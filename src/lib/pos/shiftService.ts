import {
  arrayUnion,
  collection,
  doc,
  getDocFromCache,
  getDocFromServer,
  getDocs,
  getDocsFromCache,
  increment,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  waitForPendingWrites,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { CashTransactionType, Shift, ShiftCashEntry } from '../types';
import type { PaymentSplit } from './types';
import { getDeviceId } from './deviceId';
import {
  checkCashEntryIntegrity,
  clearShiftServerCashPending,
  isNavigatorOnline,
  readShiftServerCashPending,
  withMergedCashEntries,
  type CashEntrySource,
} from './shiftCashFreshness';
import {
  createShiftCloseIntentJournal,
  isCommitObservedAttempt,
  snapshotsEqual,
  type ShiftCloseIntentJournal,
} from './offline/shiftCloseIntentStore';
import type {
  PointerRepairObserver,
  ShiftCloseIntentBusinessSnapshot,
  ShiftCloseIntentEntry,
} from './offline/shiftCloseIntentTypes';
import {
  parseCommittedOwnClose,
  reconcileShiftCloseIntent,
  recoverOnlineCloseAttempt,
  shiftCloseConfirmationDocFromData,
  shiftCloseNormalizationDecision,
  type OwnCloseIdentity,
  type ShiftCloseConfirmationRead,
  type ShiftCloseConfirmationReader,
  type ShiftCloseNormalizeOutcome,
  type ShiftCloseNormalizer,
} from './offline/shiftCloseReconciler';
import {
  createShiftOpenIntentJournal,
  type ShiftOpenIntentJournal,
} from './offline/shiftOpenIntentStore';
import type { ShiftOpenIntentBusinessSnapshot, ShiftOpenIntentEntry } from './offline/shiftOpenIntentTypes';
import {
  reconcileShiftOpenIntent,
  type ShiftOpenConfirmationDoc,
  type ShiftOpenConfirmationRead,
  type ShiftOpenConfirmationReader,
} from './offline/shiftOpenReconciler';
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

/**
 * DEC-08 — provenance-preserving boot read for the active shift.
 *
 * `absent` is asserted ONLY from an authoritative source. A cache-derived empty
 * result, an unavailable cache, or a failed read are all `unverifiable` — they
 * are never collapsed into "no active shift", because that collapse is what
 * renders OpenShiftModal over a shift that is already open server-side.
 */
export type ActiveShiftReadResult =
  | { status: 'found'; shift: Shift; provenance: 'server' | 'cache' | 'local_dev' }
  | { status: 'absent'; provenance: 'server' | 'local_dev' }
  | {
      status: 'unverifiable';
      reason: 'cache_empty' | 'cache_unavailable' | 'read_failed';
    };

/** Local copy of inventoryRepository's offline-symptom classifier — keep module-private. */
function isOfflineLikeShiftReadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === 'unavailable') return true;
  const msg = err.message || '';
  return (
    msg.includes('ERR_INTERNET_DISCONNECTED') ||
    msg.includes('WebChannelConnection') ||
    msg.includes('transport errored') ||
    msg.includes('offline')
  );
}

export async function readActiveShiftForBoot(
  branchId: string,
  staffId: string,
): Promise<ActiveShiftReadResult> {
  if (!isFirebaseConfigured || !db) {
    const shift = devGetActiveShift(branchId, staffId);
    return shift
      ? { status: 'found', shift, provenance: 'local_dev' }
      : { status: 'absent', provenance: 'local_dev' };
  }

  const q = query(
    collection(db, collections.shifts),
    where('branchId', '==', branchId),
    where('staffId', '==', staffId),
    where('status', '==', 'open'),
    limit(1),
  );

  let snap;
  try {
    snap = await getDocs(q);
  } catch (err) {
    if (!isOfflineLikeShiftReadError(err)) {
      return { status: 'unverifiable', reason: 'read_failed' };
    }
    try {
      snap = await getDocsFromCache(q);
    } catch {
      return { status: 'unverifiable', reason: 'cache_unavailable' };
    }
    if (snap.empty) return { status: 'unverifiable', reason: 'cache_empty' };
    const d = snap.docs[0]!;
    return { status: 'found', shift: mapShift(d.id, d.data()), provenance: 'cache' };
  }

  const fromCache = snap.metadata?.fromCache === true;
  if (!snap.empty) {
    const d = snap.docs[0]!;
    return {
      status: 'found',
      shift: mapShift(d.id, d.data()),
      provenance: fromCache ? 'cache' : 'server',
    };
  }
  return fromCache
    ? { status: 'unverifiable', reason: 'cache_empty' }
    : { status: 'absent', provenance: 'server' };
}

// PK-1 — local optimistic offline open. Honest error copy; no claim of server
// acceptance while pending. Remote create payload MUST remain exact W0 rules shape.
const OPEN_SHIFT_STORE_UNAVAILABLE_MESSAGE =
  'บันทึกการเปิดกะแบบออฟไลน์ไม่สำเร็จ (พื้นที่จัดเก็บในเครื่องไม่พร้อมใช้งานหรือเต็ม) กรุณาลองใหม่ หรือเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง';
const OPEN_SHIFT_CONFLICT_MESSAGE =
  'พบข้อมูลเปิดกะอื่นสำหรับเครื่องนี้ที่ยังไม่เคลียร์ กรุณาตรวจสอบก่อนดำเนินการต่อ';
const OPEN_SHIFT_REJECTED_OPEN_MESSAGE =
  'การเปิดกะก่อนหน้านี้ถูกปฏิเสธและต้องตรวจสอบ — ไม่สามารถเปิดกะใหม่ได้จนกว่าจะเคลียร์รายการนี้';
const OPEN_SHIFT_REJECTED_CLOSE_MESSAGE =
  'การปิดกะก่อนหน้านี้ต้องตรวจสอบ — ไม่สามารถเปิดกะใหม่ได้จนกว่าจะเคลียร์รายการนี้';
const OPEN_SHIFT_UNRESOLVED_CLOSE_MESSAGE =
  'มีกะที่ปิดค้างอยู่ในเครื่องนี้และยังยืนยันสถานะไม่ได้ — ไม่สามารถเปิดกะใหม่ได้ในขณะนี้';

let defaultShiftOpenIntentJournal: ShiftOpenIntentJournal | undefined;
function getDefaultShiftOpenIntentJournal(): ShiftOpenIntentJournal {
  if (!defaultShiftOpenIntentJournal) {
    defaultShiftOpenIntentJournal = createShiftOpenIntentJournal();
  }
  return defaultShiftOpenIntentJournal;
}

/** Exact W0 create payload — must stay allowlist-identical to `isW0ShiftOpen`. */
function buildW0ShiftOpenPayload(
  shiftId: string,
  branchId: string,
  staffId: string,
  staffName: string,
  startingCash: number,
): Record<string, unknown> {
  return {
    id: shiftId,
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
  };
}

/**
 * Client-built local open snapshot. `openedAt` carries device time for display only
 * while `openedOffline && syncState === 'pending'` — never proof of server acceptance.
 */
