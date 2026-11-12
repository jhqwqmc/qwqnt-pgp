/**
 * 输入框侧：根据配置的「发送策略」决定什么时候加密。
 *  - manual：按配置的快捷键（默认 Ctrl+/）才加密发送
 *  - auto：按下 Enter 发送时自动加密（图片/表情/文件等高优先级内容放行）
 *  - off：完全不干预，正常发送
 */
import { log } from './log';
import { getCurAio, getCurrentPeer, getSelfInfo } from './store';
import { getActiveAccountId, getCached, loadAccountContext, loadConfig } from './config-cache';
import { sendEncrypted } from './send';
import type { SendPolicy } from '@/shared/types';

const EDITOR_SELECTORS = [
  '.ProseMirror',
  '.ExEditor-qq-msg-editor',
  '[data-exeditor-root]',
  '.ck.ck-content.ck-editor__editable',
  '.ck-content',
  '.ck-editor__editable',
  '[contenteditable="true"]'
];

interface HotkeySpec {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

let bound = false;
let sending = false;
let policy: SendPolicy = 'manual';
let hotkey: HotkeySpec = parseHotkey('Ctrl+/');
let autoHookWarning = '';
let inputAccountEpoch = 0;

/** 解析 "Ctrl+/" / "Alt+Q" 这类快捷键 */
export function parseHotkey(text: string): HotkeySpec {
  const parts = (text || '').split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
  const key = parts.length > 1 ? parts.pop()! : (parts[0] ?? '/');
  return {
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    meta: parts.includes('meta') || parts.includes('win'),
    key
  };
}

function matchHotkey(e: KeyboardEvent): boolean {
  if (e.ctrlKey !== hotkey.ctrl) return false;
  if (e.shiftKey !== hotkey.shift) return false;
  if (e.altKey !== hotkey.alt) return false;
  if (e.metaKey !== hotkey.meta) return false;
  const k = e.key.toLowerCase();
  if (k === hotkey.key) return true;
  if (e.code.toLowerCase() === hotkey.key) return true;
  // 数字小键盘 / 特殊键
  if (hotkey.key === '/' && e.code === 'Slash') return true;
  return false;
}

export function startInputWatcher(): void {
  if (bound) return;
  document.addEventListener('keydown', onKeyDownCapture, true);
  bound = true;
  void refresh().catch(() => { policy = 'off'; });
  window.addEventListener('qwqnt-pgp:config-updated', () => void refresh());
  window.addEventListener('qwqnt-pgp:account-changed', () => {
    inputAccountEpoch++;
    policy = 'off';
    sending = false;
    void refresh().catch(() => { policy = 'off'; });
  });
  window.QwQNTPgp.onAutoSendFailure(info => handleAutoSendFailure(info));
  log('输入框监听已启动');
}

async function refresh(): Promise<void> {
  const cfg = await loadConfig();
  policy = cfg.sendPolicy;
  hotkey = parseHotkey(cfg.hotkey);
  log(`发送策略：${policy}，快捷键：${cfg.hotkey}`);
  if (policy === 'auto') void verifyAutoHook();
}

const EDITOR_SELECTOR = EDITOR_SELECTORS.join(',');

let keyDebugCount = 0;

function onKeyDownCapture(e: KeyboardEvent): void {
  // 不在输入法组合过程里截获 Enter 或快捷键。
  if (e.isComposing || e.keyCode === 229) return;
  // 每次都读缓存（同步），保证设置页一改就生效
  const p = getCached()?.sendPolicy ?? policy;
  if (p === 'off') return;
  // 前 10 次按键打个日志，方便确认监听有没有挂上、编辑器识别对不对
  if (keyDebugCount < 10) {
    keyDebugCount++;
    const t = e.target instanceof Element ? e.target : null;
    log(`按键捕获：key=${e.key} code=${e.code} target=${t ? `${t.tagName}.${String((t as HTMLElement).className ?? '').slice(0, 50)}` : '?'} policy=${p}`);
  }
  // 先看按键目标是不是在编辑器里（避免每次按键都查全 DOM）
  const target = e.target;
  if (!(target instanceof Element)) return;
  const editor = target.closest(EDITOR_SELECTOR) as HTMLElement | null;
  if (!editor) return;

  if (p === 'manual') {
    if (!matchHotkey(e)) return;
    log(`快捷键命中：${e.key}（${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${e.metaKey ? 'Meta+' : ''}）`);
    e.preventDefault();
    e.stopImmediatePropagation();
    void handleEncrypt(editor);
    return;
  }

  // Automatic sending is intercepted in QQ's main-process send hook so button,
  // Enter, and other native send paths share one gate without double-sending.
}

async function verifyAutoHook(): Promise<void> {
  try {
    const status = await window.QwQNTPgp.getAutoSendInterceptorStatus();
    if (status?.available) { autoHookWarning = ''; return; }
    const reason = status?.reason || '自动发送拦截不可用';
    if (autoHookWarning !== reason) { autoHookWarning = reason; toast(reason); }
  } catch (err) {
    const reason = `自动发送状态读取失败：${String(err)}`;
    if (autoHookWarning !== reason) { autoHookWarning = reason; toast(reason); }
  }
}

function handleAutoSendFailure(info: { accountId?: string; peerUid: string; msgId: string; plaintext: string; error: string }): void {
  const epoch = inputAccountEpoch;
  if (!info?.peerUid || !info.plaintext) return;
  // QQ's failure callback may restore its own model asynchronously. Check one
  // frame later so we neither duplicate its recovery nor overwrite new input.
  void loadAccountContext().then(context => {
    if (epoch !== inputAccountEpoch || !context || (info.accountId && info.accountId !== context.accountId) ||
      getActiveAccountId() !== context.accountId || getCurrentPeer()?.peerUid !== info.peerUid) return;
    const editor = document.querySelector<HTMLElement>('.chat-input-area .ProseMirror, .chat-input-area [contenteditable="true"], .chat-input .ProseMirror, .chat-input [contenteditable="true"]');
    if (!editor) return;
    window.requestAnimationFrame(() => {
      if (epoch !== inputAccountEpoch || !editor.isConnected || getCurrentPeer()?.peerUid !== info.peerUid || getEditorText(editor).trim()) return;
      try {
        const ck = (editor as HTMLElement & { ckeditorInstance?: { setData?: (value: string) => void } }).ckeditorInstance;
        if (ck?.setData) ck.setData(plainTextToHtml(info.plaintext));
        else {
          editor.replaceChildren(document.createTextNode(info.plaintext));
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
        }
        toast('自动加密发送失败，明文已放回输入框');
        log(`自动发送失败已恢复草稿 peer=${info.peerUid} msgId=${info.msgId} error=${info.error}`);
      } catch (err) { log(`恢复自动发送草稿失败：${String(err)}`); }
    });
  }).catch(err => log(`自动发送失败草稿检查身份失败：${String(err)}`));
}

function plainTextToHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]!).replace(/\r\n|\r|\n/g, '<br>');
}

