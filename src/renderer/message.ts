/** Message-side silent PGP decryption for QQ's native chat bubbles. */
import { log } from './log';
import { getCurrentPeer, getSelfInfo } from './store';
import { getActiveAccountId, getCached } from './config-cache';
import type { DecryptResult, SignatureInfo } from '@/shared/types';

const MESSAGE_SELECTOR = '.message, .message-native';
const ARMOR_BEGIN = '-----BEGIN PGP MESSAGE-----';
const ARMOR_END = '-----END PGP MESSAGE-----';

let autoDecrypt = true;
let suppressNextEnableScan = false;
let observer: MutationObserver | null = null;
let observedTarget: Element | null = null;
let scanTimer: number | null = null;
let needFullScan = false;
let configListenerBound = false;
let scrollListenerBound = false;
let scrollScanScheduled = false;
let preferredOwnKeyID = getCached()?.ownKeyID ?? '';
const pendingRoots: Element[] = [];
let attemptedOwners = new WeakMap<Element, string>();
let pendingRecordOwners = new WeakMap<Element, string>();
let hydrationRetries = new WeakMap<Element, number>();
const failedDecryptOwners = new Set<Element>();
let failedCipherKeys = new WeakMap<Element, string[]>();
const cooldownRetryAt = new WeakMap<Element, number>();
const cooldownRetryUsed = new WeakSet<Element>();
let resumeOwners = new WeakSet<Element>();
let completedOwners = new WeakMap<Element, { msgId: string; key: string; plain: HTMLElement; signature: SignatureInfo }>();

type CachedFailure = { error: Error; expiresAt: number };
type CacheValue = Promise<DecryptResult> | DecryptResult | CachedFailure;
const decryptCache = new Map<string, CacheValue>();
const DECRYPT_CACHE_MAX = 300;
const DECRYPT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DECRYPT_FAILURE_TTL_MS = 3000;
let manualTasks = new WeakMap<Element, { key: string; promise: Promise<void> }>();
let decryptCacheBytes = 0;
let accountEpoch = 0;
window.addEventListener('qwqnt-pgp:account-changed', () => {
  accountEpoch++;
  suppressNextEnableScan = true;
  autoDecrypt = false;
  preferredOwnKeyID = '';
  decryptCache.clear(); decryptCacheBytes = 0;
  attemptedOwners = new WeakMap();
  pendingRecordOwners = new WeakMap(); hydrationRetries = new WeakMap();
  pendingRoots.length = 0; failedDecryptOwners.clear();
  failedCipherKeys = new WeakMap();
  completedOwners = new WeakMap();
  manualTasks = new WeakMap();
  // Pending promises belong to the old scoped IPC identity and must not apply to DOM.
  resumeOwners = new WeakSet();
});

/** Memory-only diagnostics, safe to expose because it contains no message data. */
export function getMessageDecryptCacheUsage(): { entries: number; estimatedBytes: number; maxBytes: number } {
  return { entries: decryptCache.size, estimatedBytes: decryptCacheBytes, maxBytes: DECRYPT_CACHE_MAX_BYTES };
}

/**
 * Kept as a pure compatibility helper for older plugin integrations.
 * The silent renderer path never replaces unsupported messages by guessing.
 */
export function claimLastSentFallback(
  last: { text: string; app: string; uniseq: string; used?: boolean } | undefined,
  card: { app: string; uniseq: string } | null
): string | null {
  if (!last?.text || last.used || !card || card.app !== 'com.tencent.multimsg' ||
    last.app !== card.app || !last.uniseq || card.uniseq !== last.uniseq) return null;
  last.used = true;
  return last.text;
}

/** Auto-decrypt is quiet. Re-enabling it explicitly retries previously failed owners. */
export function setAutoDecrypt(v: boolean): void {
  const retry = !autoDecrypt && v;
  autoDecrypt = v;
  if (!retry) return;
  if (suppressNextEnableScan) { suppressNextEnableScan = false; return; }
  attemptedOwners = new WeakMap();
  for (const [ciphertext, value] of decryptCache) {
    if (isCachedFailure(value)) deleteDecryptCache(ciphertext);
  }
  needFullScan = true;
  if (observer) scheduleScan();
  else if (typeof document !== 'undefined') scanAll();
}

