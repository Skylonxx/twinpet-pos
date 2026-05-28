import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { auth, authEmailForUsername, collections, db, isFirebaseConfigured } from '../firebase';
import { ensureFirebaseAuth } from '../firebaseAuth';
import type { User } from '../types';
import {
  findDevUserByPin,
  findDevUserByUsernamePassword,
} from './devUsers';
import {
  clearSession,
  loadSession,
  saveSession,
  type AuthSession,
} from './session';
import { verifyPinLogin } from './verifyPinLogin';

export type AuthContextValue = {
  session: AuthSession | null;
  user: User | null;
  branchId: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  firebaseUser: FirebaseUser | null;
  loginWithPin: (pin: string, branchId: string) => Promise<User>;
  loginWithUsername: (
    username: string,
    password: string,
    branchId: string,
  ) => Promise<User>;
  completeLogin: (user: User, branchId: string) => Promise<void>;
  logout: () => Promise<void>;
  setBranchId: (branchId: string) => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

function isActiveUser(user: User): boolean {
  return user.isActive && user.deletedAt == null;
}

function assertBranchAccess(user: User, branchId: string): void {
  if (!user.branchIds.includes(branchId)) {
    throw new Error('คุณไม่มีสิทธิ์เข้าถึงสาขานี้');
  }
}

async function fetchUserById(userId: string): Promise<User | null> {
  if (!db) return null;
  const direct = await getDoc(doc(db, collections.users, userId));
  if (!direct.exists()) return null;
  const data = direct.data() as User;
  return { ...data, id: direct.id, pin: '' };
}

async function touchLastLogin(userId: string): Promise<void> {
  if (!db) return;
  try {
    await updateDoc(doc(db, collections.users, userId), {
      lastLoginAt: serverTimestamp(),
    });
  } catch {
    // Cloud Function updates lastLoginAt for PIN flow; ignore failures offline
  }
}

async function establishSession(
  user: User,
  branchId: string,
): Promise<AuthSession> {
  assertBranchAccess(user, branchId);
  const session: AuthSession = {
    user: { ...user, pin: '' },
    branchId,
  };
  saveSession(session);
  await touchLastLogin(user.id);
  return session;
}

type AuthProviderProps = {
  children: ReactNode;
};

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!auth || !isFirebaseConfigured) {
      setIsLoading(false);
      return;
    }

    return onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);

      // Email/password login — sync TwinPet user from Firebase UID
      if (fbUser && !fbUser.isAnonymous) {
        const stored = loadSession();
        if (!stored || stored.user.id !== fbUser.uid) {
          const user = await fetchUserById(fbUser.uid);
          if (user && isActiveUser(user)) {
            const branchId =
              stored?.branchId && user.branchIds.includes(stored.branchId)
                ? stored.branchId
                : user.branchIds[0];
            if (branchId) {
              const next = { user, branchId };
              setSession(next);
              saveSession(next);
            }
          }
        }
      }

      // Restore anonymous auth for an existing POS session (offline / page reload)
      if (!fbUser && loadSession()) {
        try {
          await ensureFirebaseAuth();
        } catch (err) {
          console.warn('[auth] could not restore anonymous Firebase session', err);
        }
      }

      setIsLoading(false);
    });
  }, []);

  const loginWithPin = useCallback(async (pin: string, branchId: string) => {
    const normalizedPin = pin.trim();
    if (!/^\d{4}$/.test(normalizedPin)) {
      throw new Error('PIN ต้องเป็นตัวเลข 4 หลัก');
    }
    if (!branchId) {
      throw new Error('กรุณาเลือกสาขา');
    }

    if (isFirebaseConfigured && auth) {
      try {
        await ensureFirebaseAuth();
        if (!auth.currentUser) {
          throw new Error(
            'Firebase Auth ไม่พร้อม — เปิด Anonymous Authentication ใน Firebase Console',
          );
        }
        await auth.currentUser.getIdToken(true);
        const user = await verifyPinLogin(normalizedPin, branchId);
        await auth.currentUser.getIdToken(true);
        if (!isActiveUser(user)) {
          throw new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
        }
        return user;
      } catch (err) {
        console.error('[auth] loginWithPin failed', err);
        throw err instanceof Error ? err : new Error('ไม่สามารถยืนยัน PIN ได้');
      }
    }

    if (import.meta.env.DEV) {
      const user = await findDevUserByPin(normalizedPin, branchId);
      if (user && isActiveUser(user)) {
        return { ...user, pin: '' };
      }
    }

    throw new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
  }, []);

  const completeLogin = useCallback(async (user: User, branchId: string) => {
    const nextSession = await establishSession(user, branchId);
    setSession(nextSession);
  }, []);

  const loginWithUsername = useCallback(
    async (username: string, password: string, branchId: string) => {
      const normalizedUsername = username.trim().toLowerCase();
      if (!normalizedUsername || !password) {
        throw new Error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
      }

      let user: User | null = null;

      if (isFirebaseConfigured && auth) {
        try {
          await signInWithEmailAndPassword(
            auth,
            authEmailForUsername(normalizedUsername),
            password,
          );
          const fbUser = auth.currentUser;
          if (fbUser) {
            await fbUser.getIdToken(true);
            user = await fetchUserById(fbUser.uid);
          }
        } catch {
          // fall through to dev mock in DEV
        }
      }

      if (!user && import.meta.env.DEV) {
        user = await findDevUserByUsernamePassword(
          normalizedUsername,
          password,
          branchId,
        );
      }

      if (!user || !isActiveUser(user)) {
        throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      }

      return { ...user, pin: '' };
    },
    [],
  );

  const logout = useCallback(async () => {
    clearSession();
    setSession(null);
    if (auth) {
      await signOut(auth);
    }
  }, []);

  const setBranchId = useCallback(
    (branchId: string) => {
      setSession((prev) => {
        if (!prev) return prev;
        assertBranchAccess(prev.user, branchId);
        const next = { ...prev, branchId };
        saveSession(next);
        return next;
      });
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      branchId: session?.branchId ?? null,
      isLoading,
      isAuthenticated: session != null,
      firebaseUser,
      loginWithPin,
      loginWithUsername,
      completeLogin,
      logout,
      setBranchId,
    }),
    [
      session,
      isLoading,
      firebaseUser,
      loginWithPin,
      loginWithUsername,
      completeLogin,
      logout,
      setBranchId,
    ],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}
