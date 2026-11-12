/** 通过框架的设置扩展注册「PGP 加密」页。 */
import { log } from './log';
import { toast } from './input';
import { loadConfig, saveConfig } from './config-cache';
import type { KeyBinding, KeyInfo, KeySearchResult, PgpConfig } from '@/shared/types';

const NS = 'qwqnt-pgp';
const settingsKey = Symbol.for('qwqnt-pgp.settings-owner');
const settingsOwner = Symbol();
const settingsGlobal = window as unknown as Record<symbol, symbol | undefined>;

let mounted = false;
let mounting = false;
let mountedRoot: HTMLElement | null = null;
let mountedHost: HTMLElement | null = null;
let registrationStarted = false;
let lifecycleObserver: MutationObserver | null = null;
let config: PgpConfig | null = null;
interface BindingPageState { cursors: Array<string | undefined>; nextCursor: string | null; request: number; searchUin: string; }
interface SelectControl { root: HTMLElement; wrapper: HTMLElement; close: () => void; }
const bindingPages = new WeakMap<HTMLElement, BindingPageState>();
const selectControls = new Set<SelectControl>();
const selectControlsByRoot = new WeakMap<HTMLElement, Set<SelectControl>>();
const keyLabels = new Map<string, string>();
let unsubscribeBindingChanges: (() => void) | null = null;
let outsidePointerBound = false;
let keyMenuCleanup: (() => void) | null = null;
let settingsAccountEpoch = 0;

function refreshSettingsAccount(): void {
  settingsAccountEpoch++;
  keyLabels.clear();
  const root = mountedRoot;
  if (root) cleanupSettingsRoot(root, !root.isConnected);
  void mountSettings();
}

function onSettingsOutsidePointer(event: PointerEvent): void {
  for (const control of [...selectControls]) {
    if (!control.root.isConnected || !control.wrapper.isConnected) {
      control.close();
      forgetSelectControl(control);
    } else if (!control.wrapper.contains(event.target as Node)) control.close();
  }
}

function forgetSelectControl(control: SelectControl): void {
  selectControls.delete(control);
  const controls = selectControlsByRoot.get(control.root);
  controls?.delete(control);
  if (controls && controls.size === 0) selectControlsByRoot.delete(control.root);
  if (selectControls.size === 0 && outsidePointerBound) {
    document.removeEventListener('pointerdown', onSettingsOutsidePointer, true);
    outsidePointerBound = false;
  }
}

function cleanupSettingsRoot(root: HTMLElement, discard = true): void {
  for (const control of [...(selectControlsByRoot.get(root) ?? [])]) {
    control.close();
    forgetSelectControl(control);
  }
  unsubscribeBindingChanges?.();
  unsubscribeBindingChanges = null;
  closeKeyMenu();
  keyLabels.clear();
  if (mountedRoot === root) {
    mountedHost?.replaceChildren();
    if (discard) {
      mountedHost = null;
      mountedRoot = null;
      lifecycleObserver?.disconnect();
      lifecycleObserver = null;
    }
    mounted = false;
    config = null;
  }
}

function closeKeyMenu(): void {
  keyMenuCleanup?.();
  keyMenuCleanup = null;
}

export async function mountSettings(): Promise<void> {
  if (settingsGlobal[settingsKey] && settingsGlobal[settingsKey] !== settingsOwner) return;
  if (mounting) return;
  const root = document.querySelector<HTMLElement>('.setting-tab');
  if (mounted && mountedRoot === root) return;
  if (!root) return;
  if (!settingsGlobal[settingsKey]) {
    settingsGlobal[settingsKey] = settingsOwner;
    window.addEventListener('qwqnt-pgp:account-changed', refreshSettingsAccount);
  }
  if (mountedRoot && mountedRoot !== root) cleanupSettingsRoot(mountedRoot);
  mounting = true;
  const epoch = settingsAccountEpoch;
  try {
    let host = mountedHost;
    if (!host) {
      const hako = (window as unknown as { PluginSettings?: { renderer?: { registerPluginSettings?: (pkg: unknown) => Promise<HTMLElement> } } }).PluginSettings;
      if (registrationStarted || !hako?.renderer?.registerPluginSettings) return;
      registrationStarted = true;
      host = await hako.renderer.registerPluginSettings({ name: NS, qwqnt: { name: 'PGP 加密', icon: './icon.svg' } });
      if (!host || !root.isConnected) return;
      mountedRoot = root;
      mountedHost = host;
      observeSettingsLifecycle();
    }
    if (epoch !== settingsAccountEpoch) return;
    const next = await loadConfig(true);
    if (epoch !== settingsAccountEpoch || mountedRoot !== root || !root.isConnected) return;
    config = next;
    renderInto(host);
    mounted = true;
    log('设置页挂载完成');
  } catch (err) {
    log(`设置页挂载失败：${String(err)}`);
    mounted = false;
  } finally {
    mounting = false;
    if (epoch !== settingsAccountEpoch) queueMicrotask(() => void mountSettings());
  }
}

