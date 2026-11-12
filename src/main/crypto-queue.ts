/** One-at-a-time signing/encryption queue with bounded retained input. */
export class BoundedCryptoQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private pendingBytes = 0;

  constructor(private readonly maxCount = 32, private readonly maxBytes = 4 * 1024 * 1024) {}

  run<T>(bytes: number, operation: () => Promise<T>): Promise<T> {
    const size = Math.max(0, Math.ceil(bytes));
    if (this.pendingCount >= this.maxCount || this.pendingBytes + size > this.maxBytes) {
      return Promise.reject(new Error('加密队列已满，请稍后重试'));
    }
    this.pendingCount++;
    this.pendingBytes += size;
    const task = this.tail.then(operation);
    this.tail = task.then(() => undefined, () => undefined);
    return task.finally(() => {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.pendingBytes = Math.max(0, this.pendingBytes - size);
    });
  }

  get queuedCount(): number { return this.pendingCount; }
  get queuedBytes(): number { return this.pendingBytes; }
}
