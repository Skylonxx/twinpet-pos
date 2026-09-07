/**
 * SEC-001 Packet D / D-2 — privileged-evidence sync sweep.
 *
 * Runs as its own phase inside `runCycleBody`, before `runChannels` (A04):
 * OP-1 (enumerate + allocate the sweep generation) -> claim (OP-2) ->
 * network submission (OUTSIDE every transaction, CL-D2-A05) -> apply (OP-3)
 * -> OP-4 (deferred-counter batch, skipped entirely after any durable-op
 * deadline).
 *
 * Every durable-store operation races its own fresh 2s timer plus the shared
 * phase and cycle deadline signals. Every submission races an 8s local timer
 * plus the same shared signals. Detach, never cancel (D2): a timed-out
 * promise is never awaited again and its rejection is absorbed.
 *
 * D-2 ships no production caller for `ingestAttestedPrivilegedAction`
 * (`NONE_UNTIL_D3`) — this module only drains whatever the journal already
 * holds, which is nothing until D-3 lands.
 */

import {
  submitOfflineAdjudication,
  ADJUDICATE_OFFLINE_PRIVILEGED_ACTION_CALLABLE,
  type AdjudicationCallable,
} from '../../auth/privilegedAction/offlineAdjudicationTransport';
import { createIndexedDbReversalStore, type ReversalLocalStore } from './reversalLocalStore';
import {
  PRIVILEGED_EVIDENCE_DURABLE_OP_TIMEOUT_MS,
  PRIVILEGED_EVIDENCE_PHASE_ADMISSION_WINDOW_MS,
  PRIVILEGED_EVIDENCE_PHASE_BUDGET_MS,
  PRIVILEGED_EVIDENCE_SUBMISSION_TIMEOUT_MS,
} from './privilegedEvidenceTypes';
import {
  allocatePrivilegedSweepGeneration,
  applyPrivilegedEvidenceDeferredCycleCounts,
  applyPrivilegedEvidenceDisposition,
  claimPrivilegedEvidenceRow,
  type ApplyInput,
} from './privilegedEvidenceStore';
import { selectAdmittedPrivilegedEvidenceRows } from './privilegedEvidenceScheduler';

// ─── Deadline signal — a LOCAL copy of syncOrchestrator's private primitive ─
// (structurally compatible by design; see architecture note on avoiding a
// syncOrchestrator.ts <-> syncPrivilegedEvidence.ts import cycle).

export interface PrivilegedEvidenceDeadlineSignal {
  readonly promise: Promise<'deadline'>;
  expired: () => boolean;
}

interface DisposableDeadlineSignal extends PrivilegedEvidenceDeadlineSignal {
  dispose: () => void;
}

export interface PrivilegedEvidenceSweepTimeDeps {
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  random?: () => number;
}

type ResolvedTimeDeps = Required<PrivilegedEvidenceSweepTimeDeps>;

function resolveTimeDeps(deps?: PrivilegedEvidenceSweepTimeDeps): ResolvedTimeDeps {
  return {
    now: deps?.now ?? Date.now,
    setTimeoutFn: deps?.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeoutFn: deps?.clearTimeoutFn ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    random: deps?.random ?? Math.random,
  };
}

function armPrivilegedEvidenceDeadline(d: ResolvedTimeDeps, ms: number): DisposableDeadlineSignal {
  let fired = false;
  let id: unknown = null;
  const promise = new Promise<'deadline'>((resolve) => {
    id = d.setTimeoutFn(() => {
      fired = true;
      resolve('deadline');
    }, ms);
  });
  return {
    promise,
    expired: () => fired,
    dispose: () => {
      if (id != null) {
        d.clearTimeoutFn(id);
        id = null;
      }
    },
  };
}

async function awaitWithSignals<T>(
  work: Promise<T>,
  signals: readonly PrivilegedEvidenceDeadlineSignal[],
): Promise<{ status: 'settled'; value: T } | { status: 'timeout' }> {
  if (signals.some((s) => s.expired())) {
    void work.then(
      () => undefined,
      () => undefined,
    );
    return { status: 'timeout' };
  }
  const winner = await Promise.race([
    work.then((value) => ({ kind: 'settled' as const, value })),
    ...signals.map((s) => s.promise.then(() => ({ kind: 'timeout' as const }))),
  ]);
  if (winner.kind === 'timeout') {
    void work.then(
      () => undefined,
      () => undefined,
    );
    return { status: 'timeout' };
  }
  return { status: 'settled', value: winner.value };
}

/** Every durable-store op races a FRESH 2s timer plus the two shared phase/cycle signals. */
async function runDurableOp<T>(
  d: ResolvedTimeDeps,
  work: Promise<T>,
  sharedSignals: readonly PrivilegedEvidenceDeadlineSignal[],
): Promise<{ status: 'settled'; value: T } | { status: 'timeout' }> {
  const opTimer = armPrivilegedEvidenceDeadline(d, PRIVILEGED_EVIDENCE_DURABLE_OP_TIMEOUT_MS);
  try {
    return await awaitWithSignals(work, [opTimer, ...sharedSignals]);
  } finally {
    opTimer.dispose();
  }
}

// ─── Sweep ───────────────────────────────────────────────────────────────

export interface PrivilegedEvidenceSweepInput {
  branchId: string;
  staffId: string;
  deviceId: string;
  /** Owned and armed by the caller (syncOrchestrator); the SAME object every await in the cycle races. */
  cycleDeadline: PrivilegedEvidenceDeadlineSignal;
}

export interface PrivilegedEvidenceSweepDeps extends PrivilegedEvidenceSweepTimeDeps {
  store?: ReversalLocalStore;
  callable?: AdjudicationCallable;
}

