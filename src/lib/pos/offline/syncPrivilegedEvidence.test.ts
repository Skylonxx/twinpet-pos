import { describe, expect, it } from 'vitest';
import syncPrivilegedEvidenceSource from './syncPrivilegedEvidence.ts?raw';
import { createInMemoryReversalStore } from './reversalLocalStore';
import type { ReversalLocalStore } from './reversalLocalStore';
import type { OfflineAttestationEnvelope } from '../../auth/privilegedAction/offlineAttestation';
import type { AdjudicationCallable, OfflineAdjudicationResponse } from '../../auth/privilegedAction/offlineAdjudicationTransport';
import { ingestAttestedPrivilegedAction, listPrivilegedEvidence } from './privilegedEvidenceStore';
import { runPrivilegedEvidenceSweep, type PrivilegedEvidenceDeadlineSignal } from './syncPrivilegedEvidence';

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

type Scheduled = { id: number; ms: number; fn: () => void; cleared?: boolean };

function makeTimeHarness() {
  const timeouts: Scheduled[] = [];
  let nextId = 1;
  let nowVal = 1_000;
  return {
    now: () => nowVal,
    setNow: (v: number) => {
      nowVal = v;
    },
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId++;
      timeouts.push({ id, ms, fn });
      return id;
    },
    clearTimeoutFn: (id: unknown) => {
      const row = timeouts.find((t) => t.id === id);
      if (row) row.cleared = true;
    },
    timeouts,
    fireByMs: (ms: number) => {
      const row = timeouts.find((t) => t.ms === ms && !t.cleared);
      row?.fn();
      return row;
    },
    // PRIVILEGED_EVIDENCE_SUBMISSION_TIMEOUT_MS and PRIVILEGED_EVIDENCE_PHASE_ADMISSION_WINDOW_MS
    // are both 8_000ms; the local per-submission timer is always armed LAST.
    fireLastByMs: (ms: number) => {
      const matches = timeouts.filter((t) => t.ms === ms && !t.cleared);
      const row = matches[matches.length - 1];
      row?.fn();
      return row;
    },
  };
}

function makeCycleDeadline(): { signal: PrivilegedEvidenceDeadlineSignal; fire: () => void } {
  let fired = false;
  let resolve!: (v: 'deadline') => void;
  const promise = new Promise<'deadline'>((r) => {
    resolve = r;
  });
  return {
    signal: { promise, expired: () => fired },
    fire: () => {
      fired = true;
      resolve('deadline');
    },
  };
}

