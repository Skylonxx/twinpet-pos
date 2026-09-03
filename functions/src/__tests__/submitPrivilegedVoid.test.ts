import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../db', () => ({ db: { __unused: true } }));
vi.mock('../deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
  Timestamp: class Timestamp {
    private readonly ms: number;
    private constructor(ms: number) {
      this.ms = ms;
    }
    static fromMillis(ms: number) {
      return new Timestamp(ms);
    }
    toMillis() {
      return this.ms;
    }
  },
}));

import { performSubmitPrivilegedVoid, type CanonicalVoidExecutor } from '../submitPrivilegedVoid';
import { deriveApprovalId } from '../requestManagerApprovalCore';
import {
  buildPrivilegedExecutionBinding,
  derivePrivilegedNonceKey,
  derivePrivilegedVoidExecutionId,
} from '../submitPrivilegedVoidCore';
import type { SubmitPrivilegedVoidRequest } from '../submitPrivilegedVoidCore';
import type { VoidIntentTxnOutcome } from '../voidIntent';

type Doc = Record<string, unknown>;

const NOW = 1_711_000_000_000;
const REAL_HASH = '$2b$10$realhashplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(
    Object.entries({
      'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
      'users/m1': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] },
      'users/m2': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B2'] },
      'userCredentials/m1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'settings/_rolePermissions': {
        rolePermissions: {
          admin: ['pos_sale', 'pos_discount', 'pos_void', 'product_view'],
          manager: ['pos_sale', 'pos_discount', 'pos_void', 'product_view'],
          staff: ['pos_sale', 'pos_void', 'product_view'],
        },
      },
      ...seed,
    }).map(([k, v]) => [k, { ...v }]),
  );
  const resolveVal = (v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return NOW;
    return v;
  };
  function applyData(path: string, data: Doc, merge = false) {
    const existing = merge ? (store.get(path) ?? {}) : {};
    const next: Doc = merge ? { ...existing } : {};
    for (const [k, v] of Object.entries(data)) next[k] = resolveVal(v);
    store.set(path, next);
  }
  function docRef(path: string): any {
    return {
      __doc: true,
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => {
        const data = store.get(path);
        return { exists: data !== undefined, id: path.slice(path.lastIndexOf('/') + 1), data: () => data };
      },
      set: async (data: Doc, opts?: { merge?: boolean }) => {
        applyData(path, data, opts?.merge === true);
      },
    };
  }
  function colRef(path: string): any {
    return { __col: true, path, doc: (id: string) => docRef(`${path}/${id}`) };
  }
  let txMutex: Promise<void> = Promise.resolve();
  return {
    collection: (c: string) => colRef(c),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prior = txMutex;
      txMutex = prior.then(() => held);
      await prior;
      try {
        const tx = {
          get: async (x: { path: string; id: string }) => {
            const data = store.get(x.path);
            return { exists: data !== undefined, id: x.id, data: () => data };
          },
          set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) =>
            applyData(r.path, data, opts?.merge === true),
          update: (r: { path: string }, data: Doc) => applyData(r.path, data, true),
          create: (r: { path: string }, data: Doc) => {
            if (store.has(r.path)) throw new Error(`ALREADY_EXISTS: ${r.path}`);
            applyData(r.path, data);
          },
        };
        return await fn(tx);
      } finally {
        release();
      }
    },
    __store: store,
  };
}

const requester = {
  uid: 'u-s1',
  token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
};

const baseReq = (over: Partial<SubmitPrivilegedVoidRequest> = {}): SubmitPrivilegedVoidRequest => ({
  commandId: 'cmd-void-1',
  protectedAction: 'VOID_PENDING_SALE',
  targetEntityId: 'O1',
  branchId: 'B1',
  ...over,
});

