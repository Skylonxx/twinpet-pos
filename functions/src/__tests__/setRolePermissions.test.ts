import { describe, expect, it } from 'vitest';
import { performSetRolePermissions } from '../setRolePermissions';
import type { Firestore } from 'firebase-admin/firestore';

function genericFakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Map<string, unknown>>();
  for (const [collection, docs] of Object.entries(seed)) store.set(collection, new Map(Object.entries(docs)));
  function coll(name: string): Map<string, unknown> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }
  function deepMerge(target: unknown, patch: unknown): unknown {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
    const result: Record<string, unknown> = typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      result[k] = deepMerge(result[k], v);
    }
    return result;
  }
  function docHandle(collectionName: string, id: string) {
    return {
      get: async () => ({ exists: coll(collectionName).has(id), data: () => coll(collectionName).get(id) }),
      set: (data: unknown, opts?: { merge?: boolean }) => {
        if (opts?.merge) {
          coll(collectionName).set(id, deepMerge(coll(collectionName).get(id), data));
        } else {
          coll(collectionName).set(id, data);
        }
      },
    };
  }
  const db = {
    collection: (name: string) => ({ doc: (id: string) => docHandle(name, id) }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (d: unknown, o?: unknown) => void }, data: unknown, opts?: unknown) => ref.set(data, opts),
      };
      await fn(tx);
    },
  } as unknown as Firestore;
  return { db, store };
}

const ADMIN_UID = 'admin-1';
function seedAdmin() {
  return { users: { [ADMIN_UID]: { role: 'admin', isActive: true, deletedAt: null } } };
}

describe('performSetRolePermissions', () => {
  it('rejects a non-admin caller', async () => {
    const { db } = genericFakeFirestore({ users: { u1: { role: 'staff', isActive: true, deletedAt: null } } });
    const result = await performSetRolePermissions(db, { uid: 'u1', token: { role: 'staff' } }, { roleId: 'staff', permissions: [] });
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('applies a pure addition immediately without staging', async () => {
    const { db, store } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale'] } } },
    });
    const result = await performSetRolePermissions(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { roleId: 'staff', permissions: ['pos_sale', 'product_view'] },
      1000,
    );
    expect(result).toEqual({ ok: true, requiresStaging: false });
    const matrix = store.get('settings')!.get('_rolePermissions') as { rolePermissions: Record<string, string[]> };
    expect(matrix.rolePermissions.staff.sort()).toEqual(['pos_sale', 'product_view'].sort());
  });

  it('stages a removal: matrix keeps the removed permission, head+job both DRAINING with the same changeId', async () => {
    const { db, store } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale', 'pos_void'] } } },
    });
    const result = await performSetRolePermissions(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { roleId: 'staff', permissions: ['pos_sale'] },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.requiresStaging) throw new Error('expected staging');

    const matrix = store.get('settings')!.get('_rolePermissions') as { rolePermissions: Record<string, string[]> };
    expect(matrix.rolePermissions.staff.sort()).toEqual(['pos_sale', 'pos_void'].sort());

    const head = store.get('privilegedStagedRoleDeny')!.get('staff') as { state: string; changeId: string; deniedPermissions: string[] };
    const job = store.get('privilegedRoleSweepJobs')!.get(
      Array.from((store.get('privilegedRoleSweepJobs') ?? new Map()).keys())[0] as string,
    ) as { state: string; changeId: string };
    expect(head.state).toBe('DRAINING');
    expect(head.deniedPermissions).toEqual(['pos_void']);
    expect(job.state).toBe('DRAINING');
    expect(job.changeId).toBe(head.changeId);
    expect(result.changeId).toBe(head.changeId);
  });

  it('rejects staging a new removal while one is already active for the role', async () => {
    const { db } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale', 'pos_void'] } } },
      privilegedStagedRoleDeny: { staff: { state: 'VERIFYING', changeId: 'existing', deniedPermissions: ['pos_void'] } },
    });
    const result = await performSetRolePermissions(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { roleId: 'staff', permissions: ['pos_sale'] },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'staging_already_active' });
  });

  it('allows staging a new removal once the prior round is COMPLETED', async () => {
    const { db } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale', 'pos_void'] } } },
      privilegedStagedRoleDeny: { staff: { state: 'COMPLETED', changeId: 'old', deniedPermissions: [] } },
    });
    const result = await performSetRolePermissions(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { roleId: 'staff', permissions: ['pos_sale'] },
      1000,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid request shape', async () => {
    const { db } = genericFakeFirestore(seedAdmin());
    const result = await performSetRolePermissions(db, { uid: ADMIN_UID, token: { role: 'admin' } }, { roleId: 'owner', permissions: [] });
    expect(result).toEqual({ ok: false, code: 'invalid_request_shape' });
  });
});
