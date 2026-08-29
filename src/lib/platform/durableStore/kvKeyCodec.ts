/** RC-6 reversible collision-safe durable-store key codec. */

export type DurableStoreKey = string | string[];

const STRING_TAG = 'B';
const ARRAY_TAG = 'D';

export class DurableKeyCodecError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DurableKeyCodecError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function decimalLength(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new DurableKeyCodecError('invalid_length', 'key length must be a non-negative integer');
  }
  return String(n);
}

function assertPlainString(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new DurableKeyCodecError('unsupported_key', 'durable keys must be string or string[]');
  }
}

function encodeString(value: string): string {
  const bytes = utf8Bytes(value);
  return `${STRING_TAG}${decimalLength(bytes.length)}:${value}`;
}

function encodeArray(parts: string[]): string {
  if (parts.length === 0) {
    throw new DurableKeyCodecError('unsupported_key', 'empty arrays are unsupported');
  }
  let body = '';
  for (const part of parts) {
    assertPlainString(part);
    body += encodeString(part);
  }
  return `${ARRAY_TAG}${decimalLength(parts.length)}:${body}`;
}

/** Encode a durable key to canonical UTF-8 TEXT. Nested arrays and non-string types fail closed. */
export function encodeDurableKey(key: DurableStoreKey): string {
  if (typeof key === 'string') return encodeString(key);
  if (Array.isArray(key)) {
    for (const part of key) {
      if (typeof part !== 'string') {
        throw new DurableKeyCodecError('unsupported_key', 'array keys may contain only strings');
      }
    }
    return encodeArray(key);
  }
  throw new DurableKeyCodecError('unsupported_key', 'durable keys must be string or string[]');
}

type DecodeCursor = { text: string; offset: number };

function readTag(cursor: DecodeCursor): string {
  if (cursor.offset >= cursor.text.length) {
    throw new DurableKeyCodecError('truncated_key', 'encoded key is truncated');
  }
  const tag = cursor.text[cursor.offset]!;
  cursor.offset += 1;
  return tag;
}

function readDecimal(cursor: DecodeCursor): number {
  const start = cursor.offset;
  while (cursor.offset < cursor.text.length && cursor.text[cursor.offset]! >= '0' && cursor.text[cursor.offset]! <= '9') {
    cursor.offset += 1;
  }
  if (cursor.offset === start) {
    throw new DurableKeyCodecError('invalid_length', 'missing decimal length');
  }
  const raw = cursor.text.slice(start, cursor.offset);
  if (raw.length > 1 && raw.startsWith('0')) {
    throw new DurableKeyCodecError('invalid_length', 'decimal length must not have leading zeros');
  }
  if (cursor.offset >= cursor.text.length || cursor.text[cursor.offset] !== ':') {
    throw new DurableKeyCodecError('invalid_length', 'decimal length must be followed by a colon');
  }
  cursor.offset += 1;
  return Number(raw);
}

function readUtf8String(cursor: DecodeCursor, byteLength: number): string {
  const remaining = encoder.encode(cursor.text.slice(cursor.offset));
  if (remaining.byteLength < byteLength) {
    throw new DurableKeyCodecError('truncated_key', 'encoded string payload is truncated');
  }
  const slice = remaining.subarray(0, byteLength);
  let decoded: string;
  try {
    decoded = decoder.decode(slice);
  } catch {
    throw new DurableKeyCodecError('invalid_utf8', 'encoded string is not valid UTF-8');
  }
  const consumedChars = decoder.decode(slice).length;
  // Advance by the UTF-16 code units that correspond to the consumed UTF-8 bytes.
  // Re-encode the decoded string and compare to confirm an exact byte take.
  const roundTrip = encoder.encode(decoded);
  if (roundTrip.byteLength !== byteLength) {
    throw new DurableKeyCodecError('invalid_utf8', 'encoded string byte length mismatch');
  }
  cursor.offset += decoded.length;
  void consumedChars;
  return decoded;
}

function decodeOne(cursor: DecodeCursor): DurableStoreKey {
  const tag = readTag(cursor);
  if (tag === STRING_TAG) {
    const len = readDecimal(cursor);
    return readUtf8String(cursor, len);
  }
  if (tag === ARRAY_TAG) {
    const count = readDecimal(cursor);
    if (count === 0) {
      throw new DurableKeyCodecError('unsupported_key', 'empty arrays are unsupported');
    }
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const innerTag = cursor.text[cursor.offset];
      if (innerTag === ARRAY_TAG) {
        throw new DurableKeyCodecError('unsupported_key', 'nested arrays are unsupported');
      }
      const inner = decodeOne(cursor);
      if (typeof inner !== 'string') {
        throw new DurableKeyCodecError('unsupported_key', 'nested arrays are unsupported');
      }
      parts.push(inner);
    }
    return parts;
  }
  throw new DurableKeyCodecError('unknown_tag', `unknown key tag "${tag}"`);
}

/** Decode canonical TEXT back to a durable key. Leftover bytes fail closed. */
export function decodeDurableKey(encoded: string): DurableStoreKey {
  if (typeof encoded !== 'string') {
    throw new DurableKeyCodecError('unsupported_key', 'encoded key must be a string');
  }
  const cursor: DecodeCursor = { text: encoded, offset: 0 };
  const key = decodeOne(cursor);
  if (cursor.offset !== encoded.length) {
    throw new DurableKeyCodecError('leftover_bytes', 'encoded key has leftover bytes');
  }
  return key;
}

export function encodedKeyBytes(encoded: string): Uint8Array {
  return utf8Bytes(encoded);
}

/** Unsigned-byte lexicographic compare of two encoded keys. */
export function compareEncodedKeys(a: string, b: string): number {
  const left = encodedKeyBytes(a);
  const right = encodedKeyBytes(b);
  const n = Math.min(left.byteLength, right.byteLength);
  for (let i = 0; i < n; i += 1) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.byteLength - right.byteLength;
}

export function sortEncodedKeys(keys: string[]): string[] {
  return [...keys].sort(compareEncodedKeys);
}
