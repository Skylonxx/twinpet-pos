import { describe, expect, test } from 'vitest';
import {
  CanonicalDigestError,
  bytesEqual,
  canonicalJsonString,
  sha256HexOfRows,
} from './canonicalDigest';
import { encodeDurableKey, sortEncodedKeys } from './kvKeyCodec';

describe('canonicalDigest', () => {
  test('sorts object keys and preserves array order', () => {
    expect(canonicalJsonString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonString({ cartItems: [{ z: 1, a: 2 }] })).toBe('{"cartItems":[{"a":2,"z":1}]}');
  });

  test('rejects non-finite numbers and undefined', () => {
    expect(() => canonicalJsonString(Number.NaN)).toThrow(CanonicalDigestError);
    expect(() => canonicalJsonString(Number.POSITIVE_INFINITY)).toThrow(CanonicalDigestError);
    expect(() => canonicalJsonString(undefined)).toThrow(CanonicalDigestError);
  });

  test('omits undefined object fields and is deterministic', async () => {
    const rows = [
      { encodedKey: encodeDurableKey('b'), value: { n: 2 } },
      { encodedKey: encodeDurableKey('a'), value: { n: 1, skip: undefined } },
    ];
    const ordered = sortEncodedKeys(rows.map((r) => r.encodedKey)).map(
      (encodedKey) => rows.find((r) => r.encodedKey === encodedKey)!,
    );
    const first = await sha256HexOfRows(ordered);
    const second = await sha256HexOfRows(ordered);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test('byte equality distinguishes divergent payloads', () => {
    const a = new TextEncoder().encode('{"id":"1"}');
    const b = new TextEncoder().encode('{"id":"2"}');
    expect(bytesEqual(a, a)).toBe(true);
    expect(bytesEqual(a, b)).toBe(false);
  });
});
