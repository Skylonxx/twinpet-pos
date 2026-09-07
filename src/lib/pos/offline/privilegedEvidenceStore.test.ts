import { describe, expect, it } from 'vitest';
import { createInMemoryReversalStore, type ReversalLocalStore } from './reversalLocalStore';
import type { OfflineAttestationEnvelope } from '../../auth/privilegedAction/offlineAttestation';
import type {
  OfflineAdjudicationDisposition,
  OfflineAdjudicationResponse,
} from '../../auth/privilegedAction/offlineAdjudicationTransport';
import { classifyOfflineAdjudicationResponse } from '../../auth/privilegedAction/offlineAdjudicationTransport';
import {
  PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
  parsePrivilegedEvidenceJournalRecordV1,
} from './privilegedEvidenceTypes';
import {
  allocatePrivilegedSweepGeneration,
  applyPrivilegedEvidenceDeferredCycleCounts,
  applyPrivilegedEvidenceDisposition,
  claimPrivilegedEvidenceRow,
  clearPrivilegedEvidenceBackoff,
  computeEvidenceBindingDigest,
  ingestAttestedPrivilegedAction,
  listPrivilegedEvidence,
  listPrivilegedEvidenceForBranch,
  subscribePrivilegedEvidenceStore,
} from './privilegedEvidenceStore';

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

  it('never creates a resultingVoidIntentId (D-2 never writes a PK-3 voidIntents row)', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.record.resultingVoidIntentId).toBeNull();
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

    it('retryable apply consumes disposition-carried lifecycle fields rather than duplicating hard-coded constants', async () => {
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
      // A deliberately distinguishable `manualReviewStatus` the real
      // classifier never produces for a retryable disposition (always
      // 'NOT_REQUIRED') — the parser's matrix does not constrain it for a
      // retryable kind, so this proves the writer reads `disposition`
      // rather than matching today's hard-coded 'NOT_REQUIRED' constant.
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
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') throw new Error('unreachable');
      expect(outcome.record.manualReviewStatus).toBe('RESOLVED');
      expect(outcome.record.lastDispositionKind).toBe('RETRYABLE');
      expect(parsePrivilegedEvidenceJournalRecordV1(outcome.record)).not.toBeNull();
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
