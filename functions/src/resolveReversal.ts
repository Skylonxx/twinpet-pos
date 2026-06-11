/**
 * resolveReversal — server-authoritative resolver for destructive, stock-affecting
 * REVERSAL requests.  [Phase 7B-3D-2 + Codex blocker-fix]
 *
 * Scope (this batch): two action types only —
 *   • `receiving_reversal`  — undo a completed Goods-Receiving (GRN) document.
 *   • `transfer_reversal`   — undo a branch-to-branch transfer in a reversible state.
 * Inventory-adjustment reversal, Returns and RTV are explicitly OUT of scope.
 *
 * This is the authoritative consistency boundary (Admin SDK). It is IDEMPOTENT:
 * every confirmed reversal records a `reversalIntents/{hash}` ledger entry + an
 * immutable `reversalDocuments/{serverReversalId}` audit doc — both keyed by a
 * DETERMINISTIC hash of the idempotency key — inside the SAME transaction that
 * mutates stock, so a retry can never double-apply nor overwrite an audit record.
 *
 * Authority (server is the ultimate authority — client evidence is never trusted):
 *   • Manager/Admin (verified custom claims) bypass PIN (CEO 3.2).
 *   • Staff must supply a raw `pin`, verified server-side via bcrypt against
 *     `users/{staffId}.pin` (the existing verifyPinLogin convention). The opaque
 *     `pinVerificationId`/`pinVerifiedAt` are stored as audit evidence ONLY.
 *   • The raw `pin` is transient — used only for verification, never persisted.
 *
 * Transfer reversible states are STRICTLY `sent` | `received` (CEO 3.4). The
 * current transfer schema only emits `completed`/`cancelled`, so `completed` is
 * REJECTED here (no schema-specific mapping was approved) — meaning transfer
 * reversal is dormant until the transfer lifecycle emits `sent`/`received`.
 *
 * FIFO reuses the single canonical server helper `./fifo` (no third FIFO source).
 */
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { onCall } from 'firebase-functions/v2/https';
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { planFifoCutFromState, mergeLotCuts, parseReceivedAtMs, type MutableLot, type LotCut } from './fifo';

const C = {
  users: 'users',
  products: 'products',
  productStocks: 'productStocks',
  stockLots: 'stockLots',
  stockMovements: 'stockMovements',
  receivings: 'receivings',
  receivingItems: 'receivingItems',
  inventoryTransfers: 'inventoryTransfers',
  transferItems: 'transferItems',
  reversalDocuments: 'reversalDocuments',
  reversalIntents: 'reversalIntents',
} as const;

/** Transfer states eligible for reversal (CEO 3.4) — strict, no `completed` mapping. */
const REVERSIBLE_TRANSFER_STATES: ReadonlySet<string> = new Set(['sent', 'received']);

type AuthLike = { uid?: string; token?: Record<string, unknown> } | null | undefined;

export type ReversalActionType = 'receiving_reversal' | 'transfer_reversal';

export type ReversalRejectCode =
  | 'unauthorized'
  | 'invalid_pin'
  | 'source_document_not_found'
  | 'source_document_not_reversible'
  | 'already_reversed'
  | 'stale_document'
  | 'stale_client_observation'
  | 'stock_conflict'
  | 'lot_conflict'
  | 'unsupported_action_type'
  | 'invalid_payload'
  | 'server_error';

export type ReversalStatus = 'confirmed' | 'duplicate_confirmed' | 'rejected' | 'conflict_requires_manual_review';

export type ResolveReversalRequest = {
  idempotencyKey?: string;
  actionType?: string;
  sourceDocumentId?: string;
  sourceDocumentType?: 'receiving' | 'transfer';
  branchId?: string;
  terminalId?: string;
  reasonCode?: string;
  reasonNote?: string;
  localIntentId?: string;
  /** Transient raw PIN for Staff server-side re-auth — verified, NEVER stored. */
  pin?: string;
  /** Opaque client evidence — stored for audit only, never trusted as authority. */
  pinVerificationId?: string;
  pinVerifiedAt?: string;
  clientCreatedAt?: string;
  /**
   * H4: the source document's `updatedAt` as the client observed it when it
   * captured this reversal intent. Compared against the live server `updatedAt`
   * by {@link isClientObservationStale}; a server value newer than this is proof
   * the client acted on a stale view and the request is rejected
   * (`stale_client_observation`). Optional — absent ⇒ no staleness can be proven.
   */
  clientObservedDocumentUpdatedAt?: string;
};

