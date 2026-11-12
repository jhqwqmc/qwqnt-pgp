/**
 * 从 QQ 前端拿运行时信息（当前会话、自己的账号）。
 *
 * 关键：QQNT 把 Vue 组件实例挂在 DOM 元素的 `__VUE__` 上（QwQNT 框架负责填），
 * 从当前聊天面板的 Vue 实例读取会话 store。
 * 这个 store 里就有 `curAioData`（当前会话），不用再猜 `window.app`。
 */
import { log } from './log';
import { loadAccountContext } from './config-cache';

type AnyObj = Record<string, any>;

function vueInstancesOf(el: Element | null): AnyObj[] {
  if (!el) return [];
  const v = (el as AnyObj)['__VUE__'];
  if (!v) return [];
  if (v instanceof Set) return [...v] as AnyObj[];
  if (Array.isArray(v)) return v as AnyObj[];
  return [v as AnyObj];
}

let cachedAioStore: AnyObj | null = null;
let cachedAioHost: HTMLElement | null = null;
let cachedAioSource: 'vue' | 'pinia' | 'legacy' | null = null;
let knownAioHosts: HTMLElement[] | null = null;
let selfCache: SelfInfo | null = null;
let storeAccountEpoch = 0;
let trackerStarted = false;

/**
 * 监听 QwQNT 的 `vue:component-mount` 事件：detail 直接就是组件实例，
 * 从实例的 proxy 上取 commonAioStore —— 不用再指望 element.__VUE__。
 */
export function setupVueTracker(): void {
  if (typeof window === 'undefined' || trackerStarted) return;
  trackerStarted = true;
  const invalidateAio = (event: Event): void => {
    const comp = (event as CustomEvent).detail as AnyObj | undefined;
    if (!comp) return;
    const proxy = (comp['proxy'] ?? comp) as AnyObj;
    const store = proxy['commonAioStore'] ?? comp['commonAioStore'];
    const element = (proxy['$el'] ?? comp['$el'] ?? comp['el']) as Element | undefined;
    if (isAioStore(store) || (typeof Element !== 'undefined' && element instanceof Element && element.matches('.aio, .aio.vue-component'))) clearAioStoreCache(true);
  };
  window.addEventListener('vue:component-mount', invalidateAio);
  window.addEventListener('vue:component-unmount', invalidateAio);
  window.addEventListener('qwqnt-pgp:account-changed', () => resetStoreCache());
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
    const observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (record.type === 'attributes') {
          return !!target && (target.matches('.aio, .aio.vue-component, body, #app')
            || (knownAioHosts ?? []).some(host => target === host || target.contains(host)));
        }
        return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
          && (node.matches('.aio, .aio.vue-component') || !!node.querySelector('.aio.vue-component, .aio')));
      });
      if (relevant) clearAioStoreCache(true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
  }
  log('vue 组件跟踪已挂上');
}

function storeOnComponent(component: AnyObj): AnyObj | null {
  for (const source of [component['proxy'], component['setupState'], component]) {
    const store = source?.['commonAioStore'];
    const value = store?.['__v_isRef'] === true ? store['value'] : store;
    if (isAioStore(value)) return value;
  }
  return null;
}

function storeFromEditor(host: HTMLElement, editor: Element): AnyObj | null {
  for (let element: Element | null = editor; element; element = element.parentElement) {
    for (const component of vueInstancesOf(element)) {
      const store = storeOnComponent(component);
      if (store) return store;
    }
    let component = (element as AnyObj)['__vueParentComponent'] as AnyObj | undefined;
    for (let depth = 0; component && depth < 32; depth++, component = component['parent']) {
      const root = component['vnode']?.['el'];
      if (root instanceof Element && !host.contains(root)) break;
      const store = storeOnComponent(component);
      if (store) return store;
    }
    if (element === host) break;
  }
  return null;
}

