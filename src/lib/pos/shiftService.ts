import {
  arrayUnion,
  collection,
  doc,
  getDocFromCache,
  getDocFromServer,
  getDocs,
  increment,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { CashTransactionType, Shift, ShiftCashEntry } from '../types';
import type { PaymentSplit } from './types';
import { getDeviceId } from './deviceId';
import {
  createShiftCloseIntentJournal,
  type ShiftCloseIntentJournal,
} from './offline/shiftCloseIntentStore';
import type { ShiftCloseIntentSnapshot } from './offline/shiftCloseIntentTypes';
import {
  reconcileShiftCloseIntent,
  type ShiftCloseConfirmationDoc,
  type ShiftCloseConfirmationRead,
  type ShiftCloseConfirmationReader,
  type ShiftCloseNormalizer,
} from './offline/shiftCloseReconciler';
import {
  devCloseShift,
  devGetActiveShift,
  devOpenShift,
  devRecordCashTransaction,
} from './shiftDevMock';

export type RecordCashTransactionInput = {
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  type: CashTransactionType;
  amount: number;
  note: string;
};

export function calcShiftDrawerExpected(
  shift: Pick<Shift, 'startingCash' | 'expectedCash' | 'payInTotal' | 'payOutTotal'>,
): number {
  return (
    shift.startingCash +
    shift.expectedCash +
    (shift.payInTotal || 0) -
    (shift.payOutTotal || 0)
  );
}

export function buildCreditDebtPaymentShiftUpdate(
  paymentMethod: 'cash' | 'transfer',
  amount: number,
): Record<string, ReturnType<typeof increment>> {
  if (paymentMethod === 'cash') {
    return { expectedCash: increment(amount) };
  }
  return { expectedKbank: increment(amount) };
}

export function calcShiftPaymentTotals(payments: PaymentSplit[], grandTotal: number) {
  const paidAmt = payments.reduce((s, p) => s + p.amount, 0);
  const cashPayment = payments
    .filter((p) => p.method === 'cash')
    .reduce((s, p) => s + p.amount, 0);
  const qrTotal = payments.filter((p) => p.method === 'qr').reduce((s, p) => s + p.amount, 0);
  const kbankTotal = payments
    .filter((p) => p.method === 'kbank')
    .reduce((s, p) => s + p.amount, 0);
  const cardTotal = payments.filter((p) => p.method === 'card').reduce((s, p) => s + p.amount, 0);
  const creditTotal = payments
    .filter((p) => p.method === 'credit')
    .reduce((s, p) => s + p.amount, 0);
  const changeAmt = Math.max(0, paidAmt - grandTotal);
  const netCash = Math.max(0, cashPayment - changeAmt);
  return { netCash, qrTotal, kbankTotal, cardTotal, creditTotal };
}

export function applyShiftPaymentTotals(shift: Shift, payments: PaymentSplit[], grandTotal: number): Shift {
  const { netCash, qrTotal, kbankTotal, cardTotal, creditTotal } = calcShiftPaymentTotals(
    payments,
    grandTotal,
  );
  return {
    ...shift,
    expectedCash: shift.expectedCash + netCash,
    expectedQr: shift.expectedQr + qrTotal,
    expectedKbank: shift.expectedKbank + kbankTotal,
    expectedCard: shift.expectedCard + cardTotal,
    expectedCredit: shift.expectedCredit + creditTotal,
    totalBills: shift.totalBills + 1,
  };
}

function mapShift(id: string, data: Record<string, unknown>): Shift {
  return {
    id,
    branchId: data.branchId as string,
    staffId: data.staffId as string,
    staffName: data.staffName as string,
    status: data.status as Shift['status'],
    openedAt: data.openedAt as Shift['openedAt'],
    closedAt: (data.closedAt ?? null) as Shift['closedAt'],
    startingCash: (data.startingCash as number) ?? 0,
    actualCashCount: (data.actualCashCount as number) ?? 0,
    expectedCash: (data.expectedCash as number) ?? 0,
    expectedQr: (data.expectedQr as number) ?? 0,
    expectedKbank: (data.expectedKbank as number) ?? 0,
    expectedCard: (data.expectedCard as number) ?? 0,
    expectedCredit: (data.expectedCredit as number) ?? 0,
    totalBills: (data.totalBills as number) ?? 0,
    payInTotal: (data.payInTotal as number) ?? 0,
    payOutTotal: (data.payOutTotal as number) ?? 0,
    variance: (data.variance as number) ?? 0,
    note: (data.note as string) ?? '',
    // Embedded offline cash movements — folded into the derived drawer.
    cashEntries: (data.cashEntries as ShiftCashEntry[]) ?? [],
  };
}

export async function getActiveShift(branchId: string, staffId: string): Promise<Shift | null> {
  if (!isFirebaseConfigured || !db) {
    return devGetActiveShift(branchId, staffId);
  }

  const snap = await getDocs(
    query(
      collection(db, collections.shifts),
      where('branchId', '==', branchId),
      where('staffId', '==', staffId),
      where('status', '==', 'open'),
      limit(1),
    ),
  );

  if (snap.empty) return null;
  const docSnap = snap.docs[0]!;
  return mapShift(docSnap.id, docSnap.data());
}

export async function openShift(
  branchId: string,
  staffId: string,
  staffName: string,
  startingCash: number,
): Promise<string> {
  if (!isFirebaseConfigured || !db) {
    return devOpenShift(branchId, staffId, staffName, startingCash);
  }

  const ref = doc(collection(db, collections.shifts));
  await setDoc(ref, {
    id: ref.id,
    branchId,
    staffId,
    staffName,
    status: 'open',
    openedAt: serverTimestamp(),
    closedAt: null,
    startingCash,
    actualCashCount: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 0,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
  });
  return ref.id;
}

// Packet 7C-B1 (Option 2) — local optimistic offline close. Honest error copy;
// no claim of server acceptance/settlement while pending.
const CLOSE_SHIFT_UNVERIFIABLE_MESSAGE =
  'ไม่สามารถยืนยันสถานะกะจากข้อมูลในเครื่องได้ กรุณาลองใหม่ หรือเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง';
const CLOSE_SHIFT_ALREADY_CLOSED_MESSAGE = 'กะนี้ถูกปิดไปแล้ว';
const CLOSE_SHIFT_STORE_UNAVAILABLE_MESSAGE =
  'บันทึกการปิดกะแบบออฟไลน์ไม่สำเร็จ (พื้นที่จัดเก็บในเครื่องไม่พร้อมใช้งานหรือเต็ม) กรุณาลองใหม่ หรือเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง';
const CLOSE_SHIFT_CONFLICT_MESSAGE =
  'พบข้อมูลปิดกะอื่นสำหรับกะนี้ในเครื่องนี้อยู่แล้ว กรุณาตรวจสอบก่อนดำเนินการต่อ';

let defaultShiftCloseIntentJournal: ShiftCloseIntentJournal | undefined;
function getDefaultShiftCloseIntentJournal(): ShiftCloseIntentJournal {
  if (!defaultShiftCloseIntentJournal) {
    defaultShiftCloseIntentJournal = createShiftCloseIntentJournal();
  }
  return defaultShiftCloseIntentJournal;
}

/**
 * Packet 7C-B2 — confirmation-grade shift-doc reader. `getDocFromServer`
 * bypasses `persistentLocalCache` entirely (same rationale as
 * `asyncOrderLookup.ts`'s `createAsyncOrderServerLookup`): a cache-first read
 * could return this device's own queued, unflushed write and falsely report a
 * confirmed close before the server has ever seen it. Never throws — an
 * offline/unreachable/errored read is reported as `{ ok: false }` so the
 * reconciler treats it as "stay pending", never as a rejection.
 */
export const readShiftCloseConfirmation: ShiftCloseConfirmationReader = async (
  shiftId,
): Promise<ShiftCloseConfirmationRead> => {
  if (!isFirebaseConfigured || !db) return { ok: false };
  try {
    const snap = await getDocFromServer(doc(db, collections.shifts, shiftId));
    if (!snap.exists()) return { ok: true, doc: { exists: false } };
    const data = snap.data() as Record<string, unknown>;
    const confirmationDoc: ShiftCloseConfirmationDoc = {
      exists: true,
      status: data.status as string | undefined,
      closedAt: data.closedAt,
      closedOffline: data.closedOffline as boolean | undefined,
      syncState: data.syncState as ShiftCloseConfirmationDoc['syncState'],
      deviceId: (data.deviceId as string | null | undefined) ?? null,
      branchId: data.branchId as string | undefined,
      staffId: data.staffId as string | undefined,
      startingCash: data.startingCash as number | undefined,
      actualCashCount: data.actualCashCount as number | undefined,
      variance: data.variance as number | undefined,
      expectedCash: data.expectedCash as number | undefined,
      expectedQr: data.expectedQr as number | undefined,
      expectedKbank: data.expectedKbank as number | undefined,
      expectedCard: data.expectedCard as number | undefined,
      expectedCredit: data.expectedCredit as number | undefined,
      payInTotal: data.payInTotal as number | undefined,
      payOutTotal: data.payOutTotal as number | undefined,
      totalBills: data.totalBills as number | undefined,
      note: data.note as string | undefined,
    };
    return { ok: true, doc: confirmationDoc };
  } catch {
    return { ok: false };
  }
};

/**
 * Packet 7C-B2 Variant C — the ONE field this packet ever normalizes on an
 * already-closed doc. Guardrails (confirmed identity, `syncState === 'pending'`,
 * device match) are enforced by the caller (`reconcileShiftCloseIntent`); this
 * function is intentionally a "dumb", single-field writer.
 */
export const normalizeShiftCloseSyncState: ShiftCloseNormalizer = async (shiftId) => {
  if (!isFirebaseConfigured || !db) return;
  await updateDoc(doc(db, collections.shifts, shiftId), { syncState: 'synced' });
};

/**
 * Same-runtime confirmation outcome surfaced to the UI (Packet 7C-B2). Distinct
 * from {@link ReconcileShiftCloseIntentResult} (the sweep-facing shape) — this is
 * the narrower, UI-facing contract `closeShift`'s `whenServerConfirmed` resolves to.
 * Resolves exactly once; a `still_pending`/`unreachable` outcome here means the
 * boot/reconnect sweep (a later trigger) will pick the intent back up, not this
 * mounted component.
 */
export type ShiftCloseConfirmation =
  | { outcome: 'confirmed'; closedAt: Date }
  | { outcome: 'still_pending' }
  | { outcome: 'identity_mismatch' }
  | { outcome: 'unreachable' }
  | { outcome: 'rejected'; message: string };

export type CloseShiftResult = Shift & {
  /**
   * Resolves once the SAME-RUNTIME write settles AND (only on ACK) a
   * confirmation-grade server read proves the close — never from the ACK
   * promise alone (SERVER-CONFIRMATION CONTRACT). The journal transition
   * (`local_closed_pending -> synced`/`rejected_manual_attention`) happens via
   * the same underlying reconciliation regardless of whether any caller ever
   * awaits this handle — see the fire-and-forget wiring in `closeShift`.
   */
  whenServerConfirmed: Promise<ShiftCloseConfirmation>;
};

export type CloseShiftDeps = {
  /** Injectable for tests; production uses the lazily-created IndexedDB-backed journal. */
  journal?: ShiftCloseIntentJournal;
  /** Injectable for tests; production uses {@link readShiftCloseConfirmation}. */
  readConfirmation?: ShiftCloseConfirmationReader;
  /** Injectable for tests; production uses {@link normalizeShiftCloseSyncState}. */
  normalizeSyncState?: ShiftCloseNormalizer;
};

/**
 * Close a shift — Packet 7C-B1 (Option 2) local optimistic offline close,
 * extended by Packet 7C-B2 with same-runtime confirmation reconciliation.
 * Under the drawer single-writer model the terminal is the sole authority for
 * the shift's sale totals, so the caller passes the shift it has already
 * DERIVED from its local ledger ({@link deriveShiftDrawer}); we never re-read
 * the (now reconciler-untouched) stored `expected*` fields.
 *
 * This function never awaits the network:
 *  1. Verifies the shift is still open from the LOCAL CACHE ONLY
 *     (`getDocFromCache`) — a cold/stale/unverifiable cache fails fast rather
 *     than fabricating a close.
 *  2. Persists a durable local close-intent (survives reload) BEFORE the
 *     shift-doc write — a durable-store failure (unavailable/quota) also fails
 *     fast; there is no cache-only fallback.
 *  3. Queues a non-awaited `updateDoc` on the shift doc, INCLUDING
 *     `closedAt: serverTimestamp()` — the persisted shift document must keep
 *     an authoritative server close time (matching the pre-7C-B1 baseline);
 *     omitting it would leave a synced closed shift with `closedAt: null`
 *     forever. Firestore's `persistentLocalCache` applies this mutation to
 *     the local cache instantly and flushes on reconnect.
 *  4. Returns a client-built FROZEN closed snapshot immediately, PLUS
 *     `whenServerConfirmed` (Packet 7C-B2): once the queued write ACKs, a
 *     confirmation-grade read (never the ACK promise alone) reconciles the
 *     local journal (`local_closed_pending -> synced`/`rejected_manual_attention`)
 *     via the SAME {@link reconcileShiftCloseIntent} the boot/reconnect sweeps
 *     use. This fire-and-forget reconciliation always runs, whether or not any
 *     caller awaits `whenServerConfirmed` — a mounted Z-report only OBSERVES it
 *     to flip pending -> confirmed/attention; it never gates or delays this
 *     function's return. The RETURNED object's `closedAt` is never back-filled
 *     with a fake local/device timestamp — `serverTimestamp()` is a write-only
 *     sentinel that only resolves once read back from Firestore, so the
 *     immediate return keeps whatever `closedAt` the caller's shift already
 *     carried (typically `null`). `closedAtLocal` carries the honest device
 *     time for display until `whenServerConfirmed` (or a later boot/reconnect
 *     sweep) resolves the real server value.
 */
export async function closeShift(
  shift: Shift,
  actualCashCount: number,
  note: string,
  deps?: CloseShiftDeps,
): Promise<CloseShiftResult> {
  if (!isFirebaseConfigured || !db) {
    const closed = devCloseShift(shift.id, actualCashCount, note);
    const closedAtServer =
      closed.closedAt != null && typeof (closed.closedAt as { toDate?: unknown }).toDate === 'function'
        ? (closed.closedAt as { toDate: () => Date }).toDate()
        : new Date();
    return {
      ...closed,
      whenServerConfirmed: Promise.resolve({ outcome: 'confirmed', closedAt: closedAtServer }),
    };
  }

  const ref = doc(db, collections.shifts, shift.id);

  let cached;
  try {
    cached = await getDocFromCache(ref);
  } catch {
    throw new Error(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
  }
  if (!cached.exists()) {
    throw new Error(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
  }
  if ((cached.data() as { status?: string }).status !== 'open') {
    throw new Error(CLOSE_SHIFT_ALREADY_CLOSED_MESSAGE);
  }

  const totalExpected = calcShiftDrawerExpected(shift);
  const variance = actualCashCount - totalExpected;
  const closedAtLocal = Date.now();
  const deviceId = getDeviceId();

  const snapshot: ShiftCloseIntentSnapshot = {
    shiftId: shift.id,
    branchId: shift.branchId,
    staffId: shift.staffId,
    staffName: shift.staffName,
    startingCash: shift.startingCash,
    expectedCash: shift.expectedCash,
    expectedQr: shift.expectedQr,
    expectedKbank: shift.expectedKbank,
    expectedCard: shift.expectedCard,
    expectedCredit: shift.expectedCredit,
    payInTotal: shift.payInTotal,
    payOutTotal: shift.payOutTotal,
    totalBills: shift.totalBills,
    actualCashCount,
    variance,
    note,
    closedAtLocal,
    deviceId,
  };

  const journal = deps?.journal ?? getDefaultShiftCloseIntentJournal();
  const intentResult = await journal.upsertCloseIntent(snapshot);
  if (!intentResult.ok) {
    if (intentResult.code === 'conflict') {
      throw new Error(CLOSE_SHIFT_CONFLICT_MESSAGE);
    }
    throw new Error(CLOSE_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  }

  const writeAck = updateDoc(ref, {
    status: 'closed',
    // Authoritative server close time on the persisted doc. Omitting it would
    // leave a synced closed shift with `closedAt: null` forever; there is no
    // separate `closedAtServer` mirror field to keep in sync, so none is
    // written here (avoids an unread, unresolved, permanently-null field).
    closedAt: serverTimestamp(),
    actualCashCount,
    variance,
    note,
    // Commit the terminal's authoritative sale totals onto the closed doc.
    expectedCash: shift.expectedCash,
    expectedQr: shift.expectedQr,
    expectedKbank: shift.expectedKbank,
    expectedCard: shift.expectedCard,
    expectedCredit: shift.expectedCredit,
    totalBills: shift.totalBills,
    payInTotal: shift.payInTotal,
    payOutTotal: shift.payOutTotal,
    closedOffline: true,
    syncState: 'pending',
    deviceId,
  });

  const readConfirmation = deps?.readConfirmation ?? readShiftCloseConfirmation;
  const normalizeSyncState = deps?.normalizeSyncState ?? normalizeShiftCloseSyncState;
  const pendingEntry = intentResult.value;

  // Packet 7C-B2: the ACK promise alone must NEVER mark the journal `synced`
  // or drive confirmed copy (SAME-RUNTIME ACK RULE) — on ACK it triggers a
  // confirmation-grade reconciliation (the same one boot/reconnect use) which
  // performs the actual journal transition. This chain ALWAYS runs, whether
  // or not `whenServerConfirmed` is ever awaited by a caller. It NEVER
  // rejects — any unexpected failure resolves to a safe non-overclaiming
  // outcome so callers never need a defensive `.catch()`.
  const whenServerConfirmed: Promise<ShiftCloseConfirmation> = (async (): Promise<ShiftCloseConfirmation> => {
    try {
      await writeAck;
    } catch (err) {
      console.warn('[shiftService] closeShift write not yet acked (queued, will retry)', err);
      const message = err instanceof Error ? err.message : String(err);
      try {
        await journal.markRejectedManualAttention(shift.id, message);
      } catch {
        // Best-effort local journal write; the write rejection itself is the
        // authoritative signal reported below regardless.
      }
      return { outcome: 'rejected', message };
    }

    try {
      const result = await reconcileShiftCloseIntent(pendingEntry, {
        journal,
        readConfirmation,
        normalizeSyncState,
        deviceId,
      });
      if (result.outcome === 'confirmed' && result.closedAtServer) {
        return { outcome: 'confirmed', closedAt: result.closedAtServer };
      }
      if (result.outcome === 'identity_mismatch') return { outcome: 'identity_mismatch' };
      if (result.outcome === 'unreachable') return { outcome: 'unreachable' };
      return { outcome: 'still_pending' };
    } catch {
      // Reconciliation itself failed unexpectedly (e.g. a journal write
      // error) — never fabricate confirmation/rejection; the next boot/
      // reconnect sweep will retry.
      return { outcome: 'unreachable' };
    }
  })();

  return {
    // `closedAt` is inherited from `shift` as-is (typically `null`) — never
    // fabricated with a local/device value; the real server-resolved value
    // only appears once a later fetch reads the doc back.
    ...shift,
    status: 'closed',
    actualCashCount,
    variance,
    note,
    closedOffline: true,
    syncState: 'pending',
    deviceId,
    closedAtLocal,
    whenServerConfirmed,
  };
}

/**
 * Record a cash in/out — offline-first. Returns the {@link ShiftCashEntry}
 * SYNCHRONOUSLY (so the caller can append it to the live shift instantly) and
 * fires two QUEUEABLE writes fire-and-forget:
 *   1. `arrayUnion` the entry onto `shifts/{id}.cashEntries[]` — the durable
 *      local source the derived drawer folds (survives an offline reload).
 *   2. a plain `setDoc` to `cashTransactions/{id}` — back-office audit trail.
 * Neither uses `runTransaction`, so both commit to `persistentLocalCache`
 * instantly and flush on reconnect; we must NOT await them or an offline cashier
 * would hang. The old transactional `payInTotal`/`payOutTotal` increment is gone
 * (those totals are now derived from `cashEntries[]` via `foldCashEntries`).
 */
export function recordCashTransaction(input: RecordCashTransactionInput): ShiftCashEntry {
  if (input.amount <= 0) {
    throw new Error('จำนวนเงินต้องมากกว่า 0');
  }
  const note = input.note.trim();
  if (!note) {
    throw new Error('กรุณาระบุหมายเหตุ');
  }

  const id =
    isFirebaseConfigured && db
      ? doc(collection(db, collections.cashTransactions)).id
      : `cash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const entry: ShiftCashEntry = {
    id,
    type: input.type,
    amount: input.amount,
    note,
    staffId: input.staffId,
    staffName: input.staffName,
    at: Date.now(),
  };

  if (!isFirebaseConfigured || !db) {
    devRecordCashTransaction({ shiftId: input.shiftId, entry });
    return entry;
  }

  const firestore = db;
  const shiftRef = doc(firestore, collections.shifts, input.shiftId);

  // 1. Durable local drawer source — queueable append.
  void updateDoc(shiftRef, {
    cashEntries: arrayUnion(entry),
    updatedAt: serverTimestamp(),
  }).catch((err) => {
    console.warn('[shiftService] cashEntry append not yet acked (queued, will retry)', err);
  });

  // 2. Back-office audit doc — queueable setDoc (offline-safe; NOT a transaction).
  void setDoc(doc(firestore, collections.cashTransactions, id), {
    id,
    shiftId: input.shiftId,
    branchId: input.branchId,
    staffId: input.staffId,
    staffName: input.staffName,
    type: input.type,
    amount: input.amount,
    note,
    createdAt: serverTimestamp(),
  }).catch((err) => {
    console.warn('[shiftService] cashTransaction audit not yet acked (queued, will retry)', err);
  });

  return entry;
}