export type StockPatchEntry = {
  productId: string;
  locationId: string;
  lotId?: string;
  serverQuantity: number;
};

export type ResolveReversalResponse = {
  ok: boolean;
  idempotencyKey: string;
  serverReversalId?: string;
  status: ReversalStatus;
  rejectCode?: ReversalRejectCode;
  /**
   * Human-readable reason. Rejections are returned as structured data (this +
   * rejectCode + status + idempotencyKey) so the future offline queue can mark
   * the item for Manager manual reconciliation. Rejections are intentionally NOT
   * persisted server-side in this batch (no partial writes on reject; CEO 3.2 —
   * no auto-rollback). Only CONFIRMED reversals create durable audit records.
   */
  message?: string;
  authoritativeStockPatch?: StockPatchEntry[];
  confirmedAtServer?: string;
};

const SUPPORTED: ReadonlySet<string> = new Set<ReversalActionType>(['receiving_reversal', 'transfer_reversal']);

function reject(
  idempotencyKey: string,
  rejectCode: ReversalRejectCode,
  message: string,
  status: ReversalStatus = 'rejected',
): ResolveReversalResponse {
  return { ok: false, idempotencyKey, status, rejectCode, message };
}

function hasBranchAccess(auth: AuthLike, branchId: string): boolean {
  const token = auth?.token ?? {};
  if (token.role === 'admin') return true;
  const branchIds = token.branchIds;
  if (Array.isArray(branchIds)) return branchIds.includes('ALL') || branchIds.includes(branchId);
  return false;
}

/** Stable hash of the meaningful payload — defines "same request" for idempotency. */
function payloadHashOf(req: ResolveReversalRequest): string {
  const canonical = JSON.stringify([
    req.actionType ?? '',
    req.sourceDocumentType ?? '',
    req.sourceDocumentId ?? '',
    req.branchId ?? '',
    req.reasonCode ?? '',
    req.reasonNote ?? '',
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const intentIdOf = (idempotencyKey: string): string =>
  createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40);

/** DETERMINISTIC, collision-safe audit id (Blocker 6, Option A). */
const serverReversalIdOf = (idempotencyKey: string): string => `REV-${intentIdOf(idempotencyKey)}`;

const isoNow = (): string => new Date().toISOString();

/**
 * Normalize any timestamp shape the resolver may meet — ISO string (client
 * `clientObservedDocumentUpdatedAt`), epoch millis number, a Firestore
 * `Timestamp` (via `toMillis()`), or a plain `{ seconds, nanoseconds }` —
 * to epoch milliseconds. Returns `null` for anything uncomparable (absent,
 * malformed, or an unresolved server sentinel), so callers can SKIP rather
 * than guess.
 */
function toEpochMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'object') {
    const o = v as { toMillis?: () => number; seconds?: number; nanoseconds?: number; _seconds?: number };
    if (typeof o.toMillis === 'function') {
      const ms = o.toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof o.seconds === 'number') return o.seconds * 1000 + Math.floor((o.nanoseconds ?? 0) / 1e6);
    if (typeof o._seconds === 'number') return o._seconds * 1000;
  }
  return null;
}

/**
 * H4 stale-client guard. The client records the source document's observed
 * `updatedAt` (`clientObservedDocumentUpdatedAt`) at the instant it captured the
 * reversal intent. The server is the sole authority: if the LIVE document's
 * `updatedAt` has advanced PAST the client's observation, the client decided to
 * reverse against an outdated view of server state (a concurrent edit, a prior
 * reversal, or a manual-review resolution moved the document forward) and the
 * request must NOT be trusted.
 *
 * Deterministic and conservative:
 *   • No observation supplied        → NOT stale (absence is not proof; preserves
 *                                       legacy callers that never sent the field).
 *   • No comparable server `updatedAt`→ NOT stale (nothing authoritative to beat).
 *   • server.updatedAt  >  observed   → STALE (strict — equal instants are fresh,
 *                                       so a retry of the same observation is safe).
 * Pure read of an already-loaded document — performs zero I/O and zero mutation.
 */
function isClientObservationStale(req: ResolveReversalRequest, serverDoc: DocumentData): boolean {
  const observedMs = toEpochMs(req.clientObservedDocumentUpdatedAt);
  if (observedMs === null) return false;
  const serverMs = toEpochMs(serverDoc.updatedAt);
  if (serverMs === null) return false;
  return serverMs > observedMs;
}

