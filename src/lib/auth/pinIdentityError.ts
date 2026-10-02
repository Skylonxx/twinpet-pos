/**
 * TPOS-R7 Quick PIN identity isolation failures. These are identity/session
 * problems, never "PIN incorrect", and carry only fixed messages — no raw
 * Firebase, Tauri, or server string ever reaches the UI through them.
 */
export type PinIdentityErrorCode =
  /** An anonymous Firebase PIN identity could not be established or proven. */
  | 'PIN_IDENTITY_UNAVAILABLE'
  /** A UID-bound device-enrollment recovery is pending; the UID must be kept. */
  | 'PIN_IDENTITY_TRANSITION_BLOCKED'
  /** The server refused the PIN call because the caller is not anonymous. */
  | 'PIN_IDENTITY_REJECTED';

const PIN_IDENTITY_MESSAGES: Record<PinIdentityErrorCode, string> = {
  PIN_IDENTITY_UNAVAILABLE:
    'เตรียมเซสชันสำหรับเข้าสู่ระบบด้วย PIN ไม่สำเร็จ — ยังไม่ได้ตรวจสอบ PIN กรุณาลองใหม่',
  PIN_IDENTITY_TRANSITION_BLOCKED:
    'เครื่องนี้มีการลงทะเบียนเครื่องที่ยังค้างอยู่ — ยังเข้าสู่ระบบด้วย PIN ไม่ได้ กรุณาดำเนินการลงทะเบียนให้เสร็จ หรือติดต่อผู้ดูแลระบบ',
  PIN_IDENTITY_REJECTED:
    'เซสชันปัจจุบันใช้เข้าสู่ระบบด้วย PIN ไม่ได้ — ยังไม่ได้ตรวจสอบ PIN กรุณาลองใหม่',
};

export class PinIdentityError extends Error {
  readonly code: PinIdentityErrorCode;

  constructor(code: PinIdentityErrorCode) {
    super(PIN_IDENTITY_MESSAGES[code]);
    this.name = 'PinIdentityError';
    this.code = code;
  }
}

export function isPinIdentityError(err: unknown): err is PinIdentityError {
  return err instanceof PinIdentityError;
}

/**
 * Runs a PIN-path identity step (e.g. an ID-token refresh). Any failure — a
 * raw FirebaseError included — becomes the fixed PIN_IDENTITY_UNAVAILABLE, so
 * it is never rendered raw nor shown as a wrong PIN.
 */
export async function asPinIdentityStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch {
    throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
  }
}
