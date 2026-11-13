/** Scalar plugin settings. Contact/group data lives in entity-storage.ts. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PgpConfig } from '@/shared/types';
import { initEntityStorage } from './entity-storage';
import { log } from './log';

export const DEFAULT_CONFIG: PgpConfig = {
  autoDecrypt: true,
  sendPolicy: 'manual',
  hotkey: 'Ctrl+/',
  gpgPath: '',
  gpgHome: '',
  keyserver: 'keys.openpgp.org',
  ownKeyID: ''
};

let accountsDir = '';
const cache = new Map<string, PgpConfig>();
const MAX_ACCOUNTS = 8;

export function readDebugConfig(baseConfigsDir: string): boolean {
  try {
    const file = join(baseConfigsDir, 'qwqnt-pgp', 'debug.json');
    const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { debug?: unknown } | null;
    return config?.debug === true;
  } catch {
    return false;
  }
}

/** 初始化 scalar 和 entity 存储。联系人配置由管理员单独整理，不做运行时迁移。 */
export function initConfig(baseConfigsDir: string): string {
  accountsDir = join(baseConfigsDir, 'qwqnt-pgp', 'accounts');
  log(`账号配置根目录：${accountsDir}`);
  mkdirSync(accountsDir, { recursive: true });
  initEntityStorage(accountsDir);
  return accountsDir;
}

export function getConfigPath(accountId: string): string { return join(accountDir(accountId), 'config.json'); }
export function getConfig(accountId: string): PgpConfig {
  const id = requireAccountId(accountId);
  const hit = cache.get(id);
  if (hit) { cache.delete(id); cache.set(id, hit); return structuredClone(hit); }
  const path = getConfigPath(id);
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
    catch (err) { throw new Error(`读取账号配置失败（${path}）：${String(err)}`); }
  }
  const value = normalize(raw);
  if (!existsSync(path)) writeConfigFile(path, value);
  cache.set(id, value);
  trimCache();
  return structuredClone(value);
}

export function saveConfig(accountId: string, patch: Partial<PgpConfig>): PgpConfig {
  const id = requireAccountId(accountId);
  const next = normalize({ ...getConfig(id), ...patch });
  writeConfigFile(getConfigPath(id), next);
  cache.delete(id); cache.set(id, next); trimCache();
  log(`账号 ${id} 配置已保存`);
  return structuredClone(next);
}

function writeConfigFile(configPath: string, config: PgpConfig): void {
  try {
    mkdirSync(join(configPath, '..'), { recursive: true });
    writeFileSync(`${configPath}.tmp`, JSON.stringify(config, null, 2), 'utf8');
    renameSync(`${configPath}.tmp`, configPath);
  } catch (err) {
    log(`保存配置失败（${configPath}）：${String(err)}`);
    throw new Error(`保存配置失败：${String(err)}`);
  }
}

function accountDir(accountId: string): string {
  const id = requireAccountId(accountId);
  if (!accountsDir) throw new Error('账号配置存储尚未初始化');
  return join(accountsDir, id);
}
function requireAccountId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw new Error('当前账号身份未确认');
  return value;
}
function trimCache(): void { while (cache.size > MAX_ACCOUNTS) cache.delete(cache.keys().next().value!); }

function normalize(raw: Partial<PgpConfig> | null): PgpConfig {
  const value = raw && typeof raw === 'object' ? raw : {};
  const cfg = structuredClone(DEFAULT_CONFIG);
  for (const key of Object.keys(cfg) as Array<keyof PgpConfig>) {
    const supplied = value[key];
    if (typeof supplied === typeof cfg[key] && supplied !== null) Object.assign(cfg, { [key]: supplied });
  }
  if (!['manual', 'auto', 'off'].includes(cfg.sendPolicy)) cfg.sendPolicy = DEFAULT_CONFIG.sendPolicy;
  return cfg;
}