/**
 * Server-authoritative actor check. Manager/Admin pass on verified claims; Staff
 * must pass a server-side bcrypt PIN verification against `users/{staffId}.pin`.
 * Client `pinVerificationId` is NEVER accepted as authority.
 */
async function checkActorAuthority(
  database: Firestore,
  tx: Transaction,
  auth: AuthLike,
  req: ResolveReversalRequest,
  branchId: string,
): Promise<{ rejectCode?: ReversalRejectCode; pinVerifiedAt: string | null }> {
  if (!hasBranchAccess(auth, branchId)) return { rejectCode: 'unauthorized', pinVerifiedAt: null };
  const role = auth?.token?.role;
  if (role === 'admin' || role === 'manager') return { pinVerifiedAt: null }; // CEO 3.2 — PIN bypass.
  if (role !== 'staff') return { rejectCode: 'unauthorized', pinVerifiedAt: null };

  // Staff: real server-side PIN re-auth (the ultimate authority).
  const staffId = (auth?.token?.staffId as string | undefined) ?? auth?.uid;
  const pin = String(req.pin ?? '').trim();
  if (!staffId || !pin) return { rejectCode: 'invalid_pin', pinVerifiedAt: null };
  const userSnap = await tx.get(database.collection(C.users).doc(staffId));
  const user = userSnap.exists ? (userSnap.data() as DocumentData) : null;
  if (!user || typeof user.pin !== 'string' || !user.pin) {
    return { rejectCode: 'invalid_pin', pinVerifiedAt: null };
  }
  const ok = await bcrypt.compare(pin, user.pin);
  if (!ok) return { rejectCode: 'invalid_pin', pinVerifiedAt: null };
  return { pinVerifiedAt: isoNow() };
}

/**
 * Core resolver — EXPORTED so it is unit-tested without the Functions runtime
 * (see resolveReversal.test.ts). Returns a structured {@link ResolveReversalResponse}
 * for every business outcome (never throws for rejection); only unexpected errors
 * surface to the onCall wrapper, which maps them to `server_error`.
 */
export async function performResolveReversal(
  database: Firestore,
  req: ResolveReversalRequest,
  auth: AuthLike,
): Promise<ResolveReversalResponse> {
  const idempotencyKey = String(req.idempotencyKey ?? '').trim();

  // ── Payload validation (pre-transaction) ──
  if (!idempotencyKey) return reject('', 'invalid_payload', 'ต้องระบุ idempotencyKey');
  if (!req.actionType || !SUPPORTED.has(req.actionType)) {
    return reject(idempotencyKey, 'unsupported_action_type', `ไม่รองรับ actionType: ${req.actionType}`);
  }
  const actionType = req.actionType as ReversalActionType;
  const sourceDocumentId = String(req.sourceDocumentId ?? '').trim();
  const sourceDocumentType = req.sourceDocumentType;
  const branchId = String(req.branchId ?? '').trim();
  const reasonCode = String(req.reasonCode ?? '').trim();
  if (!sourceDocumentId || !sourceDocumentType || !branchId || !reasonCode) {
    return reject(idempotencyKey, 'invalid_payload', 'payload ไม่ครบถ้วน');
  }
  const expectedType = actionType === 'receiving_reversal' ? 'receiving' : 'transfer';
  if (sourceDocumentType !== expectedType) {
    return reject(idempotencyKey, 'invalid_payload', 'sourceDocumentType ไม่ตรงกับ actionType');
  }
  if (!auth) return reject(idempotencyKey, 'unauthorized', 'ต้องเข้าสู่ระบบก่อน');

  const payloadHash = payloadHashOf(req);
  const serverReversalId = serverReversalIdOf(idempotencyKey);
  const actorUserId = (auth.token?.staffId as string | undefined) ?? auth.uid ?? null;

  return database.runTransaction(async (tx) => {
    // ── Idempotency ledger (read first) ──
    const intentRef = database.collection(C.reversalIntents).doc(intentIdOf(idempotencyKey));
    const intentSnap = await tx.get(intentRef);
    if (intentSnap.exists) {
      const intent = intentSnap.data() as DocumentData;
      if (intent.payloadHash === payloadHash) {
        return {
          ok: true,
          idempotencyKey,
          serverReversalId: intent.serverReversalId as string,
          status: 'duplicate_confirmed' as ReversalStatus,
          confirmedAtServer: (intent.confirmedAtServer as string) ?? undefined,
        };
      }
      // Same key + DIFFERENT payload → never mutate, never overwrite audit.
      return reject(
        idempotencyKey,
        'invalid_payload',
        'idempotencyKey ซ้ำแต่ payload ไม่ตรงกัน',
        'conflict_requires_manual_review',
      );
    }

    const ctx: Ctx = {
      idempotencyKey, payloadHash, serverReversalId, intentRef, sourceDocumentId, branchId,
      reasonCode, reasonNote: req.reasonNote, terminalId: req.terminalId, actorUserId, auth, req,
    };
    return actionType === 'receiving_reversal'
      ? resolveReceivingReversal(database, tx, ctx)
      : resolveTransferReversal(database, tx, ctx);
  });
}

