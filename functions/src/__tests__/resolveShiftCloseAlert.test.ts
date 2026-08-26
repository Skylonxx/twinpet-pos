import { describe, test, expect, vi } from 'vitest';

// Mirrors resolveReversal.test.ts's mocking pattern (same conventions).
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
import { deriveApprovalId, expectedActionFor } from '../requestManagerApprovalCore';

// ── Fake Admin Firestore (paths, get/set/update/create) — extends the
// resolveReversal.test.ts pattern with tx.create (immutable audit events). ──
type Doc = Record<string, unknown>;
function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries({
    'users/m1': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] },
    'users/m2': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] },
    'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'] },
    'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
    'users/m3': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B2'] },
    'userCredentials/m1': {
      pinHash: '$2b$10$abcdefghijklmnopqrstuv',
      algo: 'bcrypt',
      cost: 10,
      credentialVersion: 1,
      credentialState: 'rotated_authoritative',
      disabled: false,
      updatedBy: 't',
    },
    'userCredentials/m2': {
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
    'userCredentials/m3': {
      pinHash: '$2b$10$abcdefghijklmnopqrstuv',
      algo: 'bcrypt',
      cost: 10,
      credentialVersion: 1,
      credentialState: 'rotated_authoritative',
      disabled: false,
      updatedBy: 't',
    },
    ...seed,
  }).map(([k, v]) => [k, { ...v }]));
  const resolveVal = (v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return 1_700_000_000_000;
    return v;
  };
  const reads: string[] = [];
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
  const db = {
    collection: (c: string) => colRef(c),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (x: any) => {
          reads.push(x.path);
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
    __reads: reads,
  };
  return db;
}

const mgrB1 = { uid: 'u1', token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0 } };
const mgrB1Second = { uid: 'u9', token: { role: 'manager', staffId: 'm2', branchIds: ['B1'], authVersion: 0 } };
const adminAll = { uid: 'u2', token: { role: 'admin', staffId: 'a1', branchIds: ['ALL'], authVersion: 0 } };
const staffB1 = { uid: 'u3', token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0 } };
const mgrOtherBranch = { uid: 'u4', token: { role: 'manager', staffId: 'm3', branchIds: ['B2'], authVersion: 0 } };

function approvalDoc(over: {
  commandId?: string;
  staffId?: string;
  branchId?: string;
  shiftId?: string;
  requestedOutcome?: 'acknowledge' | 'resolve';
  consumedAt?: unknown;
  expiresAtMs?: number;
  credentialVersionAtIssue?: number;
  authVersionAtIssue?: number;
} = {}): { id: string; data: Doc } {
  const commandId = over.commandId ?? 'cmd-1';
  const staffId = over.staffId ?? 'm1';
  const branchId = over.branchId ?? 'B1';
  const shiftId = over.shiftId ?? 'S1';
  const requestedOutcome = over.requestedOutcome ?? 'acknowledge';
  return {
    id: deriveApprovalId(commandId),
    data: {
      schemaVersion: 1,
      audience: 'resolveShiftCloseAlert',
      protectedAction: expectedActionFor(requestedOutcome),
      targetEntityId: shiftId,
      branchId,
      commandId,
      requesterStaffId: staffId,
      approverStaffId: staffId,
      executorStaffId: staffId,
      approverRole: 'manager',
      securityModel: 'reauth',
      authVersionAtIssue: over.authVersionAtIssue ?? 0,
      credentialVersionAtIssue: over.credentialVersionAtIssue ?? 1,
      issuedAt: 1_700_000_000_000,
      expiresAt: { toMillis: () => over.expiresAtMs ?? Date.now() + 60_000 },
      consumedAt: over.consumedAt ?? null,
      consumedByStaffId: null,
      consumingAudience: null,
      consumedCaseVersion: null,
    },
  };
}

function bindApproval(db: ReturnType<typeof makeDb>, over: Parameters<typeof approvalDoc>[0] = {}) {
  const { id, data } = approvalDoc(over);
  db.__store.set(`managerApprovals/${id}`, { ...data });
  return id;
}

