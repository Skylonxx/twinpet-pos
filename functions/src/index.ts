import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import {
  COLLECTIONS,
  isPrivilegedRole,
  isUsableForLogin,
  normalizeUsername,
  readUserCredential,
} from './credentialStore';

setGlobalOptions({ region: FUNCTIONS_REGION });

// Offline-first async checkout reconciler (Firestore onWrite trigger) — targets
// the database/region configured in firebase.json.
export { reconcileOrder } from './reconcileOrder';

// Admin-only manual repair: re-arm a failed (`exception`) reconciliation. Safety
// net only — see docs/reports/phase-2-track-b-proposal.md. (Exported after
// setGlobalOptions so the callable inherits the configured region.)
export { retryReconcile } from './retryReconcile';

// Phase 7B-2: ORIGIN-controlled, server-authoritative resolution of branch-transfer
// discrepancies. The destination branch can only REPORT (metadata); this callable
// is the sole path that corrects inventory, gated to the origin branch by verified
// claims and run under Admin SDK so it never needs destination write access.
export { resolveTransferDiscrepancy } from './resolveTransferDiscrepancy';

// Phase 7B-3D-2: server-authoritative REVERSAL resolver for receiving_reversal /
// transfer_reversal — idempotent, audited (reversalDocuments), with structured
// rejection codes; the single path that may reverse stock for these document types.
export { resolveReversal } from './resolveReversal';

// P1 offline-sync Packet 5 / P5-C-1: captures immutable evidence for the first
// server-visible transition of a `shifts/{shiftId}` doc to closed. Never
// mutates `shifts`. Activation (deploy) is gated behind P5-C-2 rules being
// verified live in the target project/database — see functions/package.json.
export { shiftCloseEvidenceCapture } from './shiftCloseEvidenceCapture';

// P1 offline-sync Packet 5 / P5-D-1: scheduled validation worker + routine
// sweep. Converts captured shiftCloseCases into provisional validation
// verdicts (shiftCloseValidationRuns), owns the selected*/processingState/
// settlementState/alertState case projections. Never reads or writes
// `shifts`. Activation (deploy) is gated behind the six P5-D-1 composite
// indexes being live in the target project/database — see
// functions/package.json / firestore.indexes.json.
export { shiftCloseValidationSweep } from './shiftCloseValidationWorker';

// P1 offline-sync Packet 5 / P5-D-2: four low-latency source-event routing
// triggers (asyncOrders/orders/cashTransactions/creditPayments) that mark
// shiftCloseCases as pendingRevalidation/queued so the P5-D-1 sweep picks
// them up sooner. Never validates inline, never writes evidence/run/audit/
// alert/cursor docs, never reads or writes `shifts`. Activation (deploy) is
// gated behind Codex implementation review — see functions/package.json.
export {
  shiftCloseSourceEventAsyncOrders,
  shiftCloseSourceEventOrders,
  shiftCloseSourceEventCashTransactions,
  shiftCloseSourceEventCreditPayments,
} from './shiftCloseSourceEvents';

// P1 offline-sync Packet 5 / P5-E / UI-11 Packet 2A: manager/admin
// ADJUDICATION callable for an existing shift-close alert. Consume requires a
// one-shot same-principal `approvalId` from `requestManagerApproval`; any
// present `pin` is hard-rejected. Never reads/writes `shifts`.
export { resolveShiftCloseAlert } from './resolveShiftCloseAlert';
export { requestManagerApproval } from './requestManagerApproval';
export { submitPrivilegedVoid } from './submitPrivilegedVoid';
// SEC-001 Packet D / D-1B: adjudicates a PAA1 offline privileged-action
// attestation relayed by an authenticated, branch-eligible POS terminal.
// Not in the deploy inventory — Packet E remains required before deploy.
export { adjudicateOfflinePrivilegedAction } from './adjudicateOfflinePrivilegedAction';

// P1 offline-sync Packet 5 / UI-B2 / Packet S: read-only manager/admin
// callable that resolves the sensitive drawer figures (client-reported and
// server-computed) for a shift-close case through its selected validation
// run only — no query, no index, no latest-evidence fallback, zero writes.
export { getShiftCloseCaseFigures } from './getShiftCloseCaseFigures';
export { getOrderReceipt } from './getOrderReceipt';
export { setUserAccount } from './setUserAccount';

// SEC-001 Packet C-A: issuer trust bootstrap (OPTION_I1_PER_INSTALL_ASYMMETRIC_ISSUER_KEYPAIR_OPS_BOOTSTRAP).
// registerIssuer consumes a one-time Ops-issued bootstrap token + a possession-proof
// signature; revokeIssuerRegistration is Admin-only issuer revocation.
export { registerIssuer, revokeIssuerRegistration } from './issuerRegistration';