type Ctx = {
  idempotencyKey: string;
  payloadHash: string;
  serverReversalId: string;
  intentRef: DocumentReference;
  sourceDocumentId: string;
  branchId: string;
  reasonCode: string;
  reasonNote?: string;
  terminalId?: string;
  actorUserId: string | null;
  auth: AuthLike;
  req: ResolveReversalRequest;
};

function writeIntentAndAudit(
  database: Firestore,
  tx: Transaction,
  ctx: Ctx,
  actionType: ReversalActionType,
  sourceDocumentType: 'receiving' | 'transfer',
  pinVerifiedAt: string | null,
  affectedItems: DocumentData[],
  sourceSnapshot: DocumentData,
): string {
  const confirmedAtServer = isoNow();
  // Idempotency ledger (deterministic id) — proves the reversal happened once.
  tx.set(ctx.intentRef, {
    idempotencyKey: ctx.idempotencyKey,
    payloadHash: ctx.payloadHash,
    serverReversalId: ctx.serverReversalId,
    status: 'confirmed',
    actionType,
    sourceDocumentId: ctx.sourceDocumentId,
    confirmedAtServer,
    createdAtServer: FieldValue.serverTimestamp(),
  });

  // Immutable audit doc at a DETERMINISTIC id (collision-safe — a retry hits the
  // duplicate guard above and never reaches this write).
  const auditRef = database.collection(C.reversalDocuments).doc(ctx.serverReversalId);
  tx.set(auditRef, {
    serverReversalId: ctx.serverReversalId,
    idempotencyKey: ctx.idempotencyKey,
    payloadHash: ctx.payloadHash,
    actionType,
    sourceDocumentId: ctx.sourceDocumentId,
    sourceDocumentType,
    branchId: ctx.branchId,
    terminalId: ctx.terminalId ?? null,
    actorUserId: ctx.actorUserId,
    // Audit evidence ONLY — never used as authority; raw PIN is never stored.
    pinVerifiedAtServer: pinVerifiedAt,
    pinVerificationId: ctx.req.pinVerificationId ?? null,
    pinVerifiedAtClient: ctx.req.pinVerifiedAt ?? null,
    reasonCode: ctx.reasonCode,
    reasonNote: ctx.reasonNote ?? null,
    status: 'confirmed',
    createdAtServer: FieldValue.serverTimestamp(),
    confirmedAtServer: FieldValue.serverTimestamp(),
    affectedItems,
    sourceDocumentSnapshot: sourceSnapshot,
  });
  return confirmedAtServer;
}

