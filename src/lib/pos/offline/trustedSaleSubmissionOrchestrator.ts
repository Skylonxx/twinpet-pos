/**
 * Packet AI-1 trusted application orchestration.
 *
 * Two application-facing responsibilities:
 * 1. submit-path generation begin (checkout)
 * 2. resume-path sweep (POS boot / reconnect)
 *
 * The only import into the Row29/D-3 trust island is `./trustedOrchestrationOwner`.
 * Owner / authorization / proof handles never cross this module boundary.
 *
 * AI-1 limitations (must not be overclaimed):
 * 1. AI-1 delivers a wired orchestration lifecycle. It does NOT deliver
 *    crash-resume correctness.
 * 2. With no ENTRY_STORE writer, every absence seal is vacuous: it proves
 *    nothing about whether a submission occurred.
 * 3. Boot/reconnect sweeps can write durable absence_seal pointers for
 *    generations whose sales did occur. At AI-1 these are NOT authoritative
 *    evidence.
 * 4. Between sweeps, the durable cart record can name an older sale's
 *    asyncOrderId/billId. It is not guaranteed to describe the most recent sale.
 * 5. A second sale in the same session with no intervening sweep can receive
 *    `{ ok:false }` from begin. The sale still proceeds.
 * 6. Cross-tab behavior is idempotent convergence plus at-most-once release.
 *    It is NOT mutual exclusion.
 * 7. No generation-count, sale-count, or evidence claim derived from the AI-1
 *    island may be surfaced as authoritative operator-facing information.
 *
 * AI_1_ORCHESTRATION_FAILURE_OBSERVABILITY: CONSOLE_ONLY
 * AI_1_POINTER_GROWTH_LIMITATION: MONOTONIC_NO_PRUNE_PATH
 * CROSS_TAB_GUARANTEE: IDEMPOTENT_CONVERGENCE_PLUS_AT_MOST_ONCE_RELEASE
 */
import {
  acquireOwnedSaleSubmissionResumeFence,
  beginOwnedActiveCartGeneration,
  claimTrustedOrchestrationOwner,
  commitOwnedSaleSubmissionAbsenceSeal,
  isTrustedOrchestrationOwnerFor,
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
      reason: 'owner_unavailable' | 'seal_refused' | 'release_refused' | 'orchestration_error';
    };

type ClaimOk = Extract<
  ReturnType<typeof claimTrustedOrchestrationOwner>,
  { ok: true }
>;
type OwnedOwner = ClaimOk['owner'];

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

let slot: OwnedSlot | null = null;
let idleWaiters: Array<() => void> = [];

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

function settleCheckoutBound(
  operation: Promise<TrustedSaleSubmissionBeginResult>,
): Promise<TrustedSaleSubmissionBeginResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: TrustedSaleSubmissionBeginResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      observeFailure('orchestration_timeout');
      finish({ ok: false, reason: 'orchestration_timeout' });
    }, CHECKOUT_ORCHESTRATION_SETTLE_BOUND_MS);
    operation.then(
      (value) => {
        finish(value);
      },
      () => {
        if (!settled) {
          observeFailure('orchestration_error');
        }
        finish({ ok: false, reason: 'orchestration_error' });
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
  return withOwnedWork<TrustedSaleSubmissionBeginResult>(
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
      return {
        ok: true,
        generationId: begun.generationId,
        generationSeq: begun.generationSeq,
        storeEpochId: begun.storeEpochId,
      };
    },
    () => ({ ok: false, reason: 'owner_unavailable' }),
  );
}

/**
 * Checkout-path generation begin. Always settles within 2000ms.
 * Failure is a plain serializable union — never a throw.
 */
export async function beginTrustedSaleSubmission(
  input: TrustedSaleSubmissionBeginInput,
): Promise<TrustedSaleSubmissionBeginResult> {
  return settleCheckoutBound(runBegin(input));
}

/**
 * Boot / reconnect resume sweep. Best-effort. Never throws.
 * Duplicate concurrent sweeps converge: at most one durable release effect.
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
  try {
    return await withOwnedWork<TrustedResumeSweepResult>(
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
        const sealed = await commitOwnedSaleSubmissionAbsenceSeal(owner, acquired.authorization);
        if (!sealed.ok) {
          observeFailure('seal_refused');
          return { ok: false, reason: 'seal_refused' };
        }
        const proof = sealed.proof;
        const released = await releaseOwnedSaleSubmissionResumeFence(owner, acquired.authorization, {
          outcome: 'evidence_proven_absent',
          proof,
        });
        if (!released.ok) {
          observeFailure('release_refused');
          return { ok: false, reason: 'release_refused' };
        }
        return { ok: true, outcome: 'released' };
      },
      () => ({ ok: false, reason: 'owner_unavailable' }),
    );
  } catch {
    observeFailure('orchestration_error');
    return { ok: false, reason: 'orchestration_error' };
  }
}
