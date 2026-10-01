// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { AuthProvider } from '../lib/auth/AuthProvider';
import { NATIVE_DEVICE_SECURITY_READINESS_COMMAND } from '../lib/auth/nativeDeviceReadiness';
import GuestRoute from './GuestRoute';
import ProtectedRoute from './ProtectedRoute';

/**
 * TPOS-R7: a restored app session must not unlock ProtectedRoute on a native
 * POS whose strong device readiness is not READY, and GuestRoute must keep
 * /login reachable for enrollment / recovery. Web routing is unchanged.
 */

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { uid: 'anon-uid', isAnonymous: true } },
  app: {},
  db: null,
  isFirebaseConfigured: true,
  collections: { users: 'users' },
  authEmailForUsername: (u: string) => `${u}@example.invalid`,
}));
vi.mock('../lib/firebaseAuth', () => ({ ensureFirebaseAuth: vi.fn(async () => undefined) }));
vi.mock('../lib/auth/verifyPinLogin', () => ({ verifyPinLogin: vi.fn() }));
vi.mock('../lib/auth/devUsers', () => ({ findDevUserByPin: vi.fn(), findDevUserByUsernamePassword: vi.fn() }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: null) => void) => {
    cb(null);
    return () => undefined;
  },
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  updateDoc: vi.fn(),
}));
vi.mock('firebase/functions', () => ({ getFunctions: vi.fn(), httpsCallable: vi.fn() }));
vi.mock('../lib/branches', () => ({ fetchActiveBranches: vi.fn(async () => []) }));

const mockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true, configurable: true });

const TAURI_KEY = '__TAURI__';
const STAFF_USER = {
  id: 'staff-1',
  username: 'cashier',
  firstName: 'A',
  lastName: 'B',
  role: 'staff',
  branchIds: ['LDP-001'],
  isActive: true,
  deletedAt: null,
};

function saveRestoredSession() {
  localStorage.setItem(
    'twinpet_session',
    JSON.stringify({ schemaVersion: 1, issuedAt: 1, user: STAFF_USER, branchId: 'LDP-001' }),
  );
}

function installNative(readiness: unknown) {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === NATIVE_DEVICE_SECURITY_READINESS_COMMAND) {
      if (readiness instanceof Error) throw readiness;
      return { readiness };
    }
    throw new Error(`unexpected native command ${cmd}`);
  });
  (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
}

function renderAt(path: string) {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<GuestRoute />}>
            <Route path="/login" element={<div>LOGIN_SCREEN</div>} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div>PROTECTED_DASHBOARD</div>} />
            <Route path="/pos" element={<div>PROTECTED_POS</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(signOut).mockReset();
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)[TAURI_KEY];
});

describe('ProtectedRoute / GuestRoute — native device gate (TPOS-R7)', () => {
  it.each([
    ['NOT_ENROLLED', 'NOT_ENROLLED'],
    ['INVALID_OR_INCOMPLETE', 'INVALID_OR_INCOMPLETE'],
    ['readiness command failure', new Error('raw native failure')],
  ])('restored session + native %s: protected route redirects to /login', async (_label, readiness) => {
    saveRestoredSession();
    installNative(readiness);
    renderAt('/pos');

    expect(await screen.findByText('LOGIN_SCREEN')).toBeDefined();
    expect(screen.queryByText('PROTECTED_POS')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('restored session + native NOT_ENROLLED: GuestRoute keeps /login reachable (no bounce to dashboard)', async () => {
    saveRestoredSession();
    installNative('NOT_ENROLLED');
    renderAt('/login');

    expect(await screen.findByText('LOGIN_SCREEN')).toBeDefined();
    expect(screen.queryByText('PROTECTED_DASHBOARD')).toBeNull();
  });

  it('restored session + native READY: protected route renders as before', async () => {
    saveRestoredSession();
    installNative('READY');
    renderAt('/pos');

    expect(await screen.findByText('PROTECTED_POS')).toBeDefined();
  });

  it('restored session + native READY: GuestRoute redirects /login to the dashboard as before', async () => {
    saveRestoredSession();
    installNative('READY');
    renderAt('/login');

    expect(await screen.findByText('PROTECTED_DASHBOARD')).toBeDefined();
  });

  it('web: restored session unlocks protected routes unchanged', async () => {
    saveRestoredSession();
    renderAt('/pos');

    expect(await screen.findByText('PROTECTED_POS')).toBeDefined();
  });

  it('web: no session still redirects to /login unchanged', async () => {
    renderAt('/dashboard');

    expect(await screen.findByText('LOGIN_SCREEN')).toBeDefined();
  });
});
