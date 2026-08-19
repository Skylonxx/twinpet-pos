/**
 * Packet AI-2 trusted application orchestration.
 *
 * Application-facing responsibilities:
 * 1. submit-path generation begin + ENTRY write (checkout S2–S4)
 * 2. awaited post-submit presence release (checkout S5)
 * 3. resume-path sweep (POS boot / reconnect)
 *
 * The only import into the Row29/D-3 trust island is `./trustedOrchestrationOwner`.
 * Owner / authorization / proof handles never cross this module boundary.
 *
 * Claim boundaries (must not be overclaimed):
 * - AI2_ADDS_CRASH_RESUME_CORRECTNESS: PARTIAL
 * - FIRESTORE_SERVER_CONFIRMATION_INFERENCE: NO
 * - AI2_RECEIPT_AUTHORITY: NO
 * - CROSS_TAB_MUTUAL_EXCLUSION_CLAIM: NO
 * - AI2_ABSENCE_SOUNDNESS_SCOPE: SINGLE_TAB_PER_CART_KEY
 * - AI2_ABSENCE_SOUNDNESS_FAILURE_PATH_CARVEOUT:
 *   ENTRY_WRITE_FAILED_AFTER_FENCE_ACQUISITION_AND_CHECKOUT_PROCEEDED
 * - ENTRY_STORE_RELATION: PARALLEL_FOR_RECORD_FRESHNESS_ONLY
 *
 * AI2-D1 = B_FAIL_OPEN_DISCLOSED: if the ENTRY_STORE write fails after fence
 * acquisition, checkout proceeds. A later sweep may seal absence; that absence
 * is UNSOUND on this accepted path (crash-matrix case 17).
 *
 * CROSS_TAB_GUARANTEE: IDEMPOTENT_CONVERGENCE_PLUS_AT_MOST_ONCE_RELEASE
 * AI_1_ORCHESTRATION_FAILURE_OBSERVABILITY: CONSOLE_ONLY
 * POINTER_PRUNE_DISPOSITION: FUTURE_D4_OWNS_RETENTION
 */
import {
  acquireOwnedSaleSubmissionResumeFence,
  beginOwnedActiveCartGeneration,
  claimTrustedOrchestrationOwner,
  commitOwnedSaleSubmissionAbsenceSeal,
  commitOwnedSaleSubmissionEvidenceEntry,
  isTrustedOrchestrationOwnerFor,
  proveOwnedSaleSubmissionEvidencePresence,
  releaseOwnedSaleSubmissionResumeFence,
  releaseTrustedOrchestrationOwner,
} from './trustedOrchestrationOwner';

const ORCH_WARN = '[trustedSaleSubmissionOrchestrator]';

/** Gemini-authorized checkout-facing orchestration settlement bound (CR-001). */
const CHECKOUT_ORCHESTRATION_SETTLE_BOUND_MS = 2000;

export type TrustedSaleSubmissionBeginInput = {
  branchId: string;
  deviceId: string;
  asyncOrderId: string;
  billId: string;
};

export type TrustedSaleSubmissionBeginResult =
  | {
      ok: true;
      generationId: string;
      generationSeq: number;
      storeEpochId: string;
    }
  | {
      ok: false;
      reason:
        | 'owner_unavailable'
        | 'generation_refused'
        | 'fence_unavailable'
        | 'evidence_write_refused'
        | 'orchestration_timeout'
        | 'orchestration_error';
    };

export type TrustedSaleSubmissionCompleteInput = {
  branchId: string;
  deviceId: string;
  asyncOrderId: string;
};

export type TrustedSaleSubmissionCompleteResult =
  | { ok: true; outcome: 'released' }
  | {
      ok: false;
      reason:
        | 'no_pending_cycle'
        | 'release_refused'
        | 'orchestration_timeout'
        | 'orchestration_error';
    };

export type TrustedResumeSweepInput = {
  branchId: string;
  deviceId: string;
};

export type TrustedResumeSweepResult =
  | { ok: true; outcome: 'released' | 'not_eligible' }
  | {
      ok: false;
      reason:
        | 'owner_unavailable'
        | 'seal_refused'
        | 'release_refused'
        | 'unresolved'
        | 'orchestration_error';
    };

