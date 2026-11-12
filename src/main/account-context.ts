export interface AccountContext { readonly accountId: string; readonly selfUid: string; readonly revision: number }

type WindowBinding = { context: AccountContext; namespace?: string };

/** Maps only explicitly observed session-init UIDs to accounts. It never guesses from account lists. */
export class AccountContextRegistry {
  private readonly windows = new Map<number, WindowBinding>();
  private readonly namespaceOwners = new Map<string, Set<number>>();
  private readonly namespaceRevisions = new Map<string, number>();
  private revisionSerial = 0;
  private readonly invalidated = new Set<number>();

  bindSession(windowId: number, uid: string, accountId: string, namespace?: string): AccountContext {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('无效的窗口身份');
    if (!/^[1-9]\d{0,19}$/.test(accountId)) throw new Error('内核账号UIN无效');
    if (!uid || typeof uid !== 'string') throw new Error('内核会话UID无效');
    const existing = this.windows.get(windowId);
    if (!this.invalidated.has(windowId) && existing?.context.accountId === accountId && existing.context.selfUid === uid && existing.namespace === namespace) {
      return existing.context;
    }
    const revision = ++this.revisionSerial;
    this.invalidated.delete(windowId);
    const context = Object.freeze({ accountId, selfUid: uid, revision });
    const oldNamespace = this.windows.get(windowId)?.namespace;
    if (oldNamespace && oldNamespace !== namespace) this.removeNamespaceOwner(oldNamespace, windowId);
    this.windows.set(windowId, { context, namespace });
    if (namespace) {
      const members = this.namespaceOwners.get(namespace) ?? new Set<number>();
      members.add(windowId); this.namespaceOwners.set(namespace, members);
      this.namespaceRevisions.set(namespace, ++this.revisionSerial);
    }
    return context;
  }

  capture(windowId: number, namespace?: string): AccountContext {
    if (this.invalidated.has(windowId)) throw new Error('QQ会话身份正在重新确认');
    const direct = this.windows.get(windowId);
    if (direct) return direct.context;
    if (namespace) {
      const owners = [...(this.namespaceOwners.get(namespace) ?? [])].map(id => this.windows.get(id)).filter((value): value is WindowBinding => !!value);
      const identities = new Set(owners.map(owner => `${owner.context.accountId}\u0000${owner.context.selfUid}`));
      if (identities.size === 1 && owners.length) return Object.freeze({
        ...owners[0].context,
        revision: this.namespaceRevisions.get(namespace) ?? owners[0].context.revision
      });
    }
    throw new Error('当前窗口尚未绑定已确认的QQ账号');
  }

  isCurrent(windowId: number, context: AccountContext, namespace?: string): boolean {
    const binding = this.windows.get(windowId);
    if (binding) return binding.context.revision === context.revision && binding.context.accountId === context.accountId;
    try {
      const current = this.capture(windowId, namespace);
      return current.revision === context.revision && current.accountId === context.accountId;
    } catch { return false; }
  }

  canUseSingleNativeSession(context: AccountContext): boolean {
    const active = new Set([...this.windows.values()].map(value => `${value.context.accountId}\u0000${value.context.selfUid}`));
    return active.size <= 1 && active.has(`${context.accountId}\u0000${context.selfUid}`);
  }

  destroy(windowId: number): void {
    const binding = this.windows.get(windowId);
    this.windows.delete(windowId);
    this.invalidated.delete(windowId);
    if (binding?.namespace) this.removeNamespaceOwner(binding.namespace, windowId);
  }

  invalidate(windowId: number): void {
    const binding = this.windows.get(windowId);
    if (binding) {
      this.windows.delete(windowId);
      if (binding.namespace) this.removeNamespaceOwner(binding.namespace, windowId);
    }
    this.invalidated.add(windowId);
  }

  private removeNamespaceOwner(namespace: string, windowId: number): void {
    const members = this.namespaceOwners.get(namespace);
    if (!members?.delete(windowId)) return;
    if (!members.size) { this.namespaceOwners.delete(namespace); this.namespaceRevisions.delete(namespace); }
    else this.namespaceRevisions.set(namespace, ++this.revisionSerial);
  }
}

export function accountIdFromLoginList(uid: string, rows: Array<Record<string, unknown>>): string {
  const matches = rows.filter(row => row.uid === uid && typeof row.uin === 'string' && /^[1-9]\d{0,19}$/.test(row.uin));
  if (matches.length !== 1) throw new Error('无法将当前会话UID唯一映射到QQ账号');
  return String(matches[0].uin);
}
