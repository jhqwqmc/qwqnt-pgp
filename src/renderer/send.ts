import { buildCiphertextCard, CIPHERTEXT_SLICE_LENGTH } from '../shared/forward-card';
/**
 * 发送模块：加密 → 切片 → 发「伪造聊天记录卡片」。
 * 通过 preload 暴露的 sendArk 接口发送卡片，不在 renderer 中调用未公开的内核桥接对象。
 */
import { log } from './log';
import { getUinByUid, resolvePeerUin } from './store';
import { getAccountGeneration, getActiveAccountId, getDmConfig, getGroupConfig, getKeyBindings, loadAccountContext, loadConfig } from './config-cache';
import type { KeyBinding, PgpConfig, SendResult } from '@/shared/types';

export interface PeerTarget {
  chatType: number;
  peerUid: string;
  name?: string;
}

export interface SendOptions {
  plaintext: string;
  peer: PeerTarget;
  keyIDs?: string[];
}

interface SendAccount { accountId: string; generation: number }
function currentSendAccount(): SendAccount {
  const accountId = getActiveAccountId();
  if (!accountId) throw new Error('当前 QQ 账号上下文不可用');
  return { accountId, generation: getAccountGeneration() };
}
function assertSendAccount(account: SendAccount): void {
  if (account.generation !== getAccountGeneration() || account.accountId !== getActiveAccountId()) {
    throw new Error('账号已切换，已取消旧账号发送');
  }
}

