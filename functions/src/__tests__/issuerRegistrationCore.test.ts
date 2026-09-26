import { describe, expect, it } from 'vitest';
import {
  buildIssuerRegistrationDoc,
  registerIssuerPossessionProofPayload,
  sha256HexOfBase64UrlToken,
  validateRegisterIssuerRequest,
  verifyBootstrapToken,
  type BootstrapTokenRecord,
} from '../issuerRegistrationCore';

const VALID_REQUEST = {
  issuerId: 'hq-console-01',
  requestId: 'r'.repeat(32),
  bootstrapTokenId: 'token-1',
  bootstrapToken: Buffer.alloc(32, 0x01).toString('base64url'),
  publicKeyBase64Url: Buffer.alloc(32, 0x02).toString('base64url'),
  signature: Buffer.alloc(64, 0x03).toString('base64'),
};

describe('validateRegisterIssuerRequest', () => {
  it('accepts a well-formed request', () => {
    expect(validateRegisterIssuerRequest(VALID_REQUEST)).toEqual({ ok: true, value: VALID_REQUEST });
  });

  it('rejects a non-object payload', () => {
    expect(validateRegisterIssuerRequest(null)).toEqual({ ok: false, code: 'invalid_request_shape' });
    expect(validateRegisterIssuerRequest('str')).toEqual({ ok: false, code: 'invalid_request_shape' });
  });

  it('rejects an invalid issuerId shape', () => {
    expect(validateRegisterIssuerRequest({ ...VALID_REQUEST, issuerId: 'BAD ID' })).toEqual({
      ok: false,
      code: 'invalid_request_shape',
    });
  });

  it('rejects a public key that does not decode to 32 bytes', () => {
    expect(
      validateRegisterIssuerRequest({ ...VALID_REQUEST, publicKeyBase64Url: Buffer.alloc(10).toString('base64url') }),
    ).toEqual({ ok: false, code: 'invalid_request_shape' });
  });

  it('rejects missing fields', () => {
    const { signature: _signature, ...rest } = VALID_REQUEST;
    expect(validateRegisterIssuerRequest(rest)).toEqual({ ok: false, code: 'invalid_request_shape' });
  });
});

describe('verifyBootstrapToken', () => {
  const baseDoc: BootstrapTokenRecord = {
    tokenId: 'token-1',
    issuerId: 'hq-console-01',
    tokenHash: sha256HexOfBase64UrlToken('raw-token-placeholder'),
    status: 'PENDING',
    expiresAtServerMs: 10_000,
  };

  it('accepts a matching, unexpired, pending token', () => {
    const rawToken = Buffer.alloc(32, 0x09).toString('base64url');
    const doc = { ...baseDoc, tokenHash: sha256HexOfBase64UrlToken(rawToken) };
    expect(verifyBootstrapToken(doc, 'hq-console-01', rawToken, 5000)).toEqual({ ok: true });
  });

  it('rejects a missing doc', () => {
    expect(verifyBootstrapToken(null, 'hq-console-01', 'x', 1)).toEqual({
      ok: false,
      code: 'bootstrap_token_not_found',
    });
  });

  it('rejects a non-PENDING status', () => {
    expect(verifyBootstrapToken({ ...baseDoc, status: 'CONSUMED' }, 'hq-console-01', 'x', 1)).toEqual({
      ok: false,
      code: 'bootstrap_token_already_consumed',
    });
  });

  it('rejects an expired token', () => {
    expect(verifyBootstrapToken(baseDoc, 'hq-console-01', 'x', 20_000)).toEqual({
      ok: false,
      code: 'bootstrap_token_expired',
    });
  });

  it('rejects a mismatched issuerId', () => {
    expect(verifyBootstrapToken(baseDoc, 'someone-else', 'x', 1)).toEqual({
      ok: false,
      code: 'bootstrap_token_issuer_mismatch',
    });
  });

  it('rejects a wrong raw token (hash mismatch)', () => {
    const rawToken = Buffer.alloc(32, 0x09).toString('base64url');
    const doc = { ...baseDoc, tokenHash: sha256HexOfBase64UrlToken(rawToken) };
    const wrongToken = Buffer.alloc(32, 0x0a).toString('base64url');
    expect(verifyBootstrapToken(doc, 'hq-console-01', wrongToken, 1)).toEqual({
      ok: false,
      code: 'bootstrap_token_hash_mismatch',
    });
  });
});

describe('registerIssuerPossessionProofPayload', () => {
  it('equals the exact bytes the Admin Console signer produces for registerIssuer (cross-component parity)', () => {
    // Golden fixture of admin-issuance-console `issuer_key::sign_issuer_request`
    // for purpose "registerIssuer" with fields {issuerId, bootstrapTokenId}
    // (issuerApi.ts): it inserts `purpose` + `requestId`, then `canonical_json`
    // sorts keys and joins with no whitespace.
    const tokenId = '0123456789abcdef0123456789abcdef';
    const requestId = 'AbCdEf0123456789_-AbCdEf01234567';
    const consoleSignedBytes =
      `{"bootstrapTokenId":"${tokenId}","issuerId":"hq-console-01",` +
      `"purpose":"registerIssuer","requestId":"${requestId}"}`;
    expect(registerIssuerPossessionProofPayload('hq-console-01', tokenId, requestId).toString('utf8')).toBe(
      consoleSignedBytes,
    );
  });

  it('binds purpose "registerIssuer" (differs from the legacy purpose-less shape)', () => {
    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-1', 'r'.repeat(32)).toString('utf8');
    expect(JSON.parse(payload)).toEqual({
      bootstrapTokenId: 'token-1',
      issuerId: 'hq-console-01',
      purpose: 'registerIssuer',
      requestId: 'r'.repeat(32),
    });
    expect(payload).not.toBe('{"bootstrapTokenId":"token-1","issuerId":"hq-console-01","requestId":"' + 'r'.repeat(32) + '"}');
  });
});

describe('buildIssuerRegistrationDoc', () => {
  it('increments credentialVersion on re-registration', () => {
    const doc = buildIssuerRegistrationDoc('hq-console-01', 'pubkey', 1000, 'admin-1', 2);
    expect(doc.credentialVersion).toBe(3);
    expect(doc.active).toBe(true);
    expect(doc.revoked).toBe(false);
  });
});
