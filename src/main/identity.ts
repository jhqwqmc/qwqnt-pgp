import type { KeyInfo } from '@/shared/types';

type KeyInventory = { secret: KeyInfo[]; public: KeyInfo[] };

function normalizeId(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

function validSecret(key: KeyInfo): boolean {
  return key.secret === true && key.expired !== true && key.revoked !== true;
}

function keyIdMatches(key: KeyInfo, preferred: string): boolean {
  const fingerprint = normalizeId(key.fingerprint);
  const keyID = normalizeId(key.keyID);
  if (!preferred) return false;
  if (preferred === fingerprint || preferred === keyID) return true;
  // Allow an unambiguous full fingerprint suffix, but reject short suffixes
  // such as the traditional 8-character key ID because collisions are common.
  return preferred.length >= 16 && fingerprint.endsWith(preferred);
}

function canonicalId(key: KeyInfo): string {
  return String(key.fingerprint || key.keyID || '').trim();
}

/** Select one usable own signing key, preferring the configured key when it remains valid. */
export function chooseOwnKey(keys: KeyInventory, preferred: string): string {
  const available = Array.isArray(keys?.secret) ? keys.secret.filter(validSecret) : [];
  const normalizedPreferred = normalizeId(preferred);
  if (normalizedPreferred) {
    const matches = available.filter(key => keyIdMatches(key, normalizedPreferred));
    if (matches.length === 1) return canonicalId(matches[0]!);
  }
  return available.length ? canonicalId(available[0]!) : '';
}
