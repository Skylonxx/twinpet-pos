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
  LOCKOUT_WINDOW_MS,
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
      'users/m1': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] },
      'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
      'users/m3': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B2'] },
      'userCredentials/m1': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
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
  // Serialize transactions so concurrent RMW callbacks cannot interleave a
  // lost update the way a blind get-then-set would. Matches Admin SDK
  // serializable commit for this in-memory store.
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

const mgr = { uid: 'u1', token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0 } };
const staff = { uid: 'u3', token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0 } };
const otherBranch = { uid: 'u4', token: { role: 'manager', staffId: 'm3', branchIds: ['B2'], authVersion: 0 } };

const baseReq = (over: Partial<RequestManagerApprovalRequest> = {}): RequestManagerApprovalRequest => ({
  commandId: 'cmd-1',
  protectedAction: 'shift_close_alert_acknowledge',
  targetEntityId: 'S1',
  branchId: 'B1',
  pin: PIN,
  ...over,
});

function matchingApproval(over: Doc = {}): Doc {
  return {
    schemaVersion: 1,
    audience: 'resolveShiftCloseAlert',
    protectedAction: 'shift_close_alert_acknowledge',
    targetEntityId: 'S1',
    branchId: 'B1',
    commandId: 'cmd-1',
    requesterStaffId: 'm1',
    approverStaffId: 'm1',
    executorStaffId: 'm1',
    approverRole: 'manager',
    securityModel: 'reauth',
    authVersionAtIssue: 0,
    credentialVersionAtIssue: 1,
    issuedAt: NOW,
    expiresAt: { toMillis: () => NOW + 60_000 },
    consumedAt: null,
    consumedByStaffId: null,
    consumingAudience: null,
    consumedCaseVersion: null,
    ...over,
  };
}

function makeCompare() {
  const calls: Array<{ pin: string; hash: string }> = [];
  const comparePin = async (pin: string, hash: string) => {
    calls.push({ pin, hash });
    if (hash === APPROVAL_DUMMY_PIN_HASH) return false;
    return pin === PIN && hash === REAL_HASH;
  };
  return { calls, comparePin };
}

async function run(
  db: ReturnType<typeof makeDb>,
  comparePin: (pin: string, hash: string) => Promise<boolean>,
  req: RequestManagerApprovalRequest = baseReq(),
  auth: typeof mgr | typeof staff | typeof otherBranch | null = mgr,
) {
  return performRequestManagerApproval(db as never, req, auth, {
    nowMillis: NOW,
    comparePin,
    dummyPinHash: APPROVAL_DUMMY_PIN_HASH,
  });
}

function approvalPath(commandId = 'cmd-1') {
  return `managerApprovals/${deriveApprovalId(commandId)}`;
}

function attemptPath() {
  return `managerApprovalAttempts/${deriveAttemptScopeKey('B1', 'm1')}`;
}

function storeHasPin(db: ReturnType<typeof makeDb>, pin: string) {
  return JSON.stringify([...db.__store.entries()]).includes(pin);
}

function lockedUntilMillis(doc: Doc | undefined): number | null {
  const v = doc?.lockedUntil as { toMillis?: () => number } | null | undefined;
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  return null;
}

