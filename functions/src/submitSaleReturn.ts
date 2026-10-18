/**
 * Return/Refund V1 — online-only mediating callables (TPOS-USABLE-POS-RETURN-REFUND-V1).
 *
 *  - `getSaleReturnContext`: read-only. Classifies a sale (RETURN_ELIGIBLE /
 *    RETURN_UNSUPPORTED_EVIDENCE / RETURN_NOT_ELIGIBLE) and returns the
 *    sold / already-returned / returnable quantities and refundable tenders.
 *  - `submitSaleReturn`: the requester (any live `pos_sale` operator) submits
 *    the exact return; a DIFFERENT Manager/Admin holding live `pos_return`
 *    approves it with their PIN in the same call (reusing the existing
 *    `performRequestManagerApproval` PIN/lockout/audit primitive under the
 *    distinct `SALE_RETURN` action + `saleReturn` audience). The approval's
 *    commandId embeds a server-computed digest of the return content, so the
 *    PIN approves exactly what is executed.
 *
 * Exact-once: one transaction re-reads the original sale, the per-sale return
 * ledger, the approval, both actors' live authority and the target lots, then
 * commits — atomically — the approval consume, the immutable return record,
 * the immutable refund record, the ledger successor, FIFO cost-basis stock
 * restoration, stock movements, the cash-drawer pay-out (cash refunds only)
 * and the audit trail. Every effect doc id is deterministic in `returnId`, so
 * a retry either replays the committed result or commits nothing.
 *
 * The original sale (asyncOrders / orders / orderItems / payments) is never
 * written. Void is untouched except that it now refuses a sale that already
 * has an accepted return (voidIntent.ts / submitPrivilegedVoid.ts).
 *
 * Blocker-fix hardening (TPOS-USABLE-POS-RETURN-REFUND-V1-BLOCKER-FIX):
 *  - the approver credential is re-read and the approval TTL re-checked with
 *    a FRESH clock inside each transaction attempt;
 *  - the ledger is validated against the sale before any effect;
 *  - an original lot is restored in place only when it is provably the same
 *    intact cost layer with room (else a sale-time-cost restoration lot);
 *  - oversold units fail closed (`oversell_return_unsupported`);
 *  - a sale with `voidedBy` stamped by an in-flight online Void is refused;
 *  - `mode: 'resolve'` (no PIN) settles an unknown outcome: it replays a
 *    committed attempt or FENCES it (`saleReturnAttemptResolutions`) so it can
 *    never commit later — the only safe basis for the client to start anew;
 *  - customer spend aggregates are decremented exact-once by the refund.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { DESKTOP_CALLABLE_CORS } from './callableCors';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';
import { isUsableForLogin, readUserCredential } from './credentialStore';
import {
  decideLiveRolePermission,
  firestoreStagedRoleDenyHeadReader,
  liveRoleHoldsReturnRequesterPermission,
  readRolePermissionsDoc,
  type RolePermissionsReader,
  type StagedRoleDenyHeadReader,
} from './privilegedActionAuthority';
import {
  SALE_RETURN_ACTION_ID,
  SALE_RETURN_APPROVER_PERMISSION,
  SALE_RETURN_AUDIENCE,
  SALE_RETURN_REQUESTER_PERMISSION,
} from './privilegedActionRegistry';
import {
  type ApprovalRecordView,
  type ManagerApprovalServerErrorCode,
  approverBranchEligible,
  checkApprovalBinding,
  deriveApprovalId,
  isModel2ApproverRole,
  requesterBranchEligible,
} from './requestManagerApprovalCore';
import { performRequestManagerApproval, type PinCompareFn } from './requestManagerApproval';
import {
  SALE_RETURN_COLLECTIONS,
  SALE_RETURN_SCHEMA_VERSION,
  buildReturnContextView,
  decideInPlaceLotRestore,
  deriveCashRefundEntryId,
  deriveReturnApprovalCommandId,
  deriveReturnAuditEventId,
  deriveReturnContentDigest,
  deriveReturnId,
  deriveReturnNo,
  deriveReturnPortionDocId,
  isFullyReturned,
  minorToBaht,
  milliToQty,
  parseReturnLedgerForSale,
  parseSaleEvidence,
  planCustomerSpendAdjustment,
  planSaleReturn,
  serializeReturnLedger,
  validateSubmitSaleReturnRequest,
  type InPlaceLotDecision,
  type SaleReturnClassification,
  type SaleReturnContextView,
  type SaleReturnPlan,
  type SaleReturnPlanRejectCode,
  type SaleReturnRefundMethod,
  type SubmitSaleReturnRequest,
  type ValidatedSubmitSaleReturnRequest,
} from './saleReturnCore';

const C = {
  users: 'users',
  approvals: 'managerApprovals',
  asyncOrders: 'asyncOrders',
  orders: 'orders',
  stockLots: 'stockLots',
  stockMovements: 'stockMovements',
  products: 'products',
  productStocks: 'productStocks',
  shifts: 'shifts',
  cashTransactions: 'cashTransactions',
  auditLogs: 'auditLogs',
  customers: 'customers',
  ...SALE_RETURN_COLLECTIONS,
} as const;

export type SaleReturnErrorCode =
  | SaleReturnPlanRejectCode
  | ManagerApprovalServerErrorCode
  | 'order_not_found'
  | 'shift_required'
  | 'idempotency_conflict'
  /** Definitive: this attempt is fenced and can never commit; a new attempt is safe. */
  | 'attempt_not_committed';

export type SubmitSaleReturnResponse =
  | {
      ok: true;
      returnId: string;
      returnNo: string;
      refundId: string | null;
      refundAmount: number;
      refundMethod: SaleReturnRefundMethod;
      idempotent: boolean;
    }
  | { ok: false; code: SaleReturnErrorCode };