/** Start observing only real message component roots, never list or bubble wrappers. */
export function startMessageWatcher(): void {
  if (observer) return;
  if (!configListenerBound) {
    configListenerBound = true;
    window.addEventListener('qwqnt-pgp:config-updated', event => {
      const cfg = (event as CustomEvent<{ autoDecrypt?: unknown; ownKeyID?: unknown }>).detail;
      if (typeof cfg?.autoDecrypt === 'boolean') setAutoDecrypt(cfg.autoDecrypt);
      if (typeof cfg?.ownKeyID === 'string' && cfg.ownKeyID !== preferredOwnKeyID) {
        preferredOwnKeyID = cfg.ownKeyID;
        for (const [key, value] of decryptCache) if (isCachedFailure(value)) deleteDecryptCache(key);
        const retry = [...failedDecryptOwners];
        failedDecryptOwners.clear();
        for (const owner of retry) {
          if (!owner.isConnected) continue;
          attemptedOwners.delete(owner);
          scanOwner(owner);
        }
      }
    });
  }
  if (!scrollListenerBound) {
    scrollListenerBound = true;
    document.addEventListener('scroll', scanVisibleMessagesAfterScroll, { capture: true, passive: true });
  }

  observer = new MutationObserver(mutations => {
    let added = false;
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' && mutation.type !== 'characterData') continue;
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      let foundMessage = false;
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        const owner = node.matches(MESSAGE_SELECTOR) ? node : node.closest(MESSAGE_SELECTOR);
        if (owner) {
          if (pendingRoots.length < 200) pendingRoots.push(owner);
          foundMessage = true;
        }
        for (const nested of node.querySelectorAll(MESSAGE_SELECTOR)) {
          if (pendingRoots.length >= 200) break;
          pendingRoots.push(nested);
          foundMessage = true;
        }
      }
      // Text nodes may be replaced in place inside an existing message.
      if (!foundMessage && target) {
        const owner = target.matches(MESSAGE_SELECTOR) ? target : target.closest(MESSAGE_SELECTOR);
        if (owner && pendingRoots.length < 200) pendingRoots.push(owner);
      }
      if (foundMessage || (target && target.closest(MESSAGE_SELECTOR))) added = true;
    }
    if (added) scheduleScan();
  });

  const listSelector = [
    '.message-list', '.list-container', '.message-list-container',
    '.message-panel .container-content-view', '.container-content-view', '.message-panel'
  ].join(',');
  const attach = (): boolean => {
    // Forward records can be shown in another list or a dynamically mounted overlay.
    // Observe discovery at the document root and process only actual message owners.
    const current = document.documentElement ?? document.querySelector(listSelector);
    if (current && current === observedTarget && current.isConnected) return true;
    observer?.disconnect();
    observedTarget = null;
    if (!current || !observer) return false;
    observer.observe(current, { childList: true, characterData: true, subtree: true });
    observedTarget = current;
    needFullScan = true;
    scheduleScan();
    log(`消息监听挂到 ${current.className || current.tagName}`);
    return true;
  };
  const pollAttach = (): void => {
    attach();
    pruneDisconnectedState();
    processCooldownRetries();
    // Vue may hydrate unsupported forward props without a DOM mutation. Retry
    // only visible forward candidates, with a small per-owner retry budget.
    scanHydrationCandidates();
    window.setTimeout(pollAttach, 2000);
  };

  attach();
  window.setTimeout(pollAttach, 2000);
  needFullScan = true;
  scheduleScan();
  log('消息监听已启动');
}

function scanHydrationCandidates(): void {
  const visited = new Set<Element>();
  for (const node of document.querySelectorAll(MESSAGE_SELECTOR)) {
    const owner = canonicalOwner(node) ?? node;
    if (visited.has(owner)) continue;
    visited.add(owner);
    const retries = hydrationRetries.get(owner) ?? 0;
    if (retries >= 6 || !isForwardCandidate(owner)) continue;
    hydrationRetries.set(owner, retries + 1);
    scanOwner(owner);
  }
}

function isForwardCandidate(owner: Element): boolean {
  const body = messageContent(owner)?.textContent?.trim() ?? '';
  const record = messageRecord(owner);
  return /^(?:\[聊天记录\]|\[转发消息\]|\[暂不支持该消息类型[^\]]*\]|暂不支持该消息类型)/.test(body) ||
    !!record?.elements.some(element => !!element?.arkElement || typeof element?.multiForwardMsgElement?.resId === 'string');
}

function scheduleScan(): void {
  if (scanTimer !== null) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    try {
      if (needFullScan) {
        needFullScan = false;
        scanAll();
      }
      scanPending();
    } catch (err) {
      log(`扫描消息出错：${err instanceof Error ? err.name : 'unknown'}`);
    }
  }, 300);
}

function scanPending(): void {
  pruneDisconnectedState();
  const roots = pendingRoots.splice(0, pendingRoots.length);
  for (const owner of roots) if (owner.isConnected) scanOwner(owner);
}

function pruneDisconnectedState(): void {
  for (let i = pendingRoots.length - 1; i >= 0; i--) if (!pendingRoots[i].isConnected) pendingRoots.splice(i, 1);
  for (const owner of failedDecryptOwners) {
    if (!owner.isConnected) releaseFailedOwner(owner);
    else if (!isOwnerVisible(owner)) releaseFailedOwner(owner, true);
  }
}

function releaseFailedOwner(owner: Element, allowResume = false): void {
  failedDecryptOwners.delete(owner);
  attemptedOwners.delete(owner);
  cooldownRetryAt.delete(owner);
  if (allowResume) resumeOwners.add(owner);
  const record = messageRecord(owner);
  const keys = failedCipherKeys.get(owner) ?? [];
  for (const block of messageCiphertexts(owner, record)) keys.push(decryptCacheKey(block));
  for (const key of new Set(keys)) {
    if (isCachedFailure(decryptCache.get(key))) deleteDecryptCache(key);
  }
  failedCipherKeys.delete(owner);
}

function processCooldownRetries(): void {
  if (!autoDecrypt) return;
  const now = Date.now();
  for (const node of document.querySelectorAll(MESSAGE_SELECTOR)) {
    const owner = canonicalOwner(node) ?? node;
    const dueAt = cooldownRetryAt.get(owner);
    if (dueAt === undefined || dueAt > now || !isOwnerVisible(owner)) continue;
    cooldownRetryAt.delete(owner);
    cooldownRetryUsed.add(owner);
    attemptedOwners.delete(owner);
    resumeOwners.add(owner);
    scanOwner(owner);
  }
}

function trackFailedOwner(owner: Element, ciphertexts?: string[]): void {
  if (!failedDecryptOwners.has(owner) && failedDecryptOwners.size >= 200) {
    const oldest = failedDecryptOwners.values().next().value;
    if (oldest) releaseFailedOwner(oldest);
  }
  failedDecryptOwners.add(owner);
  failedCipherKeys.set(owner, (ciphertexts ?? messageCiphertexts(owner, messageRecord(owner)))
    .map(decryptCacheKey));
}