describe('requestManagerApproval — claim neutrality (source)', () => {
  test('verifier files never mint claims, import admin auth, log, or embed PIN literals', () => {
    const coreSrc = readFileSync(resolve(__dirname, '../requestManagerApprovalCore.ts'), 'utf8');
    const shellSrc = readFileSync(resolve(__dirname, '../requestManagerApproval.ts'), 'utf8');
    for (const src of [coreSrc, shellSrc]) {
      expect(src).not.toMatch(/setCustomUserClaims/);
      expect(src).not.toMatch(/\bgetAuth\b/);
      expect(src).not.toMatch(/firebase-admin\/auth/);
      expect(src).not.toMatch(/console\.log/);
      expect(src).not.toMatch(/['"`]1234['"`]/);
      expect(src).not.toMatch(/['"`]9999['"`]/);
    }
  });
});

describe('requestManagerApproval — bcrypt 14-case matrix', () => {
  test('1. new approval success -> exactly 1 real compare', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: true, approvalId: deriveApprovalId('cmd-1'), expiresAtMillis: NOW + 120_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pin: PIN, hash: REAL_HASH });
    expect(db.__store.get(approvalPath())).toMatchObject({
      audience: 'resolveShiftCloseAlert',
      requesterStaffId: 'm1',
      approverStaffId: 'm1',
      executorStaffId: 'm1',
      securityModel: 'reauth',
      consumedAt: null,
    });
    expect(storeHasPin(db, PIN)).toBe(false);
  });

  test('2. wrong PIN -> exactly 1 real compare, invalid_credentials', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq({ pin: WRONG }));
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pin: WRONG, hash: REAL_HASH });
    expect(db.__store.has(approvalPath())).toBe(false);
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 1 });
  });

  test('3. malformed PIN -> exactly 1 dummy compare', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq({ pin: '12' }));
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(APPROVAL_DUMMY_PIN_HASH);
  });

  test('4. missing credential -> exactly 1 dummy compare', async () => {
    const db = makeDb();
    db.__store.delete('userCredentials/m1');
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(APPROVAL_DUMMY_PIN_HASH);
  });

  test('5. unusable/disabled/pre-rotation -> exactly 1 dummy compare', async () => {
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

  test('6. existing valid + correct PIN -> 1 real compare, same approvalId', async () => {
    const existing = matchingApproval();
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: true, approvalId: deriveApprovalId('cmd-1'), expiresAtMillis: NOW + 60_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(REAL_HASH);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('7. existing valid + wrong PIN -> 1 real compare, invalid_credentials, no state probe', async () => {
    const existing = matchingApproval();
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq({ pin: WRONG }));
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(REAL_HASH);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('8. consumed + correct PIN -> 1 real compare, replayed_approval', async () => {
    const existing = matchingApproval({ consumedAt: NOW - 1 });
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: false, code: 'replayed_approval' });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(REAL_HASH);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('9. consumed + wrong PIN -> 1 real compare, invalid_credentials', async () => {
    const existing = matchingApproval({ consumedAt: NOW - 1 });
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq({ pin: WRONG }));
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('10. expired + correct PIN -> 1 real compare, expired_approval', async () => {
    const existing = matchingApproval({ expiresAt: { toMillis: () => NOW } });
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: false, code: 'expired_approval' });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(REAL_HASH);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('11. expired + wrong PIN -> 1 real compare, invalid_credentials', async () => {
    const existing = matchingApproval({ expiresAt: { toMillis: () => NOW } });
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq({ pin: WRONG }));
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('12. different binding + correct PIN -> 1 real compare, invalid_target, record unmutated', async () => {
    const existing = matchingApproval({ protectedAction: 'shift_close_alert_resolve' });
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect(calls).toHaveLength(1);
    expect(calls[0].hash).toBe(REAL_HASH);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('13. different binding + wrong PIN -> 1 real compare, invalid_credentials', async () => {
    const existing = matchingApproval({ protectedAction: 'shift_close_alert_resolve' });
    const db = makeDb({ [approvalPath()]: existing });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq({ pin: WRONG }));
    expect(res).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(calls).toHaveLength(1);
    expect(db.__store.get(approvalPath())).toEqual(existing);
  });

  test('14. active lockout -> ZERO compares, locked, counter unchanged', async () => {
    const db = makeDb({
      [attemptPath()]: {
        schemaVersion: 1,
        consecutiveFailures: 5,
        firstFailureAt: { toMillis: () => NOW - 1_000 },
        lockedUntil: { toMillis: () => NOW + 60_000 },
      },
    });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin);
    expect(res).toEqual({ ok: false, code: 'locked' });
    expect(calls).toHaveLength(0);
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 5 });
  });
});

describe('requestManagerApproval — atomic lockout counter / concurrency', () => {
  test('five concurrent wrong PINs from 0: each compares once, no lost update, lock at threshold 5', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const yieldingCompare: typeof comparePin = async (pin, hash) => {
      await Promise.resolve();
      return comparePin(pin, hash);
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        run(db, yieldingCompare, baseReq({ commandId: `cmd-c${i}`, pin: WRONG })),
      ),
    );
    expect(results.every((r) => r.ok === false && r.code === 'invalid_credentials')).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.hash === REAL_HASH)).toBe(true);
    const attempts = db.__store.get(attemptPath());
    expect(attempts).toMatchObject({ consecutiveFailures: 5 });
    expect(lockedUntilMillis(attempts)).toBe(NOW + LOCKOUT_WINDOW_MS);
  });

  test('request after committed lock: 0 compares, counter unchanged, lock window not extended', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        run(db, comparePin, baseReq({ commandId: `cmd-l${i}`, pin: WRONG })),
      ),
    );
    const lockedUntil = lockedUntilMillis(db.__store.get(attemptPath()));
    const beforeCount = calls.length;
    const sixth = await run(db, comparePin, baseReq({ commandId: 'cmd-l6', pin: WRONG }));
    expect(sixth).toEqual({ ok: false, code: 'locked' });
    expect(calls).toHaveLength(beforeCount);
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 5 });
    expect(lockedUntilMillis(db.__store.get(attemptPath()))).toBe(lockedUntil);
  });

  test('stale writer cannot overwrite a newer committed attempt count', async () => {
    const db = makeDb();
    let releaseStale!: () => void;
    let staleEntered = false;
    const staleCompare: PinCompareFn = async () => {
      staleEntered = true;
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      return false;
    };
    const { comparePin: freshCompare } = makeCompare();
    const staleP = run(db, staleCompare, baseReq({ commandId: 'cmd-stale', pin: WRONG }));
    await vi.waitFor(() => expect(staleEntered).toBe(true));
    await run(db, freshCompare, baseReq({ commandId: 'cmd-fresh1', pin: WRONG }));
    await run(db, freshCompare, baseReq({ commandId: 'cmd-fresh2', pin: WRONG }));
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 2 });
    releaseStale();
    const staleRes = await staleP;
    expect(staleRes).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 3 });
  });

  test('successful reset does not clobber a newer committed failure', async () => {
    const db = makeDb();
    let releaseSuccess!: () => void;
    let successEntered = false;
    const successCompare: PinCompareFn = async (pin, hash) => {
      successEntered = true;
      await new Promise<void>((resolve) => {
        releaseSuccess = resolve;
      });
      return pin === PIN && hash === REAL_HASH;
    };
    const { comparePin: failCompare } = makeCompare();
    const successP = run(db, successCompare, baseReq({ commandId: 'cmd-ok' }));
    await vi.waitFor(() => expect(successEntered).toBe(true));
    const failRes = await run(db, failCompare, baseReq({ commandId: 'cmd-fail', pin: WRONG }));
    expect(failRes).toEqual({ ok: false, code: 'invalid_credentials' });
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 1 });
    releaseSuccess();
    const successRes = await successP;
    expect(successRes.ok).toBe(true);
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 1 });
  });

  test('correct PIN after exclusive failures still resets when no newer mutation exists', async () => {
    const db = makeDb();
    const { comparePin: failCompare } = makeCompare();
    await run(db, failCompare, baseReq({ commandId: 'cmd-f1', pin: WRONG }));
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 1 });
    const { comparePin: okCompare } = makeCompare();
    const res = await run(db, okCompare, baseReq({ commandId: 'cmd-ok2' }));
    expect(res.ok).toBe(true);
    expect(db.__store.get(attemptPath())).toMatchObject({ consecutiveFailures: 0, lockedUntil: null });
  });
});

