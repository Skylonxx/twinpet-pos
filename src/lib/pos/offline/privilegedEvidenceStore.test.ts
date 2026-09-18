// SEC-001 N3 Phase 2 requires a REAL IndexedDB atomicity proof for the
// capture-then-delete transaction. `fake-indexeddb/auto` is the repository's
// established, authorized harness for that (see
// `shiftCloseIntentStore.realIndexedDb.test.ts`); installing it globally is inert
// for every other test in this file, which all use the in-memory double.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryReversalStore,
  createIndexedDbReversalStore,
  type ReversalLocalStore,
  type ReversalStoreName,
  type ReversalTxn,
} from './reversalLocalStore';
import type { OfflineAttestationEnvelope } from '../../auth/privilegedAction/offlineAttestation';
import type {
  OfflineAdjudicationDisposition,
  OfflineAdjudicationResponse,
} from '../../auth/privilegedAction/offlineAdjudicationTransport';
import { classifyOfflineAdjudicationResponse } from '../../auth/privilegedAction/offlineAdjudicationTransport';
import {
  PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY,
  PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
  isLegalPrivilegedEvidenceTransition,
  parsePrivilegedEvidenceJournalRecordV1,
  type PrivilegedEvidenceJournalRecordV1,
} from './privilegedEvidenceTypes';
import {
  PRIVILEGED_EVIDENCE_DISCARD_CAPTURE_KIND,
  allocatePrivilegedSweepGeneration,
  applyPrivilegedEvidenceDeferredCycleCounts,
  applyPrivilegedEvidenceDisposition,
  claimPrivilegedEvidenceRow,
  classifyRawUnreadablePrivilegedEvidence,
  clearPrivilegedEvidenceBackoff,
  computeEvidenceBindingDigest,
  discardUnreadablePrivilegedEvidenceRow,
  exportDiscardedPrivilegedEvidenceCapture,
  ingestAttestedPrivilegedAction,
  listDiscardedPrivilegedEvidenceCaptures,
  listPrivilegedEvidence,
  listPrivilegedEvidenceForBranch,
  listRawUnreadablePrivilegedEvidence,
  subscribePrivilegedEvidenceStore,
} from './privilegedEvidenceStore';
import { enqueueVoidIntent, markVoidIntentConfirmed, markVoidIntentTerminal } from './voidIntentStore';

function envelope(over: Partial<OfflineAttestationEnvelope> = {}): OfflineAttestationEnvelope {
  return {
    attestationIdHex: 'a'.repeat(32),
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    verifiedBranchId: 'LDP-001',
    evidenceSeed: {
      oacId: 'oac-1',
      oacSchemaVersion: 1,
      revocationEpochAtIssue: 0,
      managerAuthVersionAtIssue: 0,
      managerCredentialVersionAtIssue: 0,
      nonce: 'nonce-1',
      attemptCount: 1,
      approvalResult: 'APPROVED_LOCAL',
      approvalProofDigest: 'proof-1',
    },
    trustedApprovalLowerMs: 1_000,
    trustedApprovalUpperMs: 2_000,
    pendingExecutionExpiresAtMs: 100_000,
    localIntentId: 'intent-1',
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    approvingManagerStaffId: 'mgr-1',
    ...over,
  };
}

const ctx = { ingestStaffId: 'staff-1', ingestDeviceId: 'device-1' };

async function driveToStatus(
  store: ReturnType<typeof createInMemoryReversalStore>,
  status: 'PRIVILEGED_INTENT_QUEUED' | 'SYNCING' | 'SERVER_ACCEPTED' | 'SERVER_REJECTED' | 'MANUAL_ATTENTION',
): Promise<void> {
  await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
  if (status === 'PRIVILEGED_INTENT_QUEUED') return;
  const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
    deviceId: 'd1',
    nowMs: 1_000,
    staffId: 'staff-1',
  });
  if (claim.kind !== 'claimed') throw new Error('setup: claim failed');
  if (status === 'SYNCING') return;

  if (status === 'SERVER_ACCEPTED') {
    const response: OfflineAdjudicationResponse = {
      family: 'ADJUDICATION',
      kind: 'ACCEPTED',
      adjudicationId: envelope().attestationIdHex,
      targetOrderId: 'order-1',
      offlineExecutionId: 'exec-1',
      outcomeKind: 'VOID_APPLIED',
      idempotent: false,
      serverAdjudicatedAtMs: 5_000,
    };
    await applyPrivilegedEvidenceDisposition(
      store,
      envelope().attestationIdHex,
      1,
      { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
      { nowMs: 6_000, staffId: 'staff-1' },
    );
    return;
  }

  if (status === 'SERVER_REJECTED') {
    const response: OfflineAdjudicationResponse = {
      family: 'ADJUDICATION',
      kind: 'REJECTED',
      adjudicationId: envelope().attestationIdHex,
      targetOrderId: 'order-1',
      rejectionReason: 'trusted_time_bounds_invalid',
      terminal: true,
      idempotent: false,
      serverAdjudicatedAtMs: 5_000,
    };
    await applyPrivilegedEvidenceDisposition(
      store,
      envelope().attestationIdHex,
      1,
      { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
      { nowMs: 6_000, staffId: 'staff-1' },
    );
    return;
  }

  // MANUAL_ATTENTION
  const response: OfflineAdjudicationResponse = {
    family: 'ADJUDICATION',
    kind: 'MANUAL_ATTENTION_REQUIRED',
    adjudicationId: envelope().attestationIdHex,
    targetOrderId: 'order-1',
    manualAttentionReason: 'canonical_correlation_missing',
    terminal: true,
    idempotent: false,
    serverAdjudicatedAtMs: 5_000,
  };
  await applyPrivilegedEvidenceDisposition(
    store,
    envelope().attestationIdHex,
    1,
    { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
    { nowMs: 6_000, staffId: 'staff-1' },
  );
}

describe('ingestAttestedPrivilegedAction — atomic CAS boundary', () => {
  it('creates a new row on first ingest with the queued state and zeroed counters', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
    expect(outcome.record.submissionClaims).toBe(0);
    expect(outcome.record.evidenceBindingDigest).toBe(
      await computeEvidenceBindingDigest({
        attestationIdHex: envelope().attestationIdHex,
        localIntentId: envelope().localIntentId,
        paa1Base64: envelope().paa1Base64,
        ssa1Base64: envelope().ssa1Base64,
        oacEnvelopeBytesBase64: envelope().oacEnvelopeBytesBase64,
      }),
    );
  });

  it('duplicate ingest of byte-identical bytes is idempotent_noop with exactly one row', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 2_000);
    expect(outcome.kind).toBe('idempotent_noop');
    const rows = await listPrivilegedEvidence(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAtMs).toBe(1_000); // untouched by the no-op
  });

  it('same adjudicationId with conflicting bytes fails closed, preserving the original bytes', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const outcome = await ingestAttestedPrivilegedAction(store, envelope({ paa1Base64: 'TAMPERED' }), ctx, 2_000);
    expect(outcome.kind).toBe('binding_conflict');
    const rows = await listPrivilegedEvidence(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.paa1Base64).toBe('PAA1'); // original, never overwritten
    expect(rows[0]!.integrityConflict).toBe(true);
    expect(rows[0]!.syncStatus).toBe('MANUAL_ATTENTION');
    expect(rows[0]!.localTerminalReason).toBe('journal_binding_conflict');
  });

  it('refuses to ingest an envelope not carrying APPROVED_LOCAL', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await ingestAttestedPrivilegedAction(
      store,
      envelope({ evidenceSeed: { ...envelope().evidenceSeed, approvalResult: 'DENIED_STALE' } }),
      ctx,
      1_000,
    );
    expect(outcome.kind).toBe('not_approved_local');
    expect(await listPrivilegedEvidence(store)).toHaveLength(0);
  });

  // N3 fresh-ingest fence. Called directly against the store API with a
  // parser-invalid envelope, which is exactly the shape the tightened D-1B
  // boundary now refuses — proving the store fence holds independently of that
  // upstream validator, for any caller and any future parser invariant.
  it('refuses to persist a fresh row the canonical parser rejects, writing nothing', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await ingestAttestedPrivilegedAction(
      store,
      envelope({ attestationIdHex: 'A'.repeat(32) }),
      ctx,
      1_000,
    );

    // Fail closed, with the existing vocabulary — never `created`.
    expect(outcome.kind).toBe('unreadable');

    // Nothing was written: no readable row, and no unreadable row either. The
    // second assertion is the load-bearing one — it proves the row was never
    // persisted, rather than persisted and merely unparseable.
    const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
    expect(rows).toHaveLength(0);
    expect(unreadableCount).toBe(0);
    expect(await listPrivilegedEvidence(store)).toHaveLength(0);
  });

  it('a fresh row that passes the fence is persisted as the parser-returned canonical row', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') throw new Error('unreachable');

    // The returned record is the parser's own output, so it round-trips.
    expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).toEqual(outcome.record);

    const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
    expect(unreadableCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(outcome.record);
  });

  it('never creates a resultingVoidIntentId (D-2 never writes a PK-3 voidIntents row)', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.record.resultingVoidIntentId).toBeNull();
  });
});

describe('ingestAttestedPrivilegedAction — GD-D3-002 OPTION A target-level duplicate exclusion', () => {
  const secondEnvelope = envelope({ attestationIdHex: 'b'.repeat(32), localIntentId: 'intent-2', ssa1Base64: 'SSA1-B' });

  it('1. option disabled/omitted leaves landed ingest behavior unchanged (second envelope same target still creates)', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const outcome = await ingestAttestedPrivilegedAction(store, secondEnvelope, ctx, 2_000);
    expect(outcome.kind).toBe('created');
    expect(await listPrivilegedEvidence(store)).toHaveLength(2);
  });

  it.each([
    ['PRIVILEGED_INTENT_QUEUED'],
    ['SYNCING'],
    ['SERVER_ACCEPTED'],
    ['MANUAL_ATTENTION'],
  ] as const)('2-5. an open %s row blocks a fresh target-matching ingest with duplicate_target', async (status) => {
    const store = createInMemoryReversalStore();
    await driveToStatus(store, status);
    const outcome = await ingestAttestedPrivilegedAction(
      store,
      secondEnvelope,
      { ...ctx, expectNoOpenRowForTarget: true },
      2_000,
    );
    expect(outcome.kind).toBe('duplicate_target');
    expect(await listPrivilegedEvidence(store)).toHaveLength(1);
  });

  it('6. SERVER_REJECTED does not block a fresh approval for the same target', async () => {
    const store = createInMemoryReversalStore();
    await driveToStatus(store, 'SERVER_REJECTED');
    const outcome = await ingestAttestedPrivilegedAction(store, secondEnvelope, { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome.kind).toBe('created');
    expect(await listPrivilegedEvidence(store)).toHaveLength(2);
  });

  it('7. a different target order is never blocked', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const other = envelope({ attestationIdHex: 'c'.repeat(32), targetOrderId: 'order-2', localIntentId: 'intent-3' });
    const outcome = await ingestAttestedPrivilegedAction(store, other, { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome.kind).toBe('created');
    expect(await listPrivilegedEvidence(store)).toHaveLength(2);
  });

  it('8. a different branch is never blocked', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const other = envelope({ attestationIdHex: 'd'.repeat(32), verifiedBranchId: 'LDP-002', localIntentId: 'intent-4' });
    const outcome = await ingestAttestedPrivilegedAction(store, other, { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome.kind).toBe('created');
    expect(await listPrivilegedEvidence(store)).toHaveLength(2);
  });

  it('9. concurrent opted-in ingests for the same target converge to exactly one winner', async () => {
    const store = createInMemoryReversalStore();
    const third = envelope({ attestationIdHex: 'e'.repeat(32), localIntentId: 'intent-5' });
    const [a, b] = await Promise.all([
      ingestAttestedPrivilegedAction(store, envelope(), { ...ctx, expectNoOpenRowForTarget: true }, 1_000),
      ingestAttestedPrivilegedAction(store, third, { ...ctx, expectNoOpenRowForTarget: true }, 1_000),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['created', 'duplicate_target']);
    expect(await listPrivilegedEvidence(store)).toHaveLength(1);
  });

  it('10. the opted-in path performs no schema/parser/matrix change: every row stays parser-valid, 54-key', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), { ...ctx, expectNoOpenRowForTarget: true }, 1_000);
    const rows = await listPrivilegedEvidence(store);
    expect(rows).toHaveLength(1);
    expect(parsePrivilegedEvidenceJournalRecordV1(rows[0])).not.toBeNull();
    expect(Object.keys(rows[0]!)).toHaveLength(54);
  });

  it('11. the original open row bytes stay untouched when a duplicate target loses', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const before = (await listPrivilegedEvidence(store))[0]!;
    const outcome = await ingestAttestedPrivilegedAction(store, secondEnvelope, { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome.kind).toBe('duplicate_target');
    const after = (await listPrivilegedEvidence(store))[0]!;
    expect(after).toEqual(before);
  });
});

