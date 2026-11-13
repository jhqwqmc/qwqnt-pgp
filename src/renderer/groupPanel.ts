/**
 * 群聊详情面板注入：在群成员卡片和群公告之间插入默认展开的 PGP 成员列表。
 * 仅列出已配置公钥的群友；开关决定发送时是否给这个人加密（自己永远加密）。
 */
import { log } from './log';
import { getCurrentPeer, getCurAio, getUinByUid, resolvePeerUin, setUidUin } from './store';
import { getActiveAccountId, getGroupConfig, getKeyBindings, loadAccountContext, prepareGroupConfig, prepareDmConfig, setGroupTarget } from './config-cache';
import { getDmConfig, getKeyBinding, setDmConfig } from './config-cache';

const PANEL_ID = 'qwqnt-pgp-group-panel';
const STYLE_ID = 'qwqnt-pgp-group-style';
const GROUP_MEMBERS_TTL_MS = 60_000;
const GROUP_MEMBERS_FAILURE_TTL_MS = 10_000;
const GROUP_MEMBERS_CACHE_MAX_ENTRIES = 8;

interface Member {
  uin: string;
  uid: string;
  name: string;
}

interface GroupPanelState {
  groupId: string;
  version: number;
  loading: boolean;
  error: string;
  rawMembers: Member[];
  members: Member[];
  selected: Set<string>;
  bindings: Map<string, string>;
  selfUin: string;
  selfUid: string;
  bindingSignature: string;
  search: string;
  revision: number;
}

let started = false;
let rendererAccountEpoch = 0;
let openChatKey = '';
let openChatEpoch = 0;
let preparedOpenChatEpoch = -1;
let preparingOpenChatEpoch = -1;
const panelStates = new WeakMap<HTMLElement, GroupPanelState>();
const groupMembersCache = new Map<string, { promise: Promise<Member[]>; expiresAt: number; settled: boolean }>();
const targetSaveQueues = new Map<string, Promise<void>>();
const unresolvedGroupIds = new Map<string, number>();
const resolvingGroupIds = new Set<string>();

export function startGroupPanel(): void {
  if (started) return;
  started = true;
  let discoveryQueued = false;
  const scheduleCheck = (): void => {
    if (discoveryQueued) return;
    discoveryQueued = true;
    window.setTimeout(() => {
      discoveryQueued = false;
      try { check(); } catch { /* ignore transient QQ DOM changes */ }
    }, 30);
  };
  const observer = new MutationObserver(mutations => {
    if (mutations.some(isGroupPanelMutation)) scheduleCheck();
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true
  });
  window.addEventListener('vue:component-mount', scheduleCheck);
  window.addEventListener('qwqnt-pgp:data-changed', event => refreshVisibleData(event as CustomEvent));
  window.addEventListener('qwqnt-pgp:account-changed', () => {
    rendererAccountEpoch++;
    openChatKey = '';
    openChatEpoch++;
    preparedOpenChatEpoch = -1;
    preparingOpenChatEpoch = -1;
    groupMembersCache.clear();
    unresolvedGroupIds.clear(); resolvingGroupIds.clear();
    for (const panel of document.querySelectorAll<HTMLElement>(`#${PANEL_ID}`)) {
      const state = panelStates.get(panel);
      if (state) state.version++;
      panel.remove();
    }
    dmRenderVersion++;
    document.getElementById(DM_ID)?.remove();
    scheduleCheck();
  });
  // Mount now, then rely on relevant DOM mutations and Vue mount events for
  // QQ-created detail anchors. Avoid recurring whole-document discovery scans.
  void loadAccountContext().then(() => { try { check(); } catch { /* ignore until QQ has mounted */ } });
}

function isGroupPanelMutation(mutation: MutationRecord): boolean {
  const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  if (target?.closest(`#${PANEL_ID}`)) return false;
  if (target?.closest('.more-panel')) return true;
  if (target?.closest('.aio .header, .aio-header, .chat-header, .header-container, header')) return true;
  for (const node of mutation.addedNodes) {
    if (!(node instanceof Element)) continue;
    if (node.matches('.more-panel, .aio-header, .chat-header, .header-container, header, .aio .header')
      || node.querySelector('.more-panel, .aio .header, .aio-header, .chat-header, .header-container, header')) return true;
  }
  return false;
}

