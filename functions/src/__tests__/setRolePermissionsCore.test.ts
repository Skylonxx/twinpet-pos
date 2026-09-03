import { describe, expect, it } from 'vitest';
import {
  buildStagedRoleDenyDocs,
  checkNoActiveStaging,
  computeRolePermissionChange,
  interimMatrixRow,
  isRoleId,
  isValidPermissionsArray,
} from '../setRolePermissionsCore';

describe('isRoleId / isValidPermissionsArray', () => {
  it('accepts known roles', () => {
    expect(isRoleId('staff')).toBe(true);
    expect(isRoleId('owner')).toBe(false);
  });
  it('validates a clean permission array', () => {
    expect(isValidPermissionsArray(['pos_sale', 'pos_void'])).toBe(true);
    expect(isValidPermissionsArray(['pos_sale', 'pos_sale'])).toBe(false);
    expect(isValidPermissionsArray(['pos_sale', ''])).toBe(false);
    expect(isValidPermissionsArray('not-an-array')).toBe(false);
  });
});

describe('computeRolePermissionChange', () => {
  it('detects pure additions (no staging required)', () => {
    const change = computeRolePermissionChange(['pos_sale'], ['pos_sale', 'pos_void']);
    expect(change.addedPermissions).toEqual(['pos_void']);
    expect(change.removedPermissions).toEqual([]);
    expect(change.requiresStaging).toBe(false);
  });

  it('detects removals (staging required)', () => {
    const change = computeRolePermissionChange(['pos_sale', 'pos_void'], ['pos_sale']);
    expect(change.removedPermissions).toEqual(['pos_void']);
    expect(change.requiresStaging).toBe(true);
  });

  it('detects a mixed add+remove change', () => {
    const change = computeRolePermissionChange(['pos_sale', 'pos_void'], ['pos_sale', 'report_stock']);
    expect(change.addedPermissions).toEqual(['report_stock']);
    expect(change.removedPermissions).toEqual(['pos_void']);
    expect(change.requiresStaging).toBe(true);
  });

  it('is a no-op for an identical row', () => {
    const change = computeRolePermissionChange(['pos_sale'], ['pos_sale']);
    expect(change.addedPermissions).toEqual([]);
    expect(change.removedPermissions).toEqual([]);
    expect(change.requiresStaging).toBe(false);
  });
});

describe('interimMatrixRow', () => {
  it('keeps removed permissions present until finalize (union of current + added)', () => {
    const change = computeRolePermissionChange(['pos_sale', 'pos_void'], ['pos_sale', 'report_stock']);
    expect(interimMatrixRow(change).sort()).toEqual(['pos_sale', 'pos_void', 'report_stock'].sort());
  });
});

describe('checkNoActiveStaging', () => {
  it('allows staging when nothing is active', () => {
    expect(checkNoActiveStaging(null)).toEqual({ ok: true });
    expect(checkNoActiveStaging({ state: 'COMPLETED' })).toEqual({ ok: true });
  });
  it('rejects when a round is already active', () => {
    expect(checkNoActiveStaging({ state: 'DRAINING' })).toEqual({ ok: false, code: 'staging_already_active' });
    expect(checkNoActiveStaging({ state: 'VERIFYING' })).toEqual({ ok: false, code: 'staging_already_active' });
    expect(checkNoActiveStaging({ state: 'CONVERGED' })).toEqual({ ok: false, code: 'staging_already_active' });
  });
});

describe('buildStagedRoleDenyDocs', () => {
  it('builds a matching head/job pair, both DRAINING with the same changeId', () => {
    const change = computeRolePermissionChange(['pos_sale', 'pos_void'], ['pos_sale']);
    const { head, job } = buildStagedRoleDenyDocs('staff', change, 1000, Buffer.alloc(16, 1), Buffer.alloc(16, 2));
    expect(head.state).toBe('DRAINING');
    expect(job.state).toBe('DRAINING');
    expect(head.changeId).toBe(job.changeId);
    expect(head.deniedPermissions).toEqual(['pos_void']);
    expect(head.targetRow).toEqual(['pos_sale']);
    expect(job.targetRow).toEqual(['pos_sale']);
    expect(job.roleId).toBe('staff');
  });
});
