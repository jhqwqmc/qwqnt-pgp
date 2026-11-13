import { buildCiphertextCard } from '../shared/forward-card';
import { randomUUID } from 'node:crypto';
import type { KeyBinding, PgpConfig } from '@/shared/types';

type AnyObj = Record<string, any>;
type InterceptResult = { action: 'pass' | 'block' };
type Peer = { chatType: number; peerUid: string };
type DmConfig = { uin: string; enabled: boolean };
type GroupConfig = { groupId: string; targets: string[] };
type ForwardNode = { uin: string; name: string; groupId?: number; time: number; text: string };

export interface IpcInterceptorApi {
  interceptIpcReceiveEvents(name: string, callback: (...args: any[]) => InterceptResult | void): () => void;
  onIpcSendEvents?(name: string, callback: (...args: any[]) => void): () => void;
  interceptIpcSend?(callback: (channel: string, meta: Record<string, unknown>, payload: unknown) => InterceptResult | void): () => void;
}

export interface AutoSendFailure {
  accountId: string;
  peerUid: string;
  msgId: string;
  plaintext: string;
  error: string;
}

export interface SendInterceptorDeps {
  captureAccount(event: unknown, channel: string): { accountId: string; selfUid: string; revision: number; windowId: number } | null;
  isCurrent(event: unknown, context: { accountId: string; selfUid: string; revision: number; windowId: number }): boolean;
  assertNativeAccount(context: { accountId: string; selfUid: string; revision: number; windowId: number }): void;
  runInAccount?<T>(context: { accountId: string; selfUid: string; revision: number; windowId: number }, operation: () => Promise<T>): Promise<T>;
  getConfig(accountId: string): PgpConfig;
  getDmConfig(accountId: string, uin: string): Promise<DmConfig>;
  getGroupConfig(accountId: string, groupId: string): Promise<GroupConfig>;
  getKeyBindings(accountId: string, uins: string[]): Promise<KeyBinding[]>;
  resolveUin(uid: string): Promise<string>;
  getSelfInfo(accountId: string, selfUid: string): Promise<{ uin: string; uid: string; nick: string } | null>;
  getOwnKeyID(accountId: string): Promise<string>;
  encrypt(accountId: string, text: string, keyIDs: string[]): Promise<string>;
  uploadForward(opts: { selfUid: string; nodes: ForwardNode[]; groupId: number }): Promise<{ resId: string }>;
  replay(args: [unknown, unknown, string, unknown[]], envelope: unknown[]): void;
  replyFailure(event: unknown, channel: string, meta: AnyObj, error: string): void;
  notifyFailure(event: unknown, channel: string, failure: AutoSendFailure): void;
}

export interface AutoSendInterceptorHandle {
  available: boolean;
  reason?: string;
  dispose(): void;
  waitForIdle(): Promise<void>;
}

const SEND_CMD = 'nodeIKernelMsgService/sendMsg';
const PGP_HEADER = '-----BEGIN PGP MESSAGE-----';
const PGP_FOOTER = '-----END PGP MESSAGE-----';

/**
 * Async work is always preceded by a synchronous block in the receive interceptor.
 * Only the newly cloned envelope is permitted back through the exact same hook.
 */
