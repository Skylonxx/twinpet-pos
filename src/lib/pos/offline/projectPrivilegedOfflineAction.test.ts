import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryReversalStore, type ReversalLocalStore } from './reversalLocalStore';
import {
  __setCanonicalSyncContextForTests,
  __resetCanonicalSyncContextForTests,
} from './canonicalSyncContext';
import { allocatePrivilegedSweepGeneration, claimPrivilegedEvidenceRow, listPrivilegedEvidence } from './privilegedEvidenceStore';
import { parsePrivilegedEvidenceJournalRecordV1 } from './privilegedEvidenceTypes';
import type { OfflineAttestationEnvelope, RequestOfflineAttestationInput } from '../../auth/privilegedAction/offlineAttestation';
import { requestOfflineAttestation as realRequestOfflineAttestation } from '../../auth/privilegedAction/offlineAttestation';
import {
  projectPrivilegedOfflineAction,
  type ProjectPrivilegedOfflineActionInput,
} from './projectPrivilegedOfflineAction';
import adapterSourceRaw from './projectPrivilegedOfflineAction.ts?raw';

/**
 * RC-D3-001 — the production export is exactly one argument and closes over
 * the real canonical-sync context, the real durable-store factory, the real
 * D-1B attestation, and the real D-2 ingest. There is no public runtime
 * authority/durability override surface, so every test below drives the
 * production seam through:
 *   - `__setCanonicalSyncContextForTests` (a landed, pre-existing test-only
 *     seam in `canonicalSyncContext.ts` — not part of this adapter's public
 *     API and unreachable by any production caller of this adapter),
 *   - `vi.mock` substitutions of the SAME modules the adapter itself
 *     imports (`./reversalLocalStore`'s store factory, D-1B's
 *     `requestOfflineAttestation`, D-2's `ingestAttestedPrivilegedAction`
 *     and `listPrivilegedEvidenceForBranch`), controlled per-test through
 *     `vi.hoisted` mutable state,
 *   - `vi.spyOn(Date, 'now')` for deterministic timestamps.
 * None of this is reachable from `projectPrivilegedOfflineAction(input)`
 * itself — a production caller has no way to pass any of it in.
 */

type RealIngestFn = typeof import('./privilegedEvidenceStore').ingestAttestedPrivilegedAction;
type RealListBranchEvidenceFn = typeof import('./privilegedEvidenceStore').listPrivilegedEvidenceForBranch;

const state = vi.hoisted(() => ({
  store: null as ReversalLocalStore | null,
  requestAttestationOverride: null as
    | ((input: RequestOfflineAttestationInput) => ReturnType<typeof realRequestOfflineAttestation>)
    | null,
  ingestOverride: null as RealIngestFn | null,
  listBranchEvidenceOverride: null as RealListBranchEvidenceFn | null,
  // Populated by the `./privilegedEvidenceStore` mock factory below with the
  // TRUE unmocked implementations — tests that want to run the real durable
  // path (while still overriding attestation, etc.) call these directly,
  // never the mocked named export, which would otherwise recurse back into
  // whichever override is currently set.
  realIngest: null as RealIngestFn | null,
  realListBranchEvidence: null as RealListBranchEvidenceFn | null,
}));

vi.mock('./reversalLocalStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reversalLocalStore')>();
  return {
    ...actual,
    createIndexedDbReversalStore: () => {
      if (!state.store) throw new Error('test store not configured');
      return state.store;
    },
  };
});

vi.mock('../../auth/privilegedAction/offlineAttestation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/privilegedAction/offlineAttestation')>();
  return {
    ...actual,
    requestOfflineAttestation: (input: RequestOfflineAttestationInput) =>
      (state.requestAttestationOverride ?? actual.requestOfflineAttestation)(input),
  };
});

vi.mock('./privilegedEvidenceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./privilegedEvidenceStore')>();
  state.realIngest = actual.ingestAttestedPrivilegedAction;
  state.realListBranchEvidence = actual.listPrivilegedEvidenceForBranch;
  return {
    ...actual,
    ingestAttestedPrivilegedAction: (...args: Parameters<typeof actual.ingestAttestedPrivilegedAction>) =>
      (state.ingestOverride ?? actual.ingestAttestedPrivilegedAction)(...args),
    listPrivilegedEvidenceForBranch: (...args: Parameters<typeof actual.listPrivilegedEvidenceForBranch>) =>
      (state.listBranchEvidenceOverride ?? actual.listPrivilegedEvidenceForBranch)(...args),
  };
});