async function prepareCurrentOpenChat(peer = getCurrentPeer()): Promise<void> {
  const accountId = getActiveAccountId();
  if (!accountId || !peer?.peerUid) {
    if (openChatKey) {
      openChatKey = '';
      openChatEpoch++;
      preparedOpenChatEpoch = -1;
      preparingOpenChatEpoch = -1;
    }
    return;
  }
  const key = `${accountId}:${peer.chatType}:${peer.peerUid}`;
  if (key !== openChatKey) {
    openChatKey = key;
    openChatEpoch++;
    preparedOpenChatEpoch = -1;
    preparingOpenChatEpoch = -1;
  }
  const epoch = openChatEpoch;
  const accountEpoch = rendererAccountEpoch;
  if (preparedOpenChatEpoch === epoch || preparingOpenChatEpoch === epoch) return;
  preparingOpenChatEpoch = epoch;
  try {
    const uin = getUinByUid(peer.peerUid) || (isNumericUin(peer.peerUid) ? peer.peerUid : await resolvePeerUin(peer.peerUid));
    if (!isNumericUin(uin) || epoch !== openChatEpoch || key !== openChatKey
      || !isCurrentAccount(accountId, accountEpoch)
      || getCurrentPeer()?.chatType !== peer.chatType || getCurrentPeer()?.peerUid !== peer.peerUid) return;
    // Mark before invoking the RPC: repeated DOM mutations during the request
    // must not schedule a second cleanup for this open epoch.
    preparedOpenChatEpoch = epoch;
    if (peer.chatType === 2) await prepareGroupConfig(uin);
    else await prepareDmConfig(uin);
    if (epoch !== openChatEpoch || key !== openChatKey || !isCurrentAccount(accountId, accountEpoch)) return;
  } catch (err) {
    log(`打开会话时校验 PGP 配置失败：${String(err)}`);
  } finally {
    if (preparingOpenChatEpoch === epoch) preparingOpenChatEpoch = -1;
  }
}

function check(): void {
  const peer = getCurrentPeer();
  void prepareCurrentOpenChat(peer);
  let groupId = peer?.chatType === 2 ? (getUinByUid(peer.peerUid) || (isNumericUin(peer.peerUid) ? peer.peerUid : '')) : '';
  if (peer?.chatType === 2 && !groupId) {
    const uid = peer.peerUid;
    if ((unresolvedGroupIds.get(uid) ?? 0) <= Date.now() && !resolvingGroupIds.has(uid)) {
      resolvingGroupIds.add(uid);
      void resolvePeerUin(uid).then(uin => {
        unresolvedGroupIds.delete(uid);
        if (isNumericUin(uin) && getCurrentPeer()?.peerUid === uid) check();
      }).catch(() => unresolvedGroupIds.set(uid, Date.now() + 10_000)).finally(() => resolvingGroupIds.delete(uid));
    }
  }
  if (groupId) void prefetchGroupMembers(groupId);
  const anchors = findGroupAnchors();
  if (!anchors) {
    document.getElementById(PANEL_ID)?.remove();
    return;
  }
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    const inPosition = existing.parentElement === anchors.host
      && !!(anchors.card.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !!(existing.compareDocumentPosition(anchors.notice) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!inPosition) {
      anchors.host.insertBefore(existing, anchors.notice);
    }
    const state = panelStates.get(existing);
    if (groupId && state?.groupId !== groupId) switchGroup(existing, groupId);
    return;
  }
  const panel = createPanel();
  anchors.host.insertBefore(panel, anchors.notice);
  initializePanel(panel, groupId);
  log('群详情面板：已在成员卡片与群公告之间注入 PGP 列表');
}

interface GroupAnchors {
  host: HTMLElement;
  card: HTMLElement;
  notice: HTMLElement;
}