export function installAutoSendInterceptor(
  deps: SendInterceptorDeps,
  interceptor: IpcInterceptorApi | null | undefined
): AutoSendInterceptorHandle {
  if (!interceptor || typeof interceptor.interceptIpcReceiveEvents !== 'function') {
    return {
      available: false,
      reason: '未加载 qwqnt-ipc-interceptor，自动加密发送不可用',
      dispose() {},
      async waitForIdle() {}
    };
  }

  const permitted = new WeakSet<object>();
  const pending = new Set<Promise<void>>();
  const pendingCallbacks = new Set<string>();
  let pendingBytes = 0;
  const reportPending = (task: Promise<void>) => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const callback = (...raw: any[]): InterceptResult | void => {
    const rawChannel = typeof raw[2] === 'string' ? raw[2] : '';
    const rawEnvelope = Array.isArray(raw[3]) ? raw[3] : [];
    const rawMeta = isObject(rawEnvelope[0]) ? rawEnvelope[0] as AnyObj : {};
    let plaintext = '';
    let peerUid = '';
    let msgId = '';
    let context: ReturnType<SendInterceptorDeps['captureAccount']> = null;
    try {
      const args = normalizeReceiveArgs(raw);
      const earlyEnvelope = args?.[3];
      const earlyRequest = Array.isArray(earlyEnvelope) ? earlyEnvelope[1] as AnyObj | undefined : undefined;
      const earlyPayload = earlyRequest?.payload?.[0] as AnyObj | undefined;
      const earlyElements = earlyPayload?.msgElements;
      const isPlaintextSend = earlyRequest?.cmdName === SEND_CMD && Array.isArray(earlyElements) && earlyElements.length > 0 &&
        earlyElements.every(element => isObject(element) && Number(element.elementType) === 1);
      context = deps.captureAccount(raw[0], rawChannel);
      if (!context) {
        if (isPlaintextSend) {
          try { deps.replyFailure(raw[0], rawChannel, rawMeta, '当前QQ账号身份未确认，已阻止文本发送'); } catch { /* block regardless of ack support */ }
          return { action: 'block' };
        }
        return;
      }
      if (!args) {
        if (deps.getConfig(context.accountId).sendPolicy !== 'auto') return;
        fail(raw[0], rawChannel, rawMeta, { accountId: context.accountId, peerUid, msgId, plaintext, error: '无法解析 QQ sendMsg IPC，请求已阻止' }, deps);
        return { action: 'block' };
      }
      const envelope = args[3];
      if (isObject(envelope) && permitted.has(envelope)) {
        permitted.delete(envelope);
        return { action: 'pass' };
      }
      const request = Array.isArray(envelope) ? envelope[1] as AnyObj | undefined : undefined;
      if (request?.cmdName !== SEND_CMD || deps.getConfig(context.accountId).sendPolicy !== 'auto') return;

      const msgPayload = request.payload?.[0] as AnyObj | undefined;
      peerUid = typeof msgPayload?.peer?.peerUid === 'string' ? msgPayload.peer.peerUid : '';
      msgId = String(msgPayload?.msgId ?? '');
      const elements = msgPayload?.msgElements;
      if (!Array.isArray(elements)) {
        fail(args[0], args[2], rawMeta, { accountId: context.accountId, peerUid, msgId, plaintext: '', error: '无法识别 QQ 文本消息元素，已阻止自动发送' }, deps);
        return { action: 'block' };
      }
      if (!elements.length || elements.some(element => !isObject(element) || Number(element.elementType) !== 1)) return;
      const text = extractPlaintext(elements);
      if (text === null) {
        fail(args[0], args[2], rawMeta, { accountId: context.accountId, peerUid, msgId, plaintext: '', error: 'QQ 文本元素格式无效，已阻止自动发送' }, deps);
        return { action: 'block' };
      }
      if (isAlreadyEncrypted(text)) return;
      plaintext = text;

      const channel = args[2];
      const meta = Array.isArray(envelope) && isObject(envelope[0]) ? envelope[0] as AnyObj : {};
      const callbackId = typeof meta.callbackId === 'string' ? meta.callbackId : '';
      const callbackKey = `${channel}\u0000${callbackId}`;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (!callbackId) {
        fail(args[0], channel, meta, { accountId: context.accountId, peerUid, msgId, plaintext: text, error: '缺失 QQ 发送回调标识，已阻止发送' }, deps);
        return { action: 'block' };
      }
      // A duplicate envelope with the same callback ID is blocked; the first
      // in-flight request owns the eventual callback response.
      if (pendingCallbacks.has(callbackKey)) return { action: 'block' };
      if (pending.size >= 64 || pendingBytes + bytes > 8 * 1024 * 1024) {
        fail(args[0], channel, meta, { accountId: context.accountId, peerUid, msgId, plaintext: text, error: '自动加密发送队列已满，请稍后重试' }, deps);
        return { action: 'block' };
      }
      pendingCallbacks.add(callbackKey);
      pendingBytes += bytes;
      const task = deps.runInAccount
        ? deps.runInAccount(context, () => processBlockedSend(args, envelope, msgPayload, text, meta, channel, { peerUid, msgId }, context!))
        : processBlockedSend(args, envelope, msgPayload, text, meta, channel, { peerUid, msgId }, context)
        .catch(error => { if (deps.isCurrent(args[0], context!)) fail(args[0], channel, meta, { accountId: context!.accountId, peerUid, msgId, plaintext: text, error: errorText(error) }, deps); })
        .finally(() => {
          pendingCallbacks.delete(callbackKey);
          pendingBytes = Math.max(0, pendingBytes - bytes);
        });
      reportPending(task);
      return { action: 'block' };
    } catch (error) {
      let auto = true;
      try { auto = !!context && deps.getConfig(context.accountId).sendPolicy === 'auto'; } catch { /* fail closed for malformed send IPC */ }
      if (!auto) return;
      if (context && deps.isCurrent(raw[0], context)) fail(raw[0], rawChannel, rawMeta, { accountId: context.accountId, peerUid, msgId, plaintext, error: errorText(error) }, deps);
      return { action: 'block' };
    }
  };

  let unsubscribe: (() => void) | undefined;
  try { unsubscribe = interceptor.interceptIpcReceiveEvents(SEND_CMD, callback); }
  catch (error) {
    return {
      available: false,
      reason: `注册 sendMsg 拦截器失败：${errorText(error)}`,
      dispose() {},
      async waitForIdle() {}
    };
  }

  async function processBlockedSend(
    args: [unknown, unknown, string, unknown[]],
    originalEnvelope: unknown[],
    msgPayload: AnyObj | undefined,
    plaintext: string,
    meta: AnyObj,
    channel: string,
    origin: { peerUid: string; msgId: string },
    context: NonNullable<ReturnType<SendInterceptorDeps['captureAccount']>>
  ): Promise<void> {
    try {
      const accountId = context.accountId;
      const ensureCurrent = () => {
        if (!deps.isCurrent(args[0], context)) throw new Error('QQ账号已切换，已取消旧账号发送');
        deps.assertNativeAccount(context);
      };
      // Re-read policy after the async boundary; policy changes to non-auto
      // still replay the exact original message once.
      ensureCurrent();
      if (deps.getConfig(accountId).sendPolicy !== 'auto') {
        ensureCurrent();
        replayEnvelope(args, cloneEnvelope(originalEnvelope), permitted, deps);
        return;
      }
      const peer = normalizePeer(msgPayload?.peer);
      if (!peer) throw new Error('QQ sendMsg 请求缺少有效会话信息');
      let otherBindings: KeyBinding[] = [];
      let groupId = 0;
      if (peer.chatType === 1) {
        const peerUin = numericUin(peer.peerUid) ? peer.peerUid : await deps.resolveUin(peer.peerUid);
        if (!numericUin(peerUin)) throw new Error('无法解析私聊对象数字 QQ 号，已阻止明文发送');
        const dm = await deps.getDmConfig(accountId, peerUin);
        if (!dm.enabled) {
          ensureCurrent();
          replayEnvelope(args, cloneEnvelope(originalEnvelope), permitted, deps);
          return;
        }
        otherBindings = await deps.getKeyBindings(accountId, [peerUin]);
        if (!otherBindings.some(binding => binding.uin === peerUin)) throw new Error(`私聊对象 ${peerUin} 没有已绑定的公钥`);
      } else if (peer.chatType === 2) {
        if (!numericUin(peer.peerUid)) throw new Error('群号不是有效数字，已阻止明文发送');
        groupId = Number(peer.peerUid);
        if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('群号超出协议范围，已阻止明文发送');
        const group = await deps.getGroupConfig(accountId, peer.peerUid);
        if (!group.targets.length) {
          ensureCurrent();
          replayEnvelope(args, cloneEnvelope(originalEnvelope), permitted, deps);
          return;
        }
        const self = await deps.getSelfInfo(accountId, context.selfUid);
        const selfUin = self && numericUin(self.uin) ? self.uin : '';
        if (!selfUin) throw new Error('无法确认本机数字 QQ 号，已阻止群聊明文发送');
        const invalidTargets = group.targets.filter(uin => !numericUin(uin));
        if (invalidTargets.length) throw new Error('群聊成员设置含无效 UID/QQ 号，已阻止明文发送');
        const otherUins = [...new Set(group.targets.filter(uin => uin !== selfUin))];
        if (!otherUins.length) {
          ensureCurrent();
          replayEnvelope(args, cloneEnvelope(originalEnvelope), permitted, deps);
          return;
        }
        otherBindings = await deps.getKeyBindings(accountId, otherUins);
        const missing = otherUins.filter(uin => !otherBindings.some(binding => binding.uin === uin));
        if (missing.length) throw new Error(`群聊已选成员缺少公钥绑定：${missing.join('、')}，已阻止明文发送`);
        if (!otherBindings.length) throw new Error('群聊已启用加密成员，但没有有效公钥绑定，已阻止明文发送');
      } else {
        ensureCurrent();
        replayEnvelope(args, cloneEnvelope(originalEnvelope), permitted, deps);
        return;
      }

      ensureCurrent();
      const ownKeyID = await deps.getOwnKeyID(accountId);
      if (!ownKeyID) throw new Error('没有可用的本机签名私钥，已阻止明文发送');
      const keyIDs = [...new Set(otherBindings.map(binding => binding.keyID).filter(keyID => typeof keyID === 'string' && keyID.trim()))];
      if (!keyIDs.length) throw new Error('没有已绑定的收件人公钥，已阻止明文发送');
      const armored = await deps.encrypt(accountId, plaintext, [...new Set([ownKeyID, ...keyIDs])]);
      if (!armored || !armored.includes(PGP_HEADER) || !armored.includes(PGP_FOOTER)) {
        throw new Error('加密未返回完整 PGP 密文，已阻止明文发送');
      }
      ensureCurrent();
      const self = await deps.getSelfInfo(accountId, context.selfUid);
      if (!self?.uid || !numericUin(self.uin)) throw new Error('无法读取本机账号信息，已阻止明文发送');
      const now = Math.floor(Date.now() / 1000);
      const nodes = [{
        uin: '0',
        name: '\u200B',
        ...(groupId ? { groupId } : {}),
        time: now,
        text: armored
      }];
      const uploaded = await deps.uploadForward({ selfUid: self.uid, nodes, groupId });
      ensureCurrent();
      if (!uploaded?.resId) throw new Error('服务器没有返回转发记录 ID，已阻止明文发送');
      const card = buildCiphertextCard(1, uploaded.resId, randomUUID());
      const arkElement = { elementId: '', elementType: 10, arkElement: { bytesData: card } };
      const cloned = cloneEnvelope(originalEnvelope);
      const clonedRequest = cloned[1] as AnyObj;
      const payload = [...(clonedRequest.payload as unknown[])];
      payload[0] = { ...(payload[0] as AnyObj), msgElements: [arkElement] };
      cloned[1] = { ...clonedRequest, payload };
      ensureCurrent();
      replayEnvelope(args, cloned, permitted, deps);
    } catch (error) {
      if (deps.isCurrent(args[0], context)) fail(args[0], channel, meta, { accountId: context.accountId, ...origin, plaintext, error: errorText(error) }, deps);
    }
  }

  return {
    available: true,
    dispose: () => unsubscribe?.(),
    waitForIdle: async () => { await Promise.all([...pending]); }
  };
}

