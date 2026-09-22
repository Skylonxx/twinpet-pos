// @vitest-environment jsdom

/**
 * Pre-Group-1 role-permission UX remediation — page operator feedback, proven
 * against BOTH staff-management pages from one shared scenario matrix so the
 * two copies cannot drift apart.
 *
 * Covers the AGY-003 findings at the UI boundary: no success toast before the
 * server resolves, mapped Thai errors surfaced on rejection, staged-removal
 * info toast instead of a completion claim, and the busy/pending disabled
 * semantics. Deterministic: deferred promises + `waitFor`, no timers.
 */

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SET_ROLE_PERMISSIONS_ERROR_LABELS } from '../lib/auth/managerApprovalTypes';
import type { RolePermissionMatrix } from '../lib/staffManagement/types';

type Outcome = { requiresStaging: boolean };

const hook = vi.hoisted(() => ({
  roleMatrix: null as RolePermissionMatrix | null,
  pendingRoles: new Set<string>(),
  updateRoleMatrix: null as null | ((role: string, key: string, value: boolean) => Promise<Outcome>),
  resetRoleMatrix: null as null | (() => Promise<Outcome>),
  resetCalls: 0,
}));

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    branchId: 'branch-1',
    user: { id: 'actor-1', firstName: 'ผู้', lastName: 'ทดสอบ', role: 'admin', branchIds: ['branch-1'] },
  }),
}));

vi.mock('../lib/branches', () => ({
  getBranchLabel: (id: string) => id,
  seedBranchLabelCache: () => undefined,
  useActiveBranches: () => ({ branches: [{ id: 'branch-1', name: 'สาขาทดสอบ' }] }),
}));

vi.mock('../lib/admin/branchManagement', () => ({
  fetchAllBranches: () => Promise.resolve([{ id: 'branch-1', name: 'สาขาทดสอบ' }]),
}));

vi.mock('../components/staff/StaffFormModal', () => ({ default: () => null }));

vi.mock('../lib/stockReport/exportCsv', () => ({ downloadCsv: () => undefined }));

vi.mock('../lib/staffManagement/useStaffManagement', () => ({
  useStaffManagement: () => ({
    users: [],
    activities: [],
    roleMatrix: hook.roleMatrix,
    pendingRoles: hook.pendingRoles,
    loading: false,
    error: null,
    saveUser: () => Promise.resolve(),
    toggleActive: () => Promise.resolve(),
    softDeleteUser: () => Promise.resolve(),
    updateRoleMatrix: (role: string, key: string, value: boolean) => {
      if (!hook.updateRoleMatrix) throw new Error('updateRoleMatrix fixture missing');
      return hook.updateRoleMatrix(role, key, value);
    },
    resetRoleMatrix: () => {
      hook.resetCalls += 1;
      if (!hook.resetRoleMatrix) throw new Error('resetRoleMatrix fixture missing');
      return hook.resetRoleMatrix();
    },
  }),
}));

import StaffManagementPage from './StaffManagementPage';
import AdminStaffManagementPage from './admin/AdminStaffManagementPage';

const SEEDED: RolePermissionMatrix = {
  admin: ['pos_sale', 'settings'],
  manager: ['pos_sale', 'report_sales'],
  staff: ['pos_sale', 'product_view'],
};

const STAGED_MESSAGE = 'กำลังดำเนินการถอนสิทธิ์ ระบบจะอัปเดตให้เสร็จในอีกสักครู่';
const RESET_SUCCESS = 'Reset สิทธิ์เป็นค่าเริ่มต้นเรียบร้อย';
const STAGING_ACTIVE_LABEL = SET_ROLE_PERMISSIONS_ERROR_LABELS.staging_already_active;
/** Must match `ROLE_PERMISSION_BUSY_MESSAGE` in useStaffManagement.ts. */
const BUSY_MESSAGE = 'กำลังบันทึกสิทธิ์อยู่ กรุณารอให้เสร็จก่อนแล้วลองใหม่';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const PAGES = [
  { name: 'StaffManagementPage', Component: StaffManagementPage },
  { name: 'AdminStaffManagementPage', Component: AdminStaffManagementPage },
] as const;

/** Opens the permissions tab and returns the Reset button. */
async function renderPermissionsTab(Component: (typeof PAGES)[number]['Component']) {
  render(createElement(Component));
  fireEvent.click(screen.getByText('สิทธิ์การใช้งาน'));
  const reset = await screen.findByRole('button', { name: /Reset Default/i });
  return reset as HTMLButtonElement;
}

