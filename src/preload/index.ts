/**
 * preload：只暴露 `QwQNTPgp` —— 走 ipcMain，拿 gpg / 配置 / 发送这类主进程能力。
 * 不再有 IPC_UP/DOWN 那套（主进程直接 dlopen wrapper.node 调内核）。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createPreloadAccountScope, type ScopedAccountContext } from './account-scope';
import type {
  CryptoTestResult,
  DecryptResult,
  GpgStatus,
  KeyInfo,
  KeyBinding,
  KeySearchResult,
  PgpConfig
} from '@/shared/types';

export type AccountContext = ScopedAccountContext;
const rawInvoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`qwqnt-pgp:${channel}`, ...args) as Promise<T>;
const accountScope = createPreloadAccountScope(
  () => rawInvoke<AccountContext | null>('account-context'),
  rawInvoke
);
const { accountContext, invoke } = accountScope;

const api = {
  accountContext,
  onAccountChanged: (cb: (context: AccountContext | null) => void) => {
    return accountScope.onAccountChanged(cb);
  },
  getConfig: () => invoke<PgpConfig>('get-config'),
  setConfig: (patch: Partial<PgpConfig>) => invoke<PgpConfig>('set-config', patch),
  getConfigPath: () => invoke<string>('get-config-path'),
  getDmConfig: (uin: string) => invoke<{ uin: string; enabled: boolean }>('get-dm-config', uin),
  prepareDmConfig: (uin: string) => invoke<{ uin: string; enabled: boolean }>('prepare-dm-config', uin),
  setDmConfig: (uin: string, enabled: boolean) => invoke<{ uin: string; enabled: boolean }>('set-dm-config', uin, enabled),
  getGroupConfig: (groupId: string) => invoke<{ groupId: string; targets: string[] }>('get-group-config', groupId),
  prepareGroupConfig: (groupId: string) => invoke<{ groupId: string; targets: string[] }>('prepare-group-config', groupId),
  setGroupTarget: (groupId: string, uin: string, enabled: boolean) => invoke<{ groupId: string; targets: string[] }>('set-group-target', groupId, uin, enabled),
  getKeyBindings: (uins: string[]) => invoke<KeyBinding[]>('get-key-bindings', uins),
  listKeyBindings: (cursor?: string, limit?: number, query?: string) => invoke<{ items: KeyBinding[]; nextCursor: string | null }>('list-key-bindings', cursor, limit, query),
  setKeyBinding: (uin: string, keyID: string | null) => invoke<void>('set-key-binding', uin, keyID),
  getAutoSendInterceptorStatus: () => rawInvoke<{ available: boolean; reason?: string }>('get-auto-send-interceptor-status'),

  detectGpg: () => invoke<GpgStatus>('detect-gpg'),
  listKeys: () => invoke<{ secret: KeyInfo[]; public: KeyInfo[] }>('list-keys'),
  importKey: (armored: string) => invoke<{ keyIDs: string[] }>('import-key', armored),
  recvKey: (keyID: string, server?: string) => invoke<string>('recv-key', keyID, server),
  searchKeyserver: (query: string, server?: string) => invoke<KeySearchResult[]>('search-keyserver', query, server),
  searchGithub: (username: string) => invoke<KeySearchResult[]>('search-github', username),

  encrypt: (text: string, keyIDs: string[]) => invoke<string>('encrypt', text, keyIDs),
  decrypt: (armored: string, resume = false) => invoke<DecryptResult>('decrypt', armored, resume),
  testCrypto: (plaintext: string, keyIDs: string[]) => invoke<CryptoTestResult>('test-crypto', plaintext, keyIDs),

  debugLogEnabled: () => rawInvoke<boolean>('debug-log-enabled'),
  log: (msg: string) => rawInvoke<void>('log', msg),
  /** 订阅「配置被其他窗口改了」的广播 */
  recvForward: (selfUid: string, resId: string) => invoke<string[]>('recv-forward', selfUid, resId),
  onConfigChanged: (cb: (cfg: PgpConfig) => void) => {
    const handler = (_e: unknown, value: { accountId: string; config: PgpConfig }): void => {
      if (accountScope.currentContext()?.accountId === value.accountId) cb(value.config);
    };
    ipcRenderer.on('qwqnt-pgp:config-changed', handler);
    return () => ipcRenderer.off('qwqnt-pgp:config-changed', handler);
  },
  onDataChanged: (cb: (change: { accountId: string; kind: 'dm' | 'group' | 'binding'; id: string }) => void) => {
    const handler = (_e: unknown, change: { accountId: string; kind: 'dm' | 'group' | 'binding'; id: string }): void => { if (accountScope.currentContext()?.accountId === change.accountId) cb(change); };
    ipcRenderer.on('qwqnt-pgp:data-changed', handler);
    return () => ipcRenderer.off('qwqnt-pgp:data-changed', handler);
  },
  onAutoSendFailure: (cb: (info: { accountId: string; peerUid: string; msgId: string; plaintext: string; error: string }) => void) => {
    const handler = (_e: unknown, info: { accountId: string; peerUid: string; msgId: string; plaintext: string; error: string }): void => { if (accountScope.currentContext()?.accountId === info.accountId) cb(info); };
    ipcRenderer.on('qwqnt-pgp:auto-send-failed', handler);
    return () => ipcRenderer.off('qwqnt-pgp:auto-send-failed', handler);
  },
  /** 通过 QQ 内核发送合并转发卡片 */
  sendArk: (peer: { chatType: number; peerUid: string }, bytesData: string) =>
    invoke<{ ok: boolean; error?: string }>('send-ark', peer, bytesData),
  /** 协议端上传合并转发，拿服务器返回的 resId */
  forwardUpload: (opts: { selfUid: string; nodes: Array<{ uin: string | number; name: string; groupId?: number; time: number; text: string }>; groupId: number }) =>
    invoke<{ resId: string }>('forward-upload', opts),
  /** 从登录服务拿自己的 uin / uid / 昵称 */
  selfInfo: () => invoke<{ uin: string; uid: string; nick: string } | null>('self-info'),
  getGroupMembers: (groupId: string) =>
    invoke<Array<{ uin: string; uid: string; name: string }>>('group-members', groupId),
  resolveUin: (uid: string) => invoke<string>('resolve-uin', uid),
  getMessageRecord: (peer: { chatType: number; peerUid: string }, msgId: string) =>
    invoke<{ msgId: string; elements: Array<Record<string, unknown>>; [key: string]: unknown } | null>('get-message-record', peer, msgId),
};

const bridgeKey = Symbol.for('qwqnt-pgp.preload-bridge');
const preloadGlobal = globalThis as Record<symbol, boolean | undefined>;
if (!preloadGlobal[bridgeKey]) {
  contextBridge.exposeInMainWorld('QwQNTPgp', api);
  preloadGlobal[bridgeKey] = true;
  ipcRenderer.on('qwqnt-pgp:account-changed', (_e, value: AccountContext | null) => {
    accountScope.update(value);
  });
}

export type PgpApi = typeof api;
