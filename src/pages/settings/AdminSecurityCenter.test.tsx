// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/firebase', () => ({
  app: undefined,
  auth: undefined,
  db: undefined,
  collections: { settings: 'settings', branches: 'branches' },
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));

import AdminSecurityCenter from './AdminSecurityCenter';
import { __resetAdminSecurityServiceForTests, type AdminSecurityDeps } from '../../lib/adminSecurity/adminSecurityService';
import { cloneDefaultMatrix } from '../../lib/staffManagement/types';

const ADMIN = { id: 'uid-admin-self', role: 'admin' };
const PIN = '4826';

const QPO = { accountAuthClassification: 'QUICK_PIN_ONLY' };
const USERS = [
  { userId: 'uid-admin-self', firstName: 'Ad', lastName: 'Min', username: 'admin', role: 'admin', branchIds: ['ALL'], isActive: true, authVersion: 2, quickPinState: 'set', securityAdminClassification: 'PASSWORD_ADMIN', accountAuthClassification: 'PASSWORD_PRINCIPAL' },
  { userId: 'uid-ready-1', firstName: 'Nara', lastName: 'Ready', username: 'nara', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 3, quickPinState: 'set', ...QPO },
  { userId: 'uid-locked-1', firstName: 'Lock', lastName: 'Ed', username: 'locked', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 1, quickPinState: 'set', ...QPO },
  { userId: 'uid-missing-1', firstName: 'Mana', lastName: 'Missing', username: 'mana', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 1, quickPinState: 'set', ...QPO },
  { userId: 'uid-staff-1', firstName: 'Som', lastName: 'Staff', username: 'som', role: 'staff', branchIds: ['LDP-001'], isActive: true, authVersion: 0, quickPinState: 'required', ...QPO },
];

// D-ASC9 fixtures: another Security Admin, a POS (Quick PIN) admin and an admin the server could not classify.
const ADMIN_USERS = [
  ...USERS,
  { userId: 'uid-secadmin-2', firstName: 'Sec', lastName: 'Two', username: 'secadmin', role: 'admin', branchIds: ['ALL'], isActive: true, authVersion: 4, quickPinState: 'set', securityAdminClassification: 'PASSWORD_ADMIN', accountAuthClassification: 'PASSWORD_PRINCIPAL' },
  { userId: 'uid-posadmin-1', firstName: 'Pos', lastName: 'Admin', username: 'posadmin', role: 'admin', branchIds: ['LDP-001'], isActive: true, authVersion: 1, quickPinState: 'set', securityAdminClassification: 'POS_ADMIN', ...QPO },
  { userId: 'uid-unknown-admin', firstName: 'Unk', lastName: 'Nown', username: 'unknown', role: 'admin', branchIds: ['LDP-001'], isActive: false, authVersion: 1, quickPinState: 'set', securityAdminClassification: 'UNKNOWN', accountAuthClassification: 'UNKNOWN' },
];

// D-ASC12/D-ASC13 fixtures: password-backed and unclassified staff / managers.
const PROTECTED_USERS = [
  ...USERS,
  { userId: 'uid-pw-mgr-1', firstName: 'Pass', lastName: 'Manager', username: 'pwmgr', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 3, quickPinState: 'set', accountAuthClassification: 'PASSWORD_PRINCIPAL' },
  { userId: 'uid-pw-mgr-locked', firstName: 'Pass', lastName: 'Locked', username: 'pwlocked', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 1, quickPinState: 'set', accountAuthClassification: 'PASSWORD_PRINCIPAL' },
  { userId: 'uid-pw-staff-1', firstName: 'Pass', lastName: 'Staff', username: 'pwstaff', role: 'staff', branchIds: ['LDP-001'], isActive: false, authVersion: 0, quickPinState: 'set', accountAuthClassification: 'PASSWORD_PRINCIPAL' },
  { userId: 'uid-unk-mgr-1', firstName: 'Unk', lastName: 'Manager', username: 'unkmgr', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 3, quickPinState: 'set', accountAuthClassification: 'UNKNOWN' },
  { userId: 'uid-unk-staff-1', firstName: 'Unk', lastName: 'Staff', username: 'unkstaff', role: 'staff', branchIds: ['LDP-001'], isActive: true, authVersion: 0, quickPinState: 'set' },
];

function nativeStatusFor(id: string) {
  const base = {
    ok: true,
    managerStaffId: id,
    capability: 'PRESENT',
    branchId: 'LDP-001',
    fresh: true,
    authVersionAtIssue: 3,
    lockedOut: false,
    consecutiveFailedAttempts: 0,
    maxFailedAttempts: 5,
  };
  if (id === 'uid-locked-1' || id === 'uid-pw-mgr-locked') return { ...base, lockedOut: true, consecutiveFailedAttempts: 5, authVersionAtIssue: 1 };
  if (id === 'uid-missing-1') return { ...base, capability: 'MISSING', branchId: null, authVersionAtIssue: null };
  return base;
}

