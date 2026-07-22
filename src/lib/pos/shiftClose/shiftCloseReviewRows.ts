/**
 * Pure view helpers for the Shift Close Review page (UI-A, route-only,
 * read-only). NO Firebase imports → node-unit-testable (see
 * shiftCloseReviewRows.test.ts). Mirrors ONLY the alert-projection fields of
 * `shiftCloseAlerts` (frozen P5-A/P5-C schema) — deliberately excludes
 * settlementState/processingState/lease/evidence/validation-run fields, which
 * live on `shiftCloseCases` and other collections this UI-A packet never reads.
 */

export type AlertState = 'none' | 'open' | 'acknowledged' | 'resolved';

export const ALERT_STATES: readonly AlertState[] = ['none', 'open', 'acknowledged', 'resolved'];

export const ALERT_STATE_LABELS: Record<AlertState, string> = {
  none: 'ไม่มีการแจ้งเตือน',
  open: 'เปิดอยู่',
  acknowledged: 'รับทราบแล้ว',
  resolved: 'แก้ไขแล้ว',
};

/** Mirror of functions/src/shiftCloseValidationTypes.ts AlertReasonCode (10 values). */
export type AlertReasonCode =
  | 'source_limit_exceeded'
  | 'cash_entry_malformed'
  | 'legacy_missing_required_field'
  | 'dependency_unavailable'
  | 'cash_pair_value_mismatch'
  | 'invalid_payload'
  | 'drawer_discrepancy'
  | 'identity_mismatch'
  | 'retry_exhausted'
  | 'superseding_match';

export const ALERT_REASON_CODES: readonly AlertReasonCode[] = [
  'source_limit_exceeded',
  'cash_entry_malformed',
  'legacy_missing_required_field',
  'dependency_unavailable',
  'cash_pair_value_mismatch',
  'invalid_payload',
  'drawer_discrepancy',
  'identity_mismatch',
  'retry_exhausted',
  'superseding_match',
];

export const ALERT_REASON_LABELS: Record<AlertReasonCode, string> = {
  source_limit_exceeded: 'เกินขีดจำกัดจำนวนแหล่งข้อมูล',
  cash_entry_malformed: 'รายการเงินสดผิดรูปแบบ',
  legacy_missing_required_field: 'ข้อมูลเก่าขาดฟิลด์ที่จำเป็น',
  dependency_unavailable: 'ระบบที่พึ่งพาไม่พร้อมใช้งาน',
  cash_pair_value_mismatch: 'ยอดเงินสดคู่ไม่ตรงกัน',
  invalid_payload: 'ข้อมูลไม่ถูกต้อง',
  drawer_discrepancy: 'ยอดเงินในลิ้นชักไม่ตรง',
  identity_mismatch: 'ข้อมูลผู้ทำรายการไม่ตรงกัน',
  retry_exhausted: 'ลองใหม่ครบจำนวนครั้งสูงสุดแล้ว',
  superseding_match: 'มีรายการที่ใหม่กว่าเข้ามาแทนที่',
};

const NO_REASON_LABEL = '—';
/** Exported (not just internal) — RC-2: tests must prove unknown values reach this label, not "no reason". */
export const UNKNOWN_REASON_LABEL = 'ไม่ทราบสาเหตุ (ข้อมูลผิดปกติ)';
/** Exported — RC-2: tests must prove unknown/malformed alertState reaches this label, never `none`. */
export const UNKNOWN_STATE_LABEL = 'สถานะไม่ทราบ (ข้อมูลผิดปกติ)';
/** Sentinel `alertState` for a doc whose raw `alertState` is not one of the 4 frozen values. */
export const UNKNOWN_ALERT_STATE = 'unknown' as const;

export type AlertActor = { kind: 'system' } | { kind: 'manager'; managerUid: string } | null;

/** Actionable = requires manager attention. Frozen default filter — do not widen ad hoc. */
export const ACTIONABLE_ALERT_STATES: readonly AlertState[] = ['open', 'acknowledged'];

export type ShiftCloseReviewRow = {
  id: string;
  shiftId: string;
  branchId: string;
  /**
   * RC-2: a doc whose raw `alertState` is not one of the 4 frozen values maps
   * to `'unknown'`, NEVER to `'none'` — collapsing unrecognized/malformed data
   * into a valid non-alert state would hide schema drift/corruption behind a
   * false "clean" queue. `'unknown'` rows are excluded from the frozen
   * `{open, acknowledged}` actionable filter but are surfaced separately via
   * `malformedRows` (see `useShiftCloseReviewQueue` / `filterMalformedRows`)
   * so they can never silently vanish from the page.
   */
  alertState: AlertState | typeof UNKNOWN_ALERT_STATE;
  alertStateLabel: string;
  /** Null means "genuinely no reason" (e.g. state `none`) — see `reasonLabel`/`reasonUnknown` for the unknown-vs-absent distinction. */
  reasonCode: AlertReasonCode | null;
  reasonLabel: string;
  /**
   * RC-2 (R2 remediation): true only when the raw `reasonCode` was PRESENT but
   * unrecognized — e.g. a `resolved` row (a valid, non-actionable alertState)
   * can still carry corrupt reason data. Distinguishing this from a genuinely
   * absent reason (`reasonUnknown: false`, `reasonCode: null`) is what lets
   * `filterMalformedRows` catch malformed data that an `alertState`-only check
   * would miss entirely.
   */
  reasonUnknown: boolean;
  openedAtMs: number | null;
  updatedAtMs: number | null;
  caseVersion: number | null;
  acknowledgedByActor: AlertActor;
  resolvedByActor: AlertActor;
};