function seedOpenCase(over: {
  caseVersion?: number;
  leaseOwner?: string | null;
  leaseExpiryMs?: number | null;
  settlementState?: string;
  requestedOutcome?: 'acknowledge' | 'resolve';
  staffId?: string;
  commandId?: string;
} = {}) {
  const approval = approvalDoc({
    requestedOutcome: over.requestedOutcome,
    staffId: over.staffId,
    commandId: over.commandId,
  });
  return makeDb({
    'shiftCloseCases/S1': {
      shiftId: 'S1',
      branchId: 'B1',
      caseVersion: over.caseVersion ?? 5,
      alertState: 'open',
      settlementState: over.settlementState ?? 'manual_review_required',
      selectedRunId: 'RUN1',
      leaseOwner: over.leaseOwner ?? null,
      leaseExpiry: over.leaseExpiryMs != null ? { toMillis: () => over.leaseExpiryMs } : null,
    },
    'shiftCloseAlerts/S1': {
      shiftId: 'S1',
      branchId: 'B1',
      alertState: 'open',
      reasonCode: 'drawer_discrepancy',
      acknowledgedByActor: null,
      resolvedByActor: null,
      caseVersion: over.caseVersion ?? 5,
    },
    [`managerApprovals/${approval.id}`]: approval.data,
  });
}

const req = (over: Partial<ResolveShiftCloseAlertRequest> = {}): ResolveShiftCloseAlertRequest => {
  const commandId = String(over.commandId ?? 'cmd-1');
  return {
    commandId,
    shiftId: 'S1',
    branchId: 'B1',
    expectedCaseVersion: 5,
    requestedOutcome: 'acknowledge',
    reasonCode: 'drawer_discrepancy',
    reasonNote: 'confirmed with staff',
    approvalId: deriveApprovalId(commandId),
    ...over,
    commandId,
    approvalId: over.approvalId ?? deriveApprovalId(String(over.commandId ?? commandId)),
  };
};

const auditDocs = (db: ReturnType<typeof makeDb>) => [...db.__store.entries()].filter(([p]) => /^shiftCloseAuditEvents\//.test(p));
const commandDocs = (db: ReturnType<typeof makeDb>) => [...db.__store.entries()].filter(([p]) => /^shiftCloseAdjudicationCommands\//.test(p));
const anyShiftsWrite = (db: ReturnType<typeof makeDb>) => [...db.__store.keys()].some((p) => p.startsWith('shifts/'));

describe('resolveShiftCloseAlert — happy paths', () => {
  test('acknowledge: open -> acknowledged, actor recorded, audit appended, caseVersion+1', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: true, status: 'confirmed', newAlertState: 'acknowledged' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ alertState: 'acknowledged', caseVersion: 6 });
    expect(db.__store.get('shiftCloseAlerts/S1')).toMatchObject({
      alertState: 'acknowledged',
      reasonCode: 'drawer_discrepancy', // preserved, NOT overwritten by request.reasonCode
      acknowledgedByActor: { kind: 'manager', managerUid: 'm1' },
      resolvedByActor: null,
      caseVersion: 6,
    });
    expect(auditDocs(db)).toHaveLength(1);
    expect(res.auditEventId).toBeTruthy();
  });

  test('resolve: open -> resolved, manual_review_required -> manually_resolved', async () => {
    const db = seedOpenCase({ requestedOutcome: 'resolve' });
    const res = await performResolveShiftCloseAlert(db as never, req({ requestedOutcome: 'resolve' }), mgrB1);
    expect(res).toMatchObject({ ok: true, status: 'confirmed', newAlertState: 'resolved', newSettlementState: 'manually_resolved' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ alertState: 'resolved', settlementState: 'manually_resolved' });
  });

  test('resolve preserves prior manager acknowledgement actor', async () => {
    const db = seedOpenCase({ requestedOutcome: 'resolve', staffId: 'm2' });
    db.__store.set('shiftCloseCases/S1', { ...db.__store.get('shiftCloseCases/S1'), alertState: 'acknowledged' });
    db.__store.set('shiftCloseAlerts/S1', {
      ...db.__store.get('shiftCloseAlerts/S1'),
      alertState: 'acknowledged',
      acknowledgedByActor: { kind: 'manager', managerUid: 'm-first' },
    });
    const res = await performResolveShiftCloseAlert(db as never, req({ requestedOutcome: 'resolve' }), mgrB1Second);
    expect(res.ok).toBe(true);
    expect(db.__store.get('shiftCloseAlerts/S1')).toMatchObject({
      acknowledgedByActor: { kind: 'manager', managerUid: 'm-first' },
      resolvedByActor: { kind: 'manager', managerUid: 'm2' },
    });
  });

  test('admin (branchIds: ALL) can adjudicate any branch', async () => {
    const db = seedOpenCase({ staffId: 'a1' });
    const res = await performResolveShiftCloseAlert(db as never, req(), adminAll);
    expect(res.ok).toBe(true);
  });
});