// ── Receiving reversal ──────────────────────────────────────────────────────
async function resolveReceivingReversal(
  database: Firestore,
  tx: Transaction,
  ctx: Ctx,
): Promise<ResolveReversalResponse> {
  const recRef = database.collection(C.receivings).doc(ctx.sourceDocumentId);
  const recSnap = await tx.get(recRef);
  if (!recSnap.exists) return reject(ctx.idempotencyKey, 'source_document_not_found', 'ไม่พบเอกสารรับเข้า');
  const receiving = recSnap.data() as DocumentData;
  const branchId = receiving.branchId as string;

  // Authority (branch access + server PIN re-auth for Staff).
  const authz = await checkActorAuthority(database, tx, ctx.auth, ctx.req, branchId);
  if (authz.rejectCode) return reject(ctx.idempotencyKey, authz.rejectCode, 'ไม่มีสิทธิ์/ยืนยัน PIN ไม่ผ่าน');

  // H4 stale-client guard — reject (mutation-free) if the client's observation of
  // this document is older than the live server state. Placed before every status
  // check and write so a stale view cannot drive any irreversible path.
  if (isClientObservationStale(ctx.req, receiving)) {
    return reject(ctx.idempotencyKey, 'stale_client_observation', 'ข้อมูลเอกสารฝั่งผู้ใช้เก่ากว่าสถานะปัจจุบันของเซิร์ฟเวอร์ — ปฏิเสธเพื่อความปลอดภัย');
  }

  if (receiving.status === 'cancelled' || receiving.reversedBy) {
    return reject(ctx.idempotencyKey, 'already_reversed', 'เอกสารนี้ถูกยกเลิก/รีเวิร์สแล้ว');
  }
  if (receiving.status !== 'completed') {
    return reject(ctx.idempotencyKey, 'source_document_not_reversible', 'สถานะเอกสารไม่สามารถรีเวิร์สได้');
  }

  // Read items.
  const itemsSnap = await tx.get(recRef.collection(C.receivingItems));
  const items: DocumentData[] = [];
  itemsSnap.forEach((d) => items.push(d.data()));
  if (items.length === 0) {
    return reject(ctx.idempotencyKey, 'source_document_not_reversible', 'ไม่พบรายการในเอกสารรับเข้า');
  }

  // Blocker 3: every item MUST carry a lot identity (lot-level stock required).
  for (const it of items) {
    if (!it.lotId || typeof it.lotId !== 'string') {
      return reject(ctx.idempotencyKey, 'invalid_payload', 'รายการรับเข้าไม่มี lotId — ไม่สามารถรีเวิร์สได้');
    }
  }

  // Received qty per product AND aggregate required deduction per lot (Blocker 4).
  const receivedByProduct = new Map<string, number>();
  const lotDeduct = new Map<string, number>();
  for (const it of items) {
    receivedByProduct.set(it.productId as string, (receivedByProduct.get(it.productId as string) ?? 0) + (it.qtyBase as number));
    lotDeduct.set(it.lotId as string, (lotDeduct.get(it.lotId as string) ?? 0) + (it.qtyBase as number));
  }

  // Read product stocks.
  const stockRefByProduct = new Map<string, DocumentReference>();
  const currentStockByProduct = new Map<string, number>();
  for (const pid of receivedByProduct.keys()) {
    const stockRef = database.collection(C.products).doc(pid).collection(C.productStocks).doc(branchId);
    stockRefByProduct.set(pid, stockRef);
    const s = await tx.get(stockRef);
    currentStockByProduct.set(pid, s.exists ? ((s.data()?.totalStockBase as number) ?? 0) : 0);
  }
  // Read lots (each referenced lot must exist — Blocker 3).
  const lotByid = new Map<string, { ref: DocumentReference; data: DocumentData }>();
  for (const lotId of lotDeduct.keys()) {
    const lotRef = database.collection(C.stockLots).doc(lotId);
    const ls = await tx.get(lotRef);
    if (!ls.exists) return reject(ctx.idempotencyKey, 'lot_conflict', `ไม่พบล็อต ${lotId} — ไม่สามารถรีเวิร์ส`);
    lotByid.set(lotId, { ref: lotRef, data: ls.data() as DocumentData });
  }

  // ── Guards (ALL before any write) ──
  // 3.3 partial-sold: current_stock >= received_quantity per product.
  for (const [pid, received] of receivedByProduct) {
    if ((currentStockByProduct.get(pid) ?? 0) < received) {
      return reject(ctx.idempotencyKey, 'stock_conflict', `สต็อกถูกขายไปบางส่วน ไม่สามารถรีเวิร์สรับเข้า (${pid})`);
    }
  }
  // Blocker 4: AGGREGATE per-lot guard — no lot may go negative.
  for (const [lotId, need] of lotDeduct) {
    const lot = lotByid.get(lotId)!;
    if (((lot.data.qtyRemaining as number) ?? 0) < need) {
      return reject(ctx.idempotencyKey, 'lot_conflict', `ล็อตถูกใช้ไปบางส่วน ไม่สามารถรีเวิร์ส (${lotId})`);
    }
  }

  // ── Writes ──
  const now = FieldValue.serverTimestamp();
  const affected: DocumentData[] = [];
  const patch: StockPatchEntry[] = [];

  for (const [lotId, qty] of lotDeduct) {
    const lot = lotByid.get(lotId)!;
    const before = (lot.data.qtyRemaining as number) ?? 0;
    const after = before - qty;
    tx.update(lot.ref, {
      qtyRemaining: FieldValue.increment(-qty),
      qtyReceived: Math.max(0, ((lot.data.qtyReceived as number) ?? 0) - qty),
      isDepleted: after <= 0,
      updatedAt: now,
    });
    patch.push({ productId: lot.data.productId as string, locationId: branchId, lotId, serverQuantity: after });
  }

  for (const [pid, received] of receivedByProduct) {
    const before = currentStockByProduct.get(pid) ?? 0;
    const after = before - received;
    tx.set(stockRefByProduct.get(pid)!, { branchId, totalStockBase: FieldValue.increment(-received), lastMovementAt: now, updatedAt: now }, { merge: true });
    patch.push({ productId: pid, locationId: branchId, serverQuantity: after });

    const moveRef = database.collection(C.stockMovements).doc();
    tx.set(moveRef, {
      id: moveRef.id, productId: pid, branchId, type: 'void', qty: received, costPerUnit: 0,
      refId: ctx.sourceDocumentId, refType: 'receiving', note: `รีเวิร์สรับเข้า: ${ctx.reasonCode}`,
      createdBy: ctx.actorUserId, createdAt: now,
    });
    affected.push({ productId: pid, locationId: branchId, quantityDelta: -received, beforeQuantity: before, afterQuantity: after });
  }

  tx.update(recRef, { status: 'cancelled', reversedBy: ctx.serverReversalId, reversedAt: now, reversalReasonCode: ctx.reasonCode, updatedAt: now });

  const confirmedAtServer = writeIntentAndAudit(
    database, tx, ctx, 'receiving_reversal', 'receiving', authz.pinVerifiedAt, affected,
    { id: ctx.sourceDocumentId, branchId, status: receiving.status },
  );

  return { ok: true, idempotencyKey: ctx.idempotencyKey, serverReversalId: ctx.serverReversalId, status: 'confirmed', authoritativeStockPatch: patch, confirmedAtServer };
}

