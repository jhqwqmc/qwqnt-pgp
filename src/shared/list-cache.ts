export class ListCache<T> {
  private entries = new Map<string, { value?: T; expires: number; pending?: Promise<T> }>();

  constructor(private ttl: number) {}

  peek(key: string): T | undefined { return this.entries.get(key)?.value; }

  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }

  get(key: string, load: () => Promise<T>, force = false): Promise<T> {
    let entry = this.entries.get(key);
    if (entry?.pending) return entry.pending;
    if (!force && entry?.value !== undefined && entry.expires > Date.now()) return Promise.resolve(entry.value);
    entry ??= { expires: 0 };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
    const current = entry;
    current.pending = Promise.resolve().then(load).then(value => {
      current.value = value;
      current.expires = Date.now() + this.ttl;
      return value;
    }).finally(() => { current.pending = undefined; });
    return current.pending;
  }
}