export function buildLocalOpenShiftSnapshot(entry: ShiftOpenIntentEntry): Shift {
  const openedAt = {
    toDate: () => new Date(entry.openedAtLocal),
    toMillis: () => entry.openedAtLocal,
  } as Shift['openedAt'];

  return {
    id: entry.shiftId,
    branchId: entry.branchId,
    staffId: entry.staffId,
    staffName: entry.staffName,
    status: 'open',
    openedAt,
    closedAt: null,
    startingCash: entry.startingCash,
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
    deviceId: entry.deviceId ?? undefined,
    openedOffline: true,
    syncState: entry.status === 'synced' ? 'synced' : 'pending',
    cashEntries: [],
  };
}

/**
 * PK-1 — confirmation-grade shift-doc reader for open reconciliation.
 * Uses `getDocFromServer` (never cache) — same contract as close confirmation.
 */
export const readShiftOpenConfirmation: ShiftOpenConfirmationReader = async (
  shiftId,
): Promise<ShiftOpenConfirmationRead> => {
  if (!isFirebaseConfigured || !db) return { ok: false };
  try {
    const snap = await getDocFromServer(doc(db, collections.shifts, shiftId));
    if (!snap.exists()) return { ok: true, doc: { exists: false } };
    const data = snap.data() as Record<string, unknown>;
    const confirmationDoc: ShiftOpenConfirmationDoc = {
      exists: true,
      status: data.status as string | undefined,
      openedAt: data.openedAt,
      branchId: data.branchId as string | undefined,
      staffId: data.staffId as string | undefined,
      staffName: data.staffName as string | undefined,
      startingCash: data.startingCash as number | undefined,
    };
    return { ok: true, doc: confirmationDoc };
  } catch {
    return { ok: false };
  }
};

export type ShiftOpenConfirmation =
  | { outcome: 'confirmed'; openedAt: Date }
  | { outcome: 'still_pending' }
  | { outcome: 'identity_mismatch' }
  | { outcome: 'unreachable' }
  | { outcome: 'rejected'; message: string };

/** Narrow definitive remote-rejection codes for open W0 writes (M2). */
const DEFINITIVE_SHIFT_OPEN_REMOTE_REJECTION_CODES = new Set([
  'permission-denied',
  'firestore/permission-denied',
]);

function extractFirebaseErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

/**
 * Only proven rules/permission (and similarly definitive) failures may become
 * `rejected_manual_attention`. Ambiguous/unavailable/network errors must remain pending.
 */
export function isDefinitiveShiftOpenRemoteRejection(err: unknown): boolean {
  const code = extractFirebaseErrorCode(err);
  return code != null && DEFINITIVE_SHIFT_OPEN_REMOTE_REJECTION_CODES.has(code);
}

export type OpenShiftResult = Shift & {
  /**
   * Resolves once the SAME-RUNTIME write settles AND (only on ACK) a
   * confirmation-grade server read proves the open — never from the ACK alone.
   */
  whenServerConfirmed: Promise<ShiftOpenConfirmation>;
};

export type OpenShiftDeps = {
  journal?: ShiftOpenIntentJournal;
  /** Close journal — used only for open/close conflict guards. */
  closeJournal?: ShiftCloseIntentJournal;
  readConfirmation?: ShiftOpenConfirmationReader;
  /** When false, skip issuing setDoc (resume path already queued the write). */
  issueRemoteWrite?: boolean;
};

/**
 * Open a shift — PK-1 local optimistic offline open, mirroring closeShift's
 * durable-intent → non-awaited write → immediate snapshot contract.
 *
 * Ordering (load-bearing):
 *  1. Conflict guards (rejected open/close; resume pending open).
 *  2. Persist durable open-intent BEFORE any remote mutation.
 *  3. Queue non-awaited W0 `setDoc` (exact rules allowlist — no offline extras).
 *  4. Return client-built Shift immediately + `whenServerConfirmed`.
 */