function observeSettingsLifecycle(): void {
  if (lifecycleObserver || typeof MutationObserver === 'undefined' || !document.documentElement) return;
  lifecycleObserver = new MutationObserver(() => {
    const root = mountedRoot;
    if (root && !root.isConnected) cleanupSettingsRoot(root);
  });
  lifecycleObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function renderInto(host: HTMLElement): void {
  host.innerHTML = '';
  // 顶部留一点空隙，避免第一段被 QQ 的标题栏压住
  host.style.paddingTop = '8px';
  host.style.paddingBottom = '24px';
  host.append(renderConfigSection(), renderContactsSection(), renderTestSection());
}

let selectMenuSequence = 0;

/** 使用原生 select 保存选项值并派发变更事件。 */
function enhanceSelects(root: HTMLElement): void {
  for (const select of root.querySelectorAll<HTMLSelectElement>('select.qwqnt-pgp-select')) {
    if (select.parentElement?.classList.contains('qwqnt-pgp-setting-select')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'qwqnt-pgp-setting-select';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'setting-view';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('.qwqnt-pgp-row')?.querySelector('label')?.textContent || '选择');
    const list = document.createElement('div');
    list.className = 'setting-option';
    list.id = `qwqnt-pgp-select-options-${++selectMenuSequence}`;
    list.setAttribute('role', 'listbox');
    trigger.setAttribute('aria-controls', list.id);
    select.classList.add('qwqnt-pgp-native-select');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.insertAdjacentElement('beforebegin', wrapper);
    wrapper.append(trigger, list, select);

    let activeIndex = Math.max(0, select.selectedIndex);
    const options = (): HTMLOptionElement[] => Array.from(select.options);
    const syncTrigger = (): void => {
      const selected = options()[select.selectedIndex];
      trigger.textContent = selected?.textContent?.trim() || '选择';
      for (const [index, item] of Array.from(list.querySelectorAll<HTMLButtonElement>('.setting-item')).entries()) {
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
      }
    };
    const setActive = (index: number): void => {
      const items = Array.from(list.querySelectorAll<HTMLButtonElement>('.setting-item'));
      if (!items.length) return;
      activeIndex = Math.max(0, Math.min(index, items.length - 1));
      items.forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === activeIndex));
      trigger.setAttribute('aria-activedescendant', items[activeIndex]!.id);
      items[activeIndex]!.scrollIntoView({ block: 'nearest' });
    };
    const close = (): void => {
      list.classList.remove('show');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
    };
    const populate = (): void => {
      list.replaceChildren();
      options().forEach((option, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.id = `${list.id}-item-${index}`;
        item.className = 'setting-item';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === select.selectedIndex));
        item.textContent = option.textContent ?? '';
        item.addEventListener('click', () => {
          select.selectedIndex = index;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          syncTrigger();
          close();
          trigger.focus();
        });
        list.append(item);
      });
    };
    const open = (index = select.selectedIndex): void => {
      populate();
      list.classList.add('show');
      trigger.setAttribute('aria-expanded', 'true');
      setActive(index);
    };
    trigger.addEventListener('click', () => {
      if (list.classList.contains('show')) close();
      else open();
    });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (!list.classList.contains('show')) open(Math.max(0, select.selectedIndex + direction));
        else setActive(activeIndex + direction);
      } else if (event.key === 'Home' || event.key === 'End') {
        if (list.classList.contains('show')) {
          event.preventDefault();
          setActive(event.key === 'Home' ? 0 : options().length - 1);
        }
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!list.classList.contains('show')) open();
        else list.querySelectorAll<HTMLButtonElement>('.setting-item')[activeIndex]?.click();
      } else if (event.key === 'Escape' && list.classList.contains('show')) {
        event.preventDefault();
        close();
      }
    });
    select.addEventListener('change', syncTrigger);
    const lifecycleRoot = mountedRoot ?? document.querySelector<HTMLElement>('.setting-tab') ?? root;
    const control: SelectControl = { root: lifecycleRoot, wrapper, close };
    selectControls.add(control);
    let controls = selectControlsByRoot.get(lifecycleRoot);
    if (!controls) { controls = new Set(); selectControlsByRoot.set(lifecycleRoot, controls); }
    controls.add(control);
    if (!outsidePointerBound) {
      document.addEventListener('pointerdown', onSettingsOutsidePointer, true);
      outsidePointerBound = true;
    }
    syncTrigger();
  }
}

