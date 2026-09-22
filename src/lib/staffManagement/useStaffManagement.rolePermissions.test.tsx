// @vitest-environment jsdom

/**
 * Pre-Group-1 role-permission UX remediation — hook contract.
 *
 * Proves the accepted Option-B contract: row-scoped optimistic toggles with
 * per-role in-flight locking and row-scoped rollback, `requiresStaging`
 * propagation with interim-row rendering, and a non-optimistic sequential
 * Reset that excludes `admin` and stays truthful on partial failure.
 *
 * Deterministic by construction: every server response is an explicitly
 * resolved/rejected deferred promise. No timers, no sleeps, no emulator, no
 * Firebase.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneDefaultMatrix, type RolePermissionMatrix } from './types';

type CallableArgs = { roleId: string; permissions: string[] };
type CallableResult = { data: unknown };

const callable = vi.hoisted(() => ({
  calls: [] as CallableArgs[],
  handler: null as null | ((args: CallableArgs) => Promise<CallableResult>),
}));

const seed = vi.hoisted(() => ({
  matrix: null as RolePermissionMatrix | null,
}));

vi.mock('firebase/app', () => ({
  FirebaseError: class FirebaseError extends Error {},
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  connectFunctionsEmulator: () => undefined,
  httpsCallable: () => (args: CallableArgs) => {
    callable.calls.push({ roleId: args.roleId, permissions: [...args.permissions] });
    if (!callable.handler) throw new Error('callable handler fixture missing');
    return callable.handler(args);
  },
}));

vi.mock('firebase/firestore', () => ({
  collection: () => ({}),
  doc: () => ({}),
  getDoc: () =>
    Promise.resolve({
      data: () => (seed.matrix ? { rolePermissions: seed.matrix } : undefined),
    }),
  onSnapshot: () => () => undefined,
  orderBy: () => ({}),
  query: () => ({}),
  serverTimestamp: () => ({}),
  where: () => ({}),
}));

vi.mock('../firebase', () => ({
  app: {},
  db: {},
  collections: { users: 'users', staffActivities: 'staffActivities', settings: 'settings' },
  getEmulatorHost: () => 'localhost',
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
}));

vi.mock('./audit', () => ({
  diffUserFields: () => ({ changed: [], before: {}, after: {} }),
  writeStaffActivity: () => Promise.resolve(),
  writeUserAuditLog: () => Promise.resolve(),
}));

vi.mock('./devMock', () => ({
  devAddActivity: () => undefined,
  devGenerateUserId: () => 'dev-id',
  devSaveStaffUser: () => Promise.resolve(),
  devSoftDeleteUser: () => undefined,
  devToggleUserActive: () => null,
  getDevRoleMatrix: () => ({ admin: [], manager: [], staff: [] }),
  getDevStaffActivities: () => [],
  getDevAllStaffActivities: () => [],
  getDevStaffUsers: () => [],
  initDevStaffStore: () => Promise.resolve(),
  setDevRoleMatrix: () => undefined,
}));

vi.mock('../auth/setUserAccount', () => ({
  setUserAccount: () => Promise.resolve({ userId: 'u1' }),
}));

vi.mock('bcryptjs', () => ({ default: { hash: () => Promise.resolve('hash') } }));

import { useStaffManagement } from './useStaffManagement';

const ACTOR = { id: 'actor-1', name: 'ผู้ทดสอบ' };
const BRANCH = 'branch-1';

const SEEDED: RolePermissionMatrix = {
  admin: ['pos_sale', 'settings'],
  manager: ['pos_sale', 'report_sales'],
  staff: ['pos_sale', 'product_view'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Keep the rejection from being flagged as unhandled before a test attaches.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const ok = (requiresStaging: boolean): CallableResult => ({
  data: requiresStaging
    ? { ok: true, requiresStaging: true, changeId: 'change-1' }
    : { ok: true, requiresStaging: false },
});

/** Must match `ROLE_PERMISSION_BUSY_MESSAGE` in useStaffManagement.ts. */
const BUSY_MESSAGE = 'กำลังบันทึกสิทธิ์อยู่ กรุณารอให้เสร็จก่อนแล้วลองใหม่';

/**
 * Seed whose manager row both LACKS default permissions (so Reset adds) and
 * carries one non-default permission (so Reset removes) — the only way to get a
 * genuine mixed add/remove delta, since a single toggle can only do one or the
 * other.
 */