function realIngestAttestedPrivilegedAction(...args: Parameters<RealIngestFn>): ReturnType<RealIngestFn> {
  if (!state.realIngest) throw new Error('real ingest not captured yet');
  return state.realIngest(...args);
}

const BRANCH_ID = 'LDP-001';
const DEVICE_ID = 'device-1';

function setContext(branchId: string | null = BRANCH_ID, deviceId: string | null = DEVICE_ID) {
  __setCanonicalSyncContextForTests(branchId, deviceId);
}

beforeEach(() => {
  state.store = createInMemoryReversalStore();
  state.requestAttestationOverride = null;
  state.ingestOverride = null;
  state.listBranchEvidenceOverride = null;
  setContext();
});

afterEach(() => {
  __resetCanonicalSyncContextForTests();
  vi.restoreAllMocks();
});

function currentStore(): ReversalLocalStore {
  if (!state.store) throw new Error('test store not configured');
  return state.store;
}

function baseInput(over: Partial<ProjectPrivilegedOfflineActionInput> = {}): ProjectPrivilegedOfflineActionInput {
  return {
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    managerStaffId: 'mgr-1',
    pin: '123456',
    localIntentId: 'intent-1',
    initiatingStaffId: 'staff-cashier-1',
    ...over,
  };
}

function envelopeFor(
  input: ProjectPrivilegedOfflineActionInput,
  attestationIdHex: string,
  over: Partial<OfflineAttestationEnvelope> = {},
): OfflineAttestationEnvelope {
  return {
    attestationIdHex,
    paa1Base64: `PAA1-${attestationIdHex}`,
    ssa1Base64: `SSA1-${attestationIdHex}`,
    oacEnvelopeBytesBase64: `OAC1-${attestationIdHex}`,
    verifiedBranchId: BRANCH_ID,
    evidenceSeed: {
      oacId: 'oac-1',
      oacSchemaVersion: 1,
      revocationEpochAtIssue: 0,
      managerAuthVersionAtIssue: 0,
      managerCredentialVersionAtIssue: 0,
      nonce: `nonce-${attestationIdHex}`,
      attemptCount: 1,
      approvalResult: 'APPROVED_LOCAL',
      approvalProofDigest: `proof-${attestationIdHex}`,
    },
    trustedApprovalLowerMs: 1_000,
    trustedApprovalUpperMs: 2_000,
    pendingExecutionExpiresAtMs: 100_000,
    localIntentId: input.localIntentId,
    actionId: input.actionId,
    targetOrderId: input.targetOrderId,
    targetOrderUtc7Date: input.targetOrderUtc7Date,
    approvingManagerStaffId: input.managerStaffId,
    ...over,
  };
}

/** Deterministic, non-zero, lowercase-hex 32-char id derived from `seed`. */
function hex32(seed: string): string {
  let out = '';
  for (let i = 0; out.length < 32; i += 1) {
    out += (seed.charCodeAt(i % seed.length) + i).toString(16).slice(-1);
  }
  return out;
}

function approvingAttestation(
  attestationIdHex: string,
  over: Partial<OfflineAttestationEnvelope> = {},
): (input: RequestOfflineAttestationInput) => ReturnType<typeof realRequestOfflineAttestation> {
  return async (input: RequestOfflineAttestationInput) => ({
    ok: true,
    attestation: envelopeFor(
      {
        actionId: input.actionId,
        targetOrderId: input.targetOrderId,
        targetOrderUtc7Date: input.targetOrderUtc7Date,
        managerStaffId: input.managerStaffId,
        pin: input.pin,
        localIntentId: input.localIntentId,
        initiatingStaffId: 'unused',
      },
      attestationIdHex,
      over,
    ),
  });
}