describe('resolveShiftCloseAlert — unauthorized', () => {
  test('no auth -> unauthorized', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req(), null);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
  });

  test('staff role -> unauthorized (no PIN path)', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req(), staffB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
  });

  test('manager without branch access -> unauthorized', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrOtherBranch);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
  });

  test('cross-branch request (case.branchId !== req.branchId) -> unauthorized', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req({ branchId: 'B2' }), { uid: 'u9', token: { role: 'manager', staffId: 'm9', branchIds: ['B2'] } });
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
  });
});

describe('resolveShiftCloseAlert — payload / not-found / transition', () => {
  test('invalid payload -> invalid_payload, zero writes', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req({ reasonCode: 'not_real' }), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_payload' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 5 });
  });

  test('case not found -> case_not_found', async () => {
    const db = makeDb({});
    bindApproval(db);
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'case_not_found' });
  });

  test('missing alert doc -> alert_not_open, zero writes', async () => {
    const db = seedOpenCase();
    db.__store.delete('shiftCloseAlerts/S1');
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'alert_not_open' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 5 });
  });

  test('invalid outcome transition (acknowledge already-acknowledged) -> invalid_outcome_transition, zero writes', async () => {
    const db = seedOpenCase();
    db.__store.set('shiftCloseCases/S1', { ...db.__store.get('shiftCloseCases/S1'), alertState: 'acknowledged' });
    db.__store.set('shiftCloseAlerts/S1', { ...db.__store.get('shiftCloseAlerts/S1'), alertState: 'acknowledged', acknowledgedByActor: { kind: 'manager', managerUid: 'm1' } });
    const res = await performResolveShiftCloseAlert(db as never, req({ requestedOutcome: 'acknowledge' }), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_outcome_transition' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 5 });
  });
});

describe('resolveShiftCloseAlert — CAS / lease', () => {
  test('stale expectedCaseVersion -> conflict, zero writes', async () => {
    const db = seedOpenCase({ caseVersion: 7 });
    const res = await performResolveShiftCloseAlert(db as never, req({ expectedCaseVersion: 5 }), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'stale_case_version', status: 'conflict_requires_manual_review' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 7 });
  });

  test('live (non-expired) worker lease -> conflict_requires_manual_review, zero writes', async () => {
    const db = seedOpenCase({ leaseOwner: 'worker-inv-1', leaseExpiryMs: Date.now() + 60_000 });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, status: 'conflict_requires_manual_review' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 5, alertState: 'open' });
    expect(auditDocs(db)).toHaveLength(0);
  });

  test('expired lease proceeds normally', async () => {
    const db = seedOpenCase({ leaseOwner: 'worker-inv-1', leaseExpiryMs: Date.now() - 60_000 });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res.ok).toBe(true);
  });
});

