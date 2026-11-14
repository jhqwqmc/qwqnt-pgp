import { ListCache } from '../shared/list-cache';
import type { KeyInfo } from '@/shared/types';

export const friendsCache = new ListCache<Array<{ uin: string; name: string }>>(60_000);
export const keysCache = new ListCache<{ public: KeyInfo[]; secret: KeyInfo[] }>(5_000);

export function readFriends(account: string, force = false) {
  return friendsCache.get(account, () => window.QwQNTPgp.listFriends(force), force);
}

export function readKeys(account: string, force = false) {
  return keysCache.get(account, () => window.QwQNTPgp.listKeys(force), force);
}