function setup(
  over: Partial<AdminSecurityDeps> = {},
  opts: { native?: boolean; users?: unknown[]; branchId?: string | null } = {},
) {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'native_get_manager_oac_status') return nativeStatusFor(String(args?.managerStaffId));
    throw new Error(`unexpected native command ${cmd}`);
  });
  const fetchOverview = vi.fn(async () => ({
    ok: true,
    users: opts.users ?? USERS,
    events: [{ type: 'QUICK_PIN_ROTATED', actorStaffId: 'uid-admin-self', targetStaffId: 'uid-ready-1', createdAtMs: 1_790_000_000_000 }],
  }));
  const callSetUserAccount = vi.fn(async (cmd: { op: string; userId?: string }) => ({ ok: true, status: 'updated', userId: cmd.userId }));
  const revokeOac = vi.fn(async () => 'revoked' as const);
  const provision = vi.fn<(input: unknown, deps?: unknown) => Promise<{ kind: 'provisioned' }>>(async () => ({ kind: 'provisioned' }));
  const runLockoutRecovery = vi.fn<(input: unknown, deps?: unknown) => Promise<{ kind: 'recovered' }>>(async () => ({ kind: 'recovered' }));
  const service: AdminSecurityDeps = {
    isAdminPasswordSession: vi.fn(async () => true),
    fetchOverview,
    callSetUserAccount,
    revokeOac,
    provision,
    runLockoutRecovery,
    loadRoleMatrix: async () => cloneDefaultMatrix(),
    newKey: () => 'k',
    ...over,
  };
  const view = render(
    <AdminSecurityCenter
      operator={ADMIN}
      branchId={opts.branchId === undefined ? 'LDP-001' : opts.branchId}
      deps={{
        service,
        invoke: opts.native === false ? null : invoke,
        fetchBranches: async () => [{ id: 'LDP-001', name: 'ลาดพร้าว' }],
      }}
    />,
  );
  return { ...view, invoke, service, fetchOverview, callSetUserAccount, revokeOac, provision, runLockoutRecovery };
}

async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name);
  return cell.closest('[data-testid="admin-user-row"]') as HTMLElement;
}

beforeEach(() => __resetAdminSecurityServiceForTests());
afterEach(cleanup);

