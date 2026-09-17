import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  NATIVE_ATTEST_PRIVILEGED_ACTION_COMMAND,
  OFFLINE_ATTESTATION_UNAVAILABLE,
  buildOfflineAdjudicationRequest,
  getNativePrivilegedAttestationInvoke,
  isWellFormedAttestationRequest,
  requestOfflineAttestation,
  type RequestOfflineAttestationInput,
} from './offlineAttestation';

const repoRoot = resolve(__dirname, '../../../..');

const input: RequestOfflineAttestationInput = {
  managerStaffId: 'manager-1',
  actionId: 'VOID_SETTLED_SALE',
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2025-11-14',
  localIntentId: 'intent-1',
  pin: '123456',
};

const approvingSeed = {
  oacId: 'oac-1',
  oacSchemaVersion: 1,
  revocationEpochAtIssue: 3,
  managerAuthVersionAtIssue: 9,
  managerCredentialVersionAtIssue: 5,
  nonce: 'bm9uY2U=',
  attemptCount: 0,
  approvalResult: 'APPROVED_LOCAL',
  approvalProofDigest: 'ab'.repeat(32),
};

const approvingDto = {
  ok: true,
  verifiedBranchId: 'LDP-001',
  evidenceSeed: approvingSeed,
  attestationIdHex: 'a1a2a3a4a5a6a7a8a9aaabacadaeaf00',
  paa1Base64: 'UEFBMQ==',
  ssa1Base64: 'U1NBMQ==',
  oacEnvelopeBytesBase64: 'eyJvYWNJZCI6Im9hYy0xIn0=',
  trustedApprovalLowerMs: 1_763_099_940_000,
  trustedApprovalUpperMs: 1_763_099_940_250,
  pendingExecutionExpiresAtMs: 1_763_139_600_000,
  errorCode: null,
};