/** All checkboxes in the row whose label matches, ordered admin/manager/staff. */
function togglesForPermission(label: string): HTMLInputElement[] {
  const labelNode = screen.getByText(label);
  const row = labelNode.closest('.sm-perm-row');
  if (!row) throw new Error(`permission row not found for ${label}`);
  return within(row as HTMLElement).getAllByRole('checkbox') as HTMLInputElement[];
}

beforeEach(() => {
  hook.roleMatrix = SEEDED;
  hook.pendingRoles = new Set<string>();
  hook.updateRoleMatrix = () => Promise.resolve({ requiresStaging: false });
  hook.resetRoleMatrix = () => Promise.resolve({ requiresStaging: false });
  hook.resetCalls = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each(PAGES)('$name role-permission operator feedback', ({ Component }) => {
  it('P1 — Reset success toast appears only after the server resolves', async () => {
    const gate = deferred<Outcome>();
    hook.resetRoleMatrix = () => gate.promise;

    const reset = await renderPermissionsTab(Component);
    fireEvent.click(reset);

    // Still in flight — no success claim yet.
    await waitFor(() => expect(reset.disabled).toBe(true));
    expect(screen.queryByText(RESET_SUCCESS)).toBeNull();

    gate.resolve({ requiresStaging: false });
    expect(await screen.findByText(RESET_SUCCESS)).toBeTruthy();
  });

  it('P2 — Reset failure shows the mapped error and never a success toast', async () => {
    hook.resetRoleMatrix = () => Promise.reject(new Error('ไม่มีสิทธิ์แก้ไขสิทธิ์การใช้งาน'));

    const reset = await renderPermissionsTab(Component);
    fireEvent.click(reset);

    expect(await screen.findByText('ไม่มีสิทธิ์แก้ไขสิทธิ์การใช้งาน')).toBeTruthy();
    expect(screen.queryByText(RESET_SUCCESS)).toBeNull();
  });

  it('P3 — Reset staging_already_active surfaces the exact Thai label', async () => {
    hook.resetRoleMatrix = () => Promise.reject(new Error(STAGING_ACTIVE_LABEL));

    const reset = await renderPermissionsTab(Component);
    fireEvent.click(reset);

    expect(await screen.findByText(STAGING_ACTIVE_LABEL)).toBeTruthy();
    expect(
      screen.getByText('มีการเปลี่ยนแปลงสิทธิ์ role นี้ที่กำลังดำเนินการอยู่ กรุณารอสักครู่แล้วลองใหม่'),
    ).toBeTruthy();
    expect(screen.queryByText(RESET_SUCCESS)).toBeNull();
  });

  it('P4 — toggle rejection is caught at the page boundary and shown as a warning', async () => {
    hook.updateRoleMatrix = () => Promise.reject(new Error('ไม่สามารถบันทึกสิทธิ์การใช้งานได้'));

    await renderPermissionsTab(Component);
    const [, managerToggle] = togglesForPermission('ขายสินค้า');
    fireEvent.click(managerToggle);

    expect(await screen.findByText('ไม่สามารถบันทึกสิทธิ์การใช้งานได้')).toBeTruthy();
  });

  it('P5 — toggle staging_already_active surfaces the exact Thai label', async () => {
    hook.updateRoleMatrix = () => Promise.reject(new Error(STAGING_ACTIVE_LABEL));

    await renderPermissionsTab(Component);
    const [, managerToggle] = togglesForPermission('ขายสินค้า');
    fireEvent.click(managerToggle);

    expect(await screen.findByText(STAGING_ACTIVE_LABEL)).toBeTruthy();
  });

  it('P6 — staged toggle success shows the info notice, not a completion claim', async () => {
    hook.updateRoleMatrix = () => Promise.resolve({ requiresStaging: true });

    await renderPermissionsTab(Component);
    const [, managerToggle] = togglesForPermission('ขายสินค้า');
    fireEvent.click(managerToggle);

    expect(await screen.findByText(STAGED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(RESET_SUCCESS)).toBeNull();
  });

  it('P7 — Reset locks itself and every toggle while in flight, and cannot double-fire', async () => {
    const gate = deferred<Outcome>();
    hook.resetRoleMatrix = () => gate.promise;

    const reset = await renderPermissionsTab(Component);
    fireEvent.click(reset);

    await waitFor(() => expect(reset.disabled).toBe(true));
    for (const toggle of togglesForPermission('ขายสินค้า')) {
      expect(toggle.disabled).toBe(true);
    }

    // Repeated clicks on the disabled button do not reach the hook again.
    fireEvent.click(reset);
    fireEvent.click(reset);
    expect(hook.resetCalls).toBe(1);

    gate.resolve({ requiresStaging: false });
    await waitFor(() => expect(reset.disabled).toBe(false));
  });

  it('P8 — only the pending role is disabled; unrelated roles stay interactive', async () => {
    hook.pendingRoles = new Set<string>(['manager']);

    await renderPermissionsTab(Component);
    const [adminToggle, managerToggle, staffToggle] = togglesForPermission('ขายสินค้า');

    expect(managerToggle!.disabled).toBe(true);
    expect(staffToggle!.disabled).toBe(false);
    // admin stays locked for its own pre-existing reason.
    expect(adminToggle!.disabled).toBe(true);
  });

  it('P9 — non-staged toggle success emits no toast, proven by a post-await read signal', async () => {
    // The page handler does `const result = await updateRoleMatrix(...)` and
    // only then reads `result.requiresStaging`. Exposing that property as a
    // getter therefore gives a signal that is physically impossible to observe
    // before the await boundary has completed and the result was consumed.
    let requiresStagingReads = 0;
    const nonStagedOutcome = {
      get requiresStaging() {
        requiresStagingReads += 1;
        return false;
      },
    } as Outcome;

    const gate = deferred<Outcome>();
    hook.updateRoleMatrix = () => gate.promise;

    await renderPermissionsTab(Component);
    const [, managerToggle] = togglesForPermission('ขายสินค้า');
    fireEvent.click(managerToggle);

    // Unresolved: the handler cannot have consumed a result yet.
    expect(requiresStagingReads).toBe(0);

    await act(async () => {
      gate.resolve(nonStagedOutcome);
      await gate.promise;
    });

    // Positive post-resolution proof for THIS invocation: the page read the
    // resolved outcome, so the handler provably passed its await boundary.
    await waitFor(() => expect(requiresStagingReads).toBe(1));

    // Only now is the absence of feedback meaningful.
    expect(screen.queryByText(STAGED_MESSAGE)).toBeNull();
    expect(screen.queryByText(RESET_SUCCESS)).toBeNull();
    expect(screen.queryByText(BUSY_MESSAGE)).toBeNull();
    expect(screen.queryByText(STAGING_ACTIVE_LABEL)).toBeNull();
  });

  it('P9b — a staged toggle result does render the info toast', async () => {
    // Independent scenario. It is NOT proof that P9's non-staged invocation
    // completed; P9 proves that for itself via its own post-await read signal.
    hook.updateRoleMatrix = () => Promise.resolve({ requiresStaging: true });

    await renderPermissionsTab(Component);
    const [, managerToggle] = togglesForPermission('ขายสินค้า');
    fireEvent.click(managerToggle);

    expect(await screen.findByText(STAGED_MESSAGE)).toBeTruthy();
  });

  it('P10 — Reset is disabled while any role toggle is pending', async () => {
    hook.pendingRoles = new Set<string>(['manager']);

    const reset = await renderPermissionsTab(Component);

    // Hook-level exclusivity is reinforced in the UI: Reset cannot be started
    // while a toggle is still in flight.
    expect(reset.disabled).toBe(true);
  });

  it('P11 — a guard rejection shows the error and never a success toast', async () => {
    // Local guard refusals (missing actor/branch, busy locks) reject rather than
    // resolving a success-shaped outcome, so the page must not claim success.
    hook.resetRoleMatrix = () => Promise.reject(new Error(BUSY_MESSAGE));

    const reset = await renderPermissionsTab(Component);
    fireEvent.click(reset);

    expect(await screen.findByText(BUSY_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(RESET_SUCCESS)).toBeNull();
    expect(screen.queryByText(STAGED_MESSAGE)).toBeNull();
    // Busy flag released, so the operator can retry.
    await waitFor(() => expect(reset.disabled).toBe(false));
  });

  it('P12 — a guard rejection on toggle shows the error and no success feedback', async () => {
    hook.updateRoleMatrix = () => Promise.reject(new Error(BUSY_MESSAGE));

    await renderPermissionsTab(Component);
    const [, managerToggle] = togglesForPermission('ขายสินค้า');
    fireEvent.click(managerToggle);

    expect(await screen.findByText(BUSY_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(STAGED_MESSAGE)).toBeNull();
    expect(screen.queryByText(RESET_SUCCESS)).toBeNull();
  });
});