describe('AdminSecurityCenter — access', () => {
  it('a Quick PIN / non-password session sees the required-login message, no data and no mutation controls', async () => {
    const h = setup({ isAdminPasswordSession: vi.fn(async () => false) });
    expect(await screen.findByTestId('admin-password-required')).toBeTruthy();
    expect(screen.getByText('ต้องเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่านของผู้ดูแลระบบเพื่อจัดการความปลอดภัย')).toBeTruthy();
    expect(screen.getByTestId('admin-session-badge').textContent).toBe('ต้องเข้าสู่ระบบแบบผู้ดูแลระบบ');
    expect(screen.queryByText('เพิ่มผู้ใช้งาน')).toBeNull();
    expect(h.fetchOverview).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('a manager operator is treated the same (gate never passes)', async () => {
    const service: AdminSecurityDeps = { isAdminPasswordSession: vi.fn(async () => true), fetchOverview: vi.fn() };
    render(<AdminSecurityCenter operator={{ id: 'm', role: 'manager' }} branchId="LDP-001" deps={{ service, invoke: null }} />);
    expect(await screen.findByTestId('admin-password-required')).toBeTruthy();
    expect(service.fetchOverview).not.toHaveBeenCalled();
  });
});

describe('AdminSecurityCenter — user list', () => {
  it('renders safe fields and per-terminal approval states without raw ids, PINs or a hard-delete control', async () => {
    const { container } = setup();
    expect(await screen.findByText('Admin password session')).toBeTruthy();
    expect(screen.getByText('Admin & ความปลอดภัย')).toBeTruthy();
    expect(screen.getByText('จัดการผู้ใช้งาน PIN สิทธิ์อนุมัติ และความปลอดภัยของเครื่อง')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('admin-oac-state')).toHaveLength(4));

    const ready = await rowFor('Nara Ready');
    expect(within(ready).getByTestId('admin-oac-state').textContent).toBe('พร้อมใช้');
    expect(within(ready).getByTestId('admin-lockout-state').textContent).toBe('ปกติ');
    expect(within(ready).queryByText('ปลดล็อกสิทธิ์อนุมัติ')).toBeNull();

    const locked = await rowFor('Lock Ed');
    expect(within(locked).getByTestId('admin-oac-state').textContent).toBe('ถูกล็อก');
    expect(within(locked).getByTestId('admin-lockout-state').textContent).toBe('ถูกล็อกบนเครื่องนี้');
    expect(within(locked).getByText('ปลดล็อกสิทธิ์อนุมัติ')).toBeTruthy();

    const missing = await rowFor('Mana Missing');
    expect(within(missing).getByTestId('admin-oac-state').textContent).toBe('ไม่มี');

    const staff = await rowFor('Som Staff');
    expect(within(staff).getByText('ต้องตั้งค่า')).toBeTruthy();
    expect(within(staff).queryByTestId('admin-oac-state')).toBeNull();

    const self = await rowFor('Ad Min');
    expect(within(self).getByText('บัญชีของคุณ')).toBeTruthy();
    expect(within(self).queryByText('เปลี่ยน Quick PIN')).toBeNull();
    expect(within(self).queryByText('ปิดใช้งาน', { selector: 'button' })).toBeNull();

    const html = container.innerHTML;
    expect(html).not.toContain('uid-');
    expect(html).not.toMatch(/pinHash|verifier|lockoutId|deviceId|oacId|LCT1/);
    expect(screen.queryAllByRole('button').some((b) => /^ลบ/.test(b.textContent ?? ''))).toBe(false);

    // Activity from server-authored events, names not ids.
    const activity = screen.getByTestId('admin-activity');
    expect(within(activity).getByText('เปลี่ยน Quick PIN')).toBeTruthy();
    expect(activity.textContent).toContain('Nara Ready (nara)');
    expect(activity.textContent).toContain('สิทธิ์ Offline เดิมใช้ไม่ได้แล้ว');
  });

  it('on the web runtime the approval column says native-only and offers no OAC/lockout actions', async () => {
    setup({}, { native: false });
    const ready = await rowFor('Nara Ready');
    expect(within(ready).getByText('ใช้ได้เฉพาะในแอป Twinpet POS')).toBeTruthy();
    expect(within(ready).queryByText('ออกสิทธิ์ Offline ใหม่')).toBeNull();
  });
});

describe('AdminSecurityCenter — Quick PIN rotation', () => {
  it('requires matching 4-digit PINs, rotates once, revokes only the target OAC, never auto-reissues and clears the PIN', async () => {
    const h = setup();
    const row = await rowFor('Nara Ready');
    fireEvent.click(within(row).getByText('เปลี่ยน Quick PIN'));
    const dialog = await screen.findByTestId('admin-change-pin-dialog');
    expect(within(dialog).getByText('ระบบจะไม่แสดง PIN เดิม กรุณาตั้ง PIN ใหม่')).toBeTruthy();
    const newPin = within(dialog).getByLabelText('PIN ใหม่') as HTMLInputElement;
    const confirm = within(dialog).getByLabelText('ยืนยัน PIN ใหม่') as HTMLInputElement;
    expect(newPin.type).toBe('password');
    expect(confirm.type).toBe('password');
    expect(newPin.value).toBe('');

    fireEvent.change(newPin, { target: { value: PIN } });
    fireEvent.change(confirm, { target: { value: '4827' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'เปลี่ยน Quick PIN' }));
    expect(await within(dialog).findByText('PIN ใหม่และการยืนยันไม่ตรงกัน')).toBeTruthy();
    expect(newPin.value).toBe('');
    expect(h.callSetUserAccount).not.toHaveBeenCalled();

    fireEvent.change(newPin, { target: { value: PIN } });
    fireEvent.change(confirm, { target: { value: PIN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'เปลี่ยน Quick PIN' }));

    expect(await screen.findByText('Quick PIN เปลี่ยนแล้ว — ต้องออกสิทธิ์ Offline ใหม่')).toBeTruthy();
    expect(h.callSetUserAccount).toHaveBeenCalledTimes(1);
    expect(h.callSetUserAccount.mock.calls[0]![0]).toMatchObject({ op: 'rotate', userId: 'uid-ready-1', pin: PIN });
    expect(h.revokeOac).toHaveBeenCalledTimes(1);
    expect(h.revokeOac).toHaveBeenCalledWith('uid-ready-1');
    expect(h.provision).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('admin-change-pin-dialog')).toBeNull());
    expect(document.body.innerHTML).not.toContain(PIN);
  });
});

describe('AdminSecurityCenter — offline approval capability reissue', () => {
  async function enterPin(modal: HTMLElement, pin: string) {
    for (const d of pin) fireEvent.click(within(modal).getByText(d));
    fireEvent.click(within(modal).getByText('ยืนยัน'));
  }

  it('names the selected manager prominently, uses THAT manager and PIN once, and reports success', async () => {
    const h = setup();
    const row = await rowFor('Mana Missing');
    fireEvent.click(within(row).getByText('ออกสิทธิ์ Offline ใหม่'));
    const modal = await screen.findByTestId('reissue-oac-pin-modal');
    expect(within(modal).getByTestId('reissue-manager-identity').textContent).toBe('ผู้จัดการ: Mana Missing (mana)');
    expect(within(modal).getByTestId('reissue-pin-instruction').textContent).toBe('กรุณาใส่ Quick PIN ของ Mana Missing');
    await enterPin(modal, PIN);
    expect(await screen.findByText('ออกสิทธิ์ Offline ใหม่แล้ว')).toBeTruthy();
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(h.provision.mock.calls[0]![0]).toEqual({ managerStaffId: 'uid-missing-1', branchId: 'LDP-001', pin: PIN });
    expect(document.body.innerHTML).not.toContain(PIN);
  });

  it('a wrong manager PIN names the manager and is never retried', async () => {
    const provision = vi.fn(async () => ({ kind: 'pin_rejected' as const }));
    setup({ provision });
    const row = await rowFor('Mana Missing');
    fireEvent.click(within(row).getByText('ออกสิทธิ์ Offline ใหม่'));
    await enterPin(await screen.findByTestId('reissue-oac-pin-modal'), PIN);
    expect(await screen.findByText('Quick PIN ของ Mana Missing ไม่ถูกต้อง')).toBeTruthy();
    expect(provision).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('reissue-oac-pin-modal')).toBeNull();
  });

  it('a still-valid capability needs an explicit confirmation before any PIN entry', async () => {
    const h = setup();
    const row = await rowFor('Nara Ready');
    fireEvent.click(within(row).getByText('ออกสิทธิ์ Offline ใหม่'));
    const confirm = await screen.findByTestId('admin-confirm-dialog');
    expect(confirm.textContent).toContain('ยังใช้ได้อยู่');
    expect(screen.queryByTestId('reissue-oac-pin-modal')).toBeNull();
    fireEvent.click(within(confirm).getByRole('button', { name: 'ออกสิทธิ์ Offline ใหม่' }));
    expect(await screen.findByTestId('reissue-oac-pin-modal')).toBeTruthy();
    expect(h.provision).not.toHaveBeenCalled();
  });
});