describe('projectPrivilegedOfflineAction — RC-D3-001 one-argument production seam', () => {
  it('the exported production function has arity 1 (no runtime dependency/override parameter)', () => {
    expect(projectPrivilegedOfflineAction.length).toBe(1);
  });

  it('the adapter source no longer defines/exports a runtime dependency-bag type', () => {
    expect(adapterSourceRaw).not.toMatch(/export\s+(interface|type)\s+\w*Deps\b/);
    expect(adapterSourceRaw).not.toMatch(/deps\s*[:?]/);
  });

  it('the adapter source declares no second parameter on the exported function', () => {
    expect(adapterSourceRaw).toMatch(
      /export async function projectPrivilegedOfflineAction\(\s*input: ProjectPrivilegedOfflineActionInput,?\s*\): Promise</,
    );
  });
});

describe('projectPrivilegedOfflineAction — P1 successful projection', () => {
  it('projects: created row, Class I identity exact, provenance preserved, Class III null, resultingVoidIntentId null', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    const attestationId = hex32('p1');
    state.requestAttestationOverride = approvingAttestation(attestationId);
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome.kind).toBe('projected');
    if (outcome.kind !== 'projected') throw new Error('unreachable');
    const record = outcome.record;
    expect(parsePrivilegedEvidenceJournalRecordV1(record)).not.toBeNull();
    expect(record.adjudicationId).toBe(attestationId);
    expect(record.paa1Base64).toBe(`PAA1-${attestationId}`);
    expect(record.ssa1Base64).toBe(`SSA1-${attestationId}`);
    expect(record.oacEnvelopeBytesBase64).toBe(`OAC1-${attestationId}`);
    expect(record.actionId).toBe(input.actionId);
    expect(record.targetOrderId).toBe(input.targetOrderId);
    expect(record.branchId).toBe(BRANCH_ID);
    expect(record.approvingManagerStaffId).toBe(input.managerStaffId);
    expect(record.ingestStaffId).toBe(input.initiatingStaffId);
    expect(record.ingestDeviceId).toBe(DEVICE_ID);
    expect(record.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
    expect(record.resultingVoidIntentId).toBeNull();
    expect(record.serverVerdict).toBeNull();
    expect(record.serverReason).toBeNull();
    expect(record.serverAdjudicationId).toBeNull();
    expect(record.serverTargetOrderId).toBeNull();
    expect(record.offlineExecutionId).toBeNull();
    expect(record.outcomeKind).toBeNull();
    expect(record.serverAdjudicatedAtMs).toBeNull();
    expect(record.serverObservedAtMs).toBeNull();
    expect(record.serverIdempotentReplay).toBeNull();
  });
});

describe('projectPrivilegedOfflineAction — P2 pre-guard duplicate', () => {
  it('an existing open same-target row short-circuits before attestation, no new row', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    await realIngestAttestedPrivilegedAction(
      currentStore(),
      envelopeFor(input, hex32('existing')),
      { ingestStaffId: 'staff-x', ingestDeviceId: 'dev-x' },
      1_000,
    );
    let attestationCalls = 0;
    state.requestAttestationOverride = async () => {
      attestationCalls += 1;
      throw new Error('must not be called');
    };
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome).toEqual({ kind: 'duplicate_target' });
    expect(attestationCalls).toBe(0);
    expect(await listPrivilegedEvidence(currentStore())).toHaveLength(1);
  });
});

describe('projectPrivilegedOfflineAction — P3 concurrent duplicate', () => {
  it('two concurrent projections for the same target converge to exactly one created + one duplicate_target', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    let call = 0;
    state.requestAttestationOverride = async (reqInput) => {
      call += 1;
      return approvingAttestation(hex32(`concurrent-${call}`))(reqInput);
    };
    const [a, b] = await Promise.all([
      projectPrivilegedOfflineAction(input),
      projectPrivilegedOfflineAction(input),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['duplicate_target', 'projected']);
    const rows = await listPrivilegedEvidence(currentStore());
    expect(rows).toHaveLength(1);
  });
});

