import { describe, test, expect, vi } from 'vitest';

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

import { performResolveShiftCloseAlert, type ResolveShiftCloseAlertRequest } from '../resolveShiftCloseAlert';
import { APPROVAL_SECURITY_MODEL_DELEGATED, deriveApprovalId, expectedActionFor } from '../requestManagerApprovalCore';

type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(
    Object.entries({
      'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
      'users/m1': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] },
      'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'] },
      'userCredentials/m1': {
        pinHash: '$2b$10$abcdefghijklmnopqrstuv',
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'userCredentials/a1': {
        pinHash: '$2b$10$abcdefghijklmnopqrstuv',
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
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return 1_700_000_000_000;
    return v;
  };
  function docRef(path: string): any {
    return {
      __doc: true,
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => {
        const data = store.get(path);
        return { exists: data !== undefined, id: path.slice(path.lastIndexOf('/') + 1), data: () => data };
      },
    };
  }
  function colRef(path: string): any {
    return { __col: true, path, doc: (id: string) => docRef(`${path}/${id}`) };
  }
  return {
    collection: (c: string) => colRef(c),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (x: any) => {
          const data = store.get(x.path);
          return { exists: data !== undefined, id: x.id, data: () => data };
        },
        set: (r: { path: string }, data: Doc) => {
          const next: Doc = {};
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(v);
          store.set(r.path, next);
        },
        update: (r: { path: string }, data: Doc) => {
          const existing = store.get(r.path) ?? {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(v);
          store.set(r.path, next);
        },
        create: (r: { path: string }, data: Doc) => {
          if (store.has(r.path)) throw new Error(`ALREADY_EXISTS: ${r.path}`);
          const next: Doc = {};
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(v);
          store.set(r.path, next);
        },
      };
      return fn(tx);
    },
    __store: store,
  };
}

const staffB1 = { uid: 'u3', token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0 } };

function delegatedApproval(over: Doc = {}): { id: string; data: Doc } {
  const commandId = (over.commandId as string) ?? 'cmd-d1';
  return {
    id: deriveApprovalId(commandId),
    data: {
      schemaVersion: 1,
      audience: 'resolveShiftCloseAlert',
      protectedAction: expectedActionFor('acknowledge'),
      targetEntityId: 'S1',
      branchId: 'B1',
      commandId,
      requesterStaffId: 's1',
      approverStaffId: 'm1',
      executorStaffId: 's1',
      approverRole: 'manager',
      securityModel: APPROVAL_SECURITY_MODEL_DELEGATED,
      authVersionAtIssue: 0,
      credentialVersionAtIssue: 1,
      approverAuthVersionAtIssue: 0,
      issuedAt: 1_700_000_000_000,
      expiresAt: { toMillis: () => Date.now() + 60_000 },
      consumedAt: null,
      consumedByStaffId: null,
      consumingAudience: null,
      consumedCaseVersion: null,
      ...over,
    },
  };
}

function seedDelegated(over: { approval?: Doc } = {}) {
  const approval = delegatedApproval(over.approval);
  return makeDb({
    'shiftCloseCases/S1': {
      shiftId: 'S1',
      branchId: 'B1',
      caseVersion: 5,
      alertState: 'open',
      settlementState: 'manual_review_required',
      selectedRunId: 'RUN1',
      leaseOwner: null,
      leaseExpiry: null,
    },
    'shiftCloseAlerts/S1': {
      shiftId: 'S1',
      branchId: 'B1',
      alertState: 'open',
      reasonCode: 'drawer_discrepancy',
      acknowledgedByActor: null,
      resolvedByActor: null,
      caseVersion: 5,
    },
    [`managerApprovals/${approval.id}`]: approval.data,
  });
}

const req = (over: Partial<ResolveShiftCloseAlertRequest> = {}): ResolveShiftCloseAlertRequest => {
  const commandId = String(over.commandId ?? 'cmd-d1');
  return {
    commandId,
    shiftId: 'S1',
    branchId: 'B1',
    expectedCaseVersion: 5,
    requestedOutcome: 'acknowledge',
    reasonCode: 'drawer_discrepancy',
    approvalId: deriveApprovalId(commandId),
    ...over,
    commandId,
    approvalId: over.approvalId ?? deriveApprovalId(commandId),
  };
};

function snapshot(db: ReturnType<typeof makeDb>) {
  return JSON.stringify([...db.__store.entries()]);
}