describe('AdminSecurityCenter — lockout + disable', () => {
  it('clears a locked manager through the reused recovery episode exactly once', async () => {
    const h = setup();
    const row = await rowFor('Lock Ed');
    fireEvent.click(within(row).getByText('ปลดล็อกสิทธิ์อนุมัติ'));
    const confirm = await screen.findByTestId('admin-confirm-dialog');
    expect(confirm.textContent).toContain('ผู้จัดการ: Lock Ed (locked)');
    fireEvent.click(within(confirm).getByRole('button', { name: 'ปลดล็อกสิทธิ์อนุมัติ' }));
    expect(await screen.findByText('ปลดล็อกสิทธิ์อนุมัติแล้ว')).toBeTruthy();
    expect(h.runLockoutRecovery).toHaveBeenCalledTimes(1);
    expect(h.runLockoutRecovery.mock.calls[0]![0]).toEqual({ managerStaffId: 'uid-locked-1', operator: ADMIN });
  });

  it('a failed clear shows the fixed failure copy and is not retried', async () => {
    const runLockoutRecovery = vi.fn(async () => ({ kind: 'failed' as const }));
    setup({ runLockoutRecovery });
    fireEvent.click(within(await rowFor('Lock Ed')).getByText('ปลดล็อกสิทธิ์อนุมัติ'));
    const confirm = await screen.findByTestId('admin-confirm-dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'ปลดล็อกสิทธิ์อนุมัติ' }));
    expect(await screen.findByText('ปลดล็อกสิทธิ์อนุมัติไม่สำเร็จ กรุณาติดต่อผู้ดูแลระบบ')).toBeTruthy();
    expect(runLockoutRecovery).toHaveBeenCalledTimes(1);
  });

  it('disable asks for confirmation, uses setActive once and revokes only that user\'s local OAC', async () => {
    const h = setup();
    fireEvent.click(within(await rowFor('Nara Ready')).getByRole('button', { name: 'ปิดใช้งาน' }));
    const confirm = await screen.findByTestId('admin-confirm-dialog');
    expect(h.callSetUserAccount).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'ปิดใช้งาน' }));
    expect(await screen.findByText('ปิดใช้งานผู้ใช้แล้ว')).toBeTruthy();
    expect(h.callSetUserAccount).toHaveBeenCalledWith({ op: 'setActive', userId: 'uid-ready-1', isActive: false });
    expect(h.revokeOac.mock.calls).toEqual([['uid-ready-1']]);
  });
});

describe('AdminSecurityCenter — add user', () => {
  function fill(dialog: HTMLElement, values: Record<string, string>) {
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    }
  }

  it('refuses a duplicate username locally, then creates through the canonical op once with an active user', async () => {
    const h = setup();
    fireEvent.click(await screen.findByText('เพิ่มผู้ใช้งาน'));
    const dialog = await screen.findByTestId('admin-user-form-dialog');
    fill(dialog, { ชื่อ: 'Pim', นามสกุล: 'New', 'ชื่อผู้ใช้ (username)': 'NARA', 'Quick PIN เริ่มต้น': PIN, 'ยืนยัน Quick PIN': PIN });
    fireEvent.click(within(dialog).getByLabelText('ลาดพร้าว'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'เพิ่มผู้ใช้งาน' }));
    expect(await within(dialog).findByText('username นี้ถูกใช้แล้ว')).toBeTruthy();
    expect(h.callSetUserAccount).not.toHaveBeenCalled();
    expect((within(dialog).getByLabelText('Quick PIN เริ่มต้น') as HTMLInputElement).value).toBe('');

    fill(dialog, { 'ชื่อผู้ใช้ (username)': 'pim', 'Quick PIN เริ่มต้น': PIN, 'ยืนยัน Quick PIN': PIN });
    fireEvent.change(within(dialog).getByLabelText('บทบาท'), { target: { value: 'manager' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'เพิ่มผู้ใช้งาน' }));
    expect(await screen.findByText('เพิ่มผู้ใช้งานแล้ว')).toBeTruthy();
    expect(h.callSetUserAccount).toHaveBeenCalledTimes(1);
    expect(h.callSetUserAccount.mock.calls[0]![0]).toMatchObject({
      op: 'create',
      username: 'pim',
      firstName: 'Pim',
      role: 'manager',
      branchIds: ['LDP-001'],
      isActive: true,
      pin: PIN,
    });
    expect(h.revokeOac).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(PIN);
  });
});