/* ---------------- 样式 ---------------- */
function injectStyle(): void {
  if (document.getElementById('qwqnt-pgp-style')) return;
  const style = document.createElement('style');
  style.id = 'qwqnt-pgp-style';
  // 全部走 QQ 自己的 CSS 变量，深浅色主题自动跟随
  style.textContent = `
  .qwqnt-pgp-sec { margin-bottom: 26px; color: var(--text_primary, inherit); }
  .qwqnt-pgp-details { margin: 0 0 10px; border: 1px solid var(--border_level_1, rgba(127,127,127,.2)); border-radius: 8px; overflow: visible; }
  .qwqnt-pgp-details > summary { padding: 10px 12px; cursor: pointer; font-size: 14px; font-weight: 600; list-style-position: inside; }
  .qwqnt-pgp-details > summary:focus-visible { outline: 2px solid var(--brand_standard, #0099ff); outline-offset: -2px; border-radius: 8px; }
  .qwqnt-pgp-details-body { padding: 0 12px 12px; }
  .qwqnt-pgp-row { display: flex; align-items: center; gap: 10px; min-height: 34px; margin: 6px 0; }
  .qwqnt-pgp-row > label { width: 150px; flex: none; opacity: .85; font-size: 13px; }
  .qwqnt-pgp-row input[type=text], .qwqnt-pgp-row input[type=password], .qwqnt-pgp-row input[type=number], .qwqnt-pgp-row select, .qwqnt-pgp-field {
    flex: 1; min-width: 160px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border_level_2, rgba(127,127,127,.35));
    background: var(--bg_bottom_standard, transparent);
    color: var(--text_primary, inherit); font-size: 13px; outline: none;
  }
  .qwqnt-pgp-row input:focus, .qwqnt-pgp-row select:focus, .qwqnt-pgp-field:focus { border-color: var(--brand_standard, #0099ff); }
  .qwqnt-pgp-setting-select { position:relative; flex:1; width:100%; min-width:0; height:28px; }
  .qwqnt-pgp-native-select { position:absolute!important; width:1px!important; height:1px!important; padding:0!important; margin:-1px!important; overflow:hidden!important; clip:rect(0,0,0,0)!important; white-space:nowrap!important; border:0!important; }
  .qwqnt-pgp-setting-select .setting-view { box-sizing:border-box; display:flex; align-items:center; width:100%; height:28px; padding:0 30px 0 8px; border:1px solid rgba(127,127,127,.2); border-radius:4px; background-color:var(--overlay_active,var(--bg_bottom_standard,transparent)); color:var(--text_primary,inherit); text-align:left; font:inherit; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
  .qwqnt-pgp-setting-select .setting-view::after { content:''; position:absolute; right:11px; top:9px; width:7px; height:7px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(45deg); opacity:.68; }
  .qwqnt-pgp-setting-select .setting-view:focus-visible { outline:2px solid var(--brand_standard,#0099ff); outline-offset:1px; }
  .qwqnt-pgp-setting-select .setting-option { position:absolute; top:calc(100% + 6px); left:-1px; width:calc(100% + 2px); max-height:410px; overflow:auto; border-radius:6px; padding:6px; z-index:100; box-shadow:0 4px 20px rgba(0,0,0,.15); background:var(--bg_top_standard,var(--bg_bottom_standard,#fff)); color:var(--text_primary,inherit); opacity:0; transform:translateY(-6px); pointer-events:none; transition:150ms; }
  .qwqnt-pgp-setting-select .setting-option.show { opacity:1; transform:translateY(0); pointer-events:auto; }
  .qwqnt-pgp-setting-select .setting-item { display:block; width:100%; box-sizing:border-box; padding:0 6px; border:0; border-radius:4px; background:transparent; color:inherit; text-align:left; font-size:12px; line-height:26px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
  .qwqnt-pgp-setting-select .setting-item:hover, .qwqnt-pgp-setting-select .setting-item.active { background:var(--bg_float,rgba(127,127,127,.12)); }
  .qwqnt-pgp-setting-select .setting-item[aria-selected=true] { font-weight:600; }
  .qwqnt-pgp-btn {
    padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
    border: 1px solid var(--border_level_2, rgba(127,127,127,.35));
    background: var(--bg_bottom_standard, transparent); color: var(--text_primary, inherit);
  }
  .qwqnt-pgp-btn:hover:not(:disabled) { background: var(--bg_float, rgba(127,127,127,.12)); }
  .qwqnt-pgp-btn:disabled { opacity: .45; cursor: default; }
  .qwqnt-pgp-btn.primary { background: var(--brand_standard, #0099ff); border-color: transparent; color: var(--on_brand_primary, #fff); }
  .qwqnt-pgp-btn.primary:hover:not(:disabled) { filter: brightness(1.06); }
  .qwqnt-pgp-bool { display:flex; align-items:center; justify-content:space-between; }
  .qwqnt-pgp-switch-input { position:absolute !important; width:1px !important; height:1px !important; margin:-1px !important; padding:0 !important; overflow:hidden !important; clip:rect(0,0,0,0) !important; white-space:nowrap !important; border:0 !important; }
  .qwqnt-pgp-switch { position:relative; flex:none; width:38px; height:22px; padding:0; border:0; border-radius:999px; background:var(--fill_tertiary,rgba(127,127,127,.36)); cursor:pointer; transition:background .16s ease; }
  .qwqnt-pgp-switch[aria-checked=true] { background:var(--brand_standard,#0099ff); }
  .qwqnt-pgp-switch::after { content:""; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:var(--bg_bottom_standard,#fff); box-shadow:0 1px 2px rgba(0,0,0,.2); transition:transform .16s ease; }
  .qwqnt-pgp-switch[aria-checked=true]::after { transform:translateX(16px); }
  .qwqnt-pgp-switch:focus-visible { outline:2px solid var(--brand_standard,#0099ff); outline-offset:2px; }
  .qwqnt-pgp-list { border: 1px solid var(--border_level_1, rgba(127,127,127,.22)); border-radius: 8px; overflow: hidden; }
  .qwqnt-pgp-item { padding: 9px 12px; border-top: 1px solid var(--border_level_1, rgba(127,127,127,.16)); font-size: 13px; }
  .qwqnt-pgp-item:first-child { border-top: 0; }
  .qwqnt-pgp-item .meta { opacity: .62; font-size: 12px; margin-top: 3px; word-break: break-all; }
  .qwqnt-pgp-item .ops { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .qwqnt-pgp-hint { font-size: 12px; opacity: .6; margin: 6px 0 0; }
  .qwqnt-pgp-pre {
    white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; font-size: 12px; margin: 8px 0 0;
    padding: 8px; border-radius: 6px; background: var(--bg_bottom_standard, rgba(127,127,127,.08));
    border: 1px solid var(--border_level_1, rgba(127,127,127,.22));
  }
  .qwqnt-pgp-tea { flex: 1; min-height: 90px; resize: vertical; padding: 8px; border-radius: 6px;
    border: 1px solid var(--border_level_2, rgba(127,127,127,.35));
    background: var(--bg_bottom_standard, transparent); color: var(--text_primary, inherit);
    font-size: 13px; font-family: inherit; outline: none; }
  .qwqnt-pgp-tea:focus { border-color: var(--brand_standard, #0099ff); }
  .qwqnt-pgp-bindRow { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
  .qwqnt-pgp-bindRow > span { flex: none; opacity: .75; }
  .qwqnt-pgp-bindRow input { flex: 1; min-width: 120px; padding: 3px 6px; border-radius: 5px; border: 1px solid var(--border_level_1, rgba(127,127,127,.35)); background: transparent; color: inherit; font-size: 12px; }
  .qwqnt-pgp-key-mine { color:var(--brand_standard,#0099ff); }
  .qwqnt-pgp-key-danger { color:var(--text_error,var(--text_danger,#e55353)); }
  .qwqnt-pgp-bind-pages { justify-content:flex-end; }
  .qwqnt-pgp-bind-pages > span { flex:1; font-size:12px; opacity:.72; }
  .qwqnt-pgp-bind-search-results { margin:4px 0 8px; font-size:12px; }
  .qwqnt-pgp-binding-row { display:flex; align-items:center; gap:8px; min-width:0; padding:7px 10px; border-top:1px solid var(--border_level_1,rgba(127,127,127,.16)); font-size:12px; }
  .qwqnt-pgp-binding-row:first-child { border-top:0; }
  .qwqnt-pgp-binding-row .binding-uin { flex:none; font-variant-numeric:tabular-nums; }
  .qwqnt-pgp-binding-row .binding-key { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.75; }
  .qwqnt-pgp-bindInput { min-width:100px; }
  .qwqnt-pgp-menu { display: flex; flex-direction: column; gap: 2px; min-width: 180px; padding: 6px; border-radius: 8px;
    border: 1px solid var(--border_level_2, rgba(127,127,127,.3));
    background: var(--bg_top_standard, var(--bg_bottom_standard, var(--bg_float, #2e2e2e)));
    color: var(--text_primary, inherit);
    box-shadow: 0 8px 24px rgba(0,0,0,.28); }
  .qwqnt-pgp-menu .qwqnt-pgp-btn { text-align: left; border: none; background: transparent; padding: 6px 10px; }
  .qwqnt-pgp-menu .qwqnt-pgp-btn:hover { background: var(--bg_bottom_standard, rgba(127,127,127,.12)); }
  `;
  document.head.append(style);
}