function matchingApproval(over: Doc = {}): Doc {
  return {
    schemaVersion: 1,
    audience: 'privilegedVoid',
    protectedAction: 'VOID_PENDING_SALE',
    targetEntityId: 'O1',
    branchId: 'B1',
    commandId: 'cmd-void-1',
    requesterStaffId: 's1',
    approverStaffId: 'm1',
    executorStaffId: 's1',
    approverRole: 'manager',
    securityModel: 'delegated',
    authVersionAtIssue: 0,
    credentialVersionAtIssue: 1,
    approverAuthVersionAtIssue: 0,
    issuedAt: NOW,
    expiresAt: { toMillis: () => NOW + 60_000 },
    consumedAt: null,
    consumedByStaffId: null,
    consumingAudience: null,
    consumedCaseVersion: null,
    ...over,
  };
}

function pendingOrder(over: Doc = {}): Doc {
  return {
    id: 'O1',
    branchId: 'B1',
    staffId: 's1',
    reconcileStatus: 'pending_reconcile',
    status: 'completed',
    serverCreatedAt: { toMillis: () => NOW },
    lines: [],
    creditAmt: 0,
    customerId: null,
    total: 100,
    ...over,
  };
}

function approvalPath(commandId = 'cmd-void-1') {
  return `managerApprovals/${deriveApprovalId(commandId)}`;
}

function noncePath(commandId = 'cmd-void-1') {
  return `privilegedActionNonces/${derivePrivilegedNonceKey('B1', deriveApprovalId(commandId))}`;
}

function pendingNonce(over: Doc = {}): Doc {
  const commandId = typeof over.commandId === 'string' ? over.commandId : 'cmd-void-1';
  const branchId = typeof over.branchId === 'string' ? over.branchId : 'B1';
  const approvalId = deriveApprovalId(commandId);
  return {
    schemaVersion: 1,
    status: 'CONSUMED_PENDING_EXECUTION',
    nonceKey: derivePrivilegedNonceKey(branchId, approvalId),
    branchId,
    approvalId,
    commandId,
    protectedAction: 'VOID_PENDING_SALE',
    targetEntityId: 'O1',
    requesterStaffId: 's1',
    approvingManagerId: 'm1',
    audience: 'privilegedVoid',
    consumedAtMillis: NOW - 1,
    completedAtMillis: null,
    outcomeKind: null,
    ...over,
  };
}

function makeExecutor(store: Map<string, Doc>, kind: VoidIntentTxnOutcome['kind'] = 'VOID_TOMBSTONED') {
  const calls: string[] = [];
  return {
    calls,
    executeCanonicalVoid: async (
      _db: unknown,
      orderRef: { id: string },
      options?: { privilegedVoidExecutionId?: string },
    ) => {
      calls.push(orderRef.id);
      const path = `asyncOrders/${orderRef.id}`;
      const existing = store.get(path) ?? {};
      const next: Doc = {
        ...existing,
        status: 'voided',
        reconcileStatus: kind === 'VOID_TOMBSTONED' ? 'settled' : existing.reconcileStatus,
        voidReconciled: kind === 'VOID_APPLIED' ? true : existing.voidReconciled,
      };
      if (typeof options?.privilegedVoidExecutionId === 'string' && options.privilegedVoidExecutionId.length > 0) {
        next.privilegedVoidExecutionId = options.privilegedVoidExecutionId;
      }
      store.set(path, next);
      return { kind } as VoidIntentTxnOutcome;
    },
  };
}

function expectedExecutionId(
  over: {
    commandId?: string;
    protectedAction?: string;
    targetEntityId?: string;
    branchId?: string;
    requesterStaffId?: string;
    approvingManagerId?: string;
  } = {},
) {
  const commandId = over.commandId ?? 'cmd-void-1';
  const branchId = over.branchId ?? 'B1';
  const approvalId = deriveApprovalId(commandId);
  return derivePrivilegedVoidExecutionId(
    buildPrivilegedExecutionBinding({
      nonceKey: derivePrivilegedNonceKey(branchId, approvalId),
      approvalId,
      commandId,
      protectedAction: over.protectedAction ?? 'VOID_PENDING_SALE',
      targetEntityId: over.targetEntityId ?? 'O1',
      branchId,
      requesterStaffId: over.requesterStaffId ?? 's1',
      approvingManagerId: over.approvingManagerId ?? 'm1',
      audience: 'privilegedVoid',
    }),
  );
}

