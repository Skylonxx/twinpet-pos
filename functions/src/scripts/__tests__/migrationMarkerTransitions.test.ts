import { describe, expect, test } from 'vitest';
import {
  runSetUsernameMigrationMaintenanceMode,
} from '../setUsernameMigrationMaintenanceMode';
import {
  runVerifyUsernameReservationCompleteness,
} from '../verifyUsernameReservationCompleteness';
import { reservationsSelfGateAllows } from '../migrateUsernameReservations';

type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  function docRef(path: string) {
    return {
      path,
      set: async (data: Doc, opts?: { merge?: boolean }) => {
        store.set(path, opts?.merge ? { ...(store.get(path) ?? {}), ...data } : { ...data });
      },
      get: async () => {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
    };
  }
  function col(path: string) {
    return {
      doc: (id: string) => docRef(`${path}/${id}`),
      get: async () => {
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
          .map(([p, data]) => ({ id: p.slice(p.lastIndexOf('/') + 1), data: () => data }));
        return { docs, size: docs.length };
      },
    };
  }
  return { collection: (c: string) => col(c), __store: store };
}

describe('migration marker transitions', () => {
  test('maintenanceMode false is hard-rejected before any write', async () => {
    const db = makeDb({ 'migrationControl/usernameReservations': { maintenanceMode: true, complete: true, epoch: 1 } });
    await expect(runSetUsernameMigrationMaintenanceMode(db as never, false)).rejects.toThrow('MAINTENANCE_FALSE_REJECTED');
    expect(db.__store.get('migrationControl/usernameReservations')).toMatchObject({ maintenanceMode: true });
  });

  test('false→true is allowed; true is a no-op', async () => {
    const db = makeDb({ 'migrationControl/usernameReservations': { maintenanceMode: false, complete: true, epoch: 1 } });
    const first = await runSetUsernameMigrationMaintenanceMode(db as never, true);
    expect(first.noop).toBe(false);
    const second = await runSetUsernameMigrationMaintenanceMode(db as never, true);
    expect(second.noop).toBe(true);
  });

  test('self-gate: incomplete OR (complete && maintenance && epoch+1)', async () => {
    const db = makeDb({ 'migrationControl/usernameReservations': { complete: false, maintenanceMode: false, epoch: 0 } });
    expect((await reservationsSelfGateAllows(db as never, 1)).allowed).toBe(true);
    const db2 = makeDb({ 'migrationControl/usernameReservations': { complete: true, maintenanceMode: true, epoch: 1 } });
    expect((await reservationsSelfGateAllows(db2 as never, 2)).allowed).toBe(true);
    expect((await reservationsSelfGateAllows(db2 as never, 1)).allowed).toBe(false);
  });

  test('failed completeness leaves maintenance true and epoch unchanged', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: true, epoch: 1 },
      'users/a': { username: 'a', deletedAt: null },
    });
    const res = await runVerifyUsernameReservationCompleteness(db as never, 2);
    expect(res.ok).toBe(false);
    expect(db.__store.get('migrationControl/usernameReservations')).toMatchObject({
      maintenanceMode: true,
      epoch: 1,
    });
  });

  test('successful re-migration increments epoch by 1 and writes maintenanceMode false', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: true, epoch: 1 },
      'users/a': { username: 'ann', deletedAt: null },
      'usernames/ann': { userId: 'a' },
    });
    const res = await runVerifyUsernameReservationCompleteness(db as never, 2);
    expect(res.ok).toBe(true);
    expect(res.epoch).toBe(2);
    expect(res.maintenanceMode).toBe(false);
  });
});