describe('AdminSecurityCenter — D-ASC9 Security Admin vs POS Admin', () => {
  const MUTATION_LABELS = ['แก้ไขผู้ใช้', 'เปลี่ยน Quick PIN', 'ปลดล็อกสิทธิ์อนุมัติ', 'ออกสิทธิ์ Offline ใหม่', 'ปิดใช้งาน', 'เปิดใช้งาน'];
  function mutationButtons(row: HTMLElement): string[] {
    return within(row)
      .queryAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => MUTATION_LABELS.includes(t));
  }

  it('labels Security Admin and POS Admin rows distinctly; Security Admin and UNKNOWN rows have no mutation controls', async () => {
    const h = setup({}, { users: ADMIN_USERS });

    const sec = await rowFor('Sec Two');
    expect(within(sec).getByTestId('admin-role-label').textContent).toBe('Security Admin');
    expect(within(sec).getByTestId('admin-role-hint').textContent).toBe('เข้า Admin & ความปลอดภัยด้วย username/password');
    expect(within(sec).getByTestId('admin-row-readonly').textContent).toBe('จัดการผ่าน Owner Recovery');
    expect(mutationButtons(sec)).toEqual([]);

    const self = await rowFor('Ad Min');
    expect(within(self).getByTestId('admin-role-label').textContent).toBe('Security Admin');
    expect(within(self).getByTestId('admin-row-readonly').textContent).toBe('จัดการผ่าน Owner Recovery');
    expect(mutationButtons(self)).toEqual([]);

    const pos = await rowFor('Pos Admin');
    expect(within(pos).getByTestId('admin-role-label').textContent).toBe('POS Admin (Quick PIN)');
    expect(within(pos).getByTestId('admin-role-hint').textContent).toBe('จัดการงาน POS ได้ตามสิทธิ์ แต่ใช้ Admin & ความปลอดภัยไม่ได้');
    expect(within(pos).queryByTestId('admin-row-readonly')).toBeNull();
    expect(mutationButtons(pos)).toEqual(expect.arrayContaining(['แก้ไขผู้ใช้', 'เปลี่ยน Quick PIN', 'ปิดใช้งาน']));

    const unknown = await rowFor('Unk Nown');
    expect(within(unknown).getByTestId('admin-role-label').textContent).toBe('ผู้ดูแลระบบ (ยืนยันประเภทไม่ได้)');
    expect(within(unknown).getByTestId('admin-row-readonly')).toBeTruthy();
    expect(mutationButtons(unknown)).toEqual([]); // not even "เปิดใช้งาน" for the disabled unknown admin

    // Manager / staff labels unchanged.
    expect(within(await rowFor('Nara Ready')).getByTestId('admin-role-label').textContent).toBe('ผู้จัดการ');
    expect(within(await rowFor('Som Staff')).getByTestId('admin-role-label').textContent).toBe('พนักงาน');
    expect(h.callSetUserAccount).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toMatch(/@|providerId|email/);
  });

  it('a POS admin row is still manageable (rotate goes through the canonical op once)', async () => {
    const h = setup({}, { users: ADMIN_USERS });
    fireEvent.click(within(await rowFor('Pos Admin')).getByText('เปลี่ยน Quick PIN'));
    const dialog = await screen.findByTestId('admin-change-pin-dialog');
    fireEvent.change(within(dialog).getByLabelText('PIN ใหม่'), { target: { value: PIN } });
    fireEvent.change(within(dialog).getByLabelText('ยืนยัน PIN ใหม่'), { target: { value: PIN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'เปลี่ยน Quick PIN' }));
    await waitFor(() => expect(h.callSetUserAccount).toHaveBeenCalledTimes(1));
    expect(h.callSetUserAccount.mock.calls[0]![0]).toMatchObject({ op: 'rotate', userId: 'uid-posadmin-1' });
  });

  it('a server Owner Recovery refusal is shown verbatim and touches no local OAC', async () => {
    const { SetUserAccountError } = await import('../../lib/auth/setUserAccount');
    const callSetUserAccount = vi.fn(async () => {
      throw new SetUserAccountError('บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery', 'functions/failed-precondition');
    });
    const h = setup({ callSetUserAccount }, { users: ADMIN_USERS });
    fireEvent.click(within(await rowFor('Pos Admin')).getByRole('button', { name: 'ปิดใช้งาน' }));
    fireEvent.click(within(await screen.findByTestId('admin-confirm-dialog')).getByRole('button', { name: 'ปิดใช้งาน' }));
    expect(await screen.findByText('บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery')).toBeTruthy();
    expect(h.revokeOac).not.toHaveBeenCalled();
  });

  it('add-user offers "POS Admin (Quick PIN)" with a warning, submits internal role admin, and has no password field', async () => {
    const h = setup();
    fireEvent.click(await screen.findByText('เพิ่มผู้ใช้งาน'));
    const dialog = await screen.findByTestId('admin-user-form-dialog');
    const roleSelect = within(dialog).getByLabelText('บทบาท') as HTMLSelectElement;
    const options = [...roleSelect.options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['staff', 'พนักงาน'],
      ['manager', 'ผู้จัดการ'],
      ['admin', 'POS Admin (Quick PIN)'],
    ]);
    expect(dialog.textContent).not.toContain('ผู้ดูแลระบบ');
    expect(within(dialog).queryByTestId('admin-pos-admin-warning')).toBeNull();

    fireEvent.change(roleSelect, { target: { value: 'admin' } });
    expect(within(dialog).getByTestId('admin-pos-admin-warning').textContent).toBe(
      'บัญชีนี้ใช้ Quick PIN สำหรับงาน POS และไม่ใช่ Security Admin แบบ username/password',
    );
    // Only the two masked Quick PIN fields exist — no password / email input.
    expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(2);
    expect(within(dialog).queryByLabelText(/รหัสผ่าน|password|อีเมล|email/i)).toBeNull();

    const values: Record<string, string> = {
      ชื่อ: 'Pos',
      นามสกุล: 'New',
      'ชื่อผู้ใช้ (username)': 'posnew',
      'Quick PIN เริ่มต้น': PIN,
      'ยืนยัน Quick PIN': PIN,
    };
    for (const [label, value] of Object.entries(values)) {
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    }
    fireEvent.click(within(dialog).getByLabelText('ลาดพร้าว'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'เพิ่มผู้ใช้งาน' }));
    await waitFor(() => expect(h.callSetUserAccount).toHaveBeenCalledTimes(1));
    const payload = h.callSetUserAccount.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({ op: 'create', role: 'admin', username: 'posnew' });
    expect(Object.keys(payload).sort()).toEqual(
      ['branchIds', 'firstName', 'idempotencyKey', 'isActive', 'lastName', 'op', 'permissions', 'pin', 'role', 'username'].sort(),
    );
  });
});