/** 拿 QQ 的 aioStore（里面有 curAioData） */
export function getAioStore(editor?: Element): AnyObj | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  setupVueTracker();
  const editorHost = editor?.closest<HTMLElement>('.aio') ?? editor?.closest<HTMLElement>('.message-panel') ?? null;
  if (editor && (!editorHost || !isVisibleChatHost(editorHost))) return null;
  const focusedHost = editorHost ?? document.activeElement?.closest<HTMLElement>('.aio.vue-component, .aio') ?? null;
  if (cachedAioStore && cachedAioHost && (!editor || cachedAioSource === 'vue')
    && (!focusedHost || focusedHost === cachedAioHost)
    && isHostLightweightVisible(cachedAioHost)
    && currentHostStore(cachedAioHost, cachedAioSource) === cachedAioStore) return cachedAioStore;
  clearAioStoreCache();
  const allHosts = Array.from(document.querySelectorAll<HTMLElement>('.aio.vue-component, .aio'));
  knownAioHosts = allHosts;
  const hosts = allHosts.filter(isVisibleChatHost);
  const currentHosts = editorHost ? [editorHost] : selectCurrentChatHosts(hosts);
  if (currentHosts.length !== 1) return null;
  const host = currentHosts[0]!;

  // 使用当前聊天面板挂载的 Vue 实例。
  for (const inst of vueInstancesOf(host)) {
    const store = storeOnComponent(inst);
    if (store) return cacheStore(store, host, 'vue', 'visible AIO Vue instance');
  }
  if (editor) {
    const store = storeFromEditor(host, editor);
    if (store) return store;
    if (hosts.some(candidate => candidate !== host && !host.contains(candidate))) return null;
  }

  // QQ also exposes this exact Pinia store in some builds. Never scan unrelated
  // stores by shape: that can silently pick a background or stale conversation.
  const appEl = document.querySelector('#app') as AnyObj | null;
  const vueApp = (appEl?.['__vue_app__'] ?? (window as AnyObj)['__vue_app__']) as AnyObj | undefined;
  const pinia = (vueApp?.['config']?.['globalProperties']?.['$pinia'] ?? (window as AnyObj)['__pinia']) as AnyObj | undefined;
  const storeMap = pinia?.['_s'] as Map<string, AnyObj> | AnyObj | undefined;
  for (const name of ['common_Aio', 'commonAio', 'aioStore', 'aio']) {
    const namedStore = storeMap instanceof Map ? storeMap.get(name) : storeMap?.[name];
    if (isAioStore(namedStore)) return cacheStore(namedStore, host, 'pinia', `named Pinia store ${name}`);
  }

  // Legacy QQ builds expose the same named state through the Vue app store.
  const globals = vueApp?.['config']?.['globalProperties'];
  const legacyStore = globals?.['$store']?.['state']?.['common_Aio'];
  if (isAioStore(legacyStore)) return cacheStore(legacyStore, host, 'legacy', 'legacy named common_Aio store');

  log('没找到 aioStore（__VUE__ / pinia / window.app 都没有）');
  dumpDom();
  return null;
}

