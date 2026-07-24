/**
 * resolveShiftCloseAlertAdapter — client-side, non-throwing adapter for the
 * deployed `resolveShiftCloseAlert` callable (functions/src/resolveShiftCloseAlert.ts).
 * Packet 5 / Client-UI-C.
 *
 * Transport wiring mirrors the existing lazy/cached precedent in
 * `src/lib/pos/offline/syncOfflineReversals.ts`'s `getDefaultCallResolveReversal`
 * (same region/emulator handling as `retryReconcile.ts`). Tests inject a
 * transport and never touch the real Firebase SDK.
 *
 * This module NEVER throws to its caller. Every outcome — a rejected callable
 * promise, a structurally malformed response, or a validated response — is
 * returned as a discriminated `ResolveShiftCloseAlertAdapterResult`. Runtime
 * validation is exhaustive: every field of the response is checked against the
 * frozen 4-value status / 8-value reject-code / optional-field contract before
 * being trusted. The Thai `message` field (if present) is never inspected for
 * control flow and is never surfaced by this module.
 */

import type { AlertReasonCode, AlertState } from './shiftCloseReviewRows';
import type { SettlementState } from './shiftCloseDetailProjection';

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

const ADJUDICATION_REJECT_CODES: readonly AdjudicationRejectCode[] = [
  'unauthorized',
  'invalid_pin',
  'invalid_payload',
  'case_not_found',
  'alert_not_open',
  'stale_case_version',
  'invalid_outcome_transition',
  'server_error',
];

export type AdjudicationStatus = 'confirmed' | 'duplicate_confirmed' | 'rejected' | 'conflict_requires_manual_review';

const ADJUDICATION_STATUSES: readonly AdjudicationStatus[] = [
  'confirmed',
  'duplicate_confirmed',
  'rejected',
  'conflict_requires_manual_review',
];

const ALERT_STATE_VALUES: readonly AlertState[] = ['none', 'open', 'acknowledged', 'resolved'];
const SETTLEMENT_STATE_VALUES: readonly SettlementState[] = [
  'unsettled',
  'provisional_match',
  'manual_review_required',
  'manually_resolved',
];

/** Mirrors resolveShiftCloseAlertCore.ts's ResolveShiftCloseAlertRequest (validated client side). */
export interface ResolveShiftCloseAlertAdapterRequest {
  commandId: string;
  shiftId: string;
  branchId: string;
  expectedCaseVersion: number;
  requestedOutcome: AdjudicationOutcome;
  reasonCode: AlertReasonCode;
  /**
   * Trimmed, non-empty string, or OMITTED entirely (never present as `null` —
   * the deployed `ResolveShiftCloseAlertRequest.reasonNote?: string` rejects
   * any present non-string, including `null`, as `invalid_payload`; see the
   * machine's `normalizeReasonNote`/`submitAdjudication`).
   */
  reasonNote?: string;
}

/** Mirrors resolveShiftCloseAlert.ts's ResolveShiftCloseAlertResponse, runtime-validated. */
export interface ValidatedResolveShiftCloseAlertResponse {
  ok: boolean;
  commandId: string;
  shiftId: string;
  status: AdjudicationStatus;
  rejectCode?: AdjudicationRejectCode;
  newAlertState?: AlertState;
  newSettlementState?: SettlementState;
  auditEventId?: string;
  confirmedAtServer?: string;
}

export type ResolveShiftCloseAlertAdapterResult =
  | { kind: 'response'; response: ValidatedResolveShiftCloseAlertResponse; raw: unknown }
  | { kind: 'transport_failure'; code?: string; cause: unknown }
  | { kind: 'malformed_response'; raw: unknown };

/** Injectable network transport — the production implementation calls the Firebase callable. */
export type ResolveShiftCloseAlertTransport = (req: ResolveShiftCloseAlertAdapterRequest) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Default Firebase callable transport (lazy import — never pulls Firebase
// into a unit test that injects its own transport).
// ---------------------------------------------------------------------------

let cachedTransport: ResolveShiftCloseAlertTransport | null = null;

export async function getDefaultResolveShiftCloseAlertTransport(): Promise<ResolveShiftCloseAlertTransport> {
  if (cachedTransport) return cachedTransport;
  const [{ getFunctions, httpsCallable, connectFunctionsEmulator }, { app, USE_EMULATOR }] = await Promise.all([
    import('firebase/functions'),
    import('../../firebase'),
  ]);
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR) {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  const callable = httpsCallable<ResolveShiftCloseAlertAdapterRequest, unknown>(functions, 'resolveShiftCloseAlert');
  cachedTransport = async (req) => (await callable(req)).data;
  return cachedTransport;
}

// ---------------------------------------------------------------------------
// Runtime response validation — exhaustive, never trusts the server's shape.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRejectCode(value: unknown): value is AdjudicationRejectCode {
  return typeof value === 'string' && (ADJUDICATION_REJECT_CODES as readonly string[]).includes(value);
}