// ── Transfer reversal ───────────────────────────────────────────────────────
async function resolveTransferReversal(
  database: Firestore,
  tx: Transaction,
  ctx: Ctx,
): Promise<ResolveReversalResponse> {
  const trRef = database.collection(C.inventoryTransfers).doc(ctx.sourceDocumentId);
  const trSnap = await tx.get(trRef);
  if (!trSnap.exists) return reject(ctx.idempotencyKey, 'source_document_not_found', 'ไม่พบเอกสารโอนย้าย');
  const transfer = trSnap.data() as DocumentData;
  const fromBranchId = transfer.fromBranchId as string;
  const toBranchId = transfer.toBranchId as string;

  // Origin-branch authority (+ Staff server PIN re-auth).
  const authz = await checkActorAuthority(database, tx, ctx.auth, ctx.req, fromBranchId);
  if (authz.rejectCode) return reject(ctx.idempotencyKey, authz.rejectCode, 'ไม่มีสิทธิ์/ยืนยัน PIN ไม่ผ่าน');

  // H4 stale-client guard — reject (mutation-free) if the client's observation of
  // this document is older than the live server state. Placed before every status
  // check and write so a stale view cannot drive any irreversible path.
  if (isClientObservationStale(ctx.req, transfer)) {
    return reject(ctx.idempotencyKey, 'stale_client_observation', 'ข้อมูลเอกสารฝั่งผู้ใช้เก่ากว่าสถานะปัจจุบันของเซิร์ฟเวอร์ — ปฏิเสธเพื่อความปลอดภัย');
  }

  if (transfer.status === 'cancelled' || transfer.reversedBy) {
    return reject(ctx.idempotencyKey, 'already_reversed', 'เอกสารโอนย้ายนี้ถูกยกเลิก/รีเวิร์สแล้ว');
  }
  // Blocker 1: STRICT state gate — only `sent`/`received` (CEO 3.4). `completed`
  // is rejected (no approved schema mapping).
  if (!REVERSIBLE_TRANSFER_STATES.has(transfer.status as string)) {
    return reject(ctx.idempotencyKey, 'source_document_not_reversible', `สถานะโอนย้าย "${transfer.status}" ไม่สามารถรีเวิร์สได้`);
  }

  const itemsSnap = await tx.get(trRef.collection(C.transferItems));
  const items: DocumentData[] = [];
  itemsSnap.forEach((d) => items.push(d.data()));
  if (items.length === 0) return reject(ctx.idempotencyKey, 'source_document_not_reversible', 'ไม่พบรายการในเอกสารโอนย้าย');

  const destQtyByProduct = new Map<string, number>();
  for (const it of items) {
    destQtyByProduct.set(it.productId as string, (destQtyByProduct.get(it.productId as string) ?? 0) + (it.transferQty as number));
  }

  // Read dest stock + dest active lots (FIFO) per product.
  const destStockRefByProduct = new Map<string, DocumentReference>();
  const destStockByProduct = new Map<string, number>();
  const destLotsByProduct = new Map<string, MutableLot[]>();
  for (const pid of destQtyByProduct.keys()) {
    const destStockRef = database.collection(C.products).doc(pid).collection(C.productStocks).doc(toBranchId);
    destStockRefByProduct.set(pid, destStockRef);
    const s = await tx.get(destStockRef);
    destStockByProduct.set(pid, s.exists ? ((s.data()?.totalStockBase as number) ?? 0) : 0);

    const lotsSnap = await tx.get(
      database.collection(C.stockLots).where('productId', '==', pid).where('branchId', '==', toBranchId).where('isDepleted', '==', false).orderBy('receivedAt', 'asc'),
    );
    const lots: MutableLot[] = [];
    lotsSnap.forEach((d) => {
      const lot = d.data();
      const qtyRemaining = (lot.qtyRemaining as number) ?? 0;
      if (qtyRemaining <= 0 || lot.isDepleted === true) return;
      lots.push({ ref: d.ref, id: d.id, qtyRemaining, costPerUnit: (lot.costPerUnit as number) ?? 0, receivedAtMs: parseReceivedAtMs(lot.receivedAt) });
    });
    lots.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    destLotsByProduct.set(pid, lots);
  }

  const initialLotQty = new Map<string, number>();
  for (const lots of destLotsByProduct.values()) for (const l of lots) initialLotQty.set(l.ref.path, l.qtyRemaining);

  // ── Plan ALL dest FIFO cuts in memory, THEN guard (no write before guards). ──
  const destCutsByProduct = new Map<string, LotCut[]>();
  let lotShortfall = false;
  for (const it of items) {
    const { cuts, remaining } = planFifoCutFromState(destLotsByProduct.get(it.productId as string)!, it.transferQty as number);
    const acc = destCutsByProduct.get(it.productId as string) ?? [];
    acc.push(...cuts);
    destCutsByProduct.set(it.productId as string, acc);
    if (remaining > 0) lotShortfall = true; // Blocker 5 — active lots cannot cover.
  }
  // Dest stock counter guard.
  for (const [pid, qty] of destQtyByProduct) {
    if ((destStockByProduct.get(pid) ?? 0) < qty) {
      return reject(ctx.idempotencyKey, 'stock_conflict', `สต็อกปลายทางไม่พอสำหรับรีเวิร์ส (${pid})`);
    }
  }
  // Blocker 5: counter may be sufficient while active lots are not.
  if (lotShortfall) {
    return reject(ctx.idempotencyKey, 'lot_conflict', 'ล็อตปลายทางไม่พอสำหรับการตัด FIFO');
  }

  // ── Writes ──
  const now = FieldValue.serverTimestamp();
  const affected: DocumentData[] = [];
  const patch: StockPatchEntry[] = [];

  for (const [pid, cuts] of destCutsByProduct) {
    for (const cut of mergeLotCuts(cuts)) {
      const initial = initialLotQty.get(cut.ref.path) ?? cut.cutQty;
      tx.update(cut.ref, { qtyRemaining: FieldValue.increment(-cut.cutQty), isDepleted: initial - cut.cutQty <= 0, updatedAt: now });
    }
    const before = destStockByProduct.get(pid) ?? 0;
    const qty = destQtyByProduct.get(pid) ?? 0;
    tx.set(destStockRefByProduct.get(pid)!, { branchId: toBranchId, totalStockBase: FieldValue.increment(-qty), lastMovementAt: now, updatedAt: now }, { merge: true });
    patch.push({ productId: pid, locationId: toBranchId, serverQuantity: before - qty });
  }

  // Source: recreate lots at EXACT original cost + original receivedAt (Phase 7B-1).
  const srcAddByProduct = new Map<string, number>();
  for (const it of items) {
    const productId = it.productId as string;
    const details = (it.sourceLotDetails as DocumentData[] | undefined) ?? [];
    if (details.length > 0) {
      for (const d of details) {
        const qty = (d.qty as number) ?? 0;
        if (qty <= 0) continue;
        const lotRef = database.collection(C.stockLots).doc();
        const receivedAt = typeof d.receivedAtMs === 'number' ? Timestamp.fromMillis(d.receivedAtMs as number) : now;
        tx.set(lotRef, {
          id: lotRef.id, productId, branchId: fromBranchId, receivingId: ctx.serverReversalId,
          costPerUnit: (d.costPerUnit as number) ?? 0, qtyReceived: qty, qtyRemaining: qty,
          receivedAt, expiryDate: null, isDepleted: false, isGhost: false, createdAt: now,
        });
        srcAddByProduct.set(productId, (srcAddByProduct.get(productId) ?? 0) + qty);
        affected.push({ productId, locationId: fromBranchId, quantityDelta: qty, unitCost: (d.costPerUnit as number) ?? 0, originalReceivedAt: typeof d.receivedAtMs === 'number' ? new Date(d.receivedAtMs as number).toISOString() : null });
      }
    } else {
      const qty = it.transferQty as number;
      const lotRef = database.collection(C.stockLots).doc();
      tx.set(lotRef, {
        id: lotRef.id, productId, branchId: fromBranchId, receivingId: ctx.serverReversalId,
        costPerUnit: (it.unitCost as number) ?? 0, qtyReceived: qty, qtyRemaining: qty,
        receivedAt: now, expiryDate: null, isDepleted: false, isGhost: false, createdAt: now,
      });
      srcAddByProduct.set(productId, (srcAddByProduct.get(productId) ?? 0) + qty);
      affected.push({ productId, locationId: fromBranchId, quantityDelta: qty, unitCost: (it.unitCost as number) ?? 0 });
    }
  }
  for (const [pid, add] of srcAddByProduct) {
    const srcStockRef = database.collection(C.products).doc(pid).collection(C.productStocks).doc(fromBranchId);
    tx.set(srcStockRef, { branchId: fromBranchId, totalStockBase: FieldValue.increment(add), lastMovementAt: now, updatedAt: now }, { merge: true });
    patch.push({ productId: pid, locationId: fromBranchId, serverQuantity: add });
  }

  for (const it of items) {
    const back = database.collection(C.stockMovements).doc();
    tx.set(back, { id: back.id, productId: it.productId, branchId: fromBranchId, type: 'transfer_in', qty: it.transferQty, costPerUnit: it.unitCost ?? 0, refId: ctx.sourceDocumentId, refType: 'inventoryTransfer', note: `รีเวิร์สโอนย้าย: ${ctx.reasonCode}`, createdBy: ctx.actorUserId, createdAt: now });
    const out = database.collection(C.stockMovements).doc();
    tx.set(out, { id: out.id, productId: it.productId, branchId: toBranchId, type: 'transfer_out', qty: -(it.transferQty as number), costPerUnit: it.unitCost ?? 0, refId: ctx.sourceDocumentId, refType: 'inventoryTransfer', note: `รีเวิร์สโอนย้าย: ${ctx.reasonCode}`, createdBy: ctx.actorUserId, createdAt: now });
  }

  tx.update(trRef, { status: 'cancelled', reversedBy: ctx.serverReversalId, reversedAt: now, reversalReasonCode: ctx.reasonCode, updatedAt: now });

  const confirmedAtServer = writeIntentAndAudit(
    database, tx, ctx, 'transfer_reversal', 'transfer', authz.pinVerifiedAt, affected,
    { id: ctx.sourceDocumentId, fromBranchId, toBranchId, status: transfer.status },
  );

  return { ok: true, idempotencyKey: ctx.idempotencyKey, serverReversalId: ctx.serverReversalId, status: 'confirmed', authoritativeStockPatch: patch, confirmedAtServer };
}

export const resolveReversal = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    try {
      return await performResolveReversal(db, (request.data ?? {}) as ResolveReversalRequest, request.auth as AuthLike);
    } catch (err) {
      console.error('[resolveReversal] unexpected error', err);
      const key = String((request.data as ResolveReversalRequest | undefined)?.idempotencyKey ?? '');
      return reject(key, 'server_error', 'เกิดข้อผิดพลาดภายในระบบ');
    }
  },
);