async function run(
  db: ReturnType<typeof makeDb>,
  req: SubmitPrivilegedVoidRequest = baseReq(),
  auth: typeof requester | null = requester,
  kind: VoidIntentTxnOutcome['kind'] = 'VOID_TOMBSTONED',
  extra: { nowMillis?: number; executeCanonicalVoid?: CanonicalVoidExecutor } = {},
) {
  const exec = extra.executeCanonicalVoid
    ? { calls: [] as string[], executeCanonicalVoid: extra.executeCanonicalVoid }
    : makeExecutor(db.__store, kind);
  const res = await performSubmitPrivilegedVoid(db as never, req, auth, {
    nowMillis: extra.nowMillis ?? NOW,
    executeCanonicalVoid: exec.executeCanonicalVoid,
  });
  return { res, exec };
}

describe('submitPrivilegedVoid — source contract', () => {
  test('never treats managerApproved as authority and does not reimplement handleVoidIntent', () => {
    const src = readFileSync(resolve(__dirname, '../submitPrivilegedVoid.ts'), 'utf8');
    expect(src).toMatch(/handleVoidIntent/);
    expect(src).not.toMatch(/planStockRestores/);
    expect(src).not.toMatch(/planLotRestocks/);
    expect(src).toMatch(/void req\.managerApproved/);
  });
});

describe('submitPrivilegedVoid — rejection matrix', () => {
  test('no approval is rejected', async () => {
    const db = makeDb({ 'asyncOrders/O1': pendingOrder() });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(exec.calls).toHaveLength(0);
  });

  test('managerApproved true without approval is still rejected', async () => {
    const db = makeDb({ 'asyncOrders/O1': pendingOrder() });
    const { res, exec } = await run(db, baseReq({ managerApproved: true }));
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(exec.calls).toHaveLength(0);
  });

  test('wrong audience is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ audience: 'resolveShiftCloseAlert' }),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(exec.calls).toHaveLength(0);
  });

  test('wrong action is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ protectedAction: 'VOID_SETTLED_SALE' }),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(exec.calls).toHaveLength(0);
  });

  test('wrong target is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ targetEntityId: 'O-OTHER' }),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(exec.calls).toHaveLength(0);
  });

  test('wrong branch is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder({ branchId: 'B2' }),
      [approvalPath()]: matchingApproval(),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'branch_mismatch' });
    expect(exec.calls).toHaveLength(0);
  });

  test('requester permission missing is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const { res, exec } = await run(db, baseReq(), {
      uid: 'u-s1',
      token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_sale'] },
    });
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('requester stale authVersion is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'users/s1': { isActive: true, deletedAt: null, authVersion: 9, role: 'staff', branchIds: ['B1'] },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('approver without pos_void is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'settings/_rolePermissions': { rolePermissions: { manager: ['pos_sale'], admin: ['pos_void'], staff: ['pos_void'] } },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(exec.calls).toHaveLength(0);
  });

  test('self approval is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ approverStaffId: 's1' }),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'self_approval_not_permitted' });
    expect(exec.calls).toHaveLength(0);
  });

  test('expiry is enforced', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ expiresAt: { toMillis: () => NOW } }),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'expired_approval' });
    expect(exec.calls).toHaveLength(0);
  });

  test('credentialVersion mismatch is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'userCredentials/m1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 9,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('disabled approver is rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'users/m1': { isActive: false, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(exec.calls).toHaveLength(0);
  });
});

