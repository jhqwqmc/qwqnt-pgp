/** Per-contact/group settings, kept outside the general configuration object. */
import { mkdirSync } from 'node:fs';
import { opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyBinding } from '@/shared/types';

export type DataChange = { accountId: string; kind: 'group' | 'binding'; id: string };
export interface GroupConfig { groupId: string; targets: string[] }
export interface KeyBindingPage { items: KeyBinding[]; nextCursor: string | null }

const MAX_BATCH = 512;
const listeners = new Set<(change: DataChange) => void>();
let accountsDir = '';
const groupQueues = new Map<string, Promise<unknown>>();
const bindingQueues = new Map<string, Promise<unknown>>();
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

function entityPath(accountId: string, kind: 'groups' | 'bindings', id: string): string {
  if (!accountsDir) throw new Error('联系人数据存储尚未初始化');
  const account = requireId(accountId);
  if (!validId(id)) throw new Error('QQ号或群号必须是正整数数字字符串');
  const dir = join(accountsDir, account, kind);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.json`);
}

async function readJson<T>(path: string, invalidJson?: T): Promise<T | null> {
  try { return (JSON.parse(await readFile(path, 'utf8')) as T | null) ?? invalidJson ?? null; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof SyntaxError && invalidJson !== undefined) return invalidJson;
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

export async function getGroupConfig(accountId: string, groupId: string): Promise<GroupConfig> {
  const id = requireId(groupId);
  const stored = await readJson<Partial<GroupConfig>>(entityPath(accountId, 'groups', id));
  const targets = stored?.groupId === id && Array.isArray(stored.targets) && stored.targets.length <= MAX_PREPARE_GROUP_TARGETS
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
    const stored = await readJson<Partial<GroupConfig>>(path, {});
    const rawTargets = Array.isArray(stored?.targets) ? stored.targets : [];
    const original = stored?.groupId === group && rawTargets.length <= MAX_PREPARE_GROUP_TARGETS
      ? [...new Set(rawTargets.filter(validId))] : [];
    const peers = original.filter(target => target !== self);
    const bound = new Set<string>();
    for (let offset = 0; offset < peers.length; offset += MAX_BATCH) {
      const batch = peers.slice(offset, offset + MAX_BATCH);
      for (const binding of await getKeyBindings(account, batch)) bound.add(binding.uin);
    }
    const targets = original.filter(target => target === self || bound.has(target));
    if (stored !== null && (stored.groupId !== group || !Array.isArray(stored.targets) || targets.length !== rawTargets.length)) {
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
    if (enabled && member !== account && !(await getKeyBindings(account, [member])).length) throw new Error('请先绑定该成员的公钥');
    const path = entityPath(accountId, 'groups', group);
    const stored = await readJson<Partial<GroupConfig>>(path, {});
    const targets = new Set(stored?.groupId === group && Array.isArray(stored.targets) && stored.targets.length <= MAX_PREPARE_GROUP_TARGETS
      ? stored.targets.filter(validId) : []);
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

export async function listKeyBindings(accountId: string, cursor?: string, limit = 100, query = ''): Promise<KeyBindingPage> {
  const after = cursor === undefined || cursor === '' ? '' : requireId(cursor);
  if (typeof query !== 'string' || !/^\d*$/.test(query)) throw new Error('QQ 号筛选只接受数字');
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
      if (!validId(uin) || !uin.includes(query) || uin <= after) continue;
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

type StoredBinding = Partial<KeyBinding> & { directEnabled?: boolean };

export async function getDirectBinding(accountId: string, uin: string): Promise<{ binding: KeyBinding | null; enabled: boolean }> {
  const value = await readJson<StoredBinding>(entityPath(accountId, 'bindings', uin));
  const binding = typeof value?.keyID === 'string' && value.keyID.trim() ? { uin, keyID: value.keyID } : null;
  return { binding, enabled: !!binding && value?.directEnabled !== false };
}

export async function setDirectEncryption(accountId: string, uin: string, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('加密开关必须是布尔值');
  const path = entityPath(accountId, 'bindings', uin);
  await serialize(bindingQueues, path, async () => {
    const { binding } = await getDirectBinding(accountId, uin);
    if (!binding) throw new Error('请先在好友管理中绑定公钥');
    await atomicWrite(path, { ...binding, directEnabled: enabled });
    emit({ accountId, kind: 'binding', id: uin });
  });
}

export async function setKeyBinding(accountId: string, uin: string, keyID: string | null, onlyUnbound = false): Promise<void> {
  const id = requireId(uin);
  const path = entityPath(accountId, 'bindings', id);
  await serialize(bindingQueues, path, async () => {
    if (onlyUnbound && (await getKeyBindings(accountId, [id])).length) throw new Error('此 QQ 号已绑定公钥');
    if (keyID === null || keyID === '') await rm(path, { force: true });
    else {
      if (typeof keyID !== 'string' || !keyID.trim()) throw new Error('keyID 必须是非空字符串或 null');
      await atomicWrite(path, { uin: id, keyID: keyID.trim() });
    }
    emit({ accountId, kind: 'binding', id });
  });
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

