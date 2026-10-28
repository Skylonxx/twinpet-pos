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
  isAuthoritativeAttempt,
  isCommitObservedAttempt,
  isSupersededAttempt,
  snapshotsEqual,
  type ShiftCloseIntentJournal,
} from './offline/shiftCloseIntentStore';
import {
  DEFERRED_AUTHORITATIVE_CLOSE_PROTOCOL,
  deferredLocalCloseShiftIds,
  isDeferredAuthoritativeEntry,
  type AuthoritativeCloseRequestBody,
  type OnlineCloseAttemptRecord,
  type PointerRepairObserver,
  type ShiftCloseIntentBusinessSnapshot,
  type ShiftCloseIntentEntry,
} from './offline/shiftCloseIntentTypes';
import type { LocalSale } from './localLedger';
import {
  CLOSE_SHIFT_AUTHORITATIVE_COUNT_INVALID_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_DEVICE_INVALID_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_DRAWER_CHANGED_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_DRAWER_INCONSISTENT_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_LEDGER_INVALID_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_LOCAL_CASH_NOT_ON_SERVER_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_LOCAL_CLOSE_PENDING_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_NOTE_TOO_LONG_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_DISPLAY_CHANGED_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_LEGACY_ENTRY_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_REQUEST_CHANGED_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_RESULT_MISMATCH_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_SALES_UNAVAILABLE_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_SERVER_CASH_INVALID_MESSAGE,
  CLOSE_SHIFT_AUTHORITATIVE_UNAVAILABLE_MESSAGE,
  CLOSE_SHIFT_DEFERRED_LOCAL_CASH_INVALID_MESSAGE,
  SERVER_AUTHORITATIVE_CLOSE_ENABLED,
  authoritativeCloseRequest,
  authoritativeRefusalMessage,
  authoritativeRequestFromSnapshot,
  authoritativeServerProof,
  buildAuthoritativeCloseRequestBody,
  buildAuthoritativeExpectation,
  checkReviewedDrawerWitness,
  getDefaultCloseShiftAuthoritativeCallable,
  invokeCloseShiftAuthoritative,
  proveServerAuthoredClose,
  sameAuthoritativeRequestBody,
  type AuthoritativeCloseOutcome,
  type AuthoritativeRequestFailure,
  type CloseShiftAuthoritativeCallable,
  type ReviewedDrawerWitness,
} from './shiftCloseAuthoritativeClient';
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

/** Packet 023 — cashier copy of {@link ActiveShiftUnavailableError}; never claims the server closed / confirmed anything. */
export const ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE = 'ตรวจสอบสถานะกะในเครื่องไม่ได้ กรุณาลองอีกครั้ง';

/**
 * Packet 023 — gate ON, the device's close journal could not be read, so which
 * open shift is this device's working shift cannot be told (a shift closed
 * locally by a deferred close still reads `open`). NOT "no active shift": the
 * caller must not attach — nor proceed without — a shift for cash / refund /
 * payment work until the journal reads.
 */
export class ActiveShiftUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, options);
    this.name = 'ActiveShiftUnavailableError';
  }
}

/**
 * @throws {ActiveShiftUnavailableError} gate ON and the close journal is
 * unreadable (`{ok:false}` or a thrown read) — never resolves a shift then.
 */
export async function getActiveShift(
  branchId: string,
  staffId: string,
  deps?: { closeJournal?: ShiftCloseIntentJournal; authoritativeCloseGate?: boolean },
): Promise<Shift | null> {
  if (!isFirebaseConfigured || !db) {
    return devGetActiveShift(branchId, staffId);
  }

  // Packet 023: a shift this device closed locally (deferred) can still read
  // `open` — a cash movement / refund must never be attached to it.
  const locallyClosed = await readDeferredLocalCloseShiftIds(
    deps?.closeJournal,
    deps?.authoritativeCloseGate ?? SERVER_AUTHORITATIVE_CLOSE_ENABLED,
  );
  const snap = await getDocs(
    query(
      collection(db, collections.shifts),
      where('branchId', '==', branchId),
      where('staffId', '==', staffId),
      where('status', '==', 'open'),
      limit(1 + locallyClosed.size),
    ),
  );

  const docSnap = snap.docs.find((d) => !locallyClosed.has(d.id));
  return docSnap ? mapShift(docSnap.id, docSnap.data()) : null;
}

/**
 * Packet 023 — this device's deferred-closed shift ids (see
 * `deferredLocalCloseShiftIds`). An unreadable journal is not an empty one:
 * gate ON it throws {@link ActiveShiftUnavailableError}; gate OFF (no deferred
 * close is ever recorded) it yields none — the legacy read, unchanged.
 */