function isOwnerVisible(owner: Element): boolean {
  if (!owner.isConnected || owner.getClientRects().length === 0) return false;
  const rect = owner.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  let top = Math.max(0, rect.top);
  let right = Math.min(width, rect.right);
  let bottom = Math.min(height, rect.bottom);
  let left = Math.max(0, rect.left);
  for (let parent = owner.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipX = style.overflowX !== 'visible' || parent.classList.contains('message-list');
    const clipY = style.overflowY !== 'visible' || parent.classList.contains('message-list');
    if (clipX || clipY) {
      const bounds = parent.getBoundingClientRect();
      if (clipX) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (clipY) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    if (right <= left || bottom <= top) return false;
  }
  return right > left && bottom > top;
}

function scanVisibleMessagesAfterScroll(): void {
  if (scrollScanScheduled) return;
  scrollScanScheduled = true;
  window.setTimeout(() => {
    scrollScanScheduled = false;
    pruneDisconnectedState();
    processCooldownRetries();
    if (!autoDecrypt) return;
    for (const node of document.querySelectorAll(MESSAGE_SELECTOR)) {
      const owner = canonicalOwner(node) ?? node;
      if (isOwnerVisible(owner)) scanOwner(owner);
    }
  }, 50);
}

function scanAll(): void {
  if (!autoDecrypt) return;
  for (const owner of document.querySelectorAll(MESSAGE_SELECTOR)) scanOwner(owner);
}

interface MessageSnapshot {
  key: string;
  body: string;
  msgId: string;
  ciphertexts: string[];
  forward: ForwardCardIdentity | null;
}

type MessageElement = Record<string, any>;
type NativeMessageRecord = { msgId?: unknown; elements?: unknown; peer?: any; peerUid?: unknown; chatType?: unknown; [key: string]: any };
type ResolvedMessageRecord = { msgId?: string; elements: MessageElement[]; peer?: { chatType: number; peerUid: string } };

function vueInstances(el: Element): any[] {
  const raw = (el as Element & { __VUE__?: unknown }).__VUE__;
  return raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function recordsFor(owner: Element): NativeMessageRecord[] {
  const roots = [owner, ...owner.querySelectorAll('.message-native')];
  const records: NativeMessageRecord[] = [];
  for (const root of roots) for (const instance of vueInstances(root)) {
    const props = instance?.props;
    const record = props?.msgRecord ?? props?.msg;
    if (record && typeof record === 'object' && !records.includes(record)) records.push(record);
  }
  return records;
}

function normalizeRecord(record: NativeMessageRecord): ResolvedMessageRecord {
  const peer = record.peer ?? record.msgPeer ?? record.parentMsgPeer ?? record;
  const peerUid = typeof peer?.peerUid === 'string' ? peer.peerUid : typeof peer?.uid === 'string' ? peer.uid : '';
  const chatType = Number(peer?.chatType);
  return {
    msgId: typeof record.msgId === 'string' ? record.msgId : undefined,
    elements: Array.isArray(record.elements) ? record.elements : [],
    ...(peerUid && (chatType === 1 || chatType === 2) ? { peer: { chatType, peerUid } } : {})
  };
}

function messageRecord(owner: Element): ResolvedMessageRecord | null {
  const records = recordsFor(owner).map(normalizeRecord);
  const msgId = records.find(record => record.msgId)?.msgId ?? numericDomMessageId(owner);
  const compatible = records.filter(record => !record.msgId || !msgId || record.msgId === msgId);
  const elements: MessageElement[] = [];
  const textElementOwner = new Map<string, number>();
  compatible.forEach((record, recordIndex) => {
    for (const element of record.elements) {
      const content = Number(element?.elementType) === 1 && typeof element?.textElement?.content === 'string'
        ? element.textElement.content as string : null;
      if (content !== null) {
        const previousOwner = textElementOwner.get(content);
        // Nested Vue records often expose the exact same type-1 text. Ignore only
        // cross-record copies; repeated identical blocks within one record remain ordered.
        if (previousOwner !== undefined && previousOwner !== recordIndex) continue;
        textElementOwner.set(content, recordIndex);
      }
      elements.push(element);
    }
  });
  const peer = compatible.find(record => record.peer)?.peer;
  return { ...(msgId ? { msgId } : {}), elements, ...(peer ? { peer } : {}) };
}

function numericDomMessageId(owner: Element): string | undefined {
  const id = owner.closest('.ml-item')?.id;
  return id && /^\d+$/.test(id) ? id : undefined;
}

function snapshotMessage(owner: Element): MessageSnapshot {
  const body = messageContent(owner)?.textContent ?? '';
  const record = messageRecord(owner);
  const msgId = record?.msgId ?? '';
  const ciphertexts = messageCiphertexts(owner, record);
  const forward = findForwardCardIdentity(owner, record);
  const forwardKey = forward ? `${forward.app}\u0000${forward.uniseq}\u0000${forward.resid ?? ''}` : '';
  return {
    body, msgId, ciphertexts, forward,
    key: `${msgId}\u0000${forwardKey}\u0000${ciphertexts.join('\u0000') || (forward ? '' : body)}`
  };
}

function snapshotStillCurrent(owner: Element, snapshot: MessageSnapshot): boolean {
  if (!owner.isConnected) return false;
  const record = messageRecord(owner);
  if ((record?.msgId ?? '') !== snapshot.msgId) return false;
  if (snapshot.forward) {
    const current = findForwardCardIdentity(owner, record);
    if (!current || current.app !== snapshot.forward.app || current.uniseq !== snapshot.forward.uniseq ||
        (current.resid ?? '') !== (snapshot.forward.resid ?? '')) return false;
  }
  if (snapshot.ciphertexts.length) {
    const current = messageCiphertexts(owner, record);
    return snapshot.ciphertexts.length === current.length && snapshot.ciphertexts.every((ciphertext, index) => ciphertext === current[index]);
  }
  if (snapshot.forward) return true;
  return (messageContent(owner)?.textContent ?? '') === snapshot.body;
}

/** Find complete blocks only within this owner's visible text or exact Vue msgRecord. */
function messageCiphertexts(owner: Element, record: ResolvedMessageRecord | null): string[] {
  const content = messageContent(owner);
  const leaves = content ? [...content.querySelectorAll('.text-element')].map(node => node.textContent ?? '') : [];
  const nativeText = (record?.elements ?? [])
    .filter(element => Number(element?.elementType) === 1 && typeof element?.textElement?.content === 'string')
    .map(element => element.textElement.content as string);
  const candidates = [
    content?.textContent ?? '',
    leaves.join(''),
    nativeText.join(''),
  ];
  let best: string[] = [];
  for (const candidate of candidates) {
    const body = candidate.trimStart();
    if (!body.startsWith(ARMOR_BEGIN)) continue;
    const blocks = collectCiphertexts(body);
    const remainder = body.replace(/-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/g, '');
    if (remainder.includes(ARMOR_BEGIN)) continue;
    if (blocks.length > best.length) best = blocks;
  }
  return best;
}

function messageContent(owner: Element): Element | null {
  const content = [...owner.querySelectorAll('.msg-content, .message-content')]
    .find(node => canonicalOwner(node) === owner);
  if (content) return content;
  return [...owner.querySelectorAll('.message-content__wrapper')]
    .find(node => canonicalOwner(node) === owner) ?? null;
}

function canonicalOwner(element: Element): Element | null {
  return element.closest('.message') ?? element.closest('.message-native');
}

function scanOwner(owner: Element): void {
  const epoch = accountEpoch;
  owner = canonicalOwner(owner) ?? owner;
  if (!autoDecrypt || !owner.matches(MESSAGE_SELECTOR)) return;
  if (!isOwnerVisible(owner)) return;
  if (!messageContent(owner)) return;
  const snapshot = snapshotMessage(owner);
  const completed = completedOwners.get(owner);
  if (completed && completed.plain.isConnected && completed.msgId === snapshot.msgId && completed.key === snapshot.key &&
      messageContent(owner)?.contains(completed.plain)) {
    insertDecryptedTail(owner, completed.plain, completed.signature);
    return;
  }
  if (attemptedOwners.get(owner) === snapshot.key) return;
  if (pendingRecordOwners.get(owner) === snapshot.key) return;

  const processRecord = (record: ResolvedMessageRecord | null): void => {
    if (epoch !== accountEpoch) return;
    if (!snapshotStillCurrent(owner, snapshot)) {
      retryOwnerAfterStaleSnapshot(owner, snapshot.key);
      return;
    }
    const forward = findForwardCardIdentity(owner, record);
    const blocks = forward ? [] : messageCiphertexts(owner, record);
    if (!blocks.length && !forward) return;
    attemptedOwners.set(owner, snapshot.key);
    const resume = resumeOwners.has(owner);
    resumeOwners.delete(owner);
    const task = blocks.length ? Promise.all(blocks.map(block => doDecrypt(block, resume)))
      : decryptForward(owner, forward!.resid ?? '', record, resume);
    void task.then(results => {
      if (epoch !== accountEpoch) return;
      if (!snapshotStillCurrent(owner, snapshot)) {
        retryOwnerAfterStaleSnapshot(owner, snapshot.key);
        return;
      }
      replaceNativeContent(owner, results, snapshot.msgId, record);
      failedDecryptOwners.delete(owner);
    }).catch(error => {
      if (!isOwnerVisible(owner)) {
        releaseFailedOwner(owner, owner.isConnected);
      } else if (isCooldownError(error) && !cooldownRetryUsed.has(owner)) {
        cooldownRetryAt.set(owner, Date.now() + DECRYPT_FAILURE_TTL_MS + 100);
      } else {
        trackFailedOwner(owner, snapshot.ciphertexts);
      }
      const details = describeElements(record?.elements ?? []);
      log(`消息解密失败 msgId=${snapshot.msgId || '未知'} elements=${details.types} arkBytes=${details.arkBytes} resid=${details.hasResid ? 'yes' : 'no'} error=${shortError(error)}`);
    });
  };
  // Keep ordinary armored text synchronous; only native forward candidates need IPC.
  if (needsNativeRecord(owner, snapshot)) {
    pendingRecordOwners.set(owner, snapshot.key);
    void resolveRecordForOwner(owner, snapshot).then(processRecord).catch(error => {
      log(`读取消息记录失败 msgId=${snapshot.msgId || '未知'} error=${shortError(error)}`);
    }).finally(() => {
      if (pendingRecordOwners.get(owner) === snapshot.key) pendingRecordOwners.delete(owner);
    });
  } else {
    processRecord(messageRecord(owner));
  }
}

function retryOwnerAfterStaleSnapshot(owner: Element, key: string): void {
  if (!owner.isConnected) return;
  if (attemptedOwners.get(owner) === key) attemptedOwners.delete(owner);
  if (!pendingRoots.includes(owner) && pendingRoots.length < 200) pendingRoots.push(owner);
  scheduleScan();
}

function isQueuedDecryptSkip(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\[PGP_DECRYPT_(?:SKIPPED|COOLDOWN)\]/.test(message);
}

function isCooldownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('[PGP_DECRYPT_COOLDOWN]');
}

function needsNativeRecord(owner: Element, snapshot: MessageSnapshot): boolean {
  const existing = messageRecord(owner);
  const body = snapshot.body.trim();
  const hasArk = existing?.elements.some(element => !!element?.arkElement) ?? false;
  const hasMultiForward = existing?.elements.some(element => typeof element?.multiForwardMsgElement?.resId === 'string') ?? false;
  const identity = hasArk ? findForwardCardIdentity(owner, existing) : null;
  if (hasMultiForward || identity?.resid) return false;
  return !!snapshot.msgId && (hasArk || hasMultiForward || /^(?:\[聊天记录\]|\[转发消息\]|\[暂不支持该消息类型[^\]]*\]|暂不支持该消息类型)/.test(body));
}

