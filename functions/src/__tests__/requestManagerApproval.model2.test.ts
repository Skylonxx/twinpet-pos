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

import {
  APPROVAL_DUMMY_PIN_HASH,
  performRequestManagerApproval,
  type PinCompareFn,
} from '../requestManagerApproval';
import {
  APPROVAL_SECURITY_MODEL_DELEGATED,
  LOCKOUT_WINDOW_MS,
  approvalDocHasPinAdjacentField,
  deriveApprovalId,
  deriveAttemptScopeKey,
  type RequestManagerApprovalRequest,
} from '../requestManagerApprovalCore';

type Doc = Record<string, unknown>;

const NOW = 1_711_000_000_000;
const REAL_HASH = '$2b$10$realhashplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PIN = '1234';
const WRONG = '9999';

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(
    Object.entries({
      'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
      'users/m1': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] },
      'users/m2': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B2'] },
      'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'] },
      'users/a2': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['B1'] },
      'userCredentials/m1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'userCredentials/a1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'userCredentials/a2': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'userCredentials/s1': {
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
      set: async (data: Doc) => {
        applyData(path, data);
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
          set: (r: { path: string }, data: Doc) => applyData(r.path, data),
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

const staff = { uid: 'u-s1', token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0 } };
const mgr = { uid: 'u-m1', token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0 } };

const delegatedReq = (over: Partial<RequestManagerApprovalRequest> = {}): RequestManagerApprovalRequest => ({
  commandId: 'cmd-d1',
  protectedAction: 'shift_close_alert_acknowledge',
  targetEntityId: 'S1',
  branchId: 'B1',
  pin: PIN,
  securityModel: APPROVAL_SECURITY_MODEL_DELEGATED,
  approverStaffId: 'm1',
  ...over,
});

function makeCompare() {
  const calls: Array<{ pin: string; hash: string }> = [];
  const comparePin: PinCompareFn = async (pin, hash) => {
    calls.push({ pin, hash });
    if (hash === APPROVAL_DUMMY_PIN_HASH) return false;
    return pin === PIN && hash === REAL_HASH;
  };
  return { calls, comparePin };
}

async function run(
  db: ReturnType<typeof makeDb>,
  comparePin: PinCompareFn,
  req: RequestManagerApprovalRequest = delegatedReq(),
  auth: { uid: string; token: Record<string, unknown> } | null = staff,
) {
  return performRequestManagerApproval(db as never, req, auth, {
    nowMillis: NOW,
    comparePin,
    dummyPinHash: APPROVAL_DUMMY_PIN_HASH,
  });
}

function approvalPath(commandId = 'cmd-d1') {
  return `managerApprovals/${deriveApprovalId(commandId)}`;
}

function requesterAttemptPath() {
  return `managerApprovalAttempts/${deriveAttemptScopeKey('B1', 's1')}`;
}

function approverAttemptPath() {
  return `managerApprovalAttempts/${deriveAttemptScopeKey('B1', 'm1')}`;
}

describe('requestManagerApproval Model 2 — positive mint', () => {
  test('staff + same-branch manager mints delegated three-actor record', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: true, approvalId: deriveApprovalId('cmd-d1'), expiresAtMillis: NOW + 120_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pin: PIN, hash: REAL_HASH });
    const doc = db.__store.get(approvalPath()) as Doc;
    expect(doc).toMatchObject({
      requesterStaffId: 's1',
      approverStaffId: 'm1',
      executorStaffId: 's1',
      approverRole: 'manager',
      securityModel: APPROVAL_SECURITY_MODEL_DELEGATED,
      authVersionAtIssue: 0,
      credentialVersionAtIssue: 1,
      approverAuthVersionAtIssue: 0,
      consumedAt: null,
    });
    expect(approvalDocHasPinAdjacentField(doc)).toBe(false);
    expect(JSON.stringify([...db.__store.entries()])).not.toContain(PIN);
  });

  test('staff + admin ALL on a concrete branch mints', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ approverStaffId: 'a1' }));
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(db.__store.get(approvalPath())).toMatchObject({
      approverStaffId: 'a1',
      approverRole: 'admin',
      executorStaffId: 's1',
    });
  });

  test('staff + admin exact branch (no ALL) mints', async () => {
    const db = makeDb();
    const { comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ approverStaffId: 'a2' }));
    expect(res.ok).toBe(true);
    expect(db.__store.get(approvalPath())).toMatchObject({ approverStaffId: 'a2', approverRole: 'admin' });
  });

  test('lost mint retry same commandId is idempotent', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const first = await run(db, comparePin);
    const second = await run(db, comparePin);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);
    const approvals = [...db.__store.keys()].filter((k) => k.startsWith('managerApprovals/'));
    expect(approvals).toHaveLength(1);
  });
});

