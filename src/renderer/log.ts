/**
 * renderer 侧日志：全部转发到主进程写文件（不在控制台打印）。
 */
let debugEnabled = false;

export async function initRendererLog(): Promise<void> {
  try {
    debugEnabled = (await window.QwQNTPgp?.debugLogEnabled?.()) === true;
  } catch {
    debugEnabled = false;
  }
}

export function log(...args: unknown[]): void {
  if (!debugEnabled) return;
  try {
    const text = args.map(a => (typeof a === 'string' ? a : safeStr(a))).join(' ');
    void window.QwQNTPgp?.log(text)?.catch(() => undefined);
  } catch { /* ignore */ }
}

function safeStr(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 汇报一个对象的关键字段（避免打印巨大对象） */
export function brief(v: unknown, max = 300): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
  } catch {
    return String(v);
  }
}