type ClaimOk = Extract<
  ReturnType<typeof claimTrustedOrchestrationOwner>,
  { ok: true }
>;
type OwnedOwner = ClaimOk['owner'];
type AcquireOk = Extract<
  Awaited<ReturnType<typeof acquireOwnedSaleSubmissionResumeFence>>,
  { ok: true }
>;
type CommitEntryOk = Extract<
  Awaited<ReturnType<typeof commitOwnedSaleSubmissionEvidenceEntry>>,
  { ok: true }
>;

type OwnedSlot = {
  key: string;
  branchId: string;
  deviceId: string;
  owner: OwnedOwner;
  inFlight: number;
};

type EnsureOwnerResult =
  | { ok: true; slot: OwnedSlot }
  | { ok: false; reason: 'owner_unavailable' | 'owner_busy' };

type PendingCycle = {
  key: string;
  asyncOrderId: string;
  authorization: AcquireOk['authorization'];
  proof: CommitEntryOk['proof'];
};

let slot: OwnedSlot | null = null;
let idleWaiters: Array<() => void> = [];
let pendingCycle: PendingCycle | null = null;
const keyGate = new Map<string, Promise<void>>();

function ownerKey(branchId: string, deviceId: string): string {
  return `${branchId.length}:${branchId}|${deviceId.length}:${deviceId}`;
}

function observeFailure(reason: string): void {
  console.warn(ORCH_WARN, 'orchestration failed', reason);
}

function notifyOwnerIdle(): void {
  if (slot !== null && slot.inFlight > 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const waiter of waiters) waiter();
}

function waitUntilOwnerIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (slot === null || slot.inFlight === 0) {
      resolve();
      return;
    }
    idleWaiters.push(resolve);
  });
}

function releaseInFlight(owned: OwnedSlot): void {
  if (slot !== owned) return;
  slot.inFlight = Math.max(0, slot.inFlight - 1);
  notifyOwnerIdle();
}

function dropPendingCycle(): void {
  pendingCycle = null;
}

async function withCartKeyGate<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = keyGate.get(key) ?? Promise.resolve();
  let releaseGate = (): void => {};
  const current = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  keyGate.set(
    key,
    previous.then(
      () => current,
      () => current,
    ),
  );
  await previous;
  try {
    return await work();
  } finally {
    releaseGate();
  }
}

/**
 * Live-owner check → synchronous facade claim → module-state assignment.
 * This critical section contains NO await, Promise continuation, timer yield,
 * or other asynchronous gap (AI-D1 / CR-003).
 */
function ensureOwnerCriticalSection(branchId: string, deviceId: string): EnsureOwnerResult {
  const key = ownerKey(branchId, deviceId);
  if (
    slot !== null &&
    slot.key === key &&
    isTrustedOrchestrationOwnerFor(slot.owner, branchId, deviceId)
  ) {
    slot.inFlight += 1;
    return { ok: true, slot };
  }
  if (slot !== null && slot.inFlight > 0) {
    return { ok: false, reason: 'owner_busy' };
  }
  if (slot !== null) {
    dropPendingCycle();
    releaseTrustedOrchestrationOwner(slot.owner);
    slot = null;
  }
  const claimed = claimTrustedOrchestrationOwner(branchId, deviceId);
  if (!claimed.ok) {
    return { ok: false, reason: 'owner_unavailable' };
  }
  slot = {
    key,
    branchId,
    deviceId,
    owner: claimed.owner,
    inFlight: 1,
  };
  return { ok: true, slot };
}

async function acquireOwnedSlot(
  branchId: string,
  deviceId: string,
): Promise<EnsureOwnerResult> {
  for (;;) {
    const key = ownerKey(branchId, deviceId);
    if (slot !== null && slot.key !== key && slot.inFlight > 0) {
      await waitUntilOwnerIdle();
      continue;
    }
    const ensured = ensureOwnerCriticalSection(branchId, deviceId);
    if (ensured.ok) return ensured;
    if (ensured.reason === 'owner_busy') {
      await waitUntilOwnerIdle();
      continue;
    }
    return ensured;
  }
}