async function resolveRecordForOwner(owner: Element, snapshot: MessageSnapshot): Promise<ResolvedMessageRecord | null> {
  const existing = messageRecord(owner);
  // Avoid touching the native store for routine text/image messages. Ark cards,
  // native multi-forward elements, and QQ's rendered chat-record placeholder are candidates.
  if (!needsNativeRecord(owner, snapshot)) return existing;
  const peer = existing?.peer ?? getCurrentPeer();
  if (!peer || (peer.chatType !== 1 && peer.chatType !== 2) || !peer.peerUid) return existing;
  const api = window.QwQNTPgp as typeof window.QwQNTPgp & { getMessageRecord?: (peer: { chatType: number; peerUid: string }, msgId: string) => Promise<NativeMessageRecord | null> };
  if (!api.getMessageRecord) return existing;
  const record = await api.getMessageRecord({ chatType: peer.chatType, peerUid: peer.peerUid }, snapshot.msgId);
  if (!record || String(record.msgId ?? '') !== snapshot.msgId || !Array.isArray(record.elements)) return existing;
  const normalized = normalizeRecord(record);
  const details = describeElements(normalized.elements);
  log(`读取消息记录 msgId=${snapshot.msgId} elements=${details.types} arkBytes=${details.arkBytes} resid=${details.hasResid ? 'yes' : 'no'}`);
  return normalized;
}

