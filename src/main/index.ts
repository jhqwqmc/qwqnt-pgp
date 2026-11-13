/**
 * qwqnt-pgp 主进程入口。
 * 提供配置、日志、GnuPG 和 QQ 内核 IPC 接口。
 */
import { app, ipcMain as electronIpcMain, webContents } from 'electron';
import { initConfig, getConfig, saveConfig, getConfigPath, readDebugConfig } from './config';
import { getDmConfig, setDmConfig, getGroupConfig, prepareDmConfig, prepareGroupConfig, setGroupTarget, getKeyBindings, listKeyBindings, setKeyBinding, onDataChanged } from './entity-storage';
import { initLog, log, logLine, isDebugLogEnabled } from './log';
import { installAutoSendInterceptor, type AutoSendInterceptorHandle, type IpcInterceptorApi } from './send-interceptor';
import { createSendInterceptorTransport, type WebContentsLike } from './send-interceptor-transport';
import { BoundedCryptoQueue } from './crypto-queue';
import { Gpg, resumeDecryption } from './gpg';
import { chooseOwnKey } from './identity';
import { searchGithub } from './keys';
import { sendArk, sendSso, getSelfLoginInfo, getGroupMembers, recvForwardMsg, resolveUin, getMessageRecord, prepareSsoOffsets } from './kernel';
import { buildUploadPacket, parseUploadResponse, type ForwardNode } from './forward';
import { AccountContextRegistry, type AccountContext } from './account-context';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertAccountToken } from './scoped-ipc';
import { randomUUID } from 'node:crypto';
import { extractAuthIdentity } from './account-auth';
import { requestAuthData } from './account-auth-probe';
import type { CryptoTestResult, PgpConfig } from '@/shared/types';

const gpgInstances = new Map<string, Gpg>();
const accountContexts = new AccountContextRegistry();
const accountScope = new AsyncLocalStorage<AccountContext>();
const windowGenerations = new Map<number, number>();
const authProbeAttempts = new Map<number, number>();
const authProbeInflight = new Map<number, Promise<AccountContext | null>>();
let loaded = false;
const cryptoQueue = new BoundedCryptoQueue();
const ownKeyResolution = new Map<string, Promise<string>>();
let autoSendInterceptor: AutoSendInterceptorHandle = {
  available: false,
  reason: '自动加密发送拦截器尚未初始化',
  dispose() {},
  async waitForIdle() {}
};
const sendTransport = createSendInterceptorTransport(id =>
  webContents.fromId(id) as unknown as WebContentsLike | undefined);

function getAutoSendInterceptorStatus(): { available: boolean; reason?: string } {
  return { available: autoSendInterceptor.available, reason: autoSendInterceptor.reason };
}

function gpgFor(accountId: string): Gpg {
  let value = gpgInstances.get(accountId);
  if (value) { gpgInstances.delete(accountId); gpgInstances.set(accountId, value); return value; }
  const cfg = getConfig(accountId);
  value = new Gpg(cfg.gpgPath, cfg.gpgHome, accountId);
  gpgInstances.set(accountId, value);
  while (gpgInstances.size > 8) gpgInstances.delete(gpgInstances.keys().next().value!);
  return value;
}