describe('ingestAttestedPrivilegedAction — RC-D3-002 unreadable privileged state fails closed', () => {
  it('an unreadable row anywhere in the store blocks the opted-in fresh-row ingest, zero write', async () => {
    const store = createInMemoryReversalStore();
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'corrupt-1', { garbage: true });
    });
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), { ...ctx, expectNoOpenRowForTarget: true }, 1_000);
    expect(outcome).toEqual({ kind: 'unreadable' });
    expect(await listPrivilegedEvidence(store)).toHaveLength(0);
  });

  it('an unreadable row does not affect the landed (non-opted-in) ingest path', async () => {
    const store = createInMemoryReversalStore();
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'corrupt-1', { garbage: true });
    });
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    expect(outcome.kind).toBe('created');
  });
});

describe('ingestAttestedPrivilegedAction — RC-D3-004 Ordering B: legacy-first mutual exclusion', () => {
  const legacyInput = { branchId: 'LDP-001', deviceId: 'dev-1', reason: 'x', voidedBy: 'staff-1' };

  it('an active pending legacy voidIntent for the same bound target blocks a fresh opted-in privileged row', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'order-1', legacyInput, 1_000);
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome).toEqual({ kind: 'legacy_conflict' });
    expect(await listPrivilegedEvidence(store)).toHaveLength(0);
  });

  it('a CONFIRMED legacy voidIntent does not block a fresh opted-in privileged row', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'order-1', legacyInput, 1_000);
    await markVoidIntentConfirmed(store, 'order-1', 1_500);
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome.kind).toBe('created');
  });

  it('a TERMINAL legacy voidIntent does not block a fresh opted-in privileged row', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'order-1', legacyInput, 1_000);
    await markVoidIntentTerminal(store, 'order-1', 'authority_refused', 'permission_denied', 1_500);
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome.kind).toBe('created');
  });

  it('a legacy voidIntent on a different branch never blocks', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'order-1', { ...legacyInput, branchId: 'LDP-999' }, 1_000);
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), { ...ctx, expectNoOpenRowForTarget: true }, 2_000);
    expect(outcome.kind).toBe('created');
  });

  it('the reverse check does not apply to the landed (non-opted-in) ingest path', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'order-1', legacyInput, 1_000);
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 2_000);
    expect(outcome.kind).toBe('created');
  });
});

describe('allocatePrivilegedSweepGeneration — G1 dominance', () => {
  it('allocates strictly above the stored generation and every row claimGeneration', async () => {
    const store = createInMemoryReversalStore();
    const first = await allocatePrivilegedSweepGeneration(store);
    expect(first.generation).toBe(1);
    const second = await allocatePrivilegedSweepGeneration(store);
    expect(second.generation).toBe(2);
  });

  it('self-heals from a lost/corrupt reserved key using rowsMax', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 500, {
      deviceId: 'd1',
      nowMs: 1_000,
      staffId: 'staff-1',
    });
    expect(claim.kind).toBe('claimed');
    // Simulate reserved-key loss by writing garbage directly.
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', '__privileged_claim_generation__', { generation: 'not-a-number' });
    });
    const next = await allocatePrivilegedSweepGeneration(store);
    expect(next.generation).toBe(501); // dominates the claimed row's generation (500), not merely the corrupt stored value
  });
});

describe('claimPrivilegedEvidenceRow — re-validating claim CAS (OP-2)', () => {
  it('claims a queued row and increments submissionClaims but not unresolvedClaimCount on a first claim', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
      deviceId: 'd1',
      nowMs: 1_000,
      staffId: 'staff-1',
    });
    expect(outcome.kind).toBe('claimed');
    if (outcome.kind !== 'claimed') throw new Error('unreachable');
    expect(outcome.record.syncStatus).toBe('SYNCING');
    expect(outcome.record.submissionClaims).toBe(1);
    expect(outcome.record.unresolvedClaimCount).toBe(0);
    expect(outcome.record.claimGeneration).toBe(1);
    expect(outcome.record.lastAttemptAtMs).toBe(1_000);
    expect(outcome.record.lastRelayCallerStaffId).toBe('staff-1');
  });

  it('legal preemption: a higher generation reclaims a SYNCING row and increments unresolvedClaimCount', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 5, { deviceId: 'd1', nowMs: 1_000, staffId: 'staff-1' });
    const reclaim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 6, {
      deviceId: 'd2',
      nowMs: 2_000,
      staffId: 'staff-2',
    });
    expect(reclaim.kind).toBe('claimed');
    if (reclaim.kind !== 'claimed') throw new Error('unreachable');
    expect(reclaim.record.claimGeneration).toBe(6);
    expect(reclaim.record.unresolvedClaimCount).toBe(1);
    expect(reclaim.record.submissionClaims).toBe(2);
  });

  it('a same-or-lower generation cannot claim a live SYNCING row (F1)', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 5, { deviceId: 'd1', nowMs: 1_000, staffId: 'staff-1' });
    const sameGen = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 5, {
      deviceId: 'd2',
      nowMs: 1_000,
      staffId: 'staff-2',
    });
    expect(sameGen.kind).toBe('not_eligible');
  });

  it('a row at the retry ceiling can never be claimed (rule 4, not overridable)', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      const raw = await txn.get('privilegedEvidence', envelope().attestationIdHex);
      const rec = parsePrivilegedEvidenceJournalRecordV1(raw)!;
      await txn.put('privilegedEvidence', envelope().attestationIdHex, {
        ...rec,
        retryableFailureCount: PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
        submissionClaims: PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
      });
    });
    const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 99, {
      deviceId: 'd1',
      nowMs: 1_000,
      staffId: 'staff-1',
    });
    expect(outcome.kind).toBe('not_eligible');
  });

  it('a digest mismatch fails closed to MANUAL_ATTENTION without claiming', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      const raw = await txn.get('privilegedEvidence', envelope().attestationIdHex);
      const rec = parsePrivilegedEvidenceJournalRecordV1(raw)!;
      await txn.put('privilegedEvidence', envelope().attestationIdHex, { ...rec, evidenceBindingDigest: 'corrupted' });
    });
    const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
      deviceId: 'd1',
      nowMs: 1_000,
      staffId: 'staff-1',
    });
    expect(outcome.kind).toBe('digest_mismatch');
    if (outcome.kind !== 'digest_mismatch') throw new Error('unreachable');
    expect(outcome.record.syncStatus).toBe('MANUAL_ATTENTION');
    expect(outcome.record.localTerminalReason).toBe('evidence_binding_digest_mismatch');
    // Bytes remain untouched even under a corrupted digest.
    expect(outcome.record.paa1Base64).toBe('PAA1');
    // RC-D2-003: a failed claim writes neither relay/attempt provenance field.
    expect(outcome.record.lastRelayCallerStaffId).toBeNull();
  });

  describe('RC-D2-001 — TOCTOU-safe snapshot re-verification', () => {
    it('a paa1Base64 mutation between the readonly pre-read and the readwrite CAS is not claimed', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      const originalTransact = store.transact.bind(store);
      let call = 0;
      // The in-memory store serializes transact() calls onto a single chain
      // (models IndexedDB's per-database transaction queue) — a nested call
      // issued from INSIDE another still-open transact() callback would
      // deadlock against that same chain. Instead, chain the mutation off
      // the call-1 PROMISE (after it has fully settled and left the queue),
      // strictly before the caller's next await resumes and issues call 2.
      const spyingStore: ReversalLocalStore = {
        transact: (stores, mode, fn) => {
          call += 1;
          const result = originalTransact(stores, mode, fn);
          // call 1 = the readonly pre-read inside claimPrivilegedEvidenceRow.
          // Mutate the live row's paa1Base64 once it resolves, so the digest
          // computed from the pre-read snapshot is stale by the time the
          // writable CAS (call 2) opens.
          if (call === 1) {
            return result.then(async (value) => {
              await originalTransact(['privilegedEvidence'], 'readwrite', async (innerTxn) => {
                const raw = await innerTxn.get('privilegedEvidence', envelope().attestationIdHex);
                const rec = parsePrivilegedEvidenceJournalRecordV1(raw)!;
                await innerTxn.put('privilegedEvidence', envelope().attestationIdHex, {
                  ...rec,
                  paa1Base64: 'MUTATED',
                });
              });
              return value;
            });
          }
          return result;
        },
      };
      const outcome = await claimPrivilegedEvidenceRow(spyingStore, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      expect(outcome.kind).toBe('not_eligible');
      const rows = await listPrivilegedEvidence(store);
      // Written nothing: the row is untouched apart from our injected mutation.
      expect(rows[0]!.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
      expect(rows[0]!.claimOwner).toBeNull();
      expect(rows[0]!.submissionClaims).toBe(0);
      expect(rows[0]!.lastAttemptAtMs).toBeNull();
      expect(rows[0]!.lastRelayCallerStaffId).toBeNull();
    });

    it('a localIntentId mutation between pre-read and CAS is not claimed', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      const originalTransact = store.transact.bind(store);
      let call = 0;
      const spyingStore: ReversalLocalStore = {
        transact: (stores, mode, fn) => {
          call += 1;
          const result = originalTransact(stores, mode, fn);
          if (call === 1) {
            return result.then(async (value) => {
              await originalTransact(['privilegedEvidence'], 'readwrite', async (innerTxn) => {
                const raw = await innerTxn.get('privilegedEvidence', envelope().attestationIdHex);
                const rec = parsePrivilegedEvidenceJournalRecordV1(raw)!;
                await innerTxn.put('privilegedEvidence', envelope().attestationIdHex, {
                  ...rec,
                  localIntentId: 'MUTATED-INTENT',
                });
              });
              return value;
            });
          }
          return result;
        },
      };
      const outcome = await claimPrivilegedEvidenceRow(spyingStore, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      expect(outcome.kind).toBe('not_eligible');
      const rows = await listPrivilegedEvidence(store);
      expect(rows[0]!.claimOwner).toBeNull();
      expect(rows[0]!.submissionClaims).toBe(0);
    });

    it('an unchanged snapshot with a correct digest still claims normally', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      expect(outcome.kind).toBe('claimed');
    });
  });

  describe('RC-D2-003 — claim-time relay/attempt provenance', () => {
    it('a not_eligible claim (retry ceiling) writes neither provenance field', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
        const raw = await txn.get('privilegedEvidence', envelope().attestationIdHex);
        const rec = parsePrivilegedEvidenceJournalRecordV1(raw)!;
        await txn.put('privilegedEvidence', envelope().attestationIdHex, {
          ...rec,
          retryableFailureCount: PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
          submissionClaims: PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
        });
      });
      const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 99, {
        deviceId: 'd1',
        nowMs: 5_000,
        staffId: 'staff-9',
      });
      expect(outcome.kind).toBe('not_eligible');
      const rows = await listPrivilegedEvidence(store);
      expect(rows[0]!.lastRelayCallerStaffId).toBeNull();
      expect(rows[0]!.lastAttemptAtMs).toBeNull();
    });

    it('a late-landing OP-2 claim commit still atomically sets relay staff id + attempt timestamp', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      // "Late" here means the caller's own budget may already have moved on
      // by the time the CAS actually lands (nowMs advances) — the commit
      // itself is still atomic and still records both fields together.
      const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 7_000,
        staffId: 'staff-7',
      });
      expect(outcome.kind).toBe('claimed');
      if (outcome.kind !== 'claimed') throw new Error('unreachable');
      expect(outcome.record.lastAttemptAtMs).toBe(7_000);
      expect(outcome.record.lastRelayCallerStaffId).toBe('staff-7');
    });

    it('a completed attempt retains its claim-time relay staff id, and signed evidence identity is untouched', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 2_000,
        staffId: 'relay-staff',
      });
      if (claim.kind !== 'claimed') throw new Error('setup failed');
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 5_000,
      };
      const applied = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
        { nowMs: 6_000, staffId: 'relay-staff' },
      );
      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') throw new Error('unreachable');
      // Claim-time provenance persists through apply — never cleared by OP-3.
      expect(applied.record.lastRelayCallerStaffId).toBe('relay-staff');
      // Signed initiator/manager/action/target/branch evidence is never rewritten.
      expect(applied.record.approvingManagerStaffId).toBe('mgr-1');
      expect(applied.record.actionId).toBe('VOID_PENDING_SALE');
      expect(applied.record.targetOrderId).toBe('order-1');
      expect(applied.record.branchId).toBe('LDP-001');
    });
  });
});

