/**
 * qwqnt-pgp renderer 入口。
 *
 * 启动配置、聊天监听和设置页。内核与 GnuPG 能力通过 preload 调用。
 */
import { initRendererLog, log } from './log';
import { getAccountGeneration, getActiveAccountId, loadAccountContext, loadConfig } from './config-cache';
import { setupVueTracker, getCurrentPeer, getSelfInfo } from './store';
import { startMessageWatcher, setAutoDecrypt } from './message';
import { startInputWatcher, dumpRuntime } from './input';
import { startGroupPanel, startDmToggle } from './groupPanel';
import { buildFakeForwardCard, sendEncrypted } from './send';
import { mountSettings } from './settings';
import { startDecryptMenu } from './decrypt-menu';

const rendererKey = Symbol.for('qwqnt-pgp.renderer');
const rendererGlobal = window as unknown as Record<symbol, boolean | undefined>;

async function bootstrap(): Promise<void> {
  if (rendererGlobal[rendererKey]) return;
  rendererGlobal[rendererKey] = true;
  void initRendererLog().then(() => log('renderer 启动'));
  watchSettings();
  setAutoDecrypt(false);
  window.addEventListener('qwqnt-pgp:account-changed', () => {
    setAutoDecrypt(false);
    void loadConfig(true).then(cfg => setAutoDecrypt(cfg.autoDecrypt)).catch(err => log(`当前账号配置不可用：${String(err)}`));
  });
  try {
    const cfg = await loadConfig(true);
    setAutoDecrypt(cfg.autoDecrypt);
  } catch (err) {
    log(`读取配置失败：${String(err)}`);
  }

  // Vue 组件追踪（peer / selfInfo 的来源之一）
  setupVueTracker();
  startDecryptMenu();
  // Start group preloading immediately, independently of opening the detail panel.
  startGroupPanel();

  // 等首屏渲染完再挂界面监听，别和 QQ 抢资源
  window.setTimeout(() => {
    startMessageWatcher();
    startInputWatcher();
    startDmToggle();
  }, 1500);

}

function watchSettings(): void {
  const events = (globalThis as { RendererEvents?: { onSettingsWindowCreated?: (cb: () => void) => void } }).RendererEvents;
  events?.onSettingsWindowCreated?.(() => void mountSettings());
  void mountSettings();
}

/** 调试入口：控制台里 `__qwqnt_pgp.xxx` 直接用 */
const debugApi = {
  dump: dumpRuntime,
  mountSettings,
  peer: () => getCurrentPeer(),
  buildForwardCard: buildFakeForwardCard,
  self: () => getSelfInfo(),
  log: (...args: unknown[]) => log('[debug]', ...args),
  /** 直接发一条伪造合并转发（最常用） */
  async forward(text: string) {
    const account = await loadAccountContext();
    if (!account) return { ok: false, error: '当前账号身份未确认' };
    const accountId = getActiveAccountId();
    const generation = getAccountGeneration();
    const stillCurrent = () => generation === getAccountGeneration() && accountId === getActiveAccountId();
    const peer = getCurrentPeer();
    const self = await getSelfInfo();
    if (!stillCurrent()) return { ok: false, error: '账号已切换，已取消发送' };
    log(`[debug] forward：明文 ${text.length} 字，peer=${JSON.stringify(peer)}，self=${JSON.stringify(self)}`);
    if (!peer) return { ok: false, error: '拿不到当前会话' };
    if (!self?.uid) return { ok: false, error: '拿不到自己的 uid' };
    const cfg = await loadConfig();
    if (!stillCurrent()) return { ok: false, error: '账号已切换，已取消发送' };
    return await sendEncrypted({
      plaintext: text,
      peer,
      selfUid: self.uid,
      selfUin: self.uin,
      selfNick: self.nick,
      sliceLength: cfg.sliceLength
    });
  },
  /** 协议端直传（nodes 自己给，groupId 群聊填群号） */
  async upload(nodes: Array<{ uin: string | number; name: string; groupId?: number; time: number; text: string }>, groupId = 0) {
    const account = await loadAccountContext();
    if (!account) return { ok: false, error: '当前账号身份未确认' };
    const accountId = getActiveAccountId();
    const generation = getAccountGeneration();
    const stillCurrent = () => generation === getAccountGeneration() && accountId === getActiveAccountId();
    const self = await getSelfInfo();
    if (!stillCurrent() || !self?.uid) return { ok: false, error: '账号已切换或当前身份不可用' };
    const selfUid = self?.uid ?? '';
    log(`[debug] upload：${nodes.length} 条 groupId=${groupId} selfUid=${selfUid}`);
    const result = await window.QwQNTPgp.debugUpload({ selfUid, nodes, groupId });
    return stillCurrent() ? result : { ok: false, error: '账号已切换，已取消发送' };
  },
  /** 直接发 SSO 包（cmd + base64） */
  sso: (cmd: string, b64: string) => window.QwQNTPgp.debugSso(cmd, b64),
  /** 原始 preload API */
  api: () => window.QwQNTPgp
};

if (!rendererGlobal[rendererKey]) {
  (window as unknown as Record<string, unknown>)['__qwqnt_pgp'] = debugApi;
  (window as unknown as Record<string, unknown>)['__qwqnt_pgp_debug'] = debugApi;
  void bootstrap().catch(err => log(`renderer 启动失败：${String(err)}`));
}
