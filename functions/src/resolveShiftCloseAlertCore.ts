/**
 * resolveShiftCloseAlertCore — P5-E pure decision core. [P1 offline-sync
 * Packet 5 / P5-E]
 *
 * Server-authoritative manager/admin ADJUDICATION of an existing shift-close
 * alert: `open -> acknowledged` and `open|acknowledged -> resolved`, with a
 * `manual_review_required -> manually_resolved` settlement follow-through.
 * Pure, deterministic: no Admin SDK, no Firestore, no network, no clock
 * reads (every "now" is an explicit parameter) — the same P5-B/P5-D
 * discipline (`shiftCloseValidationWorkerCore.ts`'s header). `node:crypto`
 * via the shared `sha256Hex` (P5-B, read-only reuse) is the one synchronous
 * primitive used, exactly the P5-B/P5-D precedent.
 *
 * This module NEVER accepts client-supplied deltas as authority: the alert's
 * own `reasonCode` and prior `acknowledgedByActor` are always PRESERVED from
 * the live alert doc (frozen P5-B projection invariants,
 * `shiftCloseValidationState.ts` `isValidAlertProjection`); the request's
 * `reasonCode`/`reasonNote` are the manager's adjudication justification —
 * they are recorded on the immutable audit event only, never written onto
 * the alert projection itself.
 *
 * Gemini authorization `TWINPET-P1-OFFLINE-SYNC-PACKET-5-P5-E-IMPLEMENTATION-
 * AUTHORIZATION-GEMINI-DECISION-001` (`AUTHORIZE OPTION A`):
 *   - D5 = Option C — the request MAY carry a transient `pin`; it is never
 *     verified or persisted in this packet (reserved for a future UI/
 *     security step-up gate without a contract break).
 *   - Worker lease = Option 1 — a live (non-expired) P5-D worker lease
 *     refuses the callable with zero writes (`isLeaseLive`, evaluated by the
 *     I/O shell against the case doc's `leaseOwner`/`leaseExpiry`).
 */

import {
  type AlertActor,
  type AlertReasonCode,
  type AlertState,
  type SettlementState,
  isValidAlertReasonCode,
} from './shiftCloseValidationTypes';
import { type AlertProjectionDelta, computeManagerResolution, isValidAlertProjection } from './shiftCloseValidationState';
import { sha256Hex } from './shiftCloseValidationHash';

export type AdjudicationOutcome = 'acknowledge' | 'resolve';

export type AdjudicationRejectCode =
  | 'unauthorized'
  | 'invalid_pin'
  | 'invalid_payload'
  | 'case_not_found'
  | 'alert_not_open'
  | 'stale_case_version'
  | 'invalid_outcome_transition'
  | 'server_error';

export type AdjudicationStatus = 'confirmed' | 'duplicate_confirmed' | 'rejected' | 'conflict_requires_manual_review';

export interface ResolveShiftCloseAlertRequest {
  commandId?: string;
  shiftId?: string;
  branchId?: string;
  expectedCaseVersion?: number;
  requestedOutcome?: string;
  reasonCode?: string;
  reasonNote?: string;
  /** D5 Option C: optional transient re-auth evidence. Never verified/persisted this packet. */
  pin?: string;
}

export const MAX_REASON_NOTE_LENGTH = 1000;

export interface ValidatedAdjudicationRequest {
  commandId: string;
  shiftId: string;
  branchId: string;
  expectedCaseVersion: number;
  requestedOutcome: AdjudicationOutcome;
  reasonCode: AlertReasonCode;
  reasonNote: string | null;
}

export type PayloadValidationResult = { ok: true; value: ValidatedAdjudicationRequest } | { ok: false };