// SEC-001 Packet C-A: device-enrollment lifecycle (D17 — OPTION_A_ENROLLMENT_FILE).
// The first pair issues/signs the ENR1 enrollment authorization (Admin Console side,
// issuer-signed request); the second pair consumes the native DRP1 possession proof
// (POS terminal side) and persists validatedSecurityDeviceId/validatedDevProofPublicKeyBase64/
// devProofRegistrationNonce.
export {
  beginDeviceEnrollmentAuthorizationIssuance,
  completeDeviceEnrollmentAuthorizationIssuance,
  beginDeviceRegistration,
  completeDeviceRegistration,
} from './deviceEnrollment';

// SEC-001 Packet C-A: online OAC (offline authorization capability) provisioning
// ceremony — a live manager/admin, at an already-registered device, obtains a
// signed offline void-authorization capability bound to that exact device.
export {
  beginPrivilegedOacIssuanceSession,
  completePrivilegedOacIssuanceSession,
} from './oacIssuanceSession';

// SEC-001 Packet C-A: serves the OKS1 keyset manifest (active OAC-signing public
// keys + current revocation epoch) native terminals cache for offline verification.
export { getOacKeysetManifest } from './oacKeysetManifest';

// SEC-001 Packet C-A / F7: admin-only role-permission entrypoint. Pure additions
// apply immediately; removals stage a DRAINING deny round that roleSweepScheduler
// sweeps to COMPLETED (DRAINING -> VERIFYING -> CONVERGED -> COMPLETED).
export { setRolePermissions } from './setRolePermissions';
export { roleSweepScheduler } from './roleSweepScheduler';

// SEC-001 Packet C-B: admin-only entrypoint for minting a replay-safe signed
// LockoutClearTokenFrameV1 (LCT1) to clear offline manager lockout.
export { issuePrivilegedLockoutClear } from './issuePrivilegedLockoutClear';

// SEC-001 Packet D-1A: Staff / Device Trust, Receipts, OAC Anchors & Key Lifecycle.
export { reEnrollPrivilegedDevice } from './reEnrollPrivilegedDevice';
export { issueOfflineStaffSessionAssertion } from './issueOfflineStaffSessionAssertion';
export { refreshOfflineStaffSessionAssertion } from './refreshOfflineStaffSessionAssertion';
export { reanchorPrivilegedOacReceipt } from './reanchorPrivilegedOacReceipt';

// Admin & Security Center V1: read-only safe overview (users, Quick PIN state,
// server-authored security audit events) for the primary password admin only.
export { getAdminSecurityOverview } from './getAdminSecurityOverview';

type UserRole = 'admin' | 'manager' | 'staff';

// Fallback mirror of the client DEFAULT_ROLE_PERMS (src/lib/staffManagement/types.ts).
// Used only when settings/_rolePermissions is missing/unreadable so a login never
// strips a user down to zero granular permissions. Keep in sync if the permission
// vocabulary grows (functions cannot import from src/).
const DEFAULT_ROLE_PERMS: Record<UserRole, string[]> = {
  admin: [
    'pos_sale', 'pos_discount', 'pos_void', 'quotation', 'product_view',
    'product_edit', 'stock_receive', 'cost_view', 'report_sales', 'report_stock',
    'report_profit', 'employee_manage', 'settings',
  ],
  manager: [
    'pos_sale', 'pos_discount', 'pos_void', 'quotation', 'product_view',
    'product_edit', 'stock_receive', 'cost_view', 'report_sales', 'report_stock',
  ],
  staff: ['pos_sale', 'product_view'],
};

/**
 * Resolve the granular permission-key array for a role from the live
 * settings/_rolePermissions matrix doc (the source of truth the admin panel
 * edits). Falls back to DEFAULT_ROLE_PERMS when the doc is missing/unreadable or
 * the role row is empty, so login is never left without permissions.
 */
async function resolvePermissionKeys(role: UserRole): Promise<string[]> {
  try {
    const snap = await db.collection('settings').doc('_rolePermissions').get();
    const matrix = snap.data()?.rolePermissions as Record<string, string[]> | undefined;
    const keys = matrix?.[role];
    if (Array.isArray(keys) && keys.length > 0) return keys;
  } catch (err) {
    console.warn('[verifyPinLogin] _rolePermissions unreadable, using defaults', err);
  }
  return DEFAULT_ROLE_PERMS[role];
}