describe('AdminSecurityCenter — D-ASC10 ALL workspace (no concrete terminal branch)', () => {
  for (const branchId of ['ALL', null]) {
    it(`branchId=${String(branchId)}: branch-bound approval actions are off with safe copy; account administration still works`, async () => {
      const h = setup({}, { branchId });
      const locked = await rowFor('Lock Ed');
      const ready = await rowFor('Nara Ready');
      for (const row of [locked, ready, await rowFor('Mana Missing')]) {
        expect(within(row).getByTestId('admin-oac-branch-required').textContent).toBe('เลือกสาขาจริงก่อนจัดการสิทธิ์อนุมัติบนเครื่องนี้');
        expect(within(row).queryByTestId('admin-oac-state')).toBeNull();
        expect(within(row).queryByText('ออกสิทธิ์ Offline ใหม่')).toBeNull();
        expect(within(row).queryByText('ปลดล็อกสิทธิ์อนุมัติ')).toBeNull();
        // Ordinary account administration is not terminal-branch-bound.
        expect(within(row).getByText('แก้ไขผู้ใช้')).toBeTruthy();
        expect(within(row).getByText('เปลี่ยน Quick PIN')).toBeTruthy();
      }
      expect(within(await rowFor('Som Staff')).queryByTestId('admin-oac-branch-required')).toBeNull();
      expect(screen.getByText('เพิ่มผู้ใช้งาน')).toBeTruthy();

      fireEvent.click(within(ready).getByRole('button', { name: 'ปิดใช้งาน' }));
      fireEvent.click(within(await screen.findByTestId('admin-confirm-dialog')).getByRole('button', { name: 'ปิดใช้งาน' }));
      expect(await screen.findByText('ปิดใช้งานผู้ใช้แล้ว')).toBeTruthy();
      expect(h.callSetUserAccount).toHaveBeenCalledWith({ op: 'setActive', userId: 'uid-ready-1', isActive: false });
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.runLockoutRecovery).not.toHaveBeenCalled();
      // Nothing branch-bound was ever sent to native with a substituted branch.
      for (const call of h.invoke.mock.calls) expect(call[0]).toBe('native_get_manager_oac_status');
    });
  }
});

