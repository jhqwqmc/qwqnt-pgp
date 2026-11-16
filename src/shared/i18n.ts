import type zhCN from './locales/zh-CN.json';

export const defaultLocale = 'zh-CN';
type MessageKey = keyof typeof zhCN;
type Catalog = Partial<Record<MessageKey, string>>;

const catalogs = new Map<string, Catalog>();
for (const [path, catalog] of Object.entries(import.meta.glob<unknown>('./locales/*.json', { eager: true, import: 'default' }))) {
  const locale = path.slice('./locales/'.length, -'.json'.length);
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) continue;
  try { Intl.getCanonicalLocales(locale); } catch { continue; }
  catalogs.set(locale, catalog as Catalog);
}
export const supportedLocales = [...catalogs.keys()].sort();
let currentLocale: string = defaultLocale;

export function setLocale(value: string): void {
  currentLocale = catalogs.has(value) ? value : defaultLocale;
}

export function getLocale(): string {
  return currentLocale;
}

export function t(key: MessageKey, ...values: unknown[]): string {
  const translated = catalogs.get(currentLocale)?.[key];
  const fallback = catalogs.get(defaultLocale)?.[key];
  const message = typeof translated === 'string' ? translated : typeof fallback === 'string' ? fallback : key;
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, char => entities[char]!);
}

/** For HTML text and quoted attributes only. */
export function tHtml(key: MessageKey, ...values: unknown[]): string {
  return escapeHtml(t(key, ...values));
}