/** Pure structural validation only — never touches auth or live case/alert state. */
export function validateAdjudicationPayload(req: ResolveShiftCloseAlertRequest): PayloadValidationResult {
  const commandId = String(req.commandId ?? '').trim();
  const shiftId = String(req.shiftId ?? '').trim();
  const branchId = String(req.branchId ?? '').trim();
  const expectedCaseVersion = req.expectedCaseVersion;
  const requestedOutcome = req.requestedOutcome;
  const reasonCode = req.reasonCode;
  const reasonNote = req.reasonNote;

  if (!commandId || !shiftId || !branchId) return { ok: false };
  if (typeof expectedCaseVersion !== 'number' || !Number.isInteger(expectedCaseVersion) || expectedCaseVersion < 0) {
    return { ok: false };
  }
  if (requestedOutcome !== 'acknowledge' && requestedOutcome !== 'resolve') return { ok: false };
  if (!isValidAlertReasonCode(reasonCode)) return { ok: false };
  if (reasonNote !== undefined && (typeof reasonNote !== 'string' || reasonNote.length > MAX_REASON_NOTE_LENGTH)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      commandId,
      shiftId,
      branchId,
      expectedCaseVersion,
      requestedOutcome,
      reasonCode,
      reasonNote: reasonNote ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Auth / branch access — mirrors resolveReversal.ts's hasBranchAccess exactly
// (frozen convention: admin bypass, else branchIds includes 'ALL'/branchId).
// Adjudication is manager/admin-only (no staff PIN path — D5 Option C keeps
// the `pin` field reserved/unverified rather than a staff bypass gate).
// ---------------------------------------------------------------------------

export type AuthTokenLike = { uid?: string; token?: Record<string, unknown> } | null | undefined;

export function hasBranchAccess(auth: AuthTokenLike, branchId: string): boolean {
  const token = auth?.token ?? {};
  if (token.role === 'admin') return true;
  const branchIds = token.branchIds;
  if (Array.isArray(branchIds)) return branchIds.includes('ALL') || branchIds.includes(branchId);
  return false;
}

export interface AuthorityResult {
  rejectCode?: 'unauthorized';
  managerUid: string | null;
}

export function checkAdjudicationAuthority(auth: AuthTokenLike, branchId: string): AuthorityResult {
  if (!hasBranchAccess(auth, branchId)) return { rejectCode: 'unauthorized', managerUid: null };
  const role = auth?.token?.role;
  if (role !== 'admin' && role !== 'manager') return { rejectCode: 'unauthorized', managerUid: null };
  const managerUid = (auth?.token?.staffId as string | undefined) ?? auth?.uid ?? null;
  if (!managerUid) return { rejectCode: 'unauthorized', managerUid: null };
  return { managerUid };
}

// ---------------------------------------------------------------------------
// Worker-lease guard (Gemini Lease Option 1 — refuse on live lease).
// ---------------------------------------------------------------------------

export interface LeaseSnapshot {
  leaseOwner: string | null;
  leaseExpiryMillis: number | null;
}

/** True iff the P5-D-1 worker currently holds a non-expired lease on this case. */
export function isLeaseLive(lease: LeaseSnapshot, nowMillis: number): boolean {
  return lease.leaseOwner !== null && lease.leaseExpiryMillis !== null && lease.leaseExpiryMillis > nowMillis;
}

// ---------------------------------------------------------------------------
// Outcome / transition decision — reuses the frozen P5-B alert-projection
// builder (`computeManagerResolution`) for `resolve`; `acknowledge` is built
// locally against the SAME frozen per-state invariant table
// (`isValidAlertProjection`'s `acknowledged` case), then defensively
// re-validated before being returned so an impossible projection can never
// reach the caller.
// ---------------------------------------------------------------------------

export interface AdjudicationCaseView {
  alertState: AlertState;
  settlementState: SettlementState;
}

export interface AdjudicationAlertView {
  alertState: AlertState;
  reasonCode: AlertReasonCode | null;
  acknowledgedByActor: AlertActor | null;
}

export type TransitionDecision =
  | { kind: 'rejected'; rejectCode: 'alert_not_open' | 'invalid_outcome_transition' }
  | { kind: 'transition'; alertProjection: AlertProjectionDelta; newSettlementState: SettlementState };

export function decideAdjudicationTransition(params: {
  caseView: AdjudicationCaseView;
  alertView: AdjudicationAlertView;
  requestedOutcome: AdjudicationOutcome;
  managerUid: string;
}): TransitionDecision {
  const { caseView, alertView, requestedOutcome, managerUid } = params;

  // Case/alert projection must agree before adjudication proceeds (mirrors
  // the P5-D worker's own `validateAlertInvariants` state-agreement check) —
  // a disagreement fails closed rather than adjudicating a possibly-stale view.
  if (caseView.alertState !== alertView.alertState) {
    return { kind: 'rejected', rejectCode: 'invalid_outcome_transition' };
  }
  if (caseView.alertState === 'none') return { kind: 'rejected', rejectCode: 'alert_not_open' };
  if (alertView.reasonCode === null) return { kind: 'rejected', rejectCode: 'invalid_outcome_transition' };

  if (requestedOutcome === 'acknowledge') {
    if (caseView.alertState !== 'open') return { kind: 'rejected', rejectCode: 'invalid_outcome_transition' };
    const alertProjection: AlertProjectionDelta = {
      alertState: 'acknowledged',
      reasonCode: alertView.reasonCode,
      acknowledgedByActor: { kind: 'manager', managerUid },
      resolvedByActor: null,
    };
    if (!isValidAlertProjection(alertProjection)) return { kind: 'rejected', rejectCode: 'invalid_outcome_transition' };
    return { kind: 'transition', alertProjection, newSettlementState: caseView.settlementState };
  }

  // requestedOutcome === 'resolve'
  if (caseView.alertState !== 'open' && caseView.alertState !== 'acknowledged') {
    return { kind: 'rejected', rejectCode: 'invalid_outcome_transition' };
  }
  const alertProjection = computeManagerResolution(managerUid, alertView.reasonCode, alertView.acknowledgedByActor);
  if (!isValidAlertProjection(alertProjection)) return { kind: 'rejected', rejectCode: 'invalid_outcome_transition' };
  const newSettlementState: SettlementState =
    caseView.settlementState === 'manual_review_required' ? 'manually_resolved' : caseView.settlementState;
  return { kind: 'transition', alertProjection, newSettlementState };
}

// ---------------------------------------------------------------------------
// Idempotency payload hash — "same request" definition (mirrors
// resolveReversal.ts's payloadHashOf; excludes commandId/pin themselves).
// ---------------------------------------------------------------------------

export function adjudicationPayloadCanonical(req: ValidatedAdjudicationRequest): string {
  return JSON.stringify([req.shiftId, req.branchId, req.requestedOutcome, req.reasonCode, req.reasonNote ?? '']);
}

export function adjudicationPayloadHash(req: ValidatedAdjudicationRequest): string {
  return sha256Hex(adjudicationPayloadCanonical(req));
}

/** Deterministic command-ledger doc id (mirrors resolveReversal.ts's intentIdOf). */
export function commandLedgerId(commandId: string): string {
  return sha256Hex(commandId).slice(0, 40);
}

export function buildManagerActor(managerUid: string): AlertActor {
  return { kind: 'manager', managerUid };
}
