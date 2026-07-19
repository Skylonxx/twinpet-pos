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

// ── Fake Admin Firestore (paths, get/set/update/create) — extends the
// resolveReversal.test.ts pattern with tx.create (immutable audit events). ──
type Doc = Record<string, unknown>;
function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const resolveVal = (v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return 1_700_000_000_000;
    return v;
  };
  function docRef(path: string): any {
    return { __doc: true, path, id: path.slice(path.lastIndexOf('/') + 1) };
  }
  function colRef(path: string): any {
    return { __col: true, path, doc: (id: string) => docRef(`${path}/${id}`) };
  }
  const db = {
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
  return db;
}

const mgrB1 = { uid: 'u1', token: { role: 'manager', staffId: 'm1', branchIds: ['B1'] } };
const mgrB1Second = { uid: 'u9', token: { role: 'manager', staffId: 'm2', branchIds: ['B1'] } };
const adminAll = { uid: 'u2', token: { role: 'admin', staffId: 'a1', branchIds: ['ALL'] } };
const staffB1 = { uid: 'u3', token: { role: 'staff', staffId: 's1', branchIds: ['B1'] } };
const mgrOtherBranch = { uid: 'u4', token: { role: 'manager', staffId: 'm3', branchIds: ['B2'] } };

function seedOpenCase(over: { caseVersion?: number; leaseOwner?: string | null; leaseExpiryMs?: number | null; settlementState?: string } = {}) {
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
  });
}

const req = (over: Partial<ResolveShiftCloseAlertRequest> = {}): ResolveShiftCloseAlertRequest => ({
  commandId: 'cmd-1',
  shiftId: 'S1',
  branchId: 'B1',
  expectedCaseVersion: 5,
  requestedOutcome: 'acknowledge',
  reasonCode: 'drawer_discrepancy',
  reasonNote: 'confirmed with staff',
  ...over,
});

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
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req({ requestedOutcome: 'resolve' }), mgrB1);
    expect(res).toMatchObject({ ok: true, status: 'confirmed', newAlertState: 'resolved', newSettlementState: 'manually_resolved' });
    expect(db.__store.get('shiftCloseCases/S1')).toMatchObject({ alertState: 'resolved', settlementState: 'manually_resolved' });
  });

  test('resolve preserves prior manager acknowledgement actor', async () => {
    const db = seedOpenCase();
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
    const db = seedOpenCase();
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
    const db = seedOpenCase();
    const r1 = await performResolveShiftCloseAlert(db as never, req({ commandId: 'cmd-a' }), mgrB1);
    expect(r1.status).toBe('confirmed');
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
      pinVerifiedAtServer: null,
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

describe('resolveShiftCloseAlert — D5 Option C (PIN optional, never persisted)', () => {
  test('succeeds with no pin supplied', async () => {
    const db = seedOpenCase();
    const res = await performResolveShiftCloseAlert(db as never, req({ pin: undefined }), mgrB1);
    expect(res.ok).toBe(true);
  });

  test('succeeds identically whether or not a pin is supplied — never verified, never persisted', async () => {
    const dbNoPin = seedOpenCase();
    const dbWithPin = seedOpenCase();
    const resNoPin = await performResolveShiftCloseAlert(dbNoPin as never, req({ pin: undefined }), mgrB1);
    const resWithPin = await performResolveShiftCloseAlert(dbWithPin as never, req({ pin: '9999' }), mgrB1);
    expect(resNoPin.ok).toBe(true);
    expect(resWithPin.ok).toBe(true);
    const commandDoc = commandDocs(dbWithPin)[0]?.[1] as Record<string, unknown>;
    const auditDoc = auditDocs(dbWithPin)[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(commandDoc)).not.toContain('9999');
    expect(JSON.stringify(auditDoc)).not.toContain('9999');
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