function describeElements(elements: MessageElement[]): { types: string; arkBytes: number; hasResid: boolean } {
  let arkBytes = 0;
  let hasResid = false;
  const types = elements.map(element => {
    const type = element?.elementType ?? Object.keys(element ?? {}).find(key => /Element$/.test(key)) ?? 'unknown';
    const bytes = element?.arkElement?.bytesData;
    if (typeof bytes === 'string') arkBytes += bytes.length;
    if (typeof element?.multiForwardMsgElement?.resId === 'string' && element.multiForwardMsgElement.resId) hasResid = true;
    return String(type);
  });
  return { types: [...new Set(types)].join(',') || 'none', arkBytes, hasResid };
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\r\n]+/g, ' ').slice(0, 120);
}

async function decryptForward(owner: Element, resid: string, record: ResolvedMessageRecord | null, resume = false): Promise<DecryptResult[]> {
  const preview = inspectForwardPreview(owner, record);
  if (preview.length) {
    try {
      return await Promise.all(preview.map(block => doDecrypt(block, resume)));
    } catch (error) {
      // Never start a second hardware operation after a missing key or cancelled PIN request.
      if (/硬件|密钥|队列|口令|PIN|取消|超时/.test(String(error))) throw error;
      log('转发外显解密未成功，尝试读取完整正文');
    }
  }
  const effectiveResid = resid || findForwardCardIdentity(owner, record)?.resid || '';
  if (!effectiveResid) throw new Error('forward preview incomplete and no record ID is available');
  const ciphertexts = await fetchForwardBlocks(effectiveResid);
  return Promise.all(ciphertexts.map(block => doDecrypt(block, resume)));
}

/** Inspect rendered text and Ark news separately: QQ may truncate only the rendered preview. */
function inspectForwardPreview(owner: Element, record: ResolvedMessageRecord | null): string[] {
  const visible = messageContent(owner)?.textContent?.trimStart() ?? '';
  for (const element of record?.elements ?? []) {
    try {
      const card = JSON.parse(String(element.arkElement?.bytesData ?? ''));
      if (card.app !== 'com.tencent.multimsg') continue;
      const news: string[] = (Array.isArray(card.meta?.detail?.news) ? card.meta.detail.news : [])
        .map((entry: { text?: unknown }) => typeof entry.text === 'string' ? entry.text : '');
      const total = Number(card.extra?.tsum ?? (() => {
        try { return JSON.parse(card.extra).tsum; } catch { return 0; }
      })());
      const firstHeader = news[0]?.indexOf(ARMOR_BEGIN) ?? -1;
      const prefix = firstHeader >= 0 ? news[0].slice(0, firstHeader) : '';
      const text = news.map(line => prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line).join('').trimStart();
      const content = messageContent(owner) as HTMLElement | null;
      const clipped = content ? content.scrollHeight > content.clientHeight || content.scrollWidth > content.clientWidth : false;
      log(`转发外显检查：DOM=${visible.length}字符，news=${news.map(line => line.length).join(',')}字符，预览节点=${news.length}，总节点=${total || '未知'}，标准头=${visible.startsWith(ARMOR_BEGIN)}，DOM结尾=${visible.includes(ARMOR_END)}，news标准头=${text.startsWith(ARMOR_BEGIN)}，news结尾=${text.includes(ARMOR_END)}，布局裁切=${clipped}`);
      // Do not replace an entire mixed card based only on its first preview entry.
      const candidates = total === 1 ? [visible, ...(news.length === 1 ? [text] : [])]
        : total > 0 && total === news.length ? [text] : [];
      for (const candidate of candidates) {
        const blocks = collectCiphertexts(candidate);
        if (!candidate.startsWith(ARMOR_BEGIN) || !blocks.length || /…|\.\.\./.test(candidate)) continue;
        if (candidate.replace(/-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/g, '').trim()) continue;
        log(`转发外显完整：${candidate.length}字符，${blocks.length}个PGP块，先尝试外显解密`);
        return blocks;
      }
      log('转发外显不完整或无法确认完整性，改为拉取完整转发正文');
    } catch { /* Malformed or unrelated Ark elements cannot supply a complete preview. */ }
  }
  return [];
}