type UserDoc = {
  id?: string;
  firstName: string;
  lastName: string;
  username: string;
  pin?: string;
  role: UserRole;
  branchIds: string[];
  permissions: {
    canVoidOrder: boolean;
    canEditPrice: boolean;
    canViewReport: boolean;
    canManageStock: boolean;
    canManageStaff: boolean;
  };
  isActive: boolean;
  authVersion?: number;
  lastLoginAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
};

/** Fixed dummy bcrypt hash — never a real stored credential. */
export const LOGIN_DUMMY_PIN_HASH =
  '$2b$10$WCOTRHGYk1RxxHdHMy9.guo3rg259b4w/opYiC13GSmPmCmPJVYwO';

export const GENERIC_LOGIN_DENIED = 'PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้';

/**
 * Stable reason for a Quick PIN call made from a non-anonymous Firebase
 * identity. Sent as the `failed-precondition` message so the client can tell
 * it apart from a wrong PIN without learning anything about the PIN.
 */
export const PIN_SESSION_IDENTITY_REJECTED = 'PIN_SESSION_IDENTITY_REJECTED';

/**
 * Token-level half of the Quick PIN identity check. Reads the
 * signature-verified ID token the Functions runtime decoded, never a
 * client-supplied field: the token must have been obtained anonymously
 * (`firebase.sign_in_provider === 'anonymous'`, exact match). `identities` is
 * optional on the wire; when present it must be an empty plain object.
 * Missing / non-string / unknown providers, and null, array, primitive or
 * non-empty identities, fail closed.
 */
export function isAnonymousPinCaller(auth: { token?: unknown } | undefined): boolean {
  const token = auth?.token as { firebase?: unknown } | undefined;
  const firebase = token?.firebase as { sign_in_provider?: unknown; identities?: unknown } | undefined;
  if (!firebase || typeof firebase !== 'object') return false;
  if (firebase.sign_in_provider !== 'anonymous') return false;
  const identities = firebase.identities;
  if (identities === undefined) return true;
  if (identities === null || typeof identities !== 'object' || Array.isArray(identities)) return false;
  return Object.keys(identities).length === 0;
}

type LivePinAccount = {
  uid?: unknown;
  disabled?: unknown;
  email?: unknown;
  phoneNumber?: unknown;
  passwordHash?: unknown;
  providerData?: unknown;
  multiFactor?: unknown;
};

/**
 * MFA half of the live-account check. Absent `multiFactor` means no MFA.
 * When present it must be a plain object carrying an `enrolledFactors` array
 * that is empty; null, primitives, arrays, `{}`, a missing/undefined or
 * non-array `enrolledFactors`, and any enrolled factor all fail closed.
 */
function hasNoEnrolledMfa(multiFactor: unknown): boolean {
  if (multiFactor === undefined) return true;
  if (multiFactor === null || typeof multiFactor !== 'object' || Array.isArray(multiFactor)) return false;
  if (!Object.prototype.hasOwnProperty.call(multiFactor, 'enrolledFactors')) return false;
  const factors = (multiFactor as { enrolledFactors?: unknown }).enrolledFactors;
  return Array.isArray(factors) && factors.length === 0;
}

/**
 * Live-account half: an older anonymous token survives an account link /
 * upgrade, so the CURRENT Auth user record must still look like a dedicated
 * anonymous PIN account: exact UID, enabled, `providerData` an empty array,
 * no email, no phone, no enrolled MFA. Combined with the token predicate
 * (`sign_in_provider === 'anonymous'`), those documented linkage surfaces are
 * what identify a password / provider-linked account. Ambiguous shapes fail
 * closed.
 *
 * `passwordHash` is NOT proof of anything here: `getUser()` does not reliably
 * populate it (Admin SDK documents it as a `listUsers()` field, and `''` can
 * mean an imported hash). A non-empty value is kept only as a conservative,
 * rejection-only extra signal; its absence proves nothing about a password.
 */
export function isProviderlessPinAccount(record: LivePinAccount | null | undefined, uid: string): boolean {
  if (!record || typeof record !== 'object' || record.uid !== uid) return false;
  if (record.disabled !== false) return false;
  if (!Array.isArray(record.providerData) || record.providerData.length !== 0) return false;
  if (record.email !== undefined && record.email !== null && record.email !== '') return false;
  if (record.phoneNumber !== undefined && record.phoneNumber !== null && record.phoneNumber !== '') return false;
  if (!hasNoEnrolledMfa(record.multiFactor)) return false;
  // Rejection-only, non-authoritative (see above).
  if (record.passwordHash !== undefined && record.passwordHash !== null && record.passwordHash !== '') return false;
  return true;
}