describe('projectPrivilegedOfflineAction — P4 identical-envelope retry convergence', () => {
  it('when the first ingest call lands but still throws, the bounded retry converges to already_projected with the row unchanged', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    const attestationId = hex32('p4');
    state.requestAttestationOverride = approvingAttestation(attestationId);
    let ingestCalls = 0;
    state.ingestOverride = async (s, envelope, ctx, nowMs) => {
      ingestCalls += 1;
      const real = await realIngestAttestedPrivilegedAction(s, envelope, ctx, nowMs);
      if (ingestCalls === 1) {
        // The write actually landed; the call itself still rejects (torn transport).
        throw new Error('transport uncertainty after commit');
      }
      return real;
    };
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome.kind).toBe('already_projected');
    expect(ingestCalls).toBe(2);
    const rows = await listPrivilegedEvidence(currentStore());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAtMs).toBe(5_000);
    expect(rows[0]!.adjudicationId).toBe(attestationId);
  });
});

describe('projectPrivilegedOfflineAction — P5 binding mismatch', () => {
  it('refuses without ingest when verifiedBranchId mismatches canonical branch', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    let ingestCalls = 0;
    state.requestAttestationOverride = approvingAttestation(hex32('mismatch-branch'), { verifiedBranchId: 'LDP-999' });
    state.ingestOverride = async (...args) => {
      ingestCalls += 1;
      return realIngestAttestedPrivilegedAction(...args);
    };
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome).toEqual({ kind: 'integrity_conflict' });
    expect(ingestCalls).toBe(0);
    expect(await listPrivilegedEvidence(currentStore())).toHaveLength(0);
  });

  it('refuses without ingest when actionId mismatches the request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    state.requestAttestationOverride = approvingAttestation(hex32('mismatch-action'), { actionId: 'VOID_SETTLED_SALE' });
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome).toEqual({ kind: 'integrity_conflict' });
    expect(await listPrivilegedEvidence(currentStore())).toHaveLength(0);
  });

  it('refuses without ingest when targetOrderId mismatches the request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    state.requestAttestationOverride = approvingAttestation(hex32('mismatch-target'), { targetOrderId: 'order-other' });
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome).toEqual({ kind: 'integrity_conflict' });
    expect(await listPrivilegedEvidence(currentStore())).toHaveLength(0);
  });

  it('refuses without ingest when localIntentId mismatches the request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    state.requestAttestationOverride = approvingAttestation(hex32('mismatch-intent'), { localIntentId: 'intent-other' });
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome).toEqual({ kind: 'integrity_conflict' });
    expect(await listPrivilegedEvidence(currentStore())).toHaveLength(0);
  });

  it('refuses without ingest when the approval result is not APPROVED_LOCAL', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const input = baseInput();
    state.requestAttestationOverride = approvingAttestation(hex32('mismatch-approval'), {
      evidenceSeed: {
        oacId: 'oac-1',
        oacSchemaVersion: 1,
        revocationEpochAtIssue: 0,
        managerAuthVersionAtIssue: 0,
        managerCredentialVersionAtIssue: 0,
        nonce: 'nonce-x',
        attemptCount: 1,
        // A synthetic/inconsistent test-only shape; the real D-1B contract
        // never returns ok:true with a non-APPROVED_LOCAL evidenceSeed.
        approvalResult: 'DENIED_STALE',
        approvalProofDigest: 'proof-x',
      },
    });
    const outcome = await projectPrivilegedOfflineAction(input);
    expect(outcome).toEqual({ kind: 'integrity_conflict' });
    expect(await listPrivilegedEvidence(currentStore())).toHaveLength(0);
  });
});

describe('projectPrivilegedOfflineAction — P6 invalid canonical context', () => {
  it('fails closed to unavailable when the canonical context is unmounted, without calling attestation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    setContext(null);
    let attestationCalls = 0;
    state.requestAttestationOverride = async () => {
      attestationCalls += 1;
      throw new Error('must not be called');
    };
    const outcome = await projectPrivilegedOfflineAction(baseInput());
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(attestationCalls).toBe(0);
  });

  it('fails closed to unavailable when the canonical branch is ALL', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    setContext('ALL');
    const outcome = await projectPrivilegedOfflineAction(baseInput());
    expect(outcome).toEqual({ kind: 'unavailable' });
  });
});

