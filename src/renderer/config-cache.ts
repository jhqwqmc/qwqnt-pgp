/** Small renderer caches for general settings and the currently requested per-peer data. */
import type { KeyBinding, PgpConfig } from '@/shared/types';

declare global { interface Window { __qwqnt_pgp_cfg?: PgpConfig } }

export interface AccountContext { accountId: string; selfUid: string; revision?: number }
let activeContext: AccountContext | null = null;
let contextLoading: Promise<AccountContext | null> | null = null;
let accountGeneration = 0;
const ACCOUNT_ID = /^[1-9]\d*$/;

let cache: PgpConfig | null = null;
let loading: Promise<PgpConfig> | null = null;
const DATA_TTL_MS = 5000;
const DATA_CACHE_MAX = 256;
interface Entry<T> { value: T; expiresAt: number }
interface Pending<T> { promise: Promise<T>; ids: Set<string>; invalidated: boolean }
const dmCache = new Map<string, Entry<{ uin: string; enabled: boolean }>>();
const groupCache = new Map<string, Entry<{ groupId: string; targets: string[] }>>();
const bindingCache = new Map<string, Entry<KeyBinding | null>>();
const inflightDm = new Map<string, Pending<{ uin: string; enabled: boolean }>>();
const inflightGroup = new Map<string, Pending<{ groupId: string; targets: string[] }>>();
const inflightBindings = new Map<string, Pending<KeyBinding[]>>();

interface ConfigDataApi {
  prepareDmConfig?: (uin: string) => Promise<{ uin: string; enabled: boolean }>;
  prepareGroupConfig?: (groupId: string) => Promise<{ groupId: string; targets: string[] }>;
  getDmConfig?: (uin: string) => Promise<{ uin: string; enabled: boolean }>;
  setDmConfig?: (uin: string, enabled: boolean) => Promise<{ uin: string; enabled: boolean } | void>;
  getGroupConfig?: (groupId: string) => Promise<{ groupId: string; targets: string[] }>;
  setGroupTarget?: (groupId: string, uin: string, enabled: boolean) => Promise<{ groupId: string; targets: string[] } | void>;
  getKeyBindings?: (uins: string[]) => Promise<KeyBinding[]>;
  setKeyBinding?: (uin: string, keyID: string | null) => Promise<KeyBinding | void>;
  onDataChanged?: (cb: (event: DataChangedEvent) => void) => void;
}
export interface DataChangedEvent { accountId: string; kind: 'dm' | 'group' | 'binding'; id: string }

function dataApi(): ConfigDataApi { return window.QwQNTPgp as typeof window.QwQNTPgp & ConfigDataApi; }
function isNumericId(value: string): boolean { return /^[1-9]\d*$/.test(value); }
function publish(c: PgpConfig): void {
  cache = c;
  try { window.__qwqnt_pgp_cfg = c; } catch { /* ignore */ }
}
export function getActiveAccountId(): string | null { return activeContext?.accountId ?? null; }
export function getAccountGeneration(): number { return accountGeneration; }
export async function loadAccountContext(): Promise<AccountContext | null> {
  if (activeContext) return activeContext;
  if (contextLoading) return contextLoading;
  const generation = accountGeneration;
  const request = window.QwQNTPgp.accountContext().then(context => {
    if (generation !== accountGeneration) return activeContext;
    const normalized = context && ACCOUNT_ID.test(context.accountId) && context.selfUid
      ? { accountId: context.accountId, selfUid: context.selfUid, revision: context.revision } : null;
    if (normalized?.accountId !== activeContext?.accountId || normalized?.selfUid !== activeContext?.selfUid || normalized?.revision !== activeContext?.revision) {
      activateAccount(normalized, !!activeContext);
    }
    else if (!normalized) { cache = null; try { delete window.__qwqnt_pgp_cfg; } catch { /* ignore */ } }
    return activeContext;
  });
  contextLoading = request;
  try { return await request; }
  finally { if (contextLoading === request) contextLoading = null; }
}
function activateAccount(context: AccountContext | null, notify = true): void {
  activeContext = context;
  accountGeneration++;
  cache = null; loading = null; contextLoading = null;
  dmCache.clear(); groupCache.clear(); bindingCache.clear();
  inflightDm.clear(); inflightGroup.clear(); inflightBindings.clear();
  try { delete window.__qwqnt_pgp_cfg; } catch { /* ignore */ }
  if (notify) window.dispatchEvent(new CustomEvent('qwqnt-pgp:account-changed', { detail: context }));
}
if (typeof window !== 'undefined') window.QwQNTPgp.onAccountChanged?.(context => {
  const normalized = context && ACCOUNT_ID.test(context.accountId) && context.selfUid
    ? { accountId: context.accountId, selfUid: context.selfUid, revision: context.revision } : null;
  activateAccount(normalized, true);
});
function cap<T>(map: Map<string, T>, max = DATA_CACHE_MAX): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
function cached<T>(map: Map<string, Entry<T>>, id: string): T | undefined {
  const entry = map.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { map.delete(id); return undefined; }
  map.delete(id); map.set(id, entry);
  return entry.value;
}
function store<T>(map: Map<string, Entry<T>>, id: string, value: T): void {
  map.delete(id); map.set(id, { value, expiresAt: Date.now() + DATA_TTL_MS }); cap(map);
}
function emitDataChanged(event: DataChangedEvent): void {
  window.dispatchEvent(new CustomEvent('qwqnt-pgp:data-changed', { detail: event }));
}

