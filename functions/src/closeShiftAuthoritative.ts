/**
 * closeShiftAuthoritative — Return/Refund V1 packet 012: the server-authoritative
 * W3 shift close (Admin SDK transaction + authenticated callable).
 *
 * ADDITIVE ONLY in this packet: no client calls it yet, and Rules still allow
 * the legacy direct client W3 (a documented pre-cutover risk; the Rules seal
 * is a later, separately authorized packet). Contract:
 * docs/contracts/close-shift-authoritative-v1.md. Pure decisions live in
 * `closeShiftAuthoritativeCore.ts`; this file is auth + transaction I/O.
 *
 * One Admin transaction, all reads before any write:
 *   users/{token.staffId}            live active / authVersion / role / branch
 *   shifts/{shiftId}                 owner, branch, open, identity, cashEntries
 *   shiftCloseAuthorityRecords/{id}  idempotency / replay
 *   saleRefunds  where shiftId == S          (limit cap + 1)
 *   saleReturns  where refund.shiftId == S   (limit cap + 1)
 * then, only when every check passed: the W3 `tx.update` (exact client
 * `closeWritePayload` field set) + `tx.create` of the authority record.
 *
 * Return-vs-close serialization: a cash Return's transaction reads AND
 * writes the same `shifts/{shiftId}` doc (requires `status == 'open'`) and
 * creates its `saleRefunds` / `saleReturns` docs in that same commit. Both
 * transactions read + write the shift doc, so they serialize: a Return that
 * commits first is visible to this transaction's (re)run, refund docs
 * included; a Return after this close re-reads a closed shift and refuses.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { DESKTOP_CALLABLE_CORS } from './callableCors';
import { tokenAuthVersion, tokenStaffId, type AuthLike } from './authorityFence';
import { SALE_RETURN_COLLECTIONS } from './saleReturnCore';
import {
  CLOSE_MAX_REFUND_RECORDS,
  SHIFT_CLOSE_AUTHORITY_COLLECTION,
  buildAuthorityRecord,
  callerBranchEligible,
  canonicalResponseFromDurable,
  decideCaller,
  decideClosedShiftReplay,
  deriveCloseRequestDigest,
  foldShiftCashEntriesStrict,
  parseOpenShiftIdentity,
  planAuthoritativeClose,
  validateCloseShiftRequest,
  verifyRefundAudit,
  type CloseShiftAuthoritativeErrorCode,
  type CloseShiftAuthoritativeResponse,
  type CloseShiftAuthoritativeSuccess,
  type RawRecord,
} from './closeShiftAuthoritativeCore';

const C = {
  users: 'users',
  shifts: 'shifts',
  authority: SHIFT_CLOSE_AUTHORITY_COLLECTION,
  refunds: SALE_RETURN_COLLECTIONS.refunds,
  returns: SALE_RETURN_COLLECTIONS.returns,
} as const;

export interface CloseShiftAuthoritativeDeps {
  /** Clock for the record's `createdAtMillis` (tests). */
  clock?: () => number;
  /** Test seam: awaited after the shift read of EACH transaction attempt (race tests). */
  afterShiftRead?: (attempt: number) => Promise<void> | void;
}

class CloseTxReject extends Error {
  constructor(readonly code: CloseShiftAuthoritativeErrorCode) {
    super(code);
    this.name = 'CloseTxReject';
  }
}

/** gRPC ABORTED — the SDK's own contention retry signal; must propagate out of the callback. */
function isAbortedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 10 || code === 'aborted' || code === 'ABORTED';
}

async function readCompleteSet(
  read: () => Promise<{ docs: Array<{ id: string; data: () => DocumentData | undefined }> }>,
): Promise<RawRecord[]> {
  let snap;
  try {
    snap = await read();
  } catch (err) {
    if (isAbortedError(err)) throw err;
    throw new CloseTxReject('refund_audit_unavailable');
  }
  return snap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }));
}

function logRefusal(code: CloseShiftAuthoritativeErrorCode, shiftId: string): void {
  console.warn('[closeShiftAuthoritative] refused', { code, shiftId });
}

/**
 * Core — EXPORTED so it is tested against the Firestore emulator without the
 * Functions runtime. Never throws for a definitive refusal (typed `ok:false`,
 * nothing written); an unexpected error (contention exhausted, transport)
 * propagates and the callable reports an unknown outcome.
 */