async function waitForTimerCount(
  h: ReturnType<typeof makeTimeHarness>,
  ms: number,
  count: number,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (h.timeouts.filter((t) => t.ms === ms && !t.cleared).length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`did not observe ${count} timer(s) with ms=${ms} in time`);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('syncPrivilegedEvidence — D-3 confinement', () => {
  it('never imports or calls ingestAttestedPrivilegedAction (NONE_UNTIL_D3: no production ingest caller)', () => {
    expect(syncPrivilegedEvidenceSource).not.toMatch(/import\s*\{[^}]*ingestAttestedPrivilegedAction[^}]*\}/);
    expect(syncPrivilegedEvidenceSource).not.toMatch(/ingestAttestedPrivilegedAction\s*\(/);
  });

  it('never imports firebase/firestore or syncCenter* modules', () => {
    expect(syncPrivilegedEvidenceSource).not.toMatch(/from\s+['"]firebase\/firestore['"]/);
    expect(syncPrivilegedEvidenceSource).not.toMatch(/from\s+['"][^'"]*syncCenter/);
  });

  it('no transact callback awaits the adjudication callable (CL-D2-A05)', () => {
    // The callable is invoked strictly between claim (OP-2) and apply (OP-3),
    // never inside a store.transact(...) callback body.
    expect(syncPrivilegedEvidenceSource).toMatch(/submitOfflineAdjudication\(callable, payload\)/);
  });
});

describe('runPrivilegedEvidenceSweep — transport unavailable', () => {
  it('skips with transport_unavailable when no production callable can be constructed', async () => {
    const store = createInMemoryReversalStore();
    const h = makeTimeHarness();
    const result = await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(result).toEqual({ itemsAttempted: 0, itemsAdvanced: 0, skipReason: 'transport_unavailable' });
  });
});

describe('runPrivilegedEvidenceSweep — response handling and byte identity', () => {
  it('ACCEPTED terminal response transitions the row to SERVER_ACCEPTED', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const h = makeTimeHarness();
    const callable: AdjudicationCallable = async () => ({
      family: 'ADJUDICATION',
      kind: 'ACCEPTED',
      adjudicationId: envelope().attestationIdHex,
      targetOrderId: 'order-1',
      offlineExecutionId: 'exec-1',
      outcomeKind: 'VOID_APPLIED',
      idempotent: false,
      serverAdjudicatedAtMs: 5_000,
    });
    const result = await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(result.itemsAttempted).toBe(1);
    expect(result.itemsAdvanced).toBe(1);
    const rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.syncStatus).toBe('SERVER_ACCEPTED');
  });

  it('retries with a byte-identical payload after a retryable response, then converges on ACCEPTED', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const payloads: unknown[] = [];
    let callCount = 0;
    const callable: AdjudicationCallable = async (payload) => {
      payloads.push(payload);
      callCount += 1;
      if (callCount === 1) {
        const r: OfflineAdjudicationResponse = {
          family: 'ADJUDICATION',
          kind: 'RETRYABLE',
          adjudicationId: envelope().attestationIdHex,
          retryReason: 'backend_unavailable',
          terminal: false,
          serverAdjudicatedAtMs: 1,
        };
        return r;
      }
      const r: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: true,
        serverAdjudicatedAtMs: 2,
      };
      return r;
    };
    const h = makeTimeHarness();
    await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    h.setNow(999_999); // force the row past its backoff window for the next sweep
    await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[0]).toEqual({ paa1Base64: 'PAA1', ssa1Base64: 'SSA1', oacEnvelopeBytesBase64: 'OAC1' });
    const rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.syncStatus).toBe('SERVER_ACCEPTED');
  });

  it('CALLER_DEPENDENT suppresses only that staff id; a different staff succeeds with identical bytes', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const payloads: unknown[] = [];
    let callCount = 0;
    const callable: AdjudicationCallable = async (payload) => {
      payloads.push(payload);
      callCount += 1;
      if (callCount === 1) {
        const r: OfflineAdjudicationResponse = {
          family: 'PROTOCOL',
          kind: 'PROTOCOL_REJECTED',
          protocolReason: 'relay_caller_not_authorized',
          recoverability: 'CALLER_DEPENDENT',
          serverObservedAtMs: 1,
        };
        return r;
      }
      const r: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: envelope().attestationIdHex,
        targetOrderId: 'order-1',
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 2,
      };
      return r;
    };
    const h = makeTimeHarness();
    // staff-1 gets CALLER_DEPENDENT and is suppressed for future sweeps.
    await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    let rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
    expect(rows[0]!.relayDeferrals).toBe(1);
    expect(rows[0]!.retryableFailureCount).toBe(0);

    // The SAME staff is suppressed and the row is not re-attempted.
    await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(payloads).toHaveLength(1);

    // A DIFFERENT staff relays with byte-identical bytes and succeeds.
    await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-2', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.syncStatus).toBe('SERVER_ACCEPTED');
  });

  it('never drains a row scoped to a different branch', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope({ verifiedBranchId: 'OTHER-BRANCH' }), ctx, 1_000);
    let called = false;
    const callable: AdjudicationCallable = async () => {
      called = true;
      throw new Error('should never be called');
    };
    const h = makeTimeHarness();
    const result = await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(result.itemsAttempted).toBe(0);
    expect(called).toBe(false);
  });

  it('a never-settling callable applies LOCAL_SUBMISSION_TIMEOUT within the 8s local timer and releases the claim', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ctx, 1_000);
    const h = makeTimeHarness();
    const callable: AdjudicationCallable = () => new Promise(() => {});
    const resultPromise = runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    // phaseAdmission (8_000) is armed at phase start; the local submission
    // timer (also 8_000) is armed once the claim succeeds and the network
    // call begins — wait for both before firing the LAST one.
    await waitForTimerCount(h, 8_000, 2);
    const fired = h.fireLastByMs(8_000);
    expect(fired).toBeTruthy();
    const result = await resultPromise;
    expect(result.itemsAttempted).toBe(1);
    expect(result.itemsAdvanced).toBe(1);
    const rows = await listPrivilegedEvidence(store);
    expect(rows[0]!.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
    expect(rows[0]!.lastDispositionKind).toBe('LOCAL_SUBMISSION_TIMEOUT');
    expect(rows[0]!.claimOwner).toBeNull();
  });
});

