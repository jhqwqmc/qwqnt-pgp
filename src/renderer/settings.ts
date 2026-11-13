/** 通过框架的设置扩展注册「PGP 加密」页。 */
import { log } from './log';
import { toast } from './toast';
import { loadConfig, saveConfig } from './config-cache';
import type { KeyBinding, KeyInfo, PgpConfig } from '@/shared/types';

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
interface BindingPageState { nextCursor: string | null; request: number; searchUin: string; loading: boolean; }
const localKeyItems = new WeakMap<HTMLElement, HTMLElement[]>();
const localKeyRequests = new WeakMap<HTMLElement, number>();
const bindingSearchTimers = new WeakMap<HTMLElement, number>();
interface SelectControl { root: HTMLElement; wrapper: HTMLElement; close: () => void; }
const bindingPages = new WeakMap<HTMLElement, BindingPageState>();
const selectControls = new Set<SelectControl>();
const selectControlsByRoot = new WeakMap<HTMLElement, Set<SelectControl>>();
const keyLabels = new Map<string, string>();
let unsubscribeBindingChanges: (() => void) | null = null;
let outsidePointerBound = false;
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
  const root = mountedRoot;
  const entry = root?.querySelector<HTMLElement>(`.qwqnt > .nav-item[data-name="${NS}"]`);
  const keepEntryLast = (): void => {
    if (entry?.parentElement && entry.nextElementSibling) entry.parentElement.append(entry);
  };
  keepEntryLast();
  lifecycleObserver = new MutationObserver(() => {
    if (root && !root.isConnected) cleanupSettingsRoot(root);
    else keepEntryLast();
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
    const setActive = (index: number, showHighlight = true): void => {
      const items = Array.from(list.querySelectorAll<HTMLButtonElement>('.setting-item'));
      if (!items.length) return;
      activeIndex = Math.max(0, Math.min(index, items.length - 1));
      items.forEach((item, itemIndex) => item.classList.toggle('active', showHighlight && itemIndex === activeIndex));
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
    const open = (index = select.selectedIndex, showHighlight = false): void => {
      populate();
      list.classList.add('show');
      trigger.setAttribute('aria-expanded', 'true');
      setActive(index, showHighlight);
    };
    trigger.addEventListener('click', () => {
      if (list.classList.contains('show')) close();
      else open();
    });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (!list.classList.contains('show')) open(Math.max(0, select.selectedIndex + direction), true);
        else setActive(activeIndex + direction);
      } else if (event.key === 'Home' || event.key === 'End') {
        if (list.classList.contains('show')) {
          event.preventDefault();
          setActive(event.key === 'Home' ? 0 : options().length - 1);
        }
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!list.classList.contains('show')) open(select.selectedIndex, true);
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
  .qwqnt-pgp-sec { margin:0; color:var(--text_primary,inherit); }
  .qwqnt-pgp-details { margin:0 0 8px; border:1px solid var(--border_level_1,rgba(127,127,127,.2)); border-radius:8px; background-color:var(--fill_light_primary,var(--bg_top_standard,Canvas)); }
  .qwqnt-pgp-details > summary { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; cursor:pointer; font-size:14px; font-weight:400; list-style:none; }
  .qwqnt-pgp-details > summary::-webkit-details-marker { display:none; }
  .qwqnt-pgp-details > summary::after { content:''; width:7px; height:7px; margin-inline-end:3px; border:solid currentColor; border-width:0 1.5px 1.5px 0; opacity:.65; transform:rotate(45deg); }
  .qwqnt-pgp-details[open] > summary::after { transform:rotate(225deg); }
  .qwqnt-pgp-details[open] > summary { border-bottom:1px solid var(--border_level_1,rgba(127,127,127,.16)); }
  .qwqnt-pgp-details > summary:focus-visible { outline: 2px solid var(--brand_standard, #0099ff); outline-offset: -2px; border-radius: 8px; }
  .qwqnt-pgp-details-body { padding:4px 12px 6px; }
  .qwqnt-pgp-row { display: flex; align-items: center; gap: 10px; min-height: 34px; margin: 6px 0; }
  .qwqnt-pgp-details-body > .qwqnt-pgp-row:first-child { margin-top:0; }
  .qwqnt-pgp-details-body > .qwqnt-pgp-row:last-child,
  .qwqnt-pgp-details-body > .qwqnt-pgp-row:has(+ .qwqnt-pgp-hint:empty:last-child) { margin-bottom:0; }
  .qwqnt-pgp-details-body > .qwqnt-pgp-row + .qwqnt-pgp-row,
  .qwqnt-pgp-details-body > .qwqnt-pgp-test-field + .qwqnt-pgp-row,
  .qwqnt-pgp-details-body > .qwqnt-pgp-row + .qwqnt-pgp-test-field { border-top:1px solid rgba(127,127,127,.15); padding-top:6px; }
  .qwqnt-pgp-row > label { width: 150px; flex: none; opacity: .85; font-size: 13px; }
  .qwqnt-pgp-row input[type=text], .qwqnt-pgp-row input[type=password], .qwqnt-pgp-row input[type=number], .qwqnt-pgp-row select, .qwqnt-pgp-field {
    flex: 1; min-width: 160px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border_level_2, rgba(127,127,127,.35));
    background: rgba(127,127,127,.10);
    color: var(--text_primary, inherit); font-size: 13px; outline: none;
  }
  .qwqnt-pgp-sec :is(input[type=text], input[type=password], input[type=number], textarea.qwqnt-pgp-tea):focus {
    border-color:var(--brand_standard,#0099ff);
    outline:2px solid var(--brand_standard,#0099ff);
    outline-offset:-2px;
  }
  .qwqnt-pgp-setting-select { position:relative; flex:0 1 120px; width:120px; min-width:0; height:26px; margin-inline-start:auto; --qwqnt-pgp-select-bg:#fff; }
  .qwqnt-pgp-native-select { position:absolute!important; width:1px!important; height:1px!important; padding:0!important; margin:-1px!important; overflow:hidden!important; clip:rect(0,0,0,0)!important; white-space:nowrap!important; border:0!important; }
  .qwqnt-pgp-setting-select .setting-view { box-sizing:border-box; display:block; width:100%; height:100%; padding:0 24px 0 8px; border:1px solid rgba(127,127,127,.2); border-radius:4px; background:transparent; color:var(--text_primary,inherit); text-align:left; font:inherit; font-weight:400; font-size:12px; line-height:24px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
  .qwqnt-pgp-setting-select .setting-view::after { content:''; position:absolute; right:10px; top:50%; width:7px; height:7px; border-right:1px solid currentColor; border-bottom:1px solid currentColor; transform:translateY(-65%) rotate(45deg); }
  .qwqnt-pgp-setting-select .setting-view:hover { border-color:rgba(127,127,127,.4); }
  .qwqnt-pgp-setting-select .setting-view:focus-visible { outline:2px solid var(--brand_standard,#0099ff); outline-offset:1px; }
  .qwqnt-pgp-setting-select .setting-option { position:absolute; top:calc(100% + 6px); left:0; box-sizing:border-box; width:100%; max-height:410px; overflow:auto; border-radius:6px; padding:6px; z-index:100; box-shadow:0 4px 20px rgba(0,0,0,.15); background:var(--qwqnt-pgp-select-bg); color:var(--text_primary,inherit); opacity:0; transform:translateY(-6px); pointer-events:none; transition:150ms; }
  @media (prefers-color-scheme: dark) {
    .qwqnt-pgp-setting-select { --qwqnt-pgp-select-bg:#303030; }
  }
  .qwqnt-pgp-setting-select .setting-option.show { opacity:1; transform:translateY(0); pointer-events:auto; }
  .qwqnt-pgp-setting-select .setting-item { display:block; width:100%; box-sizing:border-box; padding:0 6px; border:0; border-radius:4px; background:transparent; color:inherit; text-align:left; font:inherit; font-size:12px; font-weight:400; line-height:26px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
  .qwqnt-pgp-setting-select .setting-item:hover, .qwqnt-pgp-setting-select .setting-item.active { background:var(--bg_float,rgba(127,127,127,.12)); }
  .qwqnt-pgp-sec button.q-button.q-button--small { box-sizing:border-box; min-width:0; min-height:0; height:24px; padding:0 8px; border-radius:4px; font-size:12px; font-weight:400; line-height:normal; white-space:nowrap; }
  .qwqnt-pgp-bool { display:flex; align-items:center; justify-content:space-between; }
  .qwqnt-pgp-switch-input { position:absolute !important; width:1px !important; height:1px !important; margin:-1px !important; padding:0 !important; overflow:hidden !important; clip:rect(0,0,0,0) !important; white-space:nowrap !important; border:0 !important; }
  .qwqnt-pgp-switch:focus-visible { outline:2px solid var(--brand_standard,#0099ff); outline-offset:2px; }
  .qwqnt-pgp-list { border: 1px solid var(--border_level_1, rgba(127,127,127,.22)); border-radius: 8px; overflow: hidden; }
  .qwqnt-pgp-item { padding: 9px 12px; border-top: 1px solid var(--border_level_1, rgba(127,127,127,.16)); font-size: 13px; }
  .qwqnt-pgp-item:first-child { border-top: 0; }
  .qwqnt-pgp-item .meta { opacity: .62; font-size: 12px; margin-top: 3px; word-break: break-all; }
  .qwqnt-pgp-hint { font-size: 12px; opacity: .6; margin: 6px 0 0; }
  .qwqnt-pgp-hint:empty { margin:0; }
  .qwqnt-pgp-tea { display:block; box-sizing:border-box; width:100%; height:96px; resize:none; overflow:auto; padding:8px; border-radius:6px;
    border: 1px solid var(--border_level_2, rgba(127,127,127,.35));
    background: rgba(127,127,127,.10); color: var(--text_primary, inherit);
    font-size: 13px; font-family: inherit; outline: none; }
  #qwqnt-pgp-testCipher { height:132px; }
  .qwqnt-pgp-contact-panel { display:grid; gap:8px; min-width:0; }
  .qwqnt-pgp-contact-scroll { overflow-y:auto; overscroll-behavior-y:auto; scrollbar-gutter:stable; }
  .qwqnt-pgp-contact-scroll:focus-visible { outline:2px solid var(--brand_standard,#0099ff); outline-offset:-2px; }
  #qwqnt-pgp-keyList { max-height:calc(5 * 94px); }
  #qwqnt-pgp-keyList > .qwqnt-pgp-item:has(.qwqnt-pgp-bindRow) { box-sizing:border-box; block-size:94px; overflow:auto; }
  #qwqnt-pgp-binding-list { max-height:calc(5 * 42px); }
  #qwqnt-pgp-binding-list > .qwqnt-pgp-binding-row { box-sizing:border-box; block-size:42px; }
  .qwqnt-pgp-network-github { margin-top:12px; padding-top:12px; border-top:1px solid var(--border_level_1,rgba(127,127,127,.16)); }
  .qwqnt-pgp-contact-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .qwqnt-pgp-contact-header input { min-width:0; }
  .qwqnt-pgp-contact-header .q-button { flex:none; }
  .qwqnt-pgp-contact-panel > input { box-sizing:border-box; width:100%; min-width:0; }
  .qwqnt-pgp-sec .qwqnt-pgp-contact-panel input.qwqnt-pgp-field:focus {
    border:1px solid var(--brand_standard,#0099ff) !important;
    box-shadow:inset 0 0 0 1px var(--brand_standard,#0099ff) !important;
  }
  .qwqnt-pgp-contact-panel .qwqnt-pgp-item { overflow-wrap:anywhere; }
  .qwqnt-pgp-bindRow { display:flex; align-items:center; gap:8px; margin-top:8px; }
  .qwqnt-pgp-bindRow input { min-width:0; }
  .qwqnt-pgp-bindRow button { flex:none; }
  .qwqnt-pgp-key-mine { color:var(--brand_standard,#0099ff); }
  .qwqnt-pgp-binding-row { display:flex; align-items:center; gap:8px; min-width:0; padding:7px 10px; border-top:1px solid var(--border_level_1,rgba(127,127,127,.16)); font-size:12px; }
  .qwqnt-pgp-binding-row:first-child { border-top:0; }
  .qwqnt-pgp-binding-row .binding-uin { flex:none; font-variant-numeric:tabular-nums; }
  .qwqnt-pgp-binding-row .binding-key { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.75; }
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
        <div class="qwqnt-pgp-row qwqnt-pgp-bool"><label id="qwqnt-pgp-autoDecrypt-label">自动解密</label><input id="qwqnt-pgp-autoDecrypt" class="qwqnt-pgp-switch-input" type="checkbox" aria-hidden="true" tabindex="-1" ${cfg.autoDecrypt ? 'checked' : ''}><div id="qwqnt-pgp-autoDecrypt-switch" class="q-switch qwqnt-pgp-switch${cfg.autoDecrypt ? ' is-active' : ''}" role="switch" tabindex="0" aria-labelledby="qwqnt-pgp-autoDecrypt-label" aria-checked="${cfg.autoDecrypt}"><span class="q-switch__handle"></span></div></div>
        <div class="qwqnt-pgp-row"><label>发送策略</label><select id="qwqnt-pgp-sendPolicy" class="qwqnt-pgp-select">
          <option value="manual" ${cfg.sendPolicy === 'manual' ? 'selected' : ''}>快捷键手动加密</option><option value="auto" ${cfg.sendPolicy === 'auto' ? 'selected' : ''}>发送时自动加密</option><option value="off" ${cfg.sendPolicy === 'off' ? 'selected' : ''}>不加密</option>
        </select></div>
        <div class="qwqnt-pgp-row"><label>加密快捷键</label><input id="qwqnt-pgp-hotkey" type="text" readonly placeholder="按组合键" value="${escapeAttr(cfg.hotkey)}"><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-hotkeyReset">重置</button></div>
        <div class="qwqnt-pgp-hint" id="qwqnt-pgp-saveState" role="status"></div>
      </div>
    </details>
    <details class="qwqnt-pgp-details"><summary>GnuPG</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><label>gpg 路径</label><input id="qwqnt-pgp-gpgPath" type="text" placeholder="自动探测" value="${escapeAttr(cfg.gpgPath)}"><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-detect">检测</button></div>
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
    gpgPath: get<HTMLInputElement>('qwqnt-pgp-gpgPath').value.trim(),
    gpgHome: get<HTMLInputElement>('qwqnt-pgp-gpgHome').value.trim()
  });

  const autoSave = async (): Promise<void> => {
    const state = document.getElementById('qwqnt-pgp-saveState');
    try {
      config = await saveConfig(collect());
      if (state) state.textContent = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (state) state.textContent = `保存失败：${msg}`;
    }
  };

  for (const el of sec.querySelectorAll<HTMLElement>('input, select')) {
    el.addEventListener('change', () => void autoSave());
  }
  const autoDecrypt = get<HTMLInputElement>('qwqnt-pgp-autoDecrypt');
  const autoDecryptSwitch = get('qwqnt-pgp-autoDecrypt-switch');
  const toggleAutoDecrypt = (): void => {
    autoDecrypt.checked = !autoDecrypt.checked;
    autoDecryptSwitch.classList.toggle('is-active', autoDecrypt.checked);
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
    <details class="qwqnt-pgp-details" open><summary>本机公钥</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-contact-panel">
        <div class="qwqnt-pgp-contact-header">
          <input class="qwqnt-pgp-field" id="qwqnt-pgp-local-search" type="text" aria-label="筛选本机公钥" placeholder="筛选公钥">
          <button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-refreshKeys" type="button">刷新</button>
        </div>
        <div class="qwqnt-pgp-list qwqnt-pgp-contact-scroll" id="qwqnt-pgp-keyList" tabindex="0" aria-label="本机公钥列表"><div class="qwqnt-pgp-item">加载中</div></div>
        <span class="qwqnt-pgp-hint" id="qwqnt-pgp-keyState" role="status"></span>
      </div>
    </div></details>
    <details class="qwqnt-pgp-details" open><summary>已绑定 QQ 号</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-contact-panel">
        <input class="qwqnt-pgp-field" id="qwqnt-pgp-binding-search" type="text" inputmode="numeric" aria-label="筛选已绑定 QQ 号" placeholder="筛选 QQ 号">
        <div class="qwqnt-pgp-list qwqnt-pgp-contact-scroll" id="qwqnt-pgp-binding-list" tabindex="0" aria-label="已绑定 QQ 号列表"><div class="qwqnt-pgp-item">加载绑定…</div></div>
      </div>
    </div></details>
    <details class="qwqnt-pgp-details"><summary>网络获取</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><label for="qwqnt-pgp-keyserver">密钥服务器</label><input id="qwqnt-pgp-keyserver" type="text" value="${escapeAttr(config!.keyserver)}"></div>
      <form class="qwqnt-pgp-row" id="qwqnt-pgp-keyserver-search"><input type="text" aria-label="搜索密钥服务器" required placeholder="邮箱或指纹"><button class="q-button q-button--small q-button--secondary" type="submit">搜索</button></form>
      <div id="qwqnt-pgp-keyserver-results"></div>
    <div class="qwqnt-pgp-network-github">
      <div>GitHub 公钥</div>
      <form class="qwqnt-pgp-row" id="qwqnt-pgp-github-search"><input type="text" aria-label="GitHub 用户名" required placeholder="用户名"><button class="q-button q-button--small q-button--secondary" type="submit">搜索</button></form>
      <div id="qwqnt-pgp-github-results"></div>
    </div>
    </div></details>
  `;
  const q = <T extends HTMLElement>(id: string) => sec.querySelector<T>(`#${id}`)!;

  q('qwqnt-pgp-refreshKeys').addEventListener('click', () => void refreshKeys(sec));
  const bindingState: BindingPageState = { nextCursor: null, request: 0, loading: false, searchUin: '' };
  bindingPages.set(sec, bindingState);
  q<HTMLInputElement>('qwqnt-pgp-binding-search').addEventListener('input', event => {
    const input = event.currentTarget as HTMLInputElement;
    const digits = input.value.replace(/\D/g, '');
    if (input.value !== digits) {
      const caret = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, '').length;
      input.value = digits;
      input.setSelectionRange(caret, caret);
    }
    if (bindingState.searchUin === digits) return;
    bindingState.searchUin = digits;
    bindingState.nextCursor = null;
    bindingState.request++;
    const previous = bindingSearchTimers.get(sec);
    if (previous) window.clearTimeout(previous);
    bindingSearchTimers.set(sec, window.setTimeout(() => void refreshBindingPage(sec), 300));
  });
  q<HTMLInputElement>('qwqnt-pgp-local-search').addEventListener('input', () => filterLocalKeys(sec));
  const bindingList = q('qwqnt-pgp-binding-list');
  bindingList.addEventListener('scroll', () => {
    if (bindingState.nextCursor && !bindingState.loading &&
        bindingList.scrollHeight - bindingList.scrollTop - bindingList.clientHeight <= 42) {
      void refreshBindingPage(sec, true);
    }
  });
  unsubscribeBindingChanges?.();
  unsubscribeBindingChanges = window.QwQNTPgp.onDataChanged(change => {
    if (change.kind !== 'binding') return;
    void refreshBindingPage(sec);
  });
  const server = q<HTMLInputElement>('qwqnt-pgp-keyserver');
  for (const source of ['keyserver', 'github'] as const) {
    const form = q<HTMLFormElement>(`qwqnt-pgp-${source}-search`);
    const input = form.querySelector<HTMLInputElement>('input')!;
    const submit = form.querySelector<HTMLButtonElement>('button')!;
    const results = q(`qwqnt-pgp-${source}-results`);
    let revision = 0;
    const clear = (): void => { revision++; results.replaceChildren(); };
    input.addEventListener('input', clear);
    if (source === 'keyserver') server.addEventListener('input', clear);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const query = input.value.trim();
      if (submit.disabled || !query) return;
      const request = ++revision;
      submit.disabled = true;
      void doSearch(sec, results, query, source, server.value.trim() || 'keys.openpgp.org',
        () => sec.isConnected && request === revision).finally(() => { submit.disabled = false; });
    });
  }
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

async function refreshBindingPage(sec: HTMLElement, append = false): Promise<void> {
  const state = bindingPages.get(sec);
  const list = sec.querySelector<HTMLElement>('#qwqnt-pgp-binding-list');
  if (!state || !list) return;
  const cursor = append ? state.nextCursor : null;
  const request = ++state.request;
  state.loading = true;
  state.nextCursor = null;
  if (!append) list.innerHTML = '<div class="qwqnt-pgp-item">加载绑定…</div>';
  try {
    const query = state.searchUin || undefined;
    const result = await window.QwQNTPgp.listKeyBindings(cursor ?? undefined, 50, query);
    if (request !== state.request) return;
    state.nextCursor = result.nextCursor;
    if (!append) {
      list.replaceChildren();
      if (!result.items.length) list.textContent = query ? '没有匹配的 QQ 号' : '暂无联系人绑定';
    }
    for (const binding of result.items) list.append(renderBindingRow(sec, binding));
  } catch (error) {
    if (request !== state.request) return;
    if (append) {
      state.nextCursor = cursor;
      toast('读取更多绑定失败');
    } else {
      list.textContent = `读取绑定失败：${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (request === state.request) state.loading = false;
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
  remove.className = 'q-button q-button--small q-button--secondary';
  remove.type = 'button';
  remove.textContent = '解绑';
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await window.QwQNTPgp.setKeyBinding(binding.uin, null);
      await refreshBindingPage(sec);
    } catch (error) {
      remove.disabled = false;
      toast(`解绑失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  row.append(uin, key, remove);
  return row;
}

async function refreshKeys(sec: HTMLElement): Promise<void> {
  const request = (localKeyRequests.get(sec) ?? 0) + 1;
  localKeyRequests.set(sec, request);
  const list = sec.querySelector<HTMLElement>('#qwqnt-pgp-keyList')!;
  const state = sec.querySelector<HTMLElement>('#qwqnt-pgp-keyState')!;
  list.innerHTML = '<div class="qwqnt-pgp-item">加载中…</div>';
  try {
    // Display public keys while marking whether each has a matching local secret key.
    const { public: pubs, secret: secs } = await window.QwQNTPgp.listKeys();
    if (localKeyRequests.get(sec) !== request) return;
    config = await loadConfig(true);
    if (localKeyRequests.get(sec) !== request) return;
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
      localKeyItems.set(sec, []);
      list.innerHTML = '<div class="qwqnt-pgp-item">本地没有公钥</div>';
      return;
    }
    const ordered = [...localPubs].sort((a, b) => Number(matchesKeyID(b, activeOwn?.keyID ?? '')) - Number(matchesKeyID(a, activeOwn?.keyID ?? '')));
    localKeyItems.set(sec, ordered.map(key => renderKeyItem(key, sec)));
    filterLocalKeys(sec);
    void refreshBindingPage(sec);
    if (!state.textContent.startsWith('保存默认密钥失败')) state.textContent = `${pubs.length} 个公钥`;
  } catch (err) {
    if (localKeyRequests.get(sec) !== request) return;
    list.innerHTML = `<div class="qwqnt-pgp-item">加载失败：${escapeHtml(String(err instanceof Error ? err.message : err))}</div>`;
  }
}

function filterLocalKeys(sec: HTMLElement): void {
  const list = sec.querySelector<HTMLElement>('#qwqnt-pgp-keyList');
  const input = sec.querySelector<HTMLInputElement>('#qwqnt-pgp-local-search');
  const items = localKeyItems.get(sec);
  if (!list || !items) return;
  const query = input?.value.trim().toLocaleLowerCase() ?? '';
  const matching = items.filter(item => !query || (item.dataset.search ?? '').includes(query));
  list.replaceChildren();
  if (!matching.length) list.innerHTML = '<div class="qwqnt-pgp-item">没有匹配的本机公钥</div>';
  else list.append(...matching);
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
  item.dataset.search = [k.userIds.join(' '), k.keyID, k.fingerprint].join(' ').toLocaleLowerCase();
  const mine = isUsableOwnKey(k) && matchesKeyID(k, config?.ownKeyID ?? '');
  item.innerHTML = `
    <div><b>${escapeHtml(k.userIds[0] ?? '(无 UID)')}</b>${mine ? ' <span class="qwqnt-pgp-key-mine">[我的公钥]</span>' : ''}</div>
    <div class="meta">${escapeHtml(k.keyID)} · ${escapeHtml(k.algo)} ${k.bits || ''}位${k.expires ? ` · 过期：${fmtDate(k.expires)}` : ''}</div>
    <div class="qwqnt-pgp-bindRow">
      <input type="text" class="qwqnt-pgp-field qwqnt-pgp-bindInput" aria-label="绑定 QQ 号" placeholder="输入 QQ 号，多个用逗号分隔">
      <button type="button" class="q-button q-button--small q-button--secondary" data-act="bind">绑定</button>
    </div>
    <div class="qwqnt-pgp-hint qwqnt-pgp-bindError" role="status"></div>
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
      toast(`已绑定 ${uins.length} 个 QQ 号`);
    } catch (err) {
      toast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  item.querySelector<HTMLButtonElement>('button[data-act="bind"]')!.addEventListener('click', () => void commit());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
  });

  return item;
}

async function doSearch(sec: HTMLElement, list: HTMLElement, query: string, source: 'keyserver' | 'github', server: string, isCurrent: () => boolean): Promise<void> {
  const fingerprint = query.replace(/^0x/i, '').replace(/\s/g, '');
  const isFingerprint = /^(?:[\da-f]{40}|[\da-f]{64})$/i.test(fingerprint);
  if (source === 'keyserver' && !isFingerprint && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) {
    list.textContent = '请输入邮箱或完整指纹';
    return;
  }
  list.innerHTML = '<div class="qwqnt-pgp-item">搜索中…</div>';
  try {
    // 先拿本地已有的 key，判断结果是不是已经导入过
    const [local, results] = await Promise.all([
      listAllKeys().catch(() => [] as KeyInfo[]),
      source === 'github' ? window.QwQNTPgp.searchGithub(query)
        : window.QwQNTPgp.searchKeyserver(isFingerprint ? `0x${fingerprint}` : query, server)
    ]);
    if (!isCurrent()) return;
    const known = new Set<string>();
    for (const k of local) {
      if (k.keyID) known.add(k.keyID.toLowerCase());
      if (k.fingerprint) known.add(k.fingerprint.toLowerCase());
    }

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
        <div><b>${escapeHtml(r.userIds[0] ?? r.keyID)}</b></div>
        <div class="meta">${escapeHtml(r.keyID)}${r.bits ? ` · ${r.bits}位` : ''}${r.created ? ` · ${fmtDate(r.created)}` : ''}</div>
        <div class="ops"><button class="q-button q-button--small q-button--secondary" type="button" data-act="import" ${imported ? 'disabled' : ''}>${imported ? '已导入' : '导入'}</button></div>
      `;
      const btn = item.querySelector<HTMLButtonElement>('button[data-act="import"]')!;
      if (!imported) {
        btn.addEventListener('click', async () => {
          if (!isCurrent()) return;
          btn.disabled = true;
          btn.textContent = '导入中…';
          try {
            if (r.armored) {
              await window.QwQNTPgp.importKey(r.armored);
            } else if (source === 'keyserver') {
              await window.QwQNTPgp.recvKey(r.fingerprint || r.keyID, server);
            } else {
              throw new Error('GitHub 未提供可导入的公钥');
            }
            btn.textContent = '已导入';
            if (sec.isConnected) void refreshKeys(sec);
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
    if (isCurrent()) list.innerHTML = `<div class="qwqnt-pgp-item">搜索失败：${escapeHtml(String(err instanceof Error ? err.message : err))}</div>`;
  }
}

/* ---------------- 测试 ---------------- */
function renderTestSection(): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'qwqnt-pgp-sec';
  sec.innerHTML = `
    <details class="qwqnt-pgp-details"><summary>加解密测试</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-row"><label>收件人</label><select id="qwqnt-pgp-testKeySelect" class="qwqnt-pgp-select"><option value="">选择本地公钥</option></select></div>
      <div class="qwqnt-pgp-test-field">
        <div class="qwqnt-pgp-row"><label for="qwqnt-pgp-testPlain">明文</label><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-copyPlain" style="margin-left:auto">复制</button></div>
        <textarea id="qwqnt-pgp-testPlain" class="qwqnt-pgp-tea">hello qwqnt-pgp</textarea>
      </div>
      <div class="qwqnt-pgp-row"><button class="q-button q-button--small q-button--primary" id="qwqnt-pgp-doEncrypt">加密</button><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-doDecrypt">解密</button></div>
      <div class="qwqnt-pgp-test-field">
        <div class="qwqnt-pgp-row"><label for="qwqnt-pgp-testCipher">密文</label><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-copyCipher" style="margin-left:auto">复制</button></div>
        <textarea id="qwqnt-pgp-testCipher" class="qwqnt-pgp-tea" placeholder="-----BEGIN PGP MESSAGE-----"></textarea>
      </div>
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
