import { constants } from 'node:os';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { log } from './log';
import { resolveOffsets } from './offset-cache';

const supported = process.platform === 'win32' && process.arch === 'x64';
let paths: { addon: string; worker: string; cache: string } | undefined;
let prepared: { wrapper: string; offsets: ReturnType<typeof resolveOffsets> } | undefined;
let hooked = false;
let attemptedHook = false;

export function hasAttemptedNativeHook(): boolean {
  return attemptedHook;
}

export function prepareNativeOffsets(pluginDir: string | undefined, dataDir: string, wrapper?: string): void {
  if (!supported) return;
  if (!pluginDir || !isAbsolute(pluginDir)) {
    log('[native-hook] 未收到插件安装路径');
    return;
  }
  paths = {
    addon: join(pluginDir, 'main', 'sso-bridge-win-x64.node'),
    worker: join(pluginDir, 'main', 'offset-worker.js'),
    cache: join(dataDir, 'qwqnt-pgp', 'offsets.json'),
  };
  if (wrapper && existsSync(paths.addon)) void prepare(wrapper).catch(() => {});
}

function prepare(wrapper: string): ReturnType<typeof resolveOffsets> {
  if (!paths) return Promise.reject(new Error('原生模块路径尚未初始化'));
  if (prepared?.wrapper === wrapper) return prepared.offsets;
  const offsets = resolveOffsets(paths.worker, paths.cache, wrapper, process.arch);
  prepared = { wrapper, offsets };
  void offsets.catch(error => {
    if (prepared?.offsets === offsets) prepared = undefined;
    log('[native-hook] 本地偏移解析失败：' + String(error));
  });
  return offsets;
}

export async function initNativeHook(wrapper?: string): Promise<boolean> {
  if (hooked || attemptedHook || !paths || !wrapper || !existsSync(paths.addon)) return hooked;
  const { addon } = paths;
  try {
    const [send, recv] = await prepare(wrapper);
    if (attemptedHook) return hooked;
    const mod = { exports: {} as Record<string, unknown> };
    process.dlopen(mod, addon, constants.dlopen.RTLD_LAZY);
    const attach = mod.exports['attach'] as ((send: number, recv: number, path: string) => boolean) | undefined;
    if (typeof attach !== 'function') return false;
    attemptedHook = true;
    hooked = attach(Number.parseInt(send, 16), Number.parseInt(recv, 16), normalize(wrapper));
    log('[native-hook] 本地偏移初始化 ' + (hooked ? '成功' : '失败'));
  } catch (error) {
    log('[native-hook] 初始化失败：' + String(error));
  }
  return hooked;
}
