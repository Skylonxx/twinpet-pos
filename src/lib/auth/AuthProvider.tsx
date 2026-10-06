import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, app, authEmailForUsername, collections, db, isFirebaseConfigured } from '../firebase';
import {
  ensureAnonymousFirebaseAuthForPin,
  ensureAnonymousFirebaseIdentity,
  ensureFirebaseAuth,
} from '../firebaseAuth';
import type { User } from '../types';
import { hasUidBoundEnrollmentRecoveryEvidence } from './deviceRegistration';
import { AuthOperationSupersededError } from './authOperationError';
import { EnrollmentIdentityError, isEnrollmentIdentityError } from './enrollmentIdentityError';
import { claimEnrollmentGrantMinter, type EnrollmentPreparationGrant } from './enrollmentGrant';
import { asPinIdentityStep, PinIdentityError } from './pinIdentityError';
import {
  assertDeviceGateOpen,
  DeviceNotReadyError,
  isDeviceGateOpen,
  isNativeTauriRuntime,
  readNativeDeviceReadiness,
  type NativeDeviceReadiness,
} from './nativeDeviceReadiness';
import { getNativeStaffSessionInvoke } from './refreshStaffSession';
import {
  findDevUserByPin,
  findDevUserByUsernamePassword,
} from './devUsers';
import {
  clearSession,
  loadSession,
  saveSession,
  SESSION_SCHEMA_VERSION,
  type AuthSession,
} from './session';
import { verifyPinLogin } from './verifyPinLogin';