/* ---------------- 配置 ---------------- */
function renderConfigSection(): HTMLElement {
  injectStyle();
  const sec = document.createElement('section');
  sec.className = 'qwqnt-pgp-sec';
  const cfg = config!;
  sec.innerHTML = `
    <details class="qwqnt-pgp-details" open>
      <summary>基本设置</summary><div class="qwqnt-pgp-details-body">
        <div class="qwqnt-pgp-row qwqnt-pgp-bool"><label for="qwqnt-pgp-autoDecrypt-switch">自动解密</label><input id="qwqnt-pgp-autoDecrypt" class="qwqnt-pgp-switch-input" type="checkbox" aria-hidden="true" tabindex="-1" ${cfg.autoDecrypt ? 'checked' : ''}><button id="qwqnt-pgp-autoDecrypt-switch" class="qwqnt-pgp-switch" type="button" role="switch" aria-label="自动解密" aria-checked="${cfg.autoDecrypt}"></button></div>
        <div class="qwqnt-pgp-row"><label>发送策略</label><select id="qwqnt-pgp-sendPolicy" class="qwqnt-pgp-select">
          <option value="manual" ${cfg.sendPolicy === 'manual' ? 'selected' : ''}>快捷键手动加密</option><option value="auto" ${cfg.sendPolicy === 'auto' ? 'selected' : ''}>发送时自动加密</option><option value="off" ${cfg.sendPolicy === 'off' ? 'selected' : ''}>不加密</option>
        </select></div>
        <div class="qwqnt-pgp-row"><label>加密快捷键</label><input id="qwqnt-pgp-hotkey" type="text" readonly placeholder="按组合键" value="${escapeAttr(cfg.hotkey)}"><button class="qwqnt-pgp-btn" id="qwqnt-pgp-hotkeyReset">重置</button></div>
        <div class="qwqnt-pgp-hint" id="qwqnt-pgp-saveState" role="status"></div>
      </div>
    </details>
    <details class="qwqnt-pgp-details"><summary>高级设置</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><label>切片长度</label><input id="qwqnt-pgp-sliceLength" type="number" min="200" step="100" value="${cfg.sliceLength}"></div>
    </div></details>
    <details class="qwqnt-pgp-details"><summary>GnuPG</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><label>gpg 路径</label><input id="qwqnt-pgp-gpgPath" type="text" placeholder="自动探测" value="${escapeAttr(cfg.gpgPath)}"><button class="qwqnt-pgp-btn" id="qwqnt-pgp-detect">检测</button></div>
      <div class="qwqnt-pgp-row"><label>钥匙串目录</label><input id="qwqnt-pgp-gpgHome" type="text" placeholder="使用默认目录" value="${escapeAttr(cfg.gpgHome)}"></div>
      <div class="qwqnt-pgp-hint" id="qwqnt-pgp-gpgStatus" role="status"></div>
    </div></details>
  `;

  const get = <T extends HTMLElement>(id: string) => sec.querySelector<T>(`#${id}`)!;

  // 快捷键录制
  const hotkeyInput = get<HTMLInputElement>('qwqnt-pgp-hotkey');
  hotkeyInput.addEventListener('keydown', e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      hotkeyInput.blur();
      return;
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    if (!parts.length) {
      toast('至少要带一个修饰键（Ctrl / Alt / Shift）');
      return;
    }
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    hotkeyInput.value = parts.join('+');
    hotkeyInput.blur();
  });
  get('qwqnt-pgp-hotkeyReset').addEventListener('click', () => {
    hotkeyInput.value = 'Ctrl+/';
  });

  get<HTMLInputElement>('qwqnt-pgp-detect').addEventListener('click', async () => {
    const st = await window.QwQNTPgp.detectGpg();
    get('qwqnt-pgp-gpgStatus').textContent = st.ok
      ? `检测成功：${st.version}（${st.path}）`
      : `检测失败：${st.error ?? '没找到 gpg'}`;
    if (st.ok) get<HTMLInputElement>('qwqnt-pgp-gpgPath').value = st.path;
  });

  // 改了就自动保存（不再需要点按钮）
  const collect = (): Partial<PgpConfig> => ({
    autoDecrypt: get<HTMLInputElement>('qwqnt-pgp-autoDecrypt').checked,
    sendPolicy: get<HTMLSelectElement>('qwqnt-pgp-sendPolicy').value as PgpConfig['sendPolicy'],
    hotkey: get<HTMLInputElement>('qwqnt-pgp-hotkey').value.trim() || 'Ctrl+/',
    sliceLength: Number(get<HTMLInputElement>('qwqnt-pgp-sliceLength').value) || 3000,
    gpgPath: get<HTMLInputElement>('qwqnt-pgp-gpgPath').value.trim(),
    gpgHome: get<HTMLInputElement>('qwqnt-pgp-gpgHome').value.trim()
  });

  const autoSave = async (): Promise<void> => {
    const state = document.getElementById('qwqnt-pgp-saveState');
    try {
      config = await saveConfig(collect());
      if (state) {
        state.textContent = '已自动保存';
        window.setTimeout(() => {
          if (state.textContent === '已自动保存') state.textContent = '';
        }, 2000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (state) state.textContent = `保存失败：${msg}`;
    }
  };

  for (const el of sec.querySelectorAll<HTMLElement>('input, select')) {
    el.addEventListener('change', () => void autoSave());
  }
  const autoDecrypt = get<HTMLInputElement>('qwqnt-pgp-autoDecrypt');
  const autoDecryptSwitch = get<HTMLButtonElement>('qwqnt-pgp-autoDecrypt-switch');
  const toggleAutoDecrypt = (): void => {
    autoDecrypt.checked = !autoDecrypt.checked;
    autoDecryptSwitch.setAttribute('aria-checked', String(autoDecrypt.checked));
    autoDecrypt.dispatchEvent(new Event('change', { bubbles: true }));
  };
  autoDecryptSwitch.addEventListener('click', toggleAutoDecrypt);
  autoDecryptSwitch.addEventListener('keydown', event => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    toggleAutoDecrypt();
  });
  enhanceSelects(sec);

  return sec;
}

