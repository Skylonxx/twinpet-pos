/**
 * Shared Packet 2A manager-approval contract (client).
 * Mirrors functions/src/requestManagerApprovalCore.ts — do not import across
 * the functions/src boundary.
 */

export const PROTECTED_ACTIONS = [
  'shift_close_alert_acknowledge',
  'shift_close_alert_resolve',
] as const;

export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];

export type ApprovalSecurityModel = 'reauth' | 'delegated';

export type ManagerApprovalErrorCode =
  | 'invalid_credentials'
  | 'not_authorized'
  | 'branch_mismatch'
  | 'invalid_target'
  | 'locked'
  | 'expired_approval'
  | 'replayed_approval'
  | 'self_approval_not_permitted'
  | 'approver_not_eligible'
  | 'no_eligible_approver'
  | 'offline'
  | 'verifier_unavailable';

export interface RequestManagerApprovalClientRequest {
  commandId: string;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  pin: string;
  securityModel?: ApprovalSecurityModel;
  approverStaffId?: string;
}

export type RequestManagerApprovalClientSuccess = {
  ok: true;
  approvalId: string;
  expiresAtMillis: number;
};

export type RequestManagerApprovalClientFailure = {
  ok: false;
  code: ManagerApprovalErrorCode;
};

export type RequestManagerApprovalClientResponse =
  | RequestManagerApprovalClientSuccess
  | RequestManagerApprovalClientFailure;

export const MANAGER_APPROVAL_ERROR_LABELS: Record<ManagerApprovalErrorCode, string> = {
  invalid_credentials: 'PIN ไม่ถูกต้อง',
  not_authorized: 'ไม่มีสิทธิ์อนุมัติรายการนี้',
  branch_mismatch: 'สาขาไม่ตรงกับสิทธิ์ที่ใช้งาน',
  invalid_target: 'ข้อมูลรายการไม่ถูกต้อง',
  locked: 'ถูกล็อกชั่วคราว กรุณาติดต่อผู้ดูแล',
  expired_approval: 'การอนุมัติหมดอายุ กรุณาขออนุมัติใหม่',
  replayed_approval: 'การอนุมัตินี้ถูกใช้ไปแล้ว',
  self_approval_not_permitted: 'ผู้ขออนุมัติและผู้อนุมัติต้องไม่ใช่คนเดียวกัน',
  approver_not_eligible: 'ผู้อนุมัติที่เลือกไม่มีสิทธิ์อนุมัติรายการนี้',
  no_eligible_approver: 'ไม่มีผู้อนุมัติที่มีสิทธิ์ในสาขานี้ ไม่สามารถดำเนินการได้',
  offline: 'ออฟไลน์ — ขออนุมัติไม่ได้ตอนนี้ ไม่มีคำขอถูกส่ง',
  verifier_unavailable: 'ระบบอนุมัติไม่ตอบสนอง กรุณาลองใหม่',
};

export function expectedProtectedAction(
  outcome: 'acknowledge' | 'resolve',
): ProtectedAction {
  return outcome === 'acknowledge' ? 'shift_close_alert_acknowledge' : 'shift_close_alert_resolve';
}

export function isManagerApprovalErrorCode(value: unknown): value is ManagerApprovalErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MANAGER_APPROVAL_ERROR_LABELS, value);
}
