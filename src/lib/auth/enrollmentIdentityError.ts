/**
 * TPOS-R7 first-enrollment identity preparation failures. These are
 * identity/session problems, never "invalid ENR1", and carry only fixed
 * messages — no UID, raw Firebase, Tauri, or server string reaches the UI.
 */
export type EnrollmentIdentityErrorCode =
  /** A dedicated anonymous Firebase identity could not be established or proven. */
  | 'ENROLLMENT_IDENTITY_UNAVAILABLE'
  /** UID-bound enrollment recovery evidence exists; the current UID must be kept. */
  | 'ENROLLMENT_IDENTITY_TRANSITION_BLOCKED'
  /** The device is not in a clean NOT_ENROLLED state; no fresh enrollment identity. */
  | 'ENROLLMENT_IDENTITY_NOT_ALLOWED';

const ENROLLMENT_IDENTITY_MESSAGES: Record<EnrollmentIdentityErrorCode, string> = {
  ENROLLMENT_IDENTITY_UNAVAILABLE:
    'เตรียมเซสชันสำหรับลงทะเบียนเครื่องไม่สำเร็จ — ยังไม่ได้เริ่มการลงทะเบียน กรุณาลองใหม่',
  ENROLLMENT_IDENTITY_TRANSITION_BLOCKED:
    'เครื่องนี้มีข้อมูลการลงทะเบียนที่ค้างอยู่ — ยังเริ่มการลงทะเบียนใหม่ไม่ได้ กรุณาติดต่อผู้ดูแลระบบ',
  ENROLLMENT_IDENTITY_NOT_ALLOWED:
    'สถานะเครื่องนี้ไม่พร้อมสำหรับการลงทะเบียนใหม่ — ยังไม่ได้เริ่มการลงทะเบียน',
};

export class EnrollmentIdentityError extends Error {
  readonly code: EnrollmentIdentityErrorCode;

  constructor(code: EnrollmentIdentityErrorCode) {
    super(ENROLLMENT_IDENTITY_MESSAGES[code]);
    this.name = 'EnrollmentIdentityError';
    this.code = code;
  }
}

export function isEnrollmentIdentityError(err: unknown): err is EnrollmentIdentityError {
  return err instanceof EnrollmentIdentityError;
}