async function withOwnedWork<T>(
  branchId: string,
  deviceId: string,
  work: (owner: OwnedOwner) => Promise<T>,
  onUnavailable: () => T,
): Promise<T> {
  const ensured = await acquireOwnedSlot(branchId, deviceId);
  if (!ensured.ok) {
    observeFailure('owner_unavailable');
    return onUnavailable();
  }
  try {
    return await work(ensured.slot.owner);
  } finally {
    releaseInFlight(ensured.slot);
  }
}

function settleBound<T>(
  operation: Promise<T>,
  onTimeout: () => T,
  onError: () => T,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      observeFailure('orchestration_timeout');
      finish(onTimeout());
    }, CHECKOUT_ORCHESTRATION_SETTLE_BOUND_MS);
    operation.then(
      (value) => {
        finish(value);
      },
      () => {
        if (!settled) {
          observeFailure('orchestration_error');
        }
        finish(onError());
      },
    );
  });
}

async function runBegin(
  input: TrustedSaleSubmissionBeginInput,
): Promise<TrustedSaleSubmissionBeginResult> {
  const branchId = input.branchId;
  const deviceId = input.deviceId;
  const asyncOrderId = input.asyncOrderId;
  const billId = input.billId;
  if (
    typeof branchId !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof asyncOrderId !== 'string' ||
    typeof billId !== 'string' ||
    branchId.length === 0 ||
    deviceId.length === 0 ||
    asyncOrderId.length === 0 ||
    billId.length === 0
  ) {
    observeFailure('owner_unavailable');
    return { ok: false, reason: 'owner_unavailable' };
  }
  const key = ownerKey(branchId, deviceId);
  return withCartKeyGate(key, () =>
    withOwnedWork<TrustedSaleSubmissionBeginResult>(
      branchId,
      deviceId,
      async (owner) => {
        const begun = await beginOwnedActiveCartGeneration(owner, {
          branchId,
          deviceId,
          asyncOrderId,
          billId,
        });
        if (!begun.ok) {
          observeFailure('generation_refused');
          return { ok: false, reason: 'generation_refused' };
        }
        const acquired = await acquireOwnedSaleSubmissionResumeFence(owner, {
          branchId,
          deviceId,
        });
        if (!acquired.ok) {
          observeFailure('fence_unavailable');
          return { ok: false, reason: 'fence_unavailable' };
        }
        const committed = await commitOwnedSaleSubmissionEvidenceEntry(
          owner,
          acquired.authorization,
        );
        if (!committed.ok) {
          // AI2-D1 B_FAIL_OPEN_DISCLOSED: checkout proceeds; later absence
          // on this generation is UNSOUND (crash-matrix case 17).
          observeFailure('evidence_write_refused');
          return { ok: false, reason: 'evidence_write_refused' };
        }
        pendingCycle = {
          key,
          asyncOrderId,
          authorization: acquired.authorization,
          proof: committed.proof,
        };
        return {
          ok: true,
          generationId: begun.generationId,
          generationSeq: begun.generationSeq,
          storeEpochId: begun.storeEpochId,
        };
      },
      () => ({ ok: false, reason: 'owner_unavailable' }),
    ),
  );
}

async function runComplete(
  input: TrustedSaleSubmissionCompleteInput,
): Promise<TrustedSaleSubmissionCompleteResult> {
  const branchId = input.branchId;
  const deviceId = input.deviceId;
  const asyncOrderId = input.asyncOrderId;
  if (
    typeof branchId !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof asyncOrderId !== 'string' ||
    branchId.length === 0 ||
    deviceId.length === 0 ||
    asyncOrderId.length === 0
  ) {
    observeFailure('no_pending_cycle');
    return { ok: false, reason: 'no_pending_cycle' };
  }
  const key = ownerKey(branchId, deviceId);
  return withCartKeyGate(key, () =>
    withOwnedWork<TrustedSaleSubmissionCompleteResult>(
      branchId,
      deviceId,
      async (owner) => {
        const cycle = pendingCycle;
        if (
          cycle === null ||
          cycle.key !== key ||
          cycle.asyncOrderId !== asyncOrderId
        ) {
          observeFailure('no_pending_cycle');
          return { ok: false, reason: 'no_pending_cycle' };
        }
        const released = await releaseOwnedSaleSubmissionResumeFence(
          owner,
          cycle.authorization,
          { outcome: 'evidence_present', proof: cycle.proof },
        );
        if (!released.ok) {
          observeFailure('release_refused');
          return { ok: false, reason: 'release_refused' };
        }
        dropPendingCycle();
        return { ok: true, outcome: 'released' };
      },
      () => ({ ok: false, reason: 'no_pending_cycle' }),
    ),
  );
}

