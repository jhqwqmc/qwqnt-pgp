type AnyObj = Record<string, any>;

export interface WebContentsLike {
  id: number;
  session: { emit?: (...args: any[]) => unknown; _events?: Record<string, unknown> };
  emit?: (...args: any[]) => unknown;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  _events?: Record<string, unknown>;
}

export interface ReceiveArgs extends Array<unknown> {
  0: unknown;
  1: unknown;
  2: string;
  3: unknown[];
}

export function rendererIdFromChannel(channel: string): number {
  const match = /^RM_IPCFROM_RENDERER(\d+)$/.exec(channel);
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function senderFor(event: unknown, channel: string, fromId: (id: number) => WebContentsLike | undefined): WebContentsLike {
  const id = rendererIdFromChannel(channel);
  const sender = isObject(event) && isObject(event.sender) ? event.sender as unknown as WebContentsLike : undefined;
  if (!id || !sender || sender.id !== id) throw new Error('QQ IPC sender 与原始 channel 不匹配');
  const current = fromId(id);
  if (!current || current.id !== id || current.isDestroyed()) throw new Error('原始 QQ IPC 窗口已关闭');
  return sender;
}

export function createSendInterceptorTransport(fromId: (id: number) => WebContentsLike | undefined) {
  return {
    replay(args: ReceiveArgs, envelope: unknown[]): void {
      const sender = senderFor(args[0], args[2], fromId);
      const meta = isObject(envelope[0]) ? envelope[0] : {};
      if (meta.peerId !== undefined && Number(meta.peerId) !== sender.id) {
        throw new Error('sendMsg envelope peerId 与原始 IPC sender 不匹配');
      }
      if (typeof sender._events?.['-ipc-message'] === 'function') {
        if (typeof sender.emit !== 'function') throw new Error('webContents 缺少 IPC emit');
        // ref/qwqnt-ipc-interceptor's webContents path receives four arguments.
        sender.emit('-ipc-message', args[0], args[1], args[2], envelope);
        return;
      }
      const session = sender.session;
      if (typeof session._events?.['-ipc-message'] !== 'function' || typeof session.emit !== 'function') {
        throw new Error('session 缺少可用的 IPC 接收器');
      }
      // Its session fallback is installed on Electron's three-argument event.
      session.emit('-ipc-message', args[0], args[2], envelope);
    },

    replyFailure(event: unknown, channel: string, meta: AnyObj, error: string): void {
      const sender = senderFor(event, channel, fromId);
      const callbackId = typeof meta.callbackId === 'string' ? meta.callbackId : '';
      if (!callbackId) throw new Error('sendMsg IPC 缺少 callbackId');
      sender.send(`RM_IPCFROM_MAIN${sender.id}`, {
        ...meta,
        callbackId,
        promiseStatue: 'full',
        type: 'response',
        eventName: typeof meta.eventName === 'string' ? meta.eventName : 'ntApi',
        peerId: sender.id
      }, { result: -1, errMsg: error });
    },

    notifyFailure(event: unknown, channel: string, failure: unknown): void {
      const sender = senderFor(event, channel, fromId);
      sender.send('qwqnt-pgp:auto-send-failed', failure);
    }
  };
}

function isObject(value: unknown): value is AnyObj {
  return typeof value === 'object' && value !== null;
}