async function fetchForwardBlocks(resid: string): Promise<string[]> {
  const self = await getSelfInfo();
  if (!self?.uid) throw new Error('self uid unavailable');
  const messages = await window.QwQNTPgp.recvForward(self.uid, resid);
  const joined = messages.join('').trimStart();
  if (!joined.startsWith(ARMOR_BEGIN)) throw new Error('forwarded content does not start with a PGP message');
  const blocks = collectCiphertexts(joined);
  if (!blocks.length) throw new Error('no complete PGP message in forwarded content');
  if (joined.replace(/-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/g, '').trim()) {
    // Preserve mixed forwarding cards; their individual messages are handled in the viewer.
    throw new Error('mixed forwarded content must be decrypted per message in its viewer');
  }
  return blocks;
}

function replaceNativeContent(owner: Element, results: DecryptResult[], msgId: string, record: ResolvedMessageRecord | null): void {
  const content = messageContent(owner);
  if (!content) return;
  const plaintext = results.map(result => result.plaintext).join('\n');
  const isForwardCard = (record?.elements ?? []).some(element => element?.elementType === 16) ||
    ((record?.elements ?? []).some(element => element?.elementType === 10) && !!findForwardCardIdentity(owner, record));
  const plain = isForwardCard
    ? replaceForwardCardWithNativeText(owner, plaintext) ?? replaceNativeTextLeaf(content, plaintext, record)
    : replaceNativeTextLeaf(content, plaintext, record);
  if (!plain) return;
  const signature = aggregateSignature(results);
  insertDecryptedTail(owner, plain, signature);
  completedOwners.set(owner, { msgId, key: snapshotMessage(owner).key, plain, signature });
}

/** Replace only the encrypted text leaf, retaining QQ's own text bubble DOM. */
function replaceNativeTextLeaf(content: Element, plaintext: string, record: ResolvedMessageRecord | null): HTMLElement {
  const plain = createNativeTextElement(plaintext);
  let encrypted = [...content.querySelectorAll('.text-element')]
    .filter(element => collectCiphertexts(element.textContent ?? '').length > 0);
  if (!encrypted.length) {
    const nativeCiphertexts = messageCiphertexts(content.closest('.message') ?? content, record);
    if (nativeCiphertexts.length) {
      encrypted = [...content.querySelectorAll('.text-element')].filter(element => {
        const leafText = element.textContent ?? '';
        return leafText.length > 0 && nativeCiphertexts.some(ciphertext => ciphertext.includes(leafText));
      });
    }
  }
  if (encrypted.length) {
    encrypted[0].replaceWith(plain);
    for (const old of encrypted.slice(1)) old.remove();
  } else {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const armoredText: Text[] = [];
    while (walker.nextNode()) {
      if (collectCiphertexts(walker.currentNode.textContent ?? '').length) armoredText.push(walker.currentNode as Text);
    }
    for (const node of armoredText) node.remove();
    const slot = [...content.children].find(child => child.matches('.lt-slot'));
    content.insertBefore(plain, slot ?? null);
  }
  return plain;
}

/** Convert only a successful native forward/Ark card body to QQ's observed text structure. */
function replaceForwardCardWithNativeText(owner: Element, plaintext: string): HTMLElement | null {
  const messageContainer = owner.querySelector('.message-container');
  const wrapper = owner.querySelector('.message-content__wrapper');
  if (!messageContainer || !wrapper || canonicalOwner(wrapper) !== owner) return null;

  const slots = [...owner.querySelectorAll('.lt-slot')].filter(slot => canonicalOwner(slot) === owner);
  const statuses = new Set<HTMLElement>();
  for (const slot of slots) {
    const status = slot.closest('.content-status');
    if (status instanceof HTMLElement) statuses.add(status);
    slot.remove();
    slot.classList.remove('outside');
    slot.classList.add('embed');
  }

  // Keep the original QQ card DOM attached for component references, but move it
  // outside message-container so Ark/forward :has() selectors no longer style it.
  const archived = document.createElement('div');
  archived.className = 'qwqnt-pgp-archived-card';
  archived.hidden = true;
  archived.setAttribute('aria-hidden', 'true');
  while (wrapper.firstChild) archived.appendChild(wrapper.firstChild);
  owner.appendChild(archived);
  for (const status of statuses) {
    if (!status.querySelector('*') && !(status.textContent ?? '').trim()) status.remove();
  }

  const side = messageContainer.classList.contains('message-container--self') ? 'container--self' : 'container--others';
  const bubble = document.createElement('div');
  bubble.className = `msg-content-container ${side} mix-message__container`;
  const inner = document.createElement('div');
  inner.className = 'message-content mix-message__inner';
  const plain = createNativeTextElement(plaintext);
  inner.appendChild(plain);
  for (const slot of slots) inner.appendChild(slot);
  bubble.appendChild(inner);
  wrapper.replaceChildren(bubble);
  messageContainer.classList.add('message-container--mix-or-markdown');
  return plain;
}

function createNativeTextElement(plaintext: string): HTMLElement {
  const element = document.createElement('span');
  element.className = 'text-element';
  const normal = document.createElement('span');
  normal.className = 'text-normal';
  normal.textContent = plaintext;
  element.appendChild(normal);
  return element;
}

function aggregateSignature(results: DecryptResult[]): SignatureInfo {
  const rank = { good: 0, none: 1, nokey: 2, error: 3, bad: 4 };
  return results.reduce((worst, result) => rank[result.signature.status] > rank[worst.status]
    ? result.signature : worst, results[0].signature);
}

