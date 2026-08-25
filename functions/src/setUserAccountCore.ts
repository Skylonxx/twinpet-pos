/**
 * Canonical account/credential mutation core (Model C1 create + rotate namespace).
 * Admin SDK only. PIN is never logged, never hashed into payloadHash, never
 * inspected on create/rotate replay.
 */
import bcrypt from 'bcryptjs';
import { FieldValue, type DocumentData, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  canonicalJSON,
  isCredentialState,
  normalizeUsername,
  sha256Hex,
  sha256Slice40,
  type CredentialState,
} from './credentialStore';

const BCRYPT_COST = 10;
const PIN_RE = /^\d{4}$/;

export type SetUserAccountActor =
  | { kind: 'staff'; staffId: string; authVersion: number }
  | { kind: 'operator_cli' };

export type SetUserAccountOp =
  | {
      op: 'create';
      idempotencyKey: string;
      username: string;
      firstName: string;
      lastName: string;
      role: 'admin' | 'manager' | 'staff';
      branchIds: string[];
      permissions: Record<string, unknown>;
      isActive: boolean;
      pin: string;
    }
  | {
      op: 'rotate';
      rotateIdempotencyKey: string;
      userId: string;
      pin: string;
      reasonCode?: string;
    }
  | {
      op: 'updateProfile';
      userId: string;
      firstName?: string;
      lastName?: string;
      role?: 'admin' | 'manager' | 'staff';
      branchIds?: string[];
      permissions?: Record<string, unknown>;
    }
  | { op: 'setActive'; userId: string; isActive: boolean }
  | { op: 'softDelete'; userId: string }
  | { op: 'rename'; userId: string; newUsername: string };

export type SetUserAccountStatus =
  | 'created'
  | 'duplicate_confirmed'
  | 'updated'
  | 'rotated'
  | 'conflict_requires_manual_review'
  | 'username_reservation_conflict'
  | 'unexpected_existing_resource'
  | 'maintenance_blocked'
  | 'reservations_incomplete'
  | 'unauthorized'
  | 'not_found'
  | 'invalid_argument';

export type SetUserAccountResult = {
  ok: boolean;
  status: SetUserAccountStatus;
  userId?: string;
  authVersion?: number;
  credentialVersion?: number;
  message?: string;
};

export function createUserIdFromKey(idempotencyKey: string): string {
  return sha256Slice40(`setUserAccount:create:userId:${idempotencyKey}`);
}

export function createIntentIdFromKey(idempotencyKey: string): string {
  return sha256Slice40(`setUserAccount:create:intent:${idempotencyKey}`);
}

export function rotateIntentIdFromKey(rotateIdempotencyKey: string): string {
  return sha256Slice40(`setUserAccount:rotate:intent:${rotateIdempotencyKey}`);
}

export function createPayloadHash(input: {
  username: string;
  firstName: string;
  lastName: string;
  role: string;
  branchIds: string[];
  permissions: Record<string, unknown>;
  isActive: boolean;
}): string {
  const branchIds = [...input.branchIds].sort();
  return sha256Hex(
    canonicalJSON([
      input.username,
      input.firstName,
      input.lastName,
      input.role,
      branchIds,
      input.permissions,
      input.isActive,
    ]),
  );
}

export function rotatePayloadHash(userId: string, reasonCode: string): string {
  return sha256Hex(canonicalJSON([userId, reasonCode]));
}

function invalid(status: SetUserAccountStatus, message: string): SetUserAccountResult {
  return { ok: false, status, message };
}

function asUser(data: DocumentData | undefined): DocumentData {
  return data ?? {};
}

async function assertActor(
  database: Firestore,
  tx: Transaction,
  actor: SetUserAccountActor,
): Promise<SetUserAccountResult | null> {
  if (actor.kind === 'operator_cli') return null;
  const snap = await tx.get(database.collection(COLLECTIONS.users).doc(actor.staffId));
  if (!snap.exists) return invalid('unauthorized', 'ไม่พบผู้ดำเนินการ');
  const user = asUser(snap.data());
  if (user.isActive !== true || user.deletedAt != null) return invalid('unauthorized', 'ผู้ดำเนินการไม่มีสิทธิ์');
  if (user.role !== 'admin') return invalid('unauthorized', 'เฉพาะผู้ดูแลระบบ');
  const live = typeof user.authVersion === 'number' ? user.authVersion : 0;
  if (live !== actor.authVersion) return invalid('unauthorized', 'สิทธิ์หมดอายุ กรุณาเข้าสู่ระบบใหม่');
  return null;
}