describe('applyPrivilegedEvidenceDisposition — apply CAS (OP-3)', () => {
  async function claimedRow(store: ReturnType<typeof createInMemoryReversalStore>, generation = 1) {
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, generation, {
      deviceId: 'd1',
      nowMs: 1_000,
      staffId: 'staff-1',
    });
    if (claim.kind !== 'claimed') throw new Error('setup failed');
    return claim.record;
  }

  it('fences a stale apply: wrong generation writes nothing', async () => {
    const store = createInMemoryReversalStore();
    await claimedRow(store, 1);
    const outcome = await applyPrivilegedEvidenceDisposition(
      store,
      envelope().attestationIdHex,
      99,
      { kind: 'transport_failure' },
      { nowMs: 2_000, staffId: 'staff-1' },
    );
    expect(outcome.kind).toBe('fenced');
    const rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.syncStatus).toBe('SYNCING'); // untouched
  });

  it('ACCEPTED applies exactly the documented field set and resets unresolvedClaimCount', async () => {
    const store = createInMemoryReversalStore();
    await claimedRow(store, 1);
    const response: OfflineAdjudicationResponse = {
      family: 'ADJUDICATION',
      kind: 'ACCEPTED',
      adjudicationId: envelope().attestationIdHex,
      targetOrderId: 'order-1',
      offlineExecutionId: 'exec-1',
      outcomeKind: 'VOID_APPLIED',
      idempotent: false,
      serverAdjudicatedAtMs: 5_000,
    };
    const outcome = await applyPrivilegedEvidenceDisposition(
      store,
      envelope().attestationIdHex,
      1,
      { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
      { nowMs: 6_000, staffId: 'staff-1' },
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') throw new Error('unreachable');
    expect(outcome.record.syncStatus).toBe('SERVER_ACCEPTED');
    expect(outcome.record.serverVerdict).toBe('ACCEPTED');
    expect(outcome.record.claimOwner).toBeNull();
    expect(outcome.record.claimGeneration).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
  });

  it('a retryable disposition increments retryableFailureCount and computes backoff', async () => {
    const store = createInMemoryReversalStore();
    await claimedRow(store, 1);
    const outcome = await applyPrivilegedEvidenceDisposition(
      store,
      envelope().attestationIdHex,
      1,
      { kind: 'transport_failure' },
      { nowMs: 10_000, staffId: 'staff-1' },
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') throw new Error('unreachable');
    expect(outcome.record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
    expect(outcome.record.retryableFailureCount).toBe(1);
    expect(outcome.record.nextAttemptAtMs).toBeGreaterThan(10_000);
    expect(outcome.record.lastDispositionKind).toBe('TRANSPORT_FAILURE');
  });

  it('local submission timeout writes no Class III field and releases the claim for byte-identical retry', async () => {
    const store = createInMemoryReversalStore();
    const claimed = await claimedRow(store, 1);
    const outcome = await applyPrivilegedEvidenceDisposition(
      store,
      envelope().attestationIdHex,
      1,
      { kind: 'local_submission_timeout' },
      { nowMs: 9_000, staffId: 'staff-1' },
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') throw new Error('unreachable');
    expect(outcome.record.lastDispositionKind).toBe('LOCAL_SUBMISSION_TIMEOUT');
    expect(outcome.record.serverVerdict).toBeNull();
    expect(outcome.record.serverReason).toBeNull();
    expect(outcome.record.paa1Base64).toBe(claimed.paa1Base64);
  });

  it('the 8th retryable outcome stops automatic retry without fabricating a server verdict', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    for (let attempt = 1; attempt <= PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES; attempt += 1) {
      const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, attempt, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      if (claim.kind !== 'claimed') throw new Error(`claim failed at attempt ${attempt}`);
      await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        attempt,
        { kind: 'transport_failure' },
        { nowMs: 1_000, staffId: 'staff-1' },
      );
    }
    const rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.syncStatus).toBe('MANUAL_ATTENTION');
    expect(rows[0]!.lastDispositionKind).toBe('LOCAL_TERMINAL');
    expect(rows[0]!.localTerminalReason).toBe('attempt_ceiling_reached');
    expect(rows[0]!.serverVerdict).toBeNull();
    expect(rows[0]!.serverReason).toBeNull();
    expect(rows[0]!.serverAdjudicatedAtMs).toBeNull();
  });

  it('CALLER_DEPENDENT increments relayDeferrals but never retryableFailureCount, and suppresses only that staff id', async () => {
    const store = createInMemoryReversalStore();
    await claimedRow(store, 1);
    const response: OfflineAdjudicationResponse = {
      family: 'PROTOCOL',
      kind: 'PROTOCOL_REJECTED',
      protocolReason: 'relay_caller_not_authorized',
      recoverability: 'CALLER_DEPENDENT',
      serverObservedAtMs: 3_000,
    };
    const outcome = await applyPrivilegedEvidenceDisposition(
      store,
      envelope().attestationIdHex,
      1,
      { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
      { nowMs: 4_000, staffId: 'staff-1' },
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') throw new Error('unreachable');
    expect(outcome.record.relayDeferrals).toBe(1);
    expect(outcome.record.retryableFailureCount).toBe(0);
    expect(outcome.record.lastCallerDependentStaffId).toBe('staff-1');
    expect(outcome.record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
  });

  it('conservation invariant holds after a mixed sequence of claims/applies', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    let gen = 1;
    for (const kind of ['transport_failure', 'transport_failure'] as const) {
      const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, gen, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      if (claim.kind !== 'claimed') throw new Error('claim failed');
      await applyPrivilegedEvidenceDisposition(store, envelope().attestationIdHex, gen, { kind }, { nowMs: 1_000, staffId: 's1' });
      gen += 1;
    }
    const rows = await listPrivilegedEvidence(store);
    const r = rows[0]!;
    expect(r.submissionClaims).toBeGreaterThanOrEqual(r.retryableFailureCount + r.relayDeferrals + r.unresolvedClaimCount);
  });

  describe('RC-D2-004 — canonical disposition is the single policy source', () => {
    it('writer follows canonical disposition for retryability, even against an ACCEPTED-shaped response', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 5_000,
      };
      // Deliberately inconsistent: response says ACCEPTED, disposition says retry.
      const disposition: OfflineAdjudicationDisposition = {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: null,
        serverRejectionReason: null,
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      // Canonical disposition wins: retried, never finalized as SERVER_ACCEPTED.
      expect(outcome.record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
      expect(outcome.record.retryableFailureCount).toBe(1);
      expect(outcome.record.serverVerdict).toBeNull();
      // D10: every successful apply in this RC-D2-004 block must parse.
      expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
    });

    it('writer follows canonical disposition for terminal/manual state, even against a mismatched ACCEPTED-shaped response, and the row stays parser-valid', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      // ACCEPTED-shaped response carries the full adjudication-identifier
      // bundle (adjudicationId/targetOrderId/serverAdjudicatedAtMs/idempotent)
      // that MANUAL_ATTENTION_REQUIRED's parser matrix also needs — so this
      // mismatch is reconcilable without inventing any response data.
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 1,
      };
      // Deliberately inconsistent: response says ACCEPTED, disposition says
      // terminal manual-attention.
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'MANUAL_ATTENTION',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: null,
        serverRejectionReason: 'canonical_correlation_missing',
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      // Canonical disposition wins: manual attention, never a silent retry,
      // and never the ACCEPTED label the raw response kind alone would pick.
      expect(outcome.record.syncStatus).toBe('MANUAL_ATTENTION');
      expect(outcome.record.manualReviewStatus).toBe('REQUIRED');
      expect(outcome.record.serverReason).toBe('canonical_correlation_missing');
      expect(outcome.record.retryableFailureCount).toBe(0);
      expect(outcome.record.lastDispositionKind).toBe('MANUAL_ATTENTION_REQUIRED');
      expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
    });

    it('fails closed (no write) rather than persist an invalid row when a RETRYABLE-shaped response cannot supply any identifier a terminal/manual disposition needs', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      // RETRYABLE carries only adjudicationId + serverAdjudicatedAtMs — none
      // of the 12 disposition-kind labels compatible with syncStatus
      // MANUAL_ATTENTION can be satisfied from that alone.
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'RETRYABLE',
        adjudicationId: envelope().attestationIdHex,
        retryReason: 'backend_unavailable',
        terminal: false,
        serverAdjudicatedAtMs: 1,
      };
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'MANUAL_ATTENTION',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: null,
        serverRejectionReason: 'canonical_correlation_missing',
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      // Never write a row `parsePrivilegedEvidenceJournalRecordV1` would
      // reject: fail closed instead. The row stays claimed under this
      // generation; a later sweep generation's fencing re-admits it.
      expect(outcome.kind).toBe('fenced');
      const rows = await listPrivilegedEvidence(store);
      expect(rows[0]!.syncStatus).toBe('SYNCING');
      expect(rows[0]!.claimGeneration).toBe(1);
    });

    it('reconciles a PROTOCOL_RETRYABLE-shaped response against a PERMANENT-byte manual-attention disposition via serverObservedAtMs, and the row stays parser-valid', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      // PROTOCOL_RETRYABLE — one of the two retryable-family response shapes
      // — carries `serverObservedAtMs`, which is exactly (and only) what
      // PROTOCOL_REJECTED_PERMANENT's matrix requires non-null.
      const response: OfflineAdjudicationResponse = {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_RETRYABLE',
        retryReason: 'backend_unavailable',
        serverObservedAtMs: 7_000,
      };
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'MANUAL_ATTENTION',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: null,
        serverRejectionReason: 'request_shape_invalid',
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 8_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(outcome.record.syncStatus).toBe('MANUAL_ATTENTION');
      expect(outcome.record.lastDispositionKind).toBe('PROTOCOL_REJECTED_PERMANENT');
      expect(outcome.record.serverObservedAtMs).toBe(7_000);
      expect(outcome.record.serverAdjudicationId).toBeNull();
      expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
    });

    it('retryable apply consumes disposition-carried lifecycle fields rather than substituting hard-coded constants', async () => {
      const store = createInMemoryReversalStore();
      const claimed = await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'RETRYABLE',
        adjudicationId: envelope().attestationIdHex,
        retryReason: 'backend_unavailable',
        terminal: false,
        serverAdjudicatedAtMs: 1,
      };
      // A deliberately distinguishable `manualReviewStatus` the real
      // classifier never produces for a retryable disposition (always
      // 'NOT_REQUIRED'). Now that the parser requires 'NOT_REQUIRED' for a
      // queued row, no legal queued-family value can differ from the
      // hard-coded RETRYABLE_QUEUED_LIFECYCLE constant — so consumption is
      // proven in the contrapositive: had the writer substituted that
      // constant, this apply would have succeeded with 'NOT_REQUIRED'. It is
      // fenced precisely because the disposition's own value is carried
      // verbatim to the canonical parser, and nothing is written.
      const disposition: OfflineAdjudicationDisposition = {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'RESOLVED',
        serverVerdict: null,
        serverRejectionReason: null,
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('fenced');
      const fencedRows = await listPrivilegedEvidence(store);
      expect(fencedRows[0]!.syncStatus).toBe('SYNCING'); // untouched, still claimed
      expect(fencedRows[0]!.manualReviewStatus).toBe(claimed.manualReviewStatus);
      expect(fencedRows[0]!.retryableFailureCount).toBe(claimed.retryableFailureCount);

      // The consumption half on a disposition the invariant admits: every
      // lifecycle field is read from `disposition`, never a local literal.
      const real = classifyOfflineAdjudicationResponse(response);
      const applied = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition: real },
        { nowMs: 7_000, staffId: 'staff-1' },
      );
      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') throw new Error('unreachable');
      expect(applied.record.syncStatus).toBe(real.syncStatus);
      expect(applied.record.manualReviewStatus).toBe(real.manualReviewStatus);
      expect(applied.record.lastDispositionKind).toBe('RETRYABLE');
      expect(parsePrivilegedEvidenceJournalRecordV1(applied.record)).not.toBeNull();
    });

    it('STATE_DEPENDENT protocol-rejected retry increments retryableFailureCount like any other retryable outcome, never flipping to terminal', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_REJECTED',
        protocolReason: 'device_registration_unavailable',
        recoverability: 'STATE_DEPENDENT',
        serverObservedAtMs: 3_000,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
        { nowMs: 4_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      // The recoverability class only picks a local label — it never turns
      // this into a terminal (manual-attention) outcome.
      expect(outcome.record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
      expect(outcome.record.lastDispositionKind).toBe('PROTOCOL_REJECTED_STATE_DEPENDENT');
      expect(outcome.record.retryableFailureCount).toBe(1);
      expect(outcome.record.relayDeferrals).toBe(0);
      expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
    });

    it('retryable counter movement follows canonical disposition only, never the raw response kind alone', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 5_000,
      };
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'SERVER_REJECTED',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: 'REJECTED',
        serverRejectionReason: 'trusted_time_bounds_invalid',
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(outcome.record.retryableFailureCount).toBe(0);
      expect(outcome.record.syncStatus).toBe('SERVER_REJECTED');
      expect(outcome.record.serverVerdict).toBe('REJECTED');
      expect(outcome.record.serverReason).toBe('trusted_time_bounds_invalid');
      // RC-D2-004 (D1): `lastDispositionKind` must itself be compatible with
      // the canonical (disposition-driven) lifecycle, not the raw ACCEPTED
      // response kind — an ACCEPTED label here would make the row parser-invalid.
      expect(outcome.record.lastDispositionKind).toBe('REJECTED');
      expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
    });

    it('covers every landed D-1B disposition variant end to end via the real classifier', async () => {
      const variants: OfflineAdjudicationResponse[] = [
        {
          family: 'ADJUDICATION',
          kind: 'ACCEPTED',
          adjudicationId: envelope().attestationIdHex,
          targetOrderId: 'order-1',
          offlineExecutionId: 'exec-1',
          outcomeKind: 'VOID_APPLIED',
          idempotent: false,
          serverAdjudicatedAtMs: 1,
        },
        {
          family: 'ADJUDICATION',
          kind: 'REJECTED',
          adjudicationId: envelope().attestationIdHex,
          targetOrderId: 'order-1',
          rejectionReason: 'trusted_time_bounds_invalid',
          terminal: true,
          idempotent: false,
          serverAdjudicatedAtMs: 1,
        },
        {
          family: 'ADJUDICATION',
          kind: 'MANUAL_ATTENTION_REQUIRED',
          adjudicationId: envelope().attestationIdHex,
          targetOrderId: 'order-1',
          manualAttentionReason: 'canonical_correlation_missing',
          terminal: true,
          idempotent: false,
          serverAdjudicatedAtMs: 1,
        },
        {
          family: 'ADJUDICATION',
          kind: 'ADJUDICATION_ANOMALY',
          adjudicationId: envelope().attestationIdHex,
          targetOrderId: 'order-1',
          anomalyReason: 'adjudication_record_unreadable',
          terminalForAutomation: true,
          recordWritten: false,
          serverObservedAtMs: 1,
        },
        {
          family: 'ADJUDICATION',
          kind: 'RETRYABLE',
          adjudicationId: envelope().attestationIdHex,
          retryReason: 'backend_unavailable',
          terminal: false,
          serverAdjudicatedAtMs: 1,
        },
        { family: 'PROTOCOL', kind: 'PROTOCOL_RETRYABLE', retryReason: 'backend_unavailable', serverObservedAtMs: 1 },
        {
          family: 'PROTOCOL',
          kind: 'PROTOCOL_REJECTED',
          protocolReason: 'request_shape_invalid',
          recoverability: 'PERMANENT',
          serverObservedAtMs: 1,
        },
      ];
      for (const response of variants) {
        const store = createInMemoryReversalStore();
        await claimedRow(store, 1);
        const disposition = classifyOfflineAdjudicationResponse(response);
        const outcome = await applyPrivilegedEvidenceDisposition(
          store,
          envelope().attestationIdHex,
          1,
          { kind: 'server', response, disposition },
          { nowMs: 6_000, staffId: 'staff-1' },
        );
        expect(outcome.kind).toBe('applied');
        if (outcome.kind !== 'applied') throw new Error(`unreachable for ${response.kind}`);
        expect(outcome.record.syncStatus).toBe(disposition.syncStatus);
        expect(outcome.record.manualReviewStatus).toBe(disposition.manualReviewStatus);
        expect(outcome.record.serverVerdict).toBe(disposition.serverVerdict);
        expect(outcome.record.serverReason).toBe(disposition.serverRejectionReason);
        expect(outcome.record.offlineExecutionId).toBe(disposition.offlineExecutionId);
        expect(outcome.record.outcomeKind).toBe(disposition.outcomeKind);
        expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
      }
    });

    it('D7 — a type-safe synthetic retryable disposition with non-null Class III fields is never silently nulled while reporting applied; it fails closed instead', async () => {
      const store = createInMemoryReversalStore();
      const claimed = await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'RETRYABLE',
        adjudicationId: envelope().attestationIdHex,
        retryReason: 'backend_unavailable',
        terminal: false,
        serverAdjudicatedAtMs: 1,
      };
      // Type-safe (compiles against OfflineAdjudicationDisposition) but a
      // shape the real D-1B classifier never produces for `retryable: true`
      // — every Class III field the type permits is deliberately non-default.
      const disposition: OfflineAdjudicationDisposition = {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: 'ACCEPTED',
        serverRejectionReason: 'device_registration_unavailable',
        offlineExecutionId: 'exec-synthetic',
        outcomeKind: 'VOID_APPLIED',
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      // Every retryable disposition-kind's parser matrix requires every
      // Class III field null — a non-null serverVerdict here makes the
      // would-be row parser-invalid. The writer must fail closed rather
      // than silently replace these fields with hard-coded nulls while
      // still reporting `applied`.
      expect(outcome.kind).toBe('fenced');
      const rows = await listPrivilegedEvidence(store);
      expect(rows[0]!.syncStatus).toBe('SYNCING'); // untouched
      expect(rows[0]!.claimGeneration).toBe(1);
      expect(rows[0]!.retryableFailureCount).toBe(0); // no partial write
      expect(rows[0]!.paa1Base64).toBe(claimed.paa1Base64);
    });

    it('D8 — CALLER_DEPENDENT and STATE_DEPENDENT persist an identical lifecycle payload for the same disposition, differing only in local label/scheduling/counter fields; an incompatible canonical payload fails both closed', async () => {
      const callerResponse: OfflineAdjudicationResponse = {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_REJECTED',
        protocolReason: 'relay_caller_not_authorized',
        recoverability: 'CALLER_DEPENDENT',
        serverObservedAtMs: 3_000,
      };
      const stateResponse: OfflineAdjudicationResponse = {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_REJECTED',
        protocolReason: 'device_registration_unavailable',
        recoverability: 'STATE_DEPENDENT',
        serverObservedAtMs: 3_000,
      };
      const baseDisposition: OfflineAdjudicationDisposition = {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: null,
        serverRejectionReason: null,
        offlineExecutionId: null,
        outcomeKind: null,
      };

      const callerStore = createInMemoryReversalStore();
      await claimedRow(callerStore, 1);
      const callerOutcome = await applyPrivilegedEvidenceDisposition(
        callerStore,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response: callerResponse, disposition: baseDisposition },
        { nowMs: 4_000, staffId: 'staff-1' },
      );

      const stateStore = createInMemoryReversalStore();
      await claimedRow(stateStore, 1);
      const stateOutcome = await applyPrivilegedEvidenceDisposition(
        stateStore,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response: stateResponse, disposition: baseDisposition },
        { nowMs: 4_000, staffId: 'staff-1' },
      );

      expect(callerOutcome.kind).toBe('applied');
      expect(stateOutcome.kind).toBe('applied');
      if (callerOutcome.kind !== 'applied' || stateOutcome.kind !== 'applied') throw new Error('unreachable');

      const lifecycleFields = [
        'syncStatus',
        'manualReviewStatus',
        'serverVerdict',
        'serverReason',
        'offlineExecutionId',
        'outcomeKind',
      ] as const;
      for (const field of lifecycleFields) {
        expect(callerOutcome.record[field]).toEqual(stateOutcome.record[field]);
      }
      // Only the local label/scheduling/counter semantics differ.
      expect(callerOutcome.record.lastDispositionKind).toBe('PROTOCOL_REJECTED_CALLER_DEPENDENT');
      expect(stateOutcome.record.lastDispositionKind).toBe('PROTOCOL_REJECTED_STATE_DEPENDENT');
      expect(callerOutcome.record.relayDeferrals).toBe(1);
      expect(stateOutcome.record.relayDeferrals).toBe(0);
      expect(callerOutcome.record.retryableFailureCount).toBe(0);
      expect(stateOutcome.record.retryableFailureCount).toBe(1);
      expect(parsePrivilegedEvidenceJournalRecordV1(callerOutcome.record)).not.toBeNull();
      expect(parsePrivilegedEvidenceJournalRecordV1(stateOutcome.record)).not.toBeNull();

      // An incompatible canonical payload (both dispositions still fully
      // agree, only now with a non-null serverVerdict) must fail BOTH
      // branches closed, consistently.
      const inconsistentDisposition: OfflineAdjudicationDisposition = {
        ...baseDisposition,
        serverVerdict: 'ACCEPTED',
      };
      const callerStore2 = createInMemoryReversalStore();
      await claimedRow(callerStore2, 1);
      const callerFenced = await applyPrivilegedEvidenceDisposition(
        callerStore2,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response: callerResponse, disposition: inconsistentDisposition },
        { nowMs: 4_000, staffId: 'staff-1' },
      );
      const stateStore2 = createInMemoryReversalStore();
      await claimedRow(stateStore2, 1);
      const stateFenced = await applyPrivilegedEvidenceDisposition(
        stateStore2,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response: stateResponse, disposition: inconsistentDisposition },
        { nowMs: 4_000, staffId: 'staff-1' },
      );
      expect(callerFenced.kind).toBe('fenced');
      expect(stateFenced.kind).toBe('fenced');
    });

    it('D9 — final parser fence: a synthetic PROTOCOL_RETRYABLE disposition pair that would construct a parser-invalid row is fenced before txn.put, and the claimed row is untouched', async () => {
      const store = createInMemoryReversalStore();
      const claimed = await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_RETRYABLE',
        retryReason: 'backend_unavailable',
        serverObservedAtMs: 9_000,
      };
      // PROTOCOL_RETRYABLE's disposition-kind matrix (like every retryable
      // kind) requires every Class III field null — a LONE non-null
      // `offlineExecutionId`, with everything else null, still makes the
      // would-be row parser-invalid. Exercises a different disposition kind
      // and a different single-field violation than D7.
      const disposition: OfflineAdjudicationDisposition = {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: null,
        serverRejectionReason: null,
        offlineExecutionId: 'exec-synthetic',
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('fenced');
      const rows = await listPrivilegedEvidence(store);
      expect(rows[0]!.syncStatus).toBe('SYNCING');
      expect(rows[0]!.claimGeneration).toBe(1);
      expect(rows[0]!.claimOwner).toBe(claimed.claimOwner);
      expect(rows[0]!.retryableFailureCount).toBe(0);
      expect(rows[0]!.paa1Base64).toBe(claimed.paa1Base64);
    });

    async function driveToRetryableFailureCount(
      store: ReversalLocalStore,
      targetCount: number,
    ): Promise<void> {
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      for (let attempt = 1; attempt <= targetCount; attempt += 1) {
        const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, attempt, {
          deviceId: 'd1',
          nowMs: 1_000,
          staffId: 'staff-1',
        });
        if (claim.kind !== 'claimed') throw new Error(`claim failed at attempt ${attempt}`);
        const applied = await applyPrivilegedEvidenceDisposition(
          store,
          envelope().attestationIdHex,
          attempt,
          { kind: 'transport_failure' },
          { nowMs: 1_000, staffId: 'staff-1' },
        );
        if (applied.kind !== 'applied') throw new Error(`apply failed at attempt ${attempt}`);
      }
    }

    it('C1 — a synthetic retryable disposition with non-null canonical fields at the attempt ceiling is preserved into the row and fails closed, never silently nulled to applied', async () => {
      const store = createInMemoryReversalStore();
      await driveToRetryableFailureCount(store, PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES - 1);
      const preCeilingRows = await listPrivilegedEvidence(store);
      expect(preCeilingRows[0]!.retryableFailureCount).toBe(PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES - 1);

      // The next apply reaches the ceiling (nextRetryCount === MAX). Supply a
      // type-safe but synthetic RETRYABLE disposition whose canonical Class
      // III fields are non-null — a shape the real D-1B classifier never
      // produces for a retryable disposition (see classifyOfflineAdjudicationResponse).
      const finalAttempt = PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES;
      const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, finalAttempt, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      if (claim.kind !== 'claimed') throw new Error('claim failed at final attempt');
      const claimedSnapshot = claim.record;
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'RETRYABLE',
        adjudicationId: envelope().attestationIdHex,
        retryReason: 'backend_unavailable',
        terminal: false,
        serverAdjudicatedAtMs: 1,
      };
      const disposition: OfflineAdjudicationDisposition = {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: 'ACCEPTED',
        serverRejectionReason: 'device_registration_unavailable',
        offlineExecutionId: 'exec-synthetic-ceiling',
        outcomeKind: 'VOID_APPLIED',
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        finalAttempt,
        { kind: 'server', response, disposition },
        { nowMs: 9_000, staffId: 'staff-1' },
      );
      // LOCAL_TERMINAL's parser matrix requires every Class III field null.
      // Silently replacing the supplied canonical payload with hard-coded
      // nulls here would let this write through as `applied`, erasing the
      // synthetic disposition's non-null data. The writer must instead
      // preserve it into the row and let the universal parser-validity
      // fence reject the write, exactly like the below-ceiling case (D7).
      expect(outcome.kind).toBe('fenced');
      const rows = await listPrivilegedEvidence(store);
      expect(rows[0]!.syncStatus).toBe('SYNCING'); // untouched claimed row
      expect(rows[0]!.claimGeneration).toBe(finalAttempt);
      expect(rows[0]!.retryableFailureCount).toBe(PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES - 1); // no partial write
      expect(rows[0]!.lastDispositionKind).not.toBe('LOCAL_TERMINAL');
      expect(rows[0]!.paa1Base64).toBe(claimedSnapshot.paa1Base64);
    });

    it('C2 — a real classifier retryable disposition at the attempt ceiling still escalates successfully to a parser-valid LOCAL_TERMINAL row', async () => {
      const store = createInMemoryReversalStore();
      await driveToRetryableFailureCount(store, PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES - 1);

      const finalAttempt = PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES;
      const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, finalAttempt, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      if (claim.kind !== 'claimed') throw new Error('claim failed at final attempt');
      // The real D-1B classifier's canonical payload for a retryable
      // disposition is always all-null (see classifyOfflineAdjudicationResponse).
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'RETRYABLE',
        adjudicationId: envelope().attestationIdHex,
        retryReason: 'backend_unavailable',
        terminal: false,
        serverAdjudicatedAtMs: 9_000,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        finalAttempt,
        { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
        { nowMs: 9_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(outcome.record.lastDispositionKind).toBe('LOCAL_TERMINAL');
      expect(outcome.record.localTerminalReason).toBe('attempt_ceiling_reached');
      expect(outcome.record.syncStatus).toBe('MANUAL_ATTENTION');
      expect(outcome.record.manualReviewStatus).toBe('REQUIRED');
      expect(outcome.record.serverVerdict).toBeNull();
      expect(outcome.record.serverReason).toBeNull();
      expect(outcome.record.offlineExecutionId).toBeNull();
      expect(outcome.record.outcomeKind).toBeNull();
      expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
    });
  });

  describe('Codex N-3 hardening — production write paths bind to the canonical transition predicate', () => {
    // GEMINI-073R1 N3 test-only hardening (Claude-055R1). No production source
    // is edited by this block: it asserts every syncStatus transition the
    // write paths above already produce is legal under the SAME canonical
    // `isLegalPrivilegedEvidenceTransition` predicate `privilegedEvidenceTypes.ts`
    // declares — reusing that one function rather than re-deriving a second,
    // independently-maintained copy of `LEGAL_TRANSITIONS` here (one source of
    // truth, per the binding N3 requirement).

    it('ingest produces the sole legal null → PRIVILEGED_INTENT_QUEUED transition', async () => {
      const store = createInMemoryReversalStore();
      const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      expect(outcome.kind).toBe('created');
      if (outcome.kind !== 'created') throw new Error('unreachable');
      expect(isLegalPrivilegedEvidenceTransition(null, outcome.record.syncStatus)).toBe(true);
      expect(outcome.record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
    });

    it('claim produces the legal PRIVILEGED_INTENT_QUEUED → SYNCING transition', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      if (claim.kind !== 'claimed') throw new Error('setup failed');
      expect(
        isLegalPrivilegedEvidenceTransition('PRIVILEGED_INTENT_QUEUED', claim.record.syncStatus),
      ).toBe(true);
      expect(claim.record.syncStatus).toBe('SYNCING');
    });

    it('an ACCEPTED apply produces the legal SYNCING → SERVER_ACCEPTED transition', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 5_000,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(isLegalPrivilegedEvidenceTransition('SYNCING', outcome.record.syncStatus)).toBe(true);
      expect(outcome.record.syncStatus).toBe('SERVER_ACCEPTED');
    });

    it('a REJECTED apply produces the legal SYNCING → SERVER_REJECTED transition', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 5_000,
      };
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'SERVER_REJECTED',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: 'REJECTED',
        serverRejectionReason: 'trusted_time_bounds_invalid',
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(isLegalPrivilegedEvidenceTransition('SYNCING', outcome.record.syncStatus)).toBe(true);
      expect(outcome.record.syncStatus).toBe('SERVER_REJECTED');
    });

    it('a terminal manual-attention apply produces the legal SYNCING → MANUAL_ATTENTION transition', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 1,
      };
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'MANUAL_ATTENTION',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: null,
        serverRejectionReason: 'canonical_correlation_missing',
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(isLegalPrivilegedEvidenceTransition('SYNCING', outcome.record.syncStatus)).toBe(true);
      expect(outcome.record.syncStatus).toBe('MANUAL_ATTENTION');
    });

    it('a retryable apply produces the legal SYNCING → PRIVILEGED_INTENT_QUEUED transition', async () => {
      const store = createInMemoryReversalStore();
      await claimedRow(store, 1);
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'transport_failure' },
        { nowMs: 10_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(isLegalPrivilegedEvidenceTransition('SYNCING', outcome.record.syncStatus)).toBe(true);
      expect(outcome.record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
    });

    it('the retryable-ceiling apply produces the legal SYNCING → MANUAL_ATTENTION transition', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      let ceilingClaimBeforeStatus;
      let lastRecordStatus: string | undefined;
      for (let attempt = 1; attempt <= PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES; attempt += 1) {
        const claim = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, attempt, {
          deviceId: 'd1',
          nowMs: 1_000,
          staffId: 'staff-1',
        });
        if (claim.kind !== 'claimed') throw new Error(`claim failed at attempt ${attempt}`);
        // The actual before-state for the ceiling apply below: bind to the
        // claim's own observed row state rather than assuming the prior
        // iteration's post-apply status still holds — the loop re-claims the
        // row every iteration, and claim itself transitions the row to SYNCING.
        ceilingClaimBeforeStatus = claim.record.syncStatus;
        const outcome = await applyPrivilegedEvidenceDisposition(
          store,
          envelope().attestationIdHex,
          attempt,
          { kind: 'transport_failure' },
          { nowMs: 1_000, staffId: 'staff-1' },
        );
        if (outcome.kind === 'applied') lastRecordStatus = outcome.record.syncStatus;
      }
      const rows = await listPrivilegedEvidence(store);
      expect(rows[0]!.syncStatus).toBe('MANUAL_ATTENTION');
      // The final iteration first claims the row into SYNCING, then applies
      // the ceiling disposition — so the actual observed pair is
      // SYNCING → MANUAL_ATTENTION, not the retry loop's earlier
      // PRIVILEGED_INTENT_QUEUED → SYNCING transitions.
      expect(ceilingClaimBeforeStatus).toBe('SYNCING');
      expect(
        isLegalPrivilegedEvidenceTransition(ceilingClaimBeforeStatus ?? null, rows[0]!.syncStatus),
      ).toBe(true);
      expect(lastRecordStatus).toBe('MANUAL_ATTENTION');
    });

    it('non-vacuity: the canonical predicate does reject an illegal reversal out of a terminal status', () => {
      // Proves the assertions above are discriminating, not vacuously true —
      // the same predicate correctly rejects a transition no write path here
      // ever produces (a terminal SERVER_ACCEPTED row silently reopened back
      // to PRIVILEGED_INTENT_QUEUED).
      expect(isLegalPrivilegedEvidenceTransition('SERVER_ACCEPTED', 'PRIVILEGED_INTENT_QUEUED')).toBe(
        false,
      );
      expect(isLegalPrivilegedEvidenceTransition('SERVER_REJECTED', 'SYNCING')).toBe(false);
      expect(isLegalPrivilegedEvidenceTransition('MANUAL_ATTENTION', 'PRIVILEGED_INTENT_QUEUED')).toBe(
        false,
      );
    });
  });

  describe('Codex N-3 hardening — concrete RETRYABLE + RESOLVED field-matrix gap (Codex-007/R1)', () => {
    // Codex-007/R1 identified that the writer AND
    // `parsePrivilegedEvidenceJournalRecordV1` both silently ACCEPTED a
    // `manualReviewStatus: 'RESOLVED'` paired with a RETRYABLE disposition —
    // a field-value combination the real classifier
    // (`classifyOfflineAdjudicationResponse`) never itself produces (it
    // always emits `manualReviewStatus: 'NOT_REQUIRED'` for a retryable
    // disposition). This is a field-matrix gap, not a `(from,to)` status
    // transition gap, so the transition-binding block above — which only
    // asserts `isLegalPrivilegedEvidenceTransition` — cannot catch it.
    //
    // Closed by the canonical parser cross-invariant
    // "PRIVILEGED_INTENT_QUEUED requires manualReviewStatus NOT_REQUIRED" in
    // `privilegedEvidenceTypes.ts`. One source of truth: the parser is
    // already OP-3's write fence, so no writer-side guard duplicates the
    // rule. The case below is now ordinary enforced behavior, not a deferred
    // expected failure.
    it(
      'a RETRYABLE disposition carrying manualReviewStatus RESOLVED is rejected, not silently applied',
      async () => {
        const store = createInMemoryReversalStore();
        await claimedRow(store, 1);
        const response: OfflineAdjudicationResponse = {
          family: 'ADJUDICATION',
          kind: 'RETRYABLE',
          adjudicationId: envelope().attestationIdHex,
          retryReason: 'backend_unavailable',
          terminal: false,
          serverAdjudicatedAtMs: 1,
        };
        // The real classifier never produces this pairing — it always emits
        // 'NOT_REQUIRED' for a retryable disposition (see the RC-D2-004 test
        // immediately above). This synthesizes the contradictory pairing
        // directly, exactly as Codex-007/R1 did.
        const disposition: OfflineAdjudicationDisposition = {
          retryable: true,
          terminalForAutomation: false,
          syncStatus: 'PRIVILEGED_INTENT_QUEUED',
          manualReviewStatus: 'RESOLVED',
          serverVerdict: null,
          serverRejectionReason: null,
          offlineExecutionId: null,
          outcomeKind: null,
        };
        const outcome = await applyPrivilegedEvidenceDisposition(
          store,
          envelope().attestationIdHex,
          1,
          { kind: 'server', response, disposition },
          { nowMs: 6_000, staffId: 'staff-1' },
        );
        // Fails closed (fenced / not applied) rather than silently persisting
        // a RETRYABLE-kind row with a RESOLVED manual-review status the real
        // classifier can never itself produce.
        expect(outcome.kind).not.toBe('applied');
      },
    );
  });

  describe('Claude N-3 hardening — SERVER_ACCEPTED / SERVER_REJECTED manual-review field-matrix gap', () => {
    // Claude-061 exactified the sibling of the RETRYABLE + RESOLVED gap above:
    // the per-kind matrix's 'ACCEPTED' and 'REJECTED' cases constrained every
    // Class III field but said nothing about `manualReviewStatus`, while the
    // real classifier (`classifyOfflineAdjudicationResponse`) emits
    // SERVER_ACCEPTED only with 'NOT_REQUIRED' and SERVER_REJECTED only with
    // 'REQUIRED'. A synthetic disposition inverting that signal therefore
    // wrote all the way through OP-3 and was reported `applied`.
    //
    // Closed by the canonical parser cross-invariants
    // "SERVER_ACCEPTED requires NOT_REQUIRED" / "SERVER_REJECTED requires
    // REQUIRED" in `privilegedEvidenceTypes.ts`. One source of truth: the
    // parser is already OP-3's write fence, so no writer-side guard
    // duplicates the rule — these two tests prove the fence actually refuses.

    it('an ACCEPTED disposition carrying manualReviewStatus REQUIRED is fenced, not silently applied', async () => {
      const store = createInMemoryReversalStore();
      const claimed = await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 5_000,
      };
      // Canonical in every ACCEPTED-matrix respect EXCEPT the inverted
      // manual-review signal, so the fence is attributable to the new
      // invariant alone: had the parser stayed silent on the field, this
      // would have been persisted as a terminal SERVER_ACCEPTED row.
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'SERVER_ACCEPTED',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: 'ACCEPTED',
        serverRejectionReason: null,
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('fenced');

      // The claimed row is untouched — no terminal accepted row is persisted.
      const rows = await listPrivilegedEvidence(store);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(claimed);
      expect(rows[0]!.syncStatus).toBe('SYNCING');
      expect(rows[0]!.serverVerdict).toBeNull();

      // The consumption half: the real classifier's disposition for the same
      // response applies and parses, so the fence is not merely rejecting
      // every ACCEPTED apply.
      const real = classifyOfflineAdjudicationResponse(response);
      expect(real.manualReviewStatus).toBe('NOT_REQUIRED');
      const applied = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition: real },
        { nowMs: 7_000, staffId: 'staff-1' },
      );
      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') throw new Error('unreachable');
      expect(applied.record.syncStatus).toBe('SERVER_ACCEPTED');
      expect(applied.record.manualReviewStatus).toBe('NOT_REQUIRED');
      expect(parsePrivilegedEvidenceJournalRecordV1(applied.record)).not.toBeNull();
    });

    it('a REJECTED disposition carrying manualReviewStatus NOT_REQUIRED is fenced, not silently applied', async () => {
      const store = createInMemoryReversalStore();
      const claimed = await claimedRow(store, 1);
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'REJECTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        rejectionReason: 'trusted_time_bounds_invalid',
        terminal: true,
        idempotent: false,
        serverAdjudicatedAtMs: 5_000,
      };
      const disposition: OfflineAdjudicationDisposition = {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'SERVER_REJECTED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: 'REJECTED',
        serverRejectionReason: 'trusted_time_bounds_invalid',
        offlineExecutionId: null,
        outcomeKind: null,
      };
      const outcome = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition },
        { nowMs: 6_000, staffId: 'staff-1' },
      );
      expect(outcome.kind).toBe('fenced');

      const rows = await listPrivilegedEvidence(store);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(claimed);
      expect(rows[0]!.syncStatus).toBe('SYNCING');
      expect(rows[0]!.serverVerdict).toBeNull();

      const real = classifyOfflineAdjudicationResponse(response);
      expect(real.manualReviewStatus).toBe('REQUIRED');
      const applied = await applyPrivilegedEvidenceDisposition(
        store,
        envelope().attestationIdHex,
        1,
        { kind: 'server', response, disposition: real },
        { nowMs: 7_000, staffId: 'staff-1' },
      );
      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') throw new Error('unreachable');
      expect(applied.record.syncStatus).toBe('SERVER_REJECTED');
      expect(applied.record.manualReviewStatus).toBe('REQUIRED');
      expect(parsePrivilegedEvidenceJournalRecordV1(applied.record)).not.toBeNull();
    });
  });
});