const MIXED_SEED: RolePermissionMatrix = {
  admin: ['pos_sale', 'settings'],
  manager: ['pos_sale', 'settings'],
  staff: ['pos_sale', 'product_view'],
};

const DEFAULT_MANAGER_ROW = cloneDefaultMatrix().manager;
const DEFAULT_STAFF_ROW = cloneDefaultMatrix().staff;

async function mountMatrix(matrix: RolePermissionMatrix) {
  seed.matrix = matrix;
  const view = renderHook(() => useStaffManagement(BRANCH, ACTOR));
  // The admin row of every seed here is deliberately unlike the default one, so
  // this cannot false-ready on the initial `cloneDefaultMatrix()` state.
  await waitFor(() => expect(view.result.current.roleMatrix.admin).toEqual(matrix.admin));
  return view;
}

async function mountSeeded() {
  const view = renderHook(() => useStaffManagement(BRANCH, ACTOR));
  // Wait on the admin row: it is deliberately unlike `cloneDefaultMatrix()`, so
  // it only matches once the seeded server fetch has actually been applied.
  // (The seeded staff row coincides with the default one, so it cannot be used
  // as the readiness signal.)
  await waitFor(() => expect(view.result.current.roleMatrix.admin).toEqual(SEEDED.admin));
  return view;
}