export interface PrivilegedEvidenceSweepResult {
  itemsAttempted: number;
  itemsAdvanced: number;
  skipReason?: 'transport_unavailable';
}

function resolveStore(deps?: PrivilegedEvidenceSweepDeps): ReversalLocalStore {
  return deps?.store ?? createIndexedDbReversalStore();
}

export async function runPrivilegedEvidenceSweep(
  input: PrivilegedEvidenceSweepInput,
  deps?: PrivilegedEvidenceSweepDeps,
): Promise<PrivilegedEvidenceSweepResult> {
  const d = resolveTimeDeps(deps);
  const store = resolveStore(deps);

  let callable: AdjudicationCallable;
  try {
    callable = deps?.callable ?? (await getDefaultCallAdjudicateOfflinePrivilegedAction());
  } catch {
    return { itemsAttempted: 0, itemsAdvanced: 0, skipReason: 'transport_unavailable' };
  }

  const phaseDeadline = armPrivilegedEvidenceDeadline(d, PRIVILEGED_EVIDENCE_PHASE_BUDGET_MS);
  const phaseAdmission = armPrivilegedEvidenceDeadline(d, PRIVILEGED_EVIDENCE_PHASE_ADMISSION_WINDOW_MS);
  const shared = [phaseDeadline, input.cycleDeadline];

  try {
    const op1 = await runDurableOp(d, allocatePrivilegedSweepGeneration(store), shared);
    if (op1.status === 'timeout') return { itemsAttempted: 0, itemsAdvanced: 0 };
    const { generation, rows } = op1.value;

    const { admitted, withheld } = selectAdmittedPrivilegedEvidenceRows(rows, {
      branchId: input.branchId,
      staffId: input.staffId,
      nowMs: d.now(),
      sweepGeneration: generation,
    });

    let attempted = 0;
    let advanced = 0;
    let durableOpTimedOut = false;
    let index = 0;

    for (; index < admitted.length; index += 1) {
      if (phaseAdmission.expired() || input.cycleDeadline.expired()) break;
      const row = admitted[index]!;

      const claimResult = await runDurableOp(
        d,
        claimPrivilegedEvidenceRow(store, row.adjudicationId, generation, {
          deviceId: input.deviceId,
          nowMs: d.now(),
          staffId: input.staffId,
        }),
        shared,
      );
      if (claimResult.status === 'timeout') {
        durableOpTimedOut = true;
        break;
      }
      if (claimResult.value.kind !== 'claimed') continue;
      attempted += 1;

      const claimed = claimResult.value.record;
      const payload = {
        paa1Base64: claimed.paa1Base64,
        ssa1Base64: claimed.ssa1Base64,
        oacEnvelopeBytesBase64: claimed.oacEnvelopeBytesBase64,
      };

      const localTimeout = armPrivilegedEvidenceDeadline(d, PRIVILEGED_EVIDENCE_SUBMISSION_TIMEOUT_MS);
      let submissionOutcome: Awaited<ReturnType<typeof awaitWithSignals<Awaited<ReturnType<typeof submitOfflineAdjudication>>>>>;
      try {
        submissionOutcome = await awaitWithSignals(submitOfflineAdjudication(callable, payload), [localTimeout, ...shared]);
      } finally {
        localTimeout.dispose();
      }

      let applyInput: ApplyInput;
      if (submissionOutcome.status === 'timeout') {
        applyInput = { kind: 'local_submission_timeout' };
      } else if (submissionOutcome.value.response === null) {
        applyInput = { kind: 'transport_failure' };
      } else {
        applyInput = {
          kind: 'server',
          response: submissionOutcome.value.response,
          disposition: submissionOutcome.value.disposition,
        };
      }

      const applyResult = await runDurableOp(
        d,
        applyPrivilegedEvidenceDisposition(store, row.adjudicationId, generation, applyInput, {
          nowMs: d.now(),
          staffId: input.staffId,
        }),
        shared,
      );
      if (applyResult.status === 'timeout') {
        durableOpTimedOut = true;
        index += 1;
        break;
      }
      if (applyResult.value.kind === 'applied') advanced += 1;
    }

    if (!durableOpTimedOut) {
      const remaining = admitted.slice(index).map((r) => r.adjudicationId);
      const toDefer = [...withheld.map((r) => r.adjudicationId), ...remaining];
      if (toDefer.length > 0) {
        await runDurableOp(d, applyPrivilegedEvidenceDeferredCycleCounts(store, toDefer), shared);
      }
    }

    return { itemsAttempted: attempted, itemsAdvanced: advanced };
  } finally {
    phaseDeadline.dispose();
    phaseAdmission.dispose();
  }
}

// ─── Default Firebase callable transport ───────────────────────────────────
// Lazily imported so the pure sweep above never pulls Firebase into unit
// tests, mirroring getDefaultCallResolveReversal (syncOfflineReversals.ts).

let cachedCall: AdjudicationCallable | null = null;

export async function getDefaultCallAdjudicateOfflinePrivilegedAction(): Promise<AdjudicationCallable> {
  if (cachedCall) return cachedCall;
  const [{ getFunctions, httpsCallable, connectFunctionsEmulator }, { app, USE_EMULATOR }] = await Promise.all([
    import('firebase/functions'),
    import('../../firebase'),
  ]);
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR) {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  const callable = httpsCallable<
    { paa1Base64: string; ssa1Base64: string; oacEnvelopeBytesBase64: string },
    unknown
  >(functions, ADJUDICATE_OFFLINE_PRIVILEGED_ACTION_CALLABLE);
  cachedCall = async (payload) => (await callable(payload)).data;
  return cachedCall;
}

/** @internal test-only */
export function __resetPrivilegedEvidenceCallableCacheForTests(): void {
  cachedCall = null;
}