async function readReservationsMarker(
  database: Firestore,
  tx: Transaction,
): Promise<{ complete: boolean; maintenanceMode: boolean; epoch: number }> {
  const snap = await tx.get(
    database.collection(COLLECTIONS.migrationControl).doc(USERNAME_RESERVATIONS_ID),
  );
  const data = asUser(snap.data());
  return {
    complete: data.complete === true,
    maintenanceMode: data.maintenanceMode === true,
    epoch: typeof data.epoch === 'number' ? data.epoch : 0,
  };
}

const USERNAME_RESERVATIONS_ID = 'usernameReservations';

async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_COST);
}

function bumpAuthVersion(tx: Transaction, database: Firestore, userId: string): void {
  tx.update(database.collection(COLLECTIONS.users).doc(userId), {
    authVersion: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function handleCreate(
  database: Firestore,
  tx: Transaction,
  actor: SetUserAccountActor,
  cmd: Extract<SetUserAccountOp, { op: 'create' }>,
): Promise<SetUserAccountResult> {
  const denied = await assertActor(database, tx, actor);
  if (denied) return denied;
  if (!PIN_RE.test(cmd.pin)) return invalid('invalid_argument', 'PIN ต้องเป็นตัวเลข 4 หลัก');
  const username = normalizeUsername(cmd.username);
  if (!username) return invalid('invalid_argument', 'กรุณาระบุ username');

  const intentId = createIntentIdFromKey(cmd.idempotencyKey);
  const userId = createUserIdFromKey(cmd.idempotencyKey);
  const payloadHash = createPayloadHash({
    username,
    firstName: cmd.firstName.trim(),
    lastName: cmd.lastName.trim(),
    role: cmd.role,
    branchIds: cmd.branchIds,
    permissions: cmd.permissions,
    isActive: cmd.isActive,
  });
  void cmd.pin;

  const intentRef = database.collection(COLLECTIONS.userAccountCommandIntents).doc(intentId);
  const intentSnap = await tx.get(intentRef);
  if (intentSnap.exists) {
    const intent = asUser(intentSnap.data());
    if (intent.payloadHash === payloadHash) {
      return {
        ok: true,
        status: 'duplicate_confirmed',
        userId: typeof intent.userId === 'string' ? intent.userId : userId,
      };
    }
    return invalid('conflict_requires_manual_review', 'คำสั่งซ้ำแต่ข้อมูลไม่ตรงกัน');
  }

  const userRef = database.collection(COLLECTIONS.users).doc(userId);
  const userSnap = await tx.get(userRef);
  if (userSnap.exists) return invalid('unexpected_existing_resource', 'พบรหัสผู้ใช้ซ้ำ');

  const marker = await readReservationsMarker(database, tx);
  if (!marker.complete) return invalid('reservations_incomplete', 'ระบบจองชื่อผู้ใช้ยังไม่พร้อม');
  if (marker.maintenanceMode) return invalid('maintenance_blocked', 'ระบบกำลังปิดปรับปรุงชื่อผู้ใช้');

  const usernameRef = database.collection(COLLECTIONS.usernames).doc(username);
  const usernameSnap = await tx.get(usernameRef);
  if (usernameSnap.exists) return invalid('username_reservation_conflict', 'username นี้ถูกใช้แล้ว');

  const pinHash = await hashPin(cmd.pin);
  const actorId = actor.kind === 'operator_cli' ? 'OPERATOR_CLI' : actor.staffId;
  const now = FieldValue.serverTimestamp();

  tx.set(userRef, {
    id: userId,
    firstName: cmd.firstName.trim(),
    lastName: cmd.lastName.trim(),
    username,
    role: cmd.role,
    branchIds: cmd.branchIds,
    permissions: cmd.permissions,
    isActive: cmd.isActive,
    authVersion: 0,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  tx.set(database.collection(COLLECTIONS.userCredentials).doc(userId), {
    pinHash,
    algo: 'bcrypt',
    cost: BCRYPT_COST,
    credentialVersion: 0,
    credentialState: 'rotated_authoritative' satisfies CredentialState,
    disabled: false,
    updatedAt: now,
    updatedBy: actorId,
  });
  tx.set(usernameRef, { userId, reservedAt: now });
  tx.set(intentRef, {
    idempotencyKey: cmd.idempotencyKey,
    payloadHash,
    userId,
    status: 'created',
    createdAt: now,
  });
  return { ok: true, status: 'created', userId, authVersion: 0, credentialVersion: 0 };
}

async function handleRotate(
  database: Firestore,
  tx: Transaction,
  actor: SetUserAccountActor,
  cmd: Extract<SetUserAccountOp, { op: 'rotate' }>,
): Promise<SetUserAccountResult> {
  const denied = await assertActor(database, tx, actor);
  if (denied) return denied;
  if (!PIN_RE.test(cmd.pin)) return invalid('invalid_argument', 'PIN ต้องเป็นตัวเลข 4 หลัก');
  const userId = String(cmd.userId ?? '').trim();
  if (!userId) return invalid('invalid_argument', 'ต้องระบุ userId');
  const reasonCode = cmd.reasonCode ?? '';
  const intentId = rotateIntentIdFromKey(cmd.rotateIdempotencyKey);
  const payloadHash = rotatePayloadHash(userId, reasonCode);
  void cmd.pin;

  const intentRef = database.collection(COLLECTIONS.userAccountCommandIntents).doc(intentId);
  const intentSnap = await tx.get(intentRef);
  if (intentSnap.exists) {
    const intent = asUser(intentSnap.data());
    if (intent.payloadHash === payloadHash) {
      return {
        ok: true,
        status: 'duplicate_confirmed',
        userId,
        credentialVersion: typeof intent.credentialVersion === 'number' ? intent.credentialVersion : undefined,
        authVersion: typeof intent.authVersion === 'number' ? intent.authVersion : undefined,
      };
    }
    return invalid('conflict_requires_manual_review', 'คำสั่งหมุน PIN ซ้ำแต่ข้อมูลไม่ตรงกัน');
  }

  const userRef = database.collection(COLLECTIONS.users).doc(userId);
  const userSnap = await tx.get(userRef);
  if (!userSnap.exists) return invalid('not_found', 'ไม่พบผู้ใช้');

  const credRef = database.collection(COLLECTIONS.userCredentials).doc(userId);
  const credSnap = await tx.get(credRef);
  const cred = asUser(credSnap.data());
  const nextCredVersion = (typeof cred.credentialVersion === 'number' ? cred.credentialVersion : 0) + 1;
  const pinHash = await hashPin(cmd.pin);
  const actorId = actor.kind === 'operator_cli' ? 'OPERATOR_CLI' : actor.staffId;
  const now = FieldValue.serverTimestamp();

  tx.set(
    credRef,
    {
      pinHash,
      algo: 'bcrypt',
      cost: BCRYPT_COST,
      credentialVersion: nextCredVersion,
      credentialState: 'rotated_authoritative' satisfies CredentialState,
      disabled: false,
      updatedAt: now,
      updatedBy: actorId,
    },
    { merge: true },
  );
  bumpAuthVersion(tx, database, userId);
  const liveUser = asUser(userSnap.data());
  const nextAuth = (typeof liveUser.authVersion === 'number' ? liveUser.authVersion : 0) + 1;
  tx.set(intentRef, {
    idempotencyKey: cmd.rotateIdempotencyKey,
    payloadHash,
    userId,
    status: 'rotated',
    credentialVersion: nextCredVersion,
    authVersion: nextAuth,
    createdAt: now,
  });
  return {
    ok: true,
    status: 'rotated',
    userId,
    credentialVersion: nextCredVersion,
    authVersion: nextAuth,
  };
}

async function handleUpdateProfile(
  database: Firestore,
  tx: Transaction,
  actor: SetUserAccountActor,
  cmd: Extract<SetUserAccountOp, { op: 'updateProfile' }>,
): Promise<SetUserAccountResult> {
  const denied = await assertActor(database, tx, actor);
  if (denied) return denied;
  const userId = String(cmd.userId ?? '').trim();
  if (!userId) return invalid('invalid_argument', 'ต้องระบุ userId');
  const userRef = database.collection(COLLECTIONS.users).doc(userId);
  const userSnap = await tx.get(userRef);
  if (!userSnap.exists) return invalid('not_found', 'ไม่พบผู้ใช้');
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof cmd.firstName === 'string') patch.firstName = cmd.firstName.trim();
  if (typeof cmd.lastName === 'string') patch.lastName = cmd.lastName.trim();
  if (cmd.role) patch.role = cmd.role;
  if (cmd.branchIds) patch.branchIds = cmd.branchIds;
  if (cmd.permissions) patch.permissions = cmd.permissions;
  tx.update(userRef, patch);
  bumpAuthVersion(tx, database, userId);
  const live = asUser(userSnap.data());
  return {
    ok: true,
    status: 'updated',
    userId,
    authVersion: (typeof live.authVersion === 'number' ? live.authVersion : 0) + 1,
  };
}

async function handleSetActive(
  database: Firestore,
  tx: Transaction,
  actor: SetUserAccountActor,
  cmd: Extract<SetUserAccountOp, { op: 'setActive' }>,
): Promise<SetUserAccountResult> {
  const denied = await assertActor(database, tx, actor);
  if (denied) return denied;
  const userId = String(cmd.userId ?? '').trim();
  if (!userId) return invalid('invalid_argument', 'ต้องระบุ userId');
  const userRef = database.collection(COLLECTIONS.users).doc(userId);
  const userSnap = await tx.get(userRef);
  if (!userSnap.exists) return invalid('not_found', 'ไม่พบผู้ใช้');
  tx.update(userRef, {
    isActive: cmd.isActive === true,
    updatedAt: FieldValue.serverTimestamp(),
  });
  bumpAuthVersion(tx, database, userId);
  const live = asUser(userSnap.data());
  return {
    ok: true,
    status: 'updated',
    userId,
    authVersion: (typeof live.authVersion === 'number' ? live.authVersion : 0) + 1,
  };
}

async function handleSoftDelete(
  database: Firestore,
  tx: Transaction,
  actor: SetUserAccountActor,
  cmd: Extract<SetUserAccountOp, { op: 'softDelete' }>,
): Promise<SetUserAccountResult> {
  const denied = await assertActor(database, tx, actor);
  if (denied) return denied;
  const userId = String(cmd.userId ?? '').trim();
  if (!userId) return invalid('invalid_argument', 'ต้องระบุ userId');
  const userRef = database.collection(COLLECTIONS.users).doc(userId);
  const userSnap = await tx.get(userRef);
  if (!userSnap.exists) return invalid('not_found', 'ไม่พบผู้ใช้');
  const username = normalizeUsername(String(asUser(userSnap.data()).username ?? ''));
  tx.update(userRef, {
    deletedAt: FieldValue.serverTimestamp(),
    isActive: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  bumpAuthVersion(tx, database, userId);
  if (username) {
    const unameRef = database.collection(COLLECTIONS.usernames).doc(username);
    const unameSnap = await tx.get(unameRef);
    if (unameSnap.exists && asUser(unameSnap.data()).userId === userId) {
      tx.delete(unameRef);
    }
  }
  const live = asUser(userSnap.data());
  return {
    ok: true,
    status: 'updated',
    userId,
    authVersion: (typeof live.authVersion === 'number' ? live.authVersion : 0) + 1,
  };
}

async function handleRename(
  database: Firestore,
  tx: Transaction,
  actor: SetUserAccountActor,
  cmd: Extract<SetUserAccountOp, { op: 'rename' }>,
): Promise<SetUserAccountResult> {
  const denied = await assertActor(database, tx, actor);
  if (denied) return denied;
  const userId = String(cmd.userId ?? '').trim();
  const newUsername = normalizeUsername(cmd.newUsername);
  if (!userId || !newUsername) return invalid('invalid_argument', 'ต้องระบุ userId และ username');
  const marker = await readReservationsMarker(database, tx);
  if (!marker.complete) return invalid('reservations_incomplete', 'ระบบจองชื่อผู้ใช้ยังไม่พร้อม');
  if (marker.maintenanceMode) return invalid('maintenance_blocked', 'ระบบกำลังปิดปรับปรุงชื่อผู้ใช้');

  const userRef = database.collection(COLLECTIONS.users).doc(userId);
  const userSnap = await tx.get(userRef);
  if (!userSnap.exists) return invalid('not_found', 'ไม่พบผู้ใช้');
  const current = normalizeUsername(String(asUser(userSnap.data()).username ?? ''));
  if (current === newUsername) {
    return { ok: true, status: 'updated', userId };
  }
  const newRef = database.collection(COLLECTIONS.usernames).doc(newUsername);
  const newSnap = await tx.get(newRef);
  if (newSnap.exists) return invalid('username_reservation_conflict', 'username นี้ถูกใช้แล้ว');
  if (current) {
    const oldRef = database.collection(COLLECTIONS.usernames).doc(current);
    const oldSnap = await tx.get(oldRef);
    if (oldSnap.exists && asUser(oldSnap.data()).userId === userId) {
      tx.delete(oldRef);
    }
  }
  tx.set(newRef, { userId, reservedAt: FieldValue.serverTimestamp() });
  tx.update(userRef, { username: newUsername, updatedAt: FieldValue.serverTimestamp() });
  bumpAuthVersion(tx, database, userId);
  const live = asUser(userSnap.data());
  return {
    ok: true,
    status: 'updated',
    userId,
    authVersion: (typeof live.authVersion === 'number' ? live.authVersion : 0) + 1,
  };
}

export async function performSetUserAccount(
  database: Firestore,
  actor: SetUserAccountActor,
  command: SetUserAccountOp,
): Promise<SetUserAccountResult> {
  return database.runTransaction(async (tx) => {
    switch (command.op) {
      case 'create':
        return handleCreate(database, tx, actor, command);
      case 'rotate':
        return handleRotate(database, tx, actor, command);
      case 'updateProfile':
        return handleUpdateProfile(database, tx, actor, command);
      case 'setActive':
        return handleSetActive(database, tx, actor, command);
      case 'softDelete':
        return handleSoftDelete(database, tx, actor, command);
      case 'rename':
        return handleRename(database, tx, actor, command);
      default:
        return invalid('invalid_argument', 'คำสั่งไม่รองรับ');
    }
  });
}

export function isKnownCredentialState(value: unknown): boolean {
  return isCredentialState(value);
}