function isValidAlertState(value: unknown): value is AlertState {
  return typeof value === 'string' && (ALERT_STATES as readonly string[]).includes(value);
}

function isValidAlertReasonCode(value: unknown): value is AlertReasonCode {
  return typeof value === 'string' && (ALERT_REASON_CODES as readonly string[]).includes(value);
}

/**
 * RC-2: validates BOTH the Timestamp-like `toMillis()` result AND a raw
 * number for finiteness — a `toMillis()` implementation that returns
 * NaN/Infinity without throwing must still degrade to `null` (never leak a
 * non-finite value into sort/UI).
 */
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

function mapActor(v: unknown): AlertActor {
  if (!v || typeof v !== 'object') return null;
  const kind = (v as Record<string, unknown>).kind;
  if (kind === 'system') return { kind: 'system' };
  if (kind === 'manager') {
    const managerUid = (v as Record<string, unknown>).managerUid;
    if (typeof managerUid === 'string' && managerUid) {
      return { kind: 'manager', managerUid };
    }
  }
  return null;
}

/**
 * Map one raw `shiftCloseAlerts/{shiftId}` doc to a safe view row. Reads ONLY
 * the alert-projection fields (never settlementState/processingState/lease/
 * evidence/validation figures — those belong to other collections/packets).
 * Degrades safely: malformed or missing fields never throw.
 */
export function mapShiftCloseReviewRow(id: string, data: Record<string, unknown>): ShiftCloseReviewRow {
  // RC-2: unrecognized/malformed alertState → UNKNOWN_ALERT_STATE, never 'none'.
  const alertState = isValidAlertState(data.alertState) ? data.alertState : UNKNOWN_ALERT_STATE;
  const alertStateLabel = alertState === UNKNOWN_ALERT_STATE ? UNKNOWN_STATE_LABEL : ALERT_STATE_LABELS[alertState];

  // RC-2: three distinct reasonCode states — genuinely absent (null/undefined,
  // e.g. a `none`-state doc), a recognized code, or a PRESENT-BUT-UNRECOGNIZED
  // value. Only the last two differ in `reasonCode`'s null-ness historically;
  // the label must still distinguish "no reason" from "unknown reason" so
  // corrupt data is never displayed as if it were simply reason-less.
  const rawReason = data.reasonCode;
  let reasonCode: AlertReasonCode | null = null;
  let reasonLabel: string;
  let reasonUnknown = false;
  if (rawReason === null || rawReason === undefined) {
    reasonLabel = NO_REASON_LABEL;
  } else if (isValidAlertReasonCode(rawReason)) {
    reasonCode = rawReason;
    reasonLabel = ALERT_REASON_LABELS[rawReason];
  } else {
    reasonLabel = UNKNOWN_REASON_LABEL;
    reasonUnknown = true;
  }

  return {
    id,
    shiftId: typeof data.shiftId === 'string' && data.shiftId ? data.shiftId : id,
    branchId: typeof data.branchId === 'string' ? data.branchId : '—',
    alertState,
    alertStateLabel,
    reasonCode,
    reasonLabel,
    reasonUnknown,
    openedAtMs: tsToMs(data.openedAt),
    updatedAtMs: tsToMs(data.updatedAt),
    caseVersion: typeof data.caseVersion === 'number' && Number.isFinite(data.caseVersion) ? data.caseVersion : null,
    acknowledgedByActor: mapActor(data.acknowledgedByActor),
    resolvedByActor: mapActor(data.resolvedByActor),
  };
}

/**
 * Deterministic in-memory sort: `updatedAtMs` descending (most recently
 * touched first); ties (including both null) break by `id` ascending so
 * render order never depends on snapshot delivery order.
 */
export function sortShiftCloseReviewRows(rows: ShiftCloseReviewRow[]): ShiftCloseReviewRow[] {
  return [...rows].sort((a, b) => {
    const bMs = b.updatedAtMs ?? -Infinity;
    const aMs = a.updatedAtMs ?? -Infinity;
    if (bMs !== aMs) return bMs - aMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The frozen default actionable filter: `alertState in { open, acknowledged }`. */
export function filterActionableRows(rows: ShiftCloseReviewRow[]): ShiftCloseReviewRow[] {
  return rows.filter((r) => (ACTIONABLE_ALERT_STATES as readonly string[]).includes(r.alertState));
}

/**
 * RC-2 (R2 remediation): rows with EITHER an unrecognized `alertState` OR a
 * present-but-unrecognized `reasonCode` — the broader "any malformed data on
 * this row" check. A valid non-actionable state (e.g. `resolved`) with a
 * corrupt reason is malformed too, even though its `alertState` alone looks
 * fine; `filterActionableRows`'s frozen `{open, acknowledged}` contract would
 * never catch it, and an `alertState`-only unknown check (the R1 remediation's
 * `filterUnknownRows`, since removed) missed it entirely — that gap is
 * exactly what let the page show a false "clean" success alert. Deliberately
 * NOT folded into `filterActionableRows` — the page must know about malformed
 * data independently of actionability so it can suppress clean-success states
 * and surface a distinct warning regardless of the actionable count.
 */
export function filterMalformedRows(rows: ShiftCloseReviewRow[]): ShiftCloseReviewRow[] {
  return rows.filter((r) => r.alertState === UNKNOWN_ALERT_STATE || r.reasonUnknown);
}
