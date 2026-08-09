// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const authMocks = vi.hoisted(() => ({
  loginWithPin: vi.fn(),
  loginWithUsername: vi.fn(),
  completeLogin: vi.fn().mockResolvedValue(undefined),
  isAuthenticated: false,
}));

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    loginWithPin: authMocks.loginWithPin,
    loginWithUsername: authMocks.loginWithUsername,
    completeLogin: authMocks.completeLogin,
    isAuthenticated: authMocks.isAuthenticated,
    user: null,
    branchId: null,
    session: null,
    isLoading: false,
    firebaseUser: null,
    logout: vi.fn(),
    setBranchId: vi.fn(),
  }),
}));

vi.mock('../lib/branches', () => ({
  getBranchLabel: (id: string) => id,
  useActiveBranches: () => ({
    branches: [{ id: 'B1', name: 'สาขาทดสอบ' }],
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

import LoginPage from './LoginPage';

function setNavigatorOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
}

beforeEach(() => {
  authMocks.isAuthenticated = false;
  authMocks.loginWithPin.mockReset();
  authMocks.loginWithUsername.mockReset();
  authMocks.completeLogin.mockReset();
  authMocks.completeLogin.mockResolvedValue(undefined);
  setNavigatorOnline(true);
});

afterEach(() => {
  cleanup();
  setNavigatorOnline(true);
});

describe('LoginPage — PK-2A DEC-10 offline blocker', () => {
  test('unauthenticated + offline → blocker present with honest offline/first-login copy', async () => {
    setNavigatorOnline(false);
    render(<LoginPage />);
    window.dispatchEvent(new Event('offline'));

    const blocker = await screen.findByTestId('login-offline-blocker');
    expect(blocker.getAttribute('role')).toBe('status');
    expect(blocker.textContent).toContain('ไม่ได้เชื่อมต่อเครือข่าย');
    expect(blocker.textContent).toContain('เข้าสู่ระบบครั้งแรก');
    expect(blocker.textContent).toContain('ออฟไลน์');
  });

  test('blocker text does NOT claim server/backend unavailability', async () => {
    setNavigatorOnline(false);
    render(<LoginPage />);
    window.dispatchEvent(new Event('offline'));

    const blocker = await screen.findByTestId('login-offline-blocker');
    const text = blocker.textContent ?? '';
    expect(text).not.toMatch(/เซิร์ฟเวอร์|server|backend/i);
  });

  test('DEC-10 Option A: PIN controls remain enabled and submission is not short-circuited by navigator.onLine', async () => {
    setNavigatorOnline(false);
    authMocks.loginWithPin.mockRejectedValue(new Error('network boom'));
    const user = userEvent.setup();
    render(<LoginPage />);
    window.dispatchEvent(new Event('offline'));

    await screen.findByTestId('login-offline-blocker');

    const pinButtons = screen.getAllByRole('button').filter((b) => /^\d$/.test(b.textContent ?? ''));
    expect(pinButtons.length).toBeGreaterThan(0);
    for (const btn of pinButtons) {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }

    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '3' }));
    await user.click(screen.getByRole('button', { name: '4' }));

    await waitFor(() => {
      expect(authMocks.loginWithPin).toHaveBeenCalled();
    });
  });

  test('DEC-10 Option A: username/password submit remains enabled while offline', async () => {
    setNavigatorOnline(false);
    authMocks.loginWithUsername.mockRejectedValue(new Error('network boom'));
    const user = userEvent.setup();
    render(<LoginPage />);
    window.dispatchEvent(new Event('offline'));

    await user.click(screen.getByRole('tab', { name: /Username/i }));
    const submit = screen.getByRole('button', { name: /เข้าสู่ระบบ/ });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    await user.type(screen.getByLabelText('Username'), 'somchai');
    await user.type(screen.getByLabelText('Password'), 'admin1234');
    await user.click(submit);

    await waitFor(() => {
      expect(authMocks.loginWithUsername).toHaveBeenCalled();
    });
  });

  test('offline → online event clears blocker without reload', async () => {
    setNavigatorOnline(false);
    render(<LoginPage />);
    window.dispatchEvent(new Event('offline'));
    expect(await screen.findByTestId('login-offline-blocker')).toBeTruthy();

    setNavigatorOnline(true);
    window.dispatchEvent(new Event('online'));

    await waitFor(() => {
      expect(screen.queryByTestId('login-offline-blocker')).toBeNull();
    });
  });

  test('unauthenticated + nominally online → no blocker', () => {
    setNavigatorOnline(true);
    render(<LoginPage />);
    expect(screen.queryByTestId('login-offline-blocker')).toBeNull();
    expect(screen.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeTruthy();
  });

  test('authenticated direct /login while offline → no blocker', async () => {
    authMocks.isAuthenticated = true;
    setNavigatorOnline(false);
    render(<LoginPage />);
    window.dispatchEvent(new Event('offline'));

    await waitFor(() => {
      expect(screen.queryByTestId('login-offline-blocker')).toBeNull();
    });
  });

  test('login rejection while offline → honest offline copy; raw thrown message not rendered', async () => {
    setNavigatorOnline(false);
    authMocks.loginWithPin.mockRejectedValue(new Error('SECRET_INTERNAL_FIREBASE_ERROR'));
    const user = userEvent.setup();
    render(<LoginPage />);
    window.dispatchEvent(new Event('offline'));

    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '3' }));
    await user.click(screen.getByRole('button', { name: '4' }));

    await waitFor(() => {
      expect(authMocks.loginWithPin).toHaveBeenCalled();
    });
    expect(screen.queryByText('SECRET_INTERNAL_FIREBASE_ERROR')).toBeNull();
    expect(screen.getAllByText(/อุปกรณ์นี้ไม่ได้เชื่อมต่อเครือข่าย/).length).toBeGreaterThan(0);
  });

  test('login rejection while nominally online → existing error message behavior', async () => {
    setNavigatorOnline(true);
    authMocks.loginWithUsername.mockRejectedValue(new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('tab', { name: /Username/i }));
    await user.type(screen.getByLabelText('Username'), 'somchai');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /เข้าสู่ระบบ/ }));

    await waitFor(() => {
      expect(screen.getByText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')).toBeTruthy();
    });
  });
});