export async function performCloseShiftAuthoritative(
  database: Firestore,
  rawRequest: unknown,
  auth: AuthLike,
  deps: CloseShiftAuthoritativeDeps = {},
): Promise<CloseShiftAuthoritativeResponse> {
  const clock = deps.clock ?? (() => Date.now());
  const staffId = auth ? tokenStaffId(auth) : null;
  if (!auth || staffId == null) return { ok: false, code: 'unauthenticated' };
  const claimedAuthVersion = tokenAuthVersion(auth);

  const validated = validateCloseShiftRequest(rawRequest);
  if (!validated.ok) return validated;
  const request = validated.value;
  const requestDigest = deriveCloseRequestDigest(request);

  const userRef = database.collection(C.users).doc(staffId);
  const shiftRef = database.collection(C.shifts).doc(request.shiftId);
  const recordRef = database.collection(C.authority).doc(request.shiftId);

  let outcome: { kind: 'replay'; response: CloseShiftAuthoritativeSuccess } | { kind: 'committed' };
  let attempt = 0;
  try {
    outcome = await database.runTransaction(async (tx) => {
      attempt += 1;
      // ── Reads (all before any write) ──
      const userSnap = await tx.get(userRef);
      const shiftSnap = await tx.get(shiftRef);
      if (deps.afterShiftRead) await deps.afterShiftRead(attempt);
      const recordSnap = await tx.get(recordRef);

      const user = userSnap.exists ? ((userSnap.data() ?? {}) as Record<string, unknown>) : null;
      const caller = decideCaller(user, claimedAuthVersion);
      if (!caller.ok) throw new CloseTxReject(caller.code);

      if (!shiftSnap.exists) throw new CloseTxReject('shift_not_found');
      const shiftData = (shiftSnap.data() ?? {}) as Record<string, unknown>;
      // Owner + branch BEFORE anything about the shift's state is revealed.
      if (shiftData.staffId !== staffId) throw new CloseTxReject('not_shift_owner');
      if (typeof shiftData.branchId !== 'string' || !callerBranchEligible(caller.role, user!, shiftData.branchId)) {
        throw new CloseTxReject('branch_not_authorized');
      }

      const record = recordSnap.exists ? ((recordSnap.data() ?? {}) as Record<string, unknown>) : null;
      if (shiftData.status === 'closed') {
        const replay = decideClosedShiftReplay({ shiftData, record, request, requestDigest });
        if (!replay.ok) throw new CloseTxReject(replay.code);
        return { kind: 'replay' as const, response: replay };
      }
      if (shiftData.status !== 'open') throw new CloseTxReject('shift_state_invalid');
      if (record != null) throw new CloseTxReject('close_record_inconsistent');

      const identity = parseOpenShiftIdentity(request.shiftId, shiftData);
      if (!identity.ok) throw new CloseTxReject(identity.code);
      const shift = identity.value;
      const cash = foldShiftCashEntriesStrict(shiftData.cashEntries, 'cashEntries' in shiftData);
      if (!cash.ok) throw new CloseTxReject(cash.code);

      const refunds = await readCompleteSet(() =>
        tx.get(database.collection(C.refunds).where('shiftId', '==', shift.shiftId).limit(CLOSE_MAX_REFUND_RECORDS + 1)),
      );
      const returns = await readCompleteSet(() =>
        tx.get(
          database.collection(C.returns).where('refund.shiftId', '==', shift.shiftId).limit(CLOSE_MAX_REFUND_RECORDS + 1),
        ),
      );
      const audit = verifyRefundAudit({ shift, refunds, returns, serverRefundEntries: cash.value.serverRefundEntries });
      if (!audit.ok) throw new CloseTxReject(audit.code);

      const plan = planAuthoritativeClose({ shift, request, cash: cash.value });
      if (!plan.ok) throw new CloseTxReject(plan.code);

      // ── Writes ──
      const closedAt = FieldValue.serverTimestamp();
      tx.update(shiftRef, { ...plan.value.w3Fields, closedAt });
      tx.create(recordRef, {
        ...buildAuthorityRecord({
          request,
          requestDigest,
          plan: plan.value,
          cash: cash.value,
          audit: audit.value,
          callerStaffId: staffId,
          nowMillis: clock(),
        }),
        closedAt,
      });
      return { kind: 'committed' as const };
    });
  } catch (err: unknown) {
    if (err instanceof CloseTxReject) {
      logRefusal(err.code, request.shiftId);
      return { ok: false, code: err.code };
    }
    throw err;
  }

  if (outcome.kind === 'replay') return outcome.response;

  // Committed. The canonical response (with the resolved server `closedAt`)
  // is read back from the durable docs; an unreadable read-back is reported
  // as committed-but-unconfirmed, and a same-UUID retry replays it.
  try {
    const [shiftSnap, recordSnap] = await database.getAll(shiftRef, recordRef);
    if (shiftSnap?.exists && recordSnap?.exists) {
      const response = canonicalResponseFromDurable({
        shiftData: (shiftSnap.data() ?? {}) as Record<string, unknown>,
        record: (recordSnap.data() ?? {}) as Record<string, unknown>,
        idempotentReplay: false,
      });
      if (response.ok) return response;
    }
  } catch {
    // fall through
  }
  return { ok: false, code: 'committed_unconfirmed' };
}

export const closeShiftAuthoritative = onCall(
  { region: FUNCTIONS_REGION, cors: DESKTOP_CALLABLE_CORS },
  async (request) => {
    try {
      return await performCloseShiftAuthoritative(db, request.data ?? {}, request.auth as AuthLike);
    } catch {
      // Unknown outcome (e.g. contention exhausted / transport): never a
      // success, never "failed". A retry with the SAME closeCorrelationId is
      // safe — it replays a committed close and never closes twice.
      throw new HttpsError('unavailable', 'ยังยืนยันผลการปิดกะกับเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่ด้วยรายการเดิม (ระบบจะไม่ปิดกะซ้ำ)');
    }
  },
);
