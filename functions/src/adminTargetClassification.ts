/**
 * Admin & Security Center V1 (D-ASC8 / D-ASC9) — server-side classification
 * of `role=admin` targets.
 *
 * A password-backed admin's Firebase Auth claims are static (nothing
 * restamps them), so any `users.authVersion` bump on that account strands
 * its username+password session until Owner Recovery exists. The normal
 * staff callable therefore must never mutate such an account, and the
 * overview must render it read-only.
 *
 *   - `PASSWORD_ADMIN` — an Auth user with the same uid exists and has the
 *     `password` provider;
 *   - `POS_ADMIN`      — no Auth user with that uid exists (a Quick PIN
 *     admin created through normal POS user management);
 *   - `UNKNOWN`        — anything that cannot be proven safe: a lookup
 *     failure, a malformed answer, or an Auth user that exists without the
 *     password provider. Callers fail closed on it.
 *
 * Only live `role=admin` uids are ever looked up. Never logs or returns
 * email / provider payloads — only the coarse classification.
 */
import { getAuth } from 'firebase-admin/auth';

export type SecurityAdminClassification = 'PASSWORD_ADMIN' | 'POS_ADMIN' | 'UNKNOWN';

export const PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED = 'PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED';
export const PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE = 'บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery';
export const ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE = 'ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE';
export const ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE_MESSAGE =
  'ไม่สามารถยืนยันประเภทบัญชีผู้ดูแลระบบได้ จึงยังไม่บันทึกการเปลี่ยนแปลง กรุณาลองใหม่ภายหลัง';

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
 * Classifies each given uid (callers pass only live `role=admin` uids).
 * Every uid is present in the result; any uid the lookup did not answer
 * cleanly is `UNKNOWN`.
 */
export async function classifyAdminTargets(
  uids: string[],
  lookup: AdminAuthLookup = defaultAdminAuthLookup,
): Promise<Map<string, SecurityAdminClassification>> {
  const result = new Map<string, SecurityAdminClassification>();
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
    const found = new Map<string, SecurityAdminClassification>();
    for (const user of answer.users) {
      if (!user || typeof user.uid !== 'string' || !asked.has(user.uid)) continue;
      const password = hasPasswordProvider(user.providerData);
      found.set(user.uid, password === true ? 'PASSWORD_ADMIN' : 'UNKNOWN');
    }
    for (const missing of answer.notFound) {
      const uid = missing?.uid;
      // A uid reported both found and not-found is contradictory → UNKNOWN.
      if (typeof uid !== 'string' || !asked.has(uid)) continue;
      found.set(uid, found.has(uid) ? 'UNKNOWN' : 'POS_ADMIN');
    }
    for (const [uid, cls] of found) result.set(uid, cls);
  }
  return result;
}

export async function classifyAdminTarget(
  uid: string,
  lookup: AdminAuthLookup = defaultAdminAuthLookup,
): Promise<SecurityAdminClassification> {
  return (await classifyAdminTargets([uid], lookup)).get(uid) ?? 'UNKNOWN';
}