/**
 * Quick PIN may stamp staff claims ONLY onto a dedicated anonymous PIN
 * identity — never onto a password / provider-linked account, whose claims
 * are global to that real account. Token check first (no network), then one
 * live `getUser` lookup. Every failure — including lookup errors and
 * user-not-found — is the same non-oracular `failed-precondition`.
 */
async function assertDedicatedPinIdentity(auth: { uid?: unknown; token?: unknown }): Promise<void> {
  const reject = () => new HttpsError('failed-precondition', PIN_SESSION_IDENTITY_REJECTED);
  if (typeof auth.uid !== 'string' || !auth.uid || !isAnonymousPinCaller(auth)) throw reject();
  let record: LivePinAccount;
  try {
    record = (await getAuth().getUser(auth.uid)) as unknown as LivePinAccount;
  } catch {
    throw reject();
  }
  if (!isProviderlessPinAccount(record, auth.uid)) throw reject();
}

export type PinLoginIdentityOutcome = {
  bcryptComparisons: number;
  match: { user: UserDoc; id: string } | null;
};

type VerifyPinLoginRequest = {
  pin?: string;
  branchId?: string;
  username?: string;
  userId?: string;
};

type SanitizedUser = Omit<UserDoc, 'pin'> & { id: string };

function serializeUser(user: UserDoc, id: string): SanitizedUser {
  const { pin: _legacyPin, ...rest } = user;
  void _legacyPin;
  const serialized = { ...rest, id: user.id ?? id } as Record<string, unknown>;

  for (const key of ['createdAt', 'updatedAt', 'lastLoginAt', 'deletedAt'] as const) {
    const value = serialized[key];
    if (value && typeof value === 'object' && 'toDate' in value) {
      serialized[key] = (value as Timestamp).toDate().toISOString();
    }
  }

  return serialized as SanitizedUser;
}

function assertActiveBranchUser(user: UserDoc, branchId: string): void {
  if (!user.isActive || user.deletedAt != null) {
    throw new HttpsError('permission-denied', 'PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
  }
  // Global Admins (branchIds: ['ALL']) are allowed to log in at any physical branch.
  const hasAccess = user.branchIds?.includes('ALL') || user.branchIds?.includes(branchId);
  if (!hasAccess) {
    throw new HttpsError('permission-denied', 'PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
  }
}

async function pinMatches(storedHash: string | undefined, pin: string): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await bcrypt.compare(pin, storedHash);
  } catch {
    return false;
  }
}

async function dummyCompare(pin: string): Promise<void> {
  await pinMatches(LOGIN_DUMMY_PIN_HASH, pin);
}

/**
 * Merge docs from two parallel Firestore queries, deduplicating by document ID.
 * This is needed because Firestore's array-contains cannot OR two values in one
 * query, so we fetch branch-specific users and Global Admin ('ALL') users separately.
 */
function mergeDocs(
  a: FirebaseFirestore.QuerySnapshot,
  b: FirebaseFirestore.QuerySnapshot,
): FirebaseFirestore.QueryDocumentSnapshot[] {
  const seen = new Set<string>();
  const result: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const doc of [...a.docs, ...b.docs]) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    result.push(doc);
  }
  return result;
}

async function loadUsernameCandidates(
  database: Firestore,
  username: string,
  branchId: string,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const [branchSnap, globalSnap] = await Promise.all([
    database.collection(COLLECTIONS.users)
      .where('username', '==', username)
      .where('branchIds', 'array-contains', branchId)
      .where('isActive', '==', true)
      .limit(2)
      .get(),
    database.collection(COLLECTIONS.users)
      .where('username', '==', username)
      .where('branchIds', 'array-contains', 'ALL')
      .where('isActive', '==', true)
      .limit(2)
      .get(),
  ]);
  return mergeDocs(branchSnap, globalSnap).filter((docSnap) => {
    const user = docSnap.data() as UserDoc;
    return user.deletedAt == null;
  });
}

async function verifyCanonicalPin(
  database: Firestore,
  userId: string,
  pin: string,
  role: UserRole,
): Promise<boolean> {
  const cred = await readUserCredential(database, userId);
  if (!isUsableForLogin(cred)) {
    await dummyCompare(pin);
    return false;
  }
  const ok = await pinMatches(cred.pinHash, pin);
  if (!ok) return false;
  if (isPrivilegedRole(role) && cred.credentialState !== 'rotated_authoritative') {
    return false;
  }
  return true;
}