describe('submitPrivilegedVoid — canonical execution seam', () => {
  test('valid fully-bound approval reaches canonical void exactly once', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({
      ok: true,
      orderId: 'O1',
      outcome: 'VOID_TOMBSTONED',
      idempotent: false,
    });
    expect(exec.calls).toEqual(['O1']);
    expect(db.__store.get(approvalPath())).toMatchObject({
      consumedByStaffId: 's1',
      consumingAudience: 'privilegedVoid',
    });
    expect(db.__store.has(noncePath())).toBe(true);
    expect(db.__store.get('asyncOrders/O1')).toMatchObject({
      status: 'voided',
      privilegedVoidExecutionId: expectedExecutionId(),
    });
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'COMPLETED', outcomeKind: 'VOID_TOMBSTONED' });
  });

  test('duplicate callable request does not double-void', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const first = await run(db);
    expect(first.res.ok).toBe(true);
    const second = await run(db);
    expect(second.res).toMatchObject({ ok: true, orderId: 'O1', idempotent: true });
    expect(first.exec.calls).toHaveLength(1);
    expect(second.exec.calls).toHaveLength(0);
    expect(db.__store.get('asyncOrders/O1')).toMatchObject({
      privilegedVoidExecutionId: expectedExecutionId(),
    });
  });

  test('second consume of the same approval without prior void is a resume, then replay-safe', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ consumedAt: NOW - 1 }),
      [noncePath()]: pendingNonce(),
    });
    const first = await run(db);
    expect(first.res.ok).toBe(true);
    expect(first.exec.calls).toEqual(['O1']);
    const second = await run(db);
    expect(second.res).toMatchObject({ ok: true, idempotent: true });
    expect(second.exec.calls).toHaveLength(0);
  });

  test('VOID_SETTLED_SALE reaches VOID_APPLIED once', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder({ reconcileStatus: 'settled' }),
      [approvalPath()]: matchingApproval({ protectedAction: 'VOID_SETTLED_SALE' }),
    });
    const { res, exec } = await run(
      db,
      baseReq({ protectedAction: 'VOID_SETTLED_SALE' }),
      requester,
      'VOID_APPLIED',
    );
    expect(res).toEqual({ ok: true, orderId: 'O1', outcome: 'VOID_APPLIED', idempotent: false });
    expect(exec.calls).toEqual(['O1']);
    expect(db.__store.get('asyncOrders/O1')).toMatchObject({
      privilegedVoidExecutionId: expectedExecutionId({ protectedAction: 'VOID_SETTLED_SALE' }),
    });
  });
});

const LIVE_MATRIX = {
  admin: ['pos_sale', 'pos_discount', 'pos_void', 'product_view'],
  manager: ['pos_sale', 'pos_discount', 'pos_void', 'product_view'],
  staff: ['pos_sale', 'pos_void', 'product_view'],
};

describe('submitPrivilegedVoid — BF-1 live requester pos_void / branch', () => {
  test('live staff pos_void revocation denies submit even when token still carries pos_void', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'settings/_rolePermissions': {
        rolePermissions: { ...LIVE_MATRIX, staff: ['pos_sale', 'product_view'] },
      },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
    expect(requester.token.permissions).toEqual(['pos_void']);
    expect(db.__store.get('users/s1')).toMatchObject({ authVersion: 0 });
  });

  test('live branch revocation after mint denies submit', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B2'] },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'branch_mismatch' });
    expect(exec.calls).toHaveLength(0);
    expect(requester.token.branchIds).toEqual(['B1']);
    expect(requester.token.authVersion).toBe(0);
  });

  test('manager requester follows the same live resolver', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({
        requesterStaffId: 'm1',
        executorStaffId: 'm1',
        approverStaffId: 'a1',
        approverRole: 'admin',
      }),
      'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'] },
      'userCredentials/a1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'settings/_rolePermissions': {
        rolePermissions: { ...LIVE_MATRIX, manager: ['pos_sale', 'product_view'] },
      },
    });
    const mgrAuth = {
      uid: 'u-m1',
      token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
    };
    const { res, exec } = await run(db, baseReq(), mgrAuth);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('admin requester follows the same live resolver', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({
        requesterStaffId: 'a1',
        executorStaffId: 'a1',
        approverStaffId: 'm1',
      }),
      'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'] },
      'settings/_rolePermissions': {
        rolePermissions: { ...LIVE_MATRIX, admin: ['pos_sale', 'product_view'] },
      },
    });
    const adminAuth = {
      uid: 'u-a1',
      token: { role: 'admin', staffId: 'a1', branchIds: ['ALL'], authVersion: 0, permissions: ['pos_void'] },
    };
    const { res, exec } = await run(db, baseReq(), adminAuth);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });
});

