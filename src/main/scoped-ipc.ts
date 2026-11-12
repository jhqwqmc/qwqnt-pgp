import type { AccountContext } from './account-context';

export interface AccountToken { accountId: string; selfUid: string; revision: number }

export function assertAccountToken(current: AccountContext, token: unknown): void {
  if (!token || typeof token !== 'object') throw new Error('QQ账号上下文已变化或无效，请重新加载');
  const supplied = token as Partial<AccountToken>;
  if (supplied.accountId !== current.accountId || supplied.selfUid !== current.selfUid || supplied.revision !== current.revision) {
    throw new Error('QQ账号上下文已变化或无效，请重新加载');
  }
}