/* ---------------- 联系人 / 密钥 ---------------- */
function renderContactsSection(): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'qwqnt-pgp-sec';
  sec.innerHTML = `
    <details class="qwqnt-pgp-details" open><summary>钥匙串与联系人</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><button class="qwqnt-pgp-btn" id="qwqnt-pgp-refreshKeys">刷新本地密钥</button><span class="qwqnt-pgp-hint" id="qwqnt-pgp-keyState" role="status"></span></div>
      <div class="qwqnt-pgp-bind-directory">
        <div class="qwqnt-pgp-row"><label for="qwqnt-pgp-binding-search">按 QQ 号查询绑定</label><input id="qwqnt-pgp-binding-search" type="text" inputmode="numeric" placeholder="输入数字 QQ 号"><button class="qwqnt-pgp-btn" id="qwqnt-pgp-binding-search-button">查询</button></div>
        <div class="qwqnt-pgp-bind-search-results" id="qwqnt-pgp-bind-search-results" role="status"></div>
        <div class="qwqnt-pgp-row qwqnt-pgp-bind-pages"><span id="qwqnt-pgp-bind-page-status" aria-live="polite"></span><button class="qwqnt-pgp-btn" id="qwqnt-pgp-bind-prev" type="button">上一页</button><button class="qwqnt-pgp-btn" id="qwqnt-pgp-bind-next" type="button">下一页</button></div>
        <div class="qwqnt-pgp-list" id="qwqnt-pgp-binding-list"><div class="qwqnt-pgp-item">加载绑定…</div></div>
      </div>
      <div class="qwqnt-pgp-list" id="qwqnt-pgp-keyList"><div class="qwqnt-pgp-item">加载中</div></div>
    </div></details>
    <details class="qwqnt-pgp-details"><summary>网络获取</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><label for="qwqnt-pgp-keyserver">密钥服务器</label><input id="qwqnt-pgp-keyserver" type="text" value="${escapeAttr(config!.keyserver)}"></div>
      <div class="qwqnt-pgp-row"><input id="qwqnt-pgp-searchInput" type="text" placeholder="邮箱、名字、keyID 或 GitHub 用户名"><button class="qwqnt-pgp-btn" id="qwqnt-pgp-searchKs">搜索密钥服务器</button><button class="qwqnt-pgp-btn" id="qwqnt-pgp-searchGh">GitHub 搜索</button></div>
      <div class="qwqnt-pgp-list" id="qwqnt-pgp-searchList"></div>
    </div></details>
  `;
  const q = <T extends HTMLElement>(id: string) => sec.querySelector<T>(`#${id}`)!;

  q('qwqnt-pgp-refreshKeys').addEventListener('click', () => void refreshKeys(sec));
  const bindingState: BindingPageState = { cursors: [undefined], nextCursor: null, request: 0, searchUin: '' };
  bindingPages.set(sec, bindingState);
  q('qwqnt-pgp-binding-search-button').addEventListener('click', () => void searchBinding(sec));
  q<HTMLInputElement>('qwqnt-pgp-binding-search').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); void searchBinding(sec); }
  });
  q('qwqnt-pgp-bind-prev').addEventListener('click', () => {
    if (bindingState.cursors.length < 2) return;
    bindingState.cursors.pop();
    void refreshBindingPage(sec);
  });
  q('qwqnt-pgp-bind-next').addEventListener('click', () => {
    if (!bindingState.nextCursor) return;
    bindingState.cursors.push(bindingState.nextCursor);
    void refreshBindingPage(sec);
  });
  unsubscribeBindingChanges?.();
  unsubscribeBindingChanges = window.QwQNTPgp.onDataChanged(change => {
    if (change.kind !== 'binding') return;
    void refreshBindingPage(sec);
    if (bindingState.searchUin === change.id) void searchBinding(sec, false);
  });
  q('qwqnt-pgp-searchKs').addEventListener('click', () => void doSearch(sec, 'keyserver'));
  q('qwqnt-pgp-searchGh').addEventListener('click', () => void doSearch(sec, 'github'));
  q<HTMLInputElement>('qwqnt-pgp-keyserver').addEventListener('change', async e => {
    try { config = await saveConfig({ keyserver: (e.currentTarget as HTMLInputElement).value.trim() || 'keys.openpgp.org' }); }
    catch (err) { toast(`保存失败：${err instanceof Error ? err.message : String(err)}`); }
  });

  void refreshKeys(sec);
  void refreshBindingPage(sec);
  return sec;
}

/** 渲染联系人绑定列表 + 添加/删除 */
/** 把私钥和公钥合成一份列表（私钥优先，按指纹去重） */
async function listAllKeys(): Promise<KeyInfo[]> {
  const { public: pubs, secret: secs } = await window.QwQNTPgp.listKeys();
  return [...secs, ...pubs.filter(p => !secs.some(s => s.fingerprint === p.fingerprint))];
}

async function refreshBindingPage(sec: HTMLElement): Promise<void> {
  const state = bindingPages.get(sec);
  const list = sec.querySelector<HTMLElement>('#qwqnt-pgp-binding-list');
  const status = sec.querySelector<HTMLElement>('#qwqnt-pgp-bind-page-status');
  const prev = sec.querySelector<HTMLButtonElement>('#qwqnt-pgp-bind-prev');
  const next = sec.querySelector<HTMLButtonElement>('#qwqnt-pgp-bind-next');
  if (!state || !list || !status || !prev || !next) return;
  const request = ++state.request;
  list.innerHTML = '<div class="qwqnt-pgp-item">加载绑定…</div>';
  prev.disabled = next.disabled = true;
  try {
    const result = await window.QwQNTPgp.listKeyBindings(state.cursors[state.cursors.length - 1], 50);
    if (request !== state.request) return;
    state.nextCursor = result.nextCursor;
    list.replaceChildren();
    if (!result.items.length) list.innerHTML = '<div class="qwqnt-pgp-item">暂无联系人绑定</div>';
    else for (const binding of result.items) list.append(renderBindingRow(sec, binding));
    status.textContent = `第 ${state.cursors.length} 页 · ${result.items.length} 条`;
    prev.disabled = state.cursors.length <= 1;
    next.disabled = !state.nextCursor;
  } catch (error) {
    if (request !== state.request) return;
    list.innerHTML = `<div class="qwqnt-pgp-item">读取绑定失败：${escapeHtml(String(error instanceof Error ? error.message : error))}</div>`;
    status.textContent = '';
    prev.disabled = next.disabled = true;
  }
}