describe('submitPrivilegedVoid — BF-2 empty/malformed live matrix', () => {
  test('explicit empty staff role row denies requester', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'settings/_rolePermissions': {
        rolePermissions: { ...LIVE_MATRIX, staff: [] },
      },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('explicit empty manager role row denies manager requester', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({
        requesterStaffId: 'm1',
        executorStaffId: 'm1',
        approverStaffId: 'a1',
        approverRole: 'admin',
      }),
      'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'] },
      'userCredentials/a1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'settings/_rolePermissions': {
        rolePermissions: { ...LIVE_MATRIX, manager: [] },
      },
    });
    const mgrAuth = {
      uid: 'u-m1',
      token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
    };
    const { res, exec } = await run(db, baseReq(), mgrAuth);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('manager approver explicit empty row denies', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'settings/_rolePermissions': {
        rolePermissions: { ...LIVE_MATRIX, manager: [] },
      },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(exec.calls).toHaveLength(0);
  });

  test('admin approver explicit empty row denies', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({
        approverStaffId: 'a1',
        approverRole: 'admin',
      }),
      'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'] },
      'userCredentials/a1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'settings/_rolePermissions': {
        rolePermissions: { ...LIVE_MATRIX, admin: [] },
      },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(exec.calls).toHaveLength(0);
  });

  test('malformed role row denies', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'settings/_rolePermissions': { rolePermissions: { staff: 'pos_void', manager: ['pos_void'], admin: ['pos_void'] } },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('absent role-permission document fails closed', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    db.__store.delete('settings/_rolePermissions');
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('unreadable role-permission document fails closed', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const exec = makeExecutor(db.__store);
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW,
      executeCanonicalVoid: exec.executeCanonicalVoid,
      readRolePermissions: async () => {
        throw new Error('unreadable');
      },
    });
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('F7 (SEC-001 Packet C-A): an active staged-deny for pos_void blocks the requester even though the matrix still grants it', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const exec = makeExecutor(db.__store);
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW,
      executeCanonicalVoid: exec.executeCanonicalVoid,
      readStagedDenyHead: async (roleId: string) =>
        roleId === 'staff'
          ? { roleId: 'staff', state: 'DRAINING', changeId: 'change-1', deniedPermissions: ['pos_void'] }
          : null,
    });
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('C-A-RC-003: a staged-deny head reader failure blocks the requester even though the matrix grants pos_void', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const exec = makeExecutor(db.__store);
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW,
      executeCanonicalVoid: exec.executeCanonicalVoid,
      readStagedDenyHead: async () => {
        throw new Error('staged-deny head unavailable');
      },
    });
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });

  test('C-A-RC-003-R1: a present but malformed staged-deny head blocks the requester via the default Firestore reader', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'privilegedStagedRoleDeny/staff': { state: 'DRAINING', changeId: 'change-1', deniedPermissions: [42] },
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exec.calls).toHaveLength(0);
  });
});