function insertDecryptedTail(owner: Element, plain: HTMLElement, signature: SignatureInfo): void {
  const status = signature.status;
  const title = {
    good: '签名验证通过', none: '无签名', bad: '签名验证失败',
    error: '签名校验出错', nokey: '缺少签名者公钥，无法验签'
  }[status];
  const create = (): HTMLSpanElement => {
    const tag = document.createElement('span');
    tag.className = 'qwqnt-pgp-signature-tail';
    tag.dataset.status = status;
    tag.textContent = '已解密';
    tag.title = title;
    tag.style.cssText = `font-size:12px;line-height:1.2;white-space:nowrap;user-select:none;margin-left:6px;color:${status === 'good' ? '#238636' : status === 'none' ? '#b77900' : '#d1242f'}`;
    return tag;
  };
  const slot = [...owner.querySelectorAll('.lt-slot')].find(element => canonicalOwner(element) === owner);
  const targets = slot ? [...slot.querySelectorAll('.lt-spacer, .lt-float')] : [];
  if (targets.length) {
    plain.querySelectorAll('.qwqnt-pgp-signature-tail').forEach(tag => tag.remove());
    for (const target of targets) {
      if (!target.querySelector('.qwqnt-pgp-signature-tail')) target.appendChild(create());
    }
  } else if (!plain.querySelector('.qwqnt-pgp-signature-tail')) {
    plain.appendChild(create());
  }
}

interface ForwardCardIdentity {
  app: string;
  uniseq: string;
  resid?: string;
}

/** Read Ark identity from Vue's actual msgRecord elements, including Set-backed instances. */
export function findForwardCardIdentity(el: Element, suppliedRecord?: ResolvedMessageRecord | null): ForwardCardIdentity | null {
  const readCard = (value: unknown): ForwardCardIdentity | null => {
    if (typeof value !== 'string') return null;
    try {
      const card = JSON.parse(value) as { app?: unknown; meta?: { detail?: Record<string, unknown> } };
      if (card.app !== 'com.tencent.multimsg') return null;
      const uniseq = card.meta?.detail?.['uniseq'];
      const resid = card.meta?.detail?.['resid'] ?? card.meta?.detail?.['resId'];
      if ((!uniseq || typeof uniseq !== 'string') && (!resid || typeof resid !== 'string')) return null;
      return { app: card.app, uniseq: typeof uniseq === 'string' ? uniseq : '', resid: typeof resid === 'string' ? resid : undefined };
    } catch {
      return null;
    }
  };
  const root = canonicalOwner(el);
  if (!root) return null;
  const record = suppliedRecord ?? messageRecord(root);
  for (const element of record?.elements ?? []) {
    const multi = element?.multiForwardMsgElement;
    if (typeof multi?.resId === 'string' && multi.resId) {
      const arkIdentity = readCard(element.arkElement?.bytesData);
      return { ...(arkIdentity ?? { app: 'com.tencent.multimsg', uniseq: '' }), resid: multi.resId };
    }
    const identity = readCard(element.arkElement?.bytesData);
    if (identity) return identity;
  }
  return null;
}

/** Find all complete, independent PGP MESSAGE armor blocks in the supplied text. */
export function collectCiphertexts(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const begin = text.indexOf(ARMOR_BEGIN, from);
    if (begin < 0) break;
    const end = text.indexOf(ARMOR_END, begin + ARMOR_BEGIN.length);
    if (end < 0) break;
    out.push(text.slice(begin, end + ARMOR_END.length));
    from = end + ARMOR_END.length;
  }
  return out;
}

/** Legacy helper: returns the blocks joined by a newline. Decryption uses collectCiphertexts(). */
export function collectCiphertext(text: string): string | null {
  const blocks = collectCiphertexts(text);
  return blocks.length ? blocks.join('\n') : null;
}

/** Whether this exact message has a standards-shaped armor header the user can retry. */
export function canManuallyDecrypt(element: Element): boolean {
  const owner = canonicalOwner(element) ?? element;
  if (!owner.matches(MESSAGE_SELECTOR)) return false;
  const current = snapshotMessage(owner);
  const completed = completedOwners.get(owner);
  if (completed && completed.msgId === current.msgId && completed.key === current.key &&
      completed.plain.isConnected && messageContent(owner)?.contains(completed.plain)) return false;
  const record = messageRecord(owner);
  if (messageCiphertexts(owner, record).length) return true;
  const body = messageContent(owner)?.textContent?.trimStart() ?? '';
  if (body.startsWith(ARMOR_BEGIN)) return true;
  if (record?.elements.some(item => Number(item?.elementType) === 1 &&
    typeof item?.textElement?.content === 'string' && item.textElement.content.trimStart().startsWith(ARMOR_BEGIN))) return true;
  if (findForwardCardIdentity(owner, record)?.resid) return true;
  const snapshot = snapshotMessage(owner);
  return needsNativeRecord(owner, snapshot) || forwardPreviewHasArmorHeader(record);
}

function forwardPreviewHasArmorHeader(record: ResolvedMessageRecord | null): boolean {
  for (const item of record?.elements ?? []) {
    try {
      const card = JSON.parse(String(item?.arkElement?.bytesData ?? ''));
      if (card?.app !== 'com.tencent.multimsg') continue;
      const first = card?.meta?.detail?.news?.[0]?.text;
      if (typeof first !== 'string') continue;
      const start = first.indexOf(ARMOR_BEGIN);
      if (start < 0) continue;
      const prefix = first.slice(0, start);
      if (prefix.length === 0 || /^[^:\r\n]{1,48}: ?$/.test(prefix)) return true;
    } catch { /* Ignore malformed/unrelated Ark. */ }
  }
  return false;
}