function isVisibleChatHost(host: HTMLElement): boolean {
  if (!isHostLightweightVisible(host)) return false;
  const style = window.getComputedStyle(host);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

function isHostLightweightVisible(host: HTMLElement): boolean {
  if (!host.isConnected || host.hidden || host.closest('[hidden]')
    || !(host.getClientRects().length > 0 || host.offsetParent !== null)) return false;
  const visibility = window.getComputedStyle(host).visibility;
  return visibility !== 'hidden' && visibility !== 'collapse';
}

function selectCurrentChatHosts(hosts: HTMLElement[]): HTMLElement[] {
  if (hosts.length <= 1) return hosts;
  const active = document.activeElement?.closest<HTMLElement>('.aio.vue-component, .aio');
  if (active && hosts.includes(active)) return [active];
  const marked = hosts.filter(host => host.matches('.is-active, .active, [aria-current="true"], [data-current="true"]'));
  return marked.length === 1 ? marked : [];
}

function isAioStore(value: unknown): value is AnyObj {
  return !!value && typeof value === 'object' && 'curAioData' in value;
}

function cacheStore(store: AnyObj, host: HTMLElement, source: 'vue' | 'pinia' | 'legacy', description: string): AnyObj {
  cachedAioStore = store;
  cachedAioHost = host;
  cachedAioSource = source;
  log(`aioStore 来自 ${description}`);
  return store;
}

function currentHostStore(host: HTMLElement, source: typeof cachedAioSource): AnyObj | null {
  if (source === 'vue') {
    for (const inst of vueInstancesOf(host)) {
      const store = storeOnComponent(inst);
      if (store) return store;
    }
  }
  const appEl = document.querySelector('#app') as AnyObj | null;
  const vueApp = (appEl?.['__vue_app__'] ?? (window as AnyObj)['__vue_app__']) as AnyObj | undefined;
  const pinia = (vueApp?.['config']?.['globalProperties']?.['$pinia'] ?? (window as AnyObj)['__pinia']) as AnyObj | undefined;
  const storeMap = pinia?.['_s'] as Map<string, AnyObj> | AnyObj | undefined;
  if (source === 'pinia' && storeMap) {
    for (const name of ['common_Aio', 'commonAio', 'aioStore', 'aio']) {
      const store = storeMap instanceof Map ? storeMap.get(name) : storeMap[name];
      if (isAioStore(store)) return store;
    }
  }
  if (source === 'legacy') {
    const store = vueApp?.['config']?.['globalProperties']?.['$store']?.['state']?.['common_Aio'];
    if (isAioStore(store)) return store;
  }
  return null;
}

function clearAioStoreCache(clearHosts = false): void {
  cachedAioStore = null;
  cachedAioHost = null;
  cachedAioSource = null;
  if (clearHosts) knownAioHosts = null;
}

/** 找不到 store 时打印一份 DOM 诊断，方便对着日志修选择器 */
let dumped = false;
function dumpDom(): void {
  if (dumped) return; // 只在第一次拿不到 store 时打印，之后不再重复
  dumped = true;
  try {
    const selectors = ['.aio', '.aio.vue-component', '.message-panel', '.chat-input-area', '.ck-content', '#app'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) { log(`DOM ${sel}: 没有`); continue; }
      const v = (el as AnyObj)['__VUE__'];
      const count = v instanceof Set ? v.size : Array.isArray(v) ? v.length : v ? 1 : 0;
      log(`DOM ${sel}: 有，__VUE__ 实例数=${count}，class=${String((el as HTMLElement).className).slice(0, 120)}`);
    }
    const appEl = document.querySelector('#app') as AnyObj | null;
    log(`#app.__vue_app__ = ${appEl && '__vue_app__' in appEl ? '有' : '无'}`);
  } catch (err) {
    log(`DOM 诊断失败：${String(err)}`);
  }
}

/** 等 aioStore 出现（最多 15 秒），用于启动早期 */
export async function waitForAioStore(timeoutMs = 15000): Promise<AnyObj | null> {
  const started = Date.now();
  for (;;) {
    const st = getAioStore();
    if (st) return st;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise(r => setTimeout(r, 500));
  }
}

/** 当前会话（curAioData） */
export function getCurAio(editor?: Element): AnyObj | null {
  const store = getAioStore(editor);
  const state = store?.['curAioData'] as AnyObj | undefined;
  const aio = state?.['__v_isRef'] === true ? state['value'] : state;
  if (aio && typeof aio === 'object') return aio;
  return null;
}

export interface PeerTarget {
  chatType: number;
  peerUid: string;
  name?: string;
}

/** uid（u_xxx）→ QQ 号，从消息事件里慢慢攒；LRU + sliding TTL 限制长期会话增长。 */
const UID_UIN_TTL_MS = 24 * 60 * 60 * 1000;
const UID_UIN_MAX_ENTRIES = 8192;
const UID_UIN_PRUNE_INTERVAL_MS = 60 * 1000;
const uidToUin = new Map<string, { uin: string; expiresAt: number }>();
let uidUinNextPruneAt = 0;

function pruneUidUinCache(now: number): void {
  if (now < uidUinNextPruneAt && uidToUin.size <= UID_UIN_MAX_ENTRIES) return;
  uidUinNextPruneAt = now + UID_UIN_PRUNE_INTERVAL_MS;
  for (const [uid, entry] of uidToUin) {
    if (entry.expiresAt <= now) uidToUin.delete(uid);
  }
  while (uidToUin.size > UID_UIN_MAX_ENTRIES) {
    const oldest = uidToUin.keys().next().value;
    if (oldest === undefined) break;
    uidToUin.delete(oldest);
  }
}

/** 把会话里的 peerUid（可能是 u_xxx 也可能是 QQ 号）换成 QQ 号 */
export function getUinByUid(uid: string): string {
  if (!uid) return '';
  const now = Date.now();
  pruneUidUinCache(now);
  const cached = uidToUin.get(uid);
  if (cached && cached.expiresAt > now) {
    uidToUin.delete(uid);
    uidToUin.set(uid, { uin: cached.uin, expiresAt: now + UID_UIN_TTL_MS });
    return cached.uin;
  }
  if (cached) uidToUin.delete(uid);
  return /^\d+$/.test(uid) && Number(uid) > 0 ? uid : '';
}

