/**
 * Pure view helpers for the Shift Close Alert Detail page (UI-B core,
 * route-only, read-only). NO Firebase imports → node-unit-testable (see
 * shiftCloseDetailProjection.test.ts). The alert projection is reused
 * verbatim from `shiftCloseReviewRows.mapShiftCloseReviewRow` (UI-A, frozen
 * P5-A/P5-C schema). This module ADDS the `shiftCloseCases` projection,
 * deliberately allowlisted — sensitive fields (actualCashCount, variance,
 * cash drawer/expected-payment figures, evidence figures, validation run
 * details/IDs, free-text manager note, raw leaseOwner/leaseExpiry) are never
 * read here (UI-B2 territory, out of scope for this packet) — plus the
 * cross-source integrity-caution computation (stored-ID mismatch,
 * caseVersion drift, malformed enums, alert/case pairing gaps).
 */

export type { ShiftCloseReviewRow } from './shiftCloseReviewRows';
export { mapShiftCloseReviewRow } from './shiftCloseReviewRows';
import type { ShiftCloseReviewRow } from './shiftCloseReviewRows';

// ---------------------------------------------------------------------------
// shiftCloseCases projection (allowlist only — mirrors
// functions/src/shiftCloseValidationTypes.ts ProcessingState/SettlementState).
// ---------------------------------------------------------------------------

export type ProcessingState =
  | 'queued'
  | 'awaiting_dependencies'
  | 'validating'
  | 'validated'
  | 'retryable_error'
  | 'permanently_unverifiable'
  | 'requires_operator_review';

export const PROCESSING_STATES: readonly ProcessingState[] = [
  'queued',
  'awaiting_dependencies',
  'validating',
  'validated',
  'retryable_error',
  'permanently_unverifiable',
  'requires_operator_review',
];

export const PROCESSING_STATE_LABELS: Record<ProcessingState, string> = {
  queued: 'อยู่ในคิว',
  awaiting_dependencies: 'รอข้อมูลที่เกี่ยวข้อง',
  validating: 'กำลังตรวจสอบ',
  validated: 'ตรวจสอบแล้ว',
  retryable_error: 'เกิดข้อผิดพลาด (ระบบจะลองใหม่)',
  permanently_unverifiable: 'ไม่สามารถตรวจสอบได้ (ถาวร) — ต้องดำเนินการโดยผู้จัดการ',
  requires_operator_review: 'ต้องการการตรวจสอบจากผู้จัดการ',
};

export type SettlementState = 'unsettled' | 'provisional_match' | 'manual_review_required' | 'manually_resolved';

export const SETTLEMENT_STATES: readonly SettlementState[] = [
  'unsettled',
  'provisional_match',
  'manual_review_required',
  'manually_resolved',
];

export const SETTLEMENT_STATE_LABELS: Record<SettlementState, string> = {
  unsettled: 'ยังไม่ยืนยันยอด',
  provisional_match: 'ยอดตรงกันชั่วคราว (ยังไม่ยืนยันสุดท้าย)',
  manual_review_required: 'ต้องตรวจสอบโดยผู้จัดการ',
  manually_resolved: 'แก้ไขโดยผู้จัดการแล้ว',
};

export const UNKNOWN_PROCESSING_STATE_LABEL = 'สถานะการประมวลผลไม่ทราบ (ข้อมูลผิดปกติ)';
export const UNKNOWN_SETTLEMENT_STATE_LABEL = 'สถานะการยืนยันยอดไม่ทราบ (ข้อมูลผิดปกติ)';
/** Sentinel for a doc whose raw `processingState`/`settlementState` is not one of the frozen values. */
export const UNKNOWN_CASE_ENUM = 'unknown' as const;

export type ShiftCloseCaseProjection = {
  id: string;
  processingState: ProcessingState | typeof UNKNOWN_CASE_ENUM;
  processingStateLabel: string;
  processingStateUnknown: boolean;
  settlementState: SettlementState | typeof UNKNOWN_CASE_ENUM;
  settlementStateLabel: string;
  settlementStateUnknown: boolean;
  updatedAtMs: number | null;
  /** Presence-only — the real run ID is never exposed to this UI packet. */
  hasSelectedRun: boolean;
  /** Internal/provenance only — never a primary triage signal (see page's muted diagnostic footer). */
  caseVersion: number | null;
  /** True when the stored `shiftId` field is present and differs from the doc ID. */
  storedIdMismatch: boolean;
};

function isValidProcessingState(value: unknown): value is ProcessingState {
  return typeof value === 'string' && (PROCESSING_STATES as readonly string[]).includes(value);
}

