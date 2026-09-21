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
      __collection: collectionName,
      __id: id,
      get: async () => ({ exists: coll(collectionName).has(id), data: () => coll(collectionName).get(id) }),
      set: (data: unknown, opts?: { merge?: boolean }) => applySet(collectionName, id, data, opts?.merge === true),
    };
  }
  // Transaction semantics good enough to express the F1 races: writes are
  // BUFFERED until commit, every `tx.get` joins the read set, and a changed
  // read-set document discards the attempt and re-runs the callback (the
  // optimistic-concurrency retry real Firestore performs). `setBeforeCommit`
  // installs a ONE-SHOT hook fired after the callback body and before the
  // conflict check — the injection point for a competing writer.
  const versions = new Map<string, number>();
  let beforeCommit: (() => Promise<void> | void) | null = null;
  const key = (c: string, id: string) => `${c}/${id}`;
  const versionOf = (c: string, id: string) => versions.get(key(c, id)) ?? 0;

  function applySet(c: string, id: string, data: unknown, merge?: boolean) {
    if (merge) coll(c).set(id, deepMerge(coll(c).get(id), data));
    else coll(c).set(id, data);
    versions.set(key(c, id), versionOf(c, id) + 1);
  }

  type Ref = { __collection: string; __id: string };

  const db = {
    collection: (name: string) => ({ doc: (id: string) => docHandle(name, id) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const readSet = new Map<string, number>();
        const buffered: Array<() => void> = [];
        const tx = {
          get: async (ref: Ref) => {
            readSet.set(key(ref.__collection, ref.__id), versionOf(ref.__collection, ref.__id));
            return {
              exists: coll(ref.__collection).has(ref.__id),
              data: () => coll(ref.__collection).get(ref.__id),
            };
          },
          set: (ref: Ref, data: unknown, opts?: { merge?: boolean }) => {
            buffered.push(() => applySet(ref.__collection, ref.__id, data, opts?.merge === true));
          },
          update: (ref: Ref, patch: Record<string, unknown>) => {
            buffered.push(() => applySet(ref.__collection, ref.__id, patch, true));
          },
        };

        const result = await fn(tx);

        if (beforeCommit) {
          const hook = beforeCommit;
          beforeCommit = null; // one-shot
          await hook();
        }

        let conflict = false;
        for (const [k, v] of readSet) {
          const [c, i] = k.split('/');
          if (versionOf(c, i) !== v) {
            conflict = true;
            break;
          }
        }
        if (conflict) continue;

        for (const w of buffered) w();
        return result;
      }
      throw new Error('transaction_max_retries_exceeded');
    },
  } as unknown as Firestore;
  return {
    db,
    store,
    setBeforeCommit: (hook: () => Promise<void> | void) => {
      beforeCommit = hook;
    },
  };
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

  // --- F1: fresh-state transaction + REJECT_ACTIVE_ROUND --------------------

  const adminAuth = { uid: ADMIN_UID, token: { role: 'admin' } };
  const matrixOf = (store: Map<string, Map<string, unknown>>) =>
    store.get('settings')!.get('_rolePermissions') as { rolePermissions: Record<string, string[]> };

  it('F1: a pure addition is refused while a DRAINING round is active, and the matrix is untouched', async () => {
    const { db, store } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale', 'pos_void'] } } },
      privilegedStagedRoleDeny: {
        staff: { state: 'DRAINING', changeId: 'C1', deniedPermissions: ['pos_void'], targetRow: ['pos_sale'] },
      },
    });
    const before = JSON.stringify(matrixOf(store));

    // Superset of the interim row => classified as a pure addition pre-fix,
    // which previously bypassed the active-head guard entirely.
    const result = await performSetRolePermissions(
      db,
      adminAuth,
      { roleId: 'staff', permissions: ['pos_sale', 'pos_void', 'pos_discount'] },
      1000,
    );

    expect(result).toEqual({ ok: false, code: 'staging_already_active' });
    expect(JSON.stringify(matrixOf(store))).toBe(before);
    expect(store.get('privilegedRoleSweepJobs')?.size ?? 0).toBe(0);
  });

  it('F1: the decision uses post-sweep state when a round finalizes before the commit', async () => {
    const { db, store, setBeforeCommit } = genericFakeFirestore({
      ...seedAdmin(),
      // The interim row the caller would have read: pos_void still present
      // because the round had not yet finalized.
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale', 'pos_void'] } } },
      privilegedStagedRoleDeny: {
        staff: { state: 'COMPLETED', changeId: 'C1', deniedPermissions: ['pos_void'], targetRow: ['pos_sale'] },
      },
    });

    // The sweep applies targetRow to the matrix while the caller's
    // transaction is in flight. Pre-fix the caller had already read the
    // interim row outside any transaction and wrote it straight back through
    // a bare merge, resurrecting pos_void after the head had cleared.
    setBeforeCommit(() => {
      db.collection('settings')
        .doc('_rolePermissions')
        .set({ rolePermissions: { staff: ['pos_sale'] } }, { merge: false });
    });

    const result = await performSetRolePermissions(
      db,
      adminAuth,
      { roleId: 'staff', permissions: ['pos_sale', 'pos_discount'] },
      2000,
    );

    expect(result).toEqual({ ok: true, requiresStaging: false });
    // pos_void stays removed: the retry re-derived the change from the
    // finalized row, so the stale interim row was never written back.
    expect(matrixOf(store).rolePermissions.staff.sort()).toEqual(['pos_discount', 'pos_sale']);
  });

  it('F1: concurrent additions to the same role preserve both, via conflict retry', async () => {
    const { db, store, setBeforeCommit } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale'] } } },
    });

    // Admin B adds p2 while admin A's transaction is in flight. A must retry
    // against B's committed row rather than clobbering it.
    setBeforeCommit(async () => {
      const b = await performSetRolePermissions(
        db,
        adminAuth,
        { roleId: 'staff', permissions: ['pos_sale', 'p2'] },
        1001,
      );
      expect(b).toEqual({ ok: true, requiresStaging: false });
    });

    const a = await performSetRolePermissions(
      db,
      adminAuth,
      { roleId: 'staff', permissions: ['pos_sale', 'p1', 'p2'] },
      1000,
    );

    expect(a).toEqual({ ok: true, requiresStaging: false });
    // Neither addition was lost — pre-fix the bare merge dropped p2.
    expect(matrixOf(store).rolePermissions.staff.sort()).toEqual(['p1', 'p2', 'pos_sale']);
  });

  it('F1: an addition that would drop a concurrently-added permission is routed through staging', async () => {
    const { db, store, setBeforeCommit } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale'] } } },
    });

    setBeforeCommit(async () => {
      await performSetRolePermissions(db, adminAuth, { roleId: 'staff', permissions: ['pos_sale', 'p2'] }, 1001);
    });

    // A's absolute set omits p2, so once A re-reads fresh state this is a
    // removal and must take the staged-deny path instead of silently
    // dropping p2 the way the pre-fix bare merge did.
    const a = await performSetRolePermissions(db, adminAuth, { roleId: 'staff', permissions: ['pos_sale', 'p1'] }, 1000);

    expect(a.ok).toBe(true);
    if (!a.ok || !a.requiresStaging) throw new Error('expected staging');
    const head = store.get('privilegedStagedRoleDeny')!.get('staff') as {
      state: string;
      deniedPermissions: string[];
      targetRow: string[];
    };
    expect(head.state).toBe('DRAINING');
    expect(head.deniedPermissions).toEqual(['p2']);
    expect(head.targetRow.sort()).toEqual(['p1', 'pos_sale']);
    // Both additions remain live during the drain window.
    expect(matrixOf(store).rolePermissions.staff.sort()).toEqual(['p1', 'p2', 'pos_sale']);
  });

  it('F1: exactly one sweep job is created even when the transaction retries', async () => {
    const { db, store, setBeforeCommit } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale', 'pos_void'] } } },
    });

    // Force one retry by touching the matrix mid-transaction.
    setBeforeCommit(() => {
      db.collection('settings')
        .doc('_rolePermissions')
        .set({ rolePermissions: { staff: ['pos_sale', 'pos_void'] }, touched: true }, { merge: true });
    });

    const result = await performSetRolePermissions(db, adminAuth, { roleId: 'staff', permissions: ['pos_sale'] }, 1000);

    expect(result.ok).toBe(true);
    // jobId is minted before the transaction, so a retry must not orphan a
    // second job document.
    expect(store.get('privilegedRoleSweepJobs')!.size).toBe(1);
  });

  it('F1: a COMPLETED head does not block a pure addition', async () => {
    const { db, store } = genericFakeFirestore({
      ...seedAdmin(),
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale'] } } },
      privilegedStagedRoleDeny: { staff: { state: 'COMPLETED', changeId: 'old', deniedPermissions: [] } },
    });

    const result = await performSetRolePermissions(
      db,
      adminAuth,
      { roleId: 'staff', permissions: ['pos_sale', 'pos_discount'] },
      1000,
    );

    expect(result).toEqual({ ok: true, requiresStaging: false });
    expect(matrixOf(store).rolePermissions.staff.sort()).toEqual(['pos_discount', 'pos_sale']);
  });
});