function findGroupAnchors(): GroupAnchors | null {
  const sides = Array.from(document.querySelectorAll<HTMLElement>('.more-panel .side-panel'));
  const visibleSides = sides.filter(side => side.offsetParent !== null);
  for (const side of visibleSides.length ? visibleSides : sides) {
    const card = side.querySelector<HTMLElement>('.group-member-card');
    const notice = side.querySelector<HTMLElement>('.group-field.field--notice');
    const host = card?.parentElement;
    if (!card || !notice || !host || host !== notice.parentElement) continue;
    if (!(card.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    return { host, card, notice };
  }
  return null;
}

function isNumericUin(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function isCurrentAccount(accountId: string | null, epoch: number): boolean {
  return !!accountId && getActiveAccountId() === accountId && rendererAccountEpoch === epoch;
}

function numericUins(values: string[]): string[] {
  return [...new Set(values.filter(isNumericUin))];
}

function looksLikeUid(value: string): boolean {
  return /^u_[\w-]+$/i.test(value);
}

function createPanel(): HTMLElement {
  injectGroupStyle();
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'qwqnt-pgp-group-card';
  panel.innerHTML = `
      <div class="qwqnt-pgp-group-head">
        <span>加密成员</span>
        <button class="qwqnt-pgp-group-refresh" type="button" aria-label="刷新成员" title="刷新成员">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 4v5h-5M4 20v-5h5"/><path d="M5.4 9a7 7 0 0 1 11.5-3.3L20 9M4 15l3.1 3.3A7 7 0 0 0 18.6 15"/></svg>
        </button>
      </div>
      <div class="qwqnt-pgp-group-content">
        <div class="qwqnt-pgp-group-tools">
          <input class="qwqnt-pgp-group-search" type="search" placeholder="搜索成员、QQ 号或密钥" aria-label="搜索群成员">
        </div>
        <div class="qwqnt-pgp-group-status" aria-live="polite"></div>
        <div class="qwqnt-pgp-group-list" role="list"></div>
      </div>
  `;
  panel.querySelector<HTMLButtonElement>('.qwqnt-pgp-group-refresh')!.addEventListener('click', () => void loadGroup(panel, true));
  panel.querySelector<HTMLInputElement>('.qwqnt-pgp-group-search')!.addEventListener('input', e => {
    const state = panelStates.get(panel);
    if (!state) return;
    state.search = (e.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
    renderRows(panel);
  });
  return panel;
}

function injectGroupStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .qwqnt-pgp-group-card { box-sizing:border-box; min-width:0; margin:8px 0; padding:0 16px 8px; border-radius:8px; background:var(--fill_light_primary,var(--bg_top_standard,Canvas)); color:var(--text_primary,inherit); }
    .qwqnt-pgp-group-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 0; font-size:14px; }
    .qwqnt-pgp-group-content { min-width:0; }
    .qwqnt-pgp-group-tools { display:flex; align-items:center; gap:8px; min-width:0; margin-bottom:6px; }
    .qwqnt-pgp-group-search { flex:1; width:0; min-width:0; box-sizing:border-box; padding:5px 8px; border:1px solid var(--border_level_2,rgba(127,127,127,.24)); border-radius:4px; background:rgba(127,127,127,.10); color:inherit; font-size:12px; }
    .qwqnt-pgp-group-search:focus { outline:2px solid var(--brand_standard,#0099ff); outline-offset:-2px; }
    .qwqnt-pgp-group-refresh { display:grid; place-items:center; width:24px; height:24px; padding:0; border:0; border-radius:4px; background:transparent; color:var(--text_secondary,inherit); cursor:pointer; }
    .qwqnt-pgp-group-refresh:hover:not(:disabled) { background:var(--overlay_active,rgba(127,127,127,.1)); }
    .qwqnt-pgp-group-refresh:disabled { cursor:default; }
    .qwqnt-pgp-group-refresh[aria-busy=true] svg { animation:qwqnt-pgp-refresh-spin .75s linear infinite; }
    @keyframes qwqnt-pgp-refresh-spin { to { transform:rotate(360deg); } }
    .qwqnt-pgp-group-status { min-height:18px; margin:4px 0; font-size:12px; opacity:.72; overflow-wrap:anywhere; }
    .qwqnt-pgp-group-status:empty { display:none; }
    .qwqnt-pgp-group-list { box-sizing:border-box; width:100%; min-width:0; max-height:min(38vh,180px); overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; }
    .qwqnt-pgp-member { box-sizing:border-box; display:flex; align-items:center; gap:8px; height:36px; min-width:0; padding:0 2px; border-top:1px solid var(--border_level_1,rgba(127,127,127,.12)); font-size:12px; }
    .qwqnt-pgp-member:first-child { border-top:0; }
    .qwqnt-pgp-member-name { flex:1; min-width:0; display:flex; align-items:center; gap:4px; overflow:hidden; white-space:nowrap; }
    .qwqnt-pgp-member-nick { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .qwqnt-pgp-member-uin { flex:none; align-self:center; text-align:right; white-space:nowrap; font-size:11px; font-variant-numeric:tabular-nums; color:var(--text_secondary,inherit); }
    /* Keep QQ's q-switch geometry and handle styling; only reserve its row space. */
    .qwqnt-pgp-member-switch { flex:none; }
    .qwqnt-pgp-member-switch[aria-disabled=true] { opacity:.5; cursor:not-allowed; }
    #${DM_ID} { position:relative; }
    #${DM_ID}:not(:last-child)::after { content:''; position:absolute; inset-inline:16px; bottom:0; border-bottom:1px solid var(--border_level_1,rgba(127,127,127,.14)); pointer-events:none; }
  `;
  document.head.append(style);
}

function initializePanel(panel: HTMLElement, groupId: string): void {
  const state: GroupPanelState = {
    groupId, version: 0, loading: false, error: '',
    rawMembers: [], members: [], selected: new Set(), bindings: new Map(), selfUin: '', selfUid: '', bindingSignature: '', search: '', revision: 0
  };
  panelStates.set(panel, state);
  panel.dataset['groupId'] = groupId;
  renderPanel(panel);
  if (groupId) void loadGroup(panel);
}

function switchGroup(panel: HTMLElement, groupId: string): void {
  const state = panelStates.get(panel);
  if (!state || state.groupId === groupId) return;
  state.groupId = groupId;
  state.version++;
  state.loading = false;
  state.error = '';
  state.rawMembers = [];
  state.members = [];
  state.selected.clear();
  state.bindings.clear();
  state.bindingSignature = '';
  state.search = '';
  panel.dataset['groupId'] = groupId;
  const search = panel.querySelector<HTMLInputElement>('.qwqnt-pgp-group-search');
  if (search) search.value = '';
  renderPanel(panel);
  void loadGroup(panel);
}

function validBindings(bindings: Array<{ uin: string; keyID: string }>): Array<{ uin: string; keyID: string }> {
  return bindings.filter(binding =>
    isNumericUin(binding.uin) && typeof binding.keyID === 'string' && binding.keyID.trim()
  ).map(binding => ({ uin: binding.uin, keyID: binding.keyID.trim() }));
}

function bindingSignature(bindings: Array<{ uin: string; keyID: string }>): string {
  return validBindings(bindings).map(binding => `${binding.uin}:${binding.keyID}`).sort().join('|');
}

function refreshVisibleData(event: CustomEvent): void {
  const changed = event.detail as { accountId?: string; kind?: string; id?: string } | undefined;
  if (!changed || changed.accountId !== getActiveAccountId()) return;
  const panel = document.getElementById(PANEL_ID);
  const state = panel ? panelStates.get(panel) : undefined;
  if (changed.kind === 'binding') {
    return;
  }
  if (!panel || !state) return;
  if (changed.kind === 'group' && changed.id === state.groupId) {
    state.version++;
    state.loading = false;
    void loadGroup(panel);
  }
}

function renderPanel(panel: HTMLElement): void {
  const state = panelStates.get(panel);
  if (!state) return;
  renderSummary(panel, state);
  renderRows(panel);
}

function renderSummary(panel: HTMLElement, state: GroupPanelState): void {
  panel.querySelector<HTMLElement>('.qwqnt-pgp-group-status')!.textContent = state.loading ? '' : state.error || (state.groupId ? '' : '当前群聊信息不可用');
  const refresh = panel.querySelector<HTMLButtonElement>('.qwqnt-pgp-group-refresh')!;
  refresh.disabled = state.loading || !state.groupId;
  refresh.setAttribute('aria-busy', String(state.loading));
}

function renderRows(panel: HTMLElement): void {
  const state = panelStates.get(panel);
  const list = panel.querySelector<HTMLElement>('.qwqnt-pgp-group-list');
  if (!state || !list) return;
  list.replaceChildren();
  const query = state.search;
  const filtered = state.members.filter(member => {
    const key = bindingFor(state, member);
    return !query || `${member.name} ${member.uin} ${key}`.toLocaleLowerCase().includes(query);
  });
  if (state.loading && !state.members.length) {
    return;
  }
  if (!state.loading && !state.error && state.members.length && !filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'qwqnt-pgp-group-status';
    empty.textContent = '没有匹配的成员';
    list.append(empty);
    return;
  }
  if (!state.loading && !state.error && state.groupId && !state.members.length) {
    const empty = document.createElement('div');
    empty.className = 'qwqnt-pgp-group-status';
    empty.textContent = '群内暂无已绑定公钥的成员';
    list.append(empty);
    return;
  }
  for (const member of filtered) {
    const id = member.uin;
    const keyID = bindingFor(state, member);
    const self = isSelf(state, member);
    const selected = self || state.selected.has(id);
    const row = document.createElement('div');
    row.className = `qwqnt-pgp-member${self ? ' is-self' : ''}`;
    row.title = `${member.name} (${id})${keyID ? ` · ${keyID}` : ''}`;
    const name = document.createElement('span');
    name.className = 'qwqnt-pgp-member-name';
    const nick = document.createElement('span');
    nick.className = 'qwqnt-pgp-member-nick';
    nick.textContent = member.name;
    const uin = document.createElement('span');
    uin.className = 'qwqnt-pgp-member-uin';
    uin.textContent = id;
    name.append(nick);
    const sw = document.createElement('div');
    sw.className = 'q-switch vue-component qwqnt-pgp-member-switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(selected));
    sw.setAttribute('aria-disabled', String(self));
    sw.setAttribute('aria-label', self ? `${member.name}（本人，始终加密）` : `${selected ? '关闭' : '开启'} ${member.name} 的 PGP 加密`);
    sw.tabIndex = self ? -1 : 0;
    const handle = document.createElement('span');
    handle.className = 'q-switch__handle';
    sw.append(handle);
    sw.classList.toggle('is-active', selected);
    const toggle = (): void => {
      if (!isNumericUin(id) || self) return;
      const next = !state.selected.has(id);
      if (next) state.selected.add(id);
      else state.selected.delete(id);
      state.revision++;
      state.error = '';
      sw.setAttribute('aria-checked', String(next));
      sw.setAttribute('aria-label', `${next ? '关闭' : '开启'} ${member.name} 的 PGP 加密`);
      sw.classList.toggle('is-active', next);
      renderSummary(panel, state);
      void persistTarget(panel, state.groupId, id, next, state.revision, getActiveAccountId() ?? '');
    };
    sw.addEventListener('click', event => {
      event.preventDefault();
      toggle();
    });
    sw.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    row.append(name, uin, sw);
    list.append(row);
  }
}

function bindingFor(state: GroupPanelState, member: Member): string {
  return state.bindings.get(member.uin) ?? '';
}

function isSelf(state: GroupPanelState, member: Member): boolean {
  return (isNumericUin(state.selfUin) && member.uin === state.selfUin)
    || (!!state.selfUid && !!member.uid && member.uid === state.selfUid);
}

function prefetchGroupMembers(groupId: string, force = false, accountId = getActiveAccountId()): Promise<Member[]> {
  if (!accountId) return Promise.resolve([]);
  const cacheKey = `${accountId}:${groupId}`;
  const now = Date.now();
  pruneGroupMembersCache(now);
  const existing = groupMembersCache.get(cacheKey);
  // Never discard a pending request: force only bypasses completed cache data.
  if (existing && !existing.settled) return existing.promise;
  if (!force && existing && existing.expiresAt > now) {
    groupMembersCache.delete(cacheKey);
    groupMembersCache.set(cacheKey, existing);
    return existing.promise;
  }
  groupMembersCache.delete(cacheKey);
  const entry: { promise: Promise<Member[]>; expiresAt: number; settled: boolean } = {
    promise: Promise.resolve().then(() => window.QwQNTPgp.getGroupMembers(groupId)),
    expiresAt: 0,
    settled: false
  };
  groupMembersCache.set(cacheKey, entry);
  pruneGroupMembersCache(now);
  void entry.promise.then(
    () => {
      entry.settled = true;
      entry.expiresAt = Date.now() + GROUP_MEMBERS_TTL_MS;
      pruneGroupMembersCache(Date.now());
    },
    err => {
      entry.settled = true;
      entry.expiresAt = Date.now() + GROUP_MEMBERS_FAILURE_TTL_MS;
      pruneGroupMembersCache(Date.now());
      log(`预加载群 ${groupId} 成员失败：${String(err)}`);
    }
  );
  return entry.promise;
}

function pruneGroupMembersCache(now: number): void {
  for (const [groupId, entry] of groupMembersCache) {
    if (entry.settled && entry.expiresAt <= now) groupMembersCache.delete(groupId);
  }
  while (groupMembersCache.size > GROUP_MEMBERS_CACHE_MAX_ENTRIES) {
    let removed = false;
    for (const [groupId, entry] of groupMembersCache) {
      if (entry.settled) {
        groupMembersCache.delete(groupId);
        removed = true;
        break;
      }
    }
    // In-flight entries are never evicted; they are pruned when they settle.
    if (!removed) break;
  }
}

async function loadGroup(panel: HTMLElement, force = false): Promise<void> {
  const accountId = getActiveAccountId();
  const accountEpoch = rendererAccountEpoch;
  if (!accountId) return;
  const state = panelStates.get(panel);
  if (!state || !state.groupId || state.loading) return;
  const groupId = state.groupId;
  const version = ++state.version;
  state.loading = true;
  state.error = '';
  renderPanel(panel);
  try {
    const [rawList, self, groupConfig] = await Promise.all([
      prefetchGroupMembers(groupId, force, accountId), window.QwQNTPgp.selfInfo().catch(() => null), getGroupConfig(groupId)
    ]);
    if (!isCurrentAccount(accountId, accountEpoch) || version !== state.version || state.groupId !== groupId || !panel.isConnected) return;
    state.selfUin = self?.uin && isNumericUin(self.uin) ? self.uin : '';
    state.selfUid = self?.uid ?? '';
    const normalized: Member[] = new Array(rawList.length);
    for (let index = 0; index < rawList.length; index++) {
      const raw = rawList[index]!;
      const uin = isNumericUin(raw.uin) ? raw.uin : raw.uid && raw.uid === state.selfUid ? state.selfUin : '';
      if (uin && state.selfUid && raw.uid === state.selfUid) state.selfUin = uin;
      if (uin && raw.uid) setUidUin(raw.uid, uin);
      const rawName = raw.name?.trim() ?? '';
      const safeName = rawName && rawName !== raw.uid && !looksLikeUid(rawName) ? rawName : uin;
      normalized[index] = { uin, uid: raw.uid, name: safeName };
    }
    if (isNumericUin(state.selfUin) && !normalized.some(member => isSelf(state, member))) {
      normalized.push({ uin: state.selfUin, uid: state.selfUid, name: self?.nick?.trim() || '我' });
    }
    if (!isCurrentAccount(accountId, accountEpoch) || version !== state.version || state.groupId !== groupId || !panel.isConnected) return;
    const bindings = await getKeyBindings(normalized.map(member => member.uin).filter(isNumericUin));
    if (!isCurrentAccount(accountId, accountEpoch) || version !== state.version || state.groupId !== groupId || !panel.isConnected) return;
    state.bindings.clear();
    for (const binding of validBindings(bindings)) state.bindings.set(binding.uin, binding.keyID);
    state.bindingSignature = bindingSignature(bindings);
    state.rawMembers = normalized;
    state.members = normalized.filter(member => isNumericUin(member.uin) && (isSelf(state, member) || state.bindings.has(member.uin)));
    const knownMemberUins = new Set(normalized.map(member => member.uin).filter(isNumericUin));
    const storedTargets = numericUins(groupConfig.targets ?? []);
    const allowedTargets = new Set(state.members.map(member => member.uin));
    const completeRoster = rawList.length > 0 && normalized.every(member => isNumericUin(member.uin));
    state.selected = new Set(storedTargets.filter(id => allowedTargets.has(id)));
    if (isNumericUin(state.selfUin)) state.selected.add(state.selfUin);
    log(`getGroupMembers(${groupId}) → ${state.members.length} 人`);
    if (rawList.length) void cleanupDepartedGroupTargets(groupId, groupConfig.targets, knownMemberUins, !completeRoster, accountId);
    if (!rawList.length) state.error = '没有成员数据；可点刷新重试';
  } catch (err) {
    if (version === state.version && state.groupId === groupId && panel.isConnected) state.error = `拉取失败：${errorText(err)}（可刷新重试）`;
    log(`拉取群成员失败：${String(err)}`);
  } finally {
    if (version === state.version && state.groupId === groupId) {
      state.loading = false;
      if (panel.isConnected) renderPanel(panel);
    }
  }
}

async function persistTarget(panel: HTMLElement, groupId: string, id: string, enabled: boolean, revision: number, accountId: string): Promise<void> {
  if (!isNumericUin(id)) return;
  const accountEpoch = rendererAccountEpoch;
  let failed = false;
  const queueKey = `${accountId}:${accountEpoch}:${groupId}:${id}`;
  const previous = targetSaveQueues.get(queueKey) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (!isCurrentAccount(accountId, accountEpoch)) return;
    await setGroupTarget(groupId, id, enabled);
  }).catch(async err => {
    failed = true;
    log(`保存群加密设置失败：${String(err)}`);
    if (!isCurrentAccount(accountId, accountEpoch)) return;
    const state = panelStates.get(panel);
    if (!state || state.groupId !== groupId || !panel.isConnected) return;
    if (state.revision === revision) {
      try {
        const config = await getGroupConfig(groupId);
        if (!isCurrentAccount(accountId, accountEpoch) || state !== panelStates.get(panel) || state.groupId !== groupId || !panel.isConnected) return;
        state.selected = new Set(config.targets);
      } catch { /* keep optimistic state */ }
    }
    state.error = `保存失败：${errorText(err)}`;
    renderPanel(panel);
  });
  targetSaveQueues.set(queueKey, next);
  void next.finally(() => { if (targetSaveQueues.get(queueKey) === next) targetSaveQueues.delete(queueKey); });
  await next;
  const state = panelStates.get(panel);
  if (!failed && isCurrentAccount(accountId, accountEpoch) && state?.groupId === groupId && state.revision === revision && panel.isConnected) {
    state.error = '';
    renderSummary(panel, state);
  }
}

function cleanupDepartedGroupTargets(
  groupId: string,
  storedTargets: string[],
  knownMemberUins: Set<string>,
  preserveUnknown = false,
  accountId = getActiveAccountId() ?? '',
  accountEpoch = rendererAccountEpoch
): Promise<void> {
  const remove = preserveUnknown ? [] : numericUins(storedTargets).filter(id => id !== accountId && !knownMemberUins.has(id));
  return Promise.all(remove.map(id => isCurrentAccount(accountId, accountEpoch) ? setGroupTarget(groupId, id, false) : Promise.resolve()))
    .then(() => undefined).catch(err => { log(`清理无效群加密目标失败：${String(err)}`); });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------------- 私聊：加密开关 ---------------- */

const DM_ID = 'qwqnt-pgp-dm-item';
let dmToggleStarted = false;
let dmRenderVersion = 0;

/** 私聊详情面板加「PGP 加密」开关（默认关；没绑定公钥就灰） */
export function startDmToggle(): void {
  if (dmToggleStarted) return;
  dmToggleStarted = true;
  injectGroupStyle();
  // Details are mounted asynchronously after the header button click. Observe
  // detail/header DOM changes and debounce one check instead of polling.
  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => { queued = false; void tickDm(); }, 80);
  };
  const observer = new MutationObserver(mutations => {
    if (mutations.some(m => {
      const target = m.target instanceof Element ? m.target : m.target.parentElement;
      return !!target?.closest('.more-panel, .aio .header, .aio-header, .chat-header, .header-container, header')
        || [...m.addedNodes].some(n => n instanceof Element && (n.matches('.more-panel, .side-panel, .aio .header, .aio-header, .chat-header, .header-container, header') || !!n.querySelector('.more-panel, .side-panel')));
    })) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
  window.addEventListener('vue:component-mount', schedule);
  schedule();
  window.addEventListener('qwqnt-pgp:account-changed', () => {
    rendererAccountEpoch++;
    dmRenderVersion++;
    document.getElementById(DM_ID)?.remove();
    schedule();
  });
  window.addEventListener('qwqnt-pgp:data-changed', event => {
    const changed = (event as CustomEvent<{ accountId?: string; kind?: string; id?: string }>).detail;
    if (changed?.kind === 'binding') {
      return;
    }
    if (changed?.kind !== 'dm') return;
    if (changed.accountId !== getActiveAccountId()) return;
    const peer = getCurrentPeer();
    const uin = peer && peer.chatType !== 2 ? getUinByUid(peer.peerUid) || (isNumericUin(peer.peerUid) ? peer.peerUid : '') : '';
    if (uin && uin === changed.id) void tickDm();
  });
}

async function tickDm(): Promise<void> {
  await loadAccountContext();
  const accountId = getActiveAccountId();
  const accountEpoch = rendererAccountEpoch;
  const version = ++dmRenderVersion;
  // 只找当前可见的详情面板（避免注入到后台窗口 / 别的面板里）
  const side = Array.from(document.querySelectorAll<HTMLElement>('.more-panel > .side-panel'))
    .find(el => el.offsetParent !== null);
  // 群详情面板（有「我的本群昵称」）不注入私聊开关
  const peer = getCurrentPeer();
  void prepareCurrentOpenChat(peer);
  const isGroup = peer?.chatType === 2;
  if (!accountId || !side || isGroup) {
    document.getElementById(DM_ID)?.remove();
    return;
  }

  // 直接插进 QQ 自己的 q-list 里（第一个 panel-content 是空的，插那儿会裸着）
  const list = side.querySelector<HTMLElement>('.panel-content .q-list.list-group');
  if (!list) return;

  const aio = getCurAio();
  const header = (aio?.['header'] ?? {}) as Record<string, unknown>;
  const uid = String(peer?.peerUid ?? header['uid'] ?? '');
  let uin = isNumericUin(String(header['uin'] ?? '')) ? String(header['uin']) : '';
  if (!uin && uid) {
    try { uin = getUinByUid(uid) || await resolvePeerUin(uid); } catch (err) { log(`解析私聊对象 QQ 号失败：${String(err)}`); }
  }
  if (!isCurrentAccount(accountId, accountEpoch) || version !== dmRenderVersion || !list.isConnected) return;
  let dm: { uin: string; enabled: boolean } | null = null;
  let binding: { uin: string; keyID: string } | null = null;
  if (isNumericUin(uin)) {
    [dm, binding] = await Promise.all([
      getDmConfig(uin).catch(err => { log(`读取私聊开关失败：${String(err)}`); return null; }),
      getKeyBinding(uin).catch(err => { log(`读取私聊绑定失败：${String(err)}`); return null; })
    ]);
  }
  if (!isCurrentAccount(accountId, accountEpoch) || version !== dmRenderVersion || !list.isConnected) return;
  const bound = !!binding?.keyID;
  let item = document.getElementById(DM_ID) as HTMLElement | null;
  if (!item || !list.contains(item)) {
    item = buildDmItem(list.querySelector<HTMLElement>(':scope > .q-list-item'));
    list.insertBefore(item, list.firstElementChild);
  }
  const sw = item.querySelector<HTMLElement>('.q-switch');
  if (!sw) return;
  const on = bound && !!dm?.enabled;
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
  sw.classList.toggle('is-active', on);
  sw.setAttribute('aria-disabled', bound ? 'false' : 'true');
  sw.style.opacity = bound ? '' : '.5';
  item.title = bound ? '加密' : '未绑定公钥（去设置里绑定后才能开启）';

  sw.onclick = async () => {
    if (!bound || !isCurrentAccount(accountId, accountEpoch)) return;
    const now = sw.getAttribute('aria-checked') === 'true';
    sw.setAttribute('aria-checked', now ? 'false' : 'true');
    sw.classList.toggle('is-active', !now);
    try {
      await setDmConfig(uin, !now);
      if (!isCurrentAccount(accountId, accountEpoch)) return;
      log(`私聊加密开关：${uin || uid} → ${!now ? '开' : '关'}`);
    } catch (err) {
      sw.setAttribute('aria-checked', now ? 'true' : 'false');
      sw.classList.toggle('is-active', now);
      log(`私聊开关保存失败：${String(err)}`);
    }
  };
}

/** 完全照 QQ 自己的 q-list-item + q-switch 结构做，视觉原生 */
function buildDmItem(nativeItem: HTMLElement | null): HTMLElement {
  const item = nativeItem ? nativeItem.cloneNode(false) as HTMLElement : document.createElement('div');
  item.id = DM_ID;
  item.className = 'q-list-item vue-component';
  item.removeAttribute('style');
  item.innerHTML = `
    <div class="q-list-item_title"><h5>加密</h5></div>
    <div class="q-list-item_tail">
      <div class="q-switch vue-component" role="switch" aria-label="加密" aria-checked="false" aria-disabled="false" tabindex="0"><span class="q-switch__handle"></span></div>
    </div>
  `;
  return item;
}
