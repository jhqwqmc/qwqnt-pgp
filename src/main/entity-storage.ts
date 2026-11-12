/** Per-contact/group settings, kept outside the general configuration object. */
import { mkdirSync } from 'node:fs';
import { opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyBinding } from '@/shared/types';

export type DataChange = { accountId: string; kind: 'dm' | 'group' | 'binding'; id: string };
export interface DmConfig { uin: string; enabled: boolean }
export interface GroupConfig { groupId: string; targets: string[] }
export interface KeyBindingPage { items: KeyBinding[]; nextCursor: string | null }

const MAX_BATCH = 512;
const listeners = new Set<(change: DataChange) => void>();
let accountsDir = '';
const groupQueues = new Map<string, Promise<unknown>>();
const dmQueues = new Map<string, Promise<unknown>>();
const MAX_PREPARE_GROUP_TARGETS = 4096;

export function initEntityStorage(configDir: string): void {
  accountsDir = configDir;
}

export function onDataChanged(listener: (change: DataChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(change: DataChange): void {
  for (const listener of listeners) {
    try { listener(change); } catch { /* one window must not block other subscribers */ }
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

function entityPath(accountId: string, kind: 'dm' | 'groups' | 'bindings', id: string): string {
  if (!accountsDir) throw new Error('联系人数据存储尚未初始化');
  const account = requireId(accountId);
  if (!validId(id)) throw new Error('QQ号或群号必须是正整数数字字符串');
  const dir = join(accountsDir, account, kind);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.json`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`读取联系人配置失败：${String(err)}`);
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new Error(`保存联系人配置失败：${String(err)}`);
  }
}

export async function getDmConfig(accountId: string, uin: string): Promise<DmConfig> {
  const id = requireId(uin);
  const stored = await readJson<Partial<DmConfig>>(entityPath(accountId, 'dm', id));
  return { uin: id, enabled: stored?.enabled === true };
}

export async function setDmConfig(accountId: string, uin: string, enabled: boolean): Promise<DmConfig> {
  const id = requireId(uin);
  const account = requireId(accountId);
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  return serialize(dmQueues, `${account}\u0000${id}`, async () => {
    const value = { uin: id, enabled };
    await atomicWrite(entityPath(account, 'dm', id), value);
    emit({ accountId: account, kind: 'dm', id });
    return value;
  });
}

/** Validate only this peer when its chat opens; sending continues to use the side-effect-free getter. */
export async function prepareDmConfig(accountId: string, uin: string): Promise<DmConfig> {
  const id = requireId(uin);
  const account = requireId(accountId);
  return serialize(dmQueues, `${account}\u0000${id}`, async () => {
    const path = entityPath(account, 'dm', id);
    const stored = await readJson<Partial<DmConfig>>(path);
    const enabled = stored?.enabled === true;
    if (!enabled || (await getKeyBindings(account, [id])).some(binding => binding.uin === id)) {
      return { uin: id, enabled };
    }
    const value = { uin: id, enabled: false };
    await atomicWrite(path, value);
    emit({ accountId: account, kind: 'dm', id });
    return value;
  });
}

export async function getGroupConfig(accountId: string, groupId: string): Promise<GroupConfig> {
  const id = requireId(groupId);
  const stored = await readJson<Partial<GroupConfig>>(entityPath(accountId, 'groups', id));
  const targets = Array.isArray(stored?.targets)
    ? [...new Set(stored.targets.filter(validId))]
    : [];
  return { groupId: id, targets };
}

/** Validate this group's targets only; the current account's own UIN never needs a binding file. */
export async function prepareGroupConfig(accountId: string, groupId: string, ownUin: string): Promise<GroupConfig> {
  const account = requireId(accountId);
  const group = requireId(groupId);
  const self = requireId(ownUin);
  return serialize(groupQueues, `${account}\u0000${group}`, async () => {
    const path = entityPath(account, 'groups', group);
    const stored = await readJson<Partial<GroupConfig>>(path);
    const original = Array.isArray(stored?.targets) ? [...new Set(stored.targets.filter(validId))] : [];
    if (original.length > MAX_PREPARE_GROUP_TARGETS) throw new Error(`群聊目标数超过 ${MAX_PREPARE_GROUP_TARGETS}，未执行懒清理`);
    const peers = original.filter(target => target !== self);
    const bound = new Set<string>();
    for (let offset = 0; offset < peers.length; offset += MAX_BATCH) {
      const batch = peers.slice(offset, offset + MAX_BATCH);
      for (const binding of await getKeyBindings(account, batch)) bound.add(binding.uin);
    }
    const targets = original.filter(target => target === self || bound.has(target));
    if (targets.length !== original.length) {
      const value = { groupId: group, targets };
      await atomicWrite(path, value);
      emit({ accountId: account, kind: 'group', id: group });
    }
    return { groupId: group, targets };
  });
}

/** Per-group serial read/modify/write prevents rapid concurrent toggles losing changes. */
export async function setGroupTarget(accountId: string, groupId: string, uin: string, enabled: boolean): Promise<GroupConfig> {
  const group = requireId(groupId);
  const member = requireId(uin);
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
  const account = requireId(accountId);
  return serialize(groupQueues, `${account}\u0000${group}`, async () => {
    const path = entityPath(accountId, 'groups', group);
    const stored = await readJson<Partial<GroupConfig>>(path);
    const targets = new Set(Array.isArray(stored?.targets) ? stored.targets.filter(validId) : []);
    if (enabled) targets.add(member);
    else targets.delete(member);
    const value = { groupId: group, targets: [...targets] };
    await atomicWrite(path, value);
    emit({ accountId: account, kind: 'group', id: group });
    return value;
  });
}

export async function getKeyBindings(accountId: string, uins: string[]): Promise<KeyBinding[]> {
  if (!Array.isArray(uins) || uins.length > MAX_BATCH) throw new Error(`单批最多读取 ${MAX_BATCH} 个绑定`);
  const ids = [...new Set(uins.map(requireId))];
  const found = await Promise.all(ids.map(async uin => {
    const value = await readJson<Partial<KeyBinding>>(entityPath(accountId, 'bindings', uin));
    return value && typeof value.keyID === 'string' && value.keyID.trim() ? { uin, keyID: value.keyID } : null;
  }));
  return found.filter((value): value is KeyBinding => value !== null);
}

export async function listKeyBindings(accountId: string, cursor?: string, limit = 100): Promise<KeyBindingPage> {
  const after = cursor === undefined || cursor === '' ? '' : requireId(cursor);
  const size = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_BATCH, limit)) : 100;
  const bindingsDir = join(accountsDir, requireId(accountId), 'bindings');
  mkdirSync(bindingsDir, { recursive: true });
  const dir = await opendir(bindingsDir);
  const candidates: string[] = [];
  let hasMore = false;
  try {
    for await (const entry of dir) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const uin = entry.name.slice(0, -5);
      if (!validId(uin) || (after && uin <= after)) continue;
      // Keep only the smallest `size + 1` IDs seen; opendir streams entries
      // without materializing or sorting the entire directory.
      candidates.push(uin);
      candidates.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      if (candidates.length > size) {
        candidates.pop();
        hasMore = true;
      }
    }
  } finally { await dir.close().catch(() => undefined); }
  const pageIds = candidates.slice(0, size);
  const items = await Promise.all(pageIds.map(async uin => {
    const value = await readJson<Partial<KeyBinding>>(entityPath(accountId, 'bindings', uin));
    return value && typeof value.keyID === 'string' && value.keyID.trim() ? { uin, keyID: value.keyID } : null;
  }));
  const validItems = items.filter((value): value is KeyBinding => value !== null);
  return { items: validItems, nextCursor: hasMore && pageIds.length ? pageIds.at(-1)! : null };
}

export async function setKeyBinding(accountId: string, uin: string, keyID: string | null): Promise<void> {
  const id = requireId(uin);
  const path = entityPath(accountId, 'bindings', id);
  if (keyID === null || keyID === '') await rm(path, { force: true });
  else {
    if (typeof keyID !== 'string' || !keyID.trim()) throw new Error('keyID 必须是非空字符串或 null');
    await atomicWrite(path, { uin: id, keyID: keyID.trim() });
  }
  emit({ accountId: requireId(accountId), kind: 'binding', id });
}

function requireId(value: unknown): string {
  if (!validId(value)) throw new Error('QQ号或群号必须是正整数数字字符串');
  return value;
}

async function serialize<T>(queues: Map<string, Promise<unknown>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  queues.set(key, task);
  try { return await task; }
  finally { if (queues.get(key) === task) queues.delete(key); }
}