export type GetSaleReturnContextRequest = { orderId?: unknown; branchId?: unknown };

export type GetSaleReturnContextResponse =
  | {
      ok: true;
      classification: SaleReturnClassification;
      reason: string | null;
      context: SaleReturnContextView | null;
    }
  | { ok: false; code: 'not_authorized' | 'branch_mismatch' | 'invalid_request' };

export interface SaleReturnDeps {
  /** Fixed clock (tests). Superseded by `clock` when both are given. */
  nowMillis?: number;
  /**
   * Clock read at each decision boundary — notably once per Return
   * transaction ATTEMPT for the approval TTL, so a retried attempt that
   * crosses the expiry boundary is rejected.
   */
  clock?: () => number;
  comparePin?: PinCompareFn;
  readRolePermissions?: RolePermissionsReader;
  readStagedDenyHead?: StagedRoleDenyHeadReader;
}

class ReturnTxReject extends Error {
  constructor(readonly code: SaleReturnErrorCode | 'replay') {
    super(code);
    this.name = 'ReturnTxReject';
  }
}

function tokenHasPermission(auth: AuthLike, perm: string): boolean {
  const raw = auth?.token?.permissions;
  return Array.isArray(raw) && raw.some((p) => p === perm);
}

function liveRole(user: DocumentData): string | null {
  return typeof user.role === 'string' ? user.role : null;
}

function liveBranchIds(user: DocumentData): string[] {
  return Array.isArray(user.branchIds) ? user.branchIds.filter((v): v is string => typeof v === 'string') : [];
}

function liveAuthVersion(user: DocumentData): number {
  return typeof user.authVersion === 'number' && Number.isFinite(user.authVersion) ? user.authVersion : 0;
}

function displayName(user: DocumentData): string {
  const first = typeof user.firstName === 'string' ? user.firstName : '';
  const last = typeof user.lastName === 'string' ? user.lastName : '';
  return `${first} ${last}`.trim() || (typeof user.username === 'string' ? user.username : '');
}

/** Requester: any live operator role; staff/manager exact branch, admin exact or live `ALL`. */
function requesterBranchOk(role: string | null, branchIds: string[], branchId: string): boolean {
  if (role === 'admin') return branchIds.includes('ALL') || branchIds.includes(branchId);
  if (role === 'manager' || role === 'staff') return requesterBranchEligible(branchIds, branchId);
  return false;
}

function isRequesterRole(role: string | null): boolean {
  return role === 'admin' || role === 'manager' || role === 'staff';
}

function toMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && 'toMillis' in value) {
    const fn = (value as { toMillis?: unknown }).toMillis;
    if (typeof fn === 'function') {
      const ms = fn.call(value);
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

function approvalViewFromData(data: DocumentData | undefined): ApprovalRecordView | null {
  if (!data) return null;
  return {
    audience: data.audience,
    protectedAction: data.protectedAction,
    targetEntityId: data.targetEntityId,
    branchId: data.branchId,
    commandId: data.commandId,
    requesterStaffId: data.requesterStaffId,
    approverStaffId: data.approverStaffId,
    executorStaffId: data.executorStaffId,
    securityModel: data.securityModel,
    authVersionAtIssue: data.authVersionAtIssue,
    credentialVersionAtIssue: data.credentialVersionAtIssue,
    consumedAt: data.consumedAt ?? null,
    expiresAtMillis: toMillis(data.expiresAt),
    approverAuthVersionAtIssue: data.approverAuthVersionAtIssue,
  };
}

type RequesterCheck =
  | { ok: true; staffId: string; authVersion: number; role: string; user: DocumentData }
  | { ok: false; code: 'not_authorized' | 'branch_mismatch' };

async function checkRequester(
  database: Firestore,
  auth: AuthLike,
  branchId: string,
  deps: SaleReturnDeps,
): Promise<RequesterCheck> {
  if (!auth) return { ok: false, code: 'not_authorized' };
  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) return { ok: false, code: 'not_authorized' };
  if (!tokenHasPermission(auth, SALE_RETURN_REQUESTER_PERMISSION)) return { ok: false, code: 'not_authorized' };
  const snap = await database.collection(C.users).doc(freshness.staffId).get();
  if (!snap.exists) return { ok: false, code: 'not_authorized' };
  const user = (snap.data() ?? {}) as DocumentData;
  const role = liveRole(user);
  if (!isRequesterRole(role)) return { ok: false, code: 'not_authorized' };
  const maySell = await liveRoleHoldsReturnRequesterPermission(
    database,
    role,
    deps.readRolePermissions,
    deps.readStagedDenyHead,
  );
  if (!maySell) return { ok: false, code: 'not_authorized' };
  if (!requesterBranchOk(role, liveBranchIds(user), branchId)) return { ok: false, code: 'branch_mismatch' };
  return { ok: true, staffId: freshness.staffId, authVersion: freshness.authVersion, role: role as string, user };
}

const DOC_ID_RE = /^[^/]{1,200}$/;

// ---------------------------------------------------------------------------
// getSaleReturnContext
// ---------------------------------------------------------------------------

export async function performGetSaleReturnContext(
  database: Firestore,
  req: GetSaleReturnContextRequest,
  auth: AuthLike,
  deps: SaleReturnDeps = {},
): Promise<GetSaleReturnContextResponse> {
  const orderId = typeof req.orderId === 'string' ? req.orderId.trim() : '';
  const branchId = typeof req.branchId === 'string' ? req.branchId.trim() : '';
  if (!DOC_ID_RE.test(orderId) || !DOC_ID_RE.test(branchId) || branchId === 'ALL') {
    return { ok: false, code: 'invalid_request' };
  }
  const requester = await checkRequester(database, auth, branchId, deps);
  if (!requester.ok) return { ok: false, code: requester.code };

  const [asyncSnap, canonicalSnap, ledgerSnap] = await Promise.all([
    database.collection(C.asyncOrders).doc(orderId).get(),
    database.collection(C.orders).doc(orderId).get(),
    database.collection(C.ledgers).doc(orderId).get(),
  ]);
  const evidence = parseSaleEvidence(
    orderId,
    asyncSnap.exists ? ((asyncSnap.data() ?? {}) as Record<string, unknown>) : null,
    canonicalSnap.exists ? ((canonicalSnap.data() ?? {}) as Record<string, unknown>) : null,
    branchId,
  );
  if (!evidence.ok) {
    if (evidence.reason === 'branch_mismatch') return { ok: false, code: 'branch_mismatch' };
    return { ok: true, classification: evidence.classification, reason: evidence.reason, context: null };
  }
  const ledger = parseReturnLedgerForSale(ledgerSnap.exists ? ledgerSnap.data() : undefined, evidence.sale);
  if (ledger == null) {
    return { ok: true, classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason: 'ledger_malformed', context: null };
  }
  const context = buildReturnContextView(evidence.sale, ledger);
  if (isFullyReturned(evidence.sale, ledger)) {
    return { ok: true, classification: 'RETURN_NOT_ELIGIBLE', reason: 'fully_returned', context };
  }
  // Every unreturned unit was sold from oversell: nothing V1 can return.
  if (context.lines.every((l) => l.supportedReturnableQtyMilli <= 0)) {
    return { ok: true, classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason: 'oversell_return_unsupported', context };
  }
  return { ok: true, classification: 'RETURN_ELIGIBLE', reason: null, context };
}

// ---------------------------------------------------------------------------
// submitSaleReturn
// ---------------------------------------------------------------------------

function fail(code: SaleReturnErrorCode): SubmitSaleReturnResponse {
  return { ok: false, code };
}

async function writeRejectionAudit(
  database: Firestore,
  params: {
    returnId: string;
    kind: 'rejected' | 'duplicate_replay';
    code: string | null;
    value: ValidatedSubmitSaleReturnRequest;
    requesterStaffId: string | null;
    nowMillis: number;
  },
): Promise<void> {
  try {
    await database
      .collection(C.auditEvents)
      .doc(`${params.returnId}_${params.kind}_${params.nowMillis}`)
      .set({
        schemaVersion: SALE_RETURN_SCHEMA_VERSION,
        eventType: params.kind,
        code: params.code,
        returnId: params.returnId,
        originalOrderId: params.value.orderId,
        branchId: params.value.branchId,
        requesterStaffId: params.requesterStaffId,
        approverStaffId: params.value.approverStaffId,
        lines: params.value.lines.map((l) => ({ lineIndex: l.lineIndex, productId: l.productId, qty: milliToQty(l.qtyMilli) })),
        refundMethod: params.value.refundMethod,
        refundAmount: minorToBaht(params.value.expectedRefundMinor),
        createdAt: FieldValue.serverTimestamp(),
        createdAtMillis: params.nowMillis,
      });
  } catch {
    // Audit of a REJECTED attempt is best-effort: a write failure here never
    // turns a rejection into success and never blocks the response.
  }
}

function replayResponse(data: DocumentData): SubmitSaleReturnResponse {
  const refund = (data.refund ?? {}) as Record<string, unknown>;
  const method = refund.method as SaleReturnRefundMethod;
  return {
    ok: true,
    returnId: String(data.returnId),
    returnNo: String(data.returnNo),
    refundId: typeof refund.refundId === 'string' ? refund.refundId : null,
    refundAmount: typeof refund.amount === 'number' ? refund.amount : 0,
    refundMethod: method,
    idempotent: true,
  };
}

type PortionWrite = {
  lineIndex: number;
  productId: string;
  portionIndex: number;
  originalLotId: string;
  qtyBaseMilli: number;
  costPerUnit: number;
  restoreMode: 'original_lot' | 'restoration_lot';
  /** Why the original lot was NOT used (audit); null for an in-place restore. */
  restoreDecisionReason: string | null;
  restoredLotId: string;
  movementId: string;
};

function defaultClock(deps: SaleReturnDeps): () => number {
  if (deps.clock) return deps.clock;
  if (deps.nowMillis != null) {
    const fixed = deps.nowMillis;
    return () => fixed;
  }
  return () => Date.now();
}

/**
 * Core verifier — EXPORTED so it is unit-tested without the Functions runtime.
 */
export async function performSubmitSaleReturn(
  database: Firestore,
  req: SubmitSaleReturnRequest,
  auth: AuthLike,
  deps: SaleReturnDeps = {},
): Promise<SubmitSaleReturnResponse> {
  const clock = defaultClock(deps);
  const nowMillis = clock();
  if (!auth) return fail('not_authorized');

  if (req.mode !== undefined && req.mode !== 'submit' && req.mode !== 'resolve') return fail('invalid_request');
  const resolveOnly = req.mode === 'resolve';
  const validated = validateSubmitSaleReturnRequest(req, { requirePin: !resolveOnly });
  if (!validated.ok) return fail('invalid_request');
  const value = validated.value;

  const requester = await checkRequester(database, auth, value.branchId, deps);
  if (!requester.ok) return fail(requester.code);
  const staffId = requester.staffId;

  // No self-approval — structural, before any PIN compare.
  if (value.approverStaffId === staffId) return fail('self_approval_not_permitted');

  const returnId = deriveReturnId(value.branchId, value.orderId, value.attemptId);
  const contentDigest = deriveReturnContentDigest(value);
  const commandId = deriveReturnApprovalCommandId(returnId, contentDigest);
  const returnRef = database.collection(C.returns).doc(returnId);
  const fenceRef = database.collection(C.attemptResolutions).doc(returnId);

  const reject = async (code: SaleReturnErrorCode): Promise<SubmitSaleReturnResponse> => {
    await writeRejectionAudit(database, { returnId, kind: 'rejected', code, value, requesterStaffId: staffId, nowMillis });
    return fail(code);
  };

  const replayOrConflict = async (data: DocumentData): Promise<SubmitSaleReturnResponse> => {
    if (data.contentDigest !== contentDigest || data.requesterStaffId !== staffId) {
      return reject('idempotency_conflict');
    }
    await writeRejectionAudit(database, {
      returnId,
      kind: 'duplicate_replay',
      code: null,
      value,
      requesterStaffId: staffId,
      nowMillis,
    });
    return replayResponse(data);
  };

  // ── Resolve mode (D-RET-FIX-7): no PIN, never executes a Return. ──
  // Atomically: an already-committed attempt answers with its own record;
  // otherwise the attempt is FENCED so it can never commit afterwards, which
  // makes "not committed" definitive and a fresh attempt safe.
  if (resolveOnly) {
    let resolved: { kind: 'replay'; data: DocumentData } | { kind: 'fenced' } | { kind: 'conflict' };
    try {
      resolved = await database.runTransaction(async (tx) => {
        const committedSnap = await tx.get(returnRef);
        const fenceSnap = await tx.get(fenceRef);
        if (committedSnap.exists) return { kind: 'replay' as const, data: (committedSnap.data() ?? {}) as DocumentData };
        if (fenceSnap.exists) {
          const fence = (fenceSnap.data() ?? {}) as DocumentData;
          return fence.requesterStaffId === staffId ? { kind: 'fenced' as const } : { kind: 'conflict' as const };
        }
        tx.create(fenceRef, {
          schemaVersion: SALE_RETURN_SCHEMA_VERSION,
          returnId,
          attemptId: value.attemptId,
          originalOrderId: value.orderId,
          branchId: value.branchId,
          requesterStaffId: staffId,
          contentDigest,
          resolution: 'not_committed',
          createdAt: FieldValue.serverTimestamp(),
          createdAtMillis: clock(),
        });
        return { kind: 'fenced' as const };
      });
    } catch {
      return fail('invalid_target');
    }
    if (resolved.kind === 'replay') return replayOrConflict(resolved.data);
    if (resolved.kind === 'conflict') return reject('idempotency_conflict');
    return reject('attempt_not_committed');
  }

  // Replay: an already-committed return answers with its own record; no new
  // effect and no new approval work (no PIN burned for a committed attempt).
  const existing = await returnRef.get();
  if (existing.exists) return replayOrConflict((existing.data() ?? {}) as DocumentData);
  if ((await fenceRef.get()).exists) return reject('attempt_not_committed');

  // Pre-flight plan (fail fast before burning a PIN attempt). Re-done in-tx.
  const [asyncSnap0, canonicalSnap0, ledgerSnap0] = await Promise.all([
    database.collection(C.asyncOrders).doc(value.orderId).get(),
    database.collection(C.orders).doc(value.orderId).get(),
    database.collection(C.ledgers).doc(value.orderId).get(),
  ]);
  const evidence0 = parseSaleEvidence(
    value.orderId,
    asyncSnap0.exists ? ((asyncSnap0.data() ?? {}) as Record<string, unknown>) : null,
    canonicalSnap0.exists ? ((canonicalSnap0.data() ?? {}) as Record<string, unknown>) : null,
    value.branchId,
  );
  if (!evidence0.ok) {
    if (evidence0.reason === 'order_not_found') return reject('order_not_found');
    if (evidence0.reason === 'branch_mismatch') return reject('branch_mismatch');
    return reject(
      evidence0.classification === 'RETURN_UNSUPPORTED_EVIDENCE' ? 'return_unsupported_evidence' : 'return_not_eligible',
    );
  }
  const ledger0 = parseReturnLedgerForSale(ledgerSnap0.exists ? ledgerSnap0.data() : undefined, evidence0.sale);
  if (ledger0 == null) return reject('return_unsupported_evidence');
  const plan0 = planSaleReturn(evidence0.sale, ledger0, value, returnId);
  if (!plan0.ok) return reject(plan0.code);
  if (plan0.plan.refundMethod === 'cash' && value.shiftId == null) return reject('shift_required');

  // Manager/Admin approval — existing PIN/lockout/audit primitive, distinct action.
  const approval = await performRequestManagerApproval(
    database,
    {
      commandId,
      protectedAction: SALE_RETURN_ACTION_ID,
      targetEntityId: value.orderId,
      branchId: value.branchId,
      pin: value.pin,
      securityModel: 'delegated',
      approverStaffId: value.approverStaffId,
    },
    auth,
    {
      nowMillis: clock(),
      comparePin: deps.comparePin,
      readRolePermissions: deps.readRolePermissions,
      readStagedDenyHead: deps.readStagedDenyHead,
    },
  );
  if (!approval.ok) return reject(approval.code);
  const approvalId = deriveApprovalId(commandId);
  if (approval.approvalId !== approvalId) return reject('invalid_target');
  const approvalRef = database.collection(C.approvals).doc(approvalId);

  const ledgerRef = database.collection(C.ledgers).doc(value.orderId);
  const asyncRef = database.collection(C.asyncOrders).doc(value.orderId);
  const canonicalRef = database.collection(C.orders).doc(value.orderId);
  const requesterRef = database.collection(C.users).doc(staffId);
  const approverRef = database.collection(C.users).doc(value.approverStaffId);
  const shiftRef = value.shiftId ? database.collection(C.shifts).doc(value.shiftId) : null;

  let committed: { plan: SaleReturnPlan; returnNo: string; refundId: string | null } | undefined;
  try {
    committed = await database.runTransaction(async (tx) => {
      // ── Reads (all before any write) ──
      const freshReturn = await tx.get(returnRef);
      if (freshReturn.exists) throw new ReturnTxReject('replay');
      const freshFence = await tx.get(fenceRef);
      const freshApproval = approvalViewFromData((await tx.get(approvalRef)).data());
      const ledgerSnap = await tx.get(ledgerRef);
      const asyncSnap = await tx.get(asyncRef);
      const canonicalSnap = await tx.get(canonicalRef);
      const requesterSnap = await tx.get(requesterRef);
      const approverSnap = await tx.get(approverRef);
      // D-RET-FIX-5: the approver credential is re-read IN this transaction,
      // so a rotation/disable racing the commit conflicts with it.
      const freshCred = await readUserCredential(database, value.approverStaffId, tx);
      const matrix = await readRolePermissionsDoc(database, tx);
      const headReader = firestoreStagedRoleDenyHeadReader(database, tx);

      if (freshFence.exists) throw new ReturnTxReject('attempt_not_committed');

      // Approval: unconsumed, unexpired AT THIS ATTEMPT, bound to this requester/approver/content.
      const attemptNowMillis = clock();
      if (freshApproval == null) throw new ReturnTxReject('invalid_target');
      if (freshApproval.consumedAt != null) throw new ReturnTxReject('replayed_approval');
      if (freshApproval.expiresAtMillis == null || freshApproval.expiresAtMillis <= attemptNowMillis) {
        throw new ReturnTxReject('expired_approval');
      }
      const bindingOk = checkApprovalBinding(freshApproval, {
        audience: SALE_RETURN_AUDIENCE,
        protectedAction: SALE_RETURN_ACTION_ID,
        targetEntityId: value.orderId,
        branchId: value.branchId,
        commandId,
        staffId,
        authVersion: requester.authVersion,
        approverStaffId: value.approverStaffId,
      });
      if (!bindingOk) throw new ReturnTxReject('invalid_target');
      if (freshApproval.requesterStaffId === freshApproval.approverStaffId) {
        throw new ReturnTxReject('self_approval_not_permitted');
      }
      // Same credential policy as the mint: compare-authoritative, usable, and
      // exactly the credential version the PIN was verified against.
      if (
        !isUsableForLogin(freshCred) ||
        freshCred.credentialState !== 'rotated_authoritative' ||
        freshCred.credentialVersion !== freshApproval.credentialVersionAtIssue
      ) {
        throw new ReturnTxReject('not_authorized');
      }

      // Requester authority re-check at the commit boundary.
      const requesterDoc = requesterSnap.exists ? ((requesterSnap.data() ?? {}) as DocumentData) : null;
      if (requesterDoc == null || requesterDoc.isActive !== true || requesterDoc.deletedAt != null) {
        throw new ReturnTxReject('not_authorized');
      }
      if (liveAuthVersion(requesterDoc) !== requester.authVersion) throw new ReturnTxReject('not_authorized');
      const requesterRole = liveRole(requesterDoc);
      if (!isRequesterRole(requesterRole)) throw new ReturnTxReject('not_authorized');
      if (!requesterBranchOk(requesterRole, liveBranchIds(requesterDoc), value.branchId)) {
        throw new ReturnTxReject('branch_mismatch');
      }

      // Approver authority re-check at the commit boundary.
      const approverDoc = approverSnap.exists ? ((approverSnap.data() ?? {}) as DocumentData) : null;
      if (approverDoc == null || approverDoc.isActive !== true || approverDoc.deletedAt != null) {
        throw new ReturnTxReject('approver_not_eligible');
      }
      const approverRole = liveRole(approverDoc);
      if (!isModel2ApproverRole(approverRole)) throw new ReturnTxReject('approver_not_eligible');
      if (!approverBranchEligible(approverRole, liveBranchIds(approverDoc), value.branchId)) {
        throw new ReturnTxReject('approver_not_eligible');
      }
      if (
        typeof freshApproval.approverAuthVersionAtIssue === 'number' &&
        liveAuthVersion(approverDoc) !== freshApproval.approverAuthVersionAtIssue
      ) {
        throw new ReturnTxReject('not_authorized');
      }

      let requesterHead;
      let approverHead;
      try {
        requesterHead = await headReader(requesterRole as string);
        approverHead = await headReader(approverRole as string);
      } catch {
        throw new ReturnTxReject('not_authorized');
      }
      if (!decideLiveRolePermission(requesterRole, SALE_RETURN_REQUESTER_PERMISSION, matrix, requesterHead).allowed) {
        throw new ReturnTxReject('not_authorized');
      }
      if (!decideLiveRolePermission(approverRole, SALE_RETURN_APPROVER_PERMISSION, matrix, approverHead).allowed) {
        throw new ReturnTxReject('approver_not_eligible');
      }

      // Fresh sale evidence + validated cumulative ledger — the serialization point.
      const evidence = parseSaleEvidence(
        value.orderId,
        asyncSnap.exists ? ((asyncSnap.data() ?? {}) as Record<string, unknown>) : null,
        canonicalSnap.exists ? ((canonicalSnap.data() ?? {}) as Record<string, unknown>) : null,
        value.branchId,
      );
      if (!evidence.ok) {
        throw new ReturnTxReject(
          evidence.classification === 'RETURN_UNSUPPORTED_EVIDENCE' ? 'return_unsupported_evidence' : 'return_not_eligible',
        );
      }
      const sale = evidence.sale;
      const ledger = parseReturnLedgerForSale(ledgerSnap.exists ? ledgerSnap.data() : undefined, sale);
      if (ledger == null) throw new ReturnTxReject('return_unsupported_evidence');
      const planned = planSaleReturn(sale, ledger, value, returnId);
      if (!planned.ok) throw new ReturnTxReject(planned.code);
      const plan = planned.plan;

      // Cash drawer: the requester's own open shift on this branch.
      if (plan.refundMethod === 'cash') {
        if (!shiftRef) throw new ReturnTxReject('shift_required');
        const shiftSnap = await tx.get(shiftRef);
        const shiftData = shiftSnap.exists ? ((shiftSnap.data() ?? {}) as DocumentData) : null;
        if (
          shiftData == null ||
          shiftData.status !== 'open' ||
          shiftData.branchId !== value.branchId ||
          shiftData.staffId !== staffId
        ) {
          throw new ReturnTxReject('shift_required');
        }
      }

      // Target lots, read in this transaction (D-RET-FIX-3). Restore IN PLACE
      // only when the original lot is provably the same intact cost layer with
      // room for the units; otherwise a distinct restoration lot at the
      // sale-time cost. (Oversell portions were already refused by the plan.)
      const lotData = new Map<string, Record<string, unknown> | null>();
      const lotAgg = new Map<string, { productIds: Set<string>; costs: number[]; baseMilli: number }>();
      for (const line of plan.lines) {
        for (const portion of line.portions) {
          if (!lotData.has(portion.originalLotId)) {
            const snap = await tx.get(database.collection(C.stockLots).doc(portion.originalLotId));
            lotData.set(portion.originalLotId, snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null);
          }
          const agg = lotAgg.get(portion.originalLotId) ?? { productIds: new Set<string>(), costs: [], baseMilli: 0 };
          agg.productIds.add(line.productId);
          agg.costs.push(portion.costPerUnit);
          agg.baseMilli += portion.qtyBaseMilli;
          lotAgg.set(portion.originalLotId, agg);
        }
      }
      const lotDecisions = new Map<string, InPlaceLotDecision>();
      for (const [lotId, agg] of lotAgg) {
        lotDecisions.set(
          lotId,
          decideInPlaceLotRestore(lotData.get(lotId) ?? null, {
            productId: agg.productIds.size === 1 ? [...agg.productIds][0]! : '',
            branchId: value.branchId,
            portionCosts: agg.costs,
            restoreBaseMilli: agg.baseMilli,
          }),
        );
      }
      const portionWrites: PortionWrite[] = [];
      for (const line of plan.lines) {
        for (const portion of line.portions) {
          const docId = deriveReturnPortionDocId(returnId, line.lineIndex, portion.portionIndex);
          const decision = lotDecisions.get(portion.originalLotId)!;
          portionWrites.push({
            lineIndex: line.lineIndex,
            productId: line.productId,
            portionIndex: portion.portionIndex,
            originalLotId: portion.originalLotId,
            qtyBaseMilli: portion.qtyBaseMilli,
            costPerUnit: portion.costPerUnit,
            restoreMode: decision.ok ? 'original_lot' : 'restoration_lot',
            restoreDecisionReason: decision.ok ? null : decision.reason,
            restoredLotId: decision.ok ? portion.originalLotId : docId,
            movementId: docId,
          });
        }
      }

      // Customer spend aggregate (CRM release gate): read here, written below.
      const customerRef =
        sale.customerId && plan.refundMinor > 0 ? database.collection(C.customers).doc(sale.customerId) : null;
      let customerDoc: Record<string, unknown> | null = null;
      if (customerRef) {
        const custSnap = await tx.get(customerRef);
        customerDoc = custSnap.exists ? ((custSnap.data() ?? {}) as Record<string, unknown>) : null;
      }
      const customerAdjustment = planCustomerSpendAdjustment(sale.customerId, customerDoc, plan.refundMinor);

      const returnNo = deriveReturnNo(sale.billId, plan.sequence);
      const refundId = plan.refundMinor > 0 ? returnId : null;
      const cashEntryId = plan.refundMethod === 'cash' && plan.refundMinor > 0 ? deriveCashRefundEntryId(returnId) : null;
      const now = FieldValue.serverTimestamp();
      const requesterName = displayName(requesterDoc);
      const approverName = displayName(approverDoc);
      const refundAmount = minorToBaht(plan.refundMinor);
      const auditRefs = {
        initiated: deriveReturnAuditEventId(returnId, 'initiated'),
        approved: deriveReturnAuditEventId(returnId, 'approved'),
        inventory: deriveReturnAuditEventId(returnId, 'inventory_restored'),
        refund: deriveReturnAuditEventId(returnId, 'refund_recorded'),
        completed: deriveReturnAuditEventId(returnId, 'completed'),
      };

      // ── Writes ──
      tx.update(approvalRef, {
        consumedAt: now,
        consumedByStaffId: staffId,
        consumingAudience: SALE_RETURN_AUDIENCE,
        consumedCaseVersion: null,
      });

      const linesDoc = plan.lines.map((l) => ({
        lineIndex: l.lineIndex,
        productId: l.productId,
        productName: l.productName,
        sku: l.sku,
        category: l.category,
        unit: l.unit,
        unitFactor: l.unitFactor,
        originalSoldQty: milliToQty(l.soldQtyMilli),
        previouslyReturnedQty: milliToQty(l.previouslyReturnedQtyMilli),
        returnedQty: milliToQty(l.returnQtyMilli),
        returnedQtyBase: milliToQty(l.returnQtyBaseMilli),
        pricing: {
          unitPrice: minorToBaht(l.unitPriceMinor),
          lineDiscount: minorToBaht(l.lineDiscountMinor),
          lineTotal: minorToBaht(l.lineTotalMinor),
          billDiscountAlloc: minorToBaht(l.billDiscountAllocMinor),
          feeAlloc: minorToBaht(l.feeAllocMinor),
          lineRefundableShare: minorToBaht(l.refundableShareMinor),
          vatAmount: 0,
          refundAmount: minorToBaht(l.refundMinor),
          lineRevenueReversed: minorToBaht(l.lineRevenueMinor),
        },
        cost: {
          total: minorToBaht(l.costMinor),
          allocations: portionWrites
            .filter((p) => p.lineIndex === l.lineIndex)
            .map((p) => ({
              originalLotId: p.originalLotId,
              qtyBase: milliToQty(p.qtyBaseMilli),
              costPerUnit: p.costPerUnit,
              restoreMode: p.restoreMode,
              restoreDecisionReason: p.restoreDecisionReason,
              restoredLotId: p.restoredLotId,
              stockMovementId: p.movementId,
            })),
        },
      }));

      tx.create(returnRef, {
        schemaVersion: SALE_RETURN_SCHEMA_VERSION,
        returnId,
        returnNo,
        returnSequence: plan.sequence,
        status: 'completed',
        originalOrderId: value.orderId,
        originalReceiptNo: sale.billId,
        originalSaleCreatedAtMillis: sale.saleCreatedAtMs,
        originalShiftId: sale.saleShiftId,
        branchId: value.branchId,
        customerId: sale.customerId,
        customerName: sale.customerName,
        requesterStaffId: staffId,
        requesterName,
        approverStaffId: value.approverStaffId,
        approverName,
        approverRole,
        reason: value.reason,
        note: value.note,
        lines: linesDoc,
        totals: {
          refundAmount,
          lineRevenueReversed: minorToBaht(plan.lineRevenueMinor),
          costRestored: minorToBaht(plan.costMinor),
          originalSaleTotal: minorToBaht(sale.totalMinor),
          refundedTotalAfter: minorToBaht(plan.nextLedger.refundedTotalMinor),
        },
        refund: {
          refundId,
          method: plan.refundMethod,
          amount: refundAmount,
          reference: value.refundReference || null,
          shiftId: cashEntryId ? value.shiftId : null,
          cashEntryId,
        },
        customerAdjustment: customerAdjustment.apply
          ? { applied: true, customerId: sale.customerId, decrement: minorToBaht(customerAdjustment.decrementMinor), fields: customerAdjustment.fields }
          : { applied: false, customerId: sale.customerId, reason: customerAdjustment.reason },
        idempotency: { attemptId: value.attemptId, commandId, approvalId },
        contentDigest,
        auditEventIds: Object.values(auditRefs),
        createdAt: now,
        approvedAt: now,
        completedAt: now,
        createdAtMillis: attemptNowMillis,
      });

      if (refundId) {
        tx.create(database.collection(C.refunds).doc(refundId), {
          schemaVersion: SALE_RETURN_SCHEMA_VERSION,
          refundId,
          returnId,
          returnNo,
          originalOrderId: value.orderId,
          originalReceiptNo: sale.billId,
          branchId: value.branchId,
          method: plan.refundMethod,
          amount: refundAmount,
          reference: value.refundReference || null,
          // Cashier-executed. No payment-gateway refund API exists; a non-cash
          // refund is a manual record and never claims gateway confirmation.
          executionMode: plan.refundMethod === 'cash' ? 'cash_drawer' : 'manual_external',
          gatewayConfirmed: false,
          shiftId: cashEntryId ? value.shiftId : null,
          cashEntryId,
          requesterStaffId: staffId,
          approverStaffId: value.approverStaffId,
          createdAt: now,
          createdAtMillis: attemptNowMillis,
        });
      }

      tx.set(ledgerRef, {
        ...serializeReturnLedger(plan.nextLedger, value.orderId, value.branchId),
        updatedAt: now,
        updatedAtMillis: attemptNowMillis,
      });

      // FIFO cost-basis restoration. In-place lots get an EXACT value computed
      // from the lot read in this transaction (never a blind increment), so
      // qtyRemaining can never exceed qtyReceived.
      const stockByProduct = new Map<string, number>();
      for (const p of portionWrites) {
        const qty = milliToQty(p.qtyBaseMilli);
        stockByProduct.set(p.productId, (stockByProduct.get(p.productId) ?? 0) + p.qtyBaseMilli);
        if (p.restoreMode === 'restoration_lot') {
          tx.create(database.collection(C.stockLots).doc(p.restoredLotId), {
            id: p.restoredLotId,
            productId: p.productId,
            branchId: value.branchId,
            receivingId: returnId,
            costPerUnit: p.costPerUnit,
            qtyReceived: qty,
            qtyRemaining: qty,
            receivedAt: now,
            expiryDate: null,
            isDepleted: false,
            isGhost: false,
            createdAt: now,
            source: 'sale_return',
            sourceReturnId: returnId,
            sourceOrderId: value.orderId,
            sourceLineIndex: p.lineIndex,
            sourceMovementId: p.movementId,
            originalLotId: p.originalLotId,
            originalCostPerUnit: p.costPerUnit,
            restoreDecisionReason: p.restoreDecisionReason,
          });
        }
        tx.create(database.collection(C.stockMovements).doc(p.movementId), {
          id: p.movementId,
          productId: p.productId,
          branchId: value.branchId,
          type: 'return',
          qty,
          costPerUnit: p.costPerUnit,
          refId: returnId,
          refType: 'saleReturn',
          note: value.reason,
          createdBy: staffId,
          createdAt: now,
          sourceOrderId: value.orderId,
          sourceReceiptNo: sale.billId,
          sourceLineIndex: p.lineIndex,
          originalLotId: p.originalLotId,
          restoreMode: p.restoreMode,
          restoredLotId: p.restoredLotId,
        });
      }
      for (const [lotId, decision] of lotDecisions) {
        if (!decision.ok) continue;
        tx.update(database.collection(C.stockLots).doc(lotId), {
          qtyRemaining: milliToQty(decision.nextRemainingMilli),
          isDepleted: false,
          updatedAt: now,
        });
      }
      for (const [productId, qtyMilli] of stockByProduct) {
        tx.set(
          database.collection(C.products).doc(productId).collection(C.productStocks).doc(value.branchId),
          {
            branchId: value.branchId,
            totalStockBase: FieldValue.increment(milliToQty(qtyMilli)),
            lastMovementAt: now,
            updatedAt: now,
          },
          { merge: true },
        );
      }

      // Customer spend: exact values from the in-transaction read, floored at 0.
      if (customerRef && customerAdjustment.apply) {
        const custUpdate: Record<string, unknown> = { updatedAt: now };
        for (const [k, f] of Object.entries(customerAdjustment.fields)) custUpdate[k] = f!.after;
        tx.update(customerRef, custUpdate);
      }

      // Cash refund leaves the drawer: a pay-out on the requester's open shift.
      // The terminal drawer fold (foldCashEntries) and the shift-close
      // validator (foldCashEntriesSnapshot + cash pairs) both already count it.
      if (cashEntryId && shiftRef) {
        const note = `คืนเงินสด ${returnNo} (บิล ${sale.billId})`;
        tx.update(shiftRef, {
          cashEntries: FieldValue.arrayUnion({
            id: cashEntryId,
            type: 'pay_out',
            amount: refundAmount,
            note,
            staffId,
            staffName: requesterName,
            at: attemptNowMillis,
          }),
          updatedAt: now,
        });
        tx.create(database.collection(C.cashTransactions).doc(cashEntryId), {
          id: cashEntryId,
          shiftId: value.shiftId,
          branchId: value.branchId,
          staffId,
          staffName: requesterName,
          type: 'pay_out',
          amount: refundAmount,
          note,
          createdAt: now,
          source: 'sale_refund',
          refundId,
          returnId,
        });
      }

      const auditBase = {
        schemaVersion: SALE_RETURN_SCHEMA_VERSION,
        returnId,
        returnNo,
        originalOrderId: value.orderId,
        originalReceiptNo: sale.billId,
        branchId: value.branchId,
        requesterStaffId: staffId,
        approverStaffId: value.approverStaffId,
        lines: plan.lines.map((l) => ({ lineIndex: l.lineIndex, productId: l.productId, qty: milliToQty(l.returnQtyMilli) })),
        refundAmount,
        refundMethod: plan.refundMethod,
        createdAt: now,
        createdAtMillis: attemptNowMillis,
      };
      tx.create(database.collection(C.auditEvents).doc(auditRefs.initiated), { ...auditBase, eventType: 'initiated', reason: value.reason });
      tx.create(database.collection(C.auditEvents).doc(auditRefs.approved), {
        ...auditBase,
        eventType: 'approved',
        approvalId,
        approverRole,
      });
      tx.create(database.collection(C.auditEvents).doc(auditRefs.inventory), {
        ...auditBase,
        eventType: 'inventory_restored',
        restorations: portionWrites.map((p) => ({
          productId: p.productId,
          lineIndex: p.lineIndex,
          originalLotId: p.originalLotId,
          qtyBase: milliToQty(p.qtyBaseMilli),
          costPerUnit: p.costPerUnit,
          restoreMode: p.restoreMode,
          restoreDecisionReason: p.restoreDecisionReason,
          restoredLotId: p.restoredLotId,
          stockMovementId: p.movementId,
        })),
        costRestored: minorToBaht(plan.costMinor),
      });
      if (refundId) {
        tx.create(database.collection(C.auditEvents).doc(auditRefs.refund), {
          ...auditBase,
          eventType: 'refund_recorded',
          refundId,
          reference: value.refundReference || null,
          cashEntryId,
          shiftId: cashEntryId ? value.shiftId : null,
        });
      }
      tx.create(database.collection(C.auditEvents).doc(auditRefs.completed), { ...auditBase, eventType: 'completed' });
      tx.create(database.collection(C.auditLogs).doc(`saleReturn_${returnId}`), {
        id: `saleReturn_${returnId}`,
        collection: C.returns,
        docId: returnId,
        action: 'refund',
        before: { orderId: value.orderId, refundedTotal: minorToBaht(ledger.refundedTotalMinor) },
        after: { returnNo, refundAmount, refundMethod: plan.refundMethod },
        reason: value.reason,
        changedBy: staffId,
        changedAt: now,
      });

      return { plan, returnNo, refundId };
    });
  } catch (err: unknown) {
    if (err instanceof ReturnTxReject) {
      if (err.code === 'replay') {
        const snap = await returnRef.get();
        if (snap.exists) return replayOrConflict((snap.data() ?? {}) as DocumentData);
        return reject('invalid_target');
      }
      return reject(err.code);
    }
    throw err;
  }
  if (committed == null) return reject('invalid_target');

  return {
    ok: true,
    returnId,
    returnNo: committed.returnNo,
    refundId: committed.refundId,
    refundAmount: minorToBaht(committed.plan.refundMinor),
    refundMethod: committed.plan.refundMethod,
    idempotent: false,
  };
}

export const getSaleReturnContext = onCall(
  { region: FUNCTIONS_REGION, cors: DESKTOP_CALLABLE_CORS },
  async (request) => {
    try {
      return await performGetSaleReturnContext(
        db,
        (request.data ?? {}) as GetSaleReturnContextRequest,
        request.auth as AuthLike,
      );
    } catch {
      throw new HttpsError('internal', 'ระบบคืนสินค้าขัดข้อง กรุณาลองใหม่');
    }
  },
);

export const submitSaleReturn = onCall(
  { region: FUNCTIONS_REGION, cors: DESKTOP_CALLABLE_CORS },
  async (request) => {
    try {
      return await performSubmitSaleReturn(
        db,
        (request.data ?? {}) as SubmitSaleReturnRequest,
        request.auth as AuthLike,
      );
    } catch {
      throw new HttpsError('internal', 'ระบบคืนสินค้าขัดข้อง กรุณาลองใหม่');
    }
  },
);