try {
  window.QwQNTPgp?.onConfigChanged?.(cfg => {
    if (!activeContext || !cfg) return;
    publish(cfg);
    window.dispatchEvent(new CustomEvent('qwqnt-pgp:config-updated', { detail: cfg }));
  });
  dataApi().onDataChanged?.(event => {
    if (!activeContext || event?.accountId !== activeContext.accountId) return;
    if (!event || !isNumericId(event.id)) return;
    if (event.kind === 'dm') {
      dmCache.delete(event.id);
      const pending = inflightDm.get(event.id);
      if (pending) { pending.invalidated = true; inflightDm.delete(event.id); }
    } else if (event.kind === 'group') {
      groupCache.delete(event.id);
      const pending = inflightGroup.get(event.id);
      if (pending) { pending.invalidated = true; inflightGroup.delete(event.id); }
    } else if (event.kind === 'binding') {
      bindingCache.delete(event.id);
      for (const [key, pending] of inflightBindings) if (pending.ids.has(event.id)) {
        pending.invalidated = true;
        inflightBindings.delete(key);
      }
    }
    emitDataChanged(event);
  });
} catch { /* preload may initialize after this module */ }

export function getCached(): PgpConfig | null {
  if (!activeContext) return null;
  return cache ?? (typeof window !== 'undefined' ? (window.__qwqnt_pgp_cfg as PgpConfig | undefined) ?? null : null);
}
export function setCached(c: PgpConfig): void {
  if (!activeContext) return;
  publish(c);
  window.dispatchEvent(new CustomEvent('qwqnt-pgp:config-updated', { detail: c }));
}
export async function loadConfig(force = false): Promise<PgpConfig> {
  await loadAccountContext();
  if (!activeContext) throw new Error('当前 QQ 账号上下文不可用');
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  const generation = accountGeneration;
  loading = Promise.resolve().then(() => {
    if (generation !== accountGeneration) throw new Error('账号已切换，取消旧配置读取');
    return window.QwQNTPgp.getConfig();
  }).then(c => {
    if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧配置结果');
    publish(c);
    window.dispatchEvent(new CustomEvent('qwqnt-pgp:config-updated', { detail: c }));
    return c;
  }).finally(() => { if (generation === accountGeneration) loading = null; });
  return loading;
}
export async function saveConfig(patch: Partial<PgpConfig>): Promise<PgpConfig> {
  const generation = accountGeneration;
  if (generation !== accountGeneration) throw new Error('账号已切换，取消旧配置写入');
  const next = await window.QwQNTPgp.setConfig(patch);
  if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧配置结果');
  setCached(next);
  return next;
}

