/**
 * Return/Refund V1 — durable recovery identity for an UNRESOLVED online Return
 * attempt (D-RET-FIX-7), with cross-window ownership (recovery gate C2).
 *
 * A Return attempt whose transport outcome is unknown is a money/stock
 * operation identity: if the server committed but the response was lost,
 * minting a NEW attempt for the same physical items could restore stock and
 * refund twice. So the exact attempt is persisted (before it is sent) and
 * survives closing/reopening the modal or reloading the app; while it exists
 * the UI offers only resolve / retry of THAT attempt.
 *
 * C2 — ONE unresolved attempt per branch + sale across every tab/window of
 * this origin. The ownership gate is a single durable `readwrite`
 * transaction (read → compare → write) of the reversal domain store: the
 * IndexedDB spec runs overlapping readwrite transactions one at a time across
 * EVERY connection to the database (the primitive `deviceId.ts` relies on for
 * its sequence), and the native committed SQLite store serializes readwrite
 * sessions (`BEGIN IMMEDIATE`) across webviews, so two windows can never both
 * see "absent" and both claim. localStorage read-then-set, an in-memory mutex
 * or `storage` events are not atomic across processes and are deliberately
 * not used. No store (or a failed / blocked open) ⇒ every operation reports
 * unavailable and the caller refuses to send.
 *
 *   claim    before EVERY send: absent → write; same attemptId → ok; another
 *            attemptId → that attempt is returned (the caller adopts it and
 *            sends nothing); unreadable record → refused.
 *   release  only when the stored attemptId equals the caller's: a stale
 *            window can never delete a newer or foreign attempt.
 *
 * This is NOT an offline Return queue — nothing here is ever executed
 * locally. It stores only non-secret identity/payload fields: never the PIN,
 * a Firebase token, OAC/private keys or credential hashes.
 */

import type { SaleReturnRefundMethod } from './saleReturnTypes';
import {
  createIndexedDbReversalStore,
  type ReversalLocalStore,
  type ReversalStoreName,
} from '../pos/offline/reversalLocalStore';

export const UNRESOLVED_RETURN_STATE = 'UNKNOWN_PENDING_RESOLUTION' as const;

export type UnresolvedReturnAttempt = {
  schemaVersion: 1;
  state: typeof UNRESOLVED_RETURN_STATE;
  attemptId: string;
  orderId: string;
  branchId: string;
  requesterStaffId: string;
  lines: { lineIndex: number; productId: string; qty: number }[];
  refundMethod: SaleReturnRefundMethod;
  refundReference: string;
  reason: string;
  note: string;
  expectedRefundAmount: number;
  shiftId: string | null;
  approverStaffId: string;
  approverDisplayName: string;
  recordedAtMs: number;
};

/** The non-secret payload of one attempt (the callable input minus the PIN). */
export type ReturnAttemptPayload = Pick<
  UnresolvedReturnAttempt,
  | 'attemptId'
  | 'orderId'
  | 'branchId'
  | 'lines'
  | 'refundMethod'
  | 'refundReference'
  | 'reason'
  | 'note'
  | 'expectedRefundAmount'
  | 'shiftId'
  | 'approverStaffId'
>;