describe('resolveShiftCloseAlert — idempotency', () => {
  test('same commandId + same payload -> duplicate_confirmed, no second mutation/audit', async () => {
    const db = seedOpenCase();
    const r1 = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    const r2 = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(r2.status).toBe('duplicate_confirmed');
    expect(r2.auditEventId).toBe(r1.auditEventId);
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 6 }); // not bumped twice
    expect(auditDocs(db)).toHaveLength(1);
    expect(commandDocs(db)).toHaveLength(1);
  });

  test('same commandId + DIFFERENT payload -> conflict, no mutation, no audit overwrite', async () => {
    const db = seedOpenCase();
    const r1 = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    const auditBefore = JSON.stringify(db.__store.get(`shiftCloseAuditEvents/${r1.auditEventId}`));
    const res = await performResolveShiftCloseAlert(db as never, req({ requestedOutcome: 'resolve' }), mgrB1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('conflict_requires_manual_review');
    expect(res.rejectCode).toBe('invalid_payload');
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 6 }); // unchanged from first confirm
    expect(JSON.stringify(db.__store.get(`shiftCloseAuditEvents/${r1.auditEventId}`))).toBe(auditBefore);
  });

  test('a different commandId is keyed independently — a second logically-different command against the resulting state gets its own audit event', async () => {
    const db = seedOpenCase({ commandId: 'cmd-a' });
    const r1 = await performResolveShiftCloseAlert(db as never, req({ commandId: 'cmd-a' }), mgrB1);
    expect(r1.status).toBe('confirmed');
    bindApproval(db, { commandId: 'cmd-b', requestedOutcome: 'resolve', staffId: 'm1' });
    const r2 = await performResolveShiftCloseAlert(db as never, req({ commandId: 'cmd-b', requestedOutcome: 'resolve', expectedCaseVersion: 6 }), mgrB1);
    expect(r2.status).toBe('confirmed');
    expect(r2.auditEventId).not.toBe(r1.auditEventId);
    expect(commandDocs(db)).toHaveLength(2);
  });
});

describe('resolveShiftCloseAlert — red-zone / audit shape', () => {
  test('never writes any shifts/* document', async () => {
    const db = seedOpenCase();
    await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    bindApproval(db, { commandId: 'cmd-2', requestedOutcome: 'resolve' });
    await performResolveShiftCloseAlert(db as never, req({ commandId: 'cmd-2', requestedOutcome: 'resolve' }), mgrB1);
    expect(anyShiftsWrite(db)).toBe(false);
  });

  test('audit event carries the manager actor, reasonCode, and note; commandId recorded', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req({ reasonNote: 'double-checked drawer' }), mgrB1);
    const audit = db.__store.get(`shiftCloseAuditEvents/${res.auditEventId}`) as Record<string, unknown>;
    expect(audit).toMatchObject({
      shiftId: 'S1',
      transitionType: 'adjudication_acknowledge',
      actor: { kind: 'manager', managerUid: 'm1' },
      reasonCode: 'drawer_discrepancy',
      note: 'double-checked drawer',
      branchId: 'B1',
      pinVerifiedAtServer: 1_700_000_000_000,
      commandId: 'cmd-1',
    });
  });

  test('deterministic audit event id — computed the same way for the same inputs', async () => {
    const dbA = seedOpenCase();
    const dbB = seedOpenCase();
    const resA = await performResolveShiftCloseAlert(dbA as never, req(), mgrB1);
    const resB = await performResolveShiftCloseAlert(dbB as never, req(), mgrB1);
    expect(resA.auditEventId).toBe(resB.auditEventId);
  });
});

