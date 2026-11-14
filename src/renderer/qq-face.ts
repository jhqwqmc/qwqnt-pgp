import { decodeFaceParts, encodeFaceParts, facePart, type FacePart } from '../shared/qq-face';

const FACE_NODE = '[data-face-index], .editor-el__qqface-wrapper, img.editor-el__qqface, .little-face-element, .face-element, msg-qq-face, msg-qqface, [data-type="msgQQFace"], img[src*="/default-emojis/"]';
const QQ_FACE_CACHE = /^(appimg:\/\/[^?#]+\/EmojiSystermResource\/)\d{1,5}\/(?:apng|png)\/\d{1,5}\.png(?:[?#]|$)/i;
let observedCacheRoot: string | undefined;

function readFaceNode(node: Element): Exclude<FacePart, string> | null {
  const image = node instanceof HTMLImageElement ? node : node.querySelector('img');
  const indexed = node.hasAttribute('data-face-index') ? node : node.querySelector('[data-face-index]');
  const label = image?.alt || node.getAttribute('aria-label') || node.getAttribute('title');
  const src = image?.getAttribute('src') ?? '';
  observedCacheRoot = QQ_FACE_CACHE.exec(src)?.[1] ?? observedCacheRoot;
  const id = indexed?.getAttribute('data-face-index') ||
    /\/default-emojis\/(\d{1,5})\.png(?:[?#]|$)/i.exec(src)?.[1] ||
    (image?.matches('.editor-el__qqface') && /^appimg:\/\//i.test(src)
      ? /\/EmojiSystermResource\/(\d{1,5})\/(?:apng|png)\/\1\.png(?:[?#]|$)/i.exec(src)?.[1]
      : undefined);
  if (id) return facePart(id, label);

  const data = node.getAttribute('data-item') ?? node.getAttribute('data');
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    const item = parsed?.item ?? parsed;
    return facePart(item?.faceIndex ?? item?.faceElement?.faceIndex, item?.faceText ?? item?.label ?? label);
  } catch { return null; }
}

export function readEditorFaces(editor: HTMLElement): string | null {
  if (!editor.querySelector(FACE_NODE)) return null;
  const parts: FacePart[] = [];
  let hasFace = false;
  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent?.replace(/\u00a0/g, ' ') ?? '');
    } else if (node instanceof Element) {
      const part = node.matches(FACE_NODE) ? readFaceNode(node) : null;
      if (part) {
        parts.push(part);
        hasFace = true;
        return;
      }
      if (node.tagName === 'BR') parts.push('\n');
      else for (const child of node.childNodes) visit(child);
      if (node.matches('p, div') && node.nextSibling) parts.push('\n');
    }
  }
  for (const child of editor.childNodes) visit(child);
  if (!hasFace) return null;
  while (parts.at(-1) === '\n') parts.pop();
  return encodeFaceParts(parts);
}

export function renderQQFaces(target: HTMLElement | DocumentFragment, text: string, nativeBubble = false): void {
  const parts = decodeFaceParts(text);
  const observed = parts.some(part => typeof part !== 'string')
    ? document.querySelector<HTMLImageElement>('img.face-element__icon[src*="/EmojiSystermResource/"], img.editor-el__qqface[src*="/EmojiSystermResource/"]')
    : null;
  const cacheRoot = QQ_FACE_CACHE.exec(observed?.getAttribute('src') ?? '')?.[1] ?? observedCacheRoot;
  for (const part of parts) {
    if (typeof part === 'string') {
      if (!nativeBubble) { target.append(part); continue; }
      const element = document.createElement('span');
      element.className = 'text-element';
      const normal = document.createElement('span');
      normal.className = 'text-normal';
      normal.textContent = part;
      element.append(normal);
      target.append(element);
      continue;
    }
    const label = part.label ? (part.label.startsWith('[') ? part.label : `[${part.label}]`) : '[QQ 表情]';
    const image = document.createElement('img');
    image.alt = label;
    image.width = image.height = 20;
    image.style.verticalAlign = 'text-bottom';
    const fallback = `/_upper_/resource/default-emojis/${part.face}.png`;
    const wrapper = nativeBubble ? document.createElement('span') : null;
    if (wrapper) {
      wrapper.className = 'face-element';
      wrapper.style.width = wrapper.style.height = '20px';
      wrapper.setAttribute('aria-label', part.label || '表情');
      image.className = 'face-element__icon';
      image.dataset.faceIndex = String(part.face);
      image.dataset.role = 'qqFace';
      wrapper.append(image);
    }
    image.addEventListener('error', () => {
      if (image.getAttribute('src') !== fallback) image.src = fallback;
      else image.replaceWith(label);
    });
    image.src = cacheRoot ? `${cacheRoot}${part.face}/apng/${part.face}.png` : fallback;
    target.append(wrapper ?? image);
  }
}
