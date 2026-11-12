export interface AuthProbeWebContents {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

export interface AuthProbeInterceptor {
  interceptIpcSend(callback: (channel: string, meta: Record<string, unknown>, payload: unknown) => { action: 'pass' | 'block' } | void): () => void;
}

/** Dispatches a read-only fetchAuthData request through the target renderer's own IPC listener. */
export function requestAuthData(
  contents: AuthProbeWebContents,
  listeners: Array<(...args: any[]) => unknown>,
  interceptor: AuthProbeInterceptor,
  callbackId: string,
  timeoutMs = 4_000,
  isCurrent: () => boolean = () => true
): Promise<unknown> {
  if (!Number.isSafeInteger(contents.id) || contents.id <= 0 || contents.isDestroyed()) return Promise.reject(new Error('target renderer is unavailable'));
  if (!listeners.length) return Promise.reject(new Error('target renderer IPC receiver is unavailable'));

  const rendererChannel = `RM_IPCFROM_RENDERER${contents.id}`;
  const responseChannel = `RM_IPCFROM_MAIN${contents.id}`;
  const fakeEvent = {
    sender: contents,
    reply: (...args: unknown[]) => { if (!contents.isDestroyed()) contents.send(rendererChannel, ...args); },
    returnValue: undefined
  };
  const meta = { type: 'request', eventName: 'GlobalDataApi', peerId: contents.id, callbackId };
  const request = { cmdName: 'fetchAuthData', cmdType: 'invoke', payload: [] };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve(value);
    };
    unsubscribe = interceptor.interceptIpcSend((channel, responseMeta, payload) => {
      if (channel === responseChannel && responseMeta?.callbackId === callbackId) {
        finish(isCurrent() && !contents.isDestroyed() ? null : new Error('auth probe was invalidated'), payload);
        return { action: 'block' };
      }
      return { action: 'pass' };
    });
    timer = setTimeout(() => finish(new Error('fetchAuthData timed out')), Math.max(1, timeoutMs));
    try {
      for (const listener of listeners) {
        listener(fakeEvent, meta, request);
        if (settled || contents.isDestroyed()) break;
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
