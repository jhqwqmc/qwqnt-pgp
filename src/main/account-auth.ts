export interface AuthIdentity { uid: string; uin?: string }

/** Extract only unambiguous literal uid/uin fields from an auth response object. */
export function extractAuthIdentity(value: unknown): AuthIdentity | null {
  const uids = new Set<string>();
  const uins = new Set<string>();
  const visited = new WeakSet<object>();
  let visitedNodes = 0;
  let overflow = false;
  const walk = (node: unknown, depth: number): void => {
    if (overflow) return;
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    if (depth > 4 || visitedNodes >= 64) { overflow = true; return; }
    visited.add(node);
    visitedNodes++;
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string' || typeof child === 'number') {
        const text = String(child).trim();
        if (!text || text.length > 128) continue;
        if (/^uid$/i.test(key)) uids.add(text);
        else if (/^uin$/i.test(key) && /^[1-9]\d{0,19}$/.test(text)) uins.add(text);
      } else walk(child, depth + 1);
    }
  };
  walk(value, 0);
  if (overflow || uids.size !== 1 || uins.size > 1) return null;
  return { uid: [...uids][0], ...(uins.size === 1 ? { uin: [...uins][0] } : {}) };
}
