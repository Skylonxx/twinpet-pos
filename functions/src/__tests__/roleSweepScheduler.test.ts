import { describe, expect, it } from 'vitest';
import { runRoleSweepTick } from '../roleSweepScheduler';
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
    const result: Record<string, unknown> =
      typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) result[k] = deepMerge(result[k], v);
    return result;
  }
  function docHandle(collectionName: string, id: string) {
    return {
      get: async () => ({ exists: coll(collectionName).has(id), data: () => coll(collectionName).get(id) }),
      set: (data: unknown, opts?: { merge?: boolean }) => {
        coll(collectionName).set(id, opts?.merge ? deepMerge(coll(collectionName).get(id), data) : data);
      },
      update: (patch: Record<string, unknown>) => {
        coll(collectionName).set(id, { ...(coll(collectionName).get(id) as Record<string, unknown>), ...patch });
      },
    };
  }
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => docHandle(name, id),
      where: (field: string, op: string, value: unknown[]) => ({
        get: async () => ({
          docs: Array.from(coll(name).entries())
            .filter(([, d]) => op === 'in' && value.includes((d as Record<string, unknown>)[field]))
            .map(([id, d]) => ({ id, data: () => d })),
        }),
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (d: unknown, o?: unknown) => void }, data: unknown, opts?: unknown) => ref.set(data, opts),
        update: (ref: { update: (p: unknown) => void }, patch: unknown) => ref.update(patch),
      };
      await fn(tx);
    },
  } as unknown as Firestore;
  return { db, store };
}

describe('runRoleSweepTick', () => {
  it('advances a DRAINING job/head pair to VERIFYING', async () => {
    const { db, store } = genericFakeFirestore({
      privilegedRoleSweepJobs: {
        'job-1': { jobId: 'job-1', roleId: 'staff', changeId: 'change-1', state: 'DRAINING', targetRow: ['pos_sale'] },
      },
      privilegedStagedRoleDeny: { staff: { roleId: 'staff', changeId: 'change-1', state: 'DRAINING', deniedPermissions: ['pos_void'] } },
    });
    const result = await runRoleSweepTick(db, 1000);
    expect(result).toEqual({ jobsExamined: 1, advanced: 1, finalized: 0, skipped: 0 });
    expect((store.get('privilegedRoleSweepJobs')!.get('job-1') as { state: string }).state).toBe('VERIFYING');
    expect((store.get('privilegedStagedRoleDeny')!.get('staff') as { state: string }).state).toBe('VERIFYING');
  });

  it('advances VERIFYING to CONVERGED', async () => {
    const { db, store } = genericFakeFirestore({
      privilegedRoleSweepJobs: {
        'job-1': { jobId: 'job-1', roleId: 'staff', changeId: 'change-1', state: 'VERIFYING', targetRow: ['pos_sale'] },
      },
      privilegedStagedRoleDeny: { staff: { roleId: 'staff', changeId: 'change-1', state: 'VERIFYING', deniedPermissions: ['pos_void'] } },
    });
    await runRoleSweepTick(db, 1000);
    expect((store.get('privilegedRoleSweepJobs')!.get('job-1') as { state: string }).state).toBe('CONVERGED');
    expect((store.get('privilegedStagedRoleDeny')!.get('staff') as { state: string }).state).toBe('CONVERGED');
  });

  it('finalizes a CONVERGED job: both become COMPLETED and the matrix row is applied', async () => {
    const { db, store } = genericFakeFirestore({
      privilegedRoleSweepJobs: {
        'job-1': { jobId: 'job-1', roleId: 'staff', changeId: 'change-1', state: 'CONVERGED', targetRow: ['pos_sale'] },
      },
      privilegedStagedRoleDeny: { staff: { roleId: 'staff', changeId: 'change-1', state: 'CONVERGED', deniedPermissions: ['pos_void'] } },
      settings: { _rolePermissions: { rolePermissions: { staff: ['pos_sale', 'pos_void'], manager: ['pos_void'] } } },
    });
    const result = await runRoleSweepTick(db, 1000);
    expect(result).toEqual({ jobsExamined: 1, advanced: 0, finalized: 1, skipped: 0 });
    expect((store.get('privilegedRoleSweepJobs')!.get('job-1') as { state: string }).state).toBe('COMPLETED');
    expect((store.get('privilegedStagedRoleDeny')!.get('staff') as { state: string }).state).toBe('COMPLETED');
    const matrix = store.get('settings')!.get('_rolePermissions') as { rolePermissions: Record<string, string[]> };
    expect(matrix.rolePermissions.staff).toEqual(['pos_sale']);
    // Other roles' rows are untouched by the finalize of a different role.
    expect(matrix.rolePermissions.manager).toEqual(['pos_void']);
  });

  it('does not examine already-COMPLETED jobs', async () => {
    const { db } = genericFakeFirestore({
      privilegedRoleSweepJobs: {
        'job-1': { jobId: 'job-1', roleId: 'staff', changeId: 'change-1', state: 'COMPLETED', targetRow: ['pos_sale'] },
      },
    });
    const result = await runRoleSweepTick(db, 1000);
    expect(result).toEqual({ jobsExamined: 0, advanced: 0, finalized: 0, skipped: 0 });
  });

  it('skips a job whose head changeId no longer matches (fails safe, does not advance)', async () => {
    const { db, store } = genericFakeFirestore({
      privilegedRoleSweepJobs: {
        'job-1': { jobId: 'job-1', roleId: 'staff', changeId: 'change-1', state: 'DRAINING', targetRow: ['pos_sale'] },
      },
      privilegedStagedRoleDeny: { staff: { roleId: 'staff', changeId: 'change-2', state: 'DRAINING', deniedPermissions: [] } },
    });
    const result = await runRoleSweepTick(db, 1000);
    expect(result).toEqual({ jobsExamined: 1, advanced: 0, finalized: 0, skipped: 1 });
    expect((store.get('privilegedRoleSweepJobs')!.get('job-1') as { state: string }).state).toBe('DRAINING');
  });
});
