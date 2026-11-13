/**
 * 通过当前 QQ 会话访问内核的消息服务。
 *
 * 不走渲染进程的 IPC_UP / IPC_DOWN，也不依赖前端 store。
 * QwQNT 的 main 插件本来就跑在 QQ 主进程里，wrapper.node 已经被 QQ 自己加载过，
 * 这里 process.dlopen 拿到的就是同一个模块实例（不会重复加载）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { log } from './log';
import { initNativeHook, prepareNativeOffsets } from './native-hook';
import { buildRecvPacket, parseRecvResponse } from './forward';
import { accountIdFromLoginList } from './account-context';

type AnyObj = Record<string, any>;

const req = createRequire(process.execPath);

function wrapperFile(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) &&
    basename(path).toLowerCase() === 'wrapper.node' && existsSync(path);
}

function uniqueWrapperPaths(paths: string[]): string[] {
  const unique = new Map<string, string>();
  for (const path of paths) {
    const normalized = normalize(path);
    unique.set(process.platform === 'win32' ? normalized.toLowerCase() : normalized, normalized);
  }
  return [...unique.values()];
}

function findLoadedWrapper(): string[] {
  const cached = Object.keys(req.cache).filter(wrapperFile);
  if (cached.length) return uniqueWrapperPaths(cached);
  try {
    const report = process.report?.getReport() as { sharedObjects?: unknown } | undefined;
    if (Array.isArray(report?.sharedObjects)) {
      return uniqueWrapperPaths(report.sharedObjects.filter(wrapperFile));
    }
  } catch { /* 内核路径仍可由应用资源目录确认 */ }
  return [];
}

let wrapper: AnyObj | null = null;
let wrapperPath: string | undefined;
let session: AnyObj | null = null;
let tried = false;

/** 找 wrapper.node 的候选路径 */
function findWrapperPaths(): string[] {
  const loaded = findLoadedWrapper();
  if (loaded.length) return loaded;
  const dll = (globalThis as { qwqnt?: { core?: { pathDll?: string } } }).qwqnt?.core?.pathDll;
  if (wrapperFile(dll)) return [normalize(dll)];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const appWrapper = resources && join(resources, 'app', 'wrapper.node');
  if (wrapperFile(appWrapper)) return [normalize(appWrapper)];
  const out: string[] = [];
  const execDir = dirname(process.execPath);

  // 2) 常见安装位置
  const roots = [
    join(execDir, 'versions'),
    join(execDir, 'resources', 'app'),
    join(process.cwd(), 'versions'),
    join(process.cwd(), 'resources', 'app'),
    'D:\\Program Files\\Tencent\\QQNT\\versions',
    'C:\\Program Files\\Tencent\\QQNT\\versions'
  ];
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue;
      if (!statSync(root).isDirectory()) {
        if (root.endsWith('wrapper.node')) out.push(root);
        continue;
      }
      const direct = join(root, 'wrapper.node');
      if (existsSync(direct)) out.push(direct);
      for (const sub of readdirSync(root)) {
        const verDir = join(root, sub);
        // versions/<版本>/wrapper.node
        const p1 = join(verDir, 'wrapper.node');
        if (existsSync(p1)) out.push(p1);
        // versions/<版本>/resources/app/wrapper.node（你这台就是这个结构）
        const p2 = join(verDir, 'resources', 'app', 'wrapper.node');
        if (existsSync(p2)) out.push(p2);
      }
    } catch { /* ignore */ }
  }
  return uniqueWrapperPaths(out.filter(wrapperFile));
}

