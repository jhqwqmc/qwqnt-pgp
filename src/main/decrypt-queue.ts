/** One hardware-key operation at a time, shared by every QQ window. */
import { createHash } from 'node:crypto';

export class SerialDecryptQueue<T> {
  private static readonly maxCooldownEntries = 256;
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, { task: Promise<T>; bytes: number }>();
  private pendingBytes = 0;
  private generation = 0;
  private cooldowns = new Map<string, number>();

  constructor(
    private shouldPause: (error: unknown) => boolean,
    private cooldownMs = 3000,
    private maxPendingCount = 128,
    private maxPendingBytes = 8 * 1024 * 1024
  ) {}

  resume(): void {
    this.cooldowns.clear();
  }

  enqueue(key: string, operation: () => Promise<T>, resume = false): Promise<T> {
    this.pruneCooldowns();
    const keyHash = this.hash(key);
    const existing = this.pending.get(keyHash);
    if (existing) return existing.task;
    if (resume) this.cooldowns.delete(keyHash);
    const cooldownUntil = this.cooldowns.get(keyHash) ?? 0;
    if (cooldownUntil > Date.now()) {
      return Promise.reject(new Error('[PGP_DECRYPT_COOLDOWN] 这条消息刚刚解密失败，请稍后再试'));
    }
    this.cooldowns.delete(keyHash);
    const bytes = Buffer.byteLength(key, 'utf8');
    if (this.pending.size >= this.maxPendingCount || this.pendingBytes + bytes > this.maxPendingBytes) {
      return Promise.reject(new Error('[PGP_DECRYPT_SKIPPED] 解密队列暂满，请稍后重试'));
    }
    const generation = this.generation;
    const task = this.tail.then(async () => {
      if (generation !== this.generation) throw new Error('[PGP_DECRYPT_SKIPPED] 该任务因前一硬件解密失败而跳过，请重新触发');
      try {
        return await operation();
      } catch (error) {
        if (this.shouldPause(error)) {
          this.generation++;
          this.cooldowns.delete(keyHash);
          this.cooldowns.set(keyHash, Date.now() + this.cooldownMs);
          while (this.cooldowns.size > SerialDecryptQueue.maxCooldownEntries) {
            const oldest = this.cooldowns.keys().next().value;
            if (oldest === undefined) break;
            this.cooldowns.delete(oldest);
          }
        }
        throw error;
      }
    });
    const entry = { task, bytes };
    this.pending.set(keyHash, entry);
    this.pendingBytes += bytes;
    this.tail = task.then(() => {}, () => {});
    const release = () => {
      if (this.pending.get(keyHash) !== entry) return;
      this.pending.delete(keyHash);
      this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
    };
    void task.then(release, release);
    return task;
  }

  get pendingCount(): number { return this.pending.size; }
  get queuedKeyBytes(): number { return this.pendingBytes; }

  private pruneCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
  }

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
