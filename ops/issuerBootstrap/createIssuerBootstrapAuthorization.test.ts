import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_TOKEN_BYTES,
  BOOTSTRAP_TOKEN_DEFAULT_TTL_MS,
  buildBootstrapAuthorization,
  isValidIssuerId,
  sha256HexOfBytes,
} from './createIssuerBootstrapAuthorization';

const TOKEN_BYTES = Buffer.alloc(BOOTSTRAP_TOKEN_BYTES, 0x42);
const TOKEN_ID_BYTES = Buffer.alloc(16, 0x01);
const NOW_MS = 1_772_000_000_000;

describe('isValidIssuerId', () => {
  it('accepts lowercase-alnum-hyphen ids of sufficient length', () => {
    expect(isValidIssuerId('hq-console-01')).toBe(true);
  });

  it('rejects empty, uppercase, and too-short ids', () => {
    expect(isValidIssuerId('')).toBe(false);
    expect(isValidIssuerId('HQ')).toBe(false);
    expect(isValidIssuerId('ab')).toBe(false);
    expect(isValidIssuerId('has spaces')).toBe(false);
  });
});

describe('buildBootstrapAuthorization', () => {
  it('produces a PENDING doc with a hashed (never raw) token', () => {
    const auth = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops-alice', TOKEN_BYTES, TOKEN_ID_BYTES);
    expect(auth.doc.issuerId).toBe('hq-console-01');
    expect(auth.doc.status).toBe('PENDING');
    expect(auth.doc.createdAtServerMs).toBe(NOW_MS);
    expect(auth.doc.expiresAtServerMs).toBe(NOW_MS + BOOTSTRAP_TOKEN_DEFAULT_TTL_MS);
    expect(auth.doc.consumedAtServerMs).toBeNull();
    expect(auth.doc.createdByOps).toBe('ops-alice');
    expect(auth.doc.tokenHash).toBe(sha256HexOfBytes(TOKEN_BYTES));
    // The raw token must never appear anywhere in the persisted doc.
    expect(JSON.stringify(auth.doc)).not.toContain(auth.rawToken);
  });

  it('derives tokenId from a separate random source than the secret token', () => {
    const auth = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops-alice', TOKEN_BYTES, TOKEN_ID_BYTES);
    expect(auth.tokenId).toBe(TOKEN_ID_BYTES.toString('hex'));
    expect(auth.tokenId).not.toBe(auth.rawToken);
  });

  it('respects a custom TTL', () => {
    const auth = buildBootstrapAuthorization(
      'hq-console-01',
      NOW_MS,
      'ops-alice',
      TOKEN_BYTES,
      TOKEN_ID_BYTES,
      60_000,
    );
    expect(auth.doc.expiresAtServerMs).toBe(NOW_MS + 60_000);
  });

  it('rejects an invalid issuerId', () => {
    expect(() => buildBootstrapAuthorization('BAD ID', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES)).toThrow();
  });

  it('rejects a wrong-length token', () => {
    expect(() =>
      buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', Buffer.alloc(10), TOKEN_ID_BYTES),
    ).toThrow(RangeError);
  });

  it('rejects a non-positive TTL', () => {
    expect(() =>
      buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES, 0),
    ).toThrow(RangeError);
  });

  it('rejects a blank operator identity', () => {
    expect(() => buildBootstrapAuthorization('hq-console-01', NOW_MS, '  ', TOKEN_BYTES, TOKEN_ID_BYTES)).toThrow();
  });

  it('is deterministic given the same injected randomness/clock', () => {
    const a = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES);
    const b = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES);
    expect(a).toEqual(b);
  });
});