/**
 * Typed username/userId identity resolver. Zero or ambiguous candidates do
 * exactly one dummy bcrypt compare and never select an identity. Exactly one
 * candidate does exactly one real compare against userCredentials/{id}.
 */
export async function resolvePinLoginIdentity(
  database: Firestore,
  pin: string,
  branchId: string,
  username?: string,
  userId?: string,
): Promise<PinLoginIdentityOutcome> {
  if (!userId && !username) {
    throw new HttpsError('invalid-argument', 'กรุณาระบุชื่อผู้ใช้');
  }

  if (userId) {
    const snap = await database.collection(COLLECTIONS.users).doc(userId).get();
    if (!snap.exists) {
      await dummyCompare(pin);
      return { bcryptComparisons: 1, match: null };
    }
    const user = snap.data() as UserDoc;
    try {
      assertActiveBranchUser(user, branchId);
    } catch {
      await dummyCompare(pin);
      return { bcryptComparisons: 1, match: null };
    }
    const ok = await verifyCanonicalPin(database, snap.id, pin, user.role);
    return { bcryptComparisons: 1, match: ok ? { user, id: snap.id } : null };
  }

  const normalized = normalizeUsername(username ?? '');
  const candidates = await loadUsernameCandidates(database, normalized, branchId);
  if (candidates.length !== 1) {
    await dummyCompare(pin);
    return { bcryptComparisons: 1, match: null };
  }
  const docSnap = candidates[0]!;
  const user = docSnap.data() as UserDoc;
  const ok = await verifyCanonicalPin(database, docSnap.id, pin, user.role);
  return { bcryptComparisons: 1, match: ok ? { user, id: docSnap.id } : null };
}

export const verifyPinLogin = onCall(
  {
    invoker: 'public',
    cors: [
      /^https?:\/\/localhost:\d+$/,
      /^https:\/\/.*\.firebaseapp\.com$/,
      /^https:\/\/.*\.web\.app$/,
      'http://tauri.localhost',
    ],
  },
  async (request) => {
    try {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบ Firebase ก่อนยืนยัน PIN');
      }
      // Before any PIN/identity work (arg validation, staff/credential reads,
      // bcrypt, permissions, claims, lastLoginAt): the caller must be a
      // dedicated anonymous PIN identity, by token AND live account record.
      await assertDedicatedPinIdentity(request.auth);

      const data = (request.data ?? {}) as VerifyPinLoginRequest;
      const pin = String(data.pin ?? '').trim();
      const branchId = String(data.branchId ?? '').trim();
      const username = data.username ? normalizeUsername(String(data.username)) : undefined;
      const userId = data.userId ? String(data.userId).trim() : undefined;

      if (!/^\d{4}$/.test(pin)) {
        throw new HttpsError('invalid-argument', 'PIN ต้องเป็นตัวเลข 4 หลัก');
      }
      if (!branchId) {
        throw new HttpsError('invalid-argument', 'กรุณาระบุสาขา');
      }
      if (!username && !userId) {
        throw new HttpsError('invalid-argument', 'กรุณาระบุชื่อผู้ใช้');
      }

      const resolved = await resolvePinLoginIdentity(db, pin, branchId, username, userId);
      if (!resolved.match) {
        throw new HttpsError('permission-denied', GENERIC_LOGIN_DENIED);
      }

      const staffId = resolved.match.id;
      const user = resolved.match.user;
      const authVersion = typeof user.authVersion === 'number' ? user.authVersion : 0;

      const permissions = await resolvePermissionKeys(user.role);

      await getAuth().setCustomUserClaims(request.auth.uid, {
        staffId,
        role: user.role,
        branchIds: user.branchIds,
        permissions,
        authVersion,
      });

      await db.collection('users').doc(staffId).update({
        lastLoginAt: FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        user: serializeUser(user, staffId),
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error('[verifyPinLogin] unhandled error', err);
      throw new HttpsError('internal', 'ระบบ PIN ขัดข้อง กรุณาลองใหม่');
    }
  },
);

// NOTE: the TEMPORARY one-shot `migrateDataToPosDb` ((default) → pos-db copier,
// `invoker: 'public'`) was REMOVED in Phase 3 Gate 1 — a public DB-copy endpoint
// must never ship to production. The (default) → pos-db migration is complete.
// Production function exports are limited to: verifyPinLogin, reconcileOrder,
// retryReconcile (see the deploy allowlist/checklist in functions/package.json
// + docs/reports/latest-report.md). Do NOT add dev/mock/test/migration
// functions to this entrypoint.