async function readDeferredLocalCloseShiftIds(
  journal: ShiftCloseIntentJournal | undefined,
  failClosed: boolean,
): Promise<Set<string>> {
  let failure: unknown;
  try {
    const listed = await (journal ?? getDefaultShiftCloseIntentJournal()).listCloseIntents();
    if (listed.ok) return deferredLocalCloseShiftIds(listed.value, getDeviceId());
    failure = listed;
  } catch (err) {
    failure = err;
  }
  if (failClosed) throw new ActiveShiftUnavailableError({ cause: failure });
  return new Set();
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
  /**
   * Packet 023 — `local_close_record`: the read returned open shift(s), but
   * every one of them is a shift THIS device durably closed locally (deferred
   * server-authoritative close). The cache is not cold for this staff/branch
   * (it answered with the shift), and that shift is closed on this device —
   * so there is no open shift to restore. Never produced for an empty cache.
   */
  | { status: 'absent'; provenance: 'server' | 'local_dev' | 'local_close_record' }
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
  /** Packet 023 — shifts this device closed locally (deferred); never restored. Empty = unchanged legacy read. */
  locallyClosedShiftIds: ReadonlySet<string> = new Set(),
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
    limit(1 + locallyClosedShiftIds.size),
  );
  const firstOpen = (docs: Array<{ id: string; data: () => unknown }>) => docs.find((d) => !locallyClosedShiftIds.has(d.id));

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
    const d = firstOpen(snap.docs);
    if (!d) return { status: 'absent', provenance: 'local_close_record' };
    return { status: 'found', shift: mapShift(d.id, d.data() as Record<string, unknown>), provenance: 'cache' };
  }

  const fromCache = snap.metadata?.fromCache === true;
  if (!snap.empty) {
    const d = firstOpen(snap.docs);
    if (!d) return { status: 'absent', provenance: fromCache ? 'local_close_record' : 'server' };
    return {
      status: 'found',
      shift: mapShift(d.id, d.data() as Record<string, unknown>),
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
  // Packet 023: a DEFERRED server-authoritative close is a record of its own
  // shift only — its shift was never closed (nor left half-written) on the
  // server by this device, so it neither blocks nor is replaced by a DIFFERENT
  // shift: rejected → manual attention on that shift (sweep attention), pending
  // → owner-only replay. Legacy closes keep their existing guards below.
  const closeListed = await closeJournal.listCloseIntents();
  if (!closeListed.ok) {
    throw new Error(OPEN_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  }
  const locallyClosed = deferredLocalCloseShiftIds(closeListed.value, deviceId);
  const rejectedClose = closeListed.value.find(
    (e) => e.status === 'rejected_manual_attention' && e.deviceId === deviceId && !isDeferredAuthoritativeEntry(e),
  );
  if (rejectedClose) {
    throw new Error(OPEN_SHIFT_REJECTED_CLOSE_MESSAGE);
  }

  // Conflict: pending close whose shift still appears open in local cache —
  // fail closed (would otherwise invite a duplicate open). Pending close for an
  // already-closed shift does NOT block (existing multi-shift contract).
  // Packet 023: a deferred close's shift reads `open` BY DESIGN (no client W3)
  // and its journal entry is the close record — never a duplicate-open risk.
  const pendingCloses = closeListed.value.filter(
    (e) => e.status === 'local_closed_pending' && e.deviceId === deviceId && !isDeferredAuthoritativeEntry(e),
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
  // Packet 023: never "resume" a shift this device already closed locally.
  const existingPending = await journal.findPendingOpenForStaff(branchId, staffId, deviceId, locallyClosed);
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
 * Packet 016: the server-authoritative close is ON but this build has no
 * configured Firebase / Firestore — a definite refusal before anything happened
 * (not an unknown outcome): no dev-mock close, no Z, nothing sent or written.
 */
export const CLOSE_SHIFT_AUTHORITATIVE_FIREBASE_UNCONFIGURED_MESSAGE =
  'ปิดกะแบบยืนยันโดยเซิร์ฟเวอร์ไม่ได้ เพราะเครื่องนี้ยังไม่ได้ตั้งค่าการเชื่อมต่อเซิร์ฟเวอร์ (Firebase) — ยังไม่ได้ปิดกะ ไม่มีการส่งหรือบันทึกการปิดกะใด ๆ และไม่มีรายงานปิดกะ (Z) กรุณาแจ้งผู้ดูแลระบบ';

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

/** `true` once every write queued on this device was acknowledged by the server (bounded). Packet 023: also the deferred replay's flush. */
export async function waitForQueuedWritesFlushed(): Promise<boolean> {
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
  /**
   * Packet 023 — `true` ONLY for a server-authoritative close RECORDED LOCALLY
   * because the server could not be reached (deferred). Nothing was sent: the
   * shift is still open on the server until the reconciliation sweep replays
   * the close under the owner's session. This is a local close record pending
   * server reconciliation — never a server-confirmed Z.
   */
  authoritativeDeferred?: true;
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
  /**
   * Packet 014 — TEST-ONLY override of the hardcoded
   * {@link SERVER_AUTHORITATIVE_CLOSE_ENABLED} gate (`false`). No production
   * caller passes it, so every production close is the legacy close.
   */
  authoritativeCloseGate?: boolean;
  /** Packet 014 — inputs of the server-authoritative close; ignored while the gate is OFF. */
  authoritativeClose?: AuthoritativeCloseDeps;
};

/** Packet 014 — authoritative (server, never cache) read of the whole shift doc. Never throws. */
export type AuthoritativeShiftRead =
  | { ok: true; exists: false }
  | { ok: true; exists: true; data: Record<string, unknown> }
  | { ok: false };

export type AuthoritativeShiftReader = (shiftId: string) => Promise<AuthoritativeShiftRead>;

export type AuthoritativeCloseDeps = {
  /**
   * The ledger sales the closing drawer was derived from (`LocalSale[]` of the
   * shift — the same list `deriveShiftDrawer` folded). Required: without it no
   * canonical attested totals exist and the close fails closed.
   */
  sales?: readonly LocalSale[];
  /** Injectable for tests; production = `httpsCallable('closeShiftAuthoritative')`. */
  callable?: CloseShiftAuthoritativeCallable;
  /** Injectable for tests; production = `getDocFromServer` of the shift. */
  readServerShift?: AuthoritativeShiftReader;
  /**
   * Packet 015 (F2) - the witness of the drawer the cashier was shown when they
   * pressed Confirm (`buildReviewedDrawerWitness(displayShift, refresh)` of the
   * close modal). REQUIRED on the ON path: absent, not refreshed from the
   * server, or different from the authoritative cash data the close would use
   * => refused before any attempt / call (`cause.reviewRequired`).
   */
  reviewedDrawer?: ReviewedDrawerWitness;
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
  // Packet 014 — staged server-authoritative close. OFF (hardcoded) in every
  // production build: nothing below this line changes while it is OFF.
  const authoritative = deps?.authoritativeCloseGate ?? SERVER_AUTHORITATIVE_CLOSE_ENABLED;
  if (!isFirebaseConfigured || !db) {
    // Packet 016 — the dev mock is never a server-authoritative close: refused
    // before anything is closed, sent or written (no Z, nothing committed).
    if (authoritative) {
      throw new Error(CLOSE_SHIFT_AUTHORITATIVE_FIREBASE_UNCONFIGURED_MESSAGE, { cause: { reason: 'firebase_unconfigured' } });
    }
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

  if (authoritative) {
    return closeShiftServerAuthoritative(shift, actualCashCount, note, deps);
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
    // Packet 023: a deferred server-authoritative close is proven only by the callable (the sweep), never here.
    if (got.ok && got.value && isDeferredAuthoritativeEntry(got.value)) return 'unverified';
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

// ── Packet 014: server-authoritative close (staged, OFF by default) ───────

/** Packet 014 — server-only read of the whole shift doc. Packet 023: also the deferred replay's pre-call read. */
export const readAuthoritativeShift: AuthoritativeShiftReader = async (shiftId) => {
  if (!isFirebaseConfigured || !db) return { ok: false };
  try {
    const snap = await getDocFromServer(doc(db, collections.shifts, shiftId));
    return snap.exists() ? { ok: true, exists: true, data: snap.data() as Record<string, unknown> } : { ok: true, exists: false };
  } catch {
    return { ok: false };
  }
};

async function safeRead(reader: AuthoritativeShiftReader, shiftId: string): Promise<AuthoritativeShiftRead> {
  try {
    return await reader(shiftId);
  } catch {
    return { ok: false };
  }
}

function requestFailureMessage(f: AuthoritativeRequestFailure): string {
  switch (f.reason) {
    case 'shift_id_invalid':
    case 'device_id_invalid':
      return CLOSE_SHIFT_AUTHORITATIVE_DEVICE_INVALID_MESSAGE;
    case 'note_too_long':
      return CLOSE_SHIFT_AUTHORITATIVE_NOTE_TOO_LONG_MESSAGE;
    case 'count_not_canonical':
      return CLOSE_SHIFT_AUTHORITATIVE_COUNT_INVALID_MESSAGE;
    case 'attested_differs_from_drawer':
      return CLOSE_SHIFT_AUTHORITATIVE_DRAWER_INCONSISTENT_MESSAGE;
    default:
      return CLOSE_SHIFT_AUTHORITATIVE_LEDGER_INVALID_MESSAGE;
  }
}

/** Entry ids of the local + cached lists that the authoritative server list lacks. */
function entriesMissingOnServer(serverEntries: unknown, ...lists: unknown[]): string[] {
  const onServer = new Set(
    (Array.isArray(serverEntries) ? serverEntries : []).map((e) => (e as { id?: unknown } | null)?.id),
  );
  const missing = new Set<string>();
  for (const list of lists) {
    for (const e of Array.isArray(list) ? list : []) {
      const id = (e as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && !onServer.has(id)) missing.add(id);
    }
  }
  return [...missing];
}

/**
 * Packet 014 — THE server-authoritative close (only when the gate is ON).
 * The W3 is written ONLY by `closeShiftAuthoritative` — this function never
 * calls `updateDoc` / `runTransaction` on the shift, on any outcome. Ordering
 * (each step fails closed with nothing durable or remote changed before the
 * attempt exists):
 *  1. (packet 023 supersedes "offline ⇒ refuse") the device's connectivity is
 *     noted; the request is built and checked the same way either way;
 *  2. the frozen v1 request body from the cashier input + the ledger sales in
 *     integer satang (`buildAuthoritativeCloseRequestBody`);
 *  3. cache existence + C1-R1 raw cash ambiguity (as the legacy close);
 *     OFFLINE ⇒ {@link closeShiftDeferredLocally}: the close is RECORDED in the
 *     existing 7C-B1 journal (offline-first) and nothing is sent or queued;
 *  4. a close record of this shift already in the journal ⇒ only its own
 *     server-proven Z, else refuse (an offline-queued / unresolved close is
 *     never flushed, reinterpreted or closed over);
 *  5. this device's queued writes flushed (the server folds only what it has);
 *     not flushed in time (connection failing) ⇒ deferred local close (023);
 *  6. an authoritative pre-call read of the shift; unreadable ⇒ deferred
 *     local close (023) — in both cases no attempt exists and nothing was sent;
 *  7. the durable attempt (B2): a NEW attempt is bound to the request and to
 *     the close expected from that read; an EXISTING one must be this
 *     protocol's, this request's, and (shift still open) this expectation's —
 *     a legacy / tombstoned / changed one refuses; nothing is ever rewritten;
 *  8. ONE call with the attempt's correlation id; an unknown outcome is
 *     probed and replayed at most once with the SAME id and body;
 *  9. 006-A proof: `ok: true` is not a Z — the server doc read
 *     (`getDocFromServer`) must pass `parseCommittedOwnClose` and equal BOTH
 *     the server's canonical snapshot and the attempt's expected close; then
 *     007-B `finalizeOnlineClose` (which re-checks the expectation) and only
 *     then the Z. Any gap ⇒ no Z, attempt kept (commit-observed when a commit
 *     is known), retried by a later close or the sweep.
 */
async function closeShiftServerAuthoritative(
  shift: Shift,
  actualCashCount: number,
  note: string,
  deps: CloseShiftDeps | undefined,
): Promise<CloseShiftResult> {
  // 1. Packet 023: offline-first — an offline close is recorded locally (step 3), never refused for being offline.
  const online = (deps?.isOnline ?? isNavigatorOnline)();

  const firestore = db;
  if (!firestore) throw new Error(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
  const journal = deps?.journal ?? getDefaultShiftCloseIntentJournal();
  const readConfirmation = deps?.readConfirmation ?? readShiftCloseConfirmation;
  const normalizeSyncState = deps?.normalizeSyncState ?? normalizeShiftCloseSyncState;
  const clearPending = deps?.serverCashPending?.clear ?? clearShiftServerCashPending;
  const readServer = deps?.authoritativeClose?.readServerShift ?? readAuthoritativeShift;
  const deviceId = getDeviceId();
  const ctx: CloseReconcileDeps = { journal, readConfirmation, normalizeSyncState, deviceId };

  // 2. Request body (pure).
  const sales = deps?.authoritativeClose?.sales;
  if (!sales) throw new Error(CLOSE_SHIFT_AUTHORITATIVE_SALES_UNAVAILABLE_MESSAGE);
  const built = buildAuthoritativeCloseRequestBody({ shift, sales, actualCashCount, note, deviceId });
  if (!built.ok) throw new Error(requestFailureMessage(built), { cause: built });
  const body = built.body;

  // 3. Cache existence + raw cash ambiguity.
  let cached;
  try {
    cached = await getDocFromCache(doc(firestore, collections.shifts, shift.id));
  } catch {
    throw new Error(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
  }
  if (!cached.exists()) throw new Error(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
  const cachedData = cached.data() as { status?: unknown; startingCash?: unknown; cashEntries?: unknown };
  const cachedRaw = cachedData.cashEntries;
  const cachedEntries = Array.isArray(cachedRaw) ? (cachedRaw as ShiftCashEntry[]) : [];
  if (
    cashEntriesAmbiguous(
      [
        { label: 'local', entries: shift.cashEntries },
        { label: 'cache', entries: cachedRaw },
      ],
      'authoritative:local+cache',
    )
  ) {
    throw new Error(CLOSE_SHIFT_CASH_AMBIGUOUS_MESSAGE);
  }
  // Packet 023 — the server cannot be reached: record the close locally.
  const deferLocally = () => closeShiftDeferredLocally(shift, body, cachedData, cachedEntries, ctx, deps);
  if (!online) return deferLocally();

  // 4. An existing close record of this shift on this device.
  let existingEntry: Awaited<ReturnType<ShiftCloseIntentJournal['getCloseIntent']>>;
  try {
    existingEntry = await journal.getCloseIntent(shift.id);
  } catch (err) {
    existingEntry = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!existingEntry.ok) throw new Error(CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
  // The transport is resolved once and lazily (only a proof / call needs it).
  let callablePromise: Promise<CloseShiftAuthoritativeCallable> | undefined;
  const getCallable = (): Promise<CloseShiftAuthoritativeCallable> => {
    callablePromise ??= deps?.authoritativeClose?.callable
      ? Promise.resolve(deps.authoritativeClose.callable)
      : getDefaultCloseShiftAuthoritativeCallable();
    return callablePromise;
  };
  if (existingEntry.value) return provenJournaledAuthoritativeClose(shift, existingEntry.value, cachedEntries, ctx, getCallable);

  // 5. Queued sale / cash writes of this device first. Not flushed in time =
  // the connection is failing: nothing was sent, so the close is recorded
  // locally (023) instead of refused.
  if (!(await (deps?.waitForQueuedWrites ?? waitForQueuedWritesFlushed)())) {
    return deferLocally();
  }

  // 6. Authoritative pre-call read (unreachable ⇒ recorded locally, 023).
  const fresh = await safeRead(readServer, shift.id);
  if (!fresh.ok) return deferLocally();
  if (!fresh.exists) throw new Error(CLOSE_SHIFT_FRESHNESS_MESSAGE);
  const d = fresh.data;
  if (d.branchId !== shift.branchId || d.staffId !== shift.staffId) throw new Error(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
  if (
    cashEntriesAmbiguous(
      [
        { label: 'local', entries: shift.cashEntries },
        { label: 'cache', entries: cachedRaw },
        { label: 'server', entries: d.cashEntries },
      ],
      'authoritative:pre-call',
    )
  ) {
    throw new Error(CLOSE_SHIFT_CASH_AMBIGUOUS_MESSAGE);
  }
  const serverEntries = Array.isArray(d.cashEntries) ? (d.cashEntries as ShiftCashEntry[]) : [];

  // 7. The durable attempt.
  const identity = {
    shiftId: shift.id,
    branchId: shift.branchId,
    staffId: shift.staffId,
    staffName: shift.staffName,
    deviceId,
  };
  let listed: Awaited<ReturnType<ShiftCloseIntentJournal['listOnlineCloseAttempts']>>;
  try {
    listed = await journal.listOnlineCloseAttempts();
  } catch (err) {
    listed = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!listed.ok) throw new Error(CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
  const prior = listed.value.find((a) => a.shiftId === shift.id);

  let attempt: OnlineCloseAttemptRecord & { authoritative: NonNullable<OnlineCloseAttemptRecord['authoritative']> };
  if (prior) {
    attempt = ownAuthoritativeAttempt(prior, identity, body);
    if (d.status === 'open') {
      // Never rewrite the bound expectation: if the drawer moved since it was
      // recorded, a call now could only commit totals the attempt refuses.
      const now = buildAuthoritativeExpectation({ identity: attempt, body, serverData: d });
      if (!now.ok || !snapshotsEqual(now.expected, attempt.authoritative.expected)) {
        throw new Error(CLOSE_SHIFT_AUTHORITATIVE_DRAWER_CHANGED_MESSAGE);
      }
      // 015 (F2): the cashier must also have reviewed exactly this drawer.
      requireReviewedDrawer(deps, shift, d, now.expected);
    }
  } else {
    if (d.status !== 'open') throw new Error(CLOSE_SHIFT_ALREADY_CLOSED_MESSAGE);
    if (entriesMissingOnServer(d.cashEntries, shift.cashEntries, cachedRaw).length > 0) {
      throw new Error(CLOSE_SHIFT_AUTHORITATIVE_LOCAL_CASH_NOT_ON_SERVER_MESSAGE);
    }
    const expectation = buildAuthoritativeExpectation({ identity, body, serverData: d });
    if (!expectation.ok) {
      throw new Error(CLOSE_SHIFT_AUTHORITATIVE_SERVER_CASH_INVALID_MESSAGE, { cause: expectation });
    }
    // 015 (F2): BEFORE the attempt is prepared or anything is sent - the drawer
    // the cashier confirmed must be the very basis of this expectation.
    requireReviewedDrawer(deps, shift, d, expectation.expected);
    let prepared: Awaited<ReturnType<ShiftCloseIntentJournal['prepareOnlineCloseAttempt']>>;
    try {
      prepared = await journal.prepareOnlineCloseAttempt(identity, {
        protocol: 'server_authoritative_v1',
        request: body,
        expected: expectation.expected,
      });
    } catch (err) {
      prepared = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
    }
    if (!prepared.ok) {
      throw new Error(prepared.code === 'conflict' ? CLOSE_SHIFT_CONFLICT_MESSAGE : CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
    }
    if (prepared.value.kind === 'journaled') {
      return provenJournaledAuthoritativeClose(shift, prepared.value.entry, cachedEntries, ctx, getCallable);
    }
    // Another window may have bound the attempt first: it must be this very request.
    attempt = ownAuthoritativeAttempt(prepared.value.attempt, identity, body);
  }
  const correlationId = attempt.closeCorrelationId;

  // 8. The call (+ at most one same-id same-body replay).
  let callable: CloseShiftAuthoritativeCallable;
  try {
    callable = await getCallable();
  } catch {
    throw new Error(CLOSE_SHIFT_AUTHORITATIVE_UNAVAILABLE_MESSAGE);
  }
  const request = authoritativeCloseRequest(attempt.authoritative.request, correlationId);
  let outcome: AuthoritativeCloseOutcome = await invokeCloseShiftAuthoritative(callable, request);
  let replayed = false;
  while (outcome.kind !== 'committed') {
    if (outcome.kind === 'refused') {
      // Definitive for THAT call: nothing written by it. But the shift may be
      // closed with THIS id (a direct W3, another body, an inconsistent
      // record, or our own earlier commit before this replay): then it is a
      // known commit of the id — custody recorded, never worded "not closed".
      const code = outcome.code;
      let closedByThis = replayed || code === 'closed_outside_authority' || code === 'idempotency_conflict';
      if (!closedByThis && code === 'close_record_inconsistent') {
        const probe = await safeRead(readServer, shift.id);
        closedByThis = !probe.ok || (probe.exists && probe.data.closeCorrelationId === correlationId);
      }
      if (!closedByThis) throw new Error(authoritativeRefusalMessage(code), { cause: { code } });
      const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
      throw new Error(
        code === 'closed_outside_authority' || code === 'idempotency_conflict'
          ? authoritativeRefusalMessage(code)
          : CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE,
        { cause: { code, commitObservation } },
      );
    }
    if (outcome.kind === 'unknown') {
      // UNKNOWN is never "failed, so write directly": probe this exact id.
      const probe = await safeRead(readServer, shift.id);
      const closedByThis =
        probe.ok && probe.exists && probe.data.status === 'closed' && probe.data.closeCorrelationId === correlationId;
      if (!closedByThis) throw new Error(CLOSE_SHIFT_TX_FAILED_MESSAGE, { cause: { outcome: outcome.kind } });
    }
    // A commit of this id is known (or claimed): durable custody, then one replay.
    const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
    if (replayed) {
      throw new Error(CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE, { cause: { outcome: outcome.kind, commitObservation } });
    }
    replayed = true;
    outcome = await invokeCloseShiftAuthoritative(callable, request);
  }

  // 9. Proof-before-Z.
  const ownIdentity: OwnCloseIdentity = {
    shiftId: attempt.shiftId,
    branchId: attempt.branchId,
    staffId: attempt.staffId,
    staffName: attempt.staffName,
    deviceId: attempt.deviceId,
    closeCorrelationId: correlationId,
  };
  let read: ShiftCloseConfirmationRead;
  try {
    read = await readConfirmation(shift.id);
  } catch {
    read = { ok: false };
  }
  if (!read.ok) {
    const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
    throw new Error(CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE, { cause: { proof: 'unreachable', commitObservation } });
  }
  const parsed = parseCommittedOwnClose(ownIdentity, read.doc);
  if (!parsed.ok) {
    const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
    throw new Error(CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE, { cause: { proof: parsed.reason, commitObservation } });
  }
  if (
    !snapshotsEqual(parsed.snapshot, outcome.success.snapshot) ||
    !snapshotsEqual(parsed.snapshot, attempt.authoritative.expected) ||
    parsed.closedAt.getTime() !== outcome.success.closedAtMillis
  ) {
    console.warn('[shiftService] server-authoritative close committed values this device did not expect');
    const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
    throw new Error(CLOSE_SHIFT_AUTHORITATIVE_RESULT_MISMATCH_MESSAGE, { cause: { proof: 'differs_from_expected', commitObservation } });
  }
  for (let i = 0; i < 2; i += 1) {
    let finalized: Awaited<ReturnType<ShiftCloseIntentJournal['finalizeOnlineClose']>>;
    try {
      // 015: the callable's validated success is the server proof the store requires.
      finalized = await journal.finalizeOnlineClose(
        parsed.snapshot,
        correlationId,
        deps?.observePointerRepair,
        authoritativeServerProof(outcome.success, shift.id, correlationId),
      );
    } catch (err) {
      finalized = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
    }
    if (finalized.ok) {
      const entry = finalized.value;
      // Proven + journaled: a Return can no longer commit onto this closed shift.
      clearPending(shift.id);
      return {
        ...withMergedCashEntries(shift, cachedEntries, serverEntries),
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
        whenServerConfirmed: reconcileClosed(entry, withProvenRead(ctx, shift.id, read)),
      };
    }
    if (finalized.code === 'conflict') {
      console.warn('[shiftService] server-authoritative close conflicts with the local journal', finalized);
      const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
      throw new Error(
        finalized.reason === 'attempt_expectation_mismatch'
          ? CLOSE_SHIFT_AUTHORITATIVE_RESULT_MISMATCH_MESSAGE
          : CLOSE_SHIFT_COMMITTED_UNVERIFIED_MESSAGE,
        { cause: { finalizeRefusal: finalized.reason, commitObservation } },
      );
    }
    console.warn('[shiftService] server-authoritative close could not be journaled', finalized);
  }
  const commitObservation = await recordCommitObservation(journal, shift.id, correlationId);
  throw new Error(CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE, { cause: { commitObservation } });
}

/**
 * Packet 015 (F2) - the cashier confirmed a drawer; the close must use exactly
 * that one. Throws (nothing durable or remote happened yet) when the
 * operator-reviewed witness is absent, was taken before the display's server
 * refresh loaded, or differs from the authoritative cash data this close is
 * built from. `cause.reviewRequired` tells the modal to refresh its display
 * and ask for a new, explicit confirmation - the count is never reused over a
 * changed monetary basis.
 */
function requireReviewedDrawer(
  deps: CloseShiftDeps | undefined,
  shift: Shift,
  serverData: Record<string, unknown>,
  expected: ShiftCloseIntentBusinessSnapshot,
): void {
  const check = checkReviewedDrawerWitness(deps?.authoritativeClose?.reviewedDrawer, {
    shiftId: shift.id,
    branchId: shift.branchId,
    serverData,
    expected,
  });
  if (!check.ok) {
    throw new Error(CLOSE_SHIFT_AUTHORITATIVE_DISPLAY_CHANGED_MESSAGE, { cause: { reviewRequired: true, reason: check.reason } });
  }
}

/**
 * Packet 014 — an existing attempt may carry this close only when it is THIS
 * device's / branch's / staff's server-authoritative attempt for exactly this
 * request body. A legacy (transaction) attempt is an unresolved close of
 * another protocol, a tombstone can never commit, and a changed body under
 * the same id is never sent.
 */
function ownAuthoritativeAttempt(
  a: OnlineCloseAttemptRecord,
  identity: { shiftId: string; branchId: string; staffId: string; deviceId: string },
  body: AuthoritativeCloseRequestBody,
): OnlineCloseAttemptRecord & { authoritative: NonNullable<OnlineCloseAttemptRecord['authoritative']> } {
  if (a.shiftId !== identity.shiftId || a.branchId !== identity.branchId || a.staffId !== identity.staffId || a.deviceId !== identity.deviceId) {
    throw new Error(CLOSE_SHIFT_CONFLICT_MESSAGE);
  }
  if (!isAuthoritativeAttempt(a) || !a.authoritative) throw new Error(CLOSE_SHIFT_AUTHORITATIVE_LOCAL_CLOSE_PENDING_MESSAGE);
  if (isSupersededAttempt(a)) throw new Error(CLOSE_SHIFT_ALREADY_CLOSED_MESSAGE);
  if (!sameAuthoritativeRequestBody(a.authoritative.request, body)) {
    throw new Error(CLOSE_SHIFT_AUTHORITATIVE_REQUEST_CHANGED_MESSAGE);
  }
  return a as OnlineCloseAttemptRecord & { authoritative: NonNullable<OnlineCloseAttemptRecord['authoritative']> };
}

/**
 * Packet 014 — this shift already has a close record in the journal. Its Z is
 * shown only when the server doc is closed with ITS correlation id and the
 * strict parse equals it (nothing is finalized, sent or written here);
 * anything else (an offline-queued close not yet on the server, a rejected or
 * foreign entry, an unreadable server) refuses for manual handling.
 */
async function provenJournaledAuthoritativeClose(
  shift: Shift,
  entry: ShiftCloseIntentEntry,
  cachedEntries: ShiftCashEntry[],
  ctx: CloseReconcileDeps,
  getCallable: () => Promise<CloseShiftAuthoritativeCallable>,
): Promise<CloseShiftResult> {
  const pending = () => new Error(CLOSE_SHIFT_AUTHORITATIVE_LOCAL_CLOSE_PENDING_MESSAGE);
  if (
    entry.status === 'rejected_manual_attention' ||
    entry.closeCorrelationId === null ||
    entry.deviceId !== ctx.deviceId ||
    entry.branchId !== shift.branchId ||
    entry.staffId !== shift.staffId
  ) {
    throw pending();
  }
  let read: ShiftCloseConfirmationRead;
  try {
    read = await ctx.readConfirmation(shift.id);
  } catch {
    read = { ok: false };
  }
  if (!read.ok) throw pending();
  const parsed = parseCommittedOwnClose(
    {
      shiftId: entry.shiftId,
      branchId: entry.branchId,
      staffId: entry.staffId,
      staffName: entry.staffName,
      deviceId: ctx.deviceId,
      closeCorrelationId: entry.closeCorrelationId,
    },
    read.doc,
  );
  if (!parsed.ok || !snapshotsEqual(parsed.snapshot, entry)) throw pending();
  // 015 (F4): a journal entry says nothing about WHO wrote the W3 (an OFF
  // close journals a direct client W3 under the same shape). The shift is
  // definitely closed by this UUID here, so the callable's idempotent replay
  // (never a write) decides: only a server-authored close is a server-
  // authoritative Z; a legacy / forged one is refused, never relabelled.
  let callable: CloseShiftAuthoritativeCallable;
  try {
    callable = await getCallable();
  } catch {
    throw pending();
  }
  const proof = await proveServerAuthoredClose({
    callable,
    request: authoritativeRequestFromSnapshot(parsed.snapshot, entry.closeCorrelationId),
    closedDoc: { snapshot: parsed.snapshot, closedAtMillis: parsed.closedAt.getTime() },
  });
  if (proof.kind === 'unreachable') throw pending();
  if (proof.kind === 'manual_attention') throw new Error(CLOSE_SHIFT_AUTHORITATIVE_LEGACY_ENTRY_MESSAGE, { cause: proof });
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
    deviceId: ctx.deviceId,
    closedAtLocal: entry.closedAtLocal,
    whenServerConfirmed: reconcileClosed(entry, withProvenRead(ctx, shift.id, read)),
  };
}

/**
 * Packet 023 — the OFFLINE-FIRST server-authoritative close: this device cannot
 * reach the server (offline, its queued writes did not flush, or the
 * authoritative read failed) and nothing has been sent. The close the cashier
 * counted is RECORDED in the existing 7C-B1 close-intent journal as a deferred
 * server-authoritative close (`closeProtocol`) — the same durable record that
 * keeps the shift closed locally across a restart (boot never restores it, no
 * second open over it) — and NOTHING else happens: no client W3 / queued
 * `updateDoc`, no attempt, no callable, no guard change. The reconciliation
 * sweep replays it through `closeShiftAuthoritative` under the owner's session
 * (`replayDeferredAuthoritativeClose`); only that callable's proof makes it
 * `synced`.
 *  a. the legacy offline guards: an unresolved / unreadable cash Return guard
 *     or an online close attempt of this shift (unknown outcome) refuses;
 *  b. the recorded close is the EXACT close the server commits for this request
 *     over this device's drawer basis (stored startingCash + local ∪ cached cash
 *     movements), in canonical satang (`buildAuthoritativeExpectation`);
 *  c. the cashier reviewed exactly that drawer (F2 witness, without the server
 *     refresh it cannot have);
 *  d. one journal write (idempotent for the same close; a different / legacy
 *     record of the shift is a conflict).
 * The result is a LOCAL close record (`authoritativeDeferred`): never a
 * server-confirmed Z, `whenServerConfirmed` = `still_pending`.
 */
async function closeShiftDeferredLocally(
  shift: Shift,
  body: AuthoritativeCloseRequestBody,
  cachedData: { startingCash?: unknown },
  cachedEntries: ShiftCashEntry[],
  ctx: CloseReconcileDeps,
  deps: CloseShiftDeps | undefined,
): Promise<CloseShiftResult> {
  const { journal, deviceId } = ctx;
  // a. The same guards as the legacy offline close.
  const pendingState = deps?.serverCashPending
    ? deps.serverCashPending.has(shift.id)
      ? 'pending'
      : 'none'
    : readShiftServerCashPending(shift.id);
  if (pendingState === 'unverifiable') throw new Error(CLOSE_SHIFT_CASH_GUARD_UNVERIFIABLE_MESSAGE);
  if (pendingState === 'pending') throw new Error(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
  let attempts: Awaited<ReturnType<ShiftCloseIntentJournal['listOnlineCloseAttempts']>>;
  try {
    attempts = await journal.listOnlineCloseAttempts();
  } catch (err) {
    attempts = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!attempts.ok) throw new Error(CLOSE_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  if (attempts.value.some((a) => a.shiftId === shift.id)) throw new Error(CLOSE_SHIFT_ONLINE_ATTEMPT_UNRESOLVED_MESSAGE);

  // b. The drawer basis this device has, as the server will fold it.
  // The stored W0 value, as the legacy offline close uses it; a cached doc that disagrees is not trusted.
  if (cachedData.startingCash !== undefined && cachedData.startingCash !== shift.startingCash) {
    throw new Error(CLOSE_SHIFT_UNVERIFIABLE_MESSAGE);
  }
  const basis = withMergedCashEntries(shift, cachedEntries);
  const serverData = { startingCash: shift.startingCash, cashEntries: basis.cashEntries ?? [] };
  const identity = { shiftId: shift.id, branchId: shift.branchId, staffId: shift.staffId, staffName: shift.staffName, deviceId };
  const expectation = buildAuthoritativeExpectation({ identity, body, serverData });
  if (!expectation.ok) throw new Error(CLOSE_SHIFT_DEFERRED_LOCAL_CASH_INVALID_MESSAGE, { cause: expectation });

  // c. F2 on the local basis.
  const check = checkReviewedDrawerWitness(
    deps?.authoritativeClose?.reviewedDrawer,
    { shiftId: shift.id, branchId: shift.branchId, serverData, expected: expectation.expected },
    { requireServerRefresh: false },
  );
  if (!check.ok) {
    throw new Error(CLOSE_SHIFT_AUTHORITATIVE_DISPLAY_CHANGED_MESSAGE, { cause: { reviewRequired: true, reason: check.reason } });
  }

  // d. The durable local close record.
  let recorded: Awaited<ReturnType<ShiftCloseIntentJournal['upsertCloseIntent']>>;
  try {
    recorded = await journal.upsertCloseIntent(expectation.expected, deps?.observePointerRepair, undefined, {
      closeProtocol: DEFERRED_AUTHORITATIVE_CLOSE_PROTOCOL,
    });
  } catch (err) {
    recorded = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (!recorded.ok) {
    throw new Error(recorded.code === 'conflict' ? CLOSE_SHIFT_CONFLICT_MESSAGE : CLOSE_SHIFT_STORE_UNAVAILABLE_MESSAGE);
  }
  const entry = recorded.value;
  return {
    ...basis,
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
    whenServerConfirmed: Promise.resolve({ outcome: 'still_pending' }),
    authoritativeDeferred: true,
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
