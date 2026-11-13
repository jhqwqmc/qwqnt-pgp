/**
 * qwqnt-pgp renderer 入口。
 *
 * 启动配置、聊天监听和设置页。内核与 GnuPG 能力通过 preload 调用。
 */
import { initRendererLog, log } from './log';
import { loadConfig } from './config-cache';
import { setupVueTracker } from './store';
import { startMessageWatcher, setAutoDecrypt } from './message';
import { startInputWatcher } from './input';
import { startGroupPanel, startDmToggle } from './groupPanel';
import { mountSettings } from './settings';
import { startDecryptMenu } from './decrypt-menu';

const rendererKey = Symbol.for('qwqnt-pgp.renderer');
const rendererGlobal = window as unknown as Record<symbol, boolean | undefined>;

// 临时控制台入口，用于生成待粘贴到 QQ 的定长文本。
function makeLengthTestText(length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > 1_000_000) {
    throw new RangeError('请输入 1 到 1000000 之间的整数');
  }
  return '1'.repeat(length);
}

async function bootstrap(): Promise<void> {
  if (rendererGlobal[rendererKey]) return;
  rendererGlobal[rendererKey] = true;
  Object.defineProperty(window, 'pgpLengthTest', { value: makeLengthTestText, configurable: true });
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
}

void bootstrap().catch(err => log(`renderer 启动失败：${String(err)}`));