/** Explicit user retry. Errors reject to the caller; this function never opens UI. */
export function manualDecrypt(element: Element): Promise<void> {
  const epoch = accountEpoch;
  const owner = canonicalOwner(element) ?? element;
  const snapshot = snapshotMessage(owner);
  const completed = completedOwners.get(owner);
  if (completed && completed.msgId === snapshot.msgId && completed.key === snapshot.key &&
      completed.plain.isConnected && messageContent(owner)?.contains(completed.plain)) return Promise.resolve();
  const active = manualTasks.get(owner);
  if (active?.key === snapshot.key) return active.promise;
  const promise = (async () => {
    const visibleRecord = messageRecord(owner);
    const visibleForward = findForwardCardIdentity(owner, visibleRecord);
    const headerCandidate = canManuallyDecrypt(owner);
    if (!headerCandidate && !visibleForward && !needsNativeRecord(owner, snapshot)) {
      throw new Error('此消息没有可识别的 PGP 密文');
    }
    const record = await resolveRecordForOwner(owner, snapshot);
    if (epoch !== accountEpoch) throw new Error('账号已切换，解密请求已取消');
    if (!snapshotStillCurrent(owner, snapshot)) throw new Error('消息内容已变化，请重新选择');
    const forward = findForwardCardIdentity(owner, record);
    const blocks = forward ? [] : messageCiphertexts(owner, record);
    if (!forward && !blocks.length) throw new Error('密文不完整，无法解密');
    attemptedOwners.set(owner, snapshot.key);
    for (const block of blocks) {
      const key = decryptCacheKey(block);
      if (isCachedFailure(decryptCache.get(key))) deleteDecryptCache(key);
    }
    const results = forward ? await decryptForward(owner, forward.resid ?? '', record, true)
      : await Promise.all(blocks.map(block => doDecrypt(block, true)));
    if (epoch !== accountEpoch) throw new Error('账号已切换，解密结果已丢弃');
    if (!snapshotStillCurrent(owner, snapshot)) throw new Error('消息内容已变化，解密结果未应用');
    replaceNativeContent(owner, results, snapshot.msgId, record);
    failedDecryptOwners.delete(owner);
  })().catch(error => {
    if (epoch !== accountEpoch) throw error;
    if (owner.isConnected && isOwnerVisible(owner)) trackFailedOwner(owner, snapshot.ciphertexts);
    else releaseFailedOwner(owner, owner.isConnected);
    throw error;
  }).finally(() => {
    if (manualTasks.get(owner)?.promise === promise) manualTasks.delete(owner);
  });
  manualTasks.set(owner, { key: snapshot.key, promise });
  return promise;
}

function isCachedFailure(value: CacheValue | undefined): value is CachedFailure {
  return !!value && !(value instanceof Promise) && !('plaintext' in value) && 'error' in value;
}

function cacheEntryBytes(key: string, value: CacheValue): number {
  const keyBytes = key.length * 2;
  if (value instanceof Promise) return keyBytes;
  if (isCachedFailure(value)) return keyBytes + value.error.message.length * 2;
  return keyBytes + value.plaintext.length * 2 + (value.signature.signer?.length ?? 0) * 2 +
    (value.signature.keyID?.length ?? 0) * 2 + (value.signature.fingerprint?.length ?? 0) * 2;
}

function deleteDecryptCache(key: string): void {
  const old = decryptCache.get(key);
  if (old !== undefined) decryptCacheBytes -= cacheEntryBytes(key, old);
  decryptCache.delete(key);
}

function setDecryptCache(key: string, value: CacheValue): boolean {
  deleteDecryptCache(key);
  const bytes = cacheEntryBytes(key, value);
  if (bytes > DECRYPT_CACHE_MAX_BYTES) return false;
  decryptCache.set(key, value);
  decryptCacheBytes += bytes;
  while (decryptCache.size > DECRYPT_CACHE_MAX || decryptCacheBytes > DECRYPT_CACHE_MAX_BYTES) {
    const oldest = decryptCache.keys().next().value;
    if (oldest === undefined) break;
    deleteDecryptCache(oldest);
  }
  return decryptCache.get(key) === value;
}

function doDecrypt(ciphertext: string, resume: boolean): Promise<DecryptResult> {
  const epoch = accountEpoch;
  const cacheKey = decryptCacheKey(ciphertext);
  const cached = decryptCache.get(cacheKey);
  if (cached instanceof Promise) return cached;
  if (isCachedFailure(cached)) {
    if (!resume && cached.expiresAt > Date.now()) return Promise.reject(cached.error);
    deleteDecryptCache(cacheKey);
  }
  if (cached && !isCachedFailure(cached)) return Promise.resolve(cached);

  const pending = window.QwQNTPgp.decrypt(ciphertext, resume).then(result => {
    if (epoch !== accountEpoch) throw new Error('账号已切换，丢弃旧解密结果');
    if (decryptCache.get(cacheKey) === pending) setDecryptCache(cacheKey, result);
    return result;
  }).catch((error: unknown) => {
    if (epoch !== accountEpoch) throw error;
    const failure = error instanceof Error ? error : new Error(String(error));
    if (decryptCache.get(cacheKey) === pending) {
      if (isQueuedDecryptSkip(failure)) deleteDecryptCache(cacheKey);
      else setDecryptCache(cacheKey, { error: failure, expiresAt: Date.now() + DECRYPT_FAILURE_TTL_MS });
    }
    throw failure;
  });
  setDecryptCache(cacheKey, pending);
  return pending;
}

function decryptCacheKey(ciphertext: string): string {
  return `${getActiveAccountId() ?? ''}\u0000${preferredOwnKeyID}\u0000${ciphertext}`;
}

/** Explicitly rescans messages, respecting autoDecrypt setting. */
export function rescan(): void {
  // This is an explicit user action; permit failed connected owners to retry.
  pruneDisconnectedState();
  for (const owner of failedDecryptOwners) attemptedOwners.delete(owner);
  failedDecryptOwners.clear();
  for (const [key, value] of decryptCache) if (isCachedFailure(value)) deleteDecryptCache(key);
  scanAll();
}