export async function openShift(
  branchId: string,
  staffId: string,
  staffName: string,
  startingCash: number,
  deps?: OpenShiftDeps,
): Promise<OpenShiftResult> {
  if (!isFirebaseConfigured || !db) {
    const id = devOpenShift(branchId, staffId, staffName, startingCash);
    const opened = (await getActiveShift(branchId, staffId)) ?? {
      id,
      branchId,
      staffId,
      staffName,
      status: 'open' as const,
      openedAt: { toDate: () => new Date(), toMillis: () => Date.now() } as Shift['openedAt'],
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
      cashEntries: [],
    };
    const openedAtServer =
      opened.openedAt != null && typeof (opened.openedAt as { toDate?: unknown }).toDate === 'function'
        ? (opened.openedAt as { toDate: () => Date }).toDate()
        : new Date();
    return {
      ...opened,
      whenServerConfirmed: Promise.resolve({ outcome: 'confirmed', openedAt: openedAtServer }),
    };
  }

  const deviceId = getDeviceId();
  const journal = deps?.journal ?? getDefaultShiftOpenIntentJournal();
  const closeJournal = deps?.closeJournal ?? getDefaultShiftCloseIntentJournal();
  const readConfirmation = deps?.readConfirmation ?? readShiftOpenConfirmation;

  // Conflict: rejected open for this device blocks a new open.
  const rejectedOpen = await journal.findRejectedOpenForDevice(deviceId);
  if (!rejectedOpen.ok) {
    throw new Error(OPEN_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  }
  if (rejectedOpen.value) {
    throw new Error(OPEN_SHIFT_REJECTED_OPEN_MESSAGE);
  }

  // Conflict: rejected close for this device blocks a new open.
  const closeListed = await closeJournal.listCloseIntents();
  if (!closeListed.ok) {
    throw new Error(OPEN_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  }
  const rejectedClose = closeListed.value.find(
    (e) => e.status === 'rejected_manual_attention' && e.deviceId === deviceId,
  );
  if (rejectedClose) {
    throw new Error(OPEN_SHIFT_REJECTED_CLOSE_MESSAGE);
  }

  // Conflict: pending close whose shift still appears open in local cache —
  // fail closed (would otherwise invite a duplicate open). Pending close for an
  // already-closed shift does NOT block (existing multi-shift contract).
  const pendingCloses = closeListed.value.filter(
    (e) => e.status === 'local_closed_pending' && e.deviceId === deviceId,
  );
  for (const pendingClose of pendingCloses) {
    try {
      const cached = await getDocFromCache(doc(db, collections.shifts, pendingClose.shiftId));
      if (cached.exists() && (cached.data() as { status?: string }).status === 'open') {
        throw new Error(OPEN_SHIFT_UNRESOLVED_CLOSE_MESSAGE);
      }
    } catch (err) {
      if (err instanceof Error && err.message === OPEN_SHIFT_UNRESOLVED_CLOSE_MESSAGE) throw err;
      // Cache miss/unverifiable for a pending close — fail closed rather than open over it.
      throw new Error(OPEN_SHIFT_UNRESOLVED_CLOSE_MESSAGE);
    }
  }

  // Resume existing pending open for this staff+device — never allocate a second id.
  const existingPending = await journal.findPendingOpenForStaff(branchId, staffId, deviceId);
  if (!existingPending.ok) {
    throw new Error(OPEN_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  }

  let pendingEntry: ShiftOpenIntentEntry;
  let issueRemoteWrite = deps?.issueRemoteWrite !== false;

  if (existingPending.value) {
    pendingEntry = existingPending.value;
    // Resume must not re-issue setDoc by default (a second setDoc after create
    // succeeds becomes an update and is denied by W0/W1–W4). Boot/reconnect
    // reissue is owned by the open reconciler when the server doc is absent.
    issueRemoteWrite = deps?.issueRemoteWrite === true;
  } else {
    const ref = doc(collection(db, collections.shifts));
    const businessSnapshot: ShiftOpenIntentBusinessSnapshot = {
      shiftId: ref.id,
      branchId,
      staffId,
      staffName,
      startingCash,
      deviceId,
    };

    const intentResult = await journal.upsertOpenIntent(businessSnapshot);
    if (!intentResult.ok) {
      if (intentResult.code === 'conflict') {
        throw new Error(OPEN_SHIFT_CONFLICT_MESSAGE);
      }
      throw new Error(OPEN_SHIFT_STORE_UNAVAILABLE_MESSAGE);
    }
    pendingEntry = intentResult.value;
  }

  const firestore = db;
  const shiftRef = doc(firestore, collections.shifts, pendingEntry.shiftId);
  const w0Payload = buildW0ShiftOpenPayload(
    pendingEntry.shiftId,
    pendingEntry.branchId,
    pendingEntry.staffId,
    pendingEntry.staffName,
    pendingEntry.startingCash,
  );

  let writeAck: Promise<void> = Promise.resolve();
  if (issueRemoteWrite) {
    const claim = await journal.claimRemoteCreateAttempt(pendingEntry.shiftId);
    if (!claim.ok) {
      throw new Error(OPEN_SHIFT_STORE_UNAVAILABLE_MESSAGE);
    }
    if (claim.value === 'claimed') {
      writeAck = setDoc(shiftRef, w0Payload);
    }
    // already_outstanding → do not enqueue another W0 create
  }

  const whenServerConfirmed: Promise<ShiftOpenConfirmation> = (async (): Promise<ShiftOpenConfirmation> => {
    try {
      await writeAck;
    } catch (err) {
      console.warn('[shiftService] openShift write not yet acked (queued, will retry)', err);
      const message = err instanceof Error ? err.message : String(err);
      if (isDefinitiveShiftOpenRemoteRejection(err)) {
        try {
          const attention = await journal.markRejectedManualAttention(
            pendingEntry.shiftId,
            message,
          );
          // Terminal rejected/manual-attention only after durable journal transition.
          if (!attention.ok) {
            return { outcome: 'still_pending' };
          }
          return { outcome: 'rejected', message };
        } catch {
          // Durable attention persistence unknown — remain honest pending.
          return { outcome: 'still_pending' };
        }
      }
      // Ambiguous/transient — keep intent pending + create claim outstanding.
      return { outcome: 'still_pending' };
    }

    // Resume path with no new write: still run confirmation-grade reconciliation.
    try {
      const result = await reconcileShiftOpenIntent(pendingEntry, {
        journal,
        readConfirmation,
        deviceId,
      });
      if (result.outcome === 'confirmed' && result.openedAtServer) {
        return { outcome: 'confirmed', openedAt: result.openedAtServer };
      }
      if (result.outcome === 'identity_mismatch') return { outcome: 'identity_mismatch' };
      if (result.outcome === 'unreachable') return { outcome: 'unreachable' };
      return { outcome: 'still_pending' };
    } catch {
      return { outcome: 'unreachable' };
    }
  })();

  return {
    ...buildLocalOpenShiftSnapshot(pendingEntry),
    whenServerConfirmed,
  };
}

/**
 * Re-issue W0 create for a pending open whose durable create claim is still `none`
 * and whose server doc is confirmed absent. CAS-claims before setDoc so concurrent
 * sweeps cannot enqueue duplicate creates.
 */
export async function reissueShiftOpenWrite(
  entry: ShiftOpenIntentEntry,
  deps?: { journal?: ShiftOpenIntentJournal },
): Promise<'issued' | 'skipped'> {
  if (!isFirebaseConfigured || !db) return 'skipped';
  const journal = deps?.journal ?? getDefaultShiftOpenIntentJournal();
  const claim = await journal.claimRemoteCreateAttempt(entry.shiftId);
  if (!claim.ok) return 'skipped';
  if (claim.value === 'already_outstanding') return 'skipped';

  const ref = doc(db, collections.shifts, entry.shiftId);
  await setDoc(
    ref,
    buildW0ShiftOpenPayload(
      entry.shiftId,
      entry.branchId,
      entry.staffId,
      entry.staffName,
      entry.startingCash,
    ),
  );
  return 'issued';
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
/**
 * B2.1: this device's close of the shift is (or may be) on the server, but it
 * cannot be confirmed / strictly parsed / reconciled now — no Z is shown; the
 * durable attempt or entry is kept for the sync sweep and investigation.
 */
export const CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE =
  'ยังยืนยันยอดปิดกะนี้กับเซิร์ฟเวอร์ไม่ได้ — ยังไม่แสดงรายงานปิดกะ (Z) กรุณาตรวจสอบสถานะการซิงก์ แล้วลองใหม่อีกครั้ง';
/**
 * Gate B2.1-A: the close transaction COMMITTED on the server, but this device
 * could not strictly confirm it and record it durably — no Z / confirmation is
 * shown; the durable attempt is kept and finalized by a retry or the sync sweep.
 * Never claims the close was undone or that the drawer is still open.
 */
export const CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE =
  'ส่งการปิดกะถึงเซิร์ฟเวอร์แล้ว แต่เครื่องนี้ยังยืนยันยอดและบันทึกผลการปิดกะไม่สำเร็จ — ยังไม่แสดงรายงานปิดกะ (Z) ระบบจะตรวจสอบและบันทึกผลอีกครั้งเมื่อซิงก์ กรุณาตรวจสอบสถานะการซิงก์ แล้วลองใหม่อีกครั้ง';
/** Recovery gate B2: an earlier ONLINE close of this shift has an unknown outcome — no offline close over it. */
export const CLOSE_SHIFT_ONLINE_ATTEMPT_UNRESOLVED_MESSAGE =
  'การปิดกะออนไลน์ครั้งก่อนของกะนี้ยังยืนยันผลกับเซิร์ฟเวอร์ไม่ได้ — ปิดกะแบบออฟไลน์ไม่ได้ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วปิดกะอีกครั้ง';
/** Recovery gate B2: the online close's durable attempt could not be recorded — nothing was sent. */
export const CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE =
  'บันทึกข้อมูลการปิดกะในเครื่องไม่สำเร็จ (พื้นที่จัดเก็บในเครื่องไม่พร้อมใช้งานหรือเต็ม) — ยังไม่ได้ปิดกะ กรุณาลองใหม่อีกครั้ง';
/** D-RET-FIX-8: online close could not read the authoritative shift — nothing was written. */
export const CLOSE_SHIFT_FRESHNESS_MESSAGE =
  'ตรวจสอบยอดเงินสดล่าสุดของกะจากเซิร์ฟเวอร์ไม่สำเร็จ — ยังไม่ได้ปิดกะ กรุณาลองใหม่อีกครั้ง';
/** Final gate §3: this device has a cash Return whose server pay-out it has not confirmed/synced. */
export const CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE =
  'มีรายการคืนเงินสดของกะนี้ที่เครื่องนี้ยังยืนยันผลหรือซิงก์จากเซิร์ฟเวอร์ไม่ได้ — ปิดกะแบบออฟไลน์ไม่ได้ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วปิดกะอีกครั้ง';
/** Recovery gate C1: the cash Return guard store cannot be read, so a pending guard cannot be ruled out. */
export const CLOSE_SHIFT_CASH_GUARD_UNVERIFIABLE_MESSAGE =
  'ตรวจสอบรายการคืนเงินสดที่ค้างในเครื่องนี้ไม่ได้ (พื้นที่จัดเก็บในเบราว์เซอร์ไม่พร้อมใช้งาน) — ปิดกะแบบออฟไลน์ไม่ได้ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วปิดกะอีกครั้ง';
/** Final gate §2: this device's queued sale/cash writes did not reach the server in time — nothing was written. */
export const CLOSE_SHIFT_PENDING_WRITES_MESSAGE =
  'ข้อมูลการขาย/เงินสดของเครื่องนี้ยังส่งขึ้นเซิร์ฟเวอร์ไม่ครบ — ยังไม่ได้ปิดกะ กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
/**
 * Final gate §2 / gate 006-A: the close transaction call was rejected, so its
 * outcome is UNKNOWN (a lost response may follow a commit) — never worded as
 * "failed"; a retry / the sweep re-checks it with the same correlation id.
 */
export const CLOSE_SHIFT_TX_FAILED_MESSAGE =
  'ยังยืนยันผลการปิดกะกับเซิร์ฟเวอร์ไม่ได้ (การเชื่อมต่อหรือการบันทึกขัดข้อง) — หากกะถูกปิดไปแล้ว ระบบจะรู้จำผลเดิมและไม่ปิดกะซ้ำ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง';

/**
 * C1-R1 R1-B: the shift's cash entries carry a duplicate / conflicting / malformed
 * identity (e.g. two `rfd_X` payouts of different amounts), so the drawer cannot
 * be frozen without silently dropping one — nothing was closed or written.
 */
export const CLOSE_SHIFT_CASH_AMBIGUOUS_MESSAGE =
  'ปิดกะไม่ได้: พบรายการเงินสดในลิ้นชักที่รหัสรายการเงินสดซ้ำกัน ขัดแย้งกัน หรือข้อมูลไม่ถูกต้อง — ยังไม่ได้ปิดกะและยังไม่บันทึกยอดใด ๆ กรุณาแจ้งผู้จัดการให้ตรวจสอบกะนี้ก่อน (ห้ามแก้ไขหรือลบรายการเอง)';

/**
 * `true` when the RAW cash sources are ambiguous (see {@link checkCashEntryIntegrity})
 * and the close must be refused. Never dedupes, repairs or rewrites anything.
 */
function cashEntriesAmbiguous(sources: CashEntrySource[], where: string): boolean {
  const verdict = checkCashEntryIntegrity(sources);
  if (verdict.ok) return false;
  console.warn(`[shiftService] close refused: ambiguous cash entries (${where})`, verdict);
  return true;
}

/** Bound on flushing this device's queued writes before the online close transaction. */
export const CLOSE_SHIFT_PENDING_WRITES_TIMEOUT_MS = 5_000;

/** Read/write handle of ONE shift doc inside the close transaction (test seam). */
export type ShiftCloseTx = {
  get: () => Promise<{ exists: boolean; data: Record<string, unknown> | undefined }>;
  update: (payload: Record<string, unknown>) => void;
};

/**
 * Runs `fn` as ONE optimistic Firestore transaction over `shifts/{shiftId}`:
 * the commit fails if the doc changed after `get()` (e.g. a cash Return
 * appended a pay-out) and `fn` is re-run on a fresh read. Production =
 * client `runTransaction`; tests inject a faithful optimistic fake.
 */
export type ShiftCloseTransactionRunner = <T>(shiftId: string, fn: (tx: ShiftCloseTx) => Promise<T>) => Promise<T>;

const firestoreShiftCloseTransaction: ShiftCloseTransactionRunner = (shiftId, fn) => {
  const firestore = db;
  if (!firestore) return Promise.reject(new Error('Firestore unavailable'));
  const ref = doc(firestore, collections.shifts, shiftId);
  return runTransaction(firestore, (tx) =>
    fn({
      get: async () => {
        const snap = await tx.get(ref);
        return { exists: snap.exists(), data: snap.exists() ? (snap.data() as Record<string, unknown>) : undefined };
      },
      update: (payload) => {
        tx.update(ref, payload);
      },
    }),
  );
};

/** `true` once every write queued on this device was acknowledged by the server (bounded). */
async function waitForQueuedWritesFlushed(): Promise<boolean> {
  const firestore = db;
  if (!firestore) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_SHIFT_PENDING_WRITES_TIMEOUT_MS);
    });
    return await Promise.race([waitForPendingWrites(firestore).then(() => true as const), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A definitive in-transaction refusal: the close was NOT written.
 * `uncommittable` = the doc is closed by ANOTHER correlation id, so this
 * attempt can never commit (W3 only closes an open doc).
 */
class ShiftCloseRefusal extends Error {
  readonly uncommittable: boolean;
  constructor(message: string, uncommittable = false) {
    super(message);
    this.uncommittable = uncommittable;
  }
}

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
    return { ok: true, doc: shiftCloseConfirmationDocFromData(snap.data() as Record<string, unknown>) };
  } catch {
    return { ok: false };
  }
};

/**
 * Packet 7C-B2 Variant C — the ONE field this packet ever normalizes on an
 * already-closed doc. The caller (`reconcileShiftCloseIntent` / the retry)
 * first proves the confirmed identity from a server read.
 *
 * Gate 007-C — a CONDITIONAL write: one Firestore transaction reads the doc
 * and writes `syncState: 'synced'` only if that read is the `closed`, `pending`
 * doc of `expected` (correlation id + device); the commit carries that read's
 * version. Of two overlapping workers at most ONE makes the effective
 * transition: one whose read already sees `synced` returns `already_synced`
 * (nothing written); one whose read preceded the other's commit is rejected
 * at its commit (Rules `isW4SyncStateNormalization` evaluate the now-synced
 * doc → permission-denied; proven on the emulator) → throws, i.e. W4 failed,
 * retried later and never reported as success. The W4 payload is the same
 * single field. Unavailable Firestore / offline → throws (never a queued write
 * that could land after another worker's).
 */
export const normalizeShiftCloseSyncState: ShiftCloseNormalizer = async (shiftId, expected) => {
  const firestore = db;
  if (!isFirebaseConfigured || !firestore) throw new Error('Firestore unavailable');
  const ref = doc(firestore, collections.shifts, shiftId);
  return runTransaction(firestore, async (tx): Promise<ShiftCloseNormalizeOutcome> => {
    const snap = await tx.get(ref);
    const decision = shiftCloseNormalizationDecision(snap.exists() ? (snap.data() as Record<string, unknown>) : undefined, expected);
    if (decision !== 'write') return decision;
    tx.update(ref, { syncState: 'synced' });
    return 'written';
  });
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
  /**
   * OBS-B2 Mechanism-B observer — optional per-call pointer-repair diagnostic.
   * Failure is isolated; never alters the close business result.
   */
  observePointerRepair?: PointerRepairObserver;
  /** Injectable for tests; production uses `navigator.onLine`. */
  isOnline?: () => boolean;
  /** Injectable for tests; production uses the per-attempt localStorage guards. */
  serverCashPending?: { has: (shiftId: string) => boolean; clear: (shiftId: string) => void };
  /** Injectable for tests; production = client `runTransaction` on the shift doc. */
  runCloseTransaction?: ShiftCloseTransactionRunner;
  /** Injectable for tests; production = bounded `waitForPendingWrites`. */
  waitForQueuedWrites?: () => Promise<boolean>;
};

function closeBusinessSnapshot(
  shift: Shift,
  actualCashCount: number,
  note: string,
  deviceId: string,
): ShiftCloseIntentBusinessSnapshot {
  const totalExpected = calcShiftDrawerExpected(shift);
  return {
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
    variance: actualCashCount - totalExpected,
    note,
    deviceId,
  };
}

/** The W3 close write (firestore.rules `isW3ShiftClose`) — identical for both paths. */
function closeWritePayload(
  s: ShiftCloseIntentBusinessSnapshot,
  closeCorrelationId: string | null,
): Record<string, unknown> {
  return {
    status: 'closed',
    // Authoritative server close time on the persisted doc. Omitting it would
    // leave a synced closed shift with `closedAt: null` forever; there is no
    // separate `closedAtServer` mirror field to keep in sync, so none is
    // written here (avoids an unread, unresolved, permanently-null field).
    closedAt: serverTimestamp(),
    actualCashCount: s.actualCashCount,
    variance: s.variance,
    note: s.note,
    // Commit the terminal's authoritative sale totals onto the closed doc.
    expectedCash: s.expectedCash,
    expectedQr: s.expectedQr,
    expectedKbank: s.expectedKbank,
    expectedCard: s.expectedCard,
    expectedCredit: s.expectedCredit,
    totalBills: s.totalBills,
    payInTotal: s.payInTotal,
    payOutTotal: s.payOutTotal,
    closedOffline: true,
    syncState: 'pending',
    deviceId: s.deviceId,
    // OBS-B1B / deployed Rules: non-null UUID writes the field; null omits the key.
    ...(closeCorrelationId !== null ? { closeCorrelationId } : {}),
  };
}

/** This device's own-close identity for a shift + correlation id (input of {@link parseCommittedOwnClose}). */
function ownCloseIdentity(shift: Shift, deviceId: string, closeCorrelationId: string): OwnCloseIdentity {
  return {
    shiftId: shift.id,
    branchId: shift.branchId,
    staffId: shift.staffId,
    staffName: shift.staffName,
    deviceId,
    closeCorrelationId,
  };
}

/**
 * Close a shift — Packet 7C-B1 (Option 2) local optimistic offline close,
 * extended by Packet 7C-B2 with same-runtime confirmation reconciliation and
 * (Return/Refund V1 final gate) a transactional ONLINE close.
 * Under the drawer single-writer model the terminal is the sole authority for
 * the shift's sale totals, so the caller passes the shift it has already
 * DERIVED from its local ledger ({@link deriveShiftDrawer}); we never re-read
 * the (now reconciler-untouched) stored `expected*` fields. Cash MOVEMENTS are
 * different: a cash Return appends a server-side pay-out to `cashEntries[]`.
 *
 *  1. Both paths first verify the shift is still open from the LOCAL CACHE
 *     (`getDocFromCache`, which includes this device's own queued writes) — a
 *     cold/stale/unverifiable cache fails fast rather than fabricating a
 *     close, and a close this device already queued shows as closed here.
 *
 *  ONLINE (`navigator.onLine`) — the cash freeze is serialized against any
 *  Return transaction on the SAME shift doc:
 *  2. Waits (bounded) until every write queued on this device was ACKed, so
 *     the transaction cannot overtake this device's own queued sale/cash
 *     writes (the queued `updateDoc` close it replaces preserved that order).
 *     Not flushed in time → fail closed, nothing written.
 *  3. ONE Firestore transaction reads the authoritative shift, verifies
 *     open + branch/staff identity, unions local + cached + authoritative
 *     `cashEntries` by id, folds cash, computes expected cash / variance and
 *     writes the exact W3 close. If a Return commits between that read and the
 *     commit, the commit fails its precondition and the transaction re-runs on
 *     a fresh read — totals are always those of the committed read; if it
 *     cannot commit, nothing is closed (retryable). A doc already closed with
 *     THIS attempt's correlation id is recognised as this device's own commit.
 *     Recovery gate B2: BEFORE the transaction a durable `prepared` attempt
 *     (identity + correlation id only, no totals, no close claim) is written
 *     and verified; a store failure refuses with nothing sent. Retries — also
 *     after a UI timeout or a restart — reuse its correlation id.
 *  4. Only AFTER the commit is the close journaled (`local_closed_pending`, the
 *     committed values and correlation id; the attempt is consumed in the same
 *     store transaction) — no close intent/UI claim exists for a close that
 *     did not commit — then reconciled exactly like the offline path
 *     (confirmation read → `synced` → Variant C normalization). If that
 *     finalize fails, or the process dies first, the prepared attempt survives
 *     and is finalized from the authoritative closed doc (same-runtime, by the
 *     boot/reconnect sweep, or by a retry that finds the shift closed with its
 *     id); the committed close is never reported as failed or undone, and
 *     (gate B2.1-A) no Z is returned until the strict recovery proved AND
 *     durably journaled it — otherwise the call rejects with
 *     {@link CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE}.
 *
 *  OFFLINE — unchanged 7C-B1/7C-B2 behaviour, except that a device with an
 *  unresolved/unsynced cash Return guard for the shift refuses (fail closed):
 *  2'. Persists a durable local close-intent (survives reload) BEFORE the
 *     shift-doc write — a durable-store failure (unavailable/quota) also fails
 *     fast; there is no cache-only fallback.
 *  3'. Queues a non-awaited `updateDoc` on the shift doc, INCLUDING
 *     `closedAt: serverTimestamp()`. Firestore's `persistentLocalCache` applies
 *     this mutation to the local cache instantly and flushes on reconnect.
 *
 *  Both return a client-built FROZEN closed snapshot PLUS `whenServerConfirmed`
 *  (Packet 7C-B2): a confirmation-grade read (never an ACK promise alone)
 *  reconciles the local journal via the SAME {@link reconcileShiftCloseIntent}
 *  the boot/reconnect sweeps use. This fire-and-forget reconciliation always
 *  runs, whether or not any caller awaits `whenServerConfirmed`. The RETURNED
 *  object's `closedAt` is never back-filled with a fake local/device timestamp;
 *  `closedAtLocal` carries the honest device time for display.
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
  const cachedData = cached.data() as { status?: string; cashEntries?: unknown; closeCorrelationId?: unknown };
  const cachedEntries = Array.isArray(cachedData.cashEntries) ? (cachedData.cashEntries as ShiftCashEntry[]) : [];

  const clearPending = deps?.serverCashPending?.clear ?? clearShiftServerCashPending;
  const journal = deps?.journal ?? getDefaultShiftCloseIntentJournal();
  const readConfirmation = deps?.readConfirmation ?? readShiftCloseConfirmation;
  const normalizeSyncState = deps?.normalizeSyncState ?? normalizeShiftCloseSyncState;
  const deviceId = getDeviceId();
  const online = (deps?.isOnline ?? isNavigatorOnline)();
  const ctx = { deps, journal, readConfirmation, normalizeSyncState, deviceId, clearPending };

  if (cachedData.status !== 'open') {
    // Recovery gate B2: a retry after a UI timeout / lost response / restart
    // whose close DID commit is this device's own close — show its Z from the
    // committed values instead of "already closed". Anything else: refused.
    if (online && cachedData.status === 'closed' && typeof cachedData.closeCorrelationId === 'string') {
      const own = await recoverOwnCommittedClose(shift, cachedData.closeCorrelationId, cachedEntries, ctx);
      if (own === 'unverified') throw new Error(CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE);
      if (own !== 'not_own') return own;
    }
    throw new Error(CLOSE_SHIFT_ALREADY_CLOSED_MESSAGE);
  }

  // C1-R1 R1-B — on the RAW local + cache lists, BEFORE the online close
  // prepares an attempt / the offline close persists an intent: both would fold
  // them with the first-wins merge. The online path re-checks every transaction
  // attempt against the fresh server list (closeShiftOnline).
  if (
    cashEntriesAmbiguous(
      [
        { label: 'local', entries: shift.cashEntries },
        { label: 'cache', entries: cachedData.cashEntries },
      ],
      online ? 'online:local+cache' : 'offline:local+cache',
    )
  ) {
    throw new Error(CLOSE_SHIFT_CASH_AMBIGUOUS_MESSAGE);
  }

  if (online) {
    return closeShiftOnline(shift, actualCashCount, note, cachedEntries, ctx);
  }

  // OFFLINE: a cash Return of this shift whose server pay-out this device has
  // not confirmed + synced (sent, unknown, or committed-unsynced) ⇒ the cache
  // cannot be trusted for the drawer; refuse rather than freeze a stale count.
  // Recovery gate C1: a guard store that cannot be read is NOT "no guard".
  const pendingState = deps?.serverCashPending
    ? deps.serverCashPending.has(shift.id)
      ? 'pending'
      : 'none'
    : readShiftServerCashPending(shift.id);
  if (pendingState === 'unverifiable') {
    throw new Error(CLOSE_SHIFT_CASH_GUARD_UNVERIFIABLE_MESSAGE);
  }
  if (pendingState === 'pending') {
    throw new Error(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
  }
  // Recovery gate B2: an ONLINE close of this shift with an unknown outcome
  // (durable prepared attempt) may already be committed with the server's
  // totals — never queue a second, offline close over it. An unreadable
  // attempt list fails closed like any other journal read.
  let attempts: Awaited<ReturnType<ShiftCloseIntentJournal['listOnlineCloseAttempts']>>;
  try {
    attempts = await journal.listOnlineCloseAttempts();
  } catch (err) {
    attempts = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!attempts.ok) throw new Error(CLOSE_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  if (attempts.value.some((a) => a.shiftId === shift.id)) {
    throw new Error(CLOSE_SHIFT_ONLINE_ATTEMPT_UNRESOLVED_MESSAGE);
  }
  shift = withMergedCashEntries(shift, cachedEntries);

  // OBS-B1B: caller passes only the 17-field business snapshot. The journal store
  // owns closedAtLocal + closeCorrelationId generation on initial create.
  const businessSnapshot = closeBusinessSnapshot(shift, actualCashCount, note, deviceId);
  const { variance } = businessSnapshot;

  const intentResult = await journal.upsertCloseIntent(
    businessSnapshot,
    deps?.observePointerRepair,
  );
  if (!intentResult.ok) {
    if (intentResult.code === 'conflict') {
      throw new Error(CLOSE_SHIFT_CONFLICT_MESSAGE);
    }
    throw new Error(CLOSE_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  }

  const pendingEntry = intentResult.value;
  const closedAtLocal = pendingEntry.closedAtLocal;

  const writeAck = updateDoc(ref, closeWritePayload(businessSnapshot, pendingEntry.closeCorrelationId));

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
    return reconcileClosed(pendingEntry, { journal, readConfirmation, normalizeSyncState, deviceId });
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

type CloseReconcileDeps = {
  journal: ShiftCloseIntentJournal;
  readConfirmation: ShiftCloseConfirmationReader;
  normalizeSyncState: ShiftCloseNormalizer;
  deviceId: string;
};

/** Packet 7C-B2 confirmation reconciliation of a written close. Never rejects. */
async function reconcileClosed(
  entry: ShiftCloseIntentEntry,
  deps: CloseReconcileDeps,
): Promise<ShiftCloseConfirmation> {
  try {
    const result = await reconcileShiftCloseIntent(entry, deps);
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
}

async function closeShiftOnline(
  shift: Shift,
  actualCashCount: number,
  note: string,
  cachedEntries: ShiftCashEntry[],
  ctx: CloseReconcileDeps & { deps: CloseShiftDeps | undefined; clearPending: (shiftId: string) => void },
): Promise<CloseShiftResult> {
  const { deps, journal, deviceId } = ctx;

  if (!(await (deps?.waitForQueuedWrites ?? waitForQueuedWritesFlushed)())) {
    throw new Error(CLOSE_SHIFT_PENDING_WRITES_MESSAGE);
  }

  // Recovery gate B2 stage 1 — durable attempt identity BEFORE any server
  // write. Unavailable/unverifiable store ⇒ refuse with nothing sent.
  let prepared: Awaited<ReturnType<ShiftCloseIntentJournal['prepareOnlineCloseAttempt']>>;
  try {
    prepared = await journal.prepareOnlineCloseAttempt({
      shiftId: shift.id,
      branchId: shift.branchId,
      staffId: shift.staffId,
      staffName: shift.staffName,
      deviceId,
    });
  } catch (err) {
    prepared = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!prepared.ok) {
    throw new Error(prepared.code === 'conflict' ? CLOSE_SHIFT_CONFLICT_MESSAGE : CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
  }
  // `journaled`: this device already recorded a close of this shift — never
  // write a second one; only that close's own commit may be recognised.
  const journaled = prepared.value.kind === 'journaled' ? prepared.value.entry : null;
  const attempt = prepared.value.kind === 'prepared' ? prepared.value.attempt : null;
  const correlationId = journaled ? journaled.closeCorrelationId : attempt!.closeCorrelationId;
  if (correlationId === null) throw new Error(CLOSE_SHIFT_CONFLICT_MESSAGE);

  let committed: { snapshot: ShiftCloseIntentBusinessSnapshot; folded: Shift };
  try {
    committed = await (deps?.runCloseTransaction ?? firestoreShiftCloseTransaction)(shift.id, async (tx) => {
      // Pure callback: reads, computes, buffers ONE write. Re-run from scratch
      // on every retry — no state carried over, no durable side effect.
      const fresh = await tx.get();
      if (!fresh.exists || !fresh.data) throw new ShiftCloseRefusal(CLOSE_SHIFT_FRESHNESS_MESSAGE);
      const d = fresh.data;
      if (d.status !== 'open') {
        if (d.status === 'closed' && d.closeCorrelationId === correlationId) {
          // An earlier attempt of THIS close committed (its response was lost).
          // B2.1: its Z / journal come ONLY from the strictly parsed committed
          // doc — a missing / malformed / inconsistent field or a wrong
          // identity refuses (no Z, no journal; the attempt is kept).
          const parsed = parseCommittedOwnClose(
            ownCloseIdentity(shift, deviceId, correlationId),
            shiftCloseConfirmationDocFromData(d),
          );
          if (!parsed.ok) throw new ShiftCloseRefusal(CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE);
          const { snapshot } = parsed;
          const entries = Array.isArray(d.cashEntries) ? (d.cashEntries as ShiftCashEntry[]) : [];
          return {
            snapshot,
            folded: {
              ...withMergedCashEntries(shift, cachedEntries, entries),
              ...pickTotals(snapshot),
              startingCash: snapshot.startingCash,
            },
          };
        }
        // B2.1-B: only a DISTINCT VALID correlation id of the same shift run
        // proves this attempt can never commit (the same classification as the
        // sweep); an empty / malformed / absent id keeps the attempt.
        const other = parseCommittedOwnClose(
          ownCloseIdentity(shift, deviceId, correlationId),
          shiftCloseConfirmationDocFromData(d),
        );
        throw new ShiftCloseRefusal(
          CLOSE_SHIFT_ALREADY_CLOSED_MESSAGE,
          !other.ok && other.reason === 'other_correlation',
        );
      }
      if (journaled) throw new ShiftCloseRefusal(CLOSE_SHIFT_CONFLICT_MESSAGE);
      if (d.branchId !== shift.branchId || d.staffId !== shift.staffId) {
        throw new ShiftCloseRefusal(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
      }
      // C1-R1 R1-B — on EVERY attempt, against THIS read, and on the raw lists
      // (before the merge below could erase a collision): a duplicate /
      // conflicting / malformed cash id refuses with nothing written. Pure, so
      // it is safe to repeat on each retry.
      if (
        cashEntriesAmbiguous(
          [
            { label: 'local', entries: shift.cashEntries },
            { label: 'cache', entries: cachedEntries },
            { label: 'server', entries: d.cashEntries },
          ],
          'online:transaction',
        )
      ) {
        throw new ShiftCloseRefusal(CLOSE_SHIFT_CASH_AMBIGUOUS_MESSAGE);
      }
      const serverEntries = Array.isArray(d.cashEntries) ? (d.cashEntries as ShiftCashEntry[]) : [];
      const folded = withMergedCashEntries(shift, cachedEntries, serverEntries);
      const snapshot = closeBusinessSnapshot(folded, actualCashCount, note, deviceId);
      tx.update(closeWritePayload(snapshot, correlationId));
      return { snapshot, folded };
    });
  } catch (err) {
    if (err instanceof ShiftCloseRefusal) {
      // Definitive: the transaction refused before writing anything. Only a
      // doc closed by ANOTHER id proves this attempt can never commit; any
      // other refusal keeps the attempt (the sweep resolves it later).
      // Gate 006-B: never deleted — a retained tombstone, which the store
      // refuses (re-reading the durable attempt) if its commit was observed.
      if (err.uncommittable && attempt) {
        await journal.supersedeOnlineCloseAttempt(shift.id, correlationId).catch(() => undefined);
      }
      throw new Error(err.message, { cause: err });
    }
    // runTransaction rejected (conflict retries exhausted, offline, rules,
    // network): NOT closed as far as this call can prove. The durable attempt
    // keeps the correlation id so a retry/sweep recognises a commit that landed.
    console.warn('[shiftService] online close transaction failed', err);
    throw new Error(CLOSE_SHIFT_TX_FAILED_MESSAGE, { cause: err });
  }
  // The committed read folded every committed cash Return of this shift, and a
  // later Return cannot commit onto a closed shift: its guards are obsolete.
  ctx.clearPending(shift.id);

  const { snapshot, folded } = committed;
  const result = (closedAtLocal: number, whenServerConfirmed: Promise<ShiftCloseConfirmation>): CloseShiftResult => ({
    ...folded,
    status: 'closed',
    actualCashCount: snapshot.actualCashCount,
    variance: snapshot.variance,
    note: snapshot.note,
    closedOffline: true,
    syncState: 'pending',
    deviceId,
    closedAtLocal,
    whenServerConfirmed,
  });

  // Gate 006-A — a resolved transaction proves the W3 commit, NOT the Z. Every
  // Z needs BOTH (1) an authoritative server read of the committed doc that
  // the shared strict parser accepts AND equals what this transaction wrote,
  // and (2) a durable journal entry built from those proven values. Only then
  // is a Z returned; its `whenServerConfirmed` reuses that same proven read
  // (no second, unverified source). Anything less → no Z, no confirmation, no
  // second W3: the prepared attempt is kept (marked commit-observed, checked)
  // for a retry / the boot-reconnect sweep. The message says the close was
  // sent — never that it was rolled back.
  const proof = await proveCommittedOwnClose(shift, deviceId, correlationId, snapshot, ctx.readConfirmation);
  if (journaled) {
    // This device already journaled this close; the Z needs the proof to equal it.
    if (!proof.ok || !snapshotsEqual(proof.snapshot, journaled) || journaled.closeCorrelationId !== correlationId) {
      throw new Error(CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE);
    }
    return result(journaled.closedAtLocal, reconcileClosed(journaled, withProvenRead(ctx, shift.id, proof.read)));
  }
  if (proof.ok) {
    // B2 stage 3 — journal only from the PROVEN committed values; the prepared
    // attempt is consumed in the same store transaction. One local retry.
    for (let i = 0; i < 2; i += 1) {
      let finalized: Awaited<ReturnType<ShiftCloseIntentJournal['finalizeOnlineClose']>>;
      try {
        finalized = await journal.finalizeOnlineClose(proof.snapshot, correlationId, deps?.observePointerRepair);
      } catch (err) {
        finalized = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
      }
      if (finalized.ok) {
        const entry = finalized.value;
        return result(entry.closedAtLocal, reconcileClosed(entry, withProvenRead(ctx, shift.id, proof.read)));
      }
      if (finalized.code === 'conflict') {
        // Gate 007-B: the store refused (a different local close record, or no
        // attempt of exactly this identity to consume): never a Z over that.
        // The known commit is recorded on THIS correlation's attempt, if any.
        console.warn('[shiftService] committed online close conflicts with the local journal', finalized);
        const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
        throw new Error(CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE, {
          cause: { finalizeRefusal: finalized.reason, commitObservation },
        });
      }
      console.warn('[shiftService] committed online close could not be journaled', finalized);
    }
  } else {
    console.warn('[shiftService] committed online close could not be proven from the server', proof.reason);
  }
  const custody = await recordCommitObservation(journal, shift.id, correlationId);
  throw new Error(CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE, { cause: { commitObservation: custody } });
}

type CommittedCloseProof =
  | { ok: true; snapshot: ShiftCloseIntentBusinessSnapshot; read: ShiftCloseConfirmationRead }
  | { ok: false; reason: string };

/**
 * Gate 006-A — the ONE post-commit proof: an authoritative (server, never
 * cache) read of the shift, accepted by {@link parseCommittedOwnClose} for
 * this device's correlation id, AND equal (every business field) to the
 * snapshot this transaction committed. A failed / unreachable read, a
 * malformed / foreign / stale doc, or any difference is NOT proof. Never throws.
 */
async function proveCommittedOwnClose(
  shift: Shift,
  deviceId: string,
  correlationId: string,
  committedSnapshot: ShiftCloseIntentBusinessSnapshot,
  readConfirmation: ShiftCloseConfirmationReader,
): Promise<CommittedCloseProof> {
  let read: ShiftCloseConfirmationRead;
  try {
    read = await readConfirmation(shift.id);
  } catch {
    read = { ok: false };
  }
  if (!read.ok) return { ok: false, reason: 'unreachable' };
  const parsed = parseCommittedOwnClose(ownCloseIdentity(shift, deviceId, correlationId), read.doc);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!snapshotsEqual(parsed.snapshot, committedSnapshot)) return { ok: false, reason: 'differs_from_commit' };
  return { ok: true, snapshot: parsed.snapshot, read };
}

/**
 * The reconcile that backs `whenServerConfirmed` consumes the read that already
 * proved the Z (one authoritative read per close, never a weaker second source);
 * any later read (sweep) goes to the real reader.
 */
function withProvenRead<T extends CloseReconcileDeps>(ctx: T, shiftId: string, read: ShiftCloseConfirmationRead): T {
  let used = false;
  return {
    ...ctx,
    readConfirmation: (id: string) => {
      if (!used && id === shiftId) {
        used = true;
        return Promise.resolve(read);
      }
      return ctx.readConfirmation(id);
    },
  };
}

/**
 * Gate 006-B — durably record that THIS runtime saw its W3 commit, and VERIFY
 * it by reading the attempt back. `durable` only when both the structured
 * write result and the read-back confirm it; otherwise `unverified` (never
 * treated as success). Either way the attempt is retained: no deletion path
 * exists for an attempt (supersession is a retained tombstone the store
 * refuses for a commit-observed attempt). Never throws.
 */
async function recordCommitObservation(
  journal: ShiftCloseIntentJournal,
  shiftId: string,
  correlationId: string,
): Promise<'durable' | 'unverified'> {
  try {
    const marked = await journal.markOnlineCloseAttemptCommitObserved(shiftId, correlationId);
    if (!marked.ok || marked.value !== true) return 'unverified';
    const listed = await journal.listOnlineCloseAttempts();
    if (!listed.ok) return 'unverified';
    const own = listed.value.find((a) => a.shiftId === shiftId && a.closeCorrelationId === correlationId);
    return own && isCommitObservedAttempt(own) ? 'durable' : 'unverified';
  } catch {
    return 'unverified';
  }
}

/**
 * Recovery gate B2 — the cached shift is closed with `closeCorrelationId`. If
 * that is THIS device's journaled close, or its prepared attempt, the close
 * is confirmed by a confirmation-grade read parsed with
 * {@link parseCommittedOwnClose} (B2.1: the journaled entry must ALSO equal
 * the parsed committed values) and its Z is returned from those values.
 *   `not_own`     not provably this device's close (caller: "already closed")
 *   `unverified`  this device's close, but it cannot be confirmed / parsed /
 *                 reconciled now — no Z; the attempt / entry are kept
 */
async function recoverOwnCommittedClose(
  shift: Shift,
  closeCorrelationId: string,
  cachedEntries: ShiftCashEntry[],
  ctx: CloseReconcileDeps,
): Promise<CloseShiftResult | 'not_own' | 'unverified'> {
  const { journal, deviceId } = ctx;
  let entry: ShiftCloseIntentEntry | null = null;
  let reconcileCtx: CloseReconcileDeps = ctx;
  try {
    const got = await journal.getCloseIntent(shift.id);
    if (got.ok && got.value && got.value.deviceId === deviceId && got.value.closeCorrelationId === closeCorrelationId) {
      const read = await ctx.readConfirmation(shift.id);
      if (!read.ok) return 'unverified';
      const parsed = parseCommittedOwnClose(ownCloseIdentity(shift, deviceId, closeCorrelationId), read.doc);
      if (!parsed.ok) return parsed.reason === 'other_correlation' ? 'not_own' : 'unverified';
      if (!snapshotsEqual(parsed.snapshot, got.value)) return 'unverified';
      entry = got.value;
      reconcileCtx = withProvenRead(ctx, shift.id, read);
    }
    if (!entry) {
      const listed = await journal.listOnlineCloseAttempts();
      const own = listed.ok
        ? listed.value.find((a) => a.shiftId === shift.id && a.closeCorrelationId === closeCorrelationId)
        : undefined;
      if (!own) return 'not_own';
      const r = await recoverOnlineCloseAttempt(own, ctx);
      if (r.outcome === 'superseded') return 'not_own';
      if (r.outcome !== 'recovered' || !r.entry) return 'unverified';
      entry = r.entry;
    }
  } catch {
    return 'unverified';
  }
  return {
    ...withMergedCashEntries(shift, cachedEntries),
    ...pickTotals(entry),
    startingCash: entry.startingCash,
    status: 'closed',
    actualCashCount: entry.actualCashCount,
    variance: entry.variance,
    note: entry.note,
    closedOffline: true,
    syncState: 'pending',
    deviceId,
    closedAtLocal: entry.closedAtLocal,
    whenServerConfirmed: reconcileClosed(entry, reconcileCtx),
  };
}

function pickTotals(s: ShiftCloseIntentBusinessSnapshot) {
  return {
    expectedCash: s.expectedCash,
    expectedQr: s.expectedQr,
    expectedKbank: s.expectedKbank,
    expectedCard: s.expectedCard,
    expectedCredit: s.expectedCredit,
    payInTotal: s.payInTotal,
    payOutTotal: s.payOutTotal,
    totalBills: s.totalBills,
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