/**
 * Checkout-path generation begin + ENTRY write (S2–S4). Always settles within 2000ms.
 * Failure is a plain serializable union — never a throw. ENTRY write failure is
 * fail-open (AI2-D1): the caller still proceeds to submit.
 */
export async function beginTrustedSaleSubmission(
  input: TrustedSaleSubmissionBeginInput,
): Promise<TrustedSaleSubmissionBeginResult> {
  return settleBound(
    runBegin(input),
    () => ({ ok: false, reason: 'orchestration_timeout' }),
    () => ({ ok: false, reason: 'orchestration_error' }),
  );
}

/**
 * Checkout-path post-submit presence release (S5). Always settles within 2000ms.
 * Failure cannot undo or refuse an already-submitted sale.
 */
export async function completeTrustedSaleSubmission(
  input: TrustedSaleSubmissionCompleteInput,
): Promise<TrustedSaleSubmissionCompleteResult> {
  return settleBound(
    runComplete(input),
    () => ({ ok: false, reason: 'orchestration_timeout' }),
    () => ({ ok: false, reason: 'orchestration_error' }),
  );
}

/**
 * Boot / reconnect resume sweep. Best-effort. Never throws.
 * Duplicate concurrent sweeps converge: at most one durable release effect.
 * Absence is attempted first; presence is a create-incapable fallback.
 */
export async function runTrustedResumeSweep(
  input: TrustedResumeSweepInput,
): Promise<TrustedResumeSweepResult> {
  const branchId = input.branchId;
  const deviceId = input.deviceId;
  if (
    typeof branchId !== 'string' ||
    typeof deviceId !== 'string' ||
    branchId.length === 0 ||
    deviceId.length === 0
  ) {
    observeFailure('owner_unavailable');
    return { ok: false, reason: 'owner_unavailable' };
  }
  const key = ownerKey(branchId, deviceId);
  try {
    return await withCartKeyGate(key, () =>
      withOwnedWork<TrustedResumeSweepResult>(
        branchId,
        deviceId,
        async (owner) => {
          const acquired = await acquireOwnedSaleSubmissionResumeFence(owner, {
            branchId,
            deviceId,
          });
          if (!acquired.ok) {
            return { ok: true, outcome: 'not_eligible' };
          }
          const sealed = await commitOwnedSaleSubmissionAbsenceSeal(
            owner,
            acquired.authorization,
          );
          if (sealed.ok) {
            const proof = sealed.proof;
            const released = await releaseOwnedSaleSubmissionResumeFence(
              owner,
              acquired.authorization,
              {
                outcome: 'evidence_proven_absent',
                proof,
              },
            );
            if (!released.ok) {
              observeFailure('release_refused');
              return { ok: false, reason: 'release_refused' };
            }
            return { ok: true, outcome: 'released' };
          }
          const proven = await proveOwnedSaleSubmissionEvidencePresence(
            owner,
            acquired.authorization,
          );
          if (!proven.ok) {
            observeFailure('unresolved');
            return { ok: false, reason: 'unresolved' };
          }
          const releasedPresent = await releaseOwnedSaleSubmissionResumeFence(
            owner,
            acquired.authorization,
            {
              outcome: 'evidence_present',
              proof: proven.proof,
            },
          );
          if (!releasedPresent.ok) {
            observeFailure('release_refused');
            return { ok: false, reason: 'release_refused' };
          }
          return { ok: true, outcome: 'released' };
        },
        () => ({ ok: false, reason: 'owner_unavailable' }),
      ),
    );
  } catch {
    observeFailure('orchestration_error');
    return { ok: false, reason: 'orchestration_error' };
  }
}