/** 拿 QQ 的 wrapper 模块（只加载一次） */
export function getWrapper(): AnyObj | null {
  if (wrapper) return wrapper;
  if (tried) return null;
  tried = true;
  const paths = findWrapperPaths();
  log(`[kernel] wrapper.node 候选：${JSON.stringify(paths)}`);
  if (paths.length !== 1) {
    log('[kernel] 无法唯一确认当前 QQ 内核');
    return null;
  }
  for (const p of paths) {
    try {
      const native = { exports: {} as AnyObj };
      process.dlopen(native as unknown as Parameters<typeof process.dlopen>[0], p);
      wrapper = native.exports;
      wrapperPath = p;
      log(`[kernel] dlopen 成功：${p}；导出键=${Object.keys(wrapper ?? {}).slice(0, 12).join(',')}`);
      return wrapper;
    } catch (err) {
      log(`[kernel] dlopen 失败 ${p}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

/** 拿 QQ 的 wrapper session（nt_1） */
export function getSession(): AnyObj | null {
  if (session) return session;
  const w = getWrapper();
  if (!w) return null;
  const cls = w['NodeIQQNTWrapperSession'];
  if (!cls) {
    log('[kernel] 找不到 NodeIQQNTWrapperSession');
    return null;
  }
  try {
    session = cls.getNTWrapperSession?.('nt_1') ?? cls.create?.() ?? null;
  } catch (err) {
    log(`[kernel] getNTWrapperSession 失败：${err instanceof Error ? err.message : String(err)}`);
    session = null;
  }
  if (session) log('[kernel] 已拿到 wrapper session（nt_1）');
  return session;
}

export function getMsgService(): AnyObj | null {
  const s = getSession();
  if (!s) return null;
  try {
    return s.getMsgService?.() ?? null;
  } catch (err) {
    log(`[kernel] getMsgService 失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface ArkPeer {
  chatType: number;
  peerUid: string;
}

type NativeMessageRecord = { msgId: string; elements: AnyObj[]; [key: string]: any };
const messageRecordInFlight = new Map<string, Promise<NativeMessageRecord | null>>();
const messageRecordCache = new Map<string, { expiresAt: number; value: NativeMessageRecord | null }>();
const MESSAGE_RECORD_CACHE_MAX_ENTRIES = 256;

function pruneMessageRecordCache(now: number): void {
  for (const [key, entry] of messageRecordCache) {
    if (entry.expiresAt <= now) messageRecordCache.delete(key);
  }
  while (messageRecordCache.size > MESSAGE_RECORD_CACHE_MAX_ENTRIES) {
    const oldest = messageRecordCache.keys().next().value;
    if (oldest === undefined) break;
    messageRecordCache.delete(oldest);
  }
}

function cacheMessageRecord(key: string, value: NativeMessageRecord | null, ttl: number): void {
  const now = Date.now();
  pruneMessageRecordCache(now);
  messageRecordCache.delete(key);
  messageRecordCache.set(key, { value, expiresAt: now + ttl });
  pruneMessageRecordCache(now);
}

/** Read exactly one native message record for a validated peer and positive message ID. */
export async function getMessageRecord(accountId: string, peer: ArkPeer, msgId: string): Promise<NativeMessageRecord | null> {
  if (!/^[1-9]\d{0,19}$/.test(accountId)) return null;
  if (!peer || (peer.chatType !== 1 && peer.chatType !== 2) ||
      typeof peer.peerUid !== 'string' || !peer.peerUid.trim() ||
      typeof msgId !== 'string' || !/^[1-9]\d*$/.test(msgId)) return null;

  const key = JSON.stringify([accountId, peer.chatType, peer.peerUid, msgId]);
  const now = Date.now();
  pruneMessageRecordCache(now);
  const cached = messageRecordCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) messageRecordCache.delete(key);
  const pending = messageRecordInFlight.get(key);
  if (pending) return pending;

  const svc = getMsgService();
  if (!svc?.getMsgsByMsgId) return null;
  const requestPeer = { chatType: peer.chatType, peerUid: peer.peerUid, guildId: '' };
  const request = Promise.resolve().then(async (): Promise<NativeMessageRecord | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => svc.getMsgsByMsgId(requestPeer, [msgId])),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('读取消息记录超时（20 秒）')), 20000);
        })
      ]);
      const code = Number(response?.result ?? response?.errCode ?? 0);
      if (code !== 0) throw new Error(`getMsgsByMsgId 返回 code=${code}`);
      const records = Array.isArray(response?.msgList) ? response.msgList : [];
      const record = records.find((item: AnyObj) =>
        String(item?.msgId ?? '') === msgId &&
        (item?.peerUid === undefined || String(item.peerUid) === peer.peerUid) &&
        (item?.chatType === undefined || Number(item.chatType) === peer.chatType)
      );
      const result = record && Array.isArray(record.elements) ? record as NativeMessageRecord : null;
      const ttl = result ? 2000 : 500;
      cacheMessageRecord(key, result, ttl);
      if (result) {
        const types = [...new Set(result.elements.map(element => String(element?.elementType ?? Object.keys(element ?? {}).find(name => /Element$/.test(name)) ?? 'unknown')))];
        const arkBytes = result.elements.reduce((total, element) => total + (typeof element?.arkElement?.bytesData === 'string' ? element.arkElement.bytesData.length : 0), 0);
        const hasResid = result.elements.some(element => Boolean(element?.multiForwardMsgElement?.resId));
        log(`[kernel] getMsgsByMsgId elements=${types.join(',') || 'none'} arkBytes=${arkBytes} resid=${hasResid ? 'yes' : 'no'}`);
      }
      return result;
    } catch (err) {
      log(`[kernel] getMsgsByMsgId 失败：${err instanceof Error ? err.message : String(err)}`);
      cacheMessageRecord(key, null, 500);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      messageRecordInFlight.delete(key);
    }
  });
  messageRecordInFlight.set(key, request);
  return request;
}