function isValidSettlementState(value: unknown): value is SettlementState {
  return typeof value === 'string' && (SETTLEMENT_STATES as readonly string[]).includes(value);
}

function tsToMs(v: unknown): number | null {
  if (v && typeof v === 'object' && 'toMillis' in (v as Record<string, unknown>)) {
    try {
      const ms = (v as { toMillis: () => number }).toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/**
 * Map one raw `shiftCloseCases/{shiftId}` doc to a safe view row. Reads ONLY
 * the allowlisted fields — never actualCashCount/variance/cash-drawer/
 * expected-payment/evidence/validation-run/note/raw-lease fields.
 */
export function mapShiftCloseCaseProjection(id: string, data: Record<string, unknown>): ShiftCloseCaseProjection {
  const processingState = isValidProcessingState(data.processingState) ? data.processingState : UNKNOWN_CASE_ENUM;
  const processingStateLabel =
    processingState === UNKNOWN_CASE_ENUM ? UNKNOWN_PROCESSING_STATE_LABEL : PROCESSING_STATE_LABELS[processingState];

  const settlementState = isValidSettlementState(data.settlementState) ? data.settlementState : UNKNOWN_CASE_ENUM;
  const settlementStateLabel =
    settlementState === UNKNOWN_CASE_ENUM ? UNKNOWN_SETTLEMENT_STATE_LABEL : SETTLEMENT_STATE_LABELS[settlementState];

  const storedShiftId = data.shiftId;
  const storedIdMismatch = typeof storedShiftId === 'string' && storedShiftId !== '' && storedShiftId !== id;

  const rawSelectedRunId = data.selectedRunId;
  const hasSelectedRun =
    rawSelectedRunId !== null && rawSelectedRunId !== undefined && rawSelectedRunId !== '';

  return {
    id,
    processingState,
    processingStateLabel,
    processingStateUnknown: processingState === UNKNOWN_CASE_ENUM,
    settlementState,
    settlementStateLabel,
    settlementStateUnknown: settlementState === UNKNOWN_CASE_ENUM,
    updatedAtMs: tsToMs(data.updatedAt),
    hasSelectedRun,
    caseVersion: typeof data.caseVersion === 'number' && Number.isFinite(data.caseVersion) ? data.caseVersion : null,
    storedIdMismatch,
  };
}

// ---------------------------------------------------------------------------
// Cross-source integrity-caution computation (pure — no Firebase, no React).
// ---------------------------------------------------------------------------

export type IntegrityCaution =
  | 'alert_stored_id_mismatch'
  | 'case_stored_id_mismatch'
  | 'case_version_drift'
  | 'alert_state_unknown'
  | 'alert_reason_unknown'
  | 'processing_state_unknown'
  | 'settlement_state_unknown'
  | 'case_missing_for_alert'
  | 'alert_missing_for_case';

export type ComputeIntegrityCautionsInput = {
  alert: ShiftCloseReviewRow | null;
  /** True only when the alert source is server-confirmed (ready, not fromCache) to have zero docs. */
  alertConfirmedEmpty: boolean;
  kase: ShiftCloseCaseProjection | null;
  /** True only when the case source is server-confirmed (ready, not fromCache) to have zero docs. */
  caseConfirmedEmpty: boolean;
};

/**
 * Deterministic, order-stable list of integrity cautions. Never throws.
 * `alert`/`kase` being non-null always takes precedence over "confirmed
 * empty" for the SAME source (a snapshot cannot be both).
 */
export function computeIntegrityCautions(input: ComputeIntegrityCautionsInput): IntegrityCaution[] {
  const { alert, alertConfirmedEmpty, kase, caseConfirmedEmpty } = input;
  const cautions: IntegrityCaution[] = [];

  if (alert && alert.shiftId !== alert.id) cautions.push('alert_stored_id_mismatch');
  if (kase && kase.storedIdMismatch) cautions.push('case_stored_id_mismatch');

  if (
    alert &&
    kase &&
    alert.caseVersion !== null &&
    kase.caseVersion !== null &&
    alert.caseVersion !== kase.caseVersion
  ) {
    cautions.push('case_version_drift');
  }

  if (alert && alert.alertState === 'unknown') cautions.push('alert_state_unknown');
  if (alert && alert.reasonUnknown) cautions.push('alert_reason_unknown');
  if (kase && kase.processingStateUnknown) cautions.push('processing_state_unknown');
  if (kase && kase.settlementStateUnknown) cautions.push('settlement_state_unknown');

  if (alert && caseConfirmedEmpty && !kase) cautions.push('case_missing_for_alert');
  if (kase && alertConfirmedEmpty && !alert) cautions.push('alert_missing_for_case');

  return cautions;
}