describe('requestManagerApproval Model 2 — negatives', () => {
  test('self approval rejects with zero bcrypt and no attempt consumed', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ approverStaffId: 's1' }));
    expect(res).toEqual({ ok: false, code: 'self_approval_not_permitted' });
    expect(calls).toHaveLength(0);
    expect(db.__store.has(requesterAttemptPath())).toBe(false);
    expect(db.__store.has(approvalPath())).toBe(false);
  });

  test('staff requester with ALL cannot mint for a concrete branch', async () => {
    const db = makeDb({
      'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['ALL'] },
    });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: false, code: 'branch_mismatch' });
    expect(calls).toHaveLength(0);
    expect(db.__store.has(approvalPath())).toBe(false);
  });

  test('manager requester with delegated is not_authorized', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ approverStaffId: 'a1' }), mgr);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
  });

  test('approver role staff is collapsed to approver_not_eligible and consumes a requester attempt', async () => {
    const db = makeDb({
      'users/s2': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
    });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ approverStaffId: 's2' }));
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(calls).toHaveLength(0);
    expect(db.__store.get(requesterAttemptPath())).toMatchObject({ consecutiveFailures: 1 });
    expect(db.__store.has(approverAttemptPath())).toBe(false);
  });

  test('nonexistent approver is indistinguishable from ineligible', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ approverStaffId: 'missing' }));
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(calls).toHaveLength(0);
    expect(db.__store.get(requesterAttemptPath())).toMatchObject({ consecutiveFailures: 1 });
  });

  test('manager wrong branch is approver_not_eligible', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ approverStaffId: 'm2' }));
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(calls).toHaveLength(0);
  });

  test('branchId ALL is invalid_target for delegated', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ branchId: 'ALL' }));
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(calls).toHaveLength(0);
  });

  test('unknown securityModel fails closed', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ securityModel: 'break-glass' }));
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(calls).toHaveLength(0);
  });

  test('wrong PIN invalid_credentials increments requester attempt only', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, delegatedReq({ pin: WRONG }));
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(db.__store.get(requesterAttemptPath())).toMatchObject({ consecutiveFailures: 1 });
    expect(db.__store.has(approverAttemptPath())).toBe(false);
  });

  test('non-rotated approver credential dummy-compares to invalid_credentials', async () => {
    const db = makeDb({
      'userCredentials/m1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'backfilled_not_trusted',
        disabled: false,
        updatedBy: 't',
      },
    });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(APPROVAL_DUMMY_PIN_HASH);
  });

  test('six approver-ineligibility probes lock the requester, not the approver', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    for (let i = 0; i < 5; i++) {
      const r = await run(db, comparePin, delegatedReq({ commandId: `probe-${i}`, approverStaffId: 'missing' }));
      expect(r).toEqual({ ok: false, code: 'approver_not_eligible' });
    }
    const sixth = await run(db, comparePin, delegatedReq({ commandId: 'probe-5', approverStaffId: 'missing' }));
    expect(sixth).toEqual({ ok: false, code: 'locked' });
    expect(calls).toHaveLength(0);
    expect(db.__store.get(requesterAttemptPath())).toMatchObject({ consecutiveFailures: 5 });
    expect(db.__store.has(approverAttemptPath())).toBe(false);
    const locked = db.__store.get(requesterAttemptPath())?.lockedUntil as { toMillis?: () => number } | undefined;
    expect(locked?.toMillis?.()).toBe(NOW + LOCKOUT_WINDOW_MS);
  });

  test('changing approver after a successful mint on the same commandId is invalid_target', async () => {
    const db = makeDb();
    const { comparePin } = makeCompare();
    const first = await run(db, comparePin, delegatedReq({ approverStaffId: 'm1' }));
    expect(first.ok).toBe(true);
    const second = await run(db, comparePin, delegatedReq({ approverStaffId: 'a1' }));
    expect(second).toEqual({ ok: false, code: 'invalid_target' });
  });

  test('exactly one bcrypt compare site remains', () => {
    const shellSrc = readFileSync(resolve(__dirname, '../requestManagerApproval.ts'), 'utf8');
    expect(shellSrc.match(/await comparePin\(/g)?.length).toBe(1);
  });
});