function isValidStatus(value: unknown): value is AdjudicationStatus {
  return typeof value === 'string' && (ADJUDICATION_STATUSES as readonly string[]).includes(value);
}

function isValidAlertState(value: unknown): value is AlertState {
  return typeof value === 'string' && (ALERT_STATE_VALUES as readonly string[]).includes(value);
}

function isValidSettlementState(value: unknown): value is SettlementState {
  return typeof value === 'string' && (SETTLEMENT_STATE_VALUES as readonly string[]).includes(value);
}

/**
 * Validates one raw callable response against the frozen result matrix. Never
 * throws. Returns `null` for anything outside the exhaustive set of accepted
 * shapes (§5 of the frozen contract) — the caller maps `null` to
 * `malformed_response`.
 */
function validateResponse(raw: unknown, req: ResolveShiftCloseAlertAdapterRequest): ValidatedResolveShiftCloseAlertResponse | null {
  if (!isPlainObject(raw)) return null;

  const { ok, commandId, shiftId, status, rejectCode, newAlertState, newSettlementState, auditEventId, confirmedAtServer } = raw;

  if (typeof ok !== 'boolean') return null;
  if (typeof commandId !== 'string' || commandId !== req.commandId) return null;
  if (typeof shiftId !== 'string' || shiftId !== req.shiftId) return null;
  if (!isValidStatus(status)) return null;

  if (rejectCode !== undefined && !isValidRejectCode(rejectCode)) return null;
  if (newAlertState !== undefined && !isValidAlertState(newAlertState)) return null;
  if (newSettlementState !== undefined && !isValidSettlementState(newSettlementState)) return null;
  if (auditEventId !== undefined && typeof auditEventId !== 'string') return null;
  if (confirmedAtServer !== undefined && typeof confirmedAtServer !== 'string') return null;

  // Exhaustive ok/status/rejectCode combination check — anything not in this
  // set is malformed, never coerced into a "close enough" success/failure.
  if (ok === true) {
    if ((status === 'confirmed' || status === 'duplicate_confirmed') && rejectCode === undefined) {
      // valid success
    } else {
      return null;
    }
  } else {
    // `stale_case_version` is frozen as valid ONLY paired with
    // `conflict_requires_manual_review` below — a `rejected` status carrying
    // it is an unsupported server shape, never terminal business truth.
    if (status === 'rejected' && rejectCode !== undefined && rejectCode !== 'stale_case_version') {
      // valid rejection (the 7 allowed rejected-status codes)
    } else if (status === 'conflict_requires_manual_review' && (rejectCode === 'stale_case_version' || rejectCode === 'invalid_payload')) {
      // valid conflict
    } else {
      return null;
    }
  }

  const response: ValidatedResolveShiftCloseAlertResponse = { ok, commandId, shiftId, status };
  if (rejectCode !== undefined) response.rejectCode = rejectCode;
  if (newAlertState !== undefined) response.newAlertState = newAlertState;
  if (newSettlementState !== undefined) response.newSettlementState = newSettlementState;
  if (auditEventId !== undefined) response.auditEventId = auditEventId;
  if (confirmedAtServer !== undefined) response.confirmedAtServer = confirmedAtServer;
  return response;
}

/**
 * Invoke `resolveShiftCloseAlert`. Never throws — a rejected transport
 * promise becomes `transport_failure`; a structurally invalid response
 * becomes `malformed_response`. `raw`/`cause` are diagnostic-only: callers
 * must never render or persist them (see `ShiftCloseAdjudicationPanel.tsx`).
 */
export async function callResolveShiftCloseAlert(
  req: ResolveShiftCloseAlertAdapterRequest,
  transport?: ResolveShiftCloseAlertTransport,
): Promise<ResolveShiftCloseAlertAdapterResult> {
  let raw: unknown;
  try {
    const call = transport ?? (await getDefaultResolveShiftCloseAlertTransport());
    raw = await call(req);
  } catch (error) {
    const code =
      isPlainObject(error) && typeof error.code === 'string' ? (error.code as string) : undefined;
    return { kind: 'transport_failure', code, cause: error };
  }

  const validated = validateResponse(raw, req);
  if (!validated) return { kind: 'malformed_response', raw };
  return { kind: 'response', response: validated, raw };
}