describe('submitPrivilegedVoid — BF-3 durable exact-bound resume', () => {
  test('never-consumed expired approval remains rejected', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ expiresAt: { toMillis: () => NOW } }),
    });
    const { res, exec } = await run(db);
    expect(res).toEqual({ ok: false, code: 'expired_approval' });
    expect(exec.calls).toHaveLength(0);
    expect(db.__store.has(noncePath())).toBe(false);
  });

  test('wrong requester rejects initial consume', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
      'users/s2': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
    });
    const other = {
      uid: 'u-s2',
      token: { role: 'staff', staffId: 's2', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
    };
    const { res, exec } = await run(db, baseReq(), other);
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(exec.calls).toHaveLength(0);
  });

  test('consume then canonical throw is resumable after approval TTL', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const calls: string[] = [];
    const throwing: CanonicalVoidExecutor = async () => {
      calls.push('throw');
      throw new Error('canonical_before_commit');
    };
    await expect(
      performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
        nowMillis: NOW,
        executeCanonicalVoid: throwing,
      }),
    ).rejects.toThrow('canonical_before_commit');
    expect(calls).toEqual(['throw']);
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'CONSUMED_PENDING_EXECUTION' });
    expect(db.__store.get('asyncOrders/O1')).not.toMatchObject({ status: 'voided' });

    const retry = makeExecutor(db.__store);
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW + 120_000,
      executeCanonicalVoid: retry.executeCanonicalVoid,
    });
    expect(res).toEqual({ ok: true, orderId: 'O1', outcome: 'VOID_TOMBSTONED', idempotent: true });
    expect(retry.calls).toEqual(['O1']);
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'COMPLETED', outcomeKind: 'VOID_TOMBSTONED' });
    expect(db.__store.get('asyncOrders/O1')).toMatchObject({
      privilegedVoidExecutionId: expectedExecutionId(),
    });

    const third = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW + 180_000,
      executeCanonicalVoid: retry.executeCanonicalVoid,
    });
    expect(third).toMatchObject({ ok: true, idempotent: true });
    expect(retry.calls).toEqual(['O1']);
  });

  test('canonical effect then ambiguous throw resumes after TTL without duplicating executor', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval(),
    });
    const calls: string[] = [];
    const ambiguous: CanonicalVoidExecutor = async (_database, orderRef, options) => {
      calls.push(orderRef.id);
      const path = `asyncOrders/${orderRef.id}`;
      const existing = db.__store.get(path) ?? {};
      db.__store.set(path, {
        ...existing,
        status: 'voided',
        voidReconciled: true,
        privilegedVoidExecutionId: options?.privilegedVoidExecutionId,
      });
      throw new Error('ambiguous_after_commit');
    };
    await expect(
      performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
        nowMillis: NOW,
        executeCanonicalVoid: ambiguous,
      }),
    ).rejects.toThrow('ambiguous_after_commit');
    expect(calls).toEqual(['O1']);
    expect(db.__store.get('asyncOrders/O1')).toMatchObject({
      status: 'voided',
      privilegedVoidExecutionId: expectedExecutionId(),
    });
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'CONSUMED_PENDING_EXECUTION' });

    const retryCalls: string[] = [];
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW + 120_000,
      executeCanonicalVoid: async () => {
        retryCalls.push('should-not-run');
        return { kind: 'VOID_TOMBSTONED' };
      },
    });
    expect(res).toEqual({ ok: true, orderId: 'O1', outcome: 'NOOP', idempotent: true });
    expect(retryCalls).toHaveLength(0);
    expect(calls).toEqual(['O1']);
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'COMPLETED', outcomeKind: 'NOOP' });
    expect(db.__store.get('asyncOrders/O1')).toMatchObject({
      privilegedVoidExecutionId: expectedExecutionId(),
    });
  });

  test('unrelated generic void does not complete pending execution A', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ consumedAt: NOW - 1 }),
      [noncePath()]: pendingNonce(),
    });
    db.__store.set('asyncOrders/O1', {
      ...pendingOrder(),
      status: 'voided',
      voidReconciled: true,
      privilegedVoidExecutionId: 'unrelated-execution-b',
    });
    const retryCalls: string[] = [];
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW + 120_000,
      executeCanonicalVoid: async () => {
        retryCalls.push('should-not-run');
        return { kind: 'VOID_TOMBSTONED' };
      },
    });
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(retryCalls).toHaveLength(0);
    expect(db.__store.get(noncePath())).toMatchObject({
      status: 'CONSUMED_PENDING_EXECUTION',
      completedAtMillis: null,
    });
    expect(db.__store.get('asyncOrders/O1')).toMatchObject({
      privilegedVoidExecutionId: 'unrelated-execution-b',
    });
  });

  test('different target correlation does not complete pending execution A or overwrite B', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ consumedAt: NOW - 1 }),
      [noncePath()]: pendingNonce(),
    });
    const winnerB = expectedExecutionId({ commandId: 'cmd-void-B' });
    db.__store.set('asyncOrders/O1', {
      ...pendingOrder(),
      status: 'voided',
      voidReconciled: true,
      privilegedVoidExecutionId: winnerB,
    });
    const retryCalls: string[] = [];
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW + 120_000,
      executeCanonicalVoid: async () => {
        retryCalls.push('should-not-run');
        return { kind: 'VOID_APPLIED' };
      },
    });
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(retryCalls).toHaveLength(0);
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'CONSUMED_PENDING_EXECUTION' });
    expect(db.__store.get('asyncOrders/O1')?.privilegedVoidExecutionId).toBe(winnerB);
  });

  test('missing target correlation does not complete pending execution A', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ consumedAt: NOW - 1 }),
      [noncePath()]: pendingNonce(),
    });
    db.__store.set('asyncOrders/O1', {
      ...pendingOrder(),
      status: 'voided',
      voidReconciled: true,
    });
    const retryCalls: string[] = [];
    const res = await performSubmitPrivilegedVoid(db as never, baseReq(), requester, {
      nowMillis: NOW + 120_000,
      executeCanonicalVoid: async () => {
        retryCalls.push('should-not-run');
        return { kind: 'VOID_TOMBSTONED' };
      },
    });
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(retryCalls).toHaveLength(0);
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'CONSUMED_PENDING_EXECUTION' });
    expect(db.__store.get('asyncOrders/O1')?.privilegedVoidExecutionId).toBeUndefined();
  });

  test('cross-binding resume is rejected and completed execution cannot authorize a new void', async () => {
    const db = makeDb({
      'asyncOrders/O1': pendingOrder(),
      [approvalPath()]: matchingApproval({ consumedAt: NOW - 1 }),
      [noncePath()]: pendingNonce(),
      'users/s2': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
    });
    const otherRequester = {
      uid: 'u-s2',
      token: { role: 'staff', staffId: 's2', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
    };
    expect((await run(db, baseReq(), otherRequester)).res).toEqual({ ok: false, code: 'invalid_target' });
    expect(
      (await run(db, baseReq({ protectedAction: 'VOID_SETTLED_SALE' }))).res,
    ).toEqual({ ok: false, code: 'invalid_target' });
    expect((await run(db, baseReq({ targetEntityId: 'O2' }))).res).toEqual({ ok: false, code: 'invalid_target' });
    expect((await run(db, baseReq({ branchId: 'B2' }))).res.ok).toBe(false);
    expect((await run(db, baseReq({ commandId: 'cmd-other' }))).res).toEqual({ ok: false, code: 'invalid_target' });

    const first = await run(db);
    expect(first.res.ok).toBe(true);
    expect(db.__store.get(noncePath())).toMatchObject({ status: 'COMPLETED' });

    const afterComplete = await run(db, baseReq({ targetEntityId: 'O2' }));
    expect(afterComplete.res).toEqual({ ok: false, code: 'invalid_target' });
    expect(afterComplete.exec.calls).toHaveLength(0);
  });
});