describe('runPrivilegedEvidenceSweep — durable-op deadline (OP-1/OP-2)', () => {
  it('OP-1 (enumerate + allocate) timing out stops the phase: no claim, no network call', async () => {
    const inner = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(inner, envelope(), ctx, 1_000);
    let callCount = 0;
    const hangingStore: ReversalLocalStore = {
      transact: (stores, mode, fn) => {
        callCount += 1;
        if (callCount === 1) return new Promise(() => {});
        return inner.transact(stores, mode, fn);
      },
    };
    const h = makeTimeHarness();
    let networkCalled = false;
    const callable: AdjudicationCallable = async () => {
      networkCalled = true;
      throw new Error('unreachable');
    };
    const resultPromise = runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store: hangingStore, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    await waitForTimerCount(h, 2_000, 1);
    h.fireByMs(2_000);
    const result = await resultPromise;
    expect(result.itemsAttempted).toBe(0);
    expect(result.itemsAdvanced).toBe(0);
    expect(networkCalled).toBe(false);
  });

  it('OP-2 (claim) timing out never submits network bytes', async () => {
    const inner = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(inner, envelope(), ctx, 1_000);
    // Call sequence: #1 OP-1 (allocate, readwrite), #2 claim pre-read
    // (readonly, outside the CAS — recomputes the digest), #3 the claim CAS
    // itself (readwrite) — hang exactly that one.
    let callCount = 0;
    const hangingStore: ReversalLocalStore = {
      transact: (stores, mode, fn) => {
        callCount += 1;
        if (callCount === 3) return new Promise(() => {});
        return inner.transact(stores, mode, fn);
      },
    };
    const h = makeTimeHarness();
    let networkCalled = false;
    const callable: AdjudicationCallable = async () => {
      networkCalled = true;
      throw new Error('unreachable');
    };
    const resultPromise = runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store: hangingStore, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    await waitForTimerCount(h, 2_000, 1);
    h.fireByMs(2_000);
    const result = await resultPromise;
    expect(result.itemsAttempted).toBe(0);
    expect(networkCalled).toBe(false);
  });
});

describe('runPrivilegedEvidenceSweep — RC-D2-001 TOCTOU regression', () => {
  it('a binding mutation between claim pre-read and CAS causes zero network submission', async () => {
    const inner = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(inner, envelope(), ctx, 1_000);
    const originalTransact = inner.transact.bind(inner);
    // Call sequence: #1 OP-1 (allocate, readwrite), #2 claim pre-read
    // (readonly), #3 the claim CAS itself (readwrite). Mutate the row's
    // paa1Base64 immediately after #2 returns, so the digest computed from
    // the pre-read snapshot is stale by the time #3 opens.
    // The in-memory store serializes transact() calls onto a single chain
    // (models IndexedDB's per-database transaction queue) — a nested call
    // issued from INSIDE another still-open transact() callback would
    // deadlock against that same chain. Instead, chain the mutation off the
    // call-2 PROMISE (after it has fully settled and left the queue),
    // strictly before the caller's next await resumes and issues call 3.
    let callCount = 0;
    const spyingStore: ReversalLocalStore = {
      transact: (stores, mode, fn) => {
        callCount += 1;
        const result = originalTransact(stores, mode, fn);
        if (callCount === 2) {
          return result.then(async (value) => {
            await originalTransact(['privilegedEvidence'], 'readwrite', async (innerTxn) => {
              const raw = await innerTxn.get('privilegedEvidence', envelope().attestationIdHex);
              const rec = raw as Record<string, unknown>;
              await innerTxn.put('privilegedEvidence', envelope().attestationIdHex, {
                ...rec,
                paa1Base64: 'MUTATED-BY-RACE',
              });
            });
            return value;
          });
        }
        return result;
      },
    };
    const h = makeTimeHarness();
    let networkCalled = false;
    const callable: AdjudicationCallable = async () => {
      networkCalled = true;
      throw new Error('should never be called after a failed claim');
    };
    const result = await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store: spyingStore, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(result.itemsAttempted).toBe(0);
    expect(networkCalled).toBe(false);
    const rows = await listPrivilegedEvidence(inner);
    expect(rows[0]!.claimOwner).toBeNull();
    expect(rows[0]!.submissionClaims).toBe(0);
  });
});

describe('runPrivilegedEvidenceSweep — multiple rows', () => {
  it('drains multiple admitted rows in one sweep when all respond quickly', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope({ attestationIdHex: 'a'.repeat(32) }), ctx, 1_000);
    await ingestAttestedPrivilegedAction(store, envelope({ attestationIdHex: 'b'.repeat(32) }), ctx, 1_000);
    const callable: AdjudicationCallable = async (payload) => {
      const p = payload as { paa1Base64: string };
      const r: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: 'a'.repeat(32),
        targetOrderId: 'order-1',
        offlineExecutionId: `exec-${p.paa1Base64}`,
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: 2,
      };
      return r;
    };
    const h = makeTimeHarness();
    const result = await runPrivilegedEvidenceSweep(
      { branchId: 'LDP-001', staffId: 'staff-1', deviceId: 'device-1', cycleDeadline: makeCycleDeadline().signal },
      { store, callable, now: h.now, setTimeoutFn: h.setTimeoutFn, clearTimeoutFn: h.clearTimeoutFn },
    );
    expect(result.itemsAttempted).toBe(2);
    expect(result.itemsAdvanced).toBe(2);
  });
});
