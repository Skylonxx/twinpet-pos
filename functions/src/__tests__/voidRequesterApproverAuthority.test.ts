import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  liveRoleHoldsPosVoid,
  liveRoleHoldsVoidRequesterPermission,
  resolveLivePosVoid,
  resolveLiveVoidRequesterPermission,
  type RolePermissionsDocSnapshot,
} from '../privilegedActionAuthority';
import {
  ACTION_REQUIREMENTS,
  PRIVILEGED_ACTION_IDS,
  PRIVILEGED_APPROVER_PERMISSION,
  PRIVILEGED_REQUESTER_PERMISSION,
} from '../privilegedActionRegistry';

/**
 * D-VOID-REQ-1 / D-VOID-REQ-2 invariants.
 *
 *   Void requester permission = pos_sale
 *   Void approver  permission = pos_void
 *
 * Any normal POS operator may initiate a same-day whole-bill Void; a distinct
 * Manager/Admin holding live pos_void approves it. The live matrix stays
 * fail-closed: an absent/malformed matrix denies every role, requester and
 * approver alike, and there is NO default fallback in the privileged gates.
 */

const srcDir = resolve(__dirname, '..');
const read = (name: string) => readFileSync(resolve(srcDir, name), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DEFAULT_MATRIX: RolePermissionsDocSnapshot = {
  exists: true,
  data: {
    rolePermissions: {
      admin: ['pos_sale', 'pos_discount', 'pos_void', 'product_view'],
      manager: ['pos_sale', 'pos_discount', 'pos_void', 'product_view'],
      staff: ['pos_sale', 'product_view'],
    },
  },
};
const ABSENT: RolePermissionsDocSnapshot = { exists: false, data: undefined };
const noStagedDeny = async () => null;
const db = {} as never;

const requester = (snap: RolePermissionsDocSnapshot, role: string | null) =>
  liveRoleHoldsVoidRequesterPermission(db, role, async () => snap, noStagedDeny);
const approver = (snap: RolePermissionsDocSnapshot, role: string | null) =>
  liveRoleHoldsPosVoid(db, role, async () => snap, noStagedDeny);

describe('Void requester = pos_sale, approver = pos_void', () => {
  test('registry constants and per-action requirements', () => {
    expect(PRIVILEGED_REQUESTER_PERMISSION).toBe('pos_sale');
    expect(PRIVILEGED_APPROVER_PERMISSION).toBe('pos_void');
    for (const id of PRIVILEGED_ACTION_IDS) {
      expect(ACTION_REQUIREMENTS[id].requesterPermission).toBe('pos_sale');
      expect(ACTION_REQUIREMENTS[id].approverPermission).toBe('pos_void');
      expect([...ACTION_REQUIREMENTS[id].approverRoles]).toEqual(['manager', 'admin']);
    }
  });

  test('with the default matrix every normal operator role may request, only Manager/Admin may approve', async () => {
    for (const role of ['staff', 'manager', 'admin']) {
      expect(await requester(DEFAULT_MATRIX, role), `requester ${role}`).toBe(true);
    }
    expect(await approver(DEFAULT_MATRIX, 'manager')).toBe(true);
    expect(await approver(DEFAULT_MATRIX, 'admin')).toBe(true);
    expect(await approver(DEFAULT_MATRIX, 'staff')).toBe(false);
  });

  test('Staff never gains pos_void: default rows are unchanged in the login mirror and the seed script', () => {
    const indexSrc = read('index.ts');
    const block = indexSrc.slice(
      indexSrc.indexOf('const DEFAULT_ROLE_PERMS'),
      indexSrc.indexOf('async function resolvePermissionKeys'),
    );
    const staffRow = /staff:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? '';
    expect(staffRow.replace(/\s+/g, '')).toBe("'pos_sale','product_view'");
    expect(/manager:\s*\[([^\]]*)\]/.exec(block)?.[1]).toContain("'pos_void'");
    expect(/admin:\s*\[([^\]]*)\]/.exec(block)?.[1]).toContain("'pos_void'");
    const seed = read('scripts/seed-admin.ts');
    const seedMatrix = seed.slice(seed.indexOf('DEFAULT_ROLE_PERMISSIONS_MATRIX'));
    const seedStaff = /staff:\s*\[([^\]]*)\]/.exec(seedMatrix)?.[1] ?? '';
    expect(seedStaff.replace(/\s+/g, '')).toBe("'pos_sale','product_view'");
  });

  test('a role holding pos_void but not pos_sale cannot request; a role holding pos_sale but not pos_void cannot approve', async () => {
    const snap: RolePermissionsDocSnapshot = {
      exists: true,
      data: { rolePermissions: { admin: ['pos_void'], manager: ['pos_sale'], staff: ['pos_sale'] } },
    };
    expect(await requester(snap, 'admin')).toBe(false);
    expect(await approver(snap, 'admin')).toBe(true);
    expect(await requester(snap, 'manager')).toBe(true);
    expect(await approver(snap, 'manager')).toBe(false);
  });
});

