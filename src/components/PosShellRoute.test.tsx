// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { useState } from 'react';
import PosShellRoute from './PosShellRoute';
import { AuthProvider, useAuth } from '../lib/hooks/useAuth';
import * as sessionModule from '../lib/auth/session';
import type { User } from '../lib/types';

vi.mock('../lib/firebase', () => ({
  auth: null,
  app: null,
  collections: { users: 'users' },
  db: null,
  isFirebaseConfigured: false,
  authEmailForUsername: (u: string) => `${u}@pos.local`,
}));

vi.mock('./AppShell', () => ({
  default: () => <div data-testid="mock-app-shell">Mock AppShell</div>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => <div data-testid={`mock-navigate-${to.replace('/', '')}`}>Navigate to {to}</div>,
  };
});

const mockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();

delete (globalThis as any).localStorage;
(globalThis as any).localStorage = mockStorage;
if (typeof window !== 'undefined') {
  delete (window as any).localStorage;
  (window as any).localStorage = mockStorage;
}

describe('IR-008 AuthProvider & PosShellRoute logout ordering and error preservation', () => {
  const validUser: User = {
    id: 'user-1',
    username: 'staff1',
    firstName: 'Staff',
    lastName: 'One',
    role: 'staff',
    branchIds: ['B-HQ'],
    isActive: true,
    deletedAt: null,
  } as unknown as User;

  const validSession: sessionModule.AuthSession = {
    schemaVersion: sessionModule.SESSION_SCHEMA_VERSION,
    issuedAt: Date.now(),
    user: validUser,
    branchId: 'B-HQ',
  };

  const invalidBranchSession: sessionModule.AuthSession = {
    schemaVersion: sessionModule.SESSION_SCHEMA_VERSION,
    issuedAt: Date.now(),
    user: validUser,
    branchId: 'B-OTHER',
  };

  beforeEach(() => {
    localStorage.clear();
    (window as any).__TAURI__ = undefined;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  function TestAuthConsumer() {
    const { session, logout } = useAuth();
    const [logoutErr, setLogoutErr] = useState<string | null>(null);

    return (
      <div data-testid="test-consumer">
        <div data-testid="session-state">{session ? session.user.id : 'NO_SESSION'}</div>
        {logoutErr && <div data-testid="logout-error">{logoutErr}</div>}
        <button
          type="button"
          data-testid="logout-button"
          onClick={() => {
            logout().catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              setLogoutErr(msg);
            });
          }}
        >
          Logout
        </button>
      </div>
    );
  }

  function TestAuthConsumerWithRoute() {
    const { session, logout } = useAuth();
    const [logoutErr, setLogoutErr] = useState<string | null>(null);

    if (!session) {
      return <div data-testid="mock-navigate-login">Navigate to /login</div>;
    }

    return (
      <div data-testid="test-consumer">
        <div data-testid="current-route">/pos</div>
        <div data-testid="session-state">{session.user.id}</div>
        {logoutErr && <div data-testid="logout-error">{logoutErr}</div>}
        <button
          type="button"
          data-testid="logout-button"
          onClick={() => {
            logout().catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              setLogoutErr(msg);
            });
          }}
        >
          Logout
        </button>
      </div>
    );
  }

  describe('AuthProvider logout ordering tests', () => {
    it('executes native clear first, and only then clears session state on success (deferred promise proof)', async () => {
      sessionModule.saveSession(validSession);
      const executionOrder: string[] = [];

      let resolveNativeClear!: () => void;
      const nativeClearPromise = new Promise<void>((resolve) => {
        resolveNativeClear = resolve;
      });

      const invokeMock = vi.fn().mockImplementation(async (cmd: string) => {
        executionOrder.push(`invoke:${cmd}`);
        if (cmd === 'native_clear_staff_session') {
          return nativeClearPromise;
        }
        return undefined;
      });
      (window as any).__TAURI__ = {
        core: { invoke: invokeMock },
      };

      const clearSessionSpy = vi.spyOn(sessionModule, 'clearSession').mockImplementation(() => {
        executionOrder.push('clearSession');
        localStorage.removeItem('twinpet_session');
      });

      render(
        <AuthProvider>
          <TestAuthConsumerWithRoute />
        </AuthProvider>,
      );

      expect(screen.getByTestId('current-route').textContent).toBe('/pos');
      expect(screen.getByTestId('session-state').textContent).toBe('user-1');
      expect(screen.queryByTestId('mock-navigate-login')).toBeNull();

      const btn = screen.getByTestId('logout-button');
      await act(async () => {
        btn.click();
      });

      // 1. Native clear was invoked
      expect(invokeMock).toHaveBeenCalledWith('native_clear_staff_session');
      expect(executionOrder).toEqual(['invoke:native_clear_staff_session']);

      // 2. While pending: provider session, storage, caller, route unchanged, no /login navigation
      expect(clearSessionSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId('test-consumer')).toBeDefined();
      expect(screen.getByTestId('current-route').textContent).toBe('/pos');
      expect(screen.getByTestId('session-state').textContent).toBe('user-1');
      expect(sessionModule.loadSession()?.user.id).toBe('user-1');
      expect(localStorage.getItem('twinpet_session')).not.toBeNull();
      expect(screen.queryByTestId('mock-navigate-login')).toBeNull();

      // 3. Resolve native clear
      await act(async () => {
        resolveNativeClear();
      });

      // 4. Then assert session cleared, clearSession called, route transitions to /login
      await waitFor(() => {
        expect(screen.getByTestId('mock-navigate-login')).toBeDefined();
      });
      expect(clearSessionSpy).toHaveBeenCalled();
      expect(executionOrder).toEqual(['invoke:native_clear_staff_session', 'clearSession']);
      expect(sessionModule.loadSession()).toBeNull();
      expect(localStorage.getItem('twinpet_session')).toBeNull();
      expect(screen.queryByTestId('test-consumer')).toBeNull();
    });

    it('preserves UI context and session when native clear rejects, surfacing error to caller', async () => {
      sessionModule.saveSession(validSession);
      const invokeMock = vi.fn().mockRejectedValue(new Error('NATIVE_CLEAR_FAILURE_SEC_SEAM'));
      (window as any).__TAURI__ = {
        core: { invoke: invokeMock },
      };

      const clearSessionSpy = vi.spyOn(sessionModule, 'clearSession');

      render(
        <AuthProvider>
          <TestAuthConsumer />
        </AuthProvider>,
      );

      expect(screen.getByTestId('session-state').textContent).toBe('user-1');

      const btn = screen.getByTestId('logout-button');
      await act(async () => {
        btn.click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('logout-error').textContent).toBe('NATIVE_CLEAR_FAILURE_SEC_SEAM');
      });

      // 1. native clear was invoked and rejected
      expect(invokeMock).toHaveBeenCalledWith('native_clear_staff_session');
      // 2. session/context is NOT cleared
      expect(screen.getByTestId('session-state').textContent).toBe('user-1');
      expect(clearSessionSpy).not.toHaveBeenCalled();
      expect(sessionModule.loadSession()).not.toBeNull();
      expect(sessionModule.loadSession()?.user.id).toBe('user-1');
      // 3. caller/component remains mounted
      expect(screen.getByTestId('test-consumer')).toBeDefined();
    });
  });

  describe('PosShellRoute integration with AuthProvider', () => {
    it('renders AppShell when user has valid branch access', () => {
      sessionModule.saveSession(validSession);

      render(
        <AuthProvider>
          <PosShellRoute />
        </AuthProvider>,
      );

      expect(screen.getByTestId('mock-app-shell')).toBeDefined();
      expect(screen.queryByTestId('mock-navigate-login')).toBeNull();
    });

    it('awaits logout and navigates to /login when branch access is invalid and logout succeeds (deferred promise proof)', async () => {
      sessionModule.saveSession(invalidBranchSession);

      let resolveNativeClear!: () => void;
      const nativeClearPromise = new Promise<void>((resolve) => {
        resolveNativeClear = resolve;
      });

      const invokeMock = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'native_clear_staff_session') {
          return nativeClearPromise;
        }
        return undefined;
      });
      (window as any).__TAURI__ = {
        core: { invoke: invokeMock },
      };

      render(
        <AuthProvider>
          <PosShellRoute />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('native_clear_staff_session');
      });

      // While native clear is pending:
      expect(sessionModule.loadSession()?.user.id).toBe('user-1');
      expect(screen.queryByTestId('mock-navigate-login')).toBeNull();

      // Resolve native clear
      await act(async () => {
        resolveNativeClear();
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-navigate-login')).toBeDefined();
      });

      expect(sessionModule.loadSession()).toBeNull();
    });

    it('surfaces blocking error, keeps component mounted, preserves session, and blocks navigation when native clear rejects', async () => {
      sessionModule.saveSession(invalidBranchSession);

      const invokeMock = vi.fn().mockRejectedValue(new Error('NATIVE_CLEAR_FAILURE_SEC_SEAM'));
      (window as any).__TAURI__ = {
        core: { invoke: invokeMock },
      };

      render(
        <AuthProvider>
          <PosShellRoute />
        </AuthProvider>,
      );

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('native_clear_staff_session');
      });

      // 1. Blocking error is visible on screen
      await waitFor(() => {
        expect(screen.getByText('ข้อผิดพลาดในการล้างเซสชัน')).toBeDefined();
        expect(screen.getByText('NATIVE_CLEAR_FAILURE_SEC_SEAM')).toBeDefined();
      });

      // 2. Caller/component remains mounted (role="alert" error card is displayed)
      expect(screen.getByRole('alert')).toBeDefined();

      // 3. Session in storage is NOT cleared
      expect(sessionModule.loadSession()).not.toBeNull();
      expect(sessionModule.loadSession()?.user.id).toBe('user-1');

      // 4. No navigation/logout-success transition occurs
      expect(screen.queryByTestId('mock-navigate-login')).toBeNull();
    });
  });
});