export async function getDmConfig(uin: string): Promise<{ uin: string; enabled: boolean }> {
  await loadAccountContext(); if (!activeContext) throw new Error('当前 QQ 账号上下文不可用');
  if (!isNumericId(uin)) throw new Error('私聊配置需要数字 QQ 号');
  const hit = cached(dmCache, uin); if (hit) return hit;
  const pending = inflightDm.get(uin); if (pending) return pending.promise;
  const entry: Pending<{ uin: string; enabled: boolean }> = { ids: new Set([uin]), invalidated: false, promise: Promise.resolve({ uin, enabled: false }) };
  const generation = accountGeneration;
  const request = Promise.resolve().then(() => {
    if (generation !== accountGeneration) throw new Error('账号已切换，取消旧私聊读取');
    const api = dataApi(); if (!api.getDmConfig) throw new Error('DM config API unavailable');
    return api.getDmConfig(uin);
  }).then(result => {
    if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧私聊配置');
    if (result?.uin !== uin || typeof result.enabled !== 'boolean') throw new Error('DM config response identity mismatch');
    if (inflightDm.get(uin) === entry) store(dmCache, uin, result);
    return result;
  }).finally(() => { if (inflightDm.get(uin) === entry) inflightDm.delete(uin); });
  entry.promise = request;
  inflightDm.set(uin, entry);
  const result = await request;
  return entry.invalidated ? getDmConfig(uin) : result;
}
/** Validate and lazily clean one opened DM; send paths keep using the raw getter. */
export async function prepareDmConfig(uin: string): Promise<{ uin: string; enabled: boolean }> {
  const context = await loadAccountContext();
  if (!context || !isNumericId(uin)) throw new Error('私聊配置需要有效账号与数字 QQ 号');
  const generation = accountGeneration;
  const api = dataApi();
  if (!api.prepareDmConfig) throw new Error('DM preparation API unavailable');
  const result = await api.prepareDmConfig(uin);
  if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧私聊准备结果');
  if (result?.uin !== uin || typeof result.enabled !== 'boolean') throw new Error('DM prepare response identity mismatch');
  const pending = inflightDm.get(uin);
  if (pending) { pending.invalidated = true; inflightDm.delete(uin); }
  store(dmCache, uin, result);
  return result;
}
export function getCachedDmConfig(uin: string): { uin: string; enabled: boolean } | undefined {
  return isNumericId(uin) ? cached(dmCache, uin) : undefined;
}
export async function setDmConfig(uin: string, enabled: boolean): Promise<{ uin: string; enabled: boolean }> {
  await loadAccountContext(); if (!activeContext) throw new Error('当前 QQ 账号上下文不可用');
  if (!isNumericId(uin)) throw new Error('私聊配置需要数字 QQ 号');
  const api = dataApi(); if (!api.setDmConfig) throw new Error('DM config API unavailable');
  const generation = accountGeneration;
  if (generation !== accountGeneration) throw new Error('账号已切换，取消旧私聊写入');
  const response = await api.setDmConfig(uin, enabled);
  if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧私聊配置');
  const result = response && response.uin === uin && typeof response.enabled === 'boolean' ? response : { uin, enabled };
  const pending = inflightDm.get(uin);
  if (pending) { pending.invalidated = true; inflightDm.delete(uin); }
  store(dmCache, uin, result); emitDataChanged({ accountId: activeContext!.accountId, kind: 'dm', id: uin }); return result;
}
export async function getGroupConfig(groupId: string): Promise<{ groupId: string; targets: string[] }> {
  await loadAccountContext(); if (!activeContext) throw new Error('当前 QQ 账号上下文不可用');
  if (!isNumericId(groupId)) throw new Error('群配置需要数字群号');
  const hit = cached(groupCache, groupId); if (hit) return hit;
  const pending = inflightGroup.get(groupId); if (pending) return pending.promise;
  const entry: Pending<{ groupId: string; targets: string[] }> = { ids: new Set([groupId]), invalidated: false, promise: Promise.resolve({ groupId, targets: [] }) };
  const generation = accountGeneration;
  const request = Promise.resolve().then(() => {
    if (generation !== accountGeneration) throw new Error('账号已切换，取消旧群配置读取');
    const api = dataApi(); if (!api.getGroupConfig) throw new Error('group config API unavailable');
    return api.getGroupConfig(groupId);
  }).then(result => {
    if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧群配置');
    if (result?.groupId !== groupId || !Array.isArray(result.targets)) throw new Error('group config response identity mismatch');
    const clean = { groupId, targets: [...new Set(result.targets.filter(isNumericId))] };
    if (inflightGroup.get(groupId) === entry) store(groupCache, groupId, clean);
    return clean;
  }).finally(() => { if (inflightGroup.get(groupId) === entry) inflightGroup.delete(groupId); });
  entry.promise = request;
  inflightGroup.set(groupId, entry);
  const result = await request;
  return entry.invalidated ? getGroupConfig(groupId) : result;
}
/** Validate and lazily clean one opened group; send paths keep using the raw getter. */
export async function prepareGroupConfig(groupId: string): Promise<{ groupId: string; targets: string[] }> {
  const context = await loadAccountContext();
  if (!context || !isNumericId(groupId)) throw new Error('群配置需要有效账号与数字群号');
  const generation = accountGeneration;
  const api = dataApi();
  if (!api.prepareGroupConfig) throw new Error('group preparation API unavailable');
  const result = await api.prepareGroupConfig(groupId);
  if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧群准备结果');
  if (result?.groupId !== groupId || !Array.isArray(result.targets)) throw new Error('group prepare response identity mismatch');
  const clean = { groupId, targets: [...new Set(result.targets.filter(isNumericId))] };
  const pending = inflightGroup.get(groupId);
  if (pending) { pending.invalidated = true; inflightGroup.delete(groupId); }
  store(groupCache, groupId, clean);
  return clean;
}
export function getCachedGroupConfig(groupId: string): { groupId: string; targets: string[] } | undefined {
  return isNumericId(groupId) ? cached(groupCache, groupId) : undefined;
}
export async function setGroupTarget(groupId: string, uin: string, enabled: boolean): Promise<{ groupId: string; targets: string[] }> {
  await loadAccountContext(); if (!activeContext) throw new Error('当前 QQ 账号上下文不可用');
  if (!isNumericId(groupId) || !isNumericId(uin)) throw new Error('群号和成员都必须是数字 QQ 号');
  const api = dataApi(); if (!api.setGroupTarget) throw new Error('group target API unavailable');
  const generation = accountGeneration;
  if (generation !== accountGeneration) throw new Error('账号已切换，取消旧群配置写入');
  const response = await api.setGroupTarget(groupId, uin, enabled);
  if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧群配置');
  const next = response && response.groupId === groupId ? response : await api.getGroupConfig?.(groupId);
  if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧群配置');
  if (!next || next.groupId !== groupId || !Array.isArray(next.targets)) throw new Error('group config API unavailable');
  const clean = { groupId, targets: [...new Set(next.targets.filter(isNumericId))] };
  const pending = inflightGroup.get(groupId);
  if (pending) { pending.invalidated = true; inflightGroup.delete(groupId); }
  store(groupCache, groupId, clean); emitDataChanged({ accountId: activeContext!.accountId, kind: 'group', id: groupId }); return clean;
}
export async function getKeyBindings(uins: string[]): Promise<KeyBinding[]> {
  await loadAccountContext(); if (!activeContext) throw new Error('当前 QQ 账号上下文不可用');
  const generation = accountGeneration;
  const ids = [...new Set(uins.filter(isNumericId))];
  const results = new Map<string, KeyBinding>();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = cached(bindingCache, id);
    if (hit !== undefined) { if (hit) results.set(id, hit); } else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 512) {
    const chunk = missing.slice(i, i + 512);
    const key = chunk.join(',');
    let pending = inflightBindings.get(key);
    if (!pending) {
      const entry: Pending<KeyBinding[]> = { ids: new Set(chunk), invalidated: false, promise: Promise.resolve([]) };
      const request = Promise.resolve().then(() => {
        if (generation !== accountGeneration) throw new Error('账号已切换，取消旧密钥绑定读取');
        const api = dataApi(); if (!api.getKeyBindings) throw new Error('key binding API unavailable');
        return api.getKeyBindings!(chunk);
      }).then(items => {
        if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧密钥绑定');
        const found = new Map(items.filter(item => chunk.includes(item.uin) && typeof item.keyID === 'string' && item.keyID.trim())
          .map(item => [item.uin, { uin: item.uin, keyID: item.keyID.trim() }]));
        if (inflightBindings.get(key) === entry) {
          for (const id of chunk) store(bindingCache, id, found.get(id) ?? null);
        }
        return items;
      }).finally(() => { if (inflightBindings.get(key) === entry) inflightBindings.delete(key); });
      entry.promise = request;
      pending = entry;
      inflightBindings.set(key, entry);
    }
    const request = pending.promise;
    /*
     * Cache writes above are conditional on this exact pending entry still
     * being current, so an older response cannot repopulate an invalidated ID.
     */
    const items = await request;
    if (pending.invalidated) {
      for (const item of await getKeyBindings(chunk)) results.set(item.uin, item);
    } else {
      for (const item of items) if (chunk.includes(item.uin)) results.set(item.uin, item);
    }
  }
  return ids.map(id => results.get(id)).filter((item): item is KeyBinding => !!item);
}
export async function getKeyBinding(uin: string): Promise<KeyBinding | null> {
  return (await getKeyBindings([uin]))[0] ?? null;
}
export async function setKeyBinding(uin: string, keyID: string | null): Promise<void> {
  await loadAccountContext(); if (!activeContext) throw new Error('当前 QQ 账号上下文不可用');
  if (!isNumericId(uin)) throw new Error('绑定需要数字 QQ 号');
  const api = dataApi(); if (!api.setKeyBinding) throw new Error('set key binding API unavailable');
  const generation = accountGeneration;
  if (generation !== accountGeneration) throw new Error('账号已切换，取消旧密钥绑定写入');
  const binding = await api.setKeyBinding(uin, keyID);
  if (generation !== accountGeneration) throw new Error('账号已切换，丢弃旧密钥绑定');
  for (const [key, pending] of inflightBindings) if (pending.ids.has(uin)) {
    pending.invalidated = true;
    inflightBindings.delete(key);
  }
  if (keyID) store(bindingCache, uin, binding?.keyID ? binding : { uin, keyID }); else store(bindingCache, uin, null);
  emitDataChanged({ accountId: activeContext!.accountId, kind: 'binding', id: uin });
}