describe('requestManagerApproval — deterministic mint race', () => {
  test('concurrent same-command valid remints share one approval, one compare each, no bcrypt retry', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const yieldingCompare: typeof comparePin = async (pin, hash) => {
      await Promise.resolve();
      return comparePin(pin, hash);
    };
    const [a, b] = await Promise.all([run(db, yieldingCompare), run(db, yieldingCompare)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.approvalId).toBe(b.approvalId);
      expect(a.approvalId).toBe(deriveApprovalId('cmd-1'));
    }
    expect(calls).toHaveLength(2);
    const approvals = [...db.__store.keys()].filter((k) => k.startsWith('managerApprovals/'));
    expect(approvals).toHaveLength(1);
    expect(storeHasPin(db, PIN)).toBe(false);
  });

  test('verifier source keeps bcrypt outside runTransaction callbacks', () => {
    const shellSrc = readFileSync(resolve(__dirname, '../requestManagerApproval.ts'), 'utf8');
    expect(shellSrc.match(/await comparePin\(/g)?.length).toBe(1);
    const needle = 'runTransaction(async (tx) => {';
    const blocks: string[] = [];
    let from = 0;
    while (from < shellSrc.length) {
      const i = shellSrc.indexOf(needle, from);
      if (i < 0) break;
      let depth = 0;
      const open = i + needle.length - 1;
      for (let j = open; j < shellSrc.length; j++) {
        if (shellSrc[j] === '{') depth += 1;
        else if (shellSrc[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            blocks.push(shellSrc.slice(i, j + 1));
            from = j + 1;
            break;
          }
        }
      }
    }
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      expect(block).not.toMatch(/comparePin|bcrypt\.compare/);
    }
  });
});

describe('requestManagerApproval — authorization before bcrypt', () => {
  test('unauthenticated -> not_authorized, zero compares', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq(), null);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
  });

  test('staff role increments the counter and returns not_authorized with zero compares', async () => {
    const db = makeDb();
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq(), staff);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(calls).toHaveLength(0);
    expect(db.__store.get(`managerApprovalAttempts/${deriveAttemptScopeKey('B1', 's1')}`)).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  test('branch mismatch increments the counter and returns branch_mismatch with zero compares', async () => {
    const db = makeDb({
      'userCredentials/m3': {
        pinHash: REAL_HASH,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
    });
    const { calls, comparePin } = makeCompare();
    const res = await run(db, comparePin, baseReq(), otherBranch);
    expect(res).toEqual({ ok: false, code: 'branch_mismatch' });
    expect(calls).toHaveLength(0);
    expect(db.__store.get(`managerApprovalAttempts/${deriveAttemptScopeKey('B1', 'm3')}`)).toMatchObject({
      consecutiveFailures: 1,
    });
  });
});
