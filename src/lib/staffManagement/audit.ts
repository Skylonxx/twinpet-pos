import {
  collection,
  doc,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import { collections } from '../firebase';
import type { AuditLog, StaffActivity } from '../types';

export type AuditContext = {
  firestore: Firestore;
  changedBy: string;
  changedByName: string;
};

export async function writeStaffActivity(
  ctx: AuditContext,
  input: {
    branchId: string;
    userId: string;
    userName: string;
    action: string;
    detail: string;
    refId?: string | null;
    ip?: string | null;
    deviceId?: string | null;
  },
): Promise<void> {
  const ref = doc(collection(ctx.firestore, collections.staffActivities));
  const row: StaffActivity = {
    id: ref.id,
    branchId: input.branchId,
    userId: input.userId,
    userName: input.userName,
    action: input.action,
    detail: input.detail,
    refId: input.refId ?? null,
    ip: input.ip ?? null,
    deviceId: input.deviceId ?? null,
    createdAt: serverTimestamp() as never,
  };
  await setDoc(ref, row);
}

export async function writeUserAuditLog(
  ctx: AuditContext,
  input: {
    docId: string;
    action: AuditLog['action'];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    changedFields: string[];
    reason?: string | null;
  },
): Promise<void> {
  const ref = doc(collection(ctx.firestore, collections.auditLogs));
  const row: AuditLog = {
    id: ref.id,
    collection: 'users',
    docId: input.docId,
    action: input.action,
    before: input.before,
    after: input.after,
    changedFields: input.changedFields,
    reason: input.reason ?? null,
    changedBy: ctx.changedBy,
    changedByName: ctx.changedByName,
    changedAt: serverTimestamp() as never,
  };
  await setDoc(ref, row);
}

export function diffUserFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): { before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const f of fields) {
    const bv = JSON.stringify(before[f]);
    const av = JSON.stringify(after[f]);
    if (bv !== av) {
      changed.push(f);
      b[f] = before[f];
      a[f] = after[f];
    }
  }
  return { before: b, after: a, changed };
}
