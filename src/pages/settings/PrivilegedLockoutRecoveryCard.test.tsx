// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PrivilegedLockoutRecoveryCard, { LOCKOUT_RECOVERY_COPY } from './PrivilegedLockoutRecoveryCard';
import { useApproverRoster } from '../../lib/auth/useApproverRoster';
import {
  __resetPrivilegedLockoutRecoveryForTests,
  type IssueLockoutClearTransport,
  type NativeInvoke,
} from '../../lib/auth/privilegedLockoutRecovery';

vi.mock('../../lib/firebase', () => ({
  app: undefined,
  auth: undefined,
  db: undefined,
  isFirebaseConfigured: false,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));

vi.mock('../../lib/auth/useApproverRoster', () => ({
  useApproverRoster: vi.fn(),
}));

const mockRoster = vi.mocked(useApproverRoster);

const ADMIN = { id: 'adminUid01', role: 'admin' };
const MANAGER = 'zcVi9fMgr01';
const DEVICE = 'ab'.repeat(16);
const LOCKOUT = 'cd'.repeat(32);
const LCT1 = 'TENUMQEC'.repeat(20);

function locked(cooldownRemainingMs = 0) {
  return {
    ok: true,
    managerStaffId: MANAGER,
    lockedOut: true,
    consecutiveFailedAttempts: 5,
    lockedAtMs: 1,
    cooldownRemainingMs,
    securityDeviceIdHex: DEVICE,
    lockoutIdHex: LOCKOUT,
    clearTokenRecorded: false,
    errorCode: null,
  };
}
const NOT_LOCKED = { ok: false, lockedOut: false, cooldownRemainingMs: 0, errorCode: 'NOT_LOCKED' };

function native(contexts: unknown[], clear: unknown = { ok: true, managerStaffId: MANAGER, reopensNow: true }) {
  const calls: string[] = [];
  let reads = 0;
  const invoke: NativeInvoke = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'native_get_privileged_lockout_recovery_context') {
      const next = contexts[Math.min(reads, contexts.length - 1)];
      reads += 1;
      return next;
    }
    if (cmd === 'native_clear_offline_lockout') return clear;
    throw new Error(cmd);
  };
  return { invoke, calls };
}

type IssueMock = ReturnType<typeof vi.fn<IssueLockoutClearTransport>>;

function renderCard(opts: { invoke: NativeInvoke | null; issue?: IssueMock; operator?: { id: string; role: string } | null }) {
  const issue: IssueMock = opts.issue ?? vi.fn<IssueLockoutClearTransport>(async () => ({
    ok: true,
    lct1Base64: LCT1,
    securityDeviceIdHex: DEVICE,
    managerStaffId: MANAGER,
    lockoutIdHex: LOCKOUT,
    issuedAtServerMs: 1000,
    expiresAtServerMs: 901_000,
  }));
  const view = render(
    <PrivilegedLockoutRecoveryCard
      branchId="LDP-001"
      operator={opts.operator === undefined ? ADMIN : opts.operator}
      deps={{ invoke: opts.invoke, issueLockoutClear: issue, isPrimaryAdminPrincipal: async () => true }}
    />,
  );
  return { ...view, issue };
}

async function selectManager() {
  fireEvent.change(await screen.findByLabelText('ผู้จัดการ / ผู้อนุมัติ'), { target: { value: MANAGER } });
}