describe('D-VOID-REQ-2 — the privileged matrix stays fail-closed (no fallback)', () => {
  test.each(['staff', 'manager', 'admin'])('an absent matrix denies %s as requester and as approver', async (role) => {
    expect(await requester(ABSENT, role)).toBe(false);
    expect(await approver(ABSENT, role)).toBe(false);
    expect(await resolveLiveVoidRequesterPermission(db, role, async () => ABSENT, noStagedDeny)).toEqual({
      allowed: false,
      reason: 'document_absent',
    });
    expect(await resolveLivePosVoid(db, role, async () => ABSENT, noStagedDeny)).toEqual({
      allowed: false,
      reason: 'document_absent',
    });
  });

  test('malformed matrix, malformed row, empty row and unreadable source all deny', async () => {
    const cases: RolePermissionsDocSnapshot[] = [
      { exists: true, data: { rolePermissions: 'nope' } },
      { exists: true, data: { rolePermissions: { staff: 'pos_sale', manager: ['pos_sale', 'pos_void'] } } },
      { exists: true, data: { rolePermissions: { staff: [], manager: [] } } },
      { exists: true, data: { rolePermissions: { staff: [42] } } },
    ];
    for (const snap of cases) {
      expect(await requester(snap, 'staff')).toBe(false);
      expect(await approver(snap, 'staff')).toBe(false);
    }
    const unreadable = async (): Promise<RolePermissionsDocSnapshot> => {
      throw new Error('unreadable');
    };
    expect(await liveRoleHoldsVoidRequesterPermission(db, 'staff', unreadable, noStagedDeny)).toBe(false);
    expect(await liveRoleHoldsPosVoid(db, 'manager', unreadable, noStagedDeny)).toBe(false);
  });

  test('a staged-deny withdraws only the permission it names', async () => {
    const denyVoid = async () => ({
      roleId: 'manager',
      state: 'DRAINING' as const,
      changeId: 'change-1',
      deniedPermissions: ['pos_void'],
    });
    expect(await liveRoleHoldsVoidRequesterPermission(db, 'manager', async () => DEFAULT_MATRIX, denyVoid)).toBe(true);
    expect(await liveRoleHoldsPosVoid(db, 'manager', async () => DEFAULT_MATRIX, denyVoid)).toBe(false);
    const denySale = async () => ({
      roleId: 'staff',
      state: 'DRAINING' as const,
      changeId: 'change-2',
      deniedPermissions: ['pos_sale'],
    });
    expect(await liveRoleHoldsVoidRequesterPermission(db, 'staff', async () => DEFAULT_MATRIX, denySale)).toBe(false);
  });

  test('privileged gates add no default-permission fallback', () => {
    for (const file of [
      'privilegedActionAuthority.ts',
      'requestManagerApproval.ts',
      'submitPrivilegedVoid.ts',
      'adjudicateOfflinePrivilegedActionCore.ts',
    ]) {
      const code = stripComments(read(file));
      expect(code, file).not.toMatch(/DEFAULT_ROLE_PERMS|DEFAULT_ROLE_PERMISSIONS/);
    }
  });
});

describe('source wiring: each actor uses its own permission helper', () => {
  const count = (code: string, needle: string) => code.split(needle).length - 1;

  test('requestManagerApproval: requester = pos_sale helper (1), named approver = pos_void helper (1)', () => {
    const code = stripComments(read('requestManagerApproval.ts'));
    expect(count(code, 'await liveRoleHoldsVoidRequesterPermission(')).toBe(1);
    expect(count(code, 'await liveRoleHoldsPosVoid(')).toBe(1);
    expect(code).not.toMatch(/'pos_void'|'pos_sale'/);
  });

  test('submitPrivilegedVoid: requester = pos_sale helper (1), approver = pos_void helper (1)', () => {
    const code = stripComments(read('submitPrivilegedVoid.ts'));
    expect(count(code, 'await liveRoleHoldsVoidRequesterPermission(')).toBe(1);
    expect(count(code, 'await liveRoleHoldsPosVoid(')).toBe(1);
    expect(code).not.toMatch(/'pos_void'|'pos_sale'/);
  });

  test('adjudication core: relay caller + initiator = pos_sale (2 live, 1 linearized); manager = pos_void (1 live, 1 linearized)', () => {
    const code = stripComments(read('adjudicateOfflinePrivilegedActionCore.ts'));
    expect(count(code, 'await liveRoleHoldsVoidRequesterPermission(')).toBe(2);
    expect(count(code, 'await liveRoleHoldsPosVoid(')).toBe(1);
    expect(count(code, '!linearizedRoleHoldsVoidRequesterPermission(')).toBe(1);
    expect(count(code, '!linearizedRoleHoldsPosVoid(')).toBe(1);
    expect(code).not.toMatch(/'pos_void'|'pos_sale'/);
  });

  test('the approver helper reads PRIVILEGED_APPROVER_PERMISSION and the requester helper PRIVILEGED_REQUESTER_PERMISSION', () => {
    const code = stripComments(read('privilegedActionAuthority.ts'));
    expect(code).toMatch(/resolveLivePosVoid[\s\S]*?PRIVILEGED_APPROVER_PERMISSION/);
    expect(code).toMatch(/resolveLiveVoidRequesterPermission[\s\S]*?PRIVILEGED_REQUESTER_PERMISSION/);
  });
});
