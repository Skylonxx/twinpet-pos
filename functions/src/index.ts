import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({ region: 'asia-southeast1' });

initializeApp();

const db = getFirestore();

type UserRole = 'admin' | 'manager' | 'staff';

type UserDoc = {
  id?: string;
  firstName: string;
  lastName: string;
  username: string;
  pin: string;
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
  lastLoginAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
};

type VerifyPinLoginRequest = {
  pin?: string;
  branchId?: string;
  username?: string;
  userId?: string;
};

type SanitizedUser = Omit<UserDoc, 'pin'> & { id: string };

function serializeUser(user: UserDoc, id: string): SanitizedUser {
  const { pin: _pin, ...rest } = user;
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
  if (!user.branchIds?.includes(branchId)) {
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

async function findUserByPinInBranch(
  pin: string,
  branchId: string,
  username?: string,
  userId?: string,
): Promise<{ user: UserDoc; id: string } | null> {
  if (userId) {
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) return null;
    const user = snap.data() as UserDoc;
    if (!(await pinMatches(user.pin, pin))) return null;
    assertActiveBranchUser(user, branchId);
    return { user, id: snap.id };
  }

  if (username) {
    const normalized = username.trim().toLowerCase();
    const snap = await db
      .collection('users')
      .where('username', '==', normalized)
      .where('branchIds', 'array-contains', branchId)
      .where('isActive', '==', true)
      .limit(5)
      .get();

    for (const docSnap of snap.docs) {
      const user = docSnap.data() as UserDoc;
      if (user.deletedAt != null) continue;
      if (await pinMatches(user.pin, pin)) {
        return { user, id: docSnap.id };
      }
    }
    return null;
  }

  const snap = await db
    .collection('users')
    .where('branchIds', 'array-contains', branchId)
    .where('isActive', '==', true)
    .get();

  for (const docSnap of snap.docs) {
    const user = docSnap.data() as UserDoc;
    if (user.deletedAt != null || !user.pin) continue;
    if (await pinMatches(user.pin, pin)) {
      return { user, id: docSnap.id };
    }
  }

  return null;
}

export const verifyPinLogin = onCall(
  {
    invoker: 'public',
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    try {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบ Firebase ก่อนยืนยัน PIN');
      }

      const data = (request.data ?? {}) as VerifyPinLoginRequest;
      const pin = String(data.pin ?? '').trim();
      const branchId = String(data.branchId ?? '').trim();
      const username = data.username ? String(data.username).trim().toLowerCase() : undefined;
      const userId = data.userId ? String(data.userId).trim() : undefined;

      if (!/^\d{4}$/.test(pin)) {
        throw new HttpsError('invalid-argument', 'PIN ต้องเป็นตัวเลข 4 หลัก');
      }
      if (!branchId) {
        throw new HttpsError('invalid-argument', 'กรุณาระบุสาขา');
      }

      const match = await findUserByPinInBranch(pin, branchId, username, userId);
      if (!match) {
        throw new HttpsError('permission-denied', 'PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
      }

      const staffId = match.id;
      const user = match.user;

      await getAuth().setCustomUserClaims(request.auth.uid, {
        staffId,
        role: user.role,
        branchIds: user.branchIds,
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