describe('PrivilegedLockoutRecoveryCard (D-V15)', () => {
  beforeEach(() => {
    __resetPrivilegedLockoutRecoveryForTests();
    mockRoster.mockReturnValue({
      status: 'ready',
      fromCache: false,
      candidates: [{ userId: MANAGER, displayName: 'ผู้จัดการ LDP', username: 'ldpmgr', role: 'manager' }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing for a non-admin and never reads native state', () => {
    for (const operator of [{ id: 'm1', role: 'manager' }, { id: 's1', role: 'staff' }, null]) {
      const { invoke, calls } = native([locked()]);
      const { container } = renderCard({ invoke, operator });
      expect(container.innerHTML).toBe('');
      expect(calls).toHaveLength(0);
      cleanup();
    }
  });

  it('shows the native-only notice when there is no native bridge', () => {
    renderCard({ invoke: null });
    expect(screen.getByText(LOCKOUT_RECOVERY_COPY.nativeOnly)).toBeTruthy();
  });

  it('roster binding: excludes the admin operator and lists only roster candidates', () => {
    const { invoke } = native([locked()]);
    renderCard({ invoke });
    expect(mockRoster).toHaveBeenCalledWith({ enabled: true, branchId: 'LDP-001', requesterStaffId: ADMIN.id });
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', MANAGER]);
  });

  it('cooldown > 0: shows remaining minutes, offers no unlock action, never calls the server', async () => {
    const { invoke, calls } = native([locked(7 * 60_000 - 1)]);
    const { issue } = renderCard({ invoke });
    await selectManager();
    expect(await screen.findByText(LOCKOUT_RECOVERY_COPY.locked)).toBeTruthy();
    expect(screen.getByText(`${LOCKOUT_RECOVERY_COPY.cooldownPrefix} 7 นาที`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: LOCKOUT_RECOVERY_COPY.title })).toBeNull();
    expect(issue).not.toHaveBeenCalled();
    expect(calls).not.toContain('native_clear_offline_lockout');
  });

  it('locked + cooldown 0: confirm → one issuance + one native clear → success that requires Close', async () => {
    const { invoke, calls } = native([locked(), locked(), NOT_LOCKED, NOT_LOCKED]);
    const { issue, container } = renderCard({ invoke });
    await selectManager();
    fireEvent.click(await screen.findByRole('button', { name: LOCKOUT_RECOVERY_COPY.title }));
    expect(screen.getByText(LOCKOUT_RECOVERY_COPY.confirm)).toBeTruthy();
    expect(issue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันปลดล็อก' }));

    expect(await screen.findByText(LOCKOUT_RECOVERY_COPY.success)).toBeTruthy();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c === 'native_clear_offline_lockout')).toHaveLength(1);
    // Success stays until the operator closes it.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(LOCKOUT_RECOVERY_COPY.success)).toBeTruthy();

    const html = container.innerHTML;
    for (const secret of [DEVICE, LOCKOUT, LCT1, 'NOT_LOCKED', 'DENIED']) {
      expect(html.includes(secret), secret).toBe(false);
    }

    fireEvent.click(screen.getByRole('button', { name: 'ปิด' }));
    expect(await screen.findByText(LOCKOUT_RECOVERY_COPY.notLocked)).toBeTruthy();
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('callable refusal: generic failure, no native clear, no raw code rendered', async () => {
    const { invoke, calls } = native([locked(), locked()]);
    const issue = vi.fn<IssueLockoutClearTransport>(async () => ({ ok: false, code: 'not_authorized' }));
    const { container } = renderCard({ invoke, issue });
    await selectManager();
    fireEvent.click(await screen.findByRole('button', { name: LOCKOUT_RECOVERY_COPY.title }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันปลดล็อก' }));
    expect(await screen.findByText(LOCKOUT_RECOVERY_COPY.failure)).toBeTruthy();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain('native_clear_offline_lockout');
    expect(container.innerHTML.includes('not_authorized')).toBe(false);
  });

  it('native clear failure: generic failure, exactly one issuance and one clear', async () => {
    const { invoke, calls } = native([locked(), locked()], { ok: false, managerStaffId: MANAGER, reopensNow: false, errorCode: 'DENIED_UNVERIFIABLE' });
    const { issue, container } = renderCard({ invoke });
    await selectManager();
    fireEvent.click(await screen.findByRole('button', { name: LOCKOUT_RECOVERY_COPY.title }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันปลดล็อก' }));
    expect(await screen.findByText(LOCKOUT_RECOVERY_COPY.failure)).toBeTruthy();
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c === 'native_clear_offline_lockout')).toHaveLength(1);
    expect(container.innerHTML.includes('DENIED_UNVERIFIABLE')).toBe(false);
  });

  it('Admin & Security Center V1 supersedes the standalone card mount (same recovery lib, per-manager row)', () => {
    const settings = readFileSync(resolve(__dirname, '..', 'SettingsPage.tsx'), 'utf8');
    expect(settings).not.toMatch(/<PrivilegedLockoutRecoveryCard/);
    expect(settings).toMatch(/<AdminSecurityCenter operator=\{user\} branchId=\{branchId\} \/>/);
    const card = readFileSync(resolve(__dirname, 'PrivilegedLockoutRecoveryCard.tsx'), 'utf8');
    expect(card).not.toMatch(/console\.|localStorage|sessionStorage|lockoutIdHex|securityDeviceIdHex|lct1Base64/);
  });
});
