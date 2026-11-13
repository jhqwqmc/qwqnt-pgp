/** Adds PGP actions to QQ's own message context menu. */
import { manualDecrypt } from './message';
import { getCached, loadConfig } from './config-cache';
import { toast } from './toast';

const ITEM_ID = 'qwqnt-pgp-decrypt';
const MESSAGE_CONTENT_SELECTOR = '.message-container > .message-content__wrapper';
let installed = false;
let contextOwner: WeakRef<Element> | null = null;
let contextAt = 0;
const OWNER_TIMEOUT_MS = 20_000;
const inFlight = new WeakSet<Element>();
const menuOwners = new WeakMap<HTMLElement, WeakRef<Element>>();

export function startDecryptMenu(): void {
  if (installed) return;
  installed = true;
  if (!getCached()) void loadConfig().then(refreshCurrentMenu).catch(() => undefined);
  window.addEventListener('qwqnt-pgp:config-updated', refreshCurrentMenu);
  window.addEventListener('qwqnt-pgp:account-changed', clearContextOwner);
  const onPointerDown = (event: MouseEvent | PointerEvent): void => {
    if (targetOnPath(event)?.closest(`#${ITEM_ID}`)) return;
    if (event.button !== 2) {
      if (event.composedPath().some(node => node instanceof Element && !!node.closest('.q-context-menu'))) return;
      clearContextOwner();
      return;
    }
    captureContextOwner(event);
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('contextmenu', event => {
    const target = targetOnPath(event);
    if (target?.closest(`#${ITEM_ID}`)) return;
    // QQ may move focus to its overlay before dispatching contextmenu.
    if (!target?.closest('.q-context-menu') || !contextOwner?.deref()?.isConnected) captureContextOwner(event);
    if (getCached()?.autoDecrypt !== false) return;
    queueMicrotask(attachMenuItem);
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') clearContextOwner(); }, true);
  window.addEventListener('vue:component-mount', event => {
    const component = (event as CustomEvent<{ vnode?: { el?: Element } }>).detail;
    const el = component?.vnode?.el;
    if (el instanceof Element && (el.closest('.q-context-menu') || el.closest('.q-context-menu-item'))) attachMenuItem();
  });
  new MutationObserver(records => {
    if (getCached()?.autoDecrypt !== false || !contextOwner?.deref() || Date.now() - contextAt > OWNER_TIMEOUT_MS) return;
    const menuAdded = records.some(record => {
      if (record.type === 'attributes' && record.target instanceof Element) {
        const menu = record.target.closest<HTMLElement>('.q-context-menu') ??
          record.target.querySelector<HTMLElement>('.q-context-menu');
        return !!menu && !record.target.closest(`#${ITEM_ID}`) &&
          (record.target === menu || record.target.contains(menu));
      }
      return [...record.addedNodes].some(node => node instanceof Element &&
        (node.matches('.q-context-menu, .q-context-menu-item') || !!node.querySelector('.q-context-menu, .q-context-menu-item')));
    });
    if (menuAdded) attachMenuItem();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
}

function normalizeTarget(rawTarget: EventTarget | null): Element | null {
  return rawTarget instanceof Element ? rawTarget : rawTarget instanceof Node ? rawTarget.parentElement : null;
}

function targetOnPath(event: Event): Element | null {
  for (const node of event.composedPath()) {
    const target = normalizeTarget(node instanceof EventTarget ? node : null);
    if (target) return target;
  }
  return normalizeTarget(event.target);
}

function clearContextOwner(): void {
  contextOwner = null;
}

function hideMenuItems(): void {
  for (const item of document.querySelectorAll<HTMLElement>(`#${ITEM_ID}`)) {
    item.style.display = 'none';
  }
}

function captureContextOwner(event: Event): void {
  clearContextOwner();
  if (getCached()?.autoDecrypt === true) return;
  const content = targetOnPath(event)?.closest(MESSAGE_CONTENT_SELECTOR);
  const owner = content?.closest('.message') ?? content?.closest('.message-native') ?? null;
  contextOwner = owner ? new WeakRef(owner) : null;
  contextAt = Date.now();
}

function refreshCurrentMenu(): void {
  if (getCached()?.autoDecrypt === false) queueMicrotask(attachMenuItem);
  else {
    clearContextOwner();
    hideMenuItems();
  }
}

function attachMenuItem(): void {
  const ownerRef = contextOwner;
  const owner = ownerRef?.deref();
  if (getCached()?.autoDecrypt !== false || !ownerRef || !owner?.isConnected || Date.now() - contextAt > OWNER_TIMEOUT_MS) return;
  const menus = Array.from(document.querySelectorAll<HTMLElement>('.q-context-menu'));
  const menu = menus.reverse().find(candidate => {
    const style = getComputedStyle(candidate);
    return style.display !== 'none' && style.visibility !== 'hidden' && !candidate.hasAttribute('hidden');
  }) ?? null;
  if (!menu) return;
  const existing = menu.querySelector<HTMLElement>(`#${ITEM_ID}`);
  if (existing) {
    menuOwners.set(menu, ownerRef);
    if (existing.style.display === 'none') existing.style.removeProperty('display');
    return;
  }
  const sample = menu.querySelector<HTMLElement>('.q-context-menu-item');
  if (!sample) return;
  menuOwners.set(menu, ownerRef);

  // Keep QQ's layout wrapper when it owns the row's flex/padding styles.
  const sampleRoot = sample.closest<HTMLElement>('.item-wrapper') ?? sample;
  const item = sampleRoot.cloneNode(true) as HTMLElement;
  item.id = ITEM_ID;
  for (const attribute of Array.from(item.attributes)) {
    if (!['id', 'class', 'style', 'role', 'type'].includes(attribute.name) && !attribute.name.startsWith('data-v-')) item.removeAttribute(attribute.name);
  }
  if (!item.hasAttribute('role') && !item.matches('button')) item.setAttribute('role', 'menuitem');
  for (const element of [item, ...Array.from(item.querySelectorAll<HTMLElement>('*'))]) {
    for (const token of Array.from(element.classList)) {
      if (/(?:^|[-_])(disabled|checked|active)(?:$|[-_])/i.test(token)) element.classList.remove(token);
    }
  }
  if (item.style.pointerEvents === 'none') item.style.removeProperty('pointer-events');
  if (item.style.visibility === 'hidden') item.style.removeProperty('visibility');
  if (item.style.opacity === '0' || item.style.opacity === '0.3') item.style.removeProperty('opacity');
  const originalIcon = sampleRoot.querySelector<HTMLElement>('.q-context-menu-item__icon, .icon, .q-icon, [class*="icon"]');
  const labelCandidates = Array.from(sampleRoot.querySelectorAll<HTMLElement>(
    '.q-context-menu-item__text, .text, .label, [class~="text"], [class~="label"]'
  ));
  const isIcon = (candidate: Element): boolean => candidate.matches('.icon, .q-icon, .q-context-menu-item__icon, [class*="icon"]') ||
    !!originalIcon?.contains(candidate) || !!candidate.contains(originalIcon);
  let originalLabel = labelCandidates.find(candidate => !isIcon(candidate) && candidate.textContent?.trim());
  originalLabel ??= Array.from(sampleRoot.querySelectorAll<HTMLElement>('span'))
    .find(candidate => !isIcon(candidate) && !candidate.querySelector('span') && candidate.textContent?.trim());
  const paths = [originalIcon, originalLabel].filter((node): node is HTMLElement => !!node)
    .map(node => childPath(sampleRoot, node));
  const iconPath = originalIcon ? childPath(sampleRoot, originalIcon) : null;
  const labelPath = originalLabel ? childPath(sampleRoot, originalLabel) : null;
  const iconSlot = iconPath ? nodeAtPath<HTMLElement>(item, iconPath) : undefined;
  const label = labelPath ? nodeAtPath<HTMLElement>(item, labelPath) : document.createElement('span');
  pruneToPaths(item, paths);
  cleanStyleAttributes(item, true);
  for (const element of item.querySelectorAll<HTMLElement>('*')) cleanStyleAttributes(element);
  if (label) label.removeAttribute('title');
  label.textContent = '解密';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<path d="M12 3 19 6v5c0 4.7-3 8.1-7 10-4-1.9-7-5.3-7-10V6l7-3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  const slot = iconSlot ?? document.createElement('span');
  if (!iconSlot) slot.className = 'icon';
  slot.classList.remove('disabled', 'checked', 'active');
  slot.setAttribute('aria-hidden', 'true');
  if (iconSlot) {
    iconSlot.replaceChildren(icon);
    if (!originalLabel) iconSlot.parentElement?.append(label);
  } else {
    slot.replaceChildren(icon);
    const content = label.parentElement ?? item.querySelector<HTMLElement>('.item-context, [class*="context"]') ?? item;
    content.insertBefore(slot, label.parentNode === content ? label : null);
    if (!label.parentNode) content.append(label);
  }
  item.setAttribute('aria-label', '解密');
  const decrypt = (): void => {
    const boundOwner = menuOwners.get(menu);
    const targetOwner = boundOwner?.deref();
    if (getCached()?.autoDecrypt !== false || boundOwner !== contextOwner ||
      Date.now() - contextAt > OWNER_TIMEOUT_MS || !targetOwner?.isConnected || inFlight.has(targetOwner)) return;
    inFlight.add(targetOwner);
    void manualDecrypt(targetOwner).catch(() => toast('解密失败')).finally(() => inFlight.delete(targetOwner));
    queueMicrotask(() => {
      if (boundOwner !== contextOwner || !menu.isConnected || !menu.getClientRects().length) return;
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    });
  };
  item.addEventListener('click', decrypt);
  item.addEventListener('contextmenu', event => {
    event.preventDefault();
    decrypt();
  });
  sampleRoot.insertAdjacentElement('afterend', item);
}

function childPath(root: Node, target: Node): number[] {
  const path: number[] = [];
  for (let node: Node | null = target; node && node !== root; node = node.parentNode) {
    const parent: Node | null = node.parentNode;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node) as number);
  }
  return path;
}

function nodeAtPath<T extends Node>(root: Node, path: number[]): T {
  let node = root;
  for (const index of path) node = node.childNodes[index];
  return node as T;
}

function pruneToPaths(root: Node, paths: number[][], depth = 0): void {
  if (!paths.length) return;
  const keep = new Set(paths.filter(path => path.length > depth).map(path => path[depth]));
  Array.from(root.childNodes).forEach((child, index) => {
    if (!keep.has(index)) root.removeChild(child);
    else pruneToPaths(child, paths.filter(path => path[depth] === index), depth + 1);
  });
}

function cleanStyleAttributes(element: HTMLElement, root = false): void {
  for (const attribute of Array.from(element.attributes)) {
    const keep = ['class', 'style'].includes(attribute.name) || attribute.name.startsWith('data-v-') ||
      (root && ['id', 'role', 'type'].includes(attribute.name));
    if (!keep) element.removeAttribute(attribute.name);
  }
}
