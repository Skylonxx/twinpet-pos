// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import LoginPage from './LoginPage';
import { useAuth } from '../lib/hooks/useAuth';
import { useActiveBranches } from '../lib/branches';
import { AuthOperationSupersededError } from '../lib/auth/authOperationError';

/**
 * TPOS-R7 (Codex 002 blocker 2, UI layer): password login and Quick PIN are
 * mutually exclusive. The 4th-digit PIN auto-submit is a queued timer; it
 * must never fire after leaving PIN mode, after the PIN changed, or while /
 * after a password login started.
 */

vi.mock('../lib/hooks/useAuth');
vi.mock('../lib/branches');

const PIN_INVALID_LABEL = 'PIN ไม่ถูกต้อง กรุณาลองใหม่';
const STAFF = { id: 'staff-b', branchIds: ['LDP-001'], role: 'staff', firstName: 'B', lastName: 'S' };
const ADMIN = { id: 'admin-a', branchIds: ['ALL'], role: 'admin', firstName: 'A', lastName: 'A' };

let loginWithPin: ReturnType<typeof vi.fn>;
let loginWithUsername: ReturnType<typeof vi.fn>;
let completeLogin: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function passwordTab() {
  return screen.getByRole('tab', { name: /Username/ });
}
function pinTab() {
  return screen.getByRole('tab', { name: /Quick PIN/ });
}

function fillPasswordForm() {
  fireEvent.click(passwordTab());
  fireEvent.change(screen.getByLabelText('Username', { selector: '#inp-user' }), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
}

function enterFourPinDigits() {
  fireEvent.change(screen.getByLabelText('Username', { selector: '#inp-pin-user' }), { target: { value: 'cashier' } });
  for (const d of ['4', '3', '2', '1']) fireEvent.click(screen.getByText(d));
}

function clickPasswordLogin() {
  fireEvent.click(screen.getByRole('button', { name: /เข้าสู่ระบบ/ }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  loginWithPin = vi.fn();
  loginWithUsername = vi.fn();
  completeLogin = vi.fn(async () => undefined);
  vi.mocked(useAuth).mockReturnValue({
    loginWithPin,
    loginWithUsername,
    completeLogin,
    isAuthenticated: false,
    isLoading: false,
    user: null,
    branchId: null,
    setBranchId: vi.fn(),
    logout: vi.fn(),
    session: null,
    firebaseUser: null,
    deviceReadiness: 'not_native',
    refreshDeviceReadiness: vi.fn(async () => 'not_native'),
  } as never);
  vi.mocked(useActiveBranches).mockReturnValue({
    branches: [{ id: 'LDP-001', name: 'หนองสังข์', isActive: true }] as never,
    loading: false,
    error: null,
    reload: vi.fn(),
    getLabel: vi.fn((id: string) => id),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LoginPage — queued PIN auto-submit vs password login (TPOS-R7)', () => {
  it('Codex interleaving: 4th digit queued → switch to Password → password login starts → timer fires: PIN submit never starts', async () => {
    const pw = deferred<typeof ADMIN>();
    loginWithUsername.mockReturnValue(pw.promise);
    render(<LoginPage />);
    fillPasswordForm();
    fireEvent.click(pinTab());

    enterFourPinDigits(); // delayed auto-submit is now scheduled
    fireEvent.click(passwordTab()); // before the timer fires
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    clickPasswordLogin();
    expect(loginWithUsername).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(loginWithPin).not.toHaveBeenCalled();

    pw.resolve(ADMIN);
    await flush();
    await flush();
    expect(loginWithPin).not.toHaveBeenCalled();
    expect(completeLogin).toHaveBeenCalledTimes(1);
    expect(completeLogin).toHaveBeenCalledWith(ADMIN, 'ALL');
  });

  it('switching tabs alone cancels the queued PIN submit and calls no auth function', async () => {
    render(<LoginPage />);
    enterFourPinDigits();
    fireEvent.click(passwordTab());
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(loginWithPin).not.toHaveBeenCalled();
    expect(loginWithUsername).not.toHaveBeenCalled();
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('switching away and straight back to PIN still does not fire the stale queued PIN', async () => {
    render(<LoginPage />);
    enterFourPinDigits();
    fireEvent.click(passwordTab());
    fireEvent.click(pinTab());
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(loginWithPin).not.toHaveBeenCalled();
  });

  it('deleting a digit before the timer fires cancels the queued PIN submit', async () => {
    render(<LoginPage />);
    enterFourPinDigits();
    fireEvent.click(screen.getByLabelText('ลบ'));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(loginWithPin).not.toHaveBeenCalled();
  });

  it('unmounting LoginPage cancels the queued PIN submit', async () => {
    const view = render(<LoginPage />);
    enterFourPinDigits();
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(loginWithPin).not.toHaveBeenCalled();
  });

  it('reverse: while a PIN login is in flight, a password login cannot start', async () => {
    const pin = deferred<typeof STAFF>();
    loginWithPin.mockReturnValue(pin.promise);
    render(<LoginPage />);
    enterFourPinDigits();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(loginWithPin).toHaveBeenCalledTimes(1);

    fillPasswordForm();
    // The submit button shows its in-progress state; pressing it starts nothing.
    fireEvent.click(screen.getByRole('button', { name: /กำลังตรวจสอบ|เข้าสู่ระบบ/ }));
    expect(loginWithUsername).not.toHaveBeenCalled();

    pin.resolve(STAFF);
    await flush();
    await flush();
    expect(completeLogin).toHaveBeenCalledTimes(1);
    expect(completeLogin).toHaveBeenCalledWith(STAFF, 'LDP-001');
  });

  it('superseded PIN result: fixed message, NOT the PIN-incorrect state', async () => {
    loginWithPin.mockRejectedValue(new AuthOperationSupersededError());
    render(<LoginPage />);
    enterFourPinDigits();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    expect(screen.getByText(new AuthOperationSupersededError().message)).toBeDefined();
    expect(screen.queryByText(PIN_INVALID_LABEL)).toBeNull();
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('superseded password result: fixed message, not "invalid password"', async () => {
    loginWithUsername.mockRejectedValue(new AuthOperationSupersededError());
    render(<LoginPage />);
    fillPasswordForm();
    clickPasswordLogin();
    await flush();
    await flush();
    expect(screen.getByText(new AuthOperationSupersededError().message)).toBeDefined();
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('control: an ordinary PIN entry still auto-submits exactly once', async () => {
    loginWithPin.mockResolvedValue(STAFF);
    render(<LoginPage />);
    enterFourPinDigits();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await flush();
    expect(loginWithPin).toHaveBeenCalledTimes(1);
    expect(loginWithPin).toHaveBeenCalledWith('4321', 'LDP-001', 'cashier');
    expect(completeLogin).toHaveBeenCalledWith(STAFF, 'LDP-001');
  });

  it('control: an ordinary password login still works', async () => {
    loginWithUsername.mockResolvedValue(ADMIN);
    render(<LoginPage />);
    fillPasswordForm();
    clickPasswordLogin();
    await flush();
    await flush();
    expect(loginWithUsername).toHaveBeenCalledWith('admin', 'secret', 'LDP-001');
    expect(completeLogin).toHaveBeenCalledWith(ADMIN, 'ALL');
    expect(loginWithPin).not.toHaveBeenCalled();
  });
});