describe('applyPrivilegedEvidenceDeferredCycleCounts (OP-4)', () => {
  it('increments deferredCycleCount for exactly the given ids', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await applyPrivilegedEvidenceDeferredCycleCounts(store, [envelope().attestationIdHex]);
    const rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.deferredCycleCount).toBe(1);
  });
});

describe('clearPrivilegedEvidenceBackoff', () => {
  it('resets nextAttemptAtMs for non-terminal rows below the ceiling only', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      const raw = await txn.get('privilegedEvidence', envelope().attestationIdHex);
      const rec = parsePrivilegedEvidenceJournalRecordV1(raw)!;
      await txn.put('privilegedEvidence', envelope().attestationIdHex, { ...rec, nextAttemptAtMs: 999_999 });
    });
    await clearPrivilegedEvidenceBackoff(store, 5_000);
    const rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.nextAttemptAtMs).toBe(0);
  });
});

describe('D-3 read contract', () => {
  it('listPrivilegedEvidenceForBranch filters by branch and reports unreadableCount', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope({ verifiedBranchId: 'LDP-001' }), ctx, 1_000);
    await ingestAttestedPrivilegedAction(
      store,
      envelope({ attestationIdHex: 'b'.repeat(32), verifiedBranchId: 'LDP-002' }),
      ctx,
      1_000,
    );
    const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branchId).toBe('LDP-001');
    expect(unreadableCount).toBe(0);
  });

  // N3 Phase 1 — read-only raw unreadable-row diagnostic. Observational only:
  // it surfaces what `enumerateRows` can merely count, and changes nothing.
  describe('listRawUnreadablePrivilegedEvidence — Phase 1 read-only diagnostic', () => {
    const CORRUPT_KEY = 'corrupt-1';
    const CORRUPT_VALUE = { garbage: true, nested: { serverVerdict: 'ACCEPTED' } };

    async function seedRaw(store: ReversalLocalStore, key: string, value: unknown): Promise<void> {
      await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
        await txn.put('privilegedEvidence', key, value);
      });
    }

    async function rawSnapshot(store: ReversalLocalStore): Promise<Array<[string, unknown]>> {
      return store.transact(['privilegedEvidence'], 'readonly', async (txn) => {
        const keys = await txn.getAllKeys!('privilegedEvidence');
        const out: Array<[string, unknown]> = [];
        for (const k of keys) out.push([k, await txn.get('privilegedEvidence', k)]);
        return out;
      });
    }

    // Case A — the exact raw key and the exact raw value are surfaced verbatim.
    it('surfaces an unreadable row as its exact raw key and exact raw value', async () => {
      const store = createInMemoryReversalStore();
      await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);

      const entries = await listRawUnreadablePrivilegedEvidence(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.key).toBe(CORRUPT_KEY);
      expect(entries[0]!.rawValue).toEqual(CORRUPT_VALUE);
      // Nothing nested is promoted to a typed/trusted top-level property.
      expect(Object.keys(entries[0]!).sort()).toEqual(['key', 'rawValue']);
    });

    // Case B — parser-valid rows are never included.
    it('excludes canonical valid rows and returns only the unreadable one', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);

      const entries = await listRawUnreadablePrivilegedEvidence(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.key).toBe(CORRUPT_KEY);
      expect(entries.map((e) => e.key)).not.toContain(envelope().attestationIdHex);
    });

    // Case C — the real reserved key is skipped exactly as enumerateRows skips it.
    it('excludes reserved keys even when their raw value would not parse as a row', async () => {
      const store = createInMemoryReversalStore();
      await seedRaw(store, PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY, { generation: 7 });
      await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);

      const entries = await listRawUnreadablePrivilegedEvidence(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.key).toBe(CORRUPT_KEY);
      expect(entries.map((e) => e.key)).not.toContain(PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY);
    });

    // Case D — strictly read-only: the raw store is byte-identical afterwards.
    it('mutates nothing — every raw key and value is unchanged after the call', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);
      await seedRaw(store, PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY, { generation: 7 });

      const before = await rawSnapshot(store);
      await listRawUnreadablePrivilegedEvidence(store);
      const after = await rawSnapshot(store);

      expect(after).toEqual(before);
      expect(after).toHaveLength(before.length); // no row added, none deleted
    });

    // Case E — the diagnostic unblocks nothing; fail-closed behavior is intact.
    it('does not unblock the store — fail-closed behavior is identical before and after', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);

      const beforeRead = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(beforeRead.unreadableCount).toBe(1);

      await listRawUnreadablePrivilegedEvidence(store);

      const afterRead = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(afterRead.unreadableCount).toBe(1);
      expect(afterRead.rows).toHaveLength(1);
      // The opted-in ingest guard still refuses, exactly as before the call.
      const outcome = await ingestAttestedPrivilegedAction(
        store,
        envelope({ attestationIdHex: 'c'.repeat(32), targetOrderId: 'order-9', localIntentId: 'intent-9' }),
        { ...ctx, expectNoOpenRowForTarget: true },
        2_000,
      );
      expect(outcome).toEqual({ kind: 'unreadable' });
    });
  });

  it('subscribePrivilegedEvidenceStore notifies same-tab listeners on mutation', async () => {
    const store = createInMemoryReversalStore();
    const seen: number[] = [];
    const unsubscribe = subscribePrivilegedEvidenceStore((rows) => seen.push(rows.length));
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
    unsubscribe();
  });
});