function isNumericUin(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

async function resolveGroupId(peer: PeerTarget): Promise<string> {
  const groupId = getUinByUid(peer.peerUid) || peer.peerUid;
  if (isNumericUin(groupId)) return groupId;
  const resolved = await resolvePeerUin(peer.peerUid);
  if (!isNumericUin(resolved)) throw new Error('无法解析数字群号，已阻止配置读取和加密发送');
  return resolved;
}

/** Self-only groups are never considered enabled for encryption. */
export async function hasEnabledGroupRecipient(peer: PeerTarget, selfUin = ''): Promise<boolean> {
  await loadAccountContext();
  const account = currentSendAccount();
  const groupId = await resolveGroupId(peer);
  assertSendAccount(account);
  const config = await getGroupConfig(groupId);
  assertSendAccount(account);
  const ownUin = isNumericUin(selfUin) ? selfUin : '';
  const targets = [...new Set(config.targets.filter(isNumericUin))];
  const bindings = await getKeyBindings(targets);
  assertSendAccount(account);
  return targets.some(uin => {
    if (!isNumericUin(uin) || (ownUin && uin === ownUin)) return false;
    const binding = bindings.find(item => item.uin === uin && item.keyID?.trim());
    if (!binding) return false;
    return true;
  });
}

function randomUUID(): string {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* ignore */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 在本地构造「聊天记录」卡片。
 * resId 由协议端上传后拿到，点开才看得到内容。
 */
function buildFakeForwardCard(slices: string[], resId: string): string {
  return buildCiphertextCard(slices.length, resId, randomUUID());
}

/** 把长文本切成若干段 */
export function sliceText(text: string, limit: number): string[] {
  const max = Math.max(200, Math.floor(limit) || 3000);
  const out: string[] = [];
  // 直接按原字符串切分，不能 split/join 行：那会丢空行和末尾换行，破坏密文逐字节还原。
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** 自动挑自己的公钥（有私钥的那把） */
async function autoOwnKeyID(): Promise<string> {
  try {
    const { secret } = await window.QwQNTPgp.listKeys();
    return secret[0]?.keyID ?? '';
  } catch {
    return '';
  }
}

/** 本次发送的收件人（自己永远在内） */
async function resolveRecipients(peer: PeerTarget, cfg: PgpConfig, selfUin: string, peerUin: string,
  groupTargets: string[], bindings: KeyBinding[]): Promise<string[]> {
  const ids = new Set<string>();
  const own = cfg.ownKeyID || (await autoOwnKeyID());
  if (own) ids.add(own);

  if (peer.chatType === 2) {
    const missing: string[] = [];
    for (const uin of groupTargets) {
      if (!isNumericUin(uin)) throw new Error('群加密成员必须使用数字 QQ 号，请重新选择成员');
      // The backend always adds the signing private key's public key. The UI
      // also persists the current user as a selected target, even without an
      // explicit binding, so don't treat that implicit own recipient as missing.
      if (selfUin && uin === selfUin) continue;
      const b = bindings.find(k => isNumericUin(k.uin) && k.uin === uin);
      if (b?.keyID) ids.add(b.keyID);
      else missing.push(uin);
    }
    if (missing.length) throw new Error(`群加密成员缺少公钥绑定：${missing.join('、')}；请为这些成员添加并绑定公钥`);
  } else {
    const bound = bindings.find(k => /^\d+$/.test(k.uin) && k.uin === peerUin);
    if (bound?.keyID) ids.add(bound.keyID);
  }
  return [...ids];
}

/** 主入口：加密 + 发伪造聊天记录卡片 */
export async function sendEncrypted(opts: SendOptions): Promise<SendResult> {
  const { peer, plaintext } = opts;
  try {
    const context = await loadAccountContext();
    if (!context) throw new Error('当前 QQ 账号上下文不可用');
    const account = { accountId: context.accountId, generation: getAccountGeneration() };
    assertSendAccount(account);
    const cfg = await loadConfig();
    assertSendAccount(account);
    const selfUin = context.accountId;
    // Enforce the user-facing opt-in before recipient lookup, key listing,
    // encryption, forwarding upload, or sendArk. Explicit keyIDs cannot bypass it.
    let peerUin = '';
    let groupTargets: string[] = [];
    if (peer.chatType === 2) {
      const groupId = await resolveGroupId(peer);
      assertSendAccount(account);
      const group = await getGroupConfig(groupId);
      assertSendAccount(account);
      groupTargets = [...new Set(group.targets.filter(isNumericUin))];
      peerUin = groupId;
    } else {
      peerUin = getUinByUid(peer.peerUid) || await resolvePeerUin(peer.peerUid);
      assertSendAccount(account);
      if (!isNumericUin(peerUin)) return { ok: false, slices: 0, error: '无法解析私聊对象数字 QQ 号，已阻止发送' };
      const dm = await getDmConfig(peerUin);
      assertSendAccount(account);
      if (!dm.enabled) return { ok: false, slices: 0, error: '此私聊的 PGP 加密开关未开启' };
    }
    const bindingUins = peer.chatType === 2 ? groupTargets : [peerUin];
    const bindings = await getKeyBindings(bindingUins);
    assertSendAccount(account);
    if (peer.chatType === 2) {
      if (!groupTargets.some(uin => uin !== selfUin && bindings.some(binding => binding.uin === uin && binding.keyID.trim()))) {
        return { ok: false, slices: 0, error: '群聊加密至少需要开启一位已绑定公钥的其他成员；仅选自己不会加密发送' };
      }
    }

    const recipients = opts.keyIDs?.length ? [...new Set(opts.keyIDs)]
      : await resolveRecipients(peer, cfg, selfUin, peerUin, groupTargets, bindings);
    assertSendAccount(account);
    if (opts.keyIDs?.length) {
      const ownKey = cfg.ownKeyID || await autoOwnKeyID();
      if (ownKey && !recipients.includes(ownKey)) recipients.unshift(ownKey);
    }
    log(`收件人：${JSON.stringify(recipients)}（会话 ${JSON.stringify(peer)}）`);
    if (!recipients.length) {
      return { ok: false, slices: 0, error: '没有可用的收件人公钥：请先设好自己的公钥，或在群里勾选要加密的成员' };
    }

    if (peer.chatType === 2) {
      const requiredKeys = groupTargets
        .filter(uin => isNumericUin(uin) && uin !== selfUin)
        .map(uin => bindings.find(item => isNumericUin(item.uin) && item.uin === uin)?.keyID)
        .filter((keyID): keyID is string => Boolean(keyID?.trim()));
      if (!requiredKeys.some(keyID => recipients.includes(keyID))) {
        return { ok: false, slices: 0, error: '显式收件人未包含任何已开启群成员的公钥，已阻止发送' };
      }
    }

    if (peer.chatType !== 2) {
      const binding = bindings.find(item => isNumericUin(item.uin) && item.uin === peerUin);
      const hasPeerKey = binding?.keyID && recipients.includes(binding.keyID);
      if (!hasPeerKey) {
        return { ok: false, slices: 0, error: `私聊对象 ${peer.name || peerUin || ''} 没有已绑定的公钥；请先按数字 QQ 号绑定对方公钥` };
      }
    }
    const armored = await window.QwQNTPgp.encrypt(plaintext, recipients);
    assertSendAccount(account);
    const slices = sliceText(armored, CIPHERTEXT_SLICE_LENGTH);
    log(`加密完成：${armored.length} 字符，切成 ${slices.length} 段`);
    return await sendFakeForward(
      peer,
      slices,
      context.selfUid,
      account
    );
  } catch (err) {
    return { ok: false, slices: 0, error: String(err instanceof Error ? err.message : err) };
  }
}

/** 伪造卡片：先协议端上传拿 resId，再本地拼 ark 发给对方 */
async function sendFakeForward(
  peer: PeerTarget,
  slices: string[],
  selfUid: string,
  account: SendAccount
): Promise<SendResult> {
  const groupId = peer.chatType === 2 ? Number(peer.peerUid) || 0 : 0;
  const now = Math.floor(Date.now() / 1000);
  const nodes = slices.map(text => ({
    uin: 0,
    name: '\u200B',
    groupId: groupId || undefined,
    time: now,
    text
  }));

  let resId: string;
  try {
    log(`上传合并转发：${nodes.length} 条，群=${groupId || '(私聊)'} selfUid=${selfUid}`);
    assertSendAccount(account);
    const up = await window.QwQNTPgp.forwardUpload({ selfUid, nodes, groupId });
    assertSendAccount(account);
    if (!up.resId) throw new Error('服务器没有返回转发记录 ID');
    resId = up.resId;
    log(`上传合并转发成功：resId=${resId}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`上传合并转发失败：${reason}`);
    return { ok: false, slices: 0, error: `上传聊天记录失败：${reason}` };
  }

  const card = buildFakeForwardCard(slices, resId);
  log(`伪造卡片：目标=${JSON.stringify(peer)} 段数=${slices.length} 卡片=${card.slice(0, 600)}`);
  try {
    assertSendAccount(account);
    const r = await window.QwQNTPgp.sendArk({ chatType: peer.chatType, peerUid: peer.peerUid }, card);
    assertSendAccount(account);
    log(`伪造卡片发送结果：ok=${r.ok}${r.error ? ` err=${r.error}` : ''}`);
    if (!r.ok) {
      return { ok: false, slices: 0, error: `伪造卡片发送失败：${r.error ?? ''}` };
    }
    return { ok: true, slices: slices.length };
  } catch (err) {
    return { ok: false, slices: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
