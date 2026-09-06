// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import WorkspaceSelector from './WorkspaceSelector';
import { useAuth } from '../lib/hooks/useAuth';
import { fetchAllBranches } from '../lib/admin/branchManagement';
import { useNavigate } from 'react-router-dom';
import type { User } from '../lib/types';

vi.mock('../lib/hooks/useAuth');
vi.mock('../lib/admin/branchManagement');
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
});

describe('WorkspaceSelector IR-008 setBranchId failure handling', () => {
  const globalAdminUser = {
    id: 'admin-1',
    username: 'globaladmin',
    firstName: 'Global',
    lastName: 'Admin',
    role: 'admin',
    branchIds: ['ALL'],
    isActive: true,
    deletedAt: null,
  } as unknown as User;

  const dummyBranches = [
    { id: 'B-HQ', name: 'HQ Branch', isActive: true },
    { id: 'B-NORTH', name: 'North Branch', isActive: true },
  ];

  it('navigates to /dashboard when setBranchId succeeds', async () => {
    const navigateMock = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigateMock);

    const setBranchIdMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useAuth).mockReturnValue({
      user: globalAdminUser,
      setBranchId: setBranchIdMock,
    } as any);

    vi.mocked(fetchAllBranches).mockResolvedValue(dummyBranches as any);

    render(<WorkspaceSelector />);

    // Step 1: Click "เข้าสู่ระบบ POS หน้าร้าน"
    const posChoiceBtn = screen.getByText('เข้าใช้งานหน้าร้าน');
    fireEvent.click(posChoiceBtn);

    await waitFor(() => {
      expect(screen.getByText('เลือกสาขา')).toBeDefined();
    });

    // Step 2: Click "เข้าสู่ POS"
    const enterPosBtn = screen.getByRole('button', { name: /เข้าสู่ POS/ });
    fireEvent.click(enterPosBtn);

    await waitFor(() => {
      expect(setBranchIdMock).toHaveBeenCalledWith('B-HQ');
    });

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard', { replace: true });
    });
  });

  it('surfaces blocking error and blocks navigation when setBranchId rejects', async () => {
    const navigateMock = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(navigateMock);

    const setBranchIdMock = vi.fn().mockRejectedValue(new Error('NATIVE_CLEAR_STAFF_SESSION_FAILED'));
    vi.mocked(useAuth).mockReturnValue({
      user: globalAdminUser,
      setBranchId: setBranchIdMock,
    } as any);

    vi.mocked(fetchAllBranches).mockResolvedValue(dummyBranches as any);

    render(<WorkspaceSelector />);

    // Step 1: Click "เข้าสู่ระบบ POS หน้าร้าน"
    const posChoiceBtn = screen.getByText('เข้าใช้งานหน้าร้าน');
    fireEvent.click(posChoiceBtn);

    await waitFor(() => {
      expect(screen.getByText('เลือกสาขา')).toBeDefined();
    });

    // Step 2: Click "เข้าสู่ POS"
    const enterPosBtn = screen.getByRole('button', { name: /เข้าสู่ POS/ });
    fireEvent.click(enterPosBtn);

    await waitFor(() => {
      expect(setBranchIdMock).toHaveBeenCalledWith('B-HQ');
    });

    // Verify blocking error banner is surfaced
    await waitFor(() => {
      expect(screen.getByText('NATIVE_CLEAR_STAFF_SESSION_FAILED')).toBeDefined();
    });

    // Navigation must NOT be called on failure
    expect(navigateMock).not.toHaveBeenCalledWith('/dashboard', { replace: true });
  });
});
