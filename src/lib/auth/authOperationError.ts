/**
 * TPOS-R7: a password or Quick PIN login whose result arrived after another
 * interactive login started, or after the Firebase identity it authenticated
 * changed. Never "wrong PIN" / "wrong password"; carries one fixed message and
 * no UID, generation number, or raw Firebase string.
 */
export const AUTH_OPERATION_SUPERSEDED_MESSAGE =
  'มีการเข้าสู่ระบบอื่นเริ่มขึ้นระหว่างนี้ — การเข้าสู่ระบบครั้งนี้ถูกยกเลิก กรุณาลองใหม่';

export class AuthOperationSupersededError extends Error {
  readonly code = 'AUTH_OPERATION_SUPERSEDED' as const;

  constructor() {
    super(AUTH_OPERATION_SUPERSEDED_MESSAGE);
    this.name = 'AuthOperationSupersededError';
  }
}

export function isAuthOperationSupersededError(err: unknown): err is AuthOperationSupersededError {
  return err instanceof AuthOperationSupersededError;
}
