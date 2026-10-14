/**
 * Admin & Security Center V1 (D-ASC8 / D-ASC9 / D-ASC11 / D-ASC12) —
 * server-side Firebase Auth classification of account targets.
 *
 * A password-backed account's Firebase Auth claims are static (nothing
 * restamps them), so any `users.authVersion` bump on that account strands
 * its username+password session until Owner Recovery can restamp claims.
 * The normal staff callable therefore must never mutate such an account —
 * whatever its role — and the overview must render it read-only.
 *
 *   - `PASSWORD_PRINCIPAL` — an Auth user with the same uid exists and has
 *     the `password` provider;
 *   - `QUICK_PIN_ONLY`     — Auth conclusively reports no user with that uid
 *     (an account created through normal POS user management);
 *   - `UNKNOWN`            — anything that cannot be proven safe: a lookup
 *     failure, a malformed / silent / contradictory answer, or an Auth user
 *     that exists without the password provider. Callers fail closed on it.
 *
 * For `role=admin` rows the same answer is also exposed in the D-ASC9 admin
 * vocabulary (`PASSWORD_ADMIN` = Security Admin, `POS_ADMIN` = Quick PIN
 * admin, `UNKNOWN`).
 *
 * Only callers that already proved a live admin actor look anything up.
 * Never logs or returns email / provider payloads — only the coarse
 * classification.
 */
import { getAuth } from 'firebase-admin/auth';

export type AccountAuthClassification = 'QUICK_PIN_ONLY' | 'PASSWORD_PRINCIPAL' | 'UNKNOWN';
export type SecurityAdminClassification = 'PASSWORD_ADMIN' | 'POS_ADMIN' | 'UNKNOWN';

export const PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED = 'PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED';
export const PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE = 'บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery';
/** D-ASC11: same code, refusal copy for a password-backed non-admin being promoted to `role=admin`. */
export const PASSWORD_PRINCIPAL_ADMIN_PROMOTION_MESSAGE =
  'บัญชีที่มีการเข้าสู่ระบบด้วยรหัสผ่านไม่สามารถเปลี่ยนเป็น POS Admin ผ่านหน้านี้ได้ กรุณาใช้ Owner Recovery';
export const ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE = 'ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE';
export const ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE_MESSAGE =
  'ไม่สามารถยืนยันประเภทบัญชีผู้ดูแลระบบได้ จึงยังไม่บันทึกการเปลี่ยนแปลง กรุณาลองใหม่ภายหลัง';
/** D-ASC12: a password-backed staff / manager target (no admin role before or after). */
export const PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED = 'PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED';
export const PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED_MESSAGE =
  'บัญชีนี้มีการเข้าสู่ระบบด้วย username/password จึงต้องจัดการผ่าน Owner Recovery';
/** D-ASC12: a staff / manager target whose Auth state cannot be proven Quick-PIN-only. */
export const ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE = 'ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE';
export const ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE_MESSAGE =
  'ไม่สามารถยืนยันประเภทการเข้าสู่ระบบของบัญชีนี้ได้ จึงยังไม่บันทึกการเปลี่ยนแปลง กรุณาลองใหม่ภายหลัง';

/** Minimal shape of `Auth.getUsers()` this module relies on. */
export type AdminAuthLookupResult = {
  users: Array<{ uid?: unknown; providerData?: unknown }>;
  notFound: Array<{ uid?: unknown }>;
};

/** Batch Auth lookup by uid (≤100 per call). Injectable for tests. */
export type AdminAuthLookup = (uids: string[]) => Promise<AdminAuthLookupResult>;

const AUTH_GET_USERS_MAX = 100;

export const defaultAdminAuthLookup: AdminAuthLookup = async (uids) =>
  (await getAuth().getUsers(uids.map((uid) => ({ uid })))) as unknown as AdminAuthLookupResult;

function hasPasswordProvider(providerData: unknown): boolean | null {
  if (!Array.isArray(providerData)) return null;
  return providerData.some(
    (p) => !!p && typeof p === 'object' && (p as { providerId?: unknown }).providerId === 'password',
  );
}

/**
 * Classifies each given uid against Firebase Auth. Every uid is present in
 * the result; any uid the lookup did not answer cleanly is `UNKNOWN`.
 */
export async function classifyAccountTargets(
  uids: string[],
  lookup: AdminAuthLookup = defaultAdminAuthLookup,
): Promise<Map<string, AccountAuthClassification>> {
  const result = new Map<string, AccountAuthClassification>();
  const unique = [...new Set(uids.filter((u) => typeof u === 'string' && u.length > 0))];
  for (const uid of unique) result.set(uid, 'UNKNOWN');
  for (let i = 0; i < unique.length; i += AUTH_GET_USERS_MAX) {
    const chunk = unique.slice(i, i + AUTH_GET_USERS_MAX);
    let answer: AdminAuthLookupResult;
    try {
      answer = await lookup(chunk);
    } catch {
      continue; // transient / unknown failure → stays UNKNOWN (fail closed)
    }
    if (!answer || !Array.isArray(answer.users) || !Array.isArray(answer.notFound)) continue;
    const asked = new Set(chunk);
    const found = new Map<string, AccountAuthClassification>();
    for (const user of answer.users) {
      if (!user || typeof user.uid !== 'string' || !asked.has(user.uid)) continue;
      const password = hasPasswordProvider(user.providerData);
      found.set(user.uid, password === true ? 'PASSWORD_PRINCIPAL' : 'UNKNOWN');
    }
    for (const missing of answer.notFound) {
      const uid = missing?.uid;
      // A uid reported both found and not-found is contradictory → UNKNOWN.
      if (typeof uid !== 'string' || !asked.has(uid)) continue;
      found.set(uid, found.has(uid) ? 'UNKNOWN' : 'QUICK_PIN_ONLY');
    }
    for (const [uid, cls] of found) result.set(uid, cls);
  }
  return result;
}

export async function classifyAccountTarget(
  uid: string,
  lookup: AdminAuthLookup = defaultAdminAuthLookup,
): Promise<AccountAuthClassification> {
  return (await classifyAccountTargets([uid], lookup)).get(uid) ?? 'UNKNOWN';
}

/** D-ASC9 admin vocabulary for the same Auth answer. */
export function toSecurityAdminClassification(c: AccountAuthClassification): SecurityAdminClassification {
  if (c === 'PASSWORD_PRINCIPAL') return 'PASSWORD_ADMIN';
  if (c === 'QUICK_PIN_ONLY') return 'POS_ADMIN';
  return 'UNKNOWN';
}

/** Classifies `role=admin` uids in the D-ASC9 admin vocabulary. */
export async function classifyAdminTargets(
  uids: string[],
  lookup: AdminAuthLookup = defaultAdminAuthLookup,
): Promise<Map<string, SecurityAdminClassification>> {
  const classes = await classifyAccountTargets(uids, lookup);
  return new Map([...classes].map(([uid, c]) => [uid, toSecurityAdminClassification(c)]));
}