export type AuthContextValue = {
  session: AuthSession | null;
  user: User | null;
  branchId: string | null;
  isLoading: boolean;
  /**
   * True only when an app session exists AND the device gate is open (web, or
   * native with READY readiness). On a native POS that is not READY the stored
   * session is kept but withheld (`session`/`user`/`branchId` read as null).
   */
  isAuthenticated: boolean;
  firebaseUser: FirebaseUser | null;
  /** TPOS-R7 device-wide native enrollment gate ('not_native' on web). */
  deviceReadiness: NativeDeviceReadiness | 'checking';
  /** Re-reads strong native readiness and updates the gate; returns the fresh value. */
  refreshDeviceReadiness: () => Promise<NativeDeviceReadiness>;
  loginWithPin: (pin: string, branchId: string, username: string) => Promise<User>;
  loginWithUsername: (
    username: string,
    password: string,
    branchId: string,
  ) => Promise<User>;
  completeLogin: (user: User, branchId: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * TPOS-R7 first device enrollment: ends any app staff session and moves
   * Firebase to a dedicated anonymous identity (reused if already anonymous),
   * so `beginDeviceRegistration` never binds a password/provider UID. Fails
   * closed with a fixed `EnrollmentIdentityError`. Resolves to a one-shot
   * grant: pass it unchanged to `registerDevice` as `enrollmentGrant`.
   */
  prepareEnrollmentIdentity: () => Promise<EnrollmentPreparationGrant>;
  setBranchId: (branchId: string) => Promise<void> | void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

function isActiveUser(user: User): boolean {
  return user.isActive && user.deletedAt == null;
}

function assertBranchAccess(user: User, branchId: string): void {
  // Global Admins (branchIds: ['ALL']) may establish a session for any branch,
  // including the sentinel 'ALL' itself which is used for cross-branch admin work.
  if (user.branchIds.includes('ALL')) return;
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

// Synchronous on purpose: the caller's last operation-fence check and the
// save happen with no await in between.
function establishSession(user: User, branchId: string): AuthSession {
  assertBranchAccess(user, branchId);
  const session: AuthSession = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    issuedAt: Date.now(),
    user: { ...user, pin: '' },
    branchId,
  };
  saveSession(session);
  return session;
}

type InteractiveAuthMode = 'pin' | 'password';

/** The one login result `completeLogin` may turn into an app session. */
type PendingCompletion = {
  op: number;
  mode: InteractiveAuthMode;
  /** Firebase UID the operation authenticated; null only on the no-Firebase dev path. */
  firebaseUid: string | null;
  userId: string;
};

// TPOS-R7: this module is the only issuer of first-enrollment grants; only a
// completed `prepareEnrollmentIdentity()` mints one.
const mintEnrollmentGrant = claimEnrollmentGrantMinter();

type AuthProviderProps = {
  children: ReactNode;
};

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const lastPersistedStaffIdRef = useRef<string | null>(null);
  // Identity fence: bumped on every auth-state callback and on a Quick PIN
  // identity transition. An async restore may save an app session only if no
  // newer identity event happened while it was awaiting.
  const identityGenerationRef = useRef(0);
  // Interactive auth fence: password login and Quick PIN are mutually
  // exclusive. Each starts a new operation (superseding any older one); a
  // result may become an app session only while its operation is still the
  // latest AND Firebase is still on the UID that operation authenticated.
  const authOpRef = useRef(0);
  const pendingCompletionRef = useRef<PendingCompletion | null>(null);

  const beginAuthOp = useCallback(() => {
    pendingCompletionRef.current = null;
    authOpRef.current += 1;
    return authOpRef.current;
  }, []);

  const isAuthOpCurrent = useCallback((op: number, firebaseUid: string | null) => {
    if (authOpRef.current !== op) return false;
    return firebaseUid === null || auth?.currentUser?.uid === firebaseUid;
  }, []);

  const assertAuthOpCurrent = useCallback(
    (op: number, firebaseUid: string | null) => {
      if (!isAuthOpCurrent(op, firebaseUid)) throw new AuthOperationSupersededError();
    },
    [isAuthOpCurrent],
  );

  const markCompletable = useCallback(
    (op: number, mode: InteractiveAuthMode, firebaseUid: string | null, userId: string) => {
      assertAuthOpCurrent(op, firebaseUid);
      pendingCompletionRef.current = { op, mode, firebaseUid, userId };
    },
    [assertAuthOpCurrent],
  );
  // TPOS-R7: one device-wide gate. Never signs out / replaces the Firebase UID
  // to enforce itself (an explicit enrollment recovery may be bound to it).
  const [deviceReadiness, setDeviceReadiness] = useState<NativeDeviceReadiness | 'checking'>(() =>
    isNativeTauriRuntime() ? 'checking' : 'not_native',
  );

  const refreshDeviceReadiness = useCallback(async () => {
    const next = await readNativeDeviceReadiness();
    setDeviceReadiness(next);
    return next;
  }, []);

  useEffect(() => {
    if (!isNativeTauriRuntime()) return;
    let cancelled = false;
    void readNativeDeviceReadiness().then((next) => {
      if (!cancelled) setDeviceReadiness(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!auth || !isFirebaseConfigured) {
      setIsLoading(false);
      return;
    }

    return onAuthStateChanged(auth, async (fbUser) => {
      const generation = ++identityGenerationRef.current;
      setFirebaseUser(fbUser);

      // Email/password login — sync TwinPet user from Firebase UID
      if (fbUser && !fbUser.isAnonymous) {
        const stored = loadSession();
        if (!stored || stored.user.id !== fbUser.uid) {
          const user = await fetchUserById(fbUser.uid);
          const stillCurrent =
            identityGenerationRef.current === generation && auth?.currentUser?.uid === fbUser.uid;
          if (stillCurrent && user && isActiveUser(user)) {
            const branchId =
              stored?.branchId && user.branchIds.includes(stored.branchId)
                ? stored.branchId
                : user.branchIds[0];
            if (branchId) {
              const next = {
                schemaVersion: SESSION_SCHEMA_VERSION,
                issuedAt: Date.now(),
                user,
                branchId,
              };
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

  const loginWithPin = useCallback(async (pin: string, branchId: string, username: string) => {
    const normalizedPin = pin.trim();
    const normalizedUsername = username.trim().toLowerCase();
    if (!/^\d{4}$/.test(normalizedPin)) {
      throw new Error('PIN ต้องเป็นตัวเลข 4 หลัก');
    }
    if (!normalizedUsername) {
      throw new Error('กรุณากรอกชื่อผู้ใช้');
    }
    if (!branchId) {
      throw new Error('กรุณาเลือกสาขา');
    }

    const op = beginAuthOp();

    if (isFirebaseConfigured && auth) {
      try {
        // Native POS: strong device readiness BEFORE the PIN reaches the
        // server, so a not-READY machine never gets staff claims stamped.
        const readiness = await refreshDeviceReadiness();
        assertDeviceGateOpen(readiness);
        const isNative = readiness !== 'not_native';
        // A superseded PIN attempt must not touch the Firebase identity.
        assertAuthOpCurrent(op, null);

        // TPOS-R7 PIN identity isolation: Quick PIN runs only under a proven
        // anonymous Firebase identity. A password/federated session is left
        // (never reused) — unless a UID-bound enrollment recovery is pending.
        const pinIdentity = await ensureAnonymousFirebaseAuthForPin({
          beforeLeavingNonAnonymous: async (departing) => {
            // Exact departing identity, captured by the helper before any await.
            const departingUid = departing.uid;
            assertAuthOpCurrent(op, departingUid);
            if (hasUidBoundEnrollmentRecoveryEvidence()) {
              throw new PinIdentityError('PIN_IDENTITY_TRANSITION_BLOCKED');
            }
            // Fence any in-flight restore of the departing account's session.
            identityGenerationRef.current += 1;
            // Leaving that account ends its native staff session and app session.
            const invoke = getNativeStaffSessionInvoke();
            if (invoke) {
              try {
                await invoke('native_clear_staff_session');
              } catch {
                throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
              }
            }
            // A newer login may have taken over while that was awaited: then
            // this attempt must not clear its session nor sign it out.
            assertAuthOpCurrent(op, departingUid);
            clearSession();
            setSession(null);
            lastPersistedStaffIdRef.current = null;
          },
          // Final synchronous fence right before signOut. The generation check
          // also covers a newer login that re-signed-in the SAME UID.
          assertCanSignOutNonAnonymous: (departing) => assertAuthOpCurrent(op, departing.uid),
        });
        assertAuthOpCurrent(op, pinIdentity.uid);
        await asPinIdentityStep(() => pinIdentity.getIdToken(true));
        const user = await verifyPinLogin(normalizedPin, branchId, { username: normalizedUsername });
        // Superseded by a newer login first; a UID change with no newer login
        // keeps its PIN-identity classification just below.
        assertAuthOpCurrent(op, null);
        if (!auth.currentUser || auth.currentUser.uid !== pinIdentity.uid || !auth.currentUser.isAnonymous) {
          throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
        }

        // Stage-2 login ordering (SEC-001 D-1A)
        // Forced token refresh to inspect newly minted custom claims from Cloud Function
        const pinUser = auth.currentUser;
        const tokenResult = await asPinIdentityStep(() => pinUser.getIdTokenResult(true));
        const claimedStaffId = tokenResult?.claims?.staffId;
        if (!claimedStaffId || claimedStaffId !== user.id) {
          throw new Error('การยืนยันตัวตนล้มเหลว (staff identity claim mismatch)');
        }

        if (!isActiveUser(user)) {
          throw new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
        }

        // Native offline staff session issuance (READY native device only).
        // Every failure here is a device-session failure, never a PIN error,
        // and never carries a raw native/server string to the UI.
        if (isNative) {
          const invoke = getNativeStaffSessionInvoke();
          if (!invoke || !app) {
            throw new DeviceNotReadyError('DEVICE_SESSION_PREPARATION_FAILED');
          }
          assertAuthOpCurrent(op, pinIdentity.uid);
          let challengeRaw: unknown;
          try {
            challengeRaw = await invoke('native_prepare_staff_session_challenge', {
              purpose: 'SSA1_LOGIN',
              branchId,
              intendedStaffId: user.id,
            });
          } catch {
            throw new DeviceNotReadyError('DEVICE_SESSION_PREPARATION_FAILED');
          }
          const challenge = challengeRaw as { generation?: unknown; sscp1ProofBase64?: unknown } | null;
          if (
            typeof challenge?.generation !== 'number' ||
            typeof challenge?.sscp1ProofBase64 !== 'string' ||
            !challenge.sscp1ProofBase64
          ) {
            throw new DeviceNotReadyError('DEVICE_SESSION_PREPARATION_FAILED');
          }

          let issued: { ssa1Base64: string; srf1Base64: string; oks1Base64: string };
          try {
            const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
            const issueCallable = httpsCallable<
              { sscp1Base64: string },
              { ok: boolean; ssa1Base64?: string; srf1Base64?: string; code?: string }
            >(functions, 'issueOfflineStaffSessionAssertion');
            const issueRes = await issueCallable({ sscp1Base64: challenge.sscp1ProofBase64 });
            const { ssa1Base64, srf1Base64 } = issueRes.data;
            if (!issueRes.data.ok || !ssa1Base64 || !srf1Base64) {
              console.warn('[auth] offline staff session issuance refused', issueRes.data.code ?? 'issue_call_failed');
              throw new DeviceNotReadyError('DEVICE_SESSION_ISSUANCE_FAILED');
            }

            const keysetCallable = httpsCallable<unknown, { ok: boolean; oks1Base64?: string }>(
              functions,
              'getOacKeysetManifest',
            );
            const keysetRes = await keysetCallable({});
            if (!keysetRes.data.ok || !keysetRes.data.oks1Base64) {
              throw new DeviceNotReadyError('DEVICE_SESSION_ISSUANCE_FAILED');
            }
            issued = { ssa1Base64, srf1Base64, oks1Base64: keysetRes.data.oks1Base64 };
          } catch (err) {
            throw err instanceof DeviceNotReadyError ? err : new DeviceNotReadyError('DEVICE_SESSION_ISSUANCE_FAILED');
          }

          assertAuthOpCurrent(op, pinIdentity.uid);
          try {
            await invoke('native_persist_staff_session_assertion', {
              generation: challenge.generation,
              ...issued,
            });
          } catch {
            throw new DeviceNotReadyError('DEVICE_SESSION_PERSIST_FAILED');
          }

          if (!isAuthOpCurrent(op, pinIdentity.uid)) {
            // Superseded while persisting: do not leave this staff's native
            // session behind for whatever identity is current now.
            try {
              await invoke('native_clear_staff_session');
            } catch {
              // best effort; completeLogin clears again for a different staff
            }
            throw new AuthOperationSupersededError();
          }
          lastPersistedStaffIdRef.current = user.id;
        }

        markCompletable(op, 'pin', pinIdentity.uid, user.id);
        return user;
      } catch (err) {
        console.error('[auth] loginWithPin failed', err);
        // Whatever failed, a superseded attempt reports only that it was superseded.
        if (authOpRef.current !== op) throw new AuthOperationSupersededError();
        throw err instanceof Error ? err : new Error('ไม่สามารถยืนยัน PIN ได้');
      }
    }

    if (import.meta.env.DEV) {
      const user = await findDevUserByPin(normalizedPin, branchId, normalizedUsername);
      if (user && isActiveUser(user)) {
        markCompletable(op, 'pin', null, user.id);
        return { ...user, pin: '' };
      }
    }

    throw new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
  }, [assertAuthOpCurrent, beginAuthOp, isAuthOpCurrent, markCompletable, refreshDeviceReadiness]);

  const completeLogin = useCallback(async (user: User, branchId: string) => {
    // Defense in depth: no app session is ever saved on a not-READY native device.
    assertDeviceGateOpen(await refreshDeviceReadiness());
    // Only the result of the still-current login operation, for the user it
    // authenticated, while Firebase is still on that operation's UID.
    const pending = pendingCompletionRef.current;
    const assertCompletable = () => {
      if (
        !pending ||
        pendingCompletionRef.current !== pending ||
        pending.userId !== user.id ||
        !isAuthOpCurrent(pending.op, pending.firebaseUid)
      ) {
        throw new AuthOperationSupersededError();
      }
    };
    assertCompletable();
    if (lastPersistedStaffIdRef.current !== user.id) {
      const invoke = getNativeStaffSessionInvoke();
      if (invoke) {
        await invoke('native_clear_staff_session');
      }
      lastPersistedStaffIdRef.current = null;
    }
    assertCompletable();
    const nextSession = establishSession(user, branchId);
    pendingCompletionRef.current = null;
    setSession(nextSession);
    await touchLastLogin(user.id);
  }, [isAuthOpCurrent, refreshDeviceReadiness]);

  const loginWithUsername = useCallback(
    async (username: string, password: string, branchId: string) => {
      const normalizedUsername = username.trim().toLowerCase();
      if (!normalizedUsername || !password) {
        throw new Error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
      }

      const op = beginAuthOp();

      // Native POS: no password sign-in (and so no app session) on a device
      // that is not fully enrolled - password login is not an enrollment bypass.
      assertDeviceGateOpen(await refreshDeviceReadiness());
      // A superseded password attempt must not sign in.
      assertAuthOpCurrent(op, null);

      let user: User | null = null;
      let expectedUid: string | null = null;

      if (isFirebaseConfigured && auth) {
        try {
          await signInWithEmailAndPassword(
            auth,
            authEmailForUsername(normalizedUsername),
            password,
          );
          const fbUser = auth.currentUser;
          if (fbUser) {
            expectedUid = fbUser.uid;
            await fbUser.getIdToken(true);
            user = await fetchUserById(fbUser.uid);
          }
        } catch {
          // fall through to dev mock in DEV
        }
        // Superseded while signing in / fetching the profile: never a
        // "wrong password", never a session for the stale account.
        assertAuthOpCurrent(op, expectedUid);
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

      markCompletable(op, 'password', expectedUid, user.id);
      return { ...user, pin: '' };
    },
    [assertAuthOpCurrent, beginAuthOp, markCompletable, refreshDeviceReadiness],
  );

  const logout = useCallback(async () => {
    // A login still in flight must not re-create a session after logout.
    authOpRef.current += 1;
    pendingCompletionRef.current = null;
    const invoke = getNativeStaffSessionInvoke();
    if (invoke) {
      await invoke('native_clear_staff_session');
    }
    clearSession();
    setSession(null);
    lastPersistedStaffIdRef.current = null;
    if (auth) {
      await signOut(auth);
    }
  }, []);

  const prepareEnrollmentIdentity = useCallback(async () => {
    // Supersedes any in-flight login and drops its pending completion.
    const op = beginAuthOp();
    try {
      // Only a clean NOT_ENROLLED native device may start a fresh enrollment.
      if ((await refreshDeviceReadiness()) !== 'NOT_ENROLLED') {
        throw new EnrollmentIdentityError('ENROLLMENT_IDENTITY_NOT_ALLOWED');
      }
      assertAuthOpCurrent(op, null);
      // Recovery continuity is authoritative: any UID-bound evidence (valid,
      // malformed, conflicting or unreadable) means nothing here may change.
      if (hasUidBoundEnrollmentRecoveryEvidence()) {
        throw new EnrollmentIdentityError('ENROLLMENT_IDENTITY_TRANSITION_BLOCKED');
      }
      // Fence any in-flight restore (e.g. a persisted password account's
      // profile fetch) so it can never re-save that account's session.
      identityGenerationRef.current += 1;
      const invoke = getNativeStaffSessionInvoke();
      if (invoke) {
        try {
          await invoke('native_clear_staff_session');
        } catch {
          throw new EnrollmentIdentityError('ENROLLMENT_IDENTITY_UNAVAILABLE');
        }
      }
      assertAuthOpCurrent(op, null);
      if (hasUidBoundEnrollmentRecoveryEvidence()) {
        throw new EnrollmentIdentityError('ENROLLMENT_IDENTITY_TRANSITION_BLOCKED');
      }
      // A stale staff session must not reappear once enrollment makes the device READY.
      clearSession();
      setSession(null);
      lastPersistedStaffIdRef.current = null;

      const assertMayLeave = (departing: FirebaseUser) => {
        assertAuthOpCurrent(op, departing.uid);
        if (hasUidBoundEnrollmentRecoveryEvidence()) {
          throw new EnrollmentIdentityError('ENROLLMENT_IDENTITY_TRANSITION_BLOCKED');
        }
      };
      const identity = await ensureAnonymousFirebaseIdentity(
        {
          beforeLeavingNonAnonymous: (departing) => {
            assertMayLeave(departing);
            identityGenerationRef.current += 1;
          },
          // Final synchronous fence right before the local signOut.
          assertCanSignOutNonAnonymous: assertMayLeave,
        },
        () => new EnrollmentIdentityError('ENROLLMENT_IDENTITY_UNAVAILABLE'),
      );
      assertAuthOpCurrent(op, identity.uid);
      if (!identity.isAnonymous || loadSession() !== null) {
        clearSession();
        setSession(null);
        throw new EnrollmentIdentityError('ENROLLMENT_IDENTITY_UNAVAILABLE');
      }
      // The only proof `registerDevice` accepts; rechecked there right before begin.
      return mintEnrollmentGrant({
        requesterUid: identity.uid,
        isPreparationCurrent: () => authOpRef.current === op,
        readDeviceReadiness: refreshDeviceReadiness,
      });
    } catch (err) {
      if (isEnrollmentIdentityError(err)) throw err;
      // Superseded, native bridge, or anything unexpected: fixed and fail closed.
      throw new EnrollmentIdentityError('ENROLLMENT_IDENTITY_UNAVAILABLE');
    }
  }, [assertAuthOpCurrent, beginAuthOp, refreshDeviceReadiness]);

  const setBranchId = useCallback(
    async (branchId: string) => {
      const invoke = getNativeStaffSessionInvoke();
      if (invoke) {
        await invoke('native_clear_staff_session');
      }
      lastPersistedStaffIdRef.current = null;
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

  const deviceGateOpen = isDeviceGateOpen(deviceReadiness);
  const gatedSession = deviceGateOpen ? session : null;

  const value = useMemo<AuthContextValue>(
    () => ({
      session: gatedSession,
      user: gatedSession?.user ?? null,
      branchId: gatedSession?.branchId ?? null,
      isLoading: isLoading || deviceReadiness === 'checking',
      isAuthenticated: gatedSession != null,
      firebaseUser,
      deviceReadiness,
      refreshDeviceReadiness,
      loginWithPin,
      loginWithUsername,
      completeLogin,
      logout,
      prepareEnrollmentIdentity,
      setBranchId,
    }),
    [
      gatedSession,
      isLoading,
      deviceReadiness,
      refreshDeviceReadiness,
      firebaseUser,
      loginWithPin,
      loginWithUsername,
      completeLogin,
      logout,
      prepareEnrollmentIdentity,
      setBranchId,
    ],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}
