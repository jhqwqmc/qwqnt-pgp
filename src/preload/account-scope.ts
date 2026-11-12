export interface ScopedAccountContext { accountId: string; selfUid: string; revision: number }
type RawInvoke = <T>(channel: string, ...args: unknown[]) => Promise<T>;

export function createPreloadAccountScope(fetchContext: () => Promise<ScopedAccountContext | null>, rawInvoke: RawInvoke) {
  let active: ScopedAccountContext | null | undefined;
  let epoch = 0;
  const listeners = new Set<(context: ScopedAccountContext | null) => void>();
  const same = (a: ScopedAccountContext | null | undefined, b: ScopedAccountContext | null | undefined) =>
    a?.accountId === b?.accountId && a?.selfUid === b?.selfUid && a?.revision === b?.revision;

  const setContext = (context: ScopedAccountContext | null, notify: boolean): void => {
    const changed = !same(active, context);
    if (changed) epoch++;
    active = context;
    if (changed && notify) for (const listener of listeners) listener(context);
  };

  const update = (context: ScopedAccountContext | null): void => setContext(context, true);

  const accountContext = async (): Promise<ScopedAccountContext | null> => {
    if (active !== undefined && active !== null) return active;
    const start = epoch;
    const fetched = await fetchContext();
    if (start !== epoch) return active ?? null;
    if (fetched && (!/^[1-9]\d{0,19}$/.test(fetched.accountId) || !fetched.selfUid || !Number.isSafeInteger(fetched.revision))) return null;
    setContext(fetched, false);
    return fetched;
  };

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    let start = epoch;
    const wasUninitialized = active === undefined || active === null;
    const context = wasUninitialized ? await accountContext() : active;
    if (wasUninitialized) start = epoch;
    if (!context) throw new Error('当前QQ账号身份尚未确认');
    if (start !== epoch || !same(active, context)) throw new Error('QQ账号已切换，请重试');
    const value = await rawInvoke<T>(channel, { accountId: context.accountId, selfUid: context.selfUid, revision: context.revision }, ...args);
    if (start !== epoch || !same(active, context)) throw new Error('QQ账号已切换，请重试');
    return value;
  };

  return {
    accountContext,
    currentContext: () => active ?? null,
    invoke,
    update,
    onAccountChanged(listener: (context: ScopedAccountContext | null) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