describe('offlineAttestation client boundary', () => {
  test('the request pre-check mirrors the native structural contract', () => {
    expect(isWellFormedAttestationRequest(input)).toBe(true);
    expect(isWellFormedAttestationRequest({ ...input, actionId: 'EXCHANGE' as never })).toBe(false);
    expect(isWellFormedAttestationRequest({ ...input, targetOrderUtc7Date: '2025-11-4' })).toBe(false);
    expect(isWellFormedAttestationRequest({ ...input, targetOrderId: 'order 1' })).toBe(false);
    expect(isWellFormedAttestationRequest({ ...input, localIntentId: '' })).toBe(false);
    expect(isWellFormedAttestationRequest({ ...input, managerStaffId: 'mgr.1' })).toBe(false);
    expect(isWellFormedAttestationRequest({ ...input, pin: '' })).toBe(false);
  });

  test('a malformed request never reaches the native command', async () => {
    const invoke = vi.fn();
    const res = await requestOfflineAttestation({ ...input, targetOrderUtc7Date: 'nope' }, invoke);
    expect(res).toEqual({ ok: false, errorCode: OFFLINE_ATTESTATION_UNAVAILABLE });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('an absent native bridge fails closed', async () => {
    expect(getNativePrivilegedAttestationInvoke()).toBeNull();
    expect(await requestOfflineAttestation(input)).toEqual({
      ok: false,
      errorCode: OFFLINE_ATTESTATION_UNAVAILABLE,
    });
  });

  test('an approving DTO is passed through verbatim with the four declared values bound', async () => {
    const invoke = vi.fn(async () => approvingDto);
    const res = await requestOfflineAttestation(input, invoke);

    expect(invoke).toHaveBeenCalledWith(NATIVE_ATTEST_PRIVILEGED_ACTION_COMMAND, {
      managerStaffId: 'manager-1',
      actionId: 'VOID_SETTLED_SALE',
      targetOrderId: 'order-1',
      targetOrderUtc7Date: '2025-11-14',
      localIntentId: 'intent-1',
      pin: '123456',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attestation).toEqual({
      attestationIdHex: approvingDto.attestationIdHex,
      paa1Base64: approvingDto.paa1Base64,
      ssa1Base64: approvingDto.ssa1Base64,
      oacEnvelopeBytesBase64: approvingDto.oacEnvelopeBytesBase64,
      verifiedBranchId: 'LDP-001',
      evidenceSeed: approvingSeed,
      trustedApprovalLowerMs: approvingDto.trustedApprovalLowerMs,
      trustedApprovalUpperMs: approvingDto.trustedApprovalUpperMs,
      pendingExecutionExpiresAtMs: approvingDto.pendingExecutionExpiresAtMs,
      localIntentId: 'intent-1',
      actionId: 'VOID_SETTLED_SALE',
      targetOrderId: 'order-1',
      targetOrderUtc7Date: '2025-11-14',
      approvingManagerStaffId: 'manager-1',
    });
    // The nine-field evidence seed is preserved exactly as C-B shaped it.
    expect(Object.keys(res.attestation.evidenceSeed)).toHaveLength(9);
  });

  test('a denial is never attested and carries no PAA1 material', async () => {
    for (const errorCode of ['DENIED_INVALID_PIN', 'DENIED_LOCKED', 'DENIED_STALE', 'DENIED_UNVERIFIABLE']) {
      const invoke = vi.fn(async () => ({
        ok: false,
        verifiedBranchId: 'LDP-001',
        evidenceSeed: { ...approvingSeed, approvalResult: errorCode },
        errorCode,
      }));
      const res = await requestOfflineAttestation(input, invoke);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errorCode).toBe(errorCode);
      expect(res.verifiedBranchId).toBe('LDP-001');
      expect(res).not.toHaveProperty('attestation');
      expect(JSON.stringify(res)).not.toContain('paa1');
    }
  });

  test.each<[string, Record<string, unknown>]>([
    ['missing paa1Base64', { paa1Base64: '' }],
    ['missing ssa1Base64', { ssa1Base64: undefined }],
    ['missing oac bytes', { oacEnvelopeBytesBase64: null }],
    ['missing attestationId', { attestationIdHex: '' }],
    ['missing branch', { verifiedBranchId: '' }],
    ['non-approving seed', { evidenceSeed: { ...approvingSeed, approvalResult: 'DENIED_STALE' } }],
    ['unordered trusted bounds', { trustedApprovalUpperMs: 1 }],
    ['pending expiry at or below the lower bound', { pendingExecutionExpiresAtMs: 1_763_099_940_000 }],
    ['no evidence seed', { evidenceSeed: null }],
  ])('an approving DTO missing %s fails closed', async (_label, patch) => {
    const invoke = vi.fn(async () => ({ ...approvingDto, ...patch }));
    expect(await requestOfflineAttestation(input, invoke)).toEqual({
      ok: false,
      errorCode: OFFLINE_ATTESTATION_UNAVAILABLE,
    });
  });

  // N3 fresh-ingest boundary — the native attestation id must arrive already
  // canonical. The client verifies and rejects; it never normalizes case,
  // pads, truncates, or re-derives the id.
  test.each<[string, unknown]>([
    ['uppercase 32-hex', 'A1A2A3A4A5A6A7A8A9AAABACADAEAF00'],
    ['mixed-case 32-hex', 'a1A2a3A4a5A6a7A8a9AaAbAcAdAeAf00'],
    ['31-char hex', 'a'.repeat(31)],
    ['33-char hex', 'a'.repeat(33)],
    ['64-char hex', 'a'.repeat(64)],
    ['all-zero 32-hex', '0'.repeat(32)],
    ['non-hex 32-char', 'g'.repeat(32)],
    ['non-string', 12345],
  ])('an approving DTO carrying a %s attestation id fails closed', async (_label, attestationIdHex) => {
    const invoke = vi.fn(async () => ({ ...approvingDto, attestationIdHex }));
    expect(await requestOfflineAttestation(input, invoke)).toEqual({
      ok: false,
      errorCode: OFFLINE_ATTESTATION_UNAVAILABLE,
    });
  });

  // N3 fresh-ingest boundary — each of the four seed counters is independently
  // wired to `Number.isInteger(v) && v >= 0`. One representative negative and
  // one representative fractional value per field proves the wiring without a
  // combinatorial matrix.
  test.each<[string, number]>([
    ['revocationEpochAtIssue', -1],
    ['revocationEpochAtIssue', 1.5],
    ['managerAuthVersionAtIssue', -1],
    ['managerAuthVersionAtIssue', 0.5],
    ['managerCredentialVersionAtIssue', -2],
    ['managerCredentialVersionAtIssue', 3.25],
    ['attemptCount', -1],
    ['attemptCount', 2.5],
  ])('an approving DTO whose %s is %s fails closed', async (field, value) => {
    const invoke = vi.fn(async () => ({
      ...approvingDto,
      evidenceSeed: { ...approvingSeed, [field]: value },
    }));
    expect(await requestOfflineAttestation(input, invoke)).toEqual({
      ok: false,
      errorCode: OFFLINE_ATTESTATION_UNAVAILABLE,
    });
  });

  test('a canonical approving DTO with zeroed seed counters is still accepted', async () => {
    const invoke = vi.fn(async () => ({
      ...approvingDto,
      evidenceSeed: {
        ...approvingSeed,
        revocationEpochAtIssue: 0,
        managerAuthVersionAtIssue: 0,
        managerCredentialVersionAtIssue: 0,
        attemptCount: 0,
      },
    }));
    const res = await requestOfflineAttestation(input, invoke);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attestation.attestationIdHex).toBe(approvingDto.attestationIdHex);
    expect(res.attestation.evidenceSeed.attemptCount).toBe(0);
  });

  // §5 hold — the stricter seed-numeric domain is scoped to the APPROVING DTO.
  // A denial is still evidenced exactly as before, malformed counters and all.
  test('a denial DTO with out-of-domain seed counters is still evidenced unchanged', async () => {
    const invoke = vi.fn(async () => ({
      ok: false,
      verifiedBranchId: 'LDP-001',
      evidenceSeed: { ...approvingSeed, approvalResult: 'DENIED_STALE', attemptCount: -1.5 },
      errorCode: 'DENIED_STALE',
    }));
    const res = await requestOfflineAttestation(input, invoke);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('DENIED_STALE');
    expect(res.verifiedBranchId).toBe('LDP-001');
    expect(res.evidenceSeed?.attemptCount).toBe(-1.5);
  });

  test('a thrown or non-object native response fails closed', async () => {
    expect(
      await requestOfflineAttestation(input, async () => {
        throw new Error('bridge exploded');
      }),
    ).toEqual({ ok: false, errorCode: OFFLINE_ATTESTATION_UNAVAILABLE });
    expect(await requestOfflineAttestation(input, async () => null)).toEqual({
      ok: false,
      errorCode: OFFLINE_ATTESTATION_UNAVAILABLE,
    });
    expect(await requestOfflineAttestation(input, async () => 'nope')).toEqual({
      ok: false,
      errorCode: OFFLINE_ATTESTATION_UNAVAILABLE,
    });
  });

  test('the adjudication request is exactly the three stored byte strings', async () => {
    const res = await requestOfflineAttestation(input, async () => approvingDto);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const body = buildOfflineAdjudicationRequest(res.attestation);
    expect(body).toEqual({
      paa1Base64: approvingDto.paa1Base64,
      ssa1Base64: approvingDto.ssa1Base64,
      oacEnvelopeBytesBase64: approvingDto.oacEnvelopeBytesBase64,
    });
    // Re-derivation is forbidden: the same envelope always yields the same body.
    expect(buildOfflineAdjudicationRequest(res.attestation)).toEqual(body);
  });

  test('the module invokes exactly one native command and never signs, reads a path, or logs', () => {
    const src = readFileSync(resolve(repoRoot, 'src/lib/auth/privilegedAction/offlineAttestation.ts'), 'utf8');
    const invoked = [...src.matchAll(/invoke\(\s*([A-Z_]+|'[a-z_]+')/g)].map((m) => m[1]);
    expect(new Set(invoked)).toEqual(new Set(['NATIVE_ATTEST_PRIVILEGED_ACTION_COMMAND']));
    expect(src).not.toMatch(/native_verify_offline_pin|native_clear_offline_lockout/);
    expect(src).not.toMatch(/console\.|localStorage|Date\.now\(\)/);
  });

  test('the client never terminalizes from a local clock (WC-4)', () => {
    const src = readFileSync(resolve(repoRoot, 'src/lib/auth/privilegedAction/offlineAttestation.ts'), 'utf8');
    expect(src).not.toMatch(/serverVerdict/);
    expect(src).not.toMatch(/SERVER_REJECTED/);
    expect(src).not.toMatch(/manualReviewStatus/);
  });
});