function captureAccount(event: { sender?: { id?: number; getURL?: () => string } }): AccountContext {
  const id = Number(event.sender?.id ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('无法识别IPC发送窗口');
  let namespace: string | undefined;
  try { namespace = new URL(event.sender?.getURL?.() ?? '').searchParams.get('processGroupNS') ?? undefined; } catch { /* no URL */ }
  return accountContexts.capture(id, namespace);
}

function assertNativeAccount(context: AccountContext & { windowId?: number }): void {
  if (!accountContexts.canUseSingleNativeSession(context)) {
    throw new Error('当前进程存在多个不同QQ会话，无法安全确定 native session；已阻止操作');
  }
}

function installAccountObserver(interceptor: IpcInterceptorApi | null | undefined): void {
  if (!interceptor) return;
  const watched = new WeakSet<object>();
  const watchContents = (contents: Electron.WebContents) => {
    if (watched.has(contents)) return;
    watched.add(contents);
    contents.once('destroyed', () => {
      windowGenerations.delete(contents.id);
      authProbeAttempts.delete(contents.id);
      authProbeInflight.delete(contents.id);
      accountContexts.destroy(contents.id);
      broadcastAccountChanges();
    });
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isInPlace || !isMainFrame) return;
      windowGenerations.set(contents.id, (windowGenerations.get(contents.id) ?? 0) + 1);
      authProbeAttempts.delete(contents.id);
      authProbeInflight.delete(contents.id);
      accountContexts.invalidate(contents.id);
      broadcastAccountChanges();
    });
    contents.on('did-stop-loading', () => {
      if (!contents.isDestroyed()) void resolveAccountContext({ sender: contents }, interceptor);
    });
  };
  for (const contents of webContents.getAllWebContents()) watchContents(contents);
  app.on('web-contents-created', (_event, contents) => watchContents(contents));
  interceptor.onIpcSendEvents?.('nodeIKernelSessionListener/onSessionInitComplete', (...args: unknown[]) => {
    try {
      const channel = args[0];
      const payload = args[2];
      if (typeof channel !== 'string') return;
      const match = /^RM_IPCFROM_MAIN(\d+)$/.exec(channel);
      const uid = (payload as { payload?: { uid?: unknown } } | undefined)?.payload?.uid;
      if (!match || typeof uid !== 'string' || !uid) return;
      const id = Number(match[1]);
      const generation = (windowGenerations.get(id) ?? 0) + 1;
      windowGenerations.set(id, generation);
      authProbeAttempts.delete(id);
      authProbeInflight.delete(id);
      const wc = webContents.fromId(id);
      if (!wc || wc.isDestroyed()) return;
      accountContexts.invalidate(id);
      broadcastAccountChanges();
      void (async () => {
        let self: Awaited<ReturnType<typeof getSelfLoginInfo>> = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (windowGenerations.get(id) !== generation || wc.isDestroyed()) return;
          self = await getSelfLoginInfo(uid);
          if (self) break;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
        if (windowGenerations.get(id) !== generation || wc.isDestroyed()) return;
        if (!self) throw new Error(`session UID ${uid} 未能唯一匹配登录账号`);
        let namespace: string | undefined;
        try { namespace = new URL(wc.getURL()).searchParams.get('processGroupNS') ?? undefined; } catch { /* no URL */ }
        accountContexts.bindSession(id, uid, self.uin, namespace);
        broadcastAccountChanges();
        log(`窗口 ${id} 已绑定QQ账号 ${self.uin}`);
      })().catch(error => log(`忽略未确认的QQ会话：${String(error)}`));
    } catch (error) { log(`处理QQ session-init失败：${String(error)}`); }
  });
}

function broadcastAccountChanges(): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    let context: AccountContext | null = null;
    try { context = captureAccount({ sender: wc }); } catch { /* unbound or ambiguous namespace */ }
    wc.send('qwqnt-pgp:account-changed', context);
  }
}

