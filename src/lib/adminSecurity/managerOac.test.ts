import { describe, expect, it, vi } from 'vitest';

vi.mock('../firebase', () => ({
  app: undefined,
  auth: undefined,
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));
import {
  NATIVE_MANAGER_OAC_STATUS_COMMAND,
  NATIVE_REVOKE_MANAGER_OAC_COMMAND,
  projectApprovalCapability,
  readManagerOacStatus,
  revokeManagerOac,
  type NativeManagerOacStatus,
} from './managerOac';

function nativeStatus(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    managerStaffId: 'mgr-1',
    capability: 'PRESENT',
    branchId: 'LDP-001',
    fresh: true,
    issuedAtServerMs: 1,
    freshnessExpiresAtServerMs: 2,
    authVersionAtIssue: 3,
    credentialVersionAtIssue: 2,
    lockedOut: false,
    consecutiveFailedAttempts: 0,
    maxFailedAttempts: 5,
    errorCode: null,
    ...over,
  };
}

describe('readManagerOacStatus', () => {
  it('calls only the read-only command with only the manager id and projects safe fields', async () => {
    const invoke = vi.fn(async () => nativeStatus());
    const status = await readManagerOacStatus('mgr-1', invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(NATIVE_MANAGER_OAC_STATUS_COMMAND, { managerStaffId: 'mgr-1' });
    expect(status).toEqual({
      kind: 'read',
      capability: 'PRESENT',
      branchId: 'LDP-001',
      fresh: true,
      authVersionAtIssue: 3,
      lockedOut: false,
      consecutiveFailedAttempts: 0,
      maxFailedAttempts: 5,
    });
  });

  it('fails closed to unavailable on throw, wrong manager echo, bad shape, non-canonical id or no bridge', async () => {
    expect(await readManagerOacStatus('mgr-1', vi.fn(async () => { throw new Error('x'); }))).toEqual({ kind: 'unavailable' });
    expect(await readManagerOacStatus('mgr-1', vi.fn(async () => nativeStatus({ managerStaffId: 'mgr-2' })))).toEqual({ kind: 'unavailable' });
    expect(await readManagerOacStatus('mgr-1', vi.fn(async () => nativeStatus({ capability: 'WEIRD' })))).toEqual({ kind: 'unavailable' });
    expect(await readManagerOacStatus('mgr-1', vi.fn(async () => nativeStatus({ ok: false })))).toEqual({ kind: 'unavailable' });
    const invoke = vi.fn();
    expect(await readManagerOacStatus('../mgr', invoke)).toEqual({ kind: 'unavailable' });
    expect(invoke).not.toHaveBeenCalled();
    expect(await readManagerOacStatus('mgr-1', null)).toEqual({ kind: 'unavailable' });
  });
});

describe('revokeManagerOac', () => {
  it('revokes exactly the named manager via the target-bound command', async () => {
    const invoke = vi.fn(async () => ({ ok: true, managerStaffId: 'mgr-1', revoked: true, errorCode: null }));
    expect(await revokeManagerOac('mgr-1', invoke)).toBe('revoked');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(NATIVE_REVOKE_MANAGER_OAC_COMMAND, { managerStaffId: 'mgr-1' });
  });

  it('reports none / failed / not_native', async () => {
    expect(await revokeManagerOac('mgr-1', vi.fn(async () => ({ ok: true, managerStaffId: 'mgr-1', revoked: false })))).toBe('none');
    expect(await revokeManagerOac('mgr-1', vi.fn(async () => ({ ok: true, managerStaffId: 'other', revoked: true })))).toBe('failed');
    expect(await revokeManagerOac('mgr-1', vi.fn(async () => { throw new Error('io'); }))).toBe('failed');
    expect(await revokeManagerOac('mgr 1', vi.fn())).toBe('failed');
    expect(await revokeManagerOac('mgr-1', null)).toBe('not_native');
  });
});

describe('projectApprovalCapability', () => {
  const read = (over: Partial<Extract<NativeManagerOacStatus, { kind: 'read' }>> = {}): NativeManagerOacStatus => ({
    kind: 'read',
    capability: 'PRESENT',
    branchId: 'LDP-001',
    fresh: true,
    authVersionAtIssue: 3,
    lockedOut: false,
    consecutiveFailedAttempts: 0,
    maxFailedAttempts: 5,
    ...over,
  });
  const base = { role: 'manager', isActive: true, branchIds: ['LDP-001'], liveAuthVersion: 3, terminalBranchId: 'LDP-001' };

  it('ready only for an exact, fresh binding', () => {
    expect(projectApprovalCapability({ ...base, status: read() })).toBe('ready');
    expect(projectApprovalCapability({ ...base, branchIds: ['ALL'], role: 'admin', status: read() })).toBe('ready');
  });

  it('expired when exact but not fresh', () => {
    expect(projectApprovalCapability({ ...base, status: read({ fresh: false }) })).toBe('expired');
  });

  it('missing / locked / unknown', () => {
    expect(projectApprovalCapability({ ...base, status: read({ capability: 'MISSING' }) })).toBe('missing');
    expect(projectApprovalCapability({ ...base, status: read({ lockedOut: true }) })).toBe('locked');
    expect(projectApprovalCapability({ ...base, status: { kind: 'unavailable' } })).toBe('unknown');
  });

  it('fails closed to reissue_required whenever the binding is no longer exact', () => {
    expect(projectApprovalCapability({ ...base, status: read({ capability: 'INVALID' }) })).toBe('reissue_required');
    // Quick PIN rotation / any account mutation bumps authVersion.
    expect(projectApprovalCapability({ ...base, liveAuthVersion: 4, status: read() })).toBe('reissue_required');
    // Demoted to staff.
    expect(projectApprovalCapability({ ...base, role: 'staff', status: read() })).toBe('reissue_required');
    // Disabled.
    expect(projectApprovalCapability({ ...base, isActive: false, status: read() })).toBe('reissue_required');
    // Current branch access removed / transferred away.
    expect(projectApprovalCapability({ ...base, branchIds: ['BKK-002'], status: read() })).toBe('reissue_required');
    // OAC issued for another branch than this terminal's.
    expect(projectApprovalCapability({ ...base, status: read({ branchId: 'BKK-002' }) })).toBe('reissue_required');
    // No concrete terminal branch.
    expect(projectApprovalCapability({ ...base, terminalBranchId: null, status: read() })).toBe('reissue_required');
  });
});
