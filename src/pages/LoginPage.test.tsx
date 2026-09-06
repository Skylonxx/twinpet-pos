// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from './LoginPage';
import { useAuth } from '../lib/hooks/useAuth';
import { useActiveBranches } from '../lib/branches';
import type { User } from '../lib/types';

vi.mock('../lib/hooks/useAuth');
vi.mock('../lib/branches');

describe('LoginPage IR-008 completeLogin failure handling', () => {
  const dummyUser = {
    id: 'user-1',
    username: 'cashier1',
    firstName: 'Cashier',
    lastName: 'One',
    role: 'staff',
    branchIds: ['B-HQ'],
    isActive: true,
    deletedAt: null,
  } as unknown as User;

  const dummyBranches = [{ id: 'B-HQ', name: 'HQ Branch', isActive: true }];

  it('surfaces blocking error and prevents success when completeLogin rejects on PIN login', async () => {
    const loginWithPinMock = vi.fn().mockResolvedValue(dummyUser);
    const completeLoginMock = vi.fn().mockRejectedValue(new Error('NATIVE_CACHE_COMMIT_FAILED'));

    vi.mocked(useAuth).mockReturnValue({
      loginWithPin: loginWithPinMock,
      loginWithUsername: vi.fn(),
      completeLogin: completeLoginMock,
      isAuthenticated: false,
      user: null,
      branchId: 'B-HQ',
      setBranchId: vi.fn(),
      logout: vi.fn(),
      session: null,
    } as any);

    vi.mocked(useActiveBranches).mockReturnValue({
      branches: dummyBranches as any,
      loading: false,
      error: null,
      reload: vi.fn(),
      getLabel: vi.fn((id: string) => id),
    });

    render(<LoginPage />);

    // Click 4 digits on the PIN pad: 1, 2, 3, 4
    fireEvent.click(screen.getByText('1'));
    fireEvent.click(screen.getByText('2'));
    fireEvent.click(screen.getByText('3'));
    fireEvent.click(screen.getByText('4'));

    const confirmBtn = screen.getByRole('button', { name: 'ยืนยัน PIN' });
    fireEvent.click(confirmBtn);

    await waitFor(
      () => {
        expect(loginWithPinMock).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    await waitFor(
      () => {
        expect(completeLoginMock).toHaveBeenCalledWith(dummyUser, 'B-HQ');
      },
      { timeout: 3000 },
    );

    // Verify blocking error is displayed and login success overlay/message is NOT shown
    await waitFor(
      () => {
        expect(screen.getByText('NATIVE_CACHE_COMMIT_FAILED')).toBeDefined();
      },
      { timeout: 3000 },
    );
    expect(screen.queryByText(/ยินดีต้อนรับ, Cashier One/)).toBeNull();
  });

  it('surfaces blocking error and prevents success when completeLogin rejects on password login', async () => {
    const loginWithUsernameMock = vi.fn().mockResolvedValue(dummyUser);
    const completeLoginMock = vi.fn().mockRejectedValue(new Error('NATIVE_MANIFEST_WRITE_FAILED'));

    vi.mocked(useAuth).mockReturnValue({
      loginWithPin: vi.fn(),
      loginWithUsername: loginWithUsernameMock,
      completeLogin: completeLoginMock,
      isAuthenticated: false,
      user: null,
      branchId: 'B-HQ',
      setBranchId: vi.fn(),
      logout: vi.fn(),
      session: null,
    } as any);

    vi.mocked(useActiveBranches).mockReturnValue({
      branches: dummyBranches as any,
      loading: false,
      error: null,
      reload: vi.fn(),
      getLabel: vi.fn((id: string) => id),
    });

    render(<LoginPage />);

    // Switch to password mode via Username tab
    const userTabs = screen.getAllByRole('tab', { name: /Username/ });
    fireEvent.click(userTabs[0]);

    // Enter username & password
    const usernameInput = document.getElementById('inp-user') as HTMLInputElement;
    const passwordInput = document.getElementById('inp-pass') as HTMLInputElement;

    fireEvent.change(usernameInput, { target: { value: 'cashier1' } });
    fireEvent.change(passwordInput, { target: { value: 'secret123' } });

    const submitBtn = screen.getByRole('button', { name: /เข้าสู่ระบบ/ });
    fireEvent.click(submitBtn);

    await waitFor(
      () => {
        expect(loginWithUsernameMock).toHaveBeenCalledWith('cashier1', 'secret123', 'B-HQ');
      },
      { timeout: 3000 },
    );

    await waitFor(
      () => {
        expect(completeLoginMock).toHaveBeenCalledWith(dummyUser, 'B-HQ');
      },
      { timeout: 3000 },
    );

    // Verify error is surfaced in the password error container
    await waitFor(
      () => {
        expect(screen.getByText('NATIVE_MANIFEST_WRITE_FAILED')).toBeDefined();
      },
      { timeout: 3000 },
    );
    expect(screen.queryByText(/ยินดีต้อนรับ, Cashier One/)).toBeNull();
  });
});
