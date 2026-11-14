/** 通过框架的设置扩展注册「PGP 加密」页。 */
import { log } from './log';
import { toast } from './toast';
import { getActiveAccountId, getKeyBindings, loadConfig, saveConfig, setKeyBinding } from './config-cache';
import { friendsCache, keysCache, readFriends, readKeys } from './contact-lists';
import { injectGroupStyle, refreshButton } from './groupPanel';
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
interface BindingPageState { items?: KeyBinding[]; shown: number; searchUin: string; expires: number; revision: number; pending?: Promise<void>; }
interface SelectControl { root: HTMLElement; wrapper: HTMLElement; close: () => void; }
const bindingPages = new WeakMap<HTMLElement, BindingPageState>();
const selectControls = new Set<SelectControl>();
const selectControlsByRoot = new WeakMap<HTMLElement, Set<SelectControl>>();
const keyLabels = new Map<string, { uid: string; fingerprint: string }>();
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
  injectGroupStyle();
  host.innerHTML = '';
  // 顶部留一点空隙，避免第一段被 QQ 的标题栏压住
  host.style.paddingTop = '8px';
  host.style.paddingBottom = '24px';
  host.append(renderConfigSection(), renderContactsSection());
  void refreshKeys(host);
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
      trigger.title = selected?.textContent?.trim() ?? '';
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
        item.title = item.textContent;
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
  .qwqnt-pgp-setting-select:has(> #qwqnt-pgp-ownKey) { flex:1; width:auto; margin-inline-start:0; }
  .qwqnt-pgp-native-select { position:absolute!important; width:1px!important; height:1px!important; padding:0!important; margin:-1px!important; overflow:hidden!important; clip:rect(0,0,0,0)!important; white-space:nowrap!important; border:0!important; }
  .qwqnt-pgp-setting-select .setting-view { box-sizing:border-box; display:block; width:100%; height:100%; padding:0 24px 0 8px; border:1px solid rgba(127,127,127,.2); border-radius:4px; background:transparent; color:var(--text_primary,inherit); text-align:left; font:inherit; font-weight:400; font-size:12px; line-height:24px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
  .qwqnt-pgp-setting-select .setting-view::after { content:''; position:absolute; right:10px; top:50%; width:7px; height:7px; border-right:1px solid currentColor; border-bottom:1px solid currentColor; transform:translateY(-65%) rotate(45deg); }
  .qwqnt-pgp-setting-select .setting-view:hover { border-color:rgba(127,127,127,.4); }
  .qwqnt-pgp-setting-select:has(select[aria-busy=true]) .setting-view::after { border:1px solid currentColor; border-inline-end-color:transparent; border-radius:50%; top:calc(50% - 4px); animation:qwqnt-pgp-refresh-spin .75s linear infinite; }
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
  .qwqnt-pgp-contact-scroll { overflow-y:auto; overscroll-behavior-y:auto; scrollbar-gutter:stable; scrollbar-width:thin !important; scrollbar-color:var(--text_tertiary,rgba(127,127,127,.55)) transparent; }
  .qwqnt-pgp-contact-scroll::-webkit-scrollbar { display:block !important; width:6px !important; }
  .qwqnt-pgp-contact-scroll::-webkit-scrollbar-thumb { background:var(--text_tertiary,rgba(127,127,127,.55)); border-radius:6px; }
  .qwqnt-pgp-contact-scroll:focus-visible { outline:2px solid var(--brand_standard,#0099ff); outline-offset:-2px; }
  #qwqnt-pgp-keyList { max-height:calc(5 * 94px); }
  #qwqnt-pgp-keyList > .qwqnt-pgp-item:has(.qwqnt-pgp-bindRow) { box-sizing:border-box; block-size:94px; overflow:auto; }
  #qwqnt-pgp-binding-list { max-height:calc(5 * 42px); }
  #qwqnt-pgp-binding-list > .qwqnt-pgp-binding-row { box-sizing:border-box; block-size:42px; }
  .qwqnt-pgp-network-github { margin-top:12px; padding-top:12px; border-top:1px solid var(--border_level_1,rgba(127,127,127,.16)); }
  .qwqnt-pgp-binding-row { display:flex; align-items:center; gap:8px; min-width:0; padding:7px 10px; border-top:1px solid var(--border_level_1,rgba(127,127,127,.16)); font-size:12px; }
  .qwqnt-pgp-binding-row:first-child { border-top:0; }
  .qwqnt-pgp-binding-row .binding-uin { flex:none; font-variant-numeric:tabular-nums; user-select:text; cursor:text; }
  .qwqnt-pgp-binding-row .binding-uid { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.75; }
  .qwqnt-pgp-binding-row .binding-key { flex:none; text-align:right; white-space:nowrap; opacity:.75; font-variant-numeric:tabular-nums; }
  #qwqnt-pgp-friends { max-height:calc(3 * 36px); }
  #qwqnt-pgp-friends .qwqnt-pgp-friend { min-height:36px; }
  #qwqnt-pgp-bind-keys { max-height:108px; }
  #qwqnt-pgp-bind-keys .qwqnt-pgp-friend { min-height:36px; }
  .qwqnt-pgp-friend { display:flex; align-items:center; gap:6px; min-height:52px; box-sizing:border-box; padding:6px 8px; border-top:1px solid var(--border_level_1,rgba(127,127,127,.16)); cursor:pointer; }
  .qwqnt-pgp-friend:first-child { border-top:0; }
  .qwqnt-pgp-friend:has(> .q-checkbox.is-checked) { box-shadow:inset 2px 0 var(--brand_standard,#0099ff); background:color-mix(in srgb,var(--brand_standard,#0099ff) 12%,transparent); }
  .qwqnt-pgp-friend:has(> .q-checkbox.is-checked) .friend-label { font-weight:600; }
  .qwqnt-pgp-friend > .q-checkbox { flex:none; margin:0; }
  .qwqnt-pgp-friend img { flex:none; width:18px; height:18px; border-radius:50%; object-fit:cover; }
  .qwqnt-pgp-friend .friend-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; line-height:18px; }
  .qwqnt-pgp-friend .friend-detail { flex:none; text-align:right; white-space:nowrap; font-size:11px; font-variant-numeric:tabular-nums; color:var(--text_secondary,inherit); }
  .qwqnt-pgp-bind-controls > .qwqnt-pgp-row > label { width:auto; }
  .qwqnt-pgp-bind-controls { display:grid; gap:8px; }
  #qwqnt-pgp-bind-submit { inline-size:100%; min-block-size:32px; }
  #qwqnt-pgp-bind-submit:disabled { opacity:.45; cursor:default; }
  .qwqnt-pgp-section-heading { margin:16px 12px 8px; font-size:14px; font-weight:600; }
  .qwqnt-pgp-contact-details > .qwqnt-pgp-details-body { padding-block:10px; }
  #qwqnt-pgp-bind-details > .qwqnt-pgp-details-body { padding-block-start:4px; }
  .qwqnt-pgp-bind-controls > .qwqnt-pgp-row:first-child { margin-block-start:0; }
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
    <h2 class="qwqnt-pgp-section-heading">基本设置</h2>
    <details class="qwqnt-pgp-details">
      <summary>加密解密</summary><div class="qwqnt-pgp-details-body">
        <div class="qwqnt-pgp-row qwqnt-pgp-bool"><label id="qwqnt-pgp-autoDecrypt-label">自动解密</label><input id="qwqnt-pgp-autoDecrypt" class="qwqnt-pgp-switch-input" type="checkbox" aria-hidden="true" tabindex="-1" ${cfg.autoDecrypt ? 'checked' : ''}><div id="qwqnt-pgp-autoDecrypt-switch" class="q-switch qwqnt-pgp-switch${cfg.autoDecrypt ? ' is-active' : ''}" role="switch" tabindex="0" aria-labelledby="qwqnt-pgp-autoDecrypt-label" aria-checked="${cfg.autoDecrypt}"><span class="q-switch__handle"></span></div></div>
        <div class="qwqnt-pgp-row"><label>我的公钥</label><select id="qwqnt-pgp-ownKey" class="qwqnt-pgp-select" aria-busy="true"><option value=""></option></select></div>
        <div class="qwqnt-pgp-row"><label>gpg 路径</label><input id="qwqnt-pgp-gpgPath" type="text" placeholder="自动探测" value="${escapeAttr(cfg.gpgPath)}"><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-detect">检测</button></div>
        <div class="qwqnt-pgp-row"><label>钥匙串目录</label><input id="qwqnt-pgp-gpgHome" type="text" placeholder="使用默认目录" value="${escapeAttr(cfg.gpgHome)}"></div>
        <div class="qwqnt-pgp-hint" id="qwqnt-pgp-gpgStatus" role="status"></div>
      </div>
    </details>
    <details class="qwqnt-pgp-details">
      <summary>发送设置</summary><div class="qwqnt-pgp-details-body">
        <div class="qwqnt-pgp-row"><label>发送策略</label><select id="qwqnt-pgp-sendPolicy" class="qwqnt-pgp-select">
          <option value="manual" ${cfg.sendPolicy === 'manual' ? 'selected' : ''}>快捷键手动加密</option><option value="auto" ${cfg.sendPolicy === 'auto' ? 'selected' : ''}>发送时自动加密</option><option value="off" ${cfg.sendPolicy === 'off' ? 'selected' : ''}>不加密</option>
        </select></div>
        <div class="qwqnt-pgp-row"><label>加密快捷键</label><input id="qwqnt-pgp-hotkey" type="text" readonly placeholder="按组合键" value="${escapeAttr(cfg.hotkey)}"><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-hotkeyReset">重置</button></div>
      </div>
    </details>
    <div class="qwqnt-pgp-hint" id="qwqnt-pgp-saveState" role="status"></div>
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
    el.addEventListener('change', () => {
      if (el.id === 'qwqnt-pgp-ownKey') {
        const ownKeyID = (el as HTMLSelectElement).value;
        if (!ownKeyID || config?.ownKeyID === ownKeyID) return;
        void saveConfig({ ownKeyID }).then(next => { config = next; }).catch(err => toast(`保存密钥失败：${err instanceof Error ? err.message : String(err)}`));
      } else void autoSave();
    });
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
    <h2 class="qwqnt-pgp-section-heading">好友管理</h2>
    <details class="qwqnt-pgp-details qwqnt-pgp-contact-details" id="qwqnt-pgp-bind-details"><summary>绑定公钥</summary><div class="qwqnt-pgp-details-body">
      <div class="qwqnt-pgp-bind-controls">
        <div class="qwqnt-pgp-row"><label for="qwqnt-pgp-friend-search">好友</label><input class="qwqnt-pgp-field" id="qwqnt-pgp-friend-search" type="text" inputmode="numeric" placeholder="搜索 QQ 号"><button class="q-button q-button--small q-button--secondary" id="qwqnt-pgp-add-uin">添加</button>${refreshButton('刷新好友')}</div>
        <div class="qwqnt-pgp-list qwqnt-pgp-contact-scroll" id="qwqnt-pgp-friends" aria-label="未绑定好友"></div>
        <div class="qwqnt-pgp-row"><label for="qwqnt-pgp-key-search">公钥</label><input class="qwqnt-pgp-field" id="qwqnt-pgp-key-search" type="text" placeholder="搜索本机公钥">${refreshButton('刷新公钥')}</div>
        <div class="qwqnt-pgp-list qwqnt-pgp-contact-scroll" id="qwqnt-pgp-bind-keys" aria-label="选择一个公钥"></div>
        <button type="button" class="q-button q-button--middle q-button--secondary" id="qwqnt-pgp-bind-submit" disabled>绑定</button>
      </div>
    </div></details>
    <details class="qwqnt-pgp-details qwqnt-pgp-contact-details" id="qwqnt-pgp-binding-preview"><summary>绑定管理</summary><div class="qwqnt-pgp-details-body qwqnt-pgp-contact-panel">
        <input class="qwqnt-pgp-field" id="qwqnt-pgp-binding-search" type="text" inputmode="numeric" aria-label="筛选已绑定 QQ 号" placeholder="筛选 QQ 号">
        <div class="qwqnt-pgp-list qwqnt-pgp-contact-scroll" id="qwqnt-pgp-binding-list" tabindex="0" aria-label="已绑定 QQ 号列表"></div>
    </div></details>
  `;
  const updateCandidate = setupBindUI(sec);
  const bindingState: BindingPageState = { shown: 50, searchUin: '', expires: 0, revision: 0 };
  bindingPages.set(sec, bindingState);
  const bindingList = sec.querySelector<HTMLElement>('#qwqnt-pgp-binding-list')!;
  sec.querySelector<HTMLInputElement>('#qwqnt-pgp-binding-search')!.addEventListener('input', event => {
    const input = event.currentTarget as HTMLInputElement;
    const digits = input.value.replace(/\D/g, '');
    if (input.value !== digits) {
      const caret = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, '').length;
      input.value = digits;
      input.setSelectionRange(caret, caret);
    }
    if (bindingState.searchUin === digits) return;
    bindingState.searchUin = digits;
    bindingState.shown = 50;
    bindingList.scrollTop = 0;
    renderBindingPage(sec);
    void refreshBindingPage(sec);
  });
  bindingList.addEventListener('scroll', () => {
    if (bindingList.scrollHeight - bindingList.scrollTop - bindingList.clientHeight <= 42) renderBindingPage(sec, true);
  });
  const preview = sec.querySelector<HTMLDetailsElement>('#qwqnt-pgp-binding-preview')!;
  preview.addEventListener('toggle', () => { if (preview.open) void refreshBindingPage(sec); });
  unsubscribeBindingChanges?.();
  unsubscribeBindingChanges = window.QwQNTPgp.onDataChanged(change => {
    if (change.kind !== 'binding' || change.accountId !== getActiveAccountId()) return;
    updateCandidate(change.id);
    bindingState.revision++;
    bindingState.expires = 0;
    void refreshBindingPage(sec);
  });
  void refreshBindingPage(sec);
  return sec;
}

interface FriendEntry { uin: string; name: string; }
function setupBindUI(sec: HTMLElement): (uin: string) => void {
  const details = sec.querySelector<HTMLDetailsElement>('#qwqnt-pgp-bind-details')!;
  const friendsList = sec.querySelector<HTMLElement>('#qwqnt-pgp-friends')!;
  const search = sec.querySelector<HTMLInputElement>('#qwqnt-pgp-friend-search')!;
  const keySearch = sec.querySelector<HTMLInputElement>('#qwqnt-pgp-key-search')!;
  const friendRefresh = search.parentElement!.querySelector<HTMLButtonElement>('.qwqnt-pgp-group-refresh')!;
  const keyRefresh = keySearch.parentElement!.querySelector<HTMLButtonElement>('.qwqnt-pgp-group-refresh')!;
  const keyList = sec.querySelector<HTMLElement>('#qwqnt-pgp-bind-keys')!;
  const submit = sec.querySelector<HTMLButtonElement>('#qwqnt-pgp-bind-submit')!;
  let friends: FriendEntry[] = [];
  let friendsReady = false;
  let bound = new Set<string>();
  let friendFailures = 0;
  let keys: KeyInfo[] = [];
  let selectedKeyID = '';
  let selectedFriends = new Set<string>();
  let manualIds: string[] = [];
  const manualNames = new Map<string, string>();
  let selectedManual = new Set<string>();
  let generation = 0;
  let submitting = false;
  const selectedRecipients = (): string[] => [...new Set([
    ...friends.filter(friend => selectedFriends.has(friend.uin)).map(friend => friend.uin),
    ...manualIds.filter(uin => selectedManual.has(uin)),
  ])].filter(uin => !bound.has(uin));
  const updateSubmit = (): void => {
    submit.disabled = submitting || !selectedKeyID ||
      !keys.some(key => (key.fingerprint || key.keyID) === selectedKeyID) || !selectedRecipients().length;
  };
  const choice = (row: HTMLElement, id: string, name: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement => {
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = checked;
    check.tabIndex = -1;
    check.setAttribute('aria-hidden', 'true');
    const checkbox = document.createElement('label');
    checkbox.className = check.checked ? 'q-checkbox is-checked' : 'q-checkbox';
    checkbox.tabIndex = 0;
    checkbox.dataset.choice = id;
    checkbox.setAttribute('role', 'checkbox');
    checkbox.setAttribute('bf-label-inner', 'true');
    checkbox.setAttribute('aria-checked', String(check.checked));
    checkbox.setAttribute('aria-label', name);
    const indicator = document.createElement('span');
    indicator.className = 'q-checkbox__input';
    indicator.dataset.number = '';
    checkbox.append(check, indicator);
    checkbox.addEventListener('keydown', event => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (!event.repeat) check.click();
    });
    row.addEventListener('click', event => {
      if (!checkbox.contains(event.target as Node)) check.click();
    });
    check.addEventListener('change', () => onChange(check.checked));
    return checkbox;
  };
  const render = (): void => {
    updateSubmit();
    const q = search.value.trim();
    const filtered = friends.filter(f => !bound.has(f.uin) && (selectedFriends.has(f.uin) || !q || f.uin.includes(q)));
    const friendScroll = friendsList.scrollTop;
    const keyScroll = keyList.scrollTop;
    const focusedFriend = document.activeElement instanceof HTMLElement && friendsList.contains(document.activeElement)
      ? document.activeElement.dataset.choice : undefined;
    const focusedKey = document.activeElement instanceof HTMLElement && keyList.contains(document.activeElement)
      ? document.activeElement.dataset.choice : undefined;
    friendsList.replaceChildren();
    const selected = filtered.filter(friend => selectedFriends.has(friend.uin));
    const unselected = filtered.filter(friend => !selectedFriends.has(friend.uin));
    const orderedManual = manualIds.filter(uin => !bound.has(uin) && selectedManual.has(uin));
    if ((friendsReady || friendFailures) && !filtered.length && !orderedManual.length) friendsList.textContent = friendFailures ? '部分好友绑定状态读取失败' : '没有匹配的未绑定好友';
    const renderPerson = (uin: string, name: string, selectedSet: Set<string>, manualPerson: boolean): void => {
      const row = document.createElement('div'); row.className = 'qwqnt-pgp-friend';
      const checkbox = choice(row, uin, `${name}，QQ ${uin}`, selectedSet.has(uin), checked => {
        if (checked) selectedSet.add(uin); else selectedSet.delete(uin);
        render();
      });
      const avatar = document.createElement('img'); avatar.alt = ''; avatar.loading = 'lazy'; avatar.decoding = 'async'; avatar.src = `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`;
      const label = document.createElement('span'); label.className = 'friend-label'; label.textContent = name;
      const detail = document.createElement('span'); detail.className = 'friend-detail'; detail.textContent = uin;
      row.title = `${name}\nQQ ${uin}${manualPerson ? '（手动添加）' : ''}`;
      row.append(avatar, label, detail, checkbox); friendsList.append(row);
      if (focusedFriend === uin) checkbox.focus({ preventScroll: true });
    };
    for (const friend of selected) renderPerson(friend.uin, friend.name, selectedFriends, false);
    for (const uin of orderedManual) renderPerson(uin, manualNames.get(uin) || uin, selectedManual, true);
    for (const friend of unselected) renderPerson(friend.uin, friend.name, selectedFriends, false);
    const keyQuery = keySearch.value.trim().toLocaleLowerCase();
    keyList.replaceChildren();
    const shownKeys = keys.filter(key => !keyQuery || [key.keyID, key.fingerprint, ...key.userIds].join(' ').toLocaleLowerCase().includes(keyQuery));
    if (!shownKeys.length) keyList.textContent = keys.length ? '没有匹配的公钥' : '没有可用的公钥';
    for (const key of shownKeys) {
      const row = document.createElement('div'); row.className = 'qwqnt-pgp-friend';
      const identity = key.fingerprint || key.keyID;
      const checkbox = choice(row, identity, key.userIds[0] || identity, selectedKeyID === identity, checked => {
        selectedKeyID = checked ? identity : '';
        render();
      });
      const label = document.createElement('span'); label.className = 'friend-label'; label.textContent = key.userIds[0] || identity;
      const detail = document.createElement('span'); detail.className = 'friend-detail'; detail.textContent = identity.slice(-16);
      row.title = [...key.userIds, identity].join('\n');
      row.append(label, detail, checkbox); keyList.append(row);
      if (focusedKey === identity) checkbox.focus({ preventScroll: true });
    }
    friendsList.scrollTop = friendScroll;
    keyList.scrollTop = keyScroll;
  };
  const clearTemporary = (): void => {
    generation++; selectedFriends.clear(); manualIds = []; selectedManual.clear(); selectedKeyID = '';
    manualNames.clear();
    search.value = ''; keySearch.value = '';
    submitting = false;
    render();
    for (const button of [friendRefresh, keyRefresh]) button.disabled = false;
    for (const button of [friendRefresh, keyRefresh]) button.setAttribute('aria-busy', 'false');
  };
  const load = async <T>(
    refresh: HTMLButtonElement,
    peek: (account: string) => T | undefined,
    read: (account: string, force: boolean) => Promise<T>,
    apply: (value: T, current: () => boolean) => void | Promise<void>,
    force: boolean,
  ): Promise<void> => {
    const account = getActiveAccountId();
    if (!account || refresh.disabled || !sec.isConnected) return;
    const run = generation;
    const current = (): boolean => run === generation && account === getActiveAccountId() && sec.isConnected;
    refresh.disabled = true;
    refresh.setAttribute('aria-busy', 'true');
    try {
      const cached = peek(account);
      if (!force && cached !== undefined) {
        await apply(cached, current);
        if (!current()) return;
        render();
      }
      const fresh = await read(account, force);
      if (!current()) return;
      if (force || fresh !== cached) await apply(fresh, current);
      if (current()) render();
    } catch {
      if (current() && details.open) toast(`${refresh.getAttribute('aria-label')}失败`);
    } finally {
      if (current()) {
        refresh.disabled = false;
        refresh.setAttribute('aria-busy', 'false');
      }
    }
  };
  let sharedFriends: FriendEntry[] | undefined;
  const loadFriends = (force = false): Promise<void> => load(
    friendRefresh, account => friendsCache.peek(account) ?? sharedFriends, readFriends, async (entries, current) => {
      const state = bindingPages.get(sec);
      if (!state?.items) await refreshBindingPage(sec);
      if (!current()) return;
      if (state?.items) {
        friends = entries;
        friendsReady = true;
        bound = new Set(state.items.map(binding => binding.uin));
        friendFailures = 0;
        return;
      }
      const next: FriendEntry[] = [];
      const nextBound = new Set(bound);
      let failures = 0;
      for (let i = 0; i < entries.length; i += 512) {
        const batch = entries.slice(i, i + 512);
        try {
          const bindings = await getKeyBindings(batch.map(friend => friend.uin));
          for (const friend of batch) nextBound.delete(friend.uin);
          for (const binding of bindings) nextBound.add(binding.uin);
          next.push(...batch);
        } catch { failures++; }
        if (!current()) return;
      }
      if (!failures || next.length) {
        friends = next;
        friendsReady = true;
      }
      bound = nextBound;
      friendFailures = failures;
    }, force,
  );
  const loadKeys = (force = false): Promise<void> => load(
    keyRefresh, account => keysCache.peek(account), readKeys, inventory => {
      keys = inventory.public.filter(key => !key.expired && !key.revoked && !!(key.fingerprint || key.keyID));
    }, force,
  );
  const initialAccount = getActiveAccountId();
  const warmFriends = initialAccount ? window.QwQNTPgp.cachedFriends().then(entries => {
    if (entries && sec.isConnected && getActiveAccountId() === initialAccount && !friendsCache.peek(initialAccount)) {
      sharedFriends = entries;
    }
  }).catch(err => log(`读取好友缓存失败：${String(err)}`)) : Promise.resolve();
  void warmFriends.then(() => loadFriends());
  details.addEventListener('toggle', () => {
    if (details.open) {
      void warmFriends.then(() => { if (details.open && sec.isConnected) void loadFriends(); });
      void loadKeys();
    } else clearTemporary();
  });
  friendRefresh.addEventListener('click', () => void loadFriends(true));
  keyRefresh.addEventListener('click', () => void loadKeys(true));
  search.addEventListener('input', () => { const digits = search.value.replace(/\D/g, ''); if (digits !== search.value) search.value = digits; render(); });
  keySearch.addEventListener('input', render);
  const addManual = async (): Promise<void> => {
    const request = generation, account = settingsAccountEpoch;
    const uin = search.value.trim();
    if (!/^[1-9]\d{0,19}$/.test(uin)) { toast('请输入有效的数字 QQ 号'); return; }
    try {
      const bindings = await window.QwQNTPgp.getKeyBindings([uin]);
      if (request !== generation || account !== settingsAccountEpoch || !details.open) return;
      if (bindings.some(binding => binding.uin === uin)) {
        bound.add(uin);
        selectedFriends.delete(uin);
        selectedManual.delete(uin);
        toast('该 QQ 号已绑定');
        render();
        return;
      }
      if (friends.some(friend => friend.uin === uin)) {
        selectedFriends.add(uin);
        search.value = ''; render(); return;
      }
      let contact: FriendEntry = { uin, name: 'QQ 用户' };
      try { contact = await window.QwQNTPgp.lookupContact(uin); } catch { /* 保留 QQ 用户兜底名 */ }
      if (request !== generation || account !== settingsAccountEpoch || !details.open) return;
      if (!manualIds.includes(uin)) manualIds.push(uin);
      manualNames.set(uin, contact.name); selectedManual.add(uin);
      search.value = ''; render();
    } catch (err) { if (request === generation && account === settingsAccountEpoch) toast(`检查绑定状态失败：${err instanceof Error ? err.message : String(err)}`); }
  };
  sec.querySelector<HTMLButtonElement>('#qwqnt-pgp-add-uin')!.addEventListener('click', () => void addManual());
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void addManual(); } });
  submit.addEventListener('click', async () => {
    const request = generation, account = settingsAccountEpoch;
    updateSubmit();
    if (submit.disabled) return;
    const unique = selectedRecipients();
    const keyID = selectedKeyID;
    submitting = true;
    updateSubmit();
    try {
      const results = await Promise.allSettled(unique.map(uin => window.QwQNTPgp.bindNewKey(uin, keyID)));
      if (request !== generation || account !== settingsAccountEpoch || !details.open) return;
      const succeeded = unique.filter((_, index) => results[index]?.status === 'fulfilled');
      const failed = unique.filter((_, index) => results[index]?.status === 'rejected');
      for (const uin of succeeded) { bound.add(uin); selectedFriends.delete(uin); selectedManual.delete(uin); }
      if (!failed.length) {
        selectedFriends.clear();
        selectedManual.clear();
        selectedKeyID = '';
        search.value = '';
        keySearch.value = '';
      }
      toast(failed.length ? `已绑定 ${succeeded.length} 个，失败 ${failed.length} 个（仍保留失败项）` : `已绑定 ${succeeded.length} 个 QQ 号`);
      const page = sec.querySelector<HTMLElement>('#qwqnt-pgp-binding-list')?.closest('section');
      if (page && succeeded.length) updateBindingPreview(page, succeeded, keyID);
      render();
    } catch (err) { if (request === generation && account === settingsAccountEpoch) toast(`绑定失败：${err instanceof Error ? err.message : String(err)}`); }
    finally {
      if (request === generation && account === settingsAccountEpoch) {
        submitting = false;
        updateSubmit();
      }
    }
  });
  return uin => {
    if (!details.open || (!friends.some(friend => friend.uin === uin) && !manualIds.includes(uin))) return;
    const request = generation;
    const account = settingsAccountEpoch;
    void window.QwQNTPgp.getKeyBindings([uin]).then(bindings => {
      if (request !== generation || account !== settingsAccountEpoch || !details.open) return;
      if (bindings.length) {
        bound.add(uin);
        selectedFriends.delete(uin);
        selectedManual.delete(uin);
      } else bound.delete(uin);
      render();
    }).catch(err => log(`刷新好友绑定失败：${String(err)}`));
  };
}

function updateBindingPreview(sec: HTMLElement, uins: string[], keyID?: string): void {
  const state = bindingPages.get(sec);
  if (!state) return;
  if (state.items) {
    const changed = new Set(uins);
    state.items = state.items.filter(binding => !changed.has(binding.uin));
    if (keyID) state.items.push(...uins.map(uin => ({ uin, keyID })));
    state.items.sort((a, b) => a.uin.localeCompare(b.uin));
    renderBindingPage(sec);
  }
  state.revision++;
  state.expires = 0;
  void refreshBindingPage(sec);
}

function renderBindingPage(sec: HTMLElement, append = false): void {
  const state = bindingPages.get(sec);
  const list = sec.querySelector<HTMLElement>('#qwqnt-pgp-binding-list');
  if (!state?.items || !list) return;
  const matches = state.items.filter(binding => binding.uin.includes(state.searchUin));
  const start = append ? state.shown : 0;
  if (append) {
    if (start >= matches.length) return;
    state.shown += 50;
  } else {
    list.replaceChildren();
    if (!matches.length) list.textContent = state.searchUin ? '没有匹配的 QQ 号' : '暂无联系人绑定';
  }
  for (const binding of matches.slice(start, state.shown)) list.append(renderBindingRow(sec, binding));
}

async function refreshBindingPage(sec: HTMLElement): Promise<void> {
  const state = bindingPages.get(sec);
  const account = getActiveAccountId();
  if (!state || !account || state.expires > Date.now()) return;
  if (state.pending) return state.pending;
  const epoch = settingsAccountEpoch;
  const current = () => epoch === settingsAccountEpoch && account === getActiveAccountId();
  const revision = state.revision;
  state.pending = (async () => {
    try {
      const items = await window.QwQNTPgp.bindingList();
      if (!current() || revision !== state.revision) return;
      state.items = items;
      state.expires = Date.now() + 5_000;
      renderBindingPage(sec);
    } catch {
      if (current() && !state.items) toast('读取联系人绑定失败');
    }
  })();
  try {
    await state.pending;
  } finally {
    state.pending = undefined;
    if (current() && revision !== state.revision) void refreshBindingPage(sec);
  }
}

function renderBindingRow(sec: HTMLElement, binding: KeyBinding): HTMLElement {
  const row = document.createElement('div');
  row.className = 'qwqnt-pgp-binding-row';
  const uin = document.createElement('span');
  uin.className = 'binding-uin';
  uin.textContent = binding.uin;
  const info = keyLabels.get(normalizeKeyID(binding.keyID));
  const uid = document.createElement('span');
  uid.className = 'binding-uid';
  uid.textContent = info?.uid ?? '';
  const key = document.createElement('span');
  key.className = 'binding-key';
  const fullFingerprint = info?.fingerprint ?? binding.keyID;
  key.textContent = fullFingerprint.slice(-16);
  key.title = [info?.uid, fullFingerprint].filter(Boolean).join('\n');
  uid.title = key.title;
  key.setAttribute('aria-label', `密钥指纹：${fullFingerprint}`);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'q-button q-button--small q-button--secondary';
  remove.textContent = '解绑';
  remove.setAttribute('aria-label', `解绑 QQ ${binding.uin}`);
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await setKeyBinding(binding.uin, null);
      if (sec.isConnected) updateBindingPreview(sec, [binding.uin]);
    } catch (err) {
      remove.disabled = false;
      toast(`解绑失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });
  row.append(uin, uid, key, remove);
  return row;
}

function normalizeKeyID(id: string): string {
  return id.trim().replace(/^0x/i, '').toUpperCase();
}

async function refreshKeys(host: HTMLElement): Promise<void> {
  const select = host.querySelector<HTMLSelectElement>('#qwqnt-pgp-ownKey');
  if (!select) return;
  try {
    const account = getActiveAccountId();
    if (!account) return;
    const { public: pubs, secret: secs } = await readKeys(account);
    const next = await loadConfig(true);
    if (mountedHost !== host || !host.contains(select)) return;
    config = next;
    const secretFprs = new Set(secs.map(s => s.fingerprint));
    const ownKeys = pubs.map(key => ({ ...key, secret: secretFprs.has(key.fingerprint) })).filter(isUsableOwnKey);
    keyLabels.clear();
    for (const key of pubs) {
      for (const entry of [key, ...key.subkeys]) {
        const info = { uid: key.userIds.join('\n'), fingerprint: entry.fingerprint || entry.keyID };
        for (const id of [entry.keyID, entry.fingerprint]) if (id) keyLabels.set(normalizeKeyID(id), info);
      }
    }
    const bindingSection = mountedHost?.querySelector<HTMLElement>('#qwqnt-pgp-binding-list')?.closest('section');
    if (bindingSection) renderBindingPage(bindingSection);
    const selected = ownKeys.find(key => matchesKeyID(key, config?.ownKeyID ?? '')) ?? ownKeys[0];
    const selectedId = selected ? selected.fingerprint || selected.keyID : '';
    if (selected && !matchesKeyID(selected, config?.ownKeyID ?? '')) config = await saveConfig({ ownKeyID: selectedId });
    select.replaceChildren();
    if (!ownKeys.length) select.add(new Option('没有可用的私钥公钥', ''));
    else for (const key of ownKeys) {
      const id = key.fingerprint || key.keyID;
      const option = new Option(`${key.userIds[0] || '(无 UID)'} · ${key.keyID}`, id);
      option.title = key.fingerprint;
      select.add(option);
    }
    select.value = selectedId;
    select.dispatchEvent(new Event('change'));
  } catch (err) {
    select.replaceChildren(new Option(`读取钥匙串失败：${err instanceof Error ? err.message : String(err)}`, ''));
    select.dispatchEvent(new Event('change'));
  } finally {
    select.removeAttribute('aria-busy');
  }
}

function matchesKeyID(key: KeyInfo, keyID: string): boolean {
  return !!keyID && (key.keyID === keyID || key.fingerprint === keyID);
}

function isUsableOwnKey(key: KeyInfo): boolean {
  return key.secret && !key.expired && !key.revoked;
}

/* ---------------- 工具 ---------------- */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