/** One atomic read/write unit over the attempt records (see the module comment). */
export interface ReturnAttemptTxn {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ReturnAttemptStore {
  transact<T>(mode: 'readonly' | 'readwrite', fn: (txn: ReturnAttemptTxn) => Promise<T>): Promise<T>;
}

/**
 * Records live in the reversal domain's `markers` store (its local
 * idempotency guards; only ever read/written by exact key, never enumerated)
 * under {@link unresolvedAttemptKey} — no new database, object store or
 * schema version. On the native POS that domain is the committed SQLite
 * durable store (`BEGIN IMMEDIATE` sessions, serialized across webviews);
 * in a browser it is IndexedDB (readwrite transactions serialized across
 * every connection/tab).
 */
const ATTEMPT_STORE: ReversalStoreName = 'markers';

const KEY_PREFIX = 'twinpet.saleReturn.unresolved.v1';
const REFUND_METHODS: readonly SaleReturnRefundMethod[] = ['cash', 'qr', 'kbank', 'card', 'none'];

export function unresolvedAttemptKey(branchId: string, orderId: string): string {
  return `${KEY_PREFIX}:${branchId}:${orderId}`;
}

/** Production store over the reversal domain (native SQLite when committed, else IndexedDB). */
export function createReversalBackedReturnAttemptStore(
  base: ReversalLocalStore = createIndexedDbReversalStore(),
): ReturnAttemptStore {
  return {
    transact: (mode, fn) =>
      base.transact([ATTEMPT_STORE], mode, (txn) =>
        fn({
          get: (key) => txn.get(ATTEMPT_STORE, key),
          put: (key, value) => txn.put(ATTEMPT_STORE, key, value),
          delete: (key) => txn.delete(ATTEMPT_STORE, key),
        }),
      ),
  };
}
/**
 * Test double with the SAME guarantees: readwrite transactions run one at a
 * time (FIFO) and commit all-or-nothing; reads see committed data only.
 */
export function createInMemoryReturnAttemptStore(): ReturnAttemptStore & { dump: () => Record<string, unknown> } {
  let data = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve();
  const run = async <T>(mode: 'readonly' | 'readwrite', fn: (txn: ReturnAttemptTxn) => Promise<T>): Promise<T> => {
    const working = new Map(data);
    const result = await fn({
      get: async (key) => {
        const v = working.get(key);
        return v === undefined ? undefined : JSON.parse(v);
      },
      put: async (key, value) => {
        if (mode !== 'readwrite') throw new Error('put in readonly transaction');
        working.set(key, JSON.stringify(value));
      },
      delete: async (key) => {
        if (mode !== 'readwrite') throw new Error('delete in readonly transaction');
        working.delete(key);
      },
    });
    if (mode === 'readwrite') data = working;
    return result;
  };
  return {
    transact(mode, fn) {
      if (mode === 'readonly') return run(mode, fn);
      const p = tail.then(() => run(mode, fn));
      tail = p.catch(() => undefined);
      return p;
    },
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)])),
  };
}

let defaultStore: ReturnAttemptStore | null = null;
function store(): ReturnAttemptStore {
  defaultStore ??= createReversalBackedReturnAttemptStore();
  return defaultStore;
}

/** Test seam: replace (or with `null` reset) the process-wide store. */
export function __setReturnAttemptStoreForTests(s: ReturnAttemptStore | null): void {
  defaultStore = s;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function parseRecord(raw: unknown, branchId: string, orderId: string): UnresolvedReturnAttempt | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1 || r.state !== UNRESOLVED_RETURN_STATE) return null;
  if (r.branchId !== branchId || r.orderId !== orderId) return null;
  if (!isStr(r.attemptId) || !r.attemptId || !isStr(r.requesterStaffId) || !isStr(r.approverStaffId)) return null;
  if (!isStr(r.refundReference) || !isStr(r.reason) || !isStr(r.note) || !isStr(r.approverDisplayName)) return null;
  if (!REFUND_METHODS.includes(r.refundMethod as SaleReturnRefundMethod)) return null;
  if (typeof r.expectedRefundAmount !== 'number' || !Number.isFinite(r.expectedRefundAmount)) return null;
  if (r.shiftId !== null && !isStr(r.shiftId)) return null;
  if (typeof r.recordedAtMs !== 'number') return null;
  if (!Array.isArray(r.lines) || r.lines.length === 0) return null;
  const lines: UnresolvedReturnAttempt['lines'] = [];
  for (const l of r.lines as unknown[]) {
    if (l === null || typeof l !== 'object') return null;
    const line = l as Record<string, unknown>;
    if (typeof line.lineIndex !== 'number' || !isStr(line.productId) || typeof line.qty !== 'number') return null;
    lines.push({ lineIndex: line.lineIndex, productId: line.productId, qty: line.qty });
  }
  return {
    schemaVersion: 1,
    state: UNRESOLVED_RETURN_STATE,
    attemptId: r.attemptId,
    orderId,
    branchId,
    requesterStaffId: r.requesterStaffId,
    lines,
    refundMethod: r.refundMethod as SaleReturnRefundMethod,
    refundReference: r.refundReference,
    reason: r.reason,
    note: r.note,
    expectedRefundAmount: r.expectedRefundAmount,
    shiftId: (r.shiftId as string | null) ?? null,
    approverStaffId: r.approverStaffId,
    approverDisplayName: r.approverDisplayName,
    recordedAtMs: r.recordedAtMs,
  };
}

/** `null` = none; `undefined` = present-but-unreadable or no store (callers must fail closed). */
function classify(raw: unknown, branchId: string, orderId: string): UnresolvedReturnAttempt | null | undefined {
  if (raw === undefined) return null;
  return parseRecord(raw, branchId, orderId) ?? undefined;
}