export function setUidUin(uid: string, uin: string): void {
  if (!uid || !/^\d+$/.test(uin) || Number(uin) <= 0) return;
  const now = Date.now();
  pruneUidUinCache(now);
  uidToUin.delete(uid);
  uidToUin.set(uid, { uin, expiresAt: now + UID_UIN_TTL_MS });
  pruneUidUinCache(now);
}

const resolvingUins = new Map<string, Promise<string>>();
const MAX_PENDING_UIN_RESOLVES = 256;
export async function resolvePeerUin(uid: string): Promise<string> {
  if (!uid) return '';
  const known = getUinByUid(uid);
  if (known) return known;
  const context = await loadAccountContext();
  const epoch = storeAccountEpoch;
  if (!context) return '';
  const key = `${context.accountId}:${epoch}:${uid}`;
  const pending = resolvingUins.get(key);
  if (pending) return pending;
  const request = window.QwQNTPgp.resolveUin(uid).then(uin => {
    if (epoch !== storeAccountEpoch) return '';
    setUidUin(uid, uin);
    return getUinByUid(uid);
  }).finally(() => { if (resolvingUins.get(key) === request) resolvingUins.delete(key); });
  while (resolvingUins.size >= MAX_PENDING_UIN_RESOLVES) {
    const oldest = resolvingUins.keys().next().value;
    if (oldest === undefined) break;
    resolvingUins.delete(oldest);
  }
  resolvingUins.set(key, request);
  return request;
}

/** Current peer is derived only from the live, visible AIO store. */
export function getCurrentPeer(editor?: Element): PeerTarget | null {
  const aio = getCurAio(editor);
  if (!aio) return null;
  const header = (aio['header'] as AnyObj | undefined) ?? {};
  const chatType = Number(aio['chatType'] ?? header['chatType']);
  const peerUid = firstString(header['uid'], aio['peerUid']);
  if (!Number.isInteger(chatType) || chatType <= 0 || !peerUid) {
    log(`curAioData 里没有有效会话目标，header=${JSON.stringify(header).slice(0, 300)}`);
    return null;
  }
  const uin = firstString(header['uin']);
  if (uin) setUidUin(peerUid, uin);
  const nameRaw = header['name'] ?? aio['peerName'] ?? aio['title'];
  return { chatType, peerUid, name: typeof nameRaw === 'string' ? nameRaw : undefined };
}

export interface SelfInfo {
  uid: string;
  uin?: string;
  nick?: string;
}

/** Synchronous identity snapshot for UI policy checks; never derives a UIN from a UID. */
export function getCachedSelfInfo(): SelfInfo | null {
  return selfCache;
}

/**
 * 拿自己的账号信息。
 * 优先使用 QQ 的 GlobalDataApi/fetchAuthData，失败后从会话 store 查找。
 */
export async function getSelfInfo(): Promise<SelfInfo | null> {
  if (selfCache) return selfCache;
  const epoch = storeAccountEpoch;
  const context = await loadAccountContext();
  if (!context || epoch !== storeAccountEpoch) return null;
  if ((await loadAccountContext())?.accountId !== context.accountId || epoch !== storeAccountEpoch) return null;
  selfCache = { uid: context.selfUid, uin: context.accountId };
  return selfCache;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** 打印一次当前会话结构（调试用） */
export function dumpAioOnce(): void {
  const aio = getCurAio();
  if (!aio) {
    log('curAioData 为空');
    return;
  }
  const brief: Record<string, string> = {};
  for (const [k, v] of Object.entries(aio)) {
    brief[k] = Array.isArray(v) ? `array(${v.length})` : typeof v;
  }
  log(`curAioData 字段：${JSON.stringify(brief)}`);
  const header = aio['header'];
  if (header && typeof header === 'object') {
    log(`curAioData.header：${JSON.stringify(header).slice(0, 600)}`);
  }
}

/** 清缓存（换会话或调试用） */
export function resetStoreCache(): void {
  storeAccountEpoch++;
  clearAioStoreCache(true);
  selfCache = null;
  uidToUin.clear();
  resolvingUins.clear();
}
