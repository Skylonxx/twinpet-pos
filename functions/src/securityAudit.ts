/**
 * Admin & Security Center V1 — server-authored security audit trail.
 *
 * `securityAuditEvents/{eventId}` is written ONLY by Cloud Functions (Admin
 * SDK) as a side effect of a security mutation the same function performed;
 * Firestore rules deny every client read and write, so a renderer can never
 * forge or edit an entry. Events carry identifiers and coarse facts only —
 * never a PIN, hash, verifier, salt, pepper, token, LCT1/OAC bytes or device
 * key. Device-scoped events record the device's registered branch, not the
 * raw security device id.
 */
import { randomUUID } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

export const SECURITY_AUDIT_EVENTS_COLLECTION = 'securityAuditEvents';
export const SECURITY_AUDIT_SCHEMA_VERSION = 1;

export type SecurityAuditEventType =
  | 'USER_CREATED'
  | 'USER_PROFILE_UPDATED'
  | 'USER_ENABLED'
  | 'USER_DISABLED'
  | 'USER_SOFT_DELETED'
  | 'USER_RENAMED'
  | 'QUICK_PIN_ROTATED'
  | 'APPROVAL_LOCKOUT_CLEAR_ISSUED'
  | 'OAC_ISSUED';

export const SECURITY_AUDIT_EVENT_TYPES: readonly SecurityAuditEventType[] = [
  'USER_CREATED',
  'USER_PROFILE_UPDATED',
  'USER_ENABLED',
  'USER_DISABLED',
  'USER_SOFT_DELETED',
  'USER_RENAMED',
  'QUICK_PIN_ROTATED',
  'APPROVAL_LOCKOUT_CLEAR_ISSUED',
  'OAC_ISSUED',
];

export type SecurityAuditEventInput = {
  type: SecurityAuditEventType;
  /** Acting staff id, or `OPERATOR_CLI` for the operator scripts. */
  actorStaffId: string;
  targetStaffId: string;
  /** Changed field NAMES only (never values) for profile updates. */
  changedFields?: string[];
  roleBefore?: string | null;
  roleAfter?: string | null;
  branchIdsBefore?: string[] | null;
  branchIdsAfter?: string[] | null;
  /** Registered branch of the device a device-scoped capability was issued for. */
  deviceBranchId?: string | null;
};

function eventDoc(input: SecurityAuditEventInput): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    schemaVersion: SECURITY_AUDIT_SCHEMA_VERSION,
    type: input.type,
    actorStaffId: input.actorStaffId,
    targetStaffId: input.targetStaffId,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (input.changedFields) doc.changedFields = [...input.changedFields].sort();
  if (input.roleBefore !== undefined) doc.roleBefore = input.roleBefore;
  if (input.roleAfter !== undefined) doc.roleAfter = input.roleAfter;
  if (input.branchIdsBefore !== undefined) doc.branchIdsBefore = input.branchIdsBefore;
  if (input.branchIdsAfter !== undefined) doc.branchIdsAfter = input.branchIdsAfter;
  if (input.deviceBranchId !== undefined) doc.deviceBranchId = input.deviceBranchId;
  return doc;
}

/** Same-transaction write: the event commits iff the mutation commits. */
export function recordSecurityAuditEventInTx(
  database: Firestore,
  tx: Transaction,
  input: SecurityAuditEventInput,
): void {
  tx.set(database.collection(SECURITY_AUDIT_EVENTS_COLLECTION).doc(randomUUID()), eventDoc(input));
}

/** Standalone write for mutations that are not a Firestore transaction (LCT1 issuance). */
export async function recordSecurityAuditEvent(
  database: Firestore,
  input: SecurityAuditEventInput,
): Promise<void> {
  await database.collection(SECURITY_AUDIT_EVENTS_COLLECTION).doc(randomUUID()).set(eventDoc(input));
}