/** `undefined` = storage unreadable (callers must fail closed: no new attempt). */
export async function readUnresolvedReturnAttempt(
  branchId: string,
  orderId: string,
  s: ReturnAttemptStore = store(),
): Promise<UnresolvedReturnAttempt | null | undefined> {
  try {
    const raw = await s.transact('readonly', (txn) => txn.get(unresolvedAttemptKey(branchId, orderId)));
    return classify(raw, branchId, orderId);
  } catch {
    return undefined;
  }
}

export type ClaimReturnAttemptResult =
  /** The store now holds THIS attempt (newly written, or already this attemptId). Safe to send. */
  | { kind: 'owned'; record: UnresolvedReturnAttempt }
  /** Another unresolved attempt owns this sale: adopt it, send NOTHING. */
  | { kind: 'other'; record: UnresolvedReturnAttempt }
  /** No store / unreadable record / write failed: send nothing. */
  | { kind: 'unavailable' };

/**
 * The cross-window ownership gate, called before EVERY send of an attempt.
 * Builds the record field by field from the payload, so a PIN (or anything
 * else) passed alongside can never be stored.
 */
export async function claimUnresolvedReturnAttempt(
  payload: ReturnAttemptPayload,
  meta: { requesterStaffId: string; approverDisplayName: string; nowMs?: number },
  s: ReturnAttemptStore = store(),
): Promise<ClaimReturnAttemptResult> {
  if (!payload.attemptId) return { kind: 'unavailable' };
  const record: UnresolvedReturnAttempt = {
    schemaVersion: 1,
    state: UNRESOLVED_RETURN_STATE,
    attemptId: payload.attemptId,
    orderId: payload.orderId,
    branchId: payload.branchId,
    requesterStaffId: meta.requesterStaffId,
    lines: payload.lines.map((l) => ({ lineIndex: l.lineIndex, productId: l.productId, qty: l.qty })),
    refundMethod: payload.refundMethod,
    refundReference: payload.refundReference,
    reason: payload.reason,
    note: payload.note,
    expectedRefundAmount: payload.expectedRefundAmount,
    shiftId: payload.shiftId,
    approverStaffId: payload.approverStaffId,
    approverDisplayName: meta.approverDisplayName,
    recordedAtMs: meta.nowMs ?? Date.now(),
  };
  const key = unresolvedAttemptKey(payload.branchId, payload.orderId);
  try {
    return await s.transact('readwrite', async (txn): Promise<ClaimReturnAttemptResult> => {
      const existing = classify(await txn.get(key), payload.branchId, payload.orderId);
      if (existing === undefined) return { kind: 'unavailable' };
      if (existing) {
        return existing.attemptId === payload.attemptId
          ? { kind: 'owned', record: existing }
          : { kind: 'other', record: existing };
      }
      await txn.put(key, record);
      return { kind: 'owned', record };
    });
  } catch {
    return { kind: 'unavailable' };
  }
}

export type ReleaseReturnAttemptResult = 'released' | 'absent' | 'not_owner' | 'unavailable';

/**
 * Only after a definitive outcome of THIS attempt (committed, or fenced /
 * definitively not committed). Deletes the record ONLY if it still carries
 * `attemptId`; a different (newer or foreign) attempt is never touched.
 */
export async function releaseUnresolvedReturnAttempt(
  branchId: string,
  orderId: string,
  attemptId: string,
  s: ReturnAttemptStore = store(),
): Promise<ReleaseReturnAttemptResult> {
  const key = unresolvedAttemptKey(branchId, orderId);
  try {
    return await s.transact('readwrite', async (txn): Promise<ReleaseReturnAttemptResult> => {
      const raw = await txn.get(key);
      if (raw === undefined) return 'absent';
      const existing = parseRecord(raw, branchId, orderId);
      if (!existing || existing.attemptId !== attemptId) return 'not_owner';
      await txn.delete(key);
      return 'released';
    });
  } catch {
    return 'unavailable';
  }
}

export function payloadFromUnresolved(rec: UnresolvedReturnAttempt): ReturnAttemptPayload {
  return {
    attemptId: rec.attemptId,
    orderId: rec.orderId,
    branchId: rec.branchId,
    lines: rec.lines,
    refundMethod: rec.refundMethod,
    refundReference: rec.refundReference,
    reason: rec.reason,
    note: rec.note,
    expectedRefundAmount: rec.expectedRefundAmount,
    shiftId: rec.shiftId,
    approverStaffId: rec.approverStaffId,
  };
}