describe('resolveShiftCloseAlert Model 2 — consume', () => {
  test('staff consume names the approver on the alert and three distinct audit actors', async () => {
    const db = seedDelegated();
    const before = snapshot(db);
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: true, status: 'confirmed', newAlertState: 'acknowledged' });
    expect(db.__store.get('shiftCloseAlerts/S1')).toMatchObject({
      acknowledgedByActor: { kind: 'manager', managerUid: 'm1' },
    });
    const audit = [...db.__store.entries()].find(([p]) => p.startsWith('shiftCloseAuditEvents/'))?.[1] as Doc;
    expect(audit).toMatchObject({
      securityModel: APPROVAL_SECURITY_MODEL_DELEGATED,
      requesterStaffId: 's1',
      approverStaffId: 'm1',
      executorStaffId: 's1',
    });
    expect(db.__store.get(`managerApprovals/${deriveApprovalId('cmd-d1')}`)).toMatchObject({
      consumedByStaffId: 's1',
    });
    expect(before).not.toMatch(/"pin"/);
  });

  test('admin ALL approver consume is confirmed', async () => {
    const db = seedDelegated({
      approval: { approverStaffId: 'a1', approverRole: 'admin', approverAuthVersionAtIssue: 0 },
    });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res.ok).toBe(true);
    expect(db.__store.get('shiftCloseAlerts/S1')).toMatchObject({
      acknowledgedByActor: { kind: 'manager', managerUid: 'a1' },
    });
  });

  test('unknown securityModel fails closed with zero writes', async () => {
    const db = seedDelegated({ approval: { securityModel: 'break-glass' } });
    const before = snapshot(db);
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(snapshot(db)).toBe(before);
  });

  test('approver demoted between mint and consume is invalid_pin with zero writes', async () => {
    const db = seedDelegated();
    db.__store.set('users/m1', { ...db.__store.get('users/m1'), role: 'staff' });
    const before = snapshot(db);
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(snapshot(db)).toBe(before);
  });

  test('approver deactivated is invalid_pin', async () => {
    const db = seedDelegated();
    db.__store.set('users/m1', { ...db.__store.get('users/m1'), isActive: false });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(db.__store.get(`managerApprovals/${deriveApprovalId('cmd-d1')}`)?.consumedAt).toBeNull();
  });

  test('approver deleted is invalid_pin', async () => {
    const db = seedDelegated();
    db.__store.set('users/m1', { ...db.__store.get('users/m1'), deletedAt: 1 });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
  });

  test('approver authVersion bump is invalid_pin', async () => {
    const db = seedDelegated();
    db.__store.set('users/m1', { ...db.__store.get('users/m1'), authVersion: 9 });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
  });

  test('approver credential rotation is invalid_pin', async () => {
    const db = seedDelegated();
    db.__store.set('userCredentials/m1', { ...db.__store.get('userCredentials/m1'), credentialVersion: 99 });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
  });

  test('requester authVersion bump is unauthorized', async () => {
    const db = seedDelegated();
    db.__store.set('users/s1', { ...db.__store.get('users/s1'), authVersion: 9 });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
  });

  test('requester branch revoked is unauthorized', async () => {
    const db = seedDelegated();
    db.__store.set('users/s1', { ...db.__store.get('users/s1'), branchIds: ['B9'] });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
  });

  test('expired approval is invalid_pin', async () => {
    const db = seedDelegated({ approval: { expiresAt: { toMillis: () => Date.now() - 1 } } });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
  });

  test('consumed approval is invalid_pin', async () => {
    const db = seedDelegated({ approval: { consumedAt: 1 } });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
  });

  test('binding mismatch is invalid_pin', async () => {
    const db = seedDelegated({ approval: { protectedAction: expectedActionFor('resolve') } });
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
  });

  test('raw pin own-property is invalid_payload with zero writes', async () => {
    const db = seedDelegated();
    const before = snapshot(db);
    const res = await performResolveShiftCloseAlert(db as never, { ...req(), pin: undefined }, staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_payload' });
    expect(snapshot(db)).toBe(before);
  });

  test('staff requester with ALL is unauthorized at consume', async () => {
    const db = seedDelegated();
    db.__store.set('users/s1', { ...db.__store.get('users/s1'), branchIds: ['ALL'] });
    const staffAll = { uid: 'u3', token: { role: 'staff', staffId: 's1', branchIds: ['ALL'], authVersion: 0 } };
    const before = snapshot(db);
    const res = await performResolveShiftCloseAlert(db as never, req(), staffAll);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
    expect(snapshot(db)).toBe(before);
  });

  test('manager cannot consume a delegated approval', async () => {
    const db = seedDelegated();
    const mgr = { uid: 'u1', token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0 } };
    const before = snapshot(db);
    const res = await performResolveShiftCloseAlert(db as never, req(), mgr);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
    expect(snapshot(db)).toBe(before);
  });

  test('ledger-first duplicate is duplicate_confirmed without a second consume', async () => {
    const db = seedDelegated();
    const first = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(first.ok).toBe(true);
    const second = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(second).toMatchObject({ ok: true, status: 'duplicate_confirmed' });
  });
});
