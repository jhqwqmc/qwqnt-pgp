/** Small bounded file logger; debug output must not grow memory or disk without limit. */
import { existsSync, mkdirSync } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

let logFile = '';
let debugEnabled = false;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_BUFFER_BYTES = 512 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
let queue: string[] = [];
let queuedBytes = 0;
let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let startupRotation: Promise<void> = Promise.resolve();

export function isDebugLogEnabled(): boolean {
  return debugEnabled && !!logFile;
}

export function initLog(baseDataDir: string, debug: boolean): void {
  debugEnabled = debug;
  if (!debugEnabled) {
    logFile = '';
    startupRotation = Promise.resolve();
    clearQueue();
    return;
  }
  try {
    const dir = join(baseDataDir, 'qwqnt-pgp');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    logFile = join(dir, 'log.txt');
    startupRotation = rotateIfNeeded().catch(() => undefined);
  } catch {
    logFile = '';
    startupRotation = Promise.resolve();
  }
}

function ts(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function log(...args: unknown[]): void {
  if (!debugEnabled || !logFile) return;
  enqueue(`[${ts()}] ${args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ')}\n`);
}

/** Append external preload / renderer log text through the same bounded queue. */
export function logLine(text: string): void {
  if (!debugEnabled || !logFile) return;
  enqueue(`[${ts()}] ${text}\n`);
}

function enqueue(text: string): void {
  const line = truncateUtf8(text, MAX_LINE_BYTES);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_BUFFER_BYTES) return;
  while (queue.length && queuedBytes + bytes > MAX_BUFFER_BYTES) {
    const removed = queue.shift()!;
    queuedBytes -= Buffer.byteLength(removed, 'utf8');
  }
  queue.push(line);
  queuedBytes += bytes;
  scheduleFlush();
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '… [truncated]\n';
  const cap = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > cap) break;
    out += char;
    bytes += size;
  }
  return out + suffix;
}

function clearQueue(): void {
  queue = [];
  queuedBytes = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

function scheduleFlush(): void {
  if (!debugEnabled || flushing || flushTimer || !queue.length) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 300);
}

async function flush(): Promise<void> {
  if (flushing || !debugEnabled || !logFile || !queue.length) return;
  flushing = true;
  const target = logFile;
  const data = queue.join('');
  queue = [];
  queuedBytes = 0;
  try {
    await startupRotation;
    if (!debugEnabled || target !== logFile) return;
    await rotateBeforeAppend(target, Buffer.byteLength(data, 'utf8'));
    // On failure the detached batch is dropped. It is bounded already, and
    // requeueing it repeatedly can otherwise recreate an unbounded join buffer.
    if (debugEnabled && target === logFile) await appendFile(target, data, 'utf8');
  } catch { /* bounded drop; future log lines may retry on their normal flush */ }
  finally {
    flushing = false;
    if (queue.length) scheduleFlush();
  }
}

async function rotateBeforeAppend(target: string, incomingBytes: number): Promise<void> {
  let size = 0;
  try { size = (await stat(target)).size; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  if (size && size + incomingBytes > MAX_LOG_BYTES) await rotate(target);
}

async function rotateIfNeeded(): Promise<void> {
  if (!logFile) return;
  let size = 0;
  try { size = (await stat(logFile)).size; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  if (size > MAX_LOG_BYTES) await rotate(logFile);
  else await capExistingBackup(`${logFile}.1`);
}

async function capExistingBackup(path: string): Promise<void> {
  let info;
  try { info = await stat(path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  if (info.size <= MAX_LOG_BYTES) return;
  const temp = `${path}.tmp`;
  await rm(temp, { force: true });
  await pipeline(createReadStream(path, { start: info.size - MAX_LOG_BYTES }), createWriteStream(temp, { flags: 'w' }));
  await rename(temp, path);
}

async function rotate(target: string): Promise<void> {
  const backup = `${target}.1`;
  await rm(backup, { force: true });
  let info;
  try { info = await stat(target); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  if (info.size > MAX_LOG_BYTES) {
    await pipeline(createReadStream(target, { start: info.size - MAX_LOG_BYTES }), createWriteStream(backup, { flags: 'w' }));
    await rm(target, { force: true });
  } else {
    await rename(target, backup);
  }
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`;
    return JSON.stringify(v);
  } catch { return String(v); }
}