describe('resolveShiftCloseAlert — Packet 2A approval consume', () => {
  test('old client missing approvalId fails closed with invalid_payload', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req({ approvalId: '' }), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_payload' });
  });

  test('present pin is hard-rejected as invalid_payload and never persisted', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req({ pin: '9999' }), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_payload' });
    expect(JSON.stringify([...db.__store.entries()])).not.toContain('9999');
  });

  test.each([
    ['undefined', { pin: undefined }],
    ['null', { pin: null as unknown as string }],
    ['empty string', { pin: '' }],
    ['value', { pin: '1234' }],
  ])('own pin property (%s) is invalid_payload at the shell', async (_label, over) => {
    const db = seedOpenCase();
    const payload = req(over);
    expect(Object.prototype.hasOwnProperty.call(payload, 'pin')).toBe(true);
    const res = await performResolveShiftCloseAlert(db as never, payload, mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_payload' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 5, alertState: 'open' });
  });

  test('ledger duplicate short-circuits without reading or consuming the approval', async () => {
    const db = seedOpenCase();
    const r1 = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(r1.status).toBe('confirmed');
    db.__reads.length = 0;
    const r2 = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(r2.status).toBe('duplicate_confirmed');
    expect(db.__reads.some((p) => p.startsWith('managerApprovals/'))).toBe(false);
    const approvalId = deriveApprovalId('cmd-1');
    expect(db.__store.get(`managerApprovals/${approvalId}`)).toMatchObject({ consumedAt: 1_700_000_000_000 });
  });

  test('missing approval gives invalid_pin with zero case writes', async () => {
    const db = seedOpenCase();
    db.__store.delete(`managerApprovals/${deriveApprovalId('cmd-1')}`);
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 5, alertState: 'open' });
  });

  test('expired approval gives invalid_pin and leaves the approval unconsumed', async () => {
    const db = seedOpenCase();
    bindApproval(db, { expiresAtMs: Date.now() - 1_000 });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(db.__store.get(`managerApprovals/${deriveApprovalId('cmd-1')}`)?.consumedAt).toBeNull();
  });

  test('consumed approval gives invalid_pin with zero writes', async () => {
    const db = seedOpenCase();
    bindApproval(db, { consumedAt: 1 });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 5 });
  });

  test('mis-bound approval (action) gives invalid_pin', async () => {
    const db = seedOpenCase({ requestedOutcome: 'resolve' });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
  });

  test('disabled live user in-transaction gives unauthorized and leaves approval unconsumed', async () => {
    const db = seedOpenCase();
    db.__store.set('users/m1', { ...db.__store.get('users/m1'), isActive: false });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
    expect(db.__store.get(`managerApprovals/${deriveApprovalId('cmd-1')}`)?.consumedAt).toBeNull();
  });

  test('stale authVersion in-transaction gives unauthorized and leaves approval unconsumed', async () => {
    const db = seedOpenCase();
    db.__store.set('users/m1', { ...db.__store.get('users/m1'), authVersion: 9 });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'unauthorized' });
    expect(db.__store.get(`managerApprovals/${deriveApprovalId('cmd-1')}`)?.consumedAt).toBeNull();
  });

  test('credential rotated between mint and consume gives invalid_pin', async () => {
    const db = seedOpenCase();
    db.__store.set('userCredentials/m1', { ...db.__store.get('userCredentials/m1'), credentialVersion: 99 });
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(db.__store.get(`managerApprovals/${deriveApprovalId('cmd-1')}`)?.consumedAt).toBeNull();
  });

  test('happy path consumes approval in the same transaction as case/alert/audit/ledger', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(res.ok).toBe(true);
    const approvalId = deriveApprovalId('cmd-1');
    expect(db.__store.get(`managerApprovals/${approvalId}`)).toMatchObject({
      consumedByStaffId: 'm1',
      consumingAudience: 'resolveShiftCloseAlert',
      consumedCaseVersion: 6,
    });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ caseVersion: 6 });
    const audit = db.__store.get(`shiftCloseAuditEvents/${res.auditEventId}`) as Record<string, unknown>;
    expect(audit).toMatchObject({
      pinVerifiedAtServer: 1_700_000_000_000,
      approvalId,
      securityModel: 'reauth',
      requesterStaffId: 'm1',
      approverStaffId: 'm1',
      executorStaffId: 'm1',
    });
  });

  test('CAS replay: a second consume of the same approval is invalid_pin', async () => {
    const db = seedOpenCase();
    const r1 = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(r1.ok).toBe(true);
    db.__store.delete([...commandDocs(db)][0]![0]);
    const r2 = await performResolveShiftCloseAlert(db as never, req(), mgrB1);
    expect(r2).toMatchObject({ ok: false, rejectCode: 'invalid_pin' });
    expect(auditDocs(db)).toHaveLength(1);
  });

  test('a case-guard rejection leaves the approval unconsumed', async () => {
    const db = seedOpenCase({ caseVersion: 7 });
    const res = await performResolveShiftCloseAlert(db as never, req({ expectedCaseVersion: 5 }), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'stale_case_version' });
    expect(db.__store.get(`managerApprovals/${deriveApprovalId('cmd-1')}`)?.consumedAt).toBeNull();
  });
});

describe('resolveShiftCloseAlert — server error mapping', () => {
  test('unexpected throw maps to structured server_error, no partial writes visible', async () => {
    const db = seedOpenCase();
    const throwingDb = {
      collection: db.collection.bind(db),
      runTransaction: async () => {
        throw new Error('boom');
      },
    };
    const res = await performResolveShiftCloseAlert(throwingDb as never, req(), mgrB1);
    expect(res).toMatchObject({ ok: false, rejectCode: 'server_error' });
  });
});
