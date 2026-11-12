import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';

type Offsets = [send: string, recv: string];
type OffsetEntry = { send: string; recv: string };

const limit = 100;
const version = 3;
const isOffset = (value: unknown): value is string => typeof value === 'string' && /^[1-9A-F][0-9A-F]{0,7}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readCache(path: string): Promise<Map<string, OffsetEntry>> {
  const entries = new Map<string, OffsetEntry>();
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (isObject(data) && data.version === version && isObject(data.entries)) {
      for (const [key, value] of Object.entries(data.entries).slice(-limit)) {
        if (/^[a-f0-9]{64}:[a-z0-9]+$/.test(key) && isObject(value) &&
            isOffset(value.send) && isOffset(value.recv)) {
          entries.set(key, { send: value.send, recv: value.recv });
        }
      }
    }
  } catch { /* 缓存不可读时重新解析 */ }
  return entries;
}

async function saveCache(path: string, entries: Map<string, OffsetEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify({ version, entries: Object.fromEntries([...entries].slice(-limit)) }), 'utf8');
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function scan(script: string, wrapper: string, arch: string): Promise<Offsets> {
  if (process.platform !== 'win32' || arch !== 'x64') {
    return Promise.reject(new Error('进程内偏移解析目前支持 Windows x64'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(script, { workerData: wrapper, execArgv: [] });
    worker.once('message', (value: unknown) => {
      if (Array.isArray(value) && value.length === 2 && isOffset(value[0]) && isOffset(value[1])) {
        resolve([value[0], value[1]]);
      } else {
        reject(new Error(typeof value === 'string' ? value : '解析器没有返回有效偏移'));
      }
    });
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`偏移解析 Worker 提前退出（${code}）`)));
  });
}

export async function resolveOffsets(
  script: string, cache: string, wrapper: string, arch: string,
): Promise<Offsets> {
  const digest = await hashFile(wrapper);
  const key = digest + ':' + arch;
  const entries = await readCache(cache);
  const hit = entries.get(key);
  if (hit && [...entries.keys()].at(-1) === key) return [hit.send, hit.recv];

  const offsets: Offsets = hit ? [hit.send, hit.recv] : await scan(script, wrapper, arch);
  if (!hit && await hashFile(wrapper) !== digest) {
    throw new Error('解析期间 QQ 内核文件发生变化，请重启 QQ');
  }
  entries.delete(key);
  entries.set(key, { send: offsets[0], recv: offsets[1] });
  await saveCache(cache, entries).catch(() => {});
  return offsets;
}
