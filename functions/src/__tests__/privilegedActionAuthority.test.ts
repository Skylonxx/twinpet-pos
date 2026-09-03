import { describe, expect, test } from 'vitest';
import {
  decideLiveRolePermission,
  firestoreStagedRoleDenyHeadReader,
  resolveLivePosVoid,
  resolveLivePrivilegedPermission,
  stagedDenyReader,
  type RolePermissionsDocSnapshot,
  type StagedRoleDenyHead,
} from '../privilegedActionAuthority';

/** Minimal Firestore-shaped fake exercising the real `collection().doc().get()` path. */
function fakeFirestore(docs: Record<string, unknown>) {
  return {
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const path = `${col}/${id}`;
          const exists = Object.prototype.hasOwnProperty.call(docs, path);
          return { exists, data: () => (exists ? docs[path] : undefined) };
        },
      }),
    }),
  } as never;
}

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

describe('resolveLivePosVoid — staged-deny reader failure fails closed (SEC-001 C-A-RC-003)', () => {
  test('staged-deny head reader throw denies even though the base matrix grants the permission', async () => {
    const decision = await resolveLivePosVoid(
      {} as never,
      'manager',
      async () => granted,
      async () => {
        throw new Error('staged-deny head unavailable');
      },
    );
    expect(decision).toEqual({ allowed: false, reason: 'staged_deny_unreadable' });
  });
});

describe('firestoreStagedRoleDenyHeadReader — present malformed head fails closed (SEC-001 C-A-RC-003-R1)', () => {
  test('present head with malformed deniedPermissions is not the same as absent and fails closed', async () => {
    const db = fakeFirestore({
      'privilegedStagedRoleDeny/staff': { state: 'DRAINING', changeId: 'change-1', deniedPermissions: [42] },
    });
    const decision = await resolveLivePrivilegedPermission(db, 'staff', 'pos_void', async () => granted);
    expect(decision).toEqual({ allowed: false, reason: 'staged_deny_unreadable' });
  });

  test('present head with malformed changeId fails closed', async () => {
    const db = fakeFirestore({
      'privilegedStagedRoleDeny/staff': { state: 'DRAINING', changeId: 123, deniedPermissions: ['pos_void'] },
    });
    const decision = await resolveLivePrivilegedPermission(db, 'staff', 'pos_void', async () => granted);
    expect(decision).toEqual({ allowed: false, reason: 'staged_deny_unreadable' });
  });

  test('present head with malformed state fails closed', async () => {
    const db = fakeFirestore({
      'privilegedStagedRoleDeny/staff': { state: 'BOGUS', changeId: 'change-1', deniedPermissions: ['pos_void'] },
    });
    const decision = await resolveLivePrivilegedPermission(db, 'staff', 'pos_void', async () => granted);
    expect(decision).toEqual({ allowed: false, reason: 'staged_deny_unreadable' });
  });

  test('a truly absent staged-deny document is still read as no active staging round', async () => {
    const db = fakeFirestore({});
    const decision = await resolveLivePrivilegedPermission(db, 'staff', 'pos_void', async () => granted);
    expect(decision).toEqual({ allowed: true, reason: 'granted' });
    const reader = firestoreStagedRoleDenyHeadReader(db);
    await expect(reader('staff')).resolves.toBeNull();
  });

  test('a present well-formed head still resolves via the default reader', async () => {
    const db = fakeFirestore({
      'privilegedStagedRoleDeny/staff': { state: 'VERIFYING', changeId: 'change-1', deniedPermissions: ['pos_void'] },
    });
    const reader = firestoreStagedRoleDenyHeadReader(db);
    await expect(reader('staff')).resolves.toEqual({
      roleId: 'staff',
      state: 'VERIFYING',
      changeId: 'change-1',
      deniedPermissions: ['pos_void'],
    });
  });
});

describe('stagedDenyReader — F7 (SEC-001 Packet C-A)', () => {
  const head: StagedRoleDenyHead = {
    roleId: 'staff',
    state: 'DRAINING',
    changeId: 'change-1',
    deniedPermissions: ['pos_void'],
  };

  test('returns the denied list for a matching changeId in an active state', () => {
    expect(stagedDenyReader(head, 'change-1')).toEqual(['pos_void']);
  });

  test('returns [] for a null head', () => {
    expect(stagedDenyReader(null, 'change-1')).toEqual([]);
  });

  test('returns [] for a mismatched changeId', () => {
    expect(stagedDenyReader(head, 'change-2')).toEqual([]);
  });

  test('returns [] once state is COMPLETED, even with a matching changeId', () => {
    expect(stagedDenyReader({ ...head, state: 'COMPLETED' }, 'change-1')).toEqual([]);
  });

  test('returns the denied list for every active state', () => {
    expect(stagedDenyReader({ ...head, state: 'VERIFYING' }, 'change-1')).toEqual(['pos_void']);
    expect(stagedDenyReader({ ...head, state: 'CONVERGED' }, 'change-1')).toEqual(['pos_void']);
  });
});

describe('decideLiveRolePermission — staged deny integration', () => {
  test('a permission present in the matrix is denied while a staged-deny round for it is active', () => {
    const head: StagedRoleDenyHead = {
      roleId: 'staff',
      state: 'VERIFYING',
      changeId: 'change-9',
      deniedPermissions: ['pos_void'],
    };
    expect(decideLiveRolePermission('staff', 'pos_void', granted, head)).toEqual({
      allowed: false,
      reason: 'staged_deny_active',
    });
  });

  test('a staged-deny round for a different role does not affect this role', () => {
    const head: StagedRoleDenyHead = {
      roleId: 'manager',
      state: 'VERIFYING',
      changeId: 'change-9',
      deniedPermissions: ['pos_void'],
    };
    expect(decideLiveRolePermission('staff', 'pos_void', granted, head)).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });

  test('a COMPLETED staged-deny round no longer denies', () => {
    const head: StagedRoleDenyHead = {
      roleId: 'staff',
      state: 'COMPLETED',
      changeId: 'change-9',
      deniedPermissions: ['pos_void'],
    };
    expect(decideLiveRolePermission('staff', 'pos_void', granted, head)).toEqual({
      allowed: true,
      reason: 'granted',
    });
  });
});
