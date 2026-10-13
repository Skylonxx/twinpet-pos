/**
 * Admin & Security Center V1 — primary password-admin principal predicate.
 *
 * Account / credential administration (`setUserAccount`) and the admin
 * security overview require the caller to be a REAL username+password
 * Firebase Auth session whose UID is the staff account itself. A Quick PIN
 * session — including an admin's — is a dedicated anonymous UID carrying
 * staff claims, and is never sufficient.
 *
 * Token-only and pure: reads the signature-verified decoded ID token the
 * Functions runtime supplies (`firebase.sign_in_provider`), never a
 * client-supplied field. It ADDS to, never replaces, the existing
 * authority checks (`assertFreshPrivilegedAuthority` + the live `users`
 * role/active/authVersion check inside the core).
 */
import type { AuthLike } from './authorityFence';
import { tokenStaffId } from './authorityFence';

export const ADMIN_PASSWORD_SESSION_REQUIRED = 'ADMIN_PASSWORD_SESSION_REQUIRED';
export const ADMIN_PASSWORD_SESSION_REQUIRED_MESSAGE =
  'ต้องเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่านของผู้ดูแลระบบเพื่อจัดการความปลอดภัย';

export function isPrimaryPasswordPrincipal(auth: AuthLike): boolean {
  if (!auth || typeof auth.uid !== 'string' || !auth.uid) return false;
  const staffId = tokenStaffId(auth);
  if (!staffId || staffId !== auth.uid) return false;
  const firebase = auth.token?.firebase as { sign_in_provider?: unknown } | undefined;
  if (!firebase || typeof firebase !== 'object') return false;
  return firebase.sign_in_provider === 'password';
}