const voidStaff = {
  uid: 'u-s1',
  token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
};

const voidReq = (over: Partial<RequestManagerApprovalRequest> = {}): RequestManagerApprovalRequest =>
  delegatedReq({
    commandId: 'cmd-void-1',
    protectedAction: 'VOID_PENDING_SALE',
    targetEntityId: 'O1',
    ...over,
  });

describe('requestManagerApproval Packet B void audience', () => {
  test('void approval mints under privilegedVoid', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, voidReq(), voidStaff);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(db.__store.get(approvalPath('cmd-void-1'))).toMatchObject({
      audience: 'privilegedVoid',
      protectedAction: 'VOID_PENDING_SALE',
      requesterStaffId: 's1',
      approverStaffId: 'm1',
      executorStaffId: 's1',
    });
  });

  test('shift-close approval document cannot bind as privilegedVoid mint retry', async () => {
    const db = makeDb();
    const { comparePin } = makeCompare();
    const shift = await run(db, comparePin, delegatedReq({ commandId: 'cmd-cross' }));
    expect(shift.ok).toBe(true);
    const voidRetry = await run(
      db,
      comparePin,
      voidReq({ commandId: 'cmd-cross' }),
      voidStaff,
    );
    expect(voidRetry).toEqual({ ok: false, code: 'invalid_target' });
  });

  test('void approval cannot bind to shift-close on same commandId retry', async () => {
    const db = makeDb();
    const { comparePin } = makeCompare();
    const minted = await run(db, comparePin, voidReq({ commandId: 'cmd-cross-2' }), voidStaff);
    expect(minted.ok).toBe(true);
    const shiftRetry = await run(
      db,
      comparePin,
      delegatedReq({ commandId: 'cmd-cross-2' }),
    );
    expect(shiftRetry).toEqual({ ok: false, code: 'invalid_target' });
  });

  test('void self-approval is rejected before bcrypt', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, voidReq({ approverStaffId: 's1' }), voidStaff);
    expect(res).toEqual({ ok: false, code: 'self_approval_not_permitted' });
    expect(calls).toHaveLength(0);
  });

  test('void reauth is rejected as self-approval before bcrypt', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const mgrVoid = {
      uid: 'u-m1',
      token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
    };
    const res = await run(
      db,
      comparePin,
      {
        commandId: 'cmd-reauth-void',
        protectedAction: 'VOID_PENDING_SALE',
        targetEntityId: 'O1',
        branchId: 'B1',
        pin: PIN,
      },
      mgrVoid,
    );
    expect(res).toEqual({ ok: false, code: 'self_approval_not_permitted' });
    expect(calls).toHaveLength(0);
  });

  test('approver without pos_void is rejected', async () => {
    const db = makeDb({
      'settings/_rolePermissions': {
        rolePermissions: { manager: ['pos_sale'], admin: ['pos_void'], staff: ['pos_void'] },
      },
    });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, voidReq(), voidStaff);
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(calls).toHaveLength(0);
  });

  test('requester without pos_void is rejected', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, voidReq(), staff);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
  });

  test('approver wrong branch is rejected', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, voidReq({ approverStaffId: 'm2' }), voidStaff);
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(calls).toHaveLength(0);
  });

  test('duplicate void request is idempotent', async () => {
    const db = makeDb();
    const { comparePin } = makeCompare();
    const first = await run(db, comparePin, voidReq(), voidStaff);
    const second = await run(db, comparePin, voidReq(), voidStaff);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
  });

  test('live staff pos_void revocation denies mint even when token still carries pos_void', async () => {
    const db = makeDb({
      'settings/_rolePermissions': {
        rolePermissions: {
          admin: ['pos_sale', 'pos_void'],
          manager: ['pos_sale', 'pos_void'],
          staff: ['pos_sale', 'product_view'],
        },
      },
    });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, voidReq(), voidStaff);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
    expect(voidStaff.token.permissions).toEqual(['pos_void']);
    expect(db.__store.get('users/s1')).toMatchObject({ authVersion: 0 });
  });

  test('manager requester follows the same live resolver', async () => {
    const db = makeDb({
      'settings/_rolePermissions': {
        rolePermissions: {
          admin: ['pos_sale', 'pos_void'],
          manager: ['pos_sale'],
          staff: ['pos_sale', 'pos_void'],
        },
      },
    });
    const { calls, comparePin } = makeCompare();
    const mgrVoid = {
      uid: 'u-m1',
      token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
    };
    const res = await run(db, comparePin, voidReq({ approverStaffId: 'a1' }), mgrVoid);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
  });

  test('admin requester follows the same live resolver', async () => {
    const db = makeDb({
      'settings/_rolePermissions': {
        rolePermissions: {
          admin: ['pos_sale'],
          manager: ['pos_sale', 'pos_void'],
          staff: ['pos_sale', 'pos_void'],
        },
      },
    });
    const { calls, comparePin } = makeCompare();
    const adminVoid = {
      uid: 'u-a1',
      token: { role: 'admin', staffId: 'a1', branchIds: ['ALL'], authVersion: 0, permissions: ['pos_void'] },
    };
    const res = await run(db, comparePin, voidReq({ approverStaffId: 'm1' }), adminVoid);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
  });

  test('explicit empty manager/admin/staff rows deny mint', async () => {
    const { comparePin, calls } = makeCompare();
    for (const role of ['staff', 'manager', 'admin'] as const) {
      const db = makeDb({
        'settings/_rolePermissions': {
          rolePermissions: {
            admin: role === 'admin' ? [] : ['pos_void'],
            manager: role === 'manager' ? [] : ['pos_void'],
            staff: role === 'staff' ? [] : ['pos_void'],
          },
        },
      });
      const auth =
        role === 'staff'
          ? voidStaff
          : role === 'manager'
            ? {
                uid: 'u-m1',
                token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_void'] },
              }
            : {
                uid: 'u-a1',
                token: { role: 'admin', staffId: 'a1', branchIds: ['ALL'], authVersion: 0, permissions: ['pos_void'] },
              };
      const req = role === 'staff' ? voidReq() : voidReq({ approverStaffId: role === 'manager' ? 'a1' : 'm1' });
      const res = await run(db, comparePin, req, auth);
      expect(res).toEqual({ ok: false, code: 'not_authorized' });
    }
    expect(calls).toHaveLength(0);
  });

  test('malformed and unreadable role-permission source denies mint', async () => {
    const malformed = makeDb({
      'settings/_rolePermissions': { rolePermissions: { staff: { pos_void: true }, manager: ['pos_void'], admin: ['pos_void'] } },
    });
    const { comparePin, calls } = makeCompare();
    expect(await run(malformed, comparePin, voidReq(), voidStaff)).toEqual({ ok: false, code: 'not_authorized' });
    const unreadable = makeDb();
    expect(
      await performRequestManagerApproval(unreadable as never, voidReq(), voidStaff, {
        nowMillis: NOW,
        comparePin,
        dummyPinHash: APPROVAL_DUMMY_PIN_HASH,
        readRolePermissions: async () => {
          throw new Error('unreadable');
        },
      }),
    ).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
  });
});