beforeEach(() => {
  callable.calls = [];
  callable.handler = null;
  seed.matrix = SEEDED;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useStaffManagement role-permission mutations', () => {
  it('T1 — non-staged toggle success keeps the requested row and clears the pending lock', async () => {
    const gate = deferred<CallableResult>();
    callable.handler = () => gate.promise;

    const { result } = await mountSeeded();

    let pending!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      pending = result.current.updateRoleMatrix('staff', 'product_view', false);
    });

    // Optimistic row applies immediately.
    expect(result.current.roleMatrix.staff).toEqual(['pos_sale']);
    await waitFor(() => expect(result.current.pendingRoles.has('staff')).toBe(true));

    let outcome!: { requiresStaging: boolean };
    await act(async () => {
      gate.resolve(ok(false));
      outcome = await pending;
    });

    expect(outcome).toEqual({ requiresStaging: false });
    expect(result.current.roleMatrix.staff).toEqual(['pos_sale']);
    expect(result.current.pendingRoles.has('staff')).toBe(false);
    expect(callable.calls).toHaveLength(1);
    expect(callable.calls[0]).toEqual({ roleId: 'staff', permissions: ['pos_sale'] });
  });

  it('T2 — toggle rejection rolls the row back, rethrows, and clears the pending lock', async () => {
    const gate = deferred<CallableResult>();
    callable.handler = () => gate.promise;

    const { result } = await mountSeeded();

    let pending!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      pending = result.current.updateRoleMatrix('staff', 'product_view', false);
    });

    expect(result.current.roleMatrix.staff).toEqual(['pos_sale']);

    await act(async () => {
      gate.reject(new Error('ไม่มีสิทธิ์แก้ไขสิทธิ์การใช้งาน'));
      await expect(pending).rejects.toThrow('ไม่มีสิทธิ์แก้ไขสิทธิ์การใช้งาน');
    });

    expect(result.current.roleMatrix.staff).toEqual(SEEDED.staff);
    expect(result.current.pendingRoles.has('staff')).toBe(false);
  });

  it('T3 — staged removal renders the authoritative interim row, not the requested target', async () => {
    const gate = deferred<CallableResult>();
    callable.handler = () => gate.promise;

    const { result } = await mountSeeded();

    let pending!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      pending = result.current.updateRoleMatrix('staff', 'product_view', false);
    });

    expect(result.current.roleMatrix.staff).toEqual(['pos_sale']);

    let outcome!: { requiresStaging: boolean };
    await act(async () => {
      gate.resolve(ok(true));
      outcome = await pending;
    });

    expect(outcome).toEqual({ requiresStaging: true });
    // Pure removal: interim === prior row, so the permission comes back ON.
    expect([...result.current.roleMatrix.staff].sort()).toEqual([...SEEDED.staff].sort());
    expect(result.current.roleMatrix.staff).toContain('product_view');
  });

  it('T3b — staged mixed add/remove keeps the removal present and applies the addition', async () => {
    const gate = deferred<CallableResult>();
    callable.handler = () => gate.promise;

    const { result } = await mountSeeded();

    let pending!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      pending = result.current.updateRoleMatrix('staff', 'quotation', true);
    });

    await act(async () => {
      gate.resolve(ok(true));
      await pending;
    });

    // Addition lands; nothing was removed here, so prior keys all survive.
    expect([...result.current.roleMatrix.staff].sort()).toEqual(
      ['pos_sale', 'product_view', 'quotation'].sort(),
    );
  });

  it('T4 — a second mutation for the same role is refused while one is in flight', async () => {
    const gate = deferred<CallableResult>();
    callable.handler = () => gate.promise;

    const { result } = await mountSeeded();

    let first!: Promise<{ requiresStaging: boolean }>;
    let second!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      first = result.current.updateRoleMatrix('staff', 'product_view', false);
      second = result.current.updateRoleMatrix('staff', 'pos_sale', false);
    });

    // H4 — the refusal must REJECT, never resolve a success-shaped outcome.
    await expect(second).rejects.toThrow(BUSY_MESSAGE);

    // No second request, and no second local mutation.
    expect(callable.calls).toHaveLength(1);
    expect(result.current.roleMatrix.staff).toEqual(['pos_sale']);

    await act(async () => {
      gate.resolve(ok(false));
      await first;
    });

    expect(result.current.roleMatrix.staff).toEqual(['pos_sale']);
  });

  it('T5 — a failing role rollback does not undo a concurrent success on another role', async () => {
    const staffGate = deferred<CallableResult>();
    const managerGate = deferred<CallableResult>();
    callable.handler = (args) => (args.roleId === 'staff' ? staffGate.promise : managerGate.promise);

    const { result } = await mountSeeded();

    let staffCall!: Promise<{ requiresStaging: boolean }>;
    let managerCall!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      staffCall = result.current.updateRoleMatrix('staff', 'product_view', false);
      managerCall = result.current.updateRoleMatrix('manager', 'report_sales', false);
    });

    // Different roles may overlap.
    expect(callable.calls).toHaveLength(2);

    await act(async () => {
      managerGate.resolve(ok(false));
      await managerCall;
    });

    await act(async () => {
      staffGate.reject(new Error('เกิดข้อผิดพลาด'));
      await expect(staffCall).rejects.toThrow('เกิดข้อผิดพลาด');
    });

    // staff rolled back; manager success preserved.
    expect(result.current.roleMatrix.staff).toEqual(SEEDED.staff);
    expect(result.current.roleMatrix.manager).toEqual(['pos_sale']);
  });

  it('T6 — Reset does not optimistically jump the matrix to defaults before the server responds', async () => {
    const { result } = await mountSeeded();

    // Snapshot is taken *inside* the callable, i.e. at the exact moment the
    // first role request is issued and before any row can have been committed.
    // That makes the assertion independent of React flush timing.
    const gate = deferred<CallableResult>();
    const snapshots: RolePermissionMatrix[] = [];
    callable.handler = () => {
      const current = result.current.roleMatrix;
      snapshots.push({
        admin: [...current.admin],
        manager: [...current.manager],
        staff: [...current.staff],
      });
      return gate.promise;
    };

    let pending!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      pending = result.current.resetRoleMatrix();
    });

    // Sequential: only the first role has been requested so far.
    expect(callable.calls).toHaveLength(1);
    expect(callable.calls[0]!.roleId).toBe('manager');

    // And nothing had been written to the matrix at that point.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual(SEEDED);

    await act(async () => {
      gate.resolve(ok(false));
      await pending.catch(() => undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Codex-022 corrective coverage (B1 / B2 / B3)
  // ---------------------------------------------------------------------------

  it('H1 — Reset is refused while a role toggle is still in flight', async () => {
    const toggleGate = deferred<CallableResult>();
    callable.handler = () => toggleGate.promise;

    const { result } = await mountSeeded();

    let toggle!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      toggle = result.current.updateRoleMatrix('staff', 'product_view', false);
    });
    expect(callable.calls).toHaveLength(1);

    // Reset must refuse at the hook boundary, not merely be disabled in the UI.
    await act(async () => {
      await expect(result.current.resetRoleMatrix()).rejects.toThrow(BUSY_MESSAGE);
    });

    // Reset issued no role mutation of its own.
    expect(callable.calls).toHaveLength(1);
    expect(callable.calls[0]!.roleId).toBe('staff');

    // The in-flight toggle still completes normally and state matches the server.
    await act(async () => {
      toggleGate.resolve(ok(false));
      await toggle;
    });
    expect(result.current.roleMatrix.staff).toEqual(['pos_sale']);
    expect(result.current.roleMatrix.manager).toEqual(SEEDED.manager);
    expect(result.current.pendingRoles.size).toBe(0);
  });

  it('H2 — a role toggle is refused while Reset is active, with no optimistic mutation', async () => {
    const managerGate = deferred<CallableResult>();
    callable.handler = (args) =>
      args.roleId === 'manager' ? managerGate.promise : Promise.resolve(ok(false));

    const { result } = await mountSeeded();

    let reset!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      reset = result.current.resetRoleMatrix();
    });
    expect(callable.calls).toHaveLength(1);
    expect(callable.calls[0]!.roleId).toBe('manager');

    const staffRowBefore = [...result.current.roleMatrix.staff];

    await act(async () => {
      await expect(result.current.updateRoleMatrix('staff', 'product_view', false)).rejects.toThrow(
        BUSY_MESSAGE,
      );
    });

    // No toggle-specific request, and no optimistic row change.
    expect(callable.calls).toHaveLength(1);
    expect(result.current.roleMatrix.staff).toEqual(staffRowBefore);

    // Reset then proceeds to completion.
    await act(async () => {
      managerGate.resolve(ok(false));
      await reset;
    });
    expect(callable.calls.map((c) => c.roleId)).toEqual(['manager', 'staff']);
    expect(result.current.roleMatrix.manager).toEqual(DEFAULT_MANAGER_ROW);
  });

  it('H2b — a second Reset is refused while the first Reset is active', async () => {
    const gate = deferred<CallableResult>();
    callable.handler = () => gate.promise;

    const { result } = await mountSeeded();

    let first!: Promise<{ requiresStaging: boolean }>;
    act(() => {
      first = result.current.resetRoleMatrix();
    });

    await act(async () => {
      await expect(result.current.resetRoleMatrix()).rejects.toThrow(BUSY_MESSAGE);
    });
    expect(callable.calls).toHaveLength(1);

    await act(async () => {
      gate.resolve(ok(false));
      await first;
    });
  });

  it('H3 — missing actor rejects and issues no request, for both mutations', async () => {
    callable.handler = () => Promise.resolve(ok(false));

    const { result } = renderHook(() => useStaffManagement(BRANCH, null));

    await act(async () => {
      await expect(result.current.resetRoleMatrix()).rejects.toThrow('ไม่พบผู้ใช้งาน');
      await expect(result.current.updateRoleMatrix('staff', 'product_view', false)).rejects.toThrow(
        'ไม่พบผู้ใช้งาน',
      );
    });

    expect(callable.calls).toHaveLength(0);
  });

  it('H3b — missing branch rejects and issues no request, for both mutations', async () => {
    callable.handler = () => Promise.resolve(ok(false));

    const { result } = renderHook(() => useStaffManagement(null, ACTOR));

    await act(async () => {
      await expect(result.current.resetRoleMatrix()).rejects.toThrow('ไม่พบสาขา');
      await expect(result.current.updateRoleMatrix('staff', 'product_view', false)).rejects.toThrow(
        'ไม่พบสาขา',
      );
    });

    expect(callable.calls).toHaveLength(0);
  });

  it('H5 — staged Reset with a real mixed add/remove delta renders prior union additions', async () => {
    callable.handler = (args) => Promise.resolve(ok(args.roleId === 'manager'));

    const { result } = await mountMatrix(MIXED_SEED);

    // Sanity: the manager delta genuinely both adds and removes.
    const priorManager = MIXED_SEED.manager;
    const additions = DEFAULT_MANAGER_ROW.filter((k) => !priorManager.includes(k));
    const removals = priorManager.filter((k) => !DEFAULT_MANAGER_ROW.includes(k));
    expect(additions.length).toBeGreaterThan(0);
    expect(removals).toEqual(['settings']);

    await act(async () => {
      await result.current.resetRoleMatrix();
    });

    // Interim row = prior union additions — NOT the requested target row.
    const expectedInterim = [...new Set([...priorManager, ...additions])].sort();
    expect([...result.current.roleMatrix.manager].sort()).toEqual(expectedInterim);
    expect([...result.current.roleMatrix.manager].sort()).not.toEqual(
      [...DEFAULT_MANAGER_ROW].sort(),
    );
  });

  it('H6 — Reset stops after the first failure and never calls the later role', async () => {
    callable.handler = (args) =>
      args.roleId === 'manager'
        ? Promise.reject(new Error('ไม่มีสิทธิ์แก้ไขสิทธิ์การใช้งาน'))
        : Promise.resolve(ok(false));

    const { result } = await mountSeeded();

    await act(async () => {
      await expect(result.current.resetRoleMatrix()).rejects.toThrow(
        'ไม่มีสิทธิ์แก้ไขสิทธิ์การใช้งาน',
      );
    });

    // manager was attempted and failed; staff must never have been requested.
    expect(callable.calls.map((c) => c.roleId)).toEqual(['manager']);
    expect(callable.calls.some((c) => c.roleId === 'staff')).toBe(false);

    // Nothing was committed.
    expect(result.current.roleMatrix.manager).toEqual(SEEDED.manager);
    expect(result.current.roleMatrix.staff).toEqual(SEEDED.staff);
  });

  it('H7 — staged Reset keeps the removed permission active, adds the missing default, and aggregates', async () => {
    callable.handler = (args) => Promise.resolve(ok(args.roleId === 'manager'));

    const { result } = await mountMatrix(MIXED_SEED);

    let outcome!: { requiresStaging: boolean };
    await act(async () => {
      outcome = await result.current.resetRoleMatrix();
    });

    expect(outcome).toEqual({ requiresStaging: true });

    // Removal is staged, so it must still render as active.
    expect(result.current.roleMatrix.manager).toContain('settings');
    // A default permission the seed lacked is now present.
    expect(result.current.roleMatrix.manager).toContain('report_stock');
    // staff was non-staged, so it converged to the target row.
    expect([...result.current.roleMatrix.staff].sort()).toEqual([...DEFAULT_STAFF_ROW].sort());
  });

  it('T7 — Reset partial failure keeps accepted rows and leaves later rows untouched', async () => {
    callable.handler = (args) =>
      args.roleId === 'manager'
        ? Promise.resolve(ok(false))
        : Promise.reject(new Error('ข้อมูลสิทธิ์ที่ส่งไม่ถูกต้อง'));

    const { result } = await mountSeeded();

    await act(async () => {
      await expect(result.current.resetRoleMatrix()).rejects.toThrow('ข้อมูลสิทธิ์ที่ส่งไม่ถูกต้อง');
    });

    // manager accepted → updated to defaults; staff failed → untouched; admin never sent.
    expect(result.current.roleMatrix.manager).toContain('report_stock');
    expect(result.current.roleMatrix.staff).toEqual(SEEDED.staff);
    expect(result.current.roleMatrix.admin).toEqual(SEEDED.admin);
  });

  it('T8 — Reset never issues a mutation for the admin role', async () => {
    callable.handler = () => Promise.resolve(ok(false));

    const { result } = await mountSeeded();

    await act(async () => {
      await result.current.resetRoleMatrix();
    });

    expect(callable.calls.map((c) => c.roleId).sort()).toEqual(['manager', 'staff']);
    expect(callable.calls.some((c) => c.roleId === 'admin')).toBe(false);
    // admin row left exactly as the server had it.
    expect(result.current.roleMatrix.admin).toEqual(SEEDED.admin);
  });

  it('T9 — Reset aggregates requiresStaging and renders target/interim per role', async () => {
    callable.handler = (args) => Promise.resolve(ok(args.roleId === 'staff'));

    const { result } = await mountSeeded();

    let outcome!: { requiresStaging: boolean };
    await act(async () => {
      outcome = await result.current.resetRoleMatrix();
    });

    expect(outcome).toEqual({ requiresStaging: true });
    // manager: non-staged → full default target row.
    expect(result.current.roleMatrix.manager).toContain('report_stock');
    // staff: staged → interim row keeps everything it had before.
    for (const key of SEEDED.staff) {
      expect(result.current.roleMatrix.staff).toContain(key);
    }
  });
});