describe('Claude N-3 write-fence — status-aware containment + canonical parser fence', () => {
  /**
   * Gemini-084 / Claude-068. Both containment writers spread a parser-valid
   * source row and force a LOCAL_TERMINAL shape. On a server-adjudicated
   * source the 9 inherited Class III fields survive that spread into a shape
   * the parser refuses twice over (the LOCAL_TERMINAL matrix requires
   * `isNull(...ALL_SERVER_FIELDS)`, and the serverVerdict cross-invariant
   * admits a non-null verdict only under ACCEPTED/REJECTED), and neither
   * writer re-parsed before `txn.put`. A persisted invalid row is then dropped
   * by `enumerateRows` and fails every consumer closed store-wide.
   */

  /** The 9 Class III server-owned fields, as a comparable snapshot. */
  function serverEvidenceOf(row: PrivilegedEvidenceJournalRecordV1) {
    return {
      serverVerdict: row.serverVerdict,
      serverReason: row.serverReason,
      serverAdjudicationId: row.serverAdjudicationId,
      serverTargetOrderId: row.serverTargetOrderId,
      offlineExecutionId: row.offlineExecutionId,
      outcomeKind: row.outcomeKind,
      serverAdjudicatedAtMs: row.serverAdjudicatedAtMs,
      serverObservedAtMs: row.serverObservedAtMs,
      serverIdempotentReplay: row.serverIdempotentReplay,
    };
  }

  async function readRow(store: ReversalLocalStore): Promise<unknown> {
    return store.transact(['privilegedEvidence'], 'readonly', (txn) =>
      txn.get('privilegedEvidence', envelope().attestationIdHex),
    );
  }

  /** Desynchronizes the stored digest from the row's own binding bytes. */
  async function corruptDigest(store: ReversalLocalStore): Promise<void> {
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      const raw = await txn.get('privilegedEvidence', envelope().attestationIdHex);
      const rec = parsePrivilegedEvidenceJournalRecordV1(raw)!;
      await txn.put('privilegedEvidence', envelope().attestationIdHex, { ...rec, evidenceBindingDigest: 'corrupted' });
    });
  }

  describe('binding-conflict writer (ingest)', () => {
    it('A. a SERVER_REJECTED source survives a conflicting re-ingest as a readable row with its server evidence intact', async () => {
      const store = createInMemoryReversalStore();
      await driveToStatus(store, 'SERVER_REJECTED');
      const before = (await listPrivilegedEvidence(store))[0]!;
      expect(before.syncStatus).toBe('SERVER_REJECTED');
      expect(before.serverVerdict).toBe('REJECTED');

      const outcome = await ingestAttestedPrivilegedAction(store, envelope({ paa1Base64: 'TAMPERED' }), ctx, 7_000);
      expect(outcome.kind).toBe('binding_conflict');

      // The load-bearing assertion: the persisted row still parses. Before the
      // fence this row was dropped by `enumerateRows` and the whole privileged
      // path failed closed store-wide.
      const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(unreadableCount).toBe(0);
      expect(rows).toHaveLength(1);

      const after = rows[0]!;
      // Terminal semantics preserved — never relabelled LOCAL_TERMINAL.
      expect(after.syncStatus).toBe('SERVER_REJECTED');
      expect(after.manualReviewStatus).toBe('REQUIRED');
      expect(after.lastDispositionKind).toBe('REJECTED');
      expect(after.localTerminalReason).toBeNull();
      // No Class III evidence silently nulled.
      expect(serverEvidenceOf(after)).toEqual(serverEvidenceOf(before));
      // Containment metadata is the only change, plus updatedAtMs.
      expect(after.integrityConflict).toBe(true);
      expect(after.updatedAtMs).toBe(7_000);
      // Original bytes preserved verbatim; the conflicting bytes are discarded.
      expect(after.paa1Base64).toBe('PAA1');
    });

    it.each([['SERVER_ACCEPTED'], ['MANUAL_ATTENTION']] as const)(
      'B. a %s source is contained without losing its disposition or server evidence',
      async (status) => {
        const store = createInMemoryReversalStore();
        await driveToStatus(store, status);
        const before = (await listPrivilegedEvidence(store))[0]!;

        const outcome = await ingestAttestedPrivilegedAction(store, envelope({ ssa1Base64: 'TAMPERED' }), ctx, 7_000);
        expect(outcome.kind).toBe('binding_conflict');

        const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
        expect(unreadableCount).toBe(0);
        expect(rows).toHaveLength(1);

        const after = rows[0]!;
        expect(after.syncStatus).toBe(status);
        expect(after.manualReviewStatus).toBe(before.manualReviewStatus);
        expect(after.lastDispositionKind).toBe(before.lastDispositionKind);
        expect(after.localTerminalReason).toBe(before.localTerminalReason);
        expect(serverEvidenceOf(after)).toEqual(serverEvidenceOf(before));
        expect(after.integrityConflict).toBe(true);
      },
    );

    it('C. a queued source keeps the existing forced LOCAL_TERMINAL containment exactly', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      const outcome = await ingestAttestedPrivilegedAction(store, envelope({ paa1Base64: 'TAMPERED' }), ctx, 2_000);
      expect(outcome.kind).toBe('binding_conflict');

      const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(unreadableCount).toBe(0);
      expect(rows).toHaveLength(1);

      const after = rows[0]!;
      expect(after.integrityConflict).toBe(true);
      expect(after.syncStatus).toBe('MANUAL_ATTENTION');
      expect(after.manualReviewStatus).toBe('REQUIRED');
      expect(after.localTerminalReason).toBe('journal_binding_conflict');
      expect(after.lastDispositionKind).toBe('LOCAL_TERMINAL');
      expect(after.claimOwner).toBeNull();
      expect(after.claimGeneration).toBeNull();
      expect(after.paa1Base64).toBe('PAA1'); // original, never overwritten
    });
  });

  describe('digest-mismatch writer (claim)', () => {
    it('D. a server-terminal source reaching the exported claim directly is contained without evidence loss', async () => {
      const store = createInMemoryReversalStore();
      await driveToStatus(store, 'SERVER_REJECTED');
      await corruptDigest(store);
      const before = (await listPrivilegedEvidence(store))[0]!;

      const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 8_000,
        staffId: 'staff-1',
      });
      expect(outcome.kind).toBe('digest_mismatch');

      const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(unreadableCount).toBe(0);
      expect(rows).toHaveLength(1);

      const after = rows[0]!;
      expect(after.syncStatus).toBe('SERVER_REJECTED');
      expect(after.manualReviewStatus).toBe('REQUIRED');
      expect(after.lastDispositionKind).toBe('REJECTED');
      expect(after.localTerminalReason).toBeNull();
      expect(serverEvidenceOf(after)).toEqual(serverEvidenceOf(before));
      expect(after.integrityConflict).toBe(true);
    });

    it('E. a queued source keeps the existing forced LOCAL_TERMINAL digest-mismatch behavior exactly', async () => {
      const store = createInMemoryReversalStore();
      await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
      await corruptDigest(store);

      const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 1_000,
        staffId: 'staff-1',
      });
      expect(outcome.kind).toBe('digest_mismatch');
      if (outcome.kind !== 'digest_mismatch') throw new Error('unreachable');
      expect(outcome.record.syncStatus).toBe('MANUAL_ATTENTION');
      expect(outcome.record.manualReviewStatus).toBe('REQUIRED');
      expect(outcome.record.localTerminalReason).toBe('evidence_binding_digest_mismatch');
      expect(outcome.record.lastDispositionKind).toBe('LOCAL_TERMINAL');
      expect(outcome.record.paa1Base64).toBe('PAA1');
      // RC-D2-003: a failed claim writes neither relay/attempt provenance field.
      expect(outcome.record.lastRelayCallerStaffId).toBeNull();

      const { unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(unreadableCount).toBe(0);
    });
  });

  describe('F. canonical parser fence fails closed', () => {
    // Narrowest available seam that survives status-aware normalization: both
    // writers stamp `updatedAtMs` from a caller-supplied clock, and the parser
    // requires it to be > 0. No test-only production hook is introduced.
    it('binding-conflict: an unparseable candidate is not written, the source is unchanged, and the result is unreadable', async () => {
      const store = createInMemoryReversalStore();
      await driveToStatus(store, 'SERVER_REJECTED');
      const before = await readRow(store);

      const outcome = await ingestAttestedPrivilegedAction(store, envelope({ paa1Base64: 'TAMPERED' }), ctx, 0);
      expect(outcome.kind).toBe('unreadable');

      // Source row byte-unchanged; nothing invalid reached the store.
      expect(await readRow(store)).toEqual(before);
      const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(unreadableCount).toBe(0);
      expect(rows[0]!.integrityConflict).toBe(false);
      expect(rows[0]!.syncStatus).toBe('SERVER_REJECTED');
    });

    it('digest-mismatch: an unparseable candidate is not written, the source is unchanged, and the result is not_eligible', async () => {
      const store = createInMemoryReversalStore();
      await driveToStatus(store, 'SERVER_REJECTED');
      await corruptDigest(store);
      const before = await readRow(store);

      const outcome = await claimPrivilegedEvidenceRow(store, envelope().attestationIdHex, 1, {
        deviceId: 'd1',
        nowMs: 0,
        staffId: 'staff-1',
      });
      expect(outcome.kind).toBe('not_eligible');

      expect(await readRow(store)).toEqual(before);
      const { unreadableCount } = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
      expect(unreadableCount).toBe(0);
    });
  });
});

