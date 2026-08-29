/** Canonical JSON + SHA-256 digest for M2 verification. No Node imports. */

export class CanonicalDigestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CanonicalDigestError';
    this.code = code;
  }
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    throw new CanonicalDigestError('undefined_value', 'canonical JSON rejects undefined');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalDigestError('nonfinite_number', 'canonical JSON rejects NaN and Infinity');
    }
    return value;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const keys = Object.keys(src)
      .filter((k) => src[k] !== undefined)
      .sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = canonicalize(src[key]);
    return out;
  }
  throw new CanonicalDigestError('unsupported_value', 'canonical JSON rejects this value type');
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalJsonUtf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonString(value));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export type DigestRow = {
  encodedKey: string;
  value: unknown;
};

const LF = 0x0a;

/** SHA-256 over encodedKey || 0x0A || canonicalJsonUtf8 || 0x0A for each row in encoded-key order. */
export async function sha256HexOfRows(rows: DigestRow[]): Promise<string> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const row of rows) {
    const keyBytes = encoder.encode(row.encodedKey);
    const payload = canonicalJsonUtf8(row.value);
    const part = new Uint8Array(keyBytes.byteLength + 1 + payload.byteLength + 1);
    part.set(keyBytes, 0);
    part[keyBytes.byteLength] = LF;
    part.set(payload, keyBytes.byteLength + 1);
    part[part.byteLength - 1] = LF;
    chunks.push(part);
    total += part.byteLength;
  }
  const concatenated = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    concatenated.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await crypto.subtle.digest('SHA-256', concatenated);
  return toHex(new Uint8Array(digest));
}