function isNumericUin(value: unknown): value is string {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) && /[1-9]/.test(text);
}

async function withKernelTimeout<T>(label: string, call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（20 秒）`)), 20000); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 将 QQ UID 解析为数字 QQ 号；解析不到时返回空串，不用 UID 冒充 UIN。 */
export async function resolveUin(uid: string): Promise<string> {
  const key = String(uid ?? '').trim();
  if (!key) return '';
  const session = getSession();
  if (!session) return '';

  try {
    const convert = session.getUixConvertService?.();
    if (convert?.getUin) {
      const result = await withKernelTimeout('UID 转换', Promise.resolve().then(() => convert.getUin([key])));
      const uin = result?.uinInfo instanceof Map ? result.uinInfo.get(key) : result?.uinInfo?.[key];
      if (isNumericUin(uin)) return String(uin).trim();
    }
  } catch (err) {
    log(`[kernel] resolveUin UixConvertService 失败 uid=${key}：${String(err)}`);
  }

  try {
    const group = session.getGroupService?.();
    if (group?.getUinByUids) {
      const result = await withKernelTimeout('群服务 UID 转换', Promise.resolve().then(() => group.getUinByUids([key])));
      if (result?.errCode !== undefined && Number(result.errCode) !== 0) {
        throw new Error(`errCode=${String(result.errCode)} ${String(result.errMsg ?? '')}`);
      }
      const uin = result?.uins instanceof Map ? result.uins.get(key) : result?.uins?.[key];
      if (isNumericUin(uin)) return String(uin).trim();
    }
  } catch (err) {
    log(`[kernel] resolveUin GroupService 失败 uid=${key}：${String(err)}`);
  }
  return '';
}

/** 发一条 ark 卡片（合并转发卡片就是 elementType 10） */
/** 从登录服务拿自己的 uin / uid / 昵称 */
export async function getSelfLoginInfo(uid: string): Promise<{ uin: string; uid: string; nick: string } | null> {
  if (!uid) return null;
  const w = getWrapper();
  const login = w?.['NodeIKernelLoginService']?.['get']?.();
  if (!login) return null;
  const res = (await login['getLoginList']?.()) as { LocalLoginInfoList?: Array<Record<string, unknown>> } | undefined;
  const list = res?.LocalLoginInfoList ?? [];
  let accountId: string;
  try { accountId = accountIdFromLoginList(uid, list); } catch { return null; }
  const cur = list.find(x => x['uid'] === uid);
  if (!cur || String(cur['uin']) !== accountId) return null;
  if (!cur) return null;
  return {
    uin: String(cur['uin'] ?? ''),
    uid: String(cur['uid'] ?? ''),
    nick: String(cur['nickName'] ?? '')
  };
}

/** 从各种可能的返回结构里抠出二进制回包（实测这台 QQ 是 { result, errMsg, rsp }） */
function pickBuffer(v: unknown, depth = 0): Buffer | null {
  if (!v || depth > 3) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['rsp', 'rspbuffer', 'rspBuffer', 'buffer', 'data', 'bytes', 'body', 'payload']) {
      const x = o[k];
      if (Buffer.isBuffer(x)) return x;
      if (x instanceof Uint8Array) return Buffer.from(x);
      const nested = pickBuffer(x, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

export function prepareSsoOffsets(pluginDir: string | undefined, dataDir: string): void {
  prepareNativeOffsets(pluginDir, dataDir, activeWrapperPath());
}

function activeWrapperPath(): string | undefined {
  if (wrapperPath) return wrapperPath;
  const candidates = findWrapperPaths();
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** 发一个 SSO 协议包（cmd + 二进制），返回回包 buffer */
export async function sendSso(cmd: string, data: Buffer): Promise<Buffer> {
  getWrapper();
  const hooked = await initNativeHook(wrapperPath);
  if (!hooked) throw new Error('当前 QQ 内核未能初始化 Windows x64 二进制回包模块');
  return requestSso(cmd, data);
}

async function requestSso(cmd: string, data: Buffer): Promise<Buffer> {

  const svc = getMsgService();
  if (!svc) throw new Error('QQ 内核未就绪');
  const fn = svc['sendSsoCmdReqByContend'] as ((c: string, d: Buffer) => Promise<unknown>) | undefined;
  if (typeof fn !== 'function') throw new Error('内核没有 sendSsoCmdReqByContend');
  const started = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // A native SSO call can stay pending forever when the receive hook is
  // missing or its offsets do not match this QQ build. Bound the wait so the
  // renderer can report a useful failure instead of appearing frozen.
  let ret: unknown;
  try {
    ret = await Promise.race([
      fn.call(svc, cmd, data),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('QQ 请求超时')), 20000); })
    ]);
  } catch (error) {
    log(`SSO 请求未完成：${cmd}，耗时 ${Date.now() - started}ms，异常类型 ${error instanceof Error ? error.name : typeof error}`);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const response = ret as { result?: unknown; errCode?: unknown; rsp?: unknown } | null;
  const code = response?.result ?? response?.errCode;
  if (typeof code === 'number' && code !== 0) {
    log(`SSO 返回错误：${cmd}，错误码 ${code}，耗时 ${Date.now() - started}ms`);
    throw new Error(`QQ 返回错误（${code}）`);
  }
  const buf = pickBuffer(ret);
  if (!buf?.length) {
    log(`SSO 回包为空：${cmd}，rsp 类型 ${typeof response?.rsp}，耗时 ${Date.now() - started}ms`);
    throw new Error('QQ 回包为空');
  }
  log(`sendSso 成功：${cmd} 回包 ${buf.length} 字节，耗时 ${Date.now() - started}ms`);
  return buf;
}

/** 拉群成员列表（走内核 GroupService，不依赖渲染进程的 IPC 通道） */
export async function getGroupMembers(groupId: string): Promise<Array<{ uin: string; uid: string; name: string }>> {
  const session = getSession();
  if (!session) throw new Error('QQ 内核 session 未就绪，无法读取群成员');
  const svc = session.getGroupService?.();
  if (!svc) throw new Error('QQ 内核未提供 GroupService，无法读取群成员');

  const assertSuccess = (res: any, label: string) => {
    if (!res) throw new Error(`${label}没有返回结果`);
    if (res.errCode !== undefined && Number(res.errCode) !== 0) {
      throw new Error(`${label}失败：errCode=${String(res.errCode)} ${String(res.errMsg ?? '')}`.trim());
    }
  };
  const asMap = (value: unknown): Map<string, Record<string, any>> => {
    if (value instanceof Map) return value as Map<string, Record<string, any>>;
    if (Array.isArray(value)) {
      return new Map(value.map((member, index) => [String((member as any)?.uid ?? index), member as Record<string, any>]));
    }
    if (value && typeof value === 'object') return new Map(Object.entries(value as Record<string, Record<string, any>>));
    return new Map();
  };

  let members = new Map<string, Record<string, any>>();
  let incomplete = true;
  let primaryError: unknown;
  if (typeof svc.getAllMemberList === 'function') {
    try {
      const all = await withKernelTimeout('读取群成员列表', Promise.resolve().then(() => svc.getAllMemberList(String(groupId), false)));
      assertSuccess(all, '读取群成员列表');
      const allResult = (all as any).result;
      members = asMap(allResult?.infos ?? (all as any).memberList ?? (all as any).memberInfoList);
      incomplete = !members.size || allResult?.finish === false;
    } catch (err) {
      primaryError = err;
      log(`[kernel] getAllMemberList 失败，尝试分页兜底：${String(err)}`);
    }
  } else {
    primaryError = new Error('GroupService 没有 getAllMemberList');
  }

  // 群成员批次的结果为 `{ result: { ids, infos: Map, finish } }`。
  // Use the paginated scene API when the bulk result is missing or incomplete.
  if (incomplete) {
    if (typeof svc.createMemberListScene !== 'function' || typeof svc.getNextMemberList !== 'function') {
      const fallbackError = new Error('GroupService 未返回完整成员列表，且不支持 getNextMemberList 分页');
      if (primaryError) throw new Error(`${fallbackError.message}；${String(primaryError)}`);
      throw fallbackError;
    }
    let sceneId: string | undefined;
    try {
      sceneId = await withKernelTimeout('创建群成员分页场景', Promise.resolve().then(() =>
        svc.createMemberListScene(String(groupId), 'groupMemberList_MainWindow')));
      if (!sceneId) throw new Error('创建群成员分页场景失败');

      const collected = new Map(members);
      let cursor: { index: number; uid: string } | undefined;
      let cursorIndex = 0;
      let finish = false;
      let pages = 0;
      while (!finish) {
        if (++pages > 100) throw new Error('群成员分页超过 100 页，已停止读取');
        const page = await withKernelTimeout('读取群成员分页', Promise.resolve().then(() => svc.getNextMemberList(sceneId, cursor, 1000)));
        assertSuccess(page, '读取群成员分页');
        const result = (page as any).result;
        if (!result) throw new Error('读取群成员分页没有 result');
        const pageInfos = asMap(result.infos);
        if (!pageInfos.size && result.finish !== true) throw new Error('群成员分页没有返回成员，也未标记完成');
        for (const [uid, member] of pageInfos) collected.set(uid, member);
        finish = result.finish === true;
        if (!finish) {
          const ids = Array.isArray(result.ids) ? result.ids : [];
          const lastUid = String(ids.at(-1) ?? [...pageInfos.keys()].at(-1) ?? '');
          if (!lastUid) throw new Error('群成员分页未提供继续读取所需的 uid');
          cursorIndex += ids.length || pageInfos.size;
          cursor = { index: cursorIndex, uid: lastUid };
        }
      }
      members = collected;
    } catch (err) {
      if (primaryError) {
        throw new Error(`读取群成员失败（主接口：${String(primaryError)}；分页兜底：${String(err)}）`);
      }
      throw err;
    } finally {
      if (sceneId && typeof svc.destroyMemberListScene === 'function') {
        try {
          Promise.resolve(svc.destroyMemberListScene(sceneId)).catch(err =>
            log(`[kernel] 销毁群成员分页场景失败：${String(err)}`));
        } catch (err) {
          log(`[kernel] 销毁群成员分页场景失败：${String(err)}`);
        }
      }
    }
  }

  if (!members.size) throw new Error(`群 ${groupId} 的成员列表为空`);
  const resolvedUins = new Map<string, string>();
  const missingUids = [...new Set([...members.entries()]
    .filter(([, member]) => !isNumericUin(member['uin'] ?? member['uinStr']))
    .map(([mapUid, member]) => String(member['uid'] ?? mapUid))
    .filter(uid => uid.length > 0))];
  if (missingUids.length && typeof svc.getUinByUids === 'function') {
    try {
      const result = await withKernelTimeout('批量解析群成员 QQ 号', Promise.resolve().then(() => svc.getUinByUids(missingUids)));
      if (result?.errCode !== undefined && Number(result.errCode) !== 0) {
        throw new Error(`errCode=${String(result.errCode)} ${String(result.errMsg ?? '')}`);
      }
      const uins = result?.uins instanceof Map ? result.uins : new Map(Object.entries(result?.uins ?? {}));
      for (const uid of missingUids) {
        const uin = uins.get(uid);
        if (isNumericUin(uin)) resolvedUins.set(uid, String(uin).trim());
      }
    } catch (err) {
      // UIN resolution is best-effort: unresolved members remain visible, but
      // the renderer can disable selection because their UIN is empty.
      log(`[kernel] 批量解析群成员 QQ 号失败 group=${groupId}：${String(err)}`);
    }
  }
  const list = [...members.entries()].map(([mapUid, m]) => ({
    uin: isNumericUin(m['uin'] ?? m['uinStr'])
      ? String(m['uin'] ?? m['uinStr']).trim()
      : resolvedUins.get(String(m['uid'] ?? mapUid)) ?? '',
    uid: String(m['uid'] ?? mapUid),
    name: String(m['cardName'] || m['nick'] || m['remark'] || m['uin'] || m['uinStr'] || '')
  }));
  log(`[kernel] getGroupMembers(${groupId}) 返回 ${list.length} 人`);
  return list;
}

/** 发一个 ark 卡片（json 字符串），走内核 sendMsg */
export async function sendArk(peer: ArkPeer, bytesData: string): Promise<{ ok: boolean; error?: string }> {
  const svc = getMsgService();
  if (!svc) return { ok: false, error: '拿不到 QQ 内核服务（wrapper.node 加载失败，看日志 [kernel] 那几行）' };
  const elements = [{ elementId: '', elementType: 10, arkElement: { bytesData } }];
  const p = { chatType: Number(peer.chatType) || 1, peerUid: String(peer.peerUid), guildId: '' };
  log(`[kernel] sendMsg peer=${JSON.stringify(p)} ark=${bytesData.length} 字`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ret = await Promise.race([
      svc.sendMsg('0', p, elements, new Map()),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('发送卡片超时（20 秒）')), 20000); })
    ]);
    if (ret === undefined || ret === null) {
      return { ok: false, error: '内核发送卡片未返回结果' };
    }
    const code = Number(ret?.result ?? ret?.errCode ?? 0);
    if (code === 0) {
      log('[kernel] sendMsg 成功');
      return { ok: true };
    }
    log(`[kernel] sendMsg 返回：${JSON.stringify(ret).slice(0, 300)}`);
    return { ok: false, error: `内核返回 code=${code}（${ret?.errMsg ?? ''}）` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[kernel] sendMsg 抛异常：${msg}`);
    return { ok: false, error: msg };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** 拉取合并转发的完整内容（SsoRecvLongMsg），返回每条节点的文本 */
export async function recvForwardMsg(selfUid: string, resId: string): Promise<string[]> {
  const pkt = buildRecvPacket(selfUid, resId);
  const buf = await sendSso(pkt.cmd, pkt.data);
  log(`[kernel] 拉取合并转发 resId=${resId.slice(0, 24)}… 回包 ${buf.length} 字节`);
  return parseRecvResponse(buf);
}