function replayEnvelope(
  args: [unknown, unknown, string, unknown[]],
  envelope: unknown[],
  permitted: WeakSet<object>,
  deps: SendInterceptorDeps
): void {
  permitted.add(envelope);
  try { deps.replay(args, envelope); }
  catch (error) {
    permitted.delete(envelope);
    throw error;
  }
  if (permitted.has(envelope)) {
    permitted.delete(envelope);
    throw new Error('QQ sendMsg 回放没有经过一次性许可拦截器');
  }
}

function fail(event: unknown, channel: string, meta: AnyObj, failure: AutoSendFailure, deps: SendInterceptorDeps): void {
  try { deps.replyFailure(event, channel, meta, failure.error); }
  catch { /* always attempt the scoped UI recovery event below */ }
  try { deps.notifyFailure(event, channel, failure); } catch { /* ignore destroyed renderer */ }
}

function normalizeReceiveArgs(raw: any[]): [unknown, unknown, string, unknown[]] | null {
  if (raw.length < 4 || typeof raw[2] !== 'string' || !Array.isArray(raw[3])) return null;
  return [raw[0], raw[1], raw[2], raw[3]];
}

function cloneEnvelope(envelope: unknown[]): unknown[] {
  if (envelope.length < 2 || !isObject(envelope[1])) throw new Error('sendMsg IPC envelope 格式无效');
  const request = envelope[1] as AnyObj;
  const payload = Array.isArray(request.payload) ? [...request.payload] : null;
  if (!payload || !isObject(payload[0])) throw new Error('sendMsg payload 格式无效');
  return [envelope[0], { ...request, payload }];
}

function extractPlaintext(rawElements: unknown): string | null {
  if (!Array.isArray(rawElements) || !rawElements.length) return null;
  const chunks: string[] = [];
  for (const raw of rawElements) {
    if (!isObject(raw) || Number(raw.elementType) !== 1 || !isObject(raw.textElement) || typeof raw.textElement.content !== 'string') return null;
    chunks.push(raw.textElement.content);
  }
  const text = chunks.join('');
  return text.trim() ? text : null;
}

function isAlreadyEncrypted(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(PGP_HEADER) && trimmed.includes(PGP_FOOTER);
}

function normalizePeer(raw: unknown): Peer | null {
  if (!isObject(raw)) return null;
  const chatType = Number(raw.chatType);
  const peerUid = typeof raw.peerUid === 'string' ? raw.peerUid : '';
  return (chatType === 1 || chatType === 2) && peerUid ? { chatType, peerUid } : null;
}

function numericUin(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is AnyObj {
  return typeof value === 'object' && value !== null;
}
