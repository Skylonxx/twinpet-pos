import { describe, expect, test } from 'vitest';
import { DURABLE_DOMAINS, MAX_KNOWN_EPOCH_SCHEMA, newEpochId } from './migrationManifest';

describe('migrationManifest', () => {
  test('names exactly eight first-epoch domain files plus schema 1', () => {
    expect(DURABLE_DOMAINS).toHaveLength(8);
    expect(DURABLE_DOMAINS.map((d) => d.database)).toEqual([
      'twinpet-offline-reversal',
      'twinpet-sale-intent-journal',
      'twinpet-shift-open-intent',
      'twinpet-shift-close-intent',
      'twinpet-active-cart-snapshot',
      'twinpet-sale-submission-evidence',
      'twinpet-device',
      'twinpet-suspended-bills',
    ]);
    expect(MAX_KNOWN_EPOCH_SCHEMA).toBe(1);
  });

  test('new epoch ids are unique canonical tokens', () => {
    const a = newEpochId();
    const b = newEpochId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^epoch-[0-9]{1,16}-[0-9a-f]{32}$/);
    expect(b).toMatch(/^epoch-[0-9]{1,16}-[0-9a-f]{32}$/);
  });
});
