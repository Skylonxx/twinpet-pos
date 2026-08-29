import { describe, expect, test } from 'vitest';
import {
  DurableKeyCodecError,
  compareEncodedKeys,
  decodeDurableKey,
  encodeDurableKey,
  sortEncodedKeys,
} from './kvKeyCodec';

describe('RC-6 kvKeyCodec', () => {
  test('round-trips empty, ASCII, and multibyte UTF-8 strings', () => {
    const corpus = ['', '1', 'foo', 'กข', 'ä', '𐍈', 'twinpet-suspended-bills'];
    for (const key of corpus) {
      expect(decodeDurableKey(encodeDurableKey(key))).toBe(key);
    }
  });

  test('uses B/D tags and byte-length prefixes', () => {
    expect(encodeDurableKey('1')).toBe('B1:1');
    expect(encodeDurableKey('')).toBe('B0:');
    expect(encodeDurableKey(['foo'])).toBe('D1:B3:foo');
  });

  test('round-trips P-04 three-string pointer and P-13 two-string bill key', () => {
    const p04 = ['__twinpet_meta__', 'latestCloseIntentByDevice', '7F3A9KMQ'];
    const p13 = ['สาขา-01', 'bill-1'];
    expect(decodeDurableKey(encodeDurableKey(p04))).toEqual(p04);
    expect(decodeDurableKey(encodeDurableKey(p13))).toEqual(p13);
    expect(encodeDurableKey(p04)).toBe(
      'D3:B16:__twinpet_meta__B25:latestCloseIntentByDeviceB8:7F3A9KMQ',
    );
  });

  test('distinguishes scalar vs one-element array and rejects numbers', () => {
    expect(encodeDurableKey('foo')).toBe('B3:foo');
    expect(encodeDurableKey(['foo'])).toBe('D1:B3:foo');
    expect(encodeDurableKey('foo')).not.toBe(encodeDurableKey(['foo']));
    expect(() => encodeDurableKey(1 as never)).toThrow(DurableKeyCodecError);
    expect(() => encodeDurableKey(['foo', 1 as never])).toThrow(DurableKeyCodecError);
  });

  test('rejects empty arrays, nested arrays, leftover bytes, and unknown tags', () => {
    expect(() => encodeDurableKey([])).toThrow(/empty arrays/);
    expect(() => encodeDurableKey([['x']] as never)).toThrow(/only strings|nested/);
    expect(() => decodeDurableKey('B3:fooX')).toThrow(/leftover/);
    expect(() => decodeDurableKey('S3:foo')).toThrow(/unknown key tag/);
    expect(() => decodeDurableKey('D1:D1:B1:x')).toThrow(/nested arrays/);
  });

  test('sorts encoded keys by unsigned UTF-8 bytes with strings before arrays', () => {
    const encoded = [
      encodeDurableKey(['zzz']),
      encodeDurableKey('z'),
      encodeDurableKey('a'),
      encodeDurableKey(['a']),
    ];
    const sorted = sortEncodedKeys(encoded);
    expect(sorted.map(decodeDurableKey)).toEqual(['a', 'z', ['a'], ['zzz']]);
    expect(sorted[0]!.startsWith('B')).toBe(true);
    expect(sorted[sorted.length - 1]!.startsWith('D')).toBe(true);
    expect(compareEncodedKeys(encodeDurableKey('B'), encodeDurableKey(['A']))).toBeLessThan(0);
  });

  test('encoded branch order is locale-independent and not localeCompare', () => {
    const pair = ['ä', 'z'];
    const encodedOrder = sortEncodedKeys(pair.map((id) => encodeDurableKey(id))).map(decodeDurableKey);
    expect(encodedOrder).toEqual(['z', 'ä']);
    expect([...pair].sort((a, b) => a.localeCompare(b, 'de'))).toEqual(['ä', 'z']);
    expect([...pair].sort((a, b) => a.localeCompare(b, 'th'))).toEqual(['ä', 'z']);
    const shortVsLong = sortEncodedKeys([encodeDurableKey('ab'), encodeDurableKey('a')]).map(
      decodeDurableKey,
    );
    expect(shortVsLong).toEqual(['a', 'ab']);
  });
});