describe('AdminSecurityCenter — D-ASC11 promotion to POS Admin', () => {
  const PROMOTION_REFUSAL = 'บัญชีที่มีการเข้าสู่ระบบด้วยรหัสผ่านไม่สามารถเปลี่ยนเป็น POS Admin ผ่านหน้านี้ได้ กรุณาใช้ Owner Recovery';

  async function promoteViaDialog(name: string) {
    fireEvent.click(within(await rowFor(name)).getByText('แก้ไขผู้ใช้'));
    const dialog = await screen.findByTestId('admin-user-form-dialog');
    fireEvent.change(within(dialog).getByLabelText('บทบาท'), { target: { value: 'admin' } });
    return dialog;
  }

  it('the edit dialog never tells a staff/manager they are safely a Quick PIN POS Admin', async () => {
    setup();
    const dialog = await promoteViaDialog('Nara Ready');
    expect(within(dialog).queryByTestId('admin-pos-admin-warning')).toBeNull();
    expect(within(dialog).getByTestId('admin-pos-admin-promote-warning').textContent).toBe(
      'เปลี่ยนเป็น POS Admin ได้เฉพาะบัญชีที่ใช้ Quick PIN เท่านั้น บัญชีที่มีการเข้าสู่ระบบด้วยรหัสผ่านจะถูกปฏิเสธและต้องใช้ Owner Recovery',
    );
    expect(dialog.textContent).not.toContain('บัญชีนี้ใช้ Quick PIN');
    expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('a password-backed manager → POS Admin: server refusal shown verbatim, no local OAC revoke, row stays manager', async () => {
    const { SetUserAccountError } = await import('../../lib/auth/setUserAccount');
    const callSetUserAccount = vi.fn(async () => {
      throw new SetUserAccountError(PROMOTION_REFUSAL, 'functions/failed-precondition');
    });
    const h = setup({ callSetUserAccount });
    const dialog = await promoteViaDialog('Nara Ready');
    fireEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findByText(PROMOTION_REFUSAL)).toBeTruthy();
    expect(callSetUserAccount).toHaveBeenCalledTimes(1);
    expect((callSetUserAccount.mock.calls[0] as unknown[])[0]).toMatchObject({ op: 'updateProfile', userId: 'uid-ready-1', role: 'admin' });
    expect(h.revokeOac).not.toHaveBeenCalled();
    // The reloaded server truth still says manager; nothing claims an admin.
    await waitFor(() => expect(h.fetchOverview).toHaveBeenCalledTimes(2));
    expect(within(await rowFor('Nara Ready')).getByTestId('admin-role-label').textContent).toBe('ผู้จัดการ');
  });

  it('a Quick-PIN-only manager → POS Admin is accepted through one canonical updateProfile and revokes only that OAC', async () => {
    const h = setup();
    const dialog = await promoteViaDialog('Mana Missing');
    fireEvent.click(within(dialog).getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(h.callSetUserAccount).toHaveBeenCalledTimes(1));
    const cmd = h.callSetUserAccount.mock.calls[0]![0] as Record<string, unknown>;
    expect(cmd).toMatchObject({ op: 'updateProfile', userId: 'uid-missing-1', role: 'admin', branchIds: ['LDP-001'] });
    expect(cmd.permissions).toBeTruthy();
    expect(Object.keys(cmd)).not.toContain('pin');
    expect(await screen.findByText('บันทึกแล้ว — ต้องออกสิทธิ์ Offline ใหม่')).toBeTruthy();
    expect(h.revokeOac.mock.calls).toEqual([['uid-missing-1']]);
  });
});

describe('AdminSecurityCenter — source hygiene', () => {
  it('never logs, persists or URL-encodes PINs and never touches business data', () => {
    for (const file of ['AdminSecurityCenter.tsx', 'AdminSecurityDialogs.tsx']) {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      expect(src, file).not.toMatch(/console\.|localStorage|sessionStorage|location\.|history\.push|URLSearchParams/);
      expect(src, file).not.toMatch(/orders|payments|stockMovements|productStocks|submitPrivilegedVoid|softDelete/);
    }
  });
});

describe('AdminSecurityCenter — D-ASC13 password-backed / unclassified staff & manager rows', () => {
  const MUTATION_LABELS = ['แก้ไขผู้ใช้', 'เปลี่ยน Quick PIN', 'ปลดล็อกสิทธิ์อนุมัติ', 'ออกสิทธิ์ Offline ใหม่', 'ปิดใช้งาน', 'เปิดใช้งาน'];
  function mutationButtons(row: HTMLElement): string[] {
    return within(row)
      .queryAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => MUTATION_LABELS.includes(t));
  }

  for (const branchId of ['LDP-001', 'ALL']) {
    it(`branchId=${branchId}: password-backed rows are marked username/password, read-only, Owner Recovery`, async () => {
      const h = setup({}, { users: PROTECTED_USERS, branchId });
      for (const name of ['Pass Manager', 'Pass Locked', 'Pass Staff']) {
        const row = await rowFor(name);
        expect(within(row).getByTestId('admin-password-principal-badge').textContent).toBe('username/password');
        expect(within(row).getByTestId('admin-row-readonly').textContent).toBe('จัดการผ่าน Owner Recovery');
        expect(mutationButtons(row)).toEqual([]); // no edit / PIN / enable-disable / OAC reissue / lockout clear
      }
      expect(within(await rowFor('Pass Manager')).getByTestId('admin-role-label').textContent).toBe('ผู้จัดการ');
      expect(within(await rowFor('Pass Staff')).getByTestId('admin-role-label').textContent).toBe('พนักงาน');
      expect(h.callSetUserAccount).not.toHaveBeenCalled();
      expect(h.revokeOac).not.toHaveBeenCalled();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.runLockoutRecovery).not.toHaveBeenCalled();
      expect(document.body.innerHTML).not.toMatch(/@|providerId|email|PASSWORD_PRINCIPAL|uid-/);
    });
  }

  it('a password-backed manager keeps a safe read-only approval status but gets no lockout clear or reissue', async () => {
    setup({}, { users: PROTECTED_USERS });
    await waitFor(() => expect(screen.getAllByTestId('admin-oac-state').length).toBeGreaterThanOrEqual(6));
    const locked = await rowFor('Pass Locked');
    expect(within(locked).getByTestId('admin-oac-state').textContent).toBe('ถูกล็อก');
    expect(within(locked).getByTestId('admin-lockout-state').textContent).toBe('ถูกล็อกบนเครื่องนี้');
    expect(within(locked).queryByText('ปลดล็อกสิทธิ์อนุมัติ')).toBeNull();
    const ready = await rowFor('Pass Manager');
    expect(within(ready).getByTestId('admin-oac-state').textContent).toBe('พร้อมใช้');
    expect(within(ready).queryByText('ออกสิทธิ์ Offline ใหม่')).toBeNull();
  });

  it('UNKNOWN staff / manager rows are read-only with the fail-closed copy and no badge', async () => {
    const h = setup({}, { users: PROTECTED_USERS });
    for (const name of ['Unk Manager', 'Unk Staff']) {
      const row = await rowFor(name);
      expect(within(row).getByTestId('admin-row-readonly').textContent).toBe('ยืนยันประเภทบัญชีไม่ได้ — ลองโหลดใหม่ภายหลัง');
      expect(within(row).queryByTestId('admin-password-principal-badge')).toBeNull();
      expect(mutationButtons(row)).toEqual([]);
    }
    expect(h.callSetUserAccount).not.toHaveBeenCalled();
  });

  it('Quick-PIN-only staff / manager rows keep their normal actions and carry no username/password badge', async () => {
    setup({}, { users: PROTECTED_USERS });
    const locked = await rowFor('Lock Ed');
    await waitFor(() => expect(within(locked).getByText('ปลดล็อกสิทธิ์อนุมัติ')).toBeTruthy());
    expect(mutationButtons(locked)).toEqual(expect.arrayContaining(['แก้ไขผู้ใช้', 'เปลี่ยน Quick PIN', 'ปลดล็อกสิทธิ์อนุมัติ', 'ปิดใช้งาน']));
    const missing = await rowFor('Mana Missing');
    expect(mutationButtons(missing)).toEqual(expect.arrayContaining(['แก้ไขผู้ใช้', 'เปลี่ยน Quick PIN', 'ออกสิทธิ์ Offline ใหม่', 'ปิดใช้งาน']));
    const staff = await rowFor('Som Staff');
    expect(mutationButtons(staff)).toEqual(['แก้ไขผู้ใช้', 'เปลี่ยน Quick PIN', 'ปิดใช้งาน']);
    for (const row of [locked, missing, staff]) {
      expect(within(row).queryByTestId('admin-password-principal-badge')).toBeNull();
      expect(within(row).queryByTestId('admin-row-readonly')).toBeNull();
    }
  });

  it('admin rows are unchanged: no username/password badge on Security Admin / POS Admin / UNKNOWN admin', async () => {
    setup({}, { users: ADMIN_USERS });
    for (const name of ['Sec Two', 'Pos Admin', 'Unk Nown', 'Ad Min']) {
      expect(within(await rowFor(name)).queryByTestId('admin-password-principal-badge')).toBeNull();
    }
    expect(within(await rowFor('Unk Nown')).getByTestId('admin-row-readonly').textContent).toBe('อ่านอย่างเดียว — ลองโหลดใหม่ภายหลัง');
  });

  for (const message of [
    'บัญชีนี้มีการเข้าสู่ระบบด้วย username/password จึงต้องจัดการผ่าน Owner Recovery',
    'ไม่สามารถยืนยันประเภทการเข้าสู่ระบบของบัญชีนี้ได้ จึงยังไม่บันทึกการเปลี่ยนแปลง กรุณาลองใหม่ภายหลัง',
  ]) {
    it(`a definite server refusal on a stale Quick-PIN-only row is shown verbatim and revokes no local OAC: ${message.slice(0, 24)}…`, async () => {
      const { SetUserAccountError } = await import('../../lib/auth/setUserAccount');
      const callSetUserAccount = vi.fn(async () => {
        throw new SetUserAccountError(message, 'functions/failed-precondition');
      });
      const h = setup({ callSetUserAccount });
      fireEvent.click(within(await rowFor('Nara Ready')).getByText('เปลี่ยน Quick PIN'));
      const dialog = await screen.findByTestId('admin-change-pin-dialog');
      fireEvent.change(within(dialog).getByLabelText('PIN ใหม่'), { target: { value: PIN } });
      fireEvent.change(within(dialog).getByLabelText('ยืนยัน PIN ใหม่'), { target: { value: PIN } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'เปลี่ยน Quick PIN' }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(callSetUserAccount).toHaveBeenCalledTimes(1);
      expect(h.revokeOac).not.toHaveBeenCalled();
      expect(document.body.innerHTML).not.toContain(PIN);
    });
  }
});