// ─── SEC-001 N3 Phase 2 — operator-mediated unreadable-row recovery ─────────
//
// Capture-then-delete, one explicit act at a time, into the EXISTING `rejections`
// store. Nothing here runs automatically, nothing repairs a row, and a row whose
// raw bytes expose server adjudication is refused outright (C2 support-only).

describe('N3 Phase 2 — classifyRawUnreadablePrivilegedEvidence', () => {
  it('flags a present, non-null top-level serverVerdict', () => {
    expect(classifyRawUnreadablePrivilegedEvidence({ serverVerdict: 'ACCEPTED' })).toBe(
      'server_evidence_present',
    );
  });

  it('flags serverAdjudicationId and serverAdjudicatedAtMs too', () => {
    expect(classifyRawUnreadablePrivilegedEvidence({ serverAdjudicationId: 'adj-1' })).toBe(
      'server_evidence_present',
    );
    expect(classifyRawUnreadablePrivilegedEvidence({ serverAdjudicatedAtMs: 5_000 })).toBe(
      'server_evidence_present',
    );
  });

  it('a present-but-null probe field is not server evidence', () => {
    expect(
      classifyRawUnreadablePrivilegedEvidence({
        serverVerdict: null,
        serverAdjudicationId: null,
        serverAdjudicatedAtMs: null,
      }),
    ).toBe('no_server_evidence_detected');
  });

  // NEGATIVE CONTROL — the classifier must never become a recursive scanner:
  // arbitrary garbage that merely CONTAINS the word somewhere deeper is Class D,
  // and treating it as server evidence would strand it forever.
  it('a nested serverVerdict is NOT server evidence (no recursive descent)', () => {
    expect(
      classifyRawUnreadablePrivilegedEvidence({ garbage: true, nested: { serverVerdict: 'ACCEPTED' } }),
    ).toBe('no_server_evidence_detected');
  });

  it('non-objects and inherited properties are never server evidence', () => {
    expect(classifyRawUnreadablePrivilegedEvidence(null)).toBe('no_server_evidence_detected');
    expect(classifyRawUnreadablePrivilegedEvidence('serverVerdict')).toBe('no_server_evidence_detected');
    expect(classifyRawUnreadablePrivilegedEvidence(42)).toBe('no_server_evidence_detected');
    const inherited = Object.create({ serverVerdict: 'ACCEPTED' }) as Record<string, unknown>;
    expect(classifyRawUnreadablePrivilegedEvidence(inherited)).toBe('no_server_evidence_detected');
  });
});

