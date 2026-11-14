const PREFIX = 'QwQNT PGP faces v1\n';

export type FacePart = string | { face: number; label: string };

export function facePart(id: unknown, label: unknown): Exclude<FacePart, string> | null {
  if ((typeof id !== 'string' && typeof id !== 'number') || !/^\d{1,5}$/.test(String(id))) return null;
  return { face: Number(id), label: typeof label === 'string' ? label.replace(/^\//, '').slice(0, 40) : '' };
}

export function encodeFaceParts(parts: FacePart[]): string {
  return parts.every(part => typeof part === 'string') && !parts.join('').startsWith(PREFIX)
    ? parts.join('') : PREFIX + JSON.stringify(parts);
}

export function decodeFaceParts(text: string): FacePart[] {
  if (text.startsWith(PREFIX)) {
    try {
      const parts: unknown = JSON.parse(text.slice(PREFIX.length));
      if (Array.isArray(parts) && parts.every(part => typeof part === 'string' ||
        (part && typeof part === 'object' && typeof part.face === 'number' && typeof part.label === 'string' && facePart(part.face, part.label)))) return parts as FacePart[];
    } catch { /* Preserve malformed content as plain text. */ }
  }
  return [text];
}
