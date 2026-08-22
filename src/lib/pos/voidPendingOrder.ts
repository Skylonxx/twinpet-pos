import { doc, getDocFromServer, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from './deviceId';
import {
  createIndexedDbReversalStore,
  type ReversalLocalStore,
} from './offline/reversalLocalStore';
import {
  claimVoidIntent,
  decideVoidPreflight,
  deferVoidIntentPending,
  enqueueVoidIntent,
  getVoidIntent,
  markVoidIntentConfirmed,
  markVoidIntentRetryable,
  markVoidIntentTerminal,
  utcPlus7Date,
  type VoidErrorClass,
  type VoidIntentRecord,
  type VoidPreflightDecision,
  type VoidPreflightServerOrder,
  type VoidTerminalReason,
} from './offline/voidIntentStore';

export { decideVoidPreflight, utcPlus7Date };
export type { VoidPreflightDecision, VoidPreflightServerOrder, VoidTerminalReason };

/**
 * Offline void — Phase A (pending tombstone), Standalone POS Local-First.
 *
 * PK-3: durable enqueue first, then drain-time pre-flight while online.
 * The Firestore merge remains the same seven permitted fields.
 */

export type PendingVoidInput = {
  reason: string;
  note?: string;
  voidedBy: string;
};

export type PendingVoidRequest = PendingVoidInput & {
  branchId: string;
};

/** The exact update fields written onto the pending `asyncOrders` doc. Pure. */
export type PendingVoidFields = {
  voidRequested: true;
  status: 'voided';
  voidReason: string;
  voidedBy: string;
};

export type VoidRequestOutcome =
  | { kind: 'confirmed' }
  | { kind: 'queued' }
  | { kind: 'blocked'; reason: VoidTerminalReason };

/** Near-boundary window used to classify permission-denied after an ALLOW pre-flight. */
export const VOID_DAY_BOUNDARY_MARGIN_MS = 60_000;

/**
 * Build the void merge fields. `voidReason` combines reason + optional note as
 * `"reason — note"` (matching the canonical `voidOrder.ts`). Timestamps are added
 * by the impure writer so this stays pure and unit-testable.
 */
export function buildPendingVoidFields(input: PendingVoidInput): PendingVoidFields {
  const note = input.note?.trim();
  const voidReason = note ? `${input.reason} — ${note}` : input.reason;
  return {
    voidRequested: true,
    status: 'voided',
    voidReason,
    voidedBy: input.voidedBy,
  };
}

function timestampToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    try {
      const ms = (value as { toMillis: () => number }).toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  return null;
}

export type AsyncOrderVoidPreflightRead =
  | { kind: 'ok'; order: VoidPreflightServerOrder }
  | { kind: 'unavailable'; errorClass: VoidErrorClass };

export async function readAsyncOrderForVoidPreflight(
  orderId: string,
): Promise<AsyncOrderVoidPreflightRead> {
  if (!isFirebaseConfigured || !db) {
    return { kind: 'unavailable', errorClass: 'unavailable' };
  }
  try {
    const snap = await getDocFromServer(doc(db, 'asyncOrders', orderId));
    if (!snap.exists()) {
      return { kind: 'ok', order: { exists: false, serverCreatedAtMs: null } };
    }
    const data = snap.data() as Record<string, unknown>;
    return {
      kind: 'ok',
      order: {
        exists: true,
        serverCreatedAtMs: timestampToMs(data.serverCreatedAt),
        status: typeof data.status === 'string' ? data.status : null,
        voidRequested: data.voidRequested === true,
      },
    };
  } catch (err) {
    return { kind: 'unavailable', errorClass: classifyVoidWriteError(err) };
  }
}

export function classifyVoidWriteError(err: unknown): VoidErrorClass {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  if (code === 'not-found' || code.endsWith('/not-found')) return 'not_found';
  if (code === 'permission-denied' || code.endsWith('/permission-denied')) {
    return 'permission_denied';
  }
  if (code === 'invalid-argument' || code.endsWith('/invalid-argument')) {
    return 'invalid_argument';
  }
  if (
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'resource-exhausted' ||
    code === 'internal' ||
    code === 'aborted' ||
    code === 'cancelled' ||
    code.endsWith('/unavailable') ||
    code.endsWith('/deadline-exceeded')
  ) {
    return 'unavailable';
  }
  if (!code) return 'unknown';
  return 'transport';
}

function isNearUtc7DayBoundary(serverCreatedAtMs: number, nowMs: number, marginMs: number): boolean {
  const createdDay = utcPlus7Date(serverCreatedAtMs);
  const nowDay = utcPlus7Date(nowMs);
  if (createdDay !== nowDay) return true;
  const shifted = new Date(nowMs + 7 * 60 * 60 * 1000);
  shifted.setUTCHours(24, 0, 0, 0);
  const nextMidnightUtc7 = shifted.getTime() - 7 * 60 * 60 * 1000;
  return nextMidnightUtc7 - nowMs <= marginMs;
}

async function writePendingVoidFields(rec: VoidIntentRecord): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    throw Object.assign(new Error('Firebase unavailable'), { code: 'unavailable' });
  }
  // Seven permitted keys only: voidRequested, status, voidReason, voidedBy,
  // deviceId, voidedAt, updatedAt. voidedBy is replayed verbatim from the intent.
  await updateDoc(doc(db, 'asyncOrders', rec.orderId), {
    ...buildPendingVoidFields({
      reason: rec.reason,
      note: rec.note ?? undefined,
      voidedBy: rec.voidedBy,
    }),
    deviceId: getDeviceId(),
    voidedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export type DrainVoidIntentDeps = {
  store: ReversalLocalStore;
  nowMs: number;
  isOnline: boolean;
  owner: string;
  intervalMs: number;
  /** Freshly evaluated current-cycle staff identity. Compared to durable voidedBy before write. */
  currentStaffId: string;
  readServer?: (orderId: string) => Promise<AsyncOrderVoidPreflightRead>;
  writeVoid?: (rec: VoidIntentRecord) => Promise<void>;
  backoffMs?: (attemptsAfterFailure: number) => number;
  maxAttempts?: number;
};

export type DrainVoidIntentResult =
  | 'confirmed'
  | 'retryable'
  | 'terminal'
  | 'deferred'
  | 'skipped';

export async function drainOneVoidIntent(
  orderId: string,
  deps: DrainVoidIntentDeps,
): Promise<DrainVoidIntentResult> {
  const claimed = await claimVoidIntent(deps.store, orderId, deps.owner, deps.nowMs);
  if (!claimed) return 'skipped';
  return evaluateAndApplyVoidDrain(claimed, deps);
}

async function evaluateAndApplyVoidDrain(
  claimed: VoidIntentRecord,
  deps: DrainVoidIntentDeps,
): Promise<DrainVoidIntentResult> {
  const readServer = deps.readServer ?? readAsyncOrderForVoidPreflight;
  const writeVoid = deps.writeVoid ?? writePendingVoidFields;
  const maxAttempts = deps.maxAttempts ?? 8;

  if (claimed.voidedBy !== deps.currentStaffId) {
    await markVoidIntentTerminal(
      deps.store,
      claimed.orderId,
      'staff_identity_mismatch',
      'permission_denied',
      deps.nowMs,
    );
    return 'terminal';
  }

  if (!deps.isOnline) {
    await deferVoidIntentPending(
      deps.store,
      claimed.orderId,
      deps.nowMs + deps.intervalMs,
      deps.nowMs,
    );
    return 'deferred';
  }

  const read = await readServer(claimed.orderId);
  if (read.kind === 'unavailable') {
    return applyRetryable(claimed, deps, read.errorClass);
  }

  const decision = decideVoidPreflight({
    serverOrder: read.order,
    nowMs: deps.nowMs,
    isOnline: true,
  });

  if (decision.action === 'confirm') {
    await markVoidIntentConfirmed(
      deps.store,
      claimed.orderId,
      deps.nowMs,
      read.order.serverCreatedAtMs,
    );
    return 'confirmed';
  }

  if (decision.action === 'block' && decision.reason === 'order_absent_server_side') {
    await deferVoidIntentPending(
      deps.store,
      claimed.orderId,
      deps.nowMs + deps.intervalMs,
      deps.nowMs,
      read.order.serverCreatedAtMs,
    );
    return 'deferred';
  }

  if (decision.action === 'block' && decision.reason === 'day_boundary_expired') {
    await markVoidIntentTerminal(
      deps.store,
      claimed.orderId,
      'day_boundary_expired',
      'permission_denied',
      deps.nowMs,
    );
    return 'terminal';
  }

  if (decision.action === 'block' && decision.reason === 'not_online') {
    await deferVoidIntentPending(
      deps.store,
      claimed.orderId,
      deps.nowMs + deps.intervalMs,
      deps.nowMs,
    );
    return 'deferred';
  }

  try {
    await writeVoid(claimed);
    await markVoidIntentConfirmed(
      deps.store,
      claimed.orderId,
      deps.nowMs,
      read.order.serverCreatedAtMs,
    );
    return 'confirmed';
  } catch (err) {
    const errorClass = classifyVoidWriteError(err);
    if (errorClass === 'not_found') {
      await markVoidIntentTerminal(
        deps.store,
        claimed.orderId,
        'order_absent_server_side',
        'not_found',
        deps.nowMs,
      );
      return 'terminal';
    }
    if (errorClass === 'permission_denied') {
      const near =
        read.order.serverCreatedAtMs != null &&
        isNearUtc7DayBoundary(
          read.order.serverCreatedAtMs,
          deps.nowMs,
          VOID_DAY_BOUNDARY_MARGIN_MS,
        );
      const reason: VoidTerminalReason = near ? 'day_boundary_expired' : 'authority_refused';
      await markVoidIntentTerminal(
        deps.store,
        claimed.orderId,
        reason,
        'permission_denied',
        deps.nowMs,
      );
      return 'terminal';
    }
    if (errorClass === 'invalid_argument') {
      await markVoidIntentTerminal(
        deps.store,
        claimed.orderId,
        'malformed_intent',
        'invalid_argument',
        deps.nowMs,
      );
      return 'terminal';
    }
    if (claimed.attempts + 1 >= maxAttempts) {
      await markVoidIntentTerminal(
        deps.store,
        claimed.orderId,
        'attempt_ceiling_reached',
        errorClass,
        deps.nowMs,
      );
      return 'terminal';
    }
    return applyRetryable(claimed, deps, errorClass);
  }
}

async function applyRetryable(
  claimed: VoidIntentRecord,
  deps: DrainVoidIntentDeps,
  errorClass: VoidErrorClass,
): Promise<DrainVoidIntentResult> {
  const maxAttempts = deps.maxAttempts ?? 8;
  const nextAttempts = claimed.attempts + 1;
  if (nextAttempts >= maxAttempts) {
    await markVoidIntentTerminal(
      deps.store,
      claimed.orderId,
      'attempt_ceiling_reached',
      errorClass,
      deps.nowMs,
    );
    return 'terminal';
  }
  const delay = deps.backoffMs ? deps.backoffMs(nextAttempts) : 5_000;
  await markVoidIntentRetryable(
    deps.store,
    claimed.orderId,
    errorClass,
    deps.nowMs + delay,
    deps.nowMs,
  );
  return 'retryable';
}

/**
 * Submits an offline-first void request for a pending sale.
 * Durable enqueue happens first. An online attempt drains this intent immediately.
 */
export async function requestPendingVoid(
  orderId: string,
  input: PendingVoidRequest,
  nowMs: number = Date.now(),
  store: ReversalLocalStore = createIndexedDbReversalStore(),
): Promise<VoidRequestOutcome> {
  const enqueued = await enqueueVoidIntent(
    store,
    orderId,
    {
      branchId: input.branchId,
      deviceId: getDeviceId(),
      reason: input.reason,
      note: input.note,
      voidedBy: input.voidedBy,
    },
    nowMs,
  );

  if (enqueued.kind === 'confirmed_noop') return { kind: 'confirmed' };
  if (enqueued.kind === 'terminal_noop') {
    return { kind: 'blocked', reason: enqueued.record.terminalReason ?? 'authority_refused' };
  }

  const online = typeof navigator === 'undefined' ? false : navigator.onLine !== false;
  if (!online || !isFirebaseConfigured || !db) {
    return { kind: 'queued' };
  }

  const drain = await drainOneVoidIntent(orderId, {
    store,
    nowMs,
    isOnline: true,
    owner: `void-immediate:${getDeviceId()}`,
    intervalMs: 120_000,
    currentStaffId: input.voidedBy,
  });

  if (drain === 'confirmed') return { kind: 'confirmed' };
  if (drain === 'terminal') {
    const rec = await getVoidIntent(store, orderId);
    return { kind: 'blocked', reason: rec?.terminalReason ?? 'authority_refused' };
  }
  return { kind: 'queued' };
}
