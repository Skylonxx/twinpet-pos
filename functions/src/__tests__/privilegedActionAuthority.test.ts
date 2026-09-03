import { describe, expect, test } from 'vitest';
import {
  decideLiveRolePermission,
  resolveLivePosVoid,
  type RolePermissionsDocSnapshot,
} from '../privilegedActionAuthority';

const granted: RolePermissionsDocSnapshot = {
  exists: true,
  data: {
    rolePermissions: {
      admin: ['pos_sale', 'pos_void'],
      manager: ['pos_sale', 'pos_void'],
      staff: ['pos_sale', 'pos_void'],
    },
  },
};

describe('decideLiveRolePermission — privileged void source of truth', () => {
  test('present valid row with pos_void allows', () => {
    expect(decideLiveRolePermission('staff', 'pos_void', granted)).toEqual({
      allowed: true,
      reason: 'granted',
    });
    expect(decideLiveRolePermission('manager', 'pos_void', granted)).toEqual({
      allowed: true,
      reason: 'granted',
    });
    expect(decideLiveRolePermission('admin', 'pos_void', granted)).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  test('explicit empty role rows deny and do not fall back to privileged defaults', () => {
    const emptyRows: RolePermissionsDocSnapshot = {
      exists: true,
      data: { rolePermissions: { admin: [], manager: [], staff: [] } },
    };
    expect(decideLiveRolePermission('admin', 'pos_void', emptyRows)).toEqual({
      allowed: false,
      reason: 'role_row_empty',
    });
    expect(decideLiveRolePermission('manager', 'pos_void', emptyRows)).toEqual({
      allowed: false,
      reason: 'role_row_empty',
    });
    expect(decideLiveRolePermission('staff', 'pos_void', emptyRows)).toEqual({
      allowed: false,
      reason: 'role_row_empty',
    });
  });

  test('valid row without pos_void denies', () => {
    const noVoid: RolePermissionsDocSnapshot = {
      exists: true,
      data: { rolePermissions: { staff: ['pos_sale', 'product_view'] } },
    };
    expect(decideLiveRolePermission('staff', 'pos_void', noVoid)).toEqual({
      allowed: false,
      reason: 'permission_absent',
    });
  });

  test('absent document fails closed (login defaults are not reused)', () => {
    expect(decideLiveRolePermission('manager', 'pos_void', { exists: false, data: undefined })).toEqual({
      allowed: false,
      reason: 'document_absent',
    });
  });

  test('missing role key fails closed', () => {
    const snap: RolePermissionsDocSnapshot = {
      exists: true,
      data: { rolePermissions: { manager: ['pos_void'] } },
    };
    expect(decideLiveRolePermission('staff', 'pos_void', snap)).toEqual({
      allowed: false,
      reason: 'role_key_absent',
    });
  });

  test('malformed matrix and malformed rows deny', () => {
    expect(
      decideLiveRolePermission('manager', 'pos_void', { exists: true, data: null }),
    ).toEqual({ allowed: false, reason: 'matrix_malformed' });
    expect(
      decideLiveRolePermission('manager', 'pos_void', { exists: true, data: { rolePermissions: ['pos_void'] } }),
    ).toEqual({ allowed: false, reason: 'matrix_malformed' });
    expect(
      decideLiveRolePermission('manager', 'pos_void', {
        exists: true,
        data: { rolePermissions: { manager: 'pos_void' } },
      }),
    ).toEqual({ allowed: false, reason: 'role_row_malformed' });
    expect(
      decideLiveRolePermission('manager', 'pos_void', {
        exists: true,
        data: { rolePermissions: { manager: [1, 'pos_void'] } },
      }),
    ).toEqual({ allowed: false, reason: 'role_row_malformed' });
  });

  test('null role is denied', () => {
    expect(decideLiveRolePermission(null, 'pos_void', granted)).toEqual({
      allowed: false,
      reason: 'role_absent',
    });
  });
});

describe('resolveLivePosVoid — unreadable source', () => {
  test('reader throw is document_unreadable deny', async () => {
    const decision = await resolveLivePosVoid({} as never, 'manager', async () => {
      throw new Error('unavailable');
    });
    expect(decision).toEqual({ allowed: false, reason: 'document_unreadable' });
  });
});