function getEditorText(editor: HTMLElement): string {
  const text = (editor.innerText ?? editor.textContent ?? '').replace(/\u00a0/g, ' ');
  return text.replace(/\n+$/g, '');
}

function clearEditor(editor: HTMLElement): void {
  try {
    // QQ 的 CKEditor 实例维护自己的 model，直接改 innerHTML 容易在下一次渲染时复原。
    const ck = (editor as HTMLElement & { ckeditorInstance?: { setData?: (value: string) => void } }).ckeditorInstance;
    if (ck?.setData) {
      ck.setData('');
      return;
    }
    editor.replaceChildren();
    editor.appendChild(document.createElement('br'));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (err) {
    log(`清空输入框失败：${String(err)}`);
  }
}

async function handleEncrypt(editor: HTMLElement): Promise<void> {
  if (sending) return;
  // 兜底：不管从哪条路径进来，off 一律不加密
  if ((getCached()?.sendPolicy ?? policy) === 'off') {
    log('发送策略是 off，跳过加密');
    return;
  }
  sending = true;
  const epoch = inputAccountEpoch;
  try {
    const plaintext = getEditorText(editor);
    if (!plaintext.trim()) {
      toast('没有可加密的内容');
      return;
    }
    const originalPeer = getCurrentPeer(editor);
    const cfg = await loadConfig();
    if (epoch !== inputAccountEpoch) return;
    const peer = getCurrentPeer(editor);
    if (!peer) {
      toast('未能读取这个输入框的会话');
      return;
    }
    if (originalPeer && (originalPeer.peerUid !== peer.peerUid || originalPeer.chatType !== peer.chatType)) {
      toast('会话已切换，已取消发送');
      return;
    }
    const self = await getSelfInfo();
    if (epoch !== inputAccountEpoch || !self?.uid || !self.uin) return;
    const current = getCurrentPeer(editor);
    if (current?.peerUid !== peer.peerUid || current.chatType !== peer.chatType) {
      toast('会话已切换，已取消发送');
      return;
    }
    log(`开始加密发送：明文 ${plaintext.length} 字符；会话=${JSON.stringify(peer)}；自己=${JSON.stringify(self)}`);
    toast('加密中…（伪造聊天记录）');

    const res = await sendEncrypted({
      plaintext,
      peer,
      selfUid: self?.uid ?? '',
      selfUin: self?.uin ?? '',
      selfNick: self?.nick ?? self?.uin,
      sliceLength: cfg.sliceLength
    });
    if (epoch !== inputAccountEpoch) return;

    if (res.ok) {
      // 等待加密/发送期间若用户继续编辑，不要误删新输入。
      if (getEditorText(editor) === plaintext) clearEditor(editor);
      toast(`已发送（聊天记录，${res.slices} 段）`);
    } else {
      toast(res.error ?? '发送失败');
      log(`发送失败：${res.error}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(msg);
    log(`加密发送异常：${msg}`);
  } finally {
    sending = false;
  }
}

/** 页面上飘一条提示 */
export function toast(text: string, timeout = 2600): void {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = [
    'position:fixed',
    'right:18px',
    'bottom:90px',
    'z-index:2147483647',
    'padding:8px 14px',
    'border-radius:8px',
    'background:var(--bg_top_standard,var(--bg_bottom_standard,#222))',
    'color:var(--text_primary,#fff)',
    'font-size:13px',
    'max-width:420px',
    'box-shadow:var(--shadow_bg_middle_primary,0 4px 18px rgba(0,0,0,.3))',
    'transition:opacity .25s',
    'pointer-events:none'
  ].join(';');
  document.body.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 300);
  }, timeout);
}

/** 调试：打印当前会话信息 */
export function dumpRuntime(): void {
  const aio = getCurAio();
  const peer = getCurrentPeer();
  const self = getSelfInfo();
  log(`peer=${JSON.stringify(peer)} self=${JSON.stringify(self)} aioKeys=${aio ? Object.keys(aio).join(',') : 'null'}`);
}