describe('N3 Phase 2 — discardUnreadablePrivilegedEvidenceRow', () => {
  const NOW = 9_000_000;
  const CORRUPT_KEY = 'corrupt-1';
  const CORRUPT_VALUE = { garbage: true, nested: { serverVerdict: 'ACCEPTED' } };

  function discardInput(over: Record<string, unknown> = {}) {
    return {
      key: CORRUPT_KEY,
      actorStaffId: 'mgr-1',
      actorRole: 'manager',
      branchId: 'LDP-001',
      deviceId: 'dev-1',
      reasonCode: 'unreadable_row_support_cleared',
      nowMs: NOW,
      ...over,
    } as Parameters<typeof discardUnreadablePrivilegedEvidenceRow>[1];
  }

  async function seedRaw(store: ReversalLocalStore, key: string, value: unknown): Promise<void> {
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', key, value);
    });
  }

  async function rawSnapshot(store: ReversalLocalStore): Promise<Array<[string, unknown]>> {
    return store.transact(['privilegedEvidence'], 'readonly', async (txn) => {
      const keys = await txn.getAllKeys!('privilegedEvidence');
      const out: Array<[string, unknown]> = [];
      for (const k of keys) out.push([k, await txn.get('privilegedEvidence', k)]);
      return out;
    });
  }

  async function rejectionsSnapshot(store: ReversalLocalStore): Promise<unknown[]> {
    return store.transact(['rejections'], 'readonly', (txn) => txn.getAll('rejections'));
  }

  /** Decorator whose `delete` always throws — models a storage fault mid-transaction. */
  function failingDeleteStore(inner: ReversalLocalStore): ReversalLocalStore {
    return {
      transact<T>(
        stores: ReversalStoreName[],
        mode: 'readonly' | 'readwrite',
        fn: (txn: ReversalTxn) => Promise<T>,
      ): Promise<T> {
        return inner.transact(stores, mode, (txn) =>
          fn({
            ...txn,
            delete: async () => {
              throw new Error('induced storage fault');
            },
          }),
        );
      },
    };
  }

  // Case 1 — surgical removal.
  it('removes only the targeted unreadable row; valid rows and the reserved key are untouched', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await allocatePrivilegedSweepGeneration(store); // writes the reserved generation key
    await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);
    const validBefore = await listPrivilegedEvidence(store);
    const reservedBefore = await store.transact(['privilegedEvidence'], 'readonly', (txn) =>
      txn.get('privilegedEvidence', PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY),
    );

    const outcome = await discardUnreadablePrivilegedEvidenceRow(store, discardInput());

    expect(outcome.kind).toBe('discarded');
    if (outcome.kind !== 'discarded') return;
    expect(outcome.key).toBe(CORRUPT_KEY);
    expect(outcome.classification).toBe('no_server_evidence_detected');
    expect(await listRawUnreadablePrivilegedEvidence(store)).toEqual([]);
    expect(await listPrivilegedEvidence(store)).toEqual(validBefore);
    expect(
      await store.transact(['privilegedEvidence'], 'readonly', (txn) =>
        txn.get('privilegedEvidence', PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY),
      ),
    ).toEqual(reservedBefore);
  });

  // Case 2 — a capture must never be overwritten to make room for a capture.
  it('refuses on capture-key collision and deletes nothing', async () => {
    const store = createInMemoryReversalStore();
    await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);
    const first = await discardUnreadablePrivilegedEvidenceRow(store, discardInput());
    expect(first.kind).toBe('discarded');
    if (first.kind !== 'discarded') return;

    // Re-seed the same key and replay at the SAME injected clock → same capture id.
    await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);
    const before = await rawSnapshot(store);
    const second = await discardUnreadablePrivilegedEvidenceRow(store, discardInput());

    expect(second).toEqual({ kind: 'refused', reason: 'capture_key_collision' });
    expect(await rawSnapshot(store)).toEqual(before);
    expect(await listDiscardedPrivilegedEvidenceCaptures(store)).toHaveLength(1);
  });

  // Case 3 — atomicity: a fault after the capture put must roll the capture back too.
  it('a storage fault during capture-then-delete leaves the row intact AND writes no capture', async () => {
    const inner = createInMemoryReversalStore();
    await seedRaw(inner, CORRUPT_KEY, CORRUPT_VALUE);
    const before = await rawSnapshot(inner);

    const outcome = await discardUnreadablePrivilegedEvidenceRow(
      failingDeleteStore(inner),
      discardInput(),
    );

    expect(outcome).toEqual({ kind: 'refused', reason: 'capture_failed' });
    expect(await rawSnapshot(inner)).toEqual(before);
    expect(await rejectionsSnapshot(inner)).toEqual([]);
    expect(await listDiscardedPrivilegedEvidenceCaptures(inner)).toEqual([]);
  });

  // Case 4 — the point of the whole packet: the device actually unblocks.
  it('after the last discard unreadableCount returns to 0 and the branch read is healthy again', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);
    await seedRaw(store, 'corrupt-2', { alsoGarbage: 1 });
    expect((await listPrivilegedEvidenceForBranch(store, 'LDP-001')).unreadableCount).toBe(2);

    for (const key of [CORRUPT_KEY, 'corrupt-2']) {
      const outcome = await discardUnreadablePrivilegedEvidenceRow(
        store,
        discardInput({ key, nowMs: NOW + key.length }),
      );
      expect(outcome.kind).toBe('discarded');
    }

    const healthy = await listPrivilegedEvidenceForBranch(store, 'LDP-001');
    expect(healthy.unreadableCount).toBe(0);
    expect(healthy.rows).toHaveLength(1);
    expect(await listRawUnreadablePrivilegedEvidence(store)).toEqual([]);
  });

  // Case 5 — C2: support escalation only. No acknowledgement, no override, no bypass.
  it('a top-level non-null serverVerdict is hard-refused — no capture, no delete', async () => {
    const store = createInMemoryReversalStore();
    const serverish = { serverVerdict: 'ACCEPTED', broken: true };
    await seedRaw(store, 'server-ish-1', serverish);

    const outcome = await discardUnreadablePrivilegedEvidenceRow(
      store,
      discardInput({ key: 'server-ish-1' }),
    );

    expect(outcome).toEqual({ kind: 'refused', reason: 'server_evidence_present' });
    expect(await rawSnapshot(store)).toEqual([['server-ish-1', serverish]]);
    expect(await rejectionsSnapshot(store)).toEqual([]);
  });

  // Case 6 — the capture is the bytes, not a reconstruction of them.
  it('captures the exact raw key and raw value with no normalization', async () => {
    const store = createInMemoryReversalStore();
    const weird = {
      garbage: true,
      list: [1, 'two', { three: null }],
      attestationIdHex: 'NOT-HEX',
      deep: { deeper: { deepest: 'x' } },
    };
    await seedRaw(store, 'weird-key-1', weird);

    const outcome = await discardUnreadablePrivilegedEvidenceRow(
      store,
      discardInput({ key: 'weird-key-1', note: '  reviewed  ' }),
    );
    expect(outcome.kind).toBe('discarded');

    const [capture] = await listDiscardedPrivilegedEvidenceCaptures(store);
    expect(capture.captureKind).toBe(PRIVILEGED_EVIDENCE_DISCARD_CAPTURE_KIND);
    expect(capture.sourceStore).toBe('privilegedEvidence');
    expect(capture.rawKey).toBe('weird-key-1');
    expect(capture.rawValue).toEqual(weird);
    expect(capture.classification).toBe('no_server_evidence_detected');
    expect(capture.branchId).toBe('LDP-001');
    expect(capture.deviceId).toBe('dev-1');
    expect(capture.actorStaffId).toBe('mgr-1');
    expect(capture.actorRole).toBe('manager');
    expect(capture.reasonCode).toBe('unreadable_row_support_cleared');
    expect(capture.note).toBe('reviewed');
    expect(capture.discardedAtMs).toBe(NOW);
    // Branch/device are the ACTING context — never laundered out of the raw value.
    expect(Object.prototype.hasOwnProperty.call(weird, 'branchId')).toBe(false);
  });

  // Case 8 — a parser-valid row is never deletable through the recovery path.
  it('refuses a readable row and leaves it byte-identical', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const before = await rawSnapshot(store);

    const outcome = await discardUnreadablePrivilegedEvidenceRow(
      store,
      discardInput({ key: envelope().attestationIdHex }),
    );

    expect(outcome).toEqual({ kind: 'refused', reason: 'readable_row' });
    expect(await rawSnapshot(store)).toEqual(before);
    expect(await rejectionsSnapshot(store)).toEqual([]);
  });

  // Case 9 — the authority / scope / target refusal matrix, each with zero mutation.
  it('refuses staff, blank reason, missing scope, a reserved key and an absent key — no mutation on any path', async () => {
    const store = createInMemoryReversalStore();
    await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);
    const before = await rawSnapshot(store);

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ actorRole: 'staff' }, 'unauthorized'],
      [{ actorRole: 'cashier' }, 'unauthorized'],
      [{ actorStaffId: '   ' }, 'unauthorized'],
      [{ reasonCode: '   ' }, 'missing_reason'],
      [{ branchId: '  ' }, 'scope_unavailable'],
      [{ deviceId: '' }, 'scope_unavailable'],
      [{ key: PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY }, 'reserved_key'],
      [{ key: 'does-not-exist' }, 'not_found'],
    ];

    for (const [over, reason] of cases) {
      expect(await discardUnreadablePrivilegedEvidenceRow(store, discardInput(over))).toEqual({
        kind: 'refused',
        reason,
      });
    }

    expect(await rawSnapshot(store)).toEqual(before);
    expect(await rejectionsSnapshot(store)).toEqual([]);
  });

  // Case 10 — listeners fire on a real removal only.
  it('notifies privileged-evidence listeners after a successful discard, and never on a refusal', async () => {
    const store = createInMemoryReversalStore();
    await seedRaw(store, CORRUPT_KEY, CORRUPT_VALUE);

    const seen: number[] = [];
    const unsubscribe = subscribePrivilegedEvidenceStore((rows) => seen.push(rows.length));
    try {
      await discardUnreadablePrivilegedEvidenceRow(store, discardInput({ actorRole: 'staff' }));
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual([]);

      const outcome = await discardUnreadablePrivilegedEvidenceRow(store, discardInput());
      expect(outcome.kind).toBe('discarded');
      await new Promise((r) => setTimeout(r, 0));
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  // Case 11 — read-back + export read the STORED capture, never the live row.
  it('reads captures back newest-first and exports the stored capture through the FilePort', async () => {
    const store = createInMemoryReversalStore();
    await seedRaw(store, 'older', { a: 1 });
    await seedRaw(store, 'newer', { b: 2 });
    await discardUnreadablePrivilegedEvidenceRow(store, discardInput({ key: 'older', nowMs: 1_000 }));
    await discardUnreadablePrivilegedEvidenceRow(store, discardInput({ key: 'newer', nowMs: 2_000 }));

    const captures = await listDiscardedPrivilegedEvidenceCaptures(store);
    expect(captures.map((c) => c.rawKey)).toEqual(['newer', 'older']);

    const saved: Array<{ name: string; mime: string; contents: string }> = [];
    const port = {
      saveTextFile: (name: string, mime: string, contents: string) =>
        void saved.push({ name, mime, contents }),
    };
    expect(
      await exportDiscardedPrivilegedEvidenceCapture(store, captures[0].captureRecordId, port),
    ).toBe('exported');
    expect(saved).toHaveLength(1);
    expect(saved[0].name).not.toContain('newer'); // no untrusted bytes in the filename
    const parsed = JSON.parse(saved[0].contents) as { rawKey: string; rawValue: unknown };
    expect(parsed.rawKey).toBe('newer');
    expect(parsed.rawValue).toEqual({ b: 2 });

    // The store is untouched by an export, and an unknown id is a plain miss.
    expect(await exportDiscardedPrivilegedEvidenceCapture(store, 'no-such-capture', port)).toBe(
      'not_found',
    );
    expect(saved).toHaveLength(1);
    expect(await listDiscardedPrivilegedEvidenceCaptures(store)).toHaveLength(2);
  });

  // Ordinary reversal-rejection rows share `rejections`; the capture reader must not claim them.
  it('never returns a foreign rejections-store row as a recovery capture', async () => {
    const store = createInMemoryReversalStore();
    await store.transact(['rejections'], 'readwrite', async (txn) => {
      await txn.put('rejections', 'rej-1', {
        recordId: 'rej-1',
        sourceType: 'transfer',
        sourceId: 'TR-1',
        branchId: 'b1',
        evidenceCode: 'x',
        evidenceMessage: 'y',
        createdAt: '2026-06-12T09:00:00.000Z',
      });
    });
    expect(await listDiscardedPrivilegedEvidenceCaptures(store)).toEqual([]);
  });
});

// Case 12 — REAL IndexedDB proof (fake-indexeddb, the repo's authorized harness).
// The in-memory double models abort-on-throw, but the multi-store transaction,
// its auto-commit ordering and an out-of-line-key delete are only genuinely
// exercised against a real IDB implementation.
describe('N3 Phase 2 — real IndexedDB capture/delete atomicity', () => {
  const REAL_KEY = 'real-corrupt-1';
  const REAL_VALUE = { garbage: true, from: 'real-idb' };

  function realInput(over: Record<string, unknown> = {}) {
    return {
      key: REAL_KEY,
      actorStaffId: 'mgr-9',
      actorRole: 'admin',
      branchId: 'LDP-001',
      deviceId: 'dev-real',
      reasonCode: 'real_idb_proof',
      nowMs: 4_242_000,
      ...over,
    } as Parameters<typeof discardUnreadablePrivilegedEvidenceRow>[1];
  }

  async function clearRealStores(store: ReversalLocalStore): Promise<void> {
    await store.transact(['privilegedEvidence', 'rejections'], 'readwrite', async (txn) => {
      for (const name of ['privilegedEvidence', 'rejections'] as const) {
        for (const key of await txn.getAllKeys!(name)) await txn.delete(name, key);
      }
    });
  }

  it('commits the capture and the raw-row delete together, and rolls both back on a fault', async () => {
    const store = createIndexedDbReversalStore();
    await clearRealStores(store);
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', REAL_KEY, REAL_VALUE);
    });
    expect(await listRawUnreadablePrivilegedEvidence(store)).toEqual([
      { key: REAL_KEY, rawValue: REAL_VALUE },
    ]);

    // (a) Injected fault → BOTH the capture and the delete are discarded.
    const faulting: ReversalLocalStore = {
      transact<T>(
        stores: ReversalStoreName[],
        mode: 'readonly' | 'readwrite',
        fn: (txn: ReversalTxn) => Promise<T>,
      ): Promise<T> {
        return store.transact(stores, mode, (txn) =>
          fn({
            ...txn,
            delete: async () => {
              throw new Error('induced real-idb fault');
            },
          }),
        );
      },
    };
    expect(await discardUnreadablePrivilegedEvidenceRow(faulting, realInput())).toEqual({
      kind: 'refused',
      reason: 'capture_failed',
    });
    expect(await listRawUnreadablePrivilegedEvidence(store)).toEqual([
      { key: REAL_KEY, rawValue: REAL_VALUE },
    ]);
    expect(await listDiscardedPrivilegedEvidenceCaptures(store)).toEqual([]);

    // (b) Clean run → the out-of-line key is deleted and the capture is committed,
    //     in one multi-store transaction over privilegedEvidence + rejections.
    const outcome = await discardUnreadablePrivilegedEvidenceRow(store, realInput());
    expect(outcome.kind).toBe('discarded');
    expect(await listRawUnreadablePrivilegedEvidence(store)).toEqual([]);
    const captures = await listDiscardedPrivilegedEvidenceCaptures(store);
    expect(captures).toHaveLength(1);
    expect(captures[0].rawKey).toBe(REAL_KEY);
    expect(captures[0].rawValue).toEqual(REAL_VALUE);

    await clearRealStores(store);
  });
});