describe('projectPrivilegedOfflineAction — P7 D-1B attestation failure', () => {
  const cases: Array<{ errorCode: string }> = [
    { errorCode: 'DENIED_INVALID_PIN' },
    { errorCode: 'DENIED_LOCKED' },
    { errorCode: 'DENIED_STALE' },
    { errorCode: 'DENIED_UNVERIFIABLE' },
  ];
  for (const { errorCode } of cases) {
    it(`${errorCode} -> not_approved, no store write, no business write`, async () => {
      vi.spyOn(Date, 'now').mockReturnValue(5_000);
      let ingestCalls = 0;
      state.requestAttestationOverride = async () => ({ ok: false, errorCode });
      state.ingestOverride = async (...args) => {
        ingestCalls += 1;
        return realIngestAttestedPrivilegedAction(...args);
      };
      const outcome = await projectPrivilegedOfflineAction(baseInput());
      expect(outcome).toEqual({ kind: 'not_approved', errorCode });
      expect(ingestCalls).toBe(0);
      expect(await listPrivilegedEvidence(currentStore())).toHaveLength(0);
    });
  }
});

describe('projectPrivilegedOfflineAction — P8 local ingest rejection/uncertainty', () => {
  it('two ingest failures resolve to uncertain, with exactly one attestation call', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    let attestationCalls = 0;
    let ingestCalls = 0;
    const attestationId = hex32('p8');
    state.requestAttestationOverride = async (input) => {
      attestationCalls += 1;
      return approvingAttestation(attestationId)(input);
    };
    state.ingestOverride = async () => {
      ingestCalls += 1;
      throw new Error('durable ingest failure');
    };
    const outcome = await projectPrivilegedOfflineAction(baseInput());
    expect(outcome).toEqual({ kind: 'uncertain' });
    expect(attestationCalls).toBe(1);
    expect(ingestCalls).toBe(2);
    expect(await listPrivilegedEvidence(currentStore())).toHaveLength(0);
  });
});

describe('projectPrivilegedOfflineAction — P9 online/offline authority neutrality', () => {
  it('the adapter source never reads navigator.onLine or Firebase configured state', () => {
    expect(adapterSourceRaw).not.toMatch(/navigator\.onLine/);
    expect(adapterSourceRaw).not.toMatch(/isFirebaseConfigured/);
  });
});

describe('projectPrivilegedOfflineAction — P10 restart-after-ingest machine safety', () => {
  it('a projected row remains sweep-eligible after a fresh generation allocation, with no UI involved', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    const attestationId = hex32('p10');
    state.requestAttestationOverride = approvingAttestation(attestationId);
    const outcome = await projectPrivilegedOfflineAction(baseInput());
    expect(outcome.kind).toBe('projected');
    const { generation } = await allocatePrivilegedSweepGeneration(currentStore());
    const claim = await claimPrivilegedEvidenceRow(currentStore(), attestationId, generation, {
      deviceId: DEVICE_ID,
      nowMs: 6_000,
      staffId: 'sweep-staff',
    });
    expect(claim.kind).toBe('claimed');
  });
});

describe('projectPrivilegedOfflineAction — durable read failure at the S1 pre-guard', () => {
  it('fails closed to durable_unavailable without calling attestation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    let attestationCalls = 0;
    state.listBranchEvidenceOverride = async () => {
      throw new Error('durable store unavailable');
    };
    state.requestAttestationOverride = async () => {
      attestationCalls += 1;
      throw new Error('must not be called');
    };
    const outcome = await projectPrivilegedOfflineAction(baseInput());
    expect(outcome).toEqual({ kind: 'durable_unavailable' });
    expect(attestationCalls).toBe(0);
  });
});

describe('projectPrivilegedOfflineAction — RC-D3-002 unreadable privileged state fails closed at S1', () => {
  it('an unreadable row anywhere in the store fails closed to integrity_conflict without calling attestation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    await currentStore().transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'corrupt-1', { garbage: true });
    });
    let attestationCalls = 0;
    state.requestAttestationOverride = async () => {
      attestationCalls += 1;
      throw new Error('must not be called');
    };
    const outcome = await projectPrivilegedOfflineAction(baseInput());
    expect(outcome).toEqual({ kind: 'integrity_conflict' });
    expect(attestationCalls).toBe(0);
  });
});