async function resolveAccountContext(
  event: { sender?: Electron.WebContents },
  interceptor: IpcInterceptorApi | null | undefined
): Promise<AccountContext | null> {
  try { return captureAccount(event); } catch { /* use sender-scoped auth probe below */ }
  const contents = event.sender;
  if (!contents || contents.isDestroyed() || !interceptor?.interceptIpcSend) return null;
  const id = contents.id;
  const existing = authProbeInflight.get(id);
  if (existing) return existing;
  const attempts = authProbeAttempts.get(id) ?? 0;
  if (attempts >= 3) return null;
  authProbeAttempts.set(id, attempts + 1);
  const generation = windowGenerations.get(id) ?? 0;
  const task = (async (): Promise<AccountContext | null> => {
    const listeners = electronIpcMain.listeners(`RM_IPCFROM_RENDERER${id}`);
    const authData = await requestAuthData(
      contents,
      listeners,
      { interceptIpcSend: callback => interceptor.interceptIpcSend!(callback) },
      randomUUID(),
      3_500,
      () => !contents.isDestroyed() && (windowGenerations.get(id) ?? 0) === generation
    );
    const identity = extractAuthIdentity(authData);
    if (!identity) throw new Error('auth response did not contain a unique UID/UIN');
    const self = await getSelfLoginInfo(identity.uid);
    if (!self || (identity.uin && identity.uin !== self.uin)) throw new Error('auth identity did not match one login account');
    if (contents.isDestroyed() || (windowGenerations.get(id) ?? 0) !== generation) return null;
    let namespace: string | undefined;
    try { namespace = new URL(contents.getURL()).searchParams.get('processGroupNS') ?? undefined; } catch { /* no URL */ }
    try {
      const current = accountContexts.capture(id, namespace);
      if (current.accountId === self.uin && current.selfUid === self.uid) return current;
    } catch { /* direct identity has not been established yet */ }
    const context = accountContexts.bindSession(id, self.uid, self.uin, namespace);
    broadcastAccountChanges();
    return context;
  })().catch(error => {
    log(`Sender-scoped auth probe failed for window ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }).finally(() => { if (authProbeInflight.get(id) === task) authProbeInflight.delete(id); });
  authProbeInflight.set(id, task);
  return task;
}

function broadcastConfig(accountId: string, config: PgpConfig): void {
  for (const wc of webContents.getAllWebContents()) {
    try { if (!wc.isDestroyed() && captureAccount({ sender: wc }).accountId === accountId) wc.send('qwqnt-pgp:config-changed', { accountId, config }); }
    catch { /* unbound or namespace-ambiguous windows do not receive account data */ }
  }
}

async function syncOwnIdentity(accountId: string) {
  const gpg = gpgFor(accountId);
  const keys = await gpg.listKeys();
  const cfg = getConfig(accountId);
  const ownKeyID = chooseOwnKey(keys, cfg.ownKeyID);
  if (cfg.ownKeyID !== ownKeyID) {
    const next = saveConfig(accountId, { ownKeyID });
    broadcastConfig(accountId, next);
  }
  return { keys, ownKeyID };
}

async function encryptWithOwnKey(accountId: string, text: string, keyIDs: string[]): Promise<string> {
  return cryptoQueue.run(Buffer.byteLength(text, 'utf8'), async () => {
    const ownKeyID = await getOwnKeyIDForSend(accountId);
    if (!ownKeyID) throw new Error('发送必须签名：本地未找到自己的可用私钥');
    return gpgFor(accountId).encrypt(text, [...new Set([...keyIDs, ownKeyID])], ownKeyID);
  });
}

async function getOwnKeyIDForSend(accountId: string): Promise<string> {
  const configured = getConfig(accountId).ownKeyID;
  if (configured) return configured;
  if (!ownKeyResolution.has(accountId)) {
    const task = syncOwnIdentity(accountId).then(identity => identity.ownKeyID).finally(() => { ownKeyResolution.delete(accountId); });
    ownKeyResolution.set(accountId, task);
  }
  return ownKeyResolution.get(accountId)!;
}

async function uploadForward(opts: { selfUid: string; nodes: ForwardNode[]; groupId: number }): Promise<{ resId: string }> {
  const context = accountScope.getStore();
  if (!context || context.selfUid !== opts.selfUid) throw new Error('当前发送账号已切换');
  assertNativeAccount(context);
  const pkt = buildUploadPacket(opts.selfUid, opts.nodes, opts.groupId);
  log(`上传合并转发：${opts.nodes.length} 条，包 ${pkt.data.length} 字节`);
  return parseUploadResponse(await sendSso(pkt.cmd, pkt.data));
}

interface PluginLike {
  meta?: { namespace?: string; path?: string; packageJson?: Record<string, unknown> };
}

/** 注册全部 IPC */
function registerIpc(interceptor: IpcInterceptorApi | null | undefined): void {
  const baseIpcMain = electronIpcMain;
  const ipcMain = {
    handle(channel: string, listener: (...args: any[]) => unknown) {
      const isBootstrap = channel === 'qwqnt-pgp:account-context' || channel === 'qwqnt-pgp:get-auto-send-interceptor-status';
      baseIpcMain.handle(channel, async (event, token, ...args) => {
        if (isBootstrap) return listener(event, token, ...args);
        const context = captureAccount(event);
        assertAccountToken(context, token);
        return accountScope.run(context, () => listener(event, ...args));
      });
    }
  };
  onDataChanged(change => {
    for (const wc of webContents.getAllWebContents()) {
      try { if (!wc.isDestroyed() && captureAccount({ sender: wc }).accountId === change.accountId) wc.send('qwqnt-pgp:data-changed', change); } catch { /* unbound windows have no account data */ }
    }
  });
  ipcMain.handle('qwqnt-pgp:account-context', event => resolveAccountContext(event, interceptor));
  ipcMain.handle('qwqnt-pgp:get-config', event => getConfig(captureAccount(event).accountId));
  ipcMain.handle('qwqnt-pgp:get-auto-send-interceptor-status', () => getAutoSendInterceptorStatus());
  ipcMain.handle('qwqnt-pgp:set-config', async (event, patch: Partial<PgpConfig>) => {
    const accountId = captureAccount(event).accountId;
    const gpg = gpgFor(accountId);
    patch = { ...(patch ?? {}) };
    if (patch.sendPolicy === 'auto' && !autoSendInterceptor.available) {
      throw new Error(autoSendInterceptor.reason ?? '自动加密发送拦截器不可用');
    }
    if (patch.ownKeyID !== undefined) {
      patch.ownKeyID = chooseOwnKey(await gpg.listKeys(), patch.ownKeyID);
    }
    const previousConfig = getConfig(accountId);
    const wasAutoDecrypt = previousConfig.autoDecrypt;
    const next = saveConfig(accountId, patch ?? {});
    if ((!wasAutoDecrypt && next.autoDecrypt) || next.ownKeyID !== previousConfig.ownKeyID) resumeDecryption();
    if (next.gpgPath !== undefined || next.gpgHome !== undefined) {
      gpg.setPaths(next.gpgPath, next.gpgHome);
    }
    // 广播给所有窗口：设置窗口改了配置，聊天窗口也要立刻拿到
    broadcastConfig(accountId, next);
    return next;
  });
  ipcMain.handle('qwqnt-pgp:get-config-path', event => getConfigPath(captureAccount(event).accountId));
  ipcMain.handle('qwqnt-pgp:get-dm-config', (event, uin: string) => getDmConfig(captureAccount(event).accountId, uin));
  ipcMain.handle('qwqnt-pgp:prepare-dm-config', (event, uin: string) => prepareDmConfig(captureAccount(event).accountId, uin));
  ipcMain.handle('qwqnt-pgp:set-dm-config', (event, uin: string, enabled: boolean) => setDmConfig(captureAccount(event).accountId, uin, enabled));
  ipcMain.handle('qwqnt-pgp:get-group-config', (event, groupId: string) => getGroupConfig(captureAccount(event).accountId, groupId));
  ipcMain.handle('qwqnt-pgp:prepare-group-config', (event, groupId: string) => {
    const accountId = captureAccount(event).accountId;
    return prepareGroupConfig(accountId, groupId, accountId);
  });
  ipcMain.handle('qwqnt-pgp:set-group-target', (event, groupId: string, uin: string, enabled: boolean) => setGroupTarget(captureAccount(event).accountId, groupId, uin, enabled));
  ipcMain.handle('qwqnt-pgp:get-key-bindings', (event, uins: string[]) => getKeyBindings(captureAccount(event).accountId, uins));
  ipcMain.handle('qwqnt-pgp:list-key-bindings', (event, cursor?: string, limit?: number, query?: string) => listKeyBindings(captureAccount(event).accountId, cursor, limit, query));
  ipcMain.handle('qwqnt-pgp:set-key-binding', (event, uin: string, keyID: string | null) => setKeyBinding(captureAccount(event).accountId, uin, keyID));

  ipcMain.handle('qwqnt-pgp:detect-gpg', async (event: unknown) => {
    const accountId = captureAccount(event as Parameters<typeof captureAccount>[0]).accountId;
    const gpg = gpgFor(accountId);
    const cfg = getConfig(accountId);
    gpg.setPaths(cfg.gpgPath, cfg.gpgHome);
    return gpg.detect();
  });

  ipcMain.handle('qwqnt-pgp:list-keys', async event => (await syncOwnIdentity(captureAccount(event).accountId)).keys);

  ipcMain.handle('qwqnt-pgp:import-key', async (event, armored: string) => gpgFor(captureAccount(event).accountId).importKey(armored));
  ipcMain.handle('qwqnt-pgp:recv-key', async (event, keyID: string, server?: string) => {
    const accountId = captureAccount(event).accountId;
    return gpgFor(accountId).recvKey(keyID, server || getConfig(accountId).keyserver);
  });
  ipcMain.handle('qwqnt-pgp:search-keyserver', async (event, query: string, server?: string) => {
    const accountId = captureAccount(event).accountId;
    return gpgFor(accountId).searchKeyserver(query, server || getConfig(accountId).keyserver);
  });
  ipcMain.handle('qwqnt-pgp:search-github', async (_e, username: string) => searchGithub(username));

  ipcMain.handle('qwqnt-pgp:encrypt', async (event, text: string, keyIDs: string[]) =>
    encryptWithOwnKey(captureAccount(event).accountId, text, keyIDs));
  ipcMain.handle('qwqnt-pgp:decrypt', async (event, armored: string, resume = false) => {
    const accountId = captureAccount(event).accountId;
    return gpgFor(accountId).decrypt(armored, resume === true, getConfig(accountId).ownKeyID);
  });

  ipcMain.handle('qwqnt-pgp:test-crypto', async (event, plaintext: string, keyIDs: string[]): Promise<CryptoTestResult> => {
    const accountId = captureAccount(event).accountId;
    const gpg = gpgFor(accountId);
    const t0 = Date.now();
    try {
      const t1 = Date.now();
      const enc = await encryptWithOwnKey(accountId, plaintext, keyIDs);
      const t2 = Date.now();
      const dec = await gpg.decrypt(enc, true, getConfig(accountId).ownKeyID);
      const t3 = Date.now();
      return {
        ok: dec.plaintext === plaintext,
        encrypted: enc,
        decrypted: dec.plaintext,
        signature: dec.signature,
        timings: { encrypt: t2 - t1, decrypt: t3 - t2, total: t3 - t0 }
      };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err), timings: { encrypt: 0, decrypt: 0, total: Date.now() - t0 } };
    }
  });

  baseIpcMain.handle('qwqnt-pgp:debug-log-enabled', () => isDebugLogEnabled());
  baseIpcMain.handle('qwqnt-pgp:log', (_e, msg: unknown) => {
    if (isDebugLogEnabled() && typeof msg === 'string') logLine(`[renderer] ${msg.slice(0, 8192)}`);
  });

  // 通过 QQ 内核发送合并转发卡片。
  ipcMain.handle('qwqnt-pgp:send-ark', async (event, peer: { chatType: number; peerUid: string }, bytesData: string) => { const ctx = captureAccount(event); assertNativeAccount(ctx); return sendArk(peer, bytesData); });
  ipcMain.handle('qwqnt-pgp:group-members', async (event, groupId: string) => { const ctx = captureAccount(event); assertNativeAccount(ctx); return getGroupMembers(groupId); });
  ipcMain.handle('qwqnt-pgp:resolve-uin', async (event, uid: string) => { const ctx = captureAccount(event); assertNativeAccount(ctx); return resolveUin(uid); });
  ipcMain.handle('qwqnt-pgp:get-message-record', async (event, peer: { chatType: number; peerUid: string }, msgId: string) => { const ctx = captureAccount(event); assertNativeAccount(ctx); return getMessageRecord(ctx.accountId, peer, msgId); });
  ipcMain.handle('qwqnt-pgp:recv-forward', async (event, selfUid: string, resId: string) => { const ctx = captureAccount(event); assertNativeAccount(ctx); if (ctx.selfUid !== selfUid) throw new Error('账号已切换'); return recvForwardMsg(selfUid, resId); });
  ipcMain.handle('qwqnt-pgp:forward-upload', async (event, opts: { selfUid: string; nodes: ForwardNode[]; groupId: number }) => {
    const ctx = captureAccount(event); assertNativeAccount(ctx); if (ctx.selfUid !== opts.selfUid) throw new Error('账号已切换');
    const result = await uploadForward(opts);
    log(`上传合并转发成功：resId=${result.resId}`);
    return result;
  });
  ipcMain.handle('qwqnt-pgp:self-info', async event => {
    const context = captureAccount(event);
    return getSelfLoginInfo(context.selfUid);
  });
}

export function onLoad(plugin: PluginLike): void {
  if (loaded) return;
  try {
    const framework = (globalThis as { qwqnt?: { framework?: { paths?: Record<string, string>; version?: string } } }).qwqnt?.framework;
    const paths = framework?.paths ?? {};
    const configsDir = paths['configs'] || plugin?.meta?.path || process.cwd();
    const dataDir = paths['data'] || plugin?.meta?.path || process.cwd();
    // 先开日志，再读配置（这样 initConfig 里的日志也能落盘）
    initLog(dataDir, readDebugConfig(configsDir));
    const file = initConfig(configsDir);
    const interceptor = (globalThis as { IpcInterceptor?: IpcInterceptorApi }).IpcInterceptor;
    installAccountObserver(interceptor);
    autoSendInterceptor = installAutoSendInterceptor({
      captureAccount: (event, channel) => {
        const id = Number((event as { sender?: { id?: number; getURL?: () => string } } | null)?.sender?.id ?? 0);
        const match = /^RM_IPCFROM_RENDERER(\d+)$/.exec(channel);
        if (!id || Number(match?.[1]) !== id) return null;
        try {
          const context = captureAccount(event as Parameters<typeof captureAccount>[0]);
          return { ...context, windowId: id };
        } catch { return null; }
      },
      isCurrent: (event, context) => {
        const id = Number((event as { sender?: { id?: number; getURL?: () => string } } | null)?.sender?.id ?? 0);
        let namespace: string | undefined;
        try { namespace = new URL((event as { sender?: { getURL?: () => string } } | null)?.sender?.getURL?.() ?? '').searchParams.get('processGroupNS') ?? undefined; } catch { /* no URL */ }
        return id === context.windowId && accountContexts.isCurrent(id, context, namespace);
      },
      assertNativeAccount: context => assertNativeAccount(context),
      runInAccount: (context, operation) => accountScope.run(context, operation),
      getConfig,
      getDmConfig,
      getGroupConfig,
      getKeyBindings,
      resolveUin,
      getSelfInfo: async (accountId, selfUid) => {
        const self = await getSelfLoginInfo(selfUid);
        if (!self || self.uin !== accountId) throw new Error('当前内核会话与账号配置不匹配');
        return self;
      },
      getOwnKeyID: getOwnKeyIDForSend,
      encrypt: encryptWithOwnKey,
      uploadForward,
      replay: sendTransport.replay,
      replyFailure: sendTransport.replyFailure,
      notifyFailure: sendTransport.notifyFailure
    }, interceptor);
    if (!autoSendInterceptor.available) log(`自动发送拦截器不可用：${autoSendInterceptor.reason}`);
    registerIpc(interceptor);
    loaded = true;
    prepareSsoOffsets(plugin?.meta?.path, dataDir);
    log(`qwqnt-pgp 已加载；配置：${file}`);
    const core = (globalThis as { qwqnt?: { core?: { version?: string; pathDll?: string } } }).qwqnt?.core;
    log(`framework v${framework?.version ?? '?'}；core v${core?.version ?? '?'}；pathDll=${core?.pathDll ?? '(无)'}`);
    log(`paths=${JSON.stringify(paths)}`);
    log('GPG实例将在首次账号请求时按账号创建');
  } catch (err) {
    log(`onLoad 失败：${String(err)}`);
    // eslint-disable-next-line no-console
    console.error(err);
  }
}

export { getConfig, saveConfig };