async function searchBinding(sec: HTMLElement, updateSearch = true): Promise<void> {
  const state = bindingPages.get(sec);
  const input = sec.querySelector<HTMLInputElement>('#qwqnt-pgp-binding-search');
  const result = sec.querySelector<HTMLElement>('#qwqnt-pgp-bind-search-results');
  if (!state || !input || !result) return;
  const uin = updateSearch ? input.value.trim() : state.searchUin;
  if (!isValidUin(uin)) {
    result.textContent = '请输入有效的数字 QQ 号';
    return;
  }
  if (updateSearch) state.searchUin = uin;
  result.textContent = '查询中…';
  try {
    const bindings = await window.QwQNTPgp.getKeyBindings([uin]);
    if (state.searchUin !== uin) return;
    result.replaceChildren();
    if (!bindings.length) {
      result.textContent = `${uin} 暂无绑定公钥`;
      return;
    }
    result.append(...bindings.map(binding => renderBindingRow(sec, binding)));
  } catch (error) {
    result.textContent = `查询失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function renderBindingRow(sec: HTMLElement, binding: KeyBinding): HTMLElement {
  const row = document.createElement('div');
  row.className = 'qwqnt-pgp-binding-row';
  const uin = document.createElement('span');
  uin.className = 'binding-uin';
  uin.textContent = binding.uin;
  const key = document.createElement('span');
  key.className = 'binding-key';
  key.textContent = keyLabels.get(binding.keyID) ?? binding.keyID;
  const remove = document.createElement('button');
  remove.className = 'qwqnt-pgp-btn';
  remove.type = 'button';
  remove.textContent = '解绑';
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await window.QwQNTPgp.setKeyBinding(binding.uin, null);
      await refreshBindingPage(sec);
      const state = bindingPages.get(sec);
      if (state?.searchUin === binding.uin) await searchBinding(sec, false);
    } catch (error) {
      remove.disabled = false;
      toast(`解绑失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  row.append(uin, key, remove);
  return row;
}

async function refreshKeys(sec: HTMLElement): Promise<void> {
  const list = sec.querySelector<HTMLElement>('#qwqnt-pgp-keyList')!;
  const state = sec.querySelector<HTMLElement>('#qwqnt-pgp-keyState')!;
  list.innerHTML = '<div class="qwqnt-pgp-item">加载中…</div>';
  try {
    // Display public keys while marking whether each has a matching local secret key.
    const { public: pubs, secret: secs } = await window.QwQNTPgp.listKeys();
          config = await loadConfig(true);
    const secretFprs = new Set(secs.map(s => s.fingerprint));
    const localPubs = pubs.map(key => ({ ...key, secret: secretFprs.has(key.fingerprint) }));
    keyLabels.clear();
    for (const key of localPubs) {
      const label = key.userIds[0] || key.keyID;
      keyLabels.set(key.keyID, label);
      keyLabels.set(key.fingerprint, label);
    }
    const secretPubs = localPubs.filter(isUsableOwnKey);
    const currentOwn = secretPubs.find(key => matchesKeyID(key, config?.ownKeyID ?? ''));
    const selectedOwn = currentOwn ?? secretPubs[0];
    const selectedOwnId = selectedOwn ? selectedOwn.fingerprint || selectedOwn.keyID : '';
    if (selectedOwn && config?.ownKeyID !== selectedOwnId) {
      try {
        config = await saveConfig({ ownKeyID: selectedOwnId });
      } catch (err) {
        state.textContent = `保存默认密钥失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const activeOwn = secretPubs.find(key => matchesKeyID(key, config?.ownKeyID ?? ''));
    if (pubs.length === 0) {
      list.innerHTML = '<div class="qwqnt-pgp-item">本地没有公钥</div>';
      return;
    }
    list.innerHTML = '';
    const ordered = [...localPubs].sort((a, b) => Number(matchesKeyID(b, activeOwn?.keyID ?? '')) - Number(matchesKeyID(a, activeOwn?.keyID ?? '')));
    for (const key of ordered) list.append(renderKeyItem(key, sec));
    void refreshBindingPage(sec);
    if (!state.textContent.startsWith('保存默认密钥失败')) state.textContent = `${pubs.length} 个公钥`;
  } catch (err) {
    list.innerHTML = `<div class="qwqnt-pgp-item">加载失败：${escapeHtml(String(err instanceof Error ? err.message : err))}</div>`;
  }
}

function matchesKeyID(key: KeyInfo, keyID: string): boolean {
  return !!keyID && (key.keyID === keyID || key.fingerprint === keyID);
}

function isUsableOwnKey(key: KeyInfo): boolean {
  return key.secret && !key.expired && !key.revoked;
}

function renderKeyItem(k: KeyInfo, sec: HTMLElement): HTMLElement {
  const item = document.createElement('div');
  item.className = 'qwqnt-pgp-item';
  const trustMap: Record<string, string> = {
    u: '已信任', f: '完全信任', m: '边际信任', n: '不信任', q: '未验证', '-': '未设置', e: '已过期', r: '已吊销'
  };
  const mine = isUsableOwnKey(k) && matchesKeyID(k, config?.ownKeyID ?? '');
  item.innerHTML = `
    <div><b>${escapeHtml(k.userIds[0] ?? '(无 UID)')}</b>${mine ? ' <span class="qwqnt-pgp-key-mine">[我的公钥]</span>' : ''}</div>
    <div class="meta">${escapeHtml(k.keyID)} · ${escapeHtml(k.algo)} ${k.bits || ''}位 · 信任：${escapeHtml(trustMap[k.validity] ?? k.validity)}${k.expires ? ` · 过期：${fmtDate(k.expires)}` : ''}</div>
    <div class="qwqnt-pgp-bindRow"><span>绑定 QQ 号</span>
      <input type="text" class="qwqnt-pgp-bindInput" placeholder="输入 QQ 号（最多 512 个），逗号分隔">
      <button type="button" class="qwqnt-pgp-btn" data-act="bind">绑定</button>
      <div class="qwqnt-pgp-hint qwqnt-pgp-bindError" role="status"></div>
    </div>
    <div class="ops"><button class="qwqnt-pgp-btn" data-act="more">更多 ▾</button></div>
  `;

  const input = item.querySelector<HTMLInputElement>('.qwqnt-pgp-bindInput')!;
  const bindError = item.querySelector<HTMLElement>('.qwqnt-pgp-bindError')!;
  const commit = async (): Promise<void> => {
    const entries = input.value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    if (!entries.length) return;
    if (entries.length > 512) {
      bindError.textContent = '一次最多绑定 512 个 QQ 号';
      return;
    }
    const invalid = entries.filter(uin => !isValidUin(uin));
    if (invalid.length) {
      input.setAttribute('aria-invalid', 'true');
      bindError.textContent = `QQ 号必须是正整数，无法绑定：${invalid.join(', ')}`;
      return;
    }
    input.removeAttribute('aria-invalid');
    bindError.textContent = '';
    const uins = [...new Set(entries)];
    try {
      await Promise.all(uins.map(uin => window.QwQNTPgp.setKeyBinding(uin, k.keyID)));
      input.value = '';
      await refreshBindingPage(sec);
      const searchState = bindingPages.get(sec);
      if (searchState?.searchUin && uins.includes(searchState.searchUin)) await searchBinding(sec, false);
      toast(`已绑定 ${uins.length} 个 QQ 号`);
    } catch (err) {
      toast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  item.querySelector<HTMLButtonElement>('button[data-act="bind"]')!.addEventListener('click', () => void commit());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
  });

  item.querySelector<HTMLButtonElement>('button[data-act="more"]')!.addEventListener('click', e => {
    openKeyMenu(k, sec, e.currentTarget as HTMLElement);
  });
  return item;
}

/** 密钥操作的下拉菜单（点「更多」弹出，点外面关掉） */
function openKeyMenu(k: KeyInfo, sec: HTMLElement, anchor: HTMLElement): void {
  closeKeyMenu();
  const fpr = k.fingerprint || k.keyID;
  const mine = isUsableOwnKey(k) && matchesKeyID(k, config?.ownKeyID ?? '');
  const menu = document.createElement('div');
  menu.id = 'qwqnt-pgp-keyMenu';
  menu.className = 'qwqnt-pgp-menu';
  menu.innerHTML = `
    <button class="qwqnt-pgp-btn" data-act="copyFpr">复制指纹</button>
    <button class="qwqnt-pgp-btn" data-act="export">导出公钥</button>
    ${isUsableOwnKey(k) && !mine ? '<button class="qwqnt-pgp-btn" data-act="setOwn">设为我的公钥</button>' : ''}
    ${k.secret ? '' : '<button class="qwqnt-pgp-btn" data-act="certify">认证这个公钥（本地签名）</button>'}
    <button class="qwqnt-pgp-btn" data-act="trust">设为完全信任</button>
    ${k.secret ? '<button class="qwqnt-pgp-btn" data-act="revoke">生成吊销证书</button>' : ''}
    <button class="qwqnt-pgp-btn qwqnt-pgp-key-danger" data-act="delete">删除密钥</button>
  `;
  const rect = anchor.getBoundingClientRect();
  menu.style.cssText = `position:fixed;left:${Math.max(8, rect.left - 120)}px;top:${rect.bottom + 4}px;z-index:99998`;
  document.body.append(menu);

  const cleanup = (): void => {
    document.removeEventListener('mousedown', close, true);
    document.removeEventListener('scroll', close, true);
    menu.remove();
    if (keyMenuCleanup === cleanup) keyMenuCleanup = null;
  };
  const close = (e: Event): void => {
    if (!menu.contains(e.target as Node)) {
      cleanup();
    }
  };
  keyMenuCleanup = cleanup;
  window.setTimeout(() => {
    if (!menu.isConnected || keyMenuCleanup !== cleanup) return;
    document.addEventListener('mousedown', close, true);
    document.addEventListener('scroll', close, true);
  }, 0);

  menu.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset['act'];
      cleanup();
      try {
        if (act === 'copyFpr') {
          await copyText(fpr);
          toast('已复制指纹');
        } else if (act === 'export') {
          const text = await window.QwQNTPgp.exportKey(k.keyID, false);
          await copyText(text);
          toast('公钥已复制到剪贴板');
        } else if (act === 'setOwn') {
          if (!isUsableOwnKey(k)) return;
          const ownKeyID = k.fingerprint || k.keyID;
          config = await saveConfig({ ownKeyID });
          toast('已设为自己的公钥');
          void refreshKeys(sec);
        } else if (act === 'certify') {
          await window.QwQNTPgp.certifyKey(fpr);
          toast('已认证（本地签名，只在本机生效）');
          void refreshKeys(sec);
        } else if (act === 'trust') {
          await window.QwQNTPgp.setTrust(fpr, 5);
          toast('已设为完全信任');
          void refreshKeys(sec);
        } else if (act === 'revoke') {
          const text = await window.QwQNTPgp.revokeKey(fpr);
          await copyText(text);
          toast('吊销证书已复制，妥善保管');
        } else if (act === 'delete') {
          if (!confirm(`确定删除密钥 ${k.keyID}？`)) return;
          await window.QwQNTPgp.deleteKey(k.keyID, k.secret);
          toast('已删除');
          void refreshKeys(sec);
        }
      } catch (err) {
        toast(`操作失败：${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });
}

async function doSearch(sec: HTMLElement, source: 'keyserver' | 'github'): Promise<void> {
  const input = sec.querySelector<HTMLInputElement>('#qwqnt-pgp-searchInput')!;
  const list = sec.querySelector<HTMLElement>('#qwqnt-pgp-searchList')!;
  const query = input.value.trim();
  if (!query) {
    toast('先输入要搜的内容');
    return;
  }
  list.innerHTML = '<div class="qwqnt-pgp-item">搜索中…</div>';
  try {
    // 先拿本地已有的 key，判断结果是不是已经导入过
    const local = await listAllKeys().catch(() => [] as KeyInfo[]);
    const known = new Set<string>();
    for (const k of local) {
      if (k.keyID) known.add(k.keyID.toLowerCase());
      if (k.fingerprint) known.add(k.fingerprint.toLowerCase());
    }

    const results: KeySearchResult[] = source === 'github'
      ? await window.QwQNTPgp.searchGithub(query)
      : await window.QwQNTPgp.searchKeyserver(query);
    if (!results.length) {
      list.innerHTML = '<div class="qwqnt-pgp-item">没有结果</div>';
      return;
    }
    list.innerHTML = '';
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'qwqnt-pgp-item';
      const imported = known.has(r.keyID.toLowerCase())
        || (r.fingerprint ? known.has(r.fingerprint.toLowerCase()) : false);
      item.innerHTML = `
        <div><b>${escapeHtml(r.userIds[0] ?? r.keyID)}</b> <span style="opacity:.6">(${r.source})</span></div>
        <div class="meta">${escapeHtml(r.keyID)}${r.bits ? ` · ${r.bits}位` : ''}${r.created ? ` · ${fmtDate(r.created)}` : ''}</div>
        <div class="ops"><button class="qwqnt-pgp-btn ${imported ? '' : 'primary'}" data-act="import" ${imported ? 'disabled' : ''}>${imported ? '已导入' : '导入'}</button></div>
      `;
      const btn = item.querySelector<HTMLButtonElement>('button[data-act="import"]')!;
      if (!imported) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '导入中…';
          try {
            if (r.armored) {
              await window.QwQNTPgp.importKey(r.armored);
            } else {
              await window.QwQNTPgp.recvKey(r.keyID);
            }
            btn.textContent = '已导入';
            btn.classList.remove('primary');
            toast('导入成功');
            void refreshKeys(sec);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '导入';
            toast(`导入失败：${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }
      list.append(item);
    }
  } catch (err) {
    list.innerHTML = `<div class="qwqnt-pgp-item">搜索失败：${escapeHtml(String(err instanceof Error ? err.message : err))}</div>`;
  }
}

/* ---------------- 测试 ---------------- */
function renderTestSection(): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'qwqnt-pgp-sec';
  sec.innerHTML = `
    <details class="qwqnt-pgp-details"><summary>加解密测试</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><label>收件人</label><select id="qwqnt-pgp-testKeySelect" class="qwqnt-pgp-select"><option value="">选择本地公钥</option></select></div>
      <div class="qwqnt-pgp-row"><label>明文</label><button class="qwqnt-pgp-btn" id="qwqnt-pgp-copyPlain" style="margin-left:auto">复制</button></div>
      <textarea id="qwqnt-pgp-testPlain" class="qwqnt-pgp-tea" style="min-height:90px">hello qwqnt-pgp</textarea>
      <div class="qwqnt-pgp-row"><button class="qwqnt-pgp-btn primary" id="qwqnt-pgp-doEncrypt">加密</button><button class="qwqnt-pgp-btn" id="qwqnt-pgp-doDecrypt">解密</button></div>
      <div class="qwqnt-pgp-row"><label>密文</label><button class="qwqnt-pgp-btn" id="qwqnt-pgp-copyCipher" style="margin-left:auto">复制</button></div>
      <textarea id="qwqnt-pgp-testCipher" class="qwqnt-pgp-tea" style="min-height:120px" placeholder="-----BEGIN PGP MESSAGE-----"></textarea>
      <div class="qwqnt-pgp-hint" id="qwqnt-pgp-testState" role="status"></div>
    </div></details>
  `;
  const q = <T extends HTMLElement>(id: string) => sec.querySelector<T>(`#${id}`)!;
  const plainBox = q<HTMLTextAreaElement>('qwqnt-pgp-testPlain');
  const cipherBox = q<HTMLTextAreaElement>('qwqnt-pgp-testCipher');
  const state = q('qwqnt-pgp-testState');

  void listAllKeys().then(keys => {
    const sel = q<HTMLSelectElement>('qwqnt-pgp-testKeySelect');
    sel.innerHTML = '<option value="">选择本地公钥</option>' +
      keys.map(k => `<option value="${escapeAttr(k.fingerprint || k.keyID)}">${escapeHtml(k.userIds[0] ?? k.keyID)}${k.secret ? '（含私钥）' : ''} · ${escapeHtml(k.keyID)}</option>`).join('');
  }).catch(err => {
    state.textContent = `读取钥匙串失败：${err instanceof Error ? err.message : String(err)}`;
  });

  const resolveKeys = (): string[] => {
    const picked = q<HTMLSelectElement>('qwqnt-pgp-testKeySelect').value.trim();
    return picked ? [picked] : [];
  };

  q('qwqnt-pgp-doEncrypt').addEventListener('click', async () => {
    const text = plainBox.value;
    if (!text.trim()) {
      state.textContent = '先填明文';
      return;
    }
    const keys = resolveKeys();
    if (!keys.length) {
      state.textContent = '请先选择本地公钥';
      return;
    }
    state.textContent = '加密中…';
    const t0 = Date.now();
    try {
      cipherBox.value = await window.QwQNTPgp.encrypt(text, keys);
      state.textContent = `加密成功（${Date.now() - t0}ms，${cipherBox.value.length} 字符）`;
    } catch (err) {
      state.textContent = `加密失败：${err instanceof Error ? err.message : String(err)}`;
    }
  });

  q('qwqnt-pgp-doDecrypt').addEventListener('click', async () => {
    const text = cipherBox.value;
    if (!text.includes('-----BEGIN PGP MESSAGE-----')) {
      state.textContent = '密文框里没有 PGP 密文';
      return;
    }
    state.textContent = '解密中…';
    const t0 = Date.now();
    try {
      plainBox.value = (await window.QwQNTPgp.decrypt(text, true)).plaintext;
      state.textContent = `解密成功（${Date.now() - t0}ms，${plainBox.value.length} 字符）`;
    } catch (err) {
      state.textContent = `解密失败：${err instanceof Error ? err.message : String(err)}`;
    }
  });

  q('qwqnt-pgp-copyPlain').addEventListener('click', () => {
    void copyText(plainBox.value).then(() => toast('明文已复制')).catch(() => toast('复制失败'));
  });
  q('qwqnt-pgp-copyCipher').addEventListener('click', () => {
    void copyText(cipherBox.value).then(() => toast('密文已复制')).catch(() => toast('复制失败'));
  });

  enhanceSelects(sec);
  return sec;
}

/* ---------------- 工具 ---------------- */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function isValidUin(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function fmtDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
