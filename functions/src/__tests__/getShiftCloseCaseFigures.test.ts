/**
 * getShiftCloseCaseFigures.test.ts — Packet 5 / UI-B2 / Packet S, file #4.
 *
 * Two independent proof layers:
 *  (1) Behavioral/integration tests against the REAL shipped shell using an
 *      in-memory fake Firestore: read order/count, the 27-row decision
 *      table, the global zero-write proof, the no-query proof, and the
 *      sensitive-log absence proof.
 *  (2) A syntax-only AST static guard (rules S1-S9 + RCQ-IP-09) run against a
 *      frozen string-constant copy of the shell module (`SHELL_BASELINE_V3`)
 *      plus a mutation/positive-fixture matrix.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { HttpsError } from 'firebase-functions/v2/https';
import { performGetShiftCloseCaseFigures } from '../getShiftCloseCaseFigures';

// ============================================================================
// PART A — behavioral/integration tests against the real shipped shell
// ============================================================================

type StoredDoc = Record<string, unknown>;

interface QueryCallRecord {
  op: string;
}

class FakeDocRef {
  constructor(
    private readonly ff: FakeFirestore,
    public readonly collectionName: string,
    public readonly id: string,
  ) {}

  async get() {
    this.ff.reads.push({ collection: this.collectionName, id: this.id });
    const data = this.ff.store.get(this.collectionName)?.get(this.id);
    return { id: this.id, exists: data !== undefined, data: () => data };
  }

  async set(_data: unknown) {
    this.ff.noteWrite(this.collectionName, 'set');
  }
  async update(_data: unknown) {
    this.ff.noteWrite(this.collectionName, 'update');
  }
  async delete() {
    this.ff.noteWrite(this.collectionName, 'delete');
  }
  async create(_data: unknown) {
    this.ff.noteWrite(this.collectionName, 'create');
  }
}

class FakeCollectionRef {
  constructor(
    private readonly ff: FakeFirestore,
    private readonly name: string,
  ) {}
  doc(id: string) {
    return new FakeDocRef(this.ff, this.name, id);
  }
  async add(_data: unknown) {
    this.ff.noteWrite(this.name, 'add');
    return new FakeDocRef(this.ff, this.name, 'generated');
  }
  where(...args: unknown[]) {
    this.ff.queryOps.push({ op: 'where' });
    return this;
  }
  orderBy(...args: unknown[]) {
    this.ff.queryOps.push({ op: 'orderBy' });
    return this;
  }
  limit(...args: unknown[]) {
    this.ff.queryOps.push({ op: 'limit' });
    return this;
  }
  startAt(...args: unknown[]) {
    this.ff.queryOps.push({ op: 'startAt' });
    return this;
  }
  startAfter(...args: unknown[]) {
    this.ff.queryOps.push({ op: 'startAfter' });
    return this;
  }
  endAt(...args: unknown[]) {
    this.ff.queryOps.push({ op: 'endAt' });
    return this;
  }
  endBefore(...args: unknown[]) {
    this.ff.queryOps.push({ op: 'endBefore' });
    return this;
  }
  async get() {
    this.ff.queryOps.push({ op: 'collection.get' });
    return { docs: [], empty: true, size: 0 };
  }
}

class FakeFirestore {
  store = new Map<string, Map<string, StoredDoc>>();
  reads: { collection: string; id: string }[] = [];
  writesByCollection = new Map<string, number>();
  totalWrites = 0;
  queryOps: QueryCallRecord[] = [];
  runTransactionCalls = 0;
  batchCalls = 0;
  bulkWriterCalls = 0;

  collection(name: string) {
    return new FakeCollectionRef(this, name);
  }
  collectionGroup(name: string) {
    this.queryOps.push({ op: 'collectionGroup' });
    return new FakeCollectionRef(this, name);
  }
  batch() {
    this.batchCalls += 1;
    return { set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} };
  }
  bulkWriter() {
    this.bulkWriterCalls += 1;
    return { set: () => {}, update: () => {}, delete: () => {}, close: async () => {} };
  }
  async runTransaction(fn: (tx: unknown) => Promise<unknown>) {
    this.runTransactionCalls += 1;
    return fn({ get: async () => undefined, set: () => {}, update: () => {}, create: () => {}, delete: () => {} });
  }

  noteWrite(collection: string, _kind: string) {
    this.totalWrites += 1;
    this.writesByCollection.set(collection, (this.writesByCollection.get(collection) ?? 0) + 1);
  }

  seed(collection: string, id: string, data: StoredDoc) {
    if (!this.store.has(collection)) this.store.set(collection, new Map());
    this.store.get(collection)!.set(id, data);
  }
}

const KNOWN_COLLECTIONS = [
  'shiftCloseCases', 'shiftCloseAlerts', 'shiftCloseValidationRuns', 'shiftCloseEvidence',
  'shiftCloseAuditEvents', 'shiftCloseAdjudicationCommands', 'shiftCloseSweepCursor', 'shifts',
];

function branchId() {
  return 'LDP-001';
}

function validCaseDoc(overrides: StoredDoc = {}): StoredDoc {
  return {
    branchId: branchId(),
    shiftId: 'SHIFT-1',
    caseVersion: 1,
    schemaVersion: 1,
    processingState: 'validated',
    settlementState: 'unsettled',
    alertState: 'none',
    selectedRunId: 'RUN-1',
    selectedCloseHash: 'HASH-1',
    latestEvidenceId: 'SHOULD-NEVER-BE-READ',
    latestCloseHash: 'SHOULD-NEVER-BE-READ',
    ...overrides,
  };
}

function validRunDoc(overrides: StoredDoc = {}): StoredDoc {
  return {
    runId: 'RUN-1',
    shiftId: 'SHIFT-1',
    branchId: branchId(),
    closeHash: 'HASH-1',
    evidenceId: 'SHIFT-1_HASH-1',
    schemaVersion: 1,
    validationSchemaVersion: 1,
    validationVerdict: 'match',
    serverComputedDrawer: { expectedCashMinor: 100 },
    perFieldDeltas: { expectedCashMinor: 0 },
    ...overrides,
  };
}

function validEvidenceDoc(overrides: StoredDoc = {}): StoredDoc {
  return {
    evidenceId: 'SHIFT-1_HASH-1',
    shiftId: 'SHIFT-1',
    branchId: branchId(),
    closeHash: 'HASH-1',
    schemaVersion: 1,
    expectedCash: 100,
    actualCashCount: 100,
    variance: 0,
    note: 'SHOULD-NEVER-BE-READ-OR-LOGGED',
    cashEntriesSnapshot: { SHOULD_NEVER: 'BE-READ' },
    ...overrides,
  };
}

function managerAuth(overrides: Record<string, unknown> = {}) {
  return { token: { staffId: 'STAFF-1', role: 'manager', branchIds: [branchId()], ...overrides } };
}

const validRequest = { branchId: branchId(), shiftId: 'SHIFT-1', expectedCaseVersion: 1 };

function seedFullChain(ff: FakeFirestore) {
  ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
  ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc());
  ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc());
}

describe('Shell — request/auth validation (K1 invalid-argument, zero reads)', () => {
  test.each([
    ['non-object', 42],
    ['missing keys', { branchId: branchId() }],
    ['extra key', { ...validRequest, evidenceId: 'x' }],
    ['branchId ALL', { ...validRequest, branchId: 'ALL' }],
    ['expectedCaseVersion negative', { ...validRequest, expectedCaseVersion: -1 }],
  ])('%s -> HttpsError invalid-argument, zero reads', async (_label, rawRequest) => {
    const ff = new FakeFirestore();
    await expect(
      performGetShiftCloseCaseFigures(ff as never, rawRequest, managerAuth()),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ff.reads.length).toBe(0);
  });
});

describe('Shell — authorization (zero reads on denial)', () => {
  test('unauthenticated -> unauthorized, zero reads', async () => {
    const ff = new FakeFirestore();
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, null);
    expect(response).toEqual({ status: 'unauthorized' });
    expect(ff.reads.length).toBe(0);
  });
  test('staff role -> unauthorized, zero reads', async () => {
    const ff = new FakeFirestore();
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth({ role: 'staff' }));
    expect(response).toEqual({ status: 'unauthorized' });
    expect(ff.reads.length).toBe(0);
  });
  test('manager other branch -> unauthorized, zero reads', async () => {
    const ff = new FakeFirestore();
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth({ branchIds: ['OTHER'] }));
    expect(response).toEqual({ status: 'unauthorized' });
    expect(ff.reads.length).toBe(0);
  });
  test('branch-restricted admin cross-branch -> unauthorized (the frozen divergence)', async () => {
    const ff = new FakeFirestore();
    const response = await performGetShiftCloseCaseFigures(
      ff as never,
      validRequest,
      managerAuth({ role: 'admin', branchIds: ['OTHER-BRANCH'] }),
    );
    expect(response).toEqual({ status: 'unauthorized' });
    expect(ff.reads.length).toBe(0);
  });
  test('admin with branchIds [ALL] -> proceeds', async () => {
    const ff = new FakeFirestore();
    seedFullChain(ff);
    const response = await performGetShiftCloseCaseFigures(
      ff as never,
      validRequest,
      managerAuth({ role: 'admin', branchIds: ['ALL'] }),
    );
    expect(response.status).toBe('ok');
  });
});

describe('Shell — the 27-row decision table: exact status, exact read count, exact read order', () => {
  test('case not found -> case_not_found, exactly 1 read', async () => {
    const ff = new FakeFirestore();
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'case_not_found' });
    expect(ff.reads).toEqual([{ collection: 'shiftCloseCases', id: 'SHIFT-1' }]);
  });

  test('stale case version -> stale_case_version, exactly 1 read', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ caseVersion: 99 }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'stale_case_version' });
    expect(ff.reads.length).toBe(1);
  });

  test('case branch mismatch -> unauthorized, exactly 1 read', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ branchId: 'OTHER' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unauthorized' });
    expect(ff.reads.length).toBe(1);
  });

  test('unsupported case state -> unsupported_case_state, exactly 1 read', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ processingState: 'nope' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unsupported_case_state' });
    expect(ff.reads.length).toBe(1);
  });

  test('provisional_no_selected_run -> exactly 1 read (no run/evidence read)', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: null, selectedCloseHash: null }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'provisional_no_selected_run' });
    expect(ff.reads).toEqual([{ collection: 'shiftCloseCases', id: 'SHIFT-1' }]);
  });

  test('case schema violation -> unavailable_data_anomaly', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ schemaVersion: 2 }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test('selected run dangling (missing doc) -> unavailable_data_anomaly, exactly 2 reads', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
    expect(ff.reads).toEqual([
      { collection: 'shiftCloseCases', id: 'SHIFT-1' },
      { collection: 'shiftCloseValidationRuns', id: 'RUN-1' },
    ]);
  });

  test('run branch mismatch -> unavailable_data_anomaly, exactly 2 reads', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ branchId: 'OTHER' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
    expect(ff.reads.length).toBe(2);
  });

  test('run close-hash mismatch -> unavailable_data_anomaly', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ closeHash: 'WRONG' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test('run schema violation -> unavailable_data_anomaly', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ validationSchemaVersion: 2 }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test('run evidenceId malformed -> unavailable_data_anomaly', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ evidenceId: 'WRONG-ID' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test('evidence missing (dangling) -> unavailable_data_anomaly, exactly 3 reads', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc());
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
    expect(ff.reads).toEqual([
      { collection: 'shiftCloseCases', id: 'SHIFT-1' },
      { collection: 'shiftCloseValidationRuns', id: 'RUN-1' },
      { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' },
    ]);
  });

  test('evidence branch mismatch -> unavailable_data_anomaly, exactly 3 reads', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc());
    ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc({ branchId: 'OTHER' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
    expect(ff.reads.length).toBe(3);
  });

  test('evidence non-finite money -> unavailable_data_anomaly', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc());
    ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc({ expectedCash: NaN }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test('valid selected chain -> ok, exactly 3 reads in the frozen order, exactly 6 figure keys + status', async () => {
    const ff = new FakeFirestore();
    seedFullChain(ff);
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({
      status: 'ok',
      reportedExpectedCashBaht: 100,
      reportedActualCashCountBaht: 100,
      reportedVarianceBaht: 0,
      serverExpectedCashMinor: 100,
      serverExpectedCashDeltaMinor: 0,
      validationVerdict: 'match',
    });
    expect(ff.reads).toEqual([
      { collection: 'shiftCloseCases', id: 'SHIFT-1' },
      { collection: 'shiftCloseValidationRuns', id: 'RUN-1' },
      { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' },
    ]);
    expect(Object.keys(response).length).toBe(7);
  });
});

// RC-PS-final: the canonical, individually-mapped 25-business-union +
// 2-callable-error decision table. Every business row asserts (1) exact
// status, (2) exact sorted response key set, (3) exact read count, (4) exact
// read sequence (collection+id, in the frozen shiftCloseCases ->
// shiftCloseValidationRuns -> shiftCloseEvidence order), and (5) presence/
// absence of every figure key via hasOwnProperty. This table subsumes (and is
// cross-checked against) the individual scenario tests above and the
// selected-run-only / J11-read-boundary describes below.
const FIGURE_KEYS = [
  'reportedExpectedCashBaht', 'reportedActualCashCountBaht', 'reportedVarianceBaht',
  'serverExpectedCashMinor', 'serverExpectedCashDeltaMinor', 'validationVerdict',
] as const;

interface DecisionRow {
  id: string;
  label: string;
  request?: unknown;
  auth?: unknown;
  seed?: (ff: FakeFirestore) => void;
  expectedStatus: string;
  expectedReads: { collection: string; id: string }[];
}

const BUSINESS_UNION_ROWS: DecisionRow[] = [
  { id: 'BU-01', label: 'unauthenticated -> unauthorized', auth: null, expectedStatus: 'unauthorized', expectedReads: [] },
  { id: 'BU-02', label: 'staff role denied -> unauthorized', auth: managerAuth({ role: 'staff' }), expectedStatus: 'unauthorized', expectedReads: [] },
  { id: 'BU-03', label: 'manager other branch denied -> unauthorized', auth: managerAuth({ branchIds: ['OTHER'] }), expectedStatus: 'unauthorized', expectedReads: [] },
  { id: 'BU-04', label: 'branch-restricted admin cross-branch denied -> unauthorized', auth: managerAuth({ role: 'admin', branchIds: ['OTHER-BRANCH'] }), expectedStatus: 'unauthorized', expectedReads: [] },
  { id: 'BU-05', label: 'case not found -> case_not_found', expectedStatus: 'case_not_found', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-06', label: 'stale case version -> stale_case_version', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ caseVersion: 99 })), expectedStatus: 'stale_case_version', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-07', label: 'case branch mismatch -> unauthorized', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ branchId: 'OTHER' })), expectedStatus: 'unauthorized', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-08', label: 'unsupported case state -> unsupported_case_state', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ processingState: 'nope' })), expectedStatus: 'unsupported_case_state', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-09', label: 'provisional no selected run -> provisional_no_selected_run', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: null, selectedCloseHash: null })), expectedStatus: 'provisional_no_selected_run', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-10', label: 'selectedRunId whitespace-only -> unavailable_data_anomaly (J11)', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: '   ', selectedCloseHash: 'HASH-1' })), expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-11', label: 'selectedCloseHash whitespace-only -> unavailable_data_anomaly (J11)', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: 'RUN-1', selectedCloseHash: '   ' })), expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-12', label: 'case schema violation -> unavailable_data_anomaly', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ schemaVersion: 2 })), expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }] },
  { id: 'BU-13', label: 'selected run dangling -> unavailable_data_anomaly', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()), expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }] },
  {
    id: 'BU-14', label: 'run branch mismatch -> unavailable_data_anomaly',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ branchId: 'OTHER' })); },
    expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }],
  },
  {
    id: 'BU-15', label: 'run close-hash mismatch -> unavailable_data_anomaly',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ closeHash: 'WRONG' })); },
    expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }],
  },
  {
    id: 'BU-16', label: 'run schema violation -> unavailable_data_anomaly',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ validationSchemaVersion: 2 })); },
    expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }],
  },
  {
    id: 'BU-17', label: 'run evidenceId malformed -> unavailable_data_anomaly',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ evidenceId: 'WRONG-ID' })); },
    expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }],
  },
  {
    id: 'BU-18', label: 'evidence missing (dangling) -> unavailable_data_anomaly',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc()); },
    expectedStatus: 'unavailable_data_anomaly',
    expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }, { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' }],
  },
  {
    id: 'BU-19', label: 'evidence branch mismatch -> unavailable_data_anomaly',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc()); ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc({ branchId: 'OTHER' })); },
    expectedStatus: 'unavailable_data_anomaly',
    expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }, { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' }],
  },
  {
    id: 'BU-20', label: 'evidence non-finite money -> unavailable_data_anomaly',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc()); ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc({ expectedCash: NaN })); },
    expectedStatus: 'unavailable_data_anomaly',
    expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }, { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' }],
  },
  {
    id: 'BU-21', label: 'valid selected chain -> ok',
    seed: seedFullChain, expectedStatus: 'ok',
    expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }, { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' }],
  },
  {
    id: 'BU-22', label: 'admin with branchIds [ALL] -> ok (wildcard authority)',
    auth: managerAuth({ role: 'admin', branchIds: ['ALL'] }), seed: seedFullChain, expectedStatus: 'ok',
    expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }, { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' }],
  },
  {
    id: 'BU-23', label: 'selectedRunId surrounding whitespace preserved byte-for-byte -> ok',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: '  RUN-1  ', selectedCloseHash: 'HASH-1' }));
      ff.seed('shiftCloseValidationRuns', '  RUN-1  ', validRunDoc({ runId: '  RUN-1  ' }));
      ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc());
    },
    expectedStatus: 'ok',
    expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: '  RUN-1  ' }, { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' }],
  },
  {
    id: 'BU-24', label: 'selectedRunId null but a decoy latestEvidenceId doc exists (selected-run-only) -> provisional_no_selected_run',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: null, selectedCloseHash: null })); ff.seed('shiftCloseEvidence', 'SHOULD-NEVER-BE-READ', validEvidenceDoc()); },
    expectedStatus: 'provisional_no_selected_run', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }],
  },
  {
    id: 'BU-25', label: 'selected run dangling with decoy latestEvidenceId doc present (selected-run-only) -> unavailable_data_anomaly, decoy never read',
    seed: (ff) => { ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()); ff.seed('shiftCloseEvidence', 'SHOULD-NEVER-BE-READ', validEvidenceDoc()); },
    expectedStatus: 'unavailable_data_anomaly', expectedReads: [{ collection: 'shiftCloseCases', id: 'SHIFT-1' }, { collection: 'shiftCloseValidationRuns', id: 'RUN-1' }],
  },
];

describe('Shell — the exact 25+2 decision table (RC-PS-final): status, keys, read count, read order', () => {
  test.each(BUSINESS_UNION_ROWS.map((r) => [r.id, r] as const))('%s: %s', async (_id, row) => {
    const ff = new FakeFirestore();
    row.seed?.(ff);
    const response = await performGetShiftCloseCaseFigures(
      ff as never,
      row.request ?? validRequest,
      row.auth === undefined ? managerAuth() : row.auth,
    ) as Record<string, unknown>;

    expect(response.status).toBe(row.expectedStatus);
    expect(ff.reads).toEqual(row.expectedReads); // exact read count + exact read order + terminal-stop (no read past the row's own sequence)

    if (row.expectedStatus === 'ok') {
      expect(Object.keys(response).sort()).toEqual(
        ['status', ...FIGURE_KEYS].sort(),
      );
      expect(Object.keys(response).length).toBe(7);
      for (const key of FIGURE_KEYS) expect(Object.prototype.hasOwnProperty.call(response, key)).toBe(true);
    } else {
      expect(Object.keys(response)).toEqual(['status']);
      for (const key of FIGURE_KEYS) expect(Object.prototype.hasOwnProperty.call(response, key)).toBe(false);
    }
  });

  test('exactly 25 business-union rows are mapped', () => {
    expect(BUSINESS_UNION_ROWS.length).toBe(25);
    expect(new Set(BUSINESS_UNION_ROWS.map((r) => r.id)).size).toBe(25);
  });
});

describe('Shell — the exact 25+2 decision table (RC-PS-final): the 2 callable-error rows', () => {
  test('CE-01: invalid request/argument -> exact HttpsError(invalid-argument, "คำขอไม่ถูกต้อง"), 0 reads, 0 logs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ff = new FakeFirestore();
    await expect(
      performGetShiftCloseCaseFigures(ff as never, { branchId: branchId() }, managerAuth()),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: 'คำขอไม่ถูกต้อง' });
    expect(ff.reads.length).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('CE-02: unexpected internal exception -> exact HttpsError(internal, "ระบบขัดข้อง กรุณาลองใหม่"), exactly one attempted read, exactly one safe 3-key log envelope', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let getAttempts = 0;
    const throwingCollection = {
      doc: (id: string) => ({
        get: async () => {
          getAttempts += 1;
          expect(id).toBe('SHIFT-1');
          throw new Error('SENSITIVE_VALUE_SHOULD_NEVER_BE_LOGGED');
        },
      }),
    };
    const throwingFf = { collection: () => throwingCollection } as unknown as FakeFirestore;
    await expect(
      performGetShiftCloseCaseFigures(throwingFf, validRequest, managerAuth()),
    ).rejects.toMatchObject({ code: 'internal', message: 'ระบบขัดข้อง กรุณาลองใหม่' });
    expect(getAttempts).toBe(1); // exact read count: exactly one attempted read, zero completed
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toEqual([{ operation: 'getShiftCloseCaseFigures', stage: 'read_case', code: 'unavailable' }]);
    errorSpy.mockRestore();
  });
});

describe('Shell — selected-run-only, no latestEvidenceId/latestCloseHash fallback', () => {
  test('selected chain broken but latestEvidenceId points at a valid readable evidence doc -> still anomaly, never figures', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
    // The selected run is dangling — no seed for RUN-1 — but a decoy evidence
    // doc exists at the (irrelevant) latestEvidenceId location.
    ff.seed('shiftCloseEvidence', 'SHOULD-NEVER-BE-READ', validEvidenceDoc());
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
    expect(ff.reads.some((r) => r.id === 'SHOULD-NEVER-BE-READ')).toBe(false);
  });

  test('case.selectedRunId null but latestEvidenceId set -> provisional_no_selected_run with exactly 1 read', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: null, selectedCloseHash: null }));
    ff.seed('shiftCloseEvidence', 'SHOULD-NEVER-BE-READ', validEvidenceDoc());
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'provisional_no_selected_run' });
    expect(ff.reads.length).toBe(1);
  });
});

describe('Shell — J11 read boundary: a whitespace-only pointer is fail-closed at exactly one read', () => {
  test('selectedRunId whitespace-only -> unavailable_data_anomaly, exactly 1 read, never .doc(\'   \')', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: '   ', selectedCloseHash: 'HASH-1' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
    expect(ff.reads).toEqual([{ collection: 'shiftCloseCases', id: 'SHIFT-1' }]);
    expect(ff.reads.some((r) => r.id.trim().length === 0)).toBe(false);
  });
  test('selectedCloseHash whitespace-only -> unavailable_data_anomaly, exactly 1 read, never a second read', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: 'RUN-1', selectedCloseHash: '   ' }));
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response).toEqual({ status: 'unavailable_data_anomaly' });
    expect(ff.reads).toEqual([{ collection: 'shiftCloseCases', id: 'SHIFT-1' }]);
  });
  test('selectedRunId with surrounding whitespace is preserved byte-for-byte and used verbatim as the run doc id', async () => {
    const ff = new FakeFirestore();
    ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: '  RUN-1  ', selectedCloseHash: 'HASH-1' }));
    ff.seed('shiftCloseValidationRuns', '  RUN-1  ', validRunDoc({ runId: '  RUN-1  ' }));
    ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc());
    const response = await performGetShiftCloseCaseFigures(ff as never, validRequest, managerAuth());
    expect(response.status).toBe('ok');
    expect(ff.reads).toEqual([
      { collection: 'shiftCloseCases', id: 'SHIFT-1' },
      { collection: 'shiftCloseValidationRuns', id: '  RUN-1  ' },
      { collection: 'shiftCloseEvidence', id: 'SHIFT-1_HASH-1' },
    ]);
  });
});

// A row sweep covering every reachable status/decision outcome, reused by the
// all-row zero-write/no-query and all-row sensitive-log proofs below (RC-PS-03).
interface SweepRow {
  label: string;
  seed?: (ff: FakeFirestore) => void;
  request?: unknown;
  auth?: unknown;
}
const ALL_ROW_SWEEP: SweepRow[] = [
  { label: 'invalid request (non-object)', request: 42 },
  { label: 'unauthenticated', auth: null },
  { label: 'staff role denied', auth: managerAuth({ role: 'staff' }) },
  { label: 'manager other branch denied', auth: managerAuth({ branchIds: ['OTHER'] }) },
  { label: 'case not found' },
  { label: 'stale case version', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ caseVersion: 99 })) },
  { label: 'case branch mismatch', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ branchId: 'OTHER' })) },
  { label: 'unsupported case state', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ processingState: 'nope' })) },
  {
    label: 'provisional no selected run',
    seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: null, selectedCloseHash: null })),
  },
  {
    label: 'selectedRunId whitespace-only',
    seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ selectedRunId: '   ', selectedCloseHash: 'HASH-1' })),
  },
  { label: 'case schema violation', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc({ schemaVersion: 2 })) },
  { label: 'selected run dangling', seed: (ff) => ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc()) },
  {
    label: 'run branch mismatch',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
      ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ branchId: 'OTHER' }));
    },
  },
  {
    label: 'run close-hash mismatch',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
      ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ closeHash: 'WRONG' }));
    },
  },
  {
    label: 'run schema violation',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
      ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ validationSchemaVersion: 2 }));
    },
  },
  {
    label: 'run evidenceId malformed',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
      ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc({ evidenceId: 'WRONG-ID' }));
    },
  },
  {
    label: 'evidence missing (dangling)',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
      ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc());
    },
  },
  {
    label: 'evidence branch mismatch',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
      ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc());
      ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc({ branchId: 'OTHER' }));
    },
  },
  {
    label: 'evidence non-finite money',
    seed: (ff) => {
      ff.seed('shiftCloseCases', 'SHIFT-1', validCaseDoc());
      ff.seed('shiftCloseValidationRuns', 'RUN-1', validRunDoc());
      ff.seed('shiftCloseEvidence', 'SHIFT-1_HASH-1', validEvidenceDoc({ expectedCash: NaN }));
    },
  },
  { label: 'valid selected chain -> ok', seed: seedFullChain },
];

describe('Shell — global zero-write / no-query proof (all-row sweep)', () => {
  test('zero Firestore writes and zero query-API calls across every decision-table row', async () => {
    const ff = new FakeFirestore();
    for (const row of ALL_ROW_SWEEP) {
      row.seed?.(ff);
      await performGetShiftCloseCaseFigures(
        ff as never,
        row.request ?? validRequest,
        row.auth === undefined ? managerAuth() : row.auth,
      ).catch(() => undefined);
    }
    expect(ff.totalWrites).toBe(0);
    for (const collection of KNOWN_COLLECTIONS) {
      expect(ff.writesByCollection.get(collection) ?? 0).toBe(0);
    }
    expect(ff.writesByCollection.size === 0 || [...ff.writesByCollection.values()].every((v) => v === 0)).toBe(true);
    expect(ff.runTransactionCalls).toBe(0);
    expect(ff.batchCalls).toBe(0);
    expect(ff.bulkWriterCalls).toBe(0);
    expect(ff.queryOps).toEqual([]);
  });

  test('firestore.indexes.json is byte-unchanged by Packet S (exact SHA-256 before/after the full row sweep)', async () => {
    const indexesPath = path.join(__dirname, '..', '..', '..', 'firestore.indexes.json');
    expect(fs.existsSync(indexesPath)).toBe(true);
    const crypto = await import('crypto');
    const before = fs.readFileSync(indexesPath);
    const beforeHash = crypto.createHash('sha256').update(before).digest('hex');
    const ff = new FakeFirestore();
    for (const row of ALL_ROW_SWEEP) {
      row.seed?.(ff);
      await performGetShiftCloseCaseFigures(
        ff as never,
        row.request ?? validRequest,
        row.auth === undefined ? managerAuth() : row.auth,
      ).catch(() => undefined);
    }
    const after = fs.readFileSync(indexesPath);
    const afterHash = crypto.createHash('sha256').update(after).digest('hex');
    expect(afterHash).toBe(beforeHash);
    expect(Buffer.compare(before, after)).toBe(0);
  });
});

describe('Shell — sensitive-log absence and the K1 internal-error boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  test('unexpected internal exception -> exactly one safe log, HttpsError internal', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ff = new FakeFirestore();
    const throwingCollection = {
      doc: () => ({
        get: async () => {
          throw new Error('EVIDENCE_VALUE_12345_SHOULD_NEVER_BE_LOGGED');
        },
      }),
    };
    const throwingFf = { collection: () => throwingCollection } as unknown as FakeFirestore;
    await expect(
      performGetShiftCloseCaseFigures(throwingFf, validRequest, managerAuth()),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = errorSpy.mock.calls[0];
    const serialized = JSON.stringify(loggedArgs);
    expect(serialized).not.toContain('EVIDENCE_VALUE_12345');
    expect(serialized).not.toContain('SHIFT-1');
    expect(serialized).not.toContain('STAFF-1');
    expect(serialized).not.toContain(branchId());
  });

  test('no sensitive value appears in any console.* call across the full decision-table row sweep', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ff = new FakeFirestore();
    for (const row of ALL_ROW_SWEEP) {
      row.seed?.(ff);
      await performGetShiftCloseCaseFigures(
        ff as never,
        row.request ?? validRequest,
        row.auth === undefined ? managerAuth() : row.auth,
      ).catch(() => undefined);
    }
    const allCalls = [...logSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    const serialized = JSON.stringify(allCalls);
    for (const seeded of ['SHIFT-1', 'HASH-1', 'RUN-1', 'STAFF-1', branchId(), '100', 'expectedCash']) {
      expect(serialized).not.toContain(seeded);
    }
    // None of these rows hit the internal-error catch branch, so no log at all is expected.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PART B — the AST static guard: rules S1-S9 + RCQ-IP-09 over SHELL_BASELINE_V3
// ============================================================================

const SHELL_ALLOWED_PROPERTY_NAMES = ['collection', 'doc', 'get', 'data', 'auth', 'exists', 'error', 'id'] as const;

const EXCLUDED_FIELD_NAMES_39 = [
  'note', 'notes', 'reasonNote', 'message', 'description',
  'actor', 'acknowledgedByActor', 'resolvedByActor', 'staffName', 'actorUid', 'managerUid', 'uid',
  'cashEntries', 'cashEntriesSnapshot', 'cashEntriesMeta', 'sourceManifest', 'snapshot', 'rawSnapshot',
  'createdAt', 'updatedAt', 'createdAtServer', 'confirmedAtServer', 'capturedAt', 'openedAt',
  'resolvedAt', 'acknowledgedAt', 'leaseOwner', 'leaseExpiry',
  'sourceEvent', 'sourceEventBranch', 'sourceEventId',
  'commandId', 'payloadHash', 'payloadCanonical', 'auditEventId', 'eventId', 'pinVerifiedAtServer',
  'latestEvidenceId', 'latestCloseHash', 'rawToken',
] as const;

// 'require' is deliberately absent: it is already rule S1-REQUIRE's exact
// concern (MS-21), so listing it here too would double-report the same
// identifier under two codes with no added detection.
const S8A_BANNED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'process', 'Buffer',
  'Bun', 'Deno', 'Reflect', 'Proxy', 'eval', 'Function', 'globalThis',
  'WeakRef', 'FinalizationRegistry', 'structuredClone', 'navigator',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
];

const FORBIDDEN_MEMBER_NAMES_SHELL = [
  'set', 'create', 'update', 'delete', 'add', 'batch', 'bulkWriter', 'runTransaction',
  'where', 'orderBy', 'limit', 'limitToLast', 'startAt', 'startAfter', 'endAt', 'endBefore',
  'offset', 'select', 'collectionGroup', 'listDocuments',
  'listCollections', 'onSnapshot', 'stream', 'getAll', 'bundle', 'recursiveDelete',
  'terminate', 'withConverter', 'settings',
];

interface Violation {
  code: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

interface CharRange {
  start: number;
  end: number;
}

function parseModule(source: string): ts.SourceFile {
  return ts.createSourceFile('SHELL_BASELINE_V3.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function loc(sf: ts.SourceFile, start: number) {
  const p = sf.getLineAndCharacterOfPosition(start);
  return { line: p.line + 1, column: p.character + 1 };
}
function forEachDescendant(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node);
  ts.forEachChild(node, (child) => forEachDescendant(child, cb));
}
function enclosingFunctionName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}
function isDeclarationNamePosition(n: ts.Identifier, p: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(p) && p.name === n) ||
    (ts.isParameter(p) && p.name === n) ||
    (ts.isVariableDeclaration(p) && p.name === n) ||
    (ts.isImportSpecifier(p) && p.name === n) ||
    (ts.isPropertyAccessExpression(p) && p.name === n)
  );
}

/**
 * Syntax-only static guard implementing rules S1-S9 + RCQ-IP-09 over SHELL_BASELINE_V3-shaped
 * source. `changedRange`, when supplied, is the exact [start,end) span of the mutation under
 * test; structural ("required construct absent") violations are anchored to it instead of the
 * whole SourceFile, so every reported location is provably inside the mutation.
 */
function analyzeShell(source: string, changedRange?: CharRange): Violation[] {
  const sf = parseModule(source);
  const violations: Violation[] = [];
  const fallbackRange: CharRange = changedRange ?? { start: 0, end: source.length };
  const push = (code: string, node: ts.Node | CharRange) => {
    const start = typeof (node as ts.Node).getStart === 'function' ? (node as ts.Node).getStart(sf) : (node as CharRange).start;
    const end = typeof (node as ts.Node).getEnd === 'function' ? (node as ts.Node).getEnd() : (node as CharRange).end;
    violations.push({ code, ...loc(sf, start), start, end });
  };
  const pushStructural = (code: string) => push(code, fallbackRange);

  const ALLOWED_SPECIFIERS = [
    'firebase-functions/v2/https', 'firebase-admin/firestore', './db', './deployConfig',
    './getShiftCloseCaseFiguresCore', './shiftCloseValidationTypes',
  ];
  const imports: ts.ImportDeclaration[] = [];
  forEachDescendant(sf, (n) => {
    if (ts.isImportDeclaration(n)) imports.push(n);
  });
  if (imports.length === 0) pushStructural('S1-MISSING-IMPORT');
  for (const imp of imports) {
    const spec = ts.isStringLiteral(imp.moduleSpecifier) ? imp.moduleSpecifier.text : '';
    if (!ALLOWED_SPECIFIERS.includes(spec)) {
      push('S8b-SPECIFIER', imp);
    } else if (imp.importClause?.namedBindings && ts.isNamespaceImport(imp.importClause.namedBindings)) {
      push('S1-NAMESPACE', imp);
    } else if (spec === 'firebase-admin/firestore' && !imp.importClause?.isTypeOnly) {
      push('S1-VALUE-IMPORT', imp);
    } else if (spec === './db') {
      for (const el of (imp.importClause?.namedBindings && ts.isNamedImports(imp.importClause.namedBindings) ? imp.importClause.namedBindings.elements : [])) {
        if (el.propertyName) push('S1-RENAMED-IMPORT', el);
      }
    }
  }
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) push('S1-DYNAMIC', n);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') push('S1-REQUIRE', n);
  });

  // ---- S8a: banned direct global identifiers ----
  forEachDescendant(sf, (n) => {
    if (ts.isIdentifier(n) && S8A_BANNED_GLOBALS.includes(n.text)) {
      if (!isDeclarationNamePosition(n, n.parent)) push('S8a-GLOBAL', n);
    }
  });

  // ---- S2: db occurrence rule ----
  let dbCount = 0;
  forEachDescendant(sf, (n) => {
    if (!ts.isIdentifier(n) || n.text !== 'db') return;
    const p = n.parent;
    const isImportCtx = ts.isImportSpecifier(p) && p.name === n && !p.propertyName;
    const isCallArgCtx =
      ts.isCallExpression(p) &&
      ts.isIdentifier(p.expression) &&
      p.expression.text === 'performGetShiftCloseCaseFigures' &&
      p.arguments.includes(n as unknown as ts.Expression);
    dbCount += 1;
    if (!isImportCtx && !isCallArgCtx) push('S2-CONTEXT', n);
  });
  if (dbCount !== 2) pushStructural('S2-COUNT');

  // ---- S3: exactly three read chains rooted at `database` ----
  const frozenNames = ['shiftCloseCases', 'shiftCloseValidationRuns', 'shiftCloseEvidence'];
  const readChains: ts.CallExpression[] = [];
  forEachDescendant(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (!ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'get') return;
    const docCall = n.expression.expression;
    if (!ts.isCallExpression(docCall) || !ts.isPropertyAccessExpression(docCall.expression) || docCall.expression.name.text !== 'doc') return;
    const collCall = docCall.expression.expression;
    if (!ts.isCallExpression(collCall) || !ts.isPropertyAccessExpression(collCall.expression) || collCall.expression.name.text !== 'collection') return;
    const root = collCall.expression.expression;
    if (!ts.isIdentifier(root) || root.text !== 'database') return;
    readChains.push(n);
    const collArg = collCall.arguments[0];
    if (!collArg || !ts.isStringLiteral(collArg)) push('S3-ARGUMENT-KIND', n);
    else if (!frozenNames.includes(collArg.text)) push('S3-LITERAL', n);
    const docArg = docCall.arguments[0];
    if (!docArg || !ts.isIdentifier(docArg)) push('S3-ARGUMENT-KIND', n);
    if (enclosingFunctionName(n) !== 'performGetShiftCloseCaseFigures') push('S3-CHAIN', n);
  });
  if (readChains.length !== 3) pushStructural('S3-COUNT');

  // ---- S4/S9: permitted property registry ----
  let idAccessCount = 0;
  const snapshotBindingNames = ['caseSnap', 'runSnap', 'evidenceSnap'];
  forEachDescendant(sf, (n) => {
    if (!ts.isPropertyAccessExpression(n)) return;
    const name = n.name.text;
    if (name === 'id') {
      if (ts.isIdentifier(n.expression) && snapshotBindingNames.includes(n.expression.text)) {
        idAccessCount += 1;
      } else {
        push('S9-ID-RECEIVER', n);
      }
      return;
    }
    if (!(SHELL_ALLOWED_PROPERTY_NAMES as readonly string[]).includes(name)) {
      push('S4-PROPERTY-NAME', n);
    }
  });
  if (idAccessCount !== 3) pushStructural('S9-ID-COUNT');
  for (const bindingName of snapshotBindingNames) {
    let decls = 0;
    forEachDescendant(sf, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === bindingName) {
        decls += 1;
        const parent = n.parent;
        const isConst = ts.isVariableDeclarationList(parent) && (parent.flags & ts.NodeFlags.Const) !== 0;
        const init = n.initializer;
        const isAwaitChain =
          init &&
          ts.isAwaitExpression(init) &&
          ts.isCallExpression(init.expression) &&
          ts.isPropertyAccessExpression(init.expression.expression) &&
          init.expression.expression.name.text === 'get';
        if (!isConst || !isAwaitChain) push('S9-SNAPSHOT-BINDING', n);
      }
    });
  }
  forEachDescendant(sf, (n) => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name) && n.name.text === 'id') {
      push('S9-ID-MISUSE', n);
    }
    if (ts.isComputedPropertyName(n) && n.getText() === '[id]') push('S9-ID-MISUSE', n);
  });

  // ---- S5: no indirection ----
  forEachDescendant(sf, (n) => {
    if (ts.isElementAccessExpression(n)) push('S5-ELEMENT-ACCESS', n);
    if (ts.isComputedPropertyName(n)) push('S5-COMPUTED-NAME', n);
    if ((ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n))) push('S5-BINDING-PATTERN', n);
  });
  let functionCount = 0;
  forEachDescendant(sf, (n) => {
    if (ts.isFunctionDeclaration(n)) functionCount += 1;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      const isHandlerCallback = ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'onCall';
      if (!isHandlerCallback) push('S5-EXTRA-FUNCTION', n);
    }
  });
  if (functionCount !== 1) pushStructural('S5-EXTRA-FUNCTION');
  forEachDescendant(sf, (n) => {
    if (ts.isPropertyAccessExpression(n) && ['collection', 'doc', 'get'].includes(n.name.text)) {
      const p = n.parent;
      if (!ts.isCallExpression(p) || p.expression !== n) push('S5-METHOD-EXTRACTION', n);
    }
  });

  // ---- S6: forbidden member names ----
  forEachDescendant(sf, (n) => {
    if (ts.isPropertyAccessExpression(n) && FORBIDDEN_MEMBER_NAMES_SHELL.includes(n.name.text)) {
      push('S6-MEMBER', n);
    }
  });

  // ---- S7: write-capable types/sentinels ----
  forEachDescendant(sf, (n) => {
    if (ts.isIdentifier(n) && (n.text === 'WriteBatch' || n.text === 'BulkWriter')) {
      if (!isDeclarationNamePosition(n, n.parent)) push('S7-SENTINEL', n);
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'FieldValue') {
      push('S7-SENTINEL', n);
    }
    if (ts.isImportSpecifier(n) && n.name.text === 'FieldValue') push('S7-SENTINEL', n);
  });

  // ---- S8c: reflective bans ----
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const memberName = n.expression.name.text;
      const chain = n.expression.getText();
      if (memberName === 'call') push('S8c-CALL', n);
      else if (memberName === 'apply') push('S8c-CALL', n);
      else if (memberName === 'bind') push('S8c-BIND', n);
      const bannedObjectApi = [
        'Object.getOwnPropertyDescriptor', 'Object.getPrototypeOf', 'Object.setPrototypeOf',
        'Object.defineProperty', 'Object.defineProperties', 'Object.create', 'Object.assign',
        'Object.getOwnPropertyDescriptors', 'Object.getOwnPropertySymbols',
      ];
      if (bannedObjectApi.includes(chain)) push('S8c-OBJECT-API', n);
    }
  });

  // ---- S8d: exactly two HttpsError constructions, correct try/catch boundary ----
  const httpsErrorCalls: ts.NewExpression[] = [];
  forEachDescendant(sf, (n) => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'HttpsError') {
      httpsErrorCalls.push(n);
    }
  });
  if (httpsErrorCalls.length !== 2) pushStructural('S8D-ERROR-BOUNDARY');
  for (const call of httpsErrorCalls) {
    const args = call.arguments ?? [];
    const codeArg = args[0];
    const isInvalidArg = ts.isStringLiteral(codeArg) && codeArg.text === 'invalid-argument';
    const isInternal = ts.isStringLiteral(codeArg) && codeArg.text === 'internal';
    let cur: ts.Node = call;
    let inTry = false;
    let inCatch = false;
    while (cur.parent) {
      cur = cur.parent;
      if (ts.isTryStatement(cur)) inTry = true;
      if (ts.isCatchClause(cur)) inCatch = true;
    }
    if (isInvalidArg && inTry) push('S8D-ERROR-BOUNDARY', call);
    if (isInternal && !inCatch) push('S8D-ERROR-BOUNDARY', call);
    if (!isInvalidArg && !isInternal) push('S8D-ERROR-BOUNDARY', call);
  }

  // ---- RCQ-IP-09: exactly one safe console.error envelope ----
  const consoleErrorCalls: ts.CallExpression[] = [];
  forEachDescendant(sf, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'console' &&
      n.expression.name.text === 'error'
    ) {
      consoleErrorCalls.push(n);
    }
  });
  if (consoleErrorCalls.length !== 1) pushStructural('RCQ-IP-09-LOGGER-COUNT');
  for (const call of consoleErrorCalls) {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      push('RCQ-IP-09-ENVELOPE', call);
      continue;
    }
    const names = arg.properties
      .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : ts.isShorthandPropertyAssignment(p) ? p.name.text : ''))
      .sort();
    const expected = ['code', 'operation', 'stage'].sort();
    if (names.length !== 3 || names.some((v, i) => v !== expected[i])) push('RCQ-IP-09-ENVELOPE', call);
    for (const name of names) {
      if ((EXCLUDED_FIELD_NAMES_39 as readonly string[]).includes(name)) push('EXCLUDED-FIELD', call);
    }
  }

  // ---- EXCLUDED-FIELD: 39-name targeted guard ----
  forEachDescendant(sf, (n) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    if (ts.isPropertyAccessExpression(n)) text = n.name.text;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name)) text = n.name.text;
    if (text !== null && (EXCLUDED_FIELD_NAMES_39 as readonly string[]).includes(text)) push('EXCLUDED-FIELD', n);
  });

  return violations;
}

interface Mutated {
  source: string;
  range: CharRange;
}

function applyInsert(source: string, marker: string, construct: string): Mutated {
  const markerComment = `/* MARKER:${marker} */`;
  const occurrences = source.split(markerComment).length - 1;
  if (occurrences !== 1) throw new Error(`marker ${marker} occurs ${occurrences} times, expected 1`);
  const idx = source.indexOf(markerComment);
  const insertAt = idx + markerComment.length + 1;
  return {
    source: source.replace(markerComment, `${markerComment}\n${construct}`),
    range: { start: insertAt, end: insertAt + construct.length },
  };
}
function applyReplacement(source: string, target: string, replacement: string): Mutated {
  const occurrences = source.split(target).length - 1;
  if (occurrences !== 1) throw new Error(`replacement target occurs ${occurrences} times, expected 1:\n${target}`);
  const idx = source.indexOf(target);
  return {
    source: source.replace(target, replacement),
    range: { start: idx, end: idx + replacement.length },
  };
}

const SHELL_STRUCTURAL_CODES = ['S1-MISSING-IMPORT', 'S2-COUNT', 'S3-COUNT', 'HANDLER-MISSING', 'S9-ID-COUNT', 'S8D-ERROR-BOUNDARY'];

/**
 * Asserts (RC-PS-02): baseline is clean; the mutation produces at least one
 * violation; the actual distinct violation-code set equals `expectedCodes`
 * exactly; and every violation's [start,end) falls inside the mutation's own
 * exact changed range.
 */
function expectMutation(form: 'INSERT' | 'REPLACE', markerOrTarget: string, constructOrReplacement: string, expectedCodes: string[]) {
  expect(analyzeShell(SHELL_BASELINE_V3)).toEqual([]);
  const { source: mutated, range } =
    form === 'INSERT'
      ? applyInsert(SHELL_BASELINE_V3, markerOrTarget, constructOrReplacement)
      : applyReplacement(SHELL_BASELINE_V3, markerOrTarget, constructOrReplacement);
  const violations = analyzeShell(mutated, range);
  expect(violations.length).toBeGreaterThanOrEqual(1);
  const actualCodes = [...new Set(violations.map((v) => v.code))].sort();
  const expectedSet = [...new Set(expectedCodes)].sort();
  expect(actualCodes).toEqual(expectedSet);
  for (const v of violations) {
    expect(v.start).toBeGreaterThanOrEqual(range.start);
    expect(v.end).toBeLessThanOrEqual(range.end);
  }
}
function expectPositive(marker: string, construct: string) {
  expect(analyzeShell(SHELL_BASELINE_V3)).toEqual([]);
  const { source: mutated } = applyInsert(SHELL_BASELINE_V3, marker, construct);
  expect(analyzeShell(mutated)).toEqual([]);
}

describe('Static guard — SHELL_BASELINE_V3 zero-violation baseline', () => {
  test('the unmutated baseline yields zero violations', () => {
    expect(analyzeShell(SHELL_BASELINE_V3)).toEqual([]);
  });
});

describe('Production/fixture byte binding (RC-PS-final): SHELL_BASELINE_V3 == shipped getShiftCloseCaseFigures.ts', () => {
  test('SHELL_BASELINE_V3 is byte-for-byte identical to the live production file', () => {
    const productionBytes = fs.readFileSync(path.join(__dirname, '..', 'getShiftCloseCaseFigures.ts'));
    const fixtureBytes = Buffer.from(SHELL_BASELINE_V3, 'utf8');
    expect(fixtureBytes.length).toBe(productionBytes.length);
    expect(Buffer.compare(fixtureBytes, productionBytes)).toBe(0);
  });
});

describe('Static guard — shell mutation matrix (MS-01 .. MS-62)', () => {
  test('MS-01', () => expectMutation('INSERT', 'BODY', "const r0 = fetch('https://example.test');", ['S8a-GLOBAL']));
  test('MS-02', () => expectMutation('INSERT', 'BODY', "const w0 = new WebSocket('wss://example.test');", ['S8a-GLOBAL']));
  test('MS-03', () => expectMutation('INSERT', 'BODY', 'const x0 = new XMLHttpRequest();', ['S8a-GLOBAL']));
  test('MS-04', () => expectMutation('INSERT', 'BODY', "const e0 = new EventSource('/x');", ['S8a-GLOBAL']));
  test('MS-05', () => expectMutation('INSERT', 'BODY', 'const p0 = process;', ['S8a-GLOBAL']));
  test('MS-06', () => expectMutation('INSERT', 'BODY', 'const b0 = Buffer;', ['S8a-GLOBAL']));
  test('MS-07', () => expectMutation('INSERT', 'BODY', 'const g0 = globalThis;', ['S8a-GLOBAL']));
  test('MS-08', () => expectMutation('INSERT', 'BODY', "const v0 = Reflect.get(database, 'collection');", ['S8a-GLOBAL']));
  test('MS-09', () => expectMutation('INSERT', 'BODY', 'const p1 = new Proxy(database, {});', ['S8a-GLOBAL']));
  test('MS-10', () => expectMutation('INSERT', 'BODY', "const f0 = eval('1');", ['S8a-GLOBAL']));
  test('MS-11', () => expectMutation('INSERT', 'BODY', "const f1 = new Function('return 1');", ['S8a-GLOBAL']));
  test('MS-12', () => expectMutation('INSERT', 'BODY', 'const d0 = Deno;', ['S8a-GLOBAL']));
  test('MS-13', () => expectMutation('INSERT', 'BODY', 'const b1 = Bun;', ['S8a-GLOBAL']));
  test('MS-14', () => expectMutation('INSERT', 'BODY', 'const t0 = setTimeout;', ['S8a-GLOBAL']));
  test('MS-15', () => expectMutation('INSERT', 'IMPORTS', "import { readFileSync } from 'node:fs';", ['S8b-SPECIFIER']));
  test('MS-16', () => expectMutation('INSERT', 'IMPORTS', "import { request } from 'https';", ['S8b-SPECIFIER']));
  test('MS-17', () => expectMutation('INSERT', 'IMPORTS', "import { Worker } from 'worker_threads';", ['S8b-SPECIFIER']));
  test('MS-18', () => expectMutation('INSERT', 'IMPORTS', "import { spawn } from 'child_process';", ['S8b-SPECIFIER']));
  test('MS-19', () => expectMutation('INSERT', 'IMPORTS', "import * as admin from 'firebase-admin';", ['S8b-SPECIFIER']));
  test('MS-20', () => expectMutation('INSERT', 'BODY', "await import('firebase-admin/firestore');", ['S1-DYNAMIC']));
  test('MS-21', () => expectMutation('INSERT', 'BODY', "require('./db');", ['S1-REQUIRE']));
  test('MS-22', () => expectMutation('INSERT', 'IMPORTS', "import { FieldValue } from 'firebase-admin/firestore';", ['S1-VALUE-IMPORT', 'S7-SENTINEL']));
  test('MS-23', () => expectMutation('INSERT', 'BODY', 'if (database === db) { void 0; }', ['S2-CONTEXT', 'S2-COUNT']));
  test('MS-24', () => expectMutation('INSERT', 'BODY', 'const alias0 = db;', ['S2-CONTEXT', 'S2-COUNT']));
  test('MS-25', () => expectMutation('INSERT', 'BODY', "const extraRead0 = await database.collection('shifts').doc(shiftId).get();", ['S3-LITERAL', 'S3-COUNT']));
  test('MS-26', () => expectMutation('INSERT', 'BODY', "const extraRead1 = await database.collection(shiftId).doc(shiftId).get();", ['S3-ARGUMENT-KIND', 'S3-COUNT']));
  test('MS-27', () => expectMutation('INSERT', 'BODY', "const extraRead2 = await database.collection('shiftCloseCases').doc(shiftId).get();", ['S3-COUNT']));
  test('MS-28', () => expectMutation('INSERT', 'BODY', "const q0 = await database.collection('shiftCloseCases').where('a', '==', 1).get();", ['S4-PROPERTY-NAME', 'S6-MEMBER']));
  test('MS-29', () => expectMutation('INSERT', 'BODY', "await database.collection('shiftCloseCases').doc(shiftId).set({});", ['S4-PROPERTY-NAME', 'S6-MEMBER']));
  test('MS-30', () => expectMutation('INSERT', 'BODY', 'await database.runTransaction(async () => 1);', ['S4-PROPERTY-NAME', 'S5-EXTRA-FUNCTION', 'S6-MEMBER']));
  test('MS-31', () => expectMutation('INSERT', 'BODY', 'const bat0 = database.batch();', ['S4-PROPERTY-NAME', 'S6-MEMBER']));
  test('MS-32', () => expectMutation('INSERT', 'BODY', 'const bw0 = database.bulkWriter();', ['S4-PROPERTY-NAME', 'S6-MEMBER']));
  test('MS-33', () => expectMutation('INSERT', 'BODY', "database.collection('shiftCloseCases').onSnapshot(() => 1);", ['S4-PROPERTY-NAME', 'S5-EXTRA-FUNCTION', 'S6-MEMBER']));
  test('MS-36', () => expectMutation('INSERT', 'BODY', 'const read0 = database.collection;', ['S5-METHOD-EXTRACTION']));
  test('MS-37', () => expectMutation('INSERT', 'BODY', "const key0 = 'x'; const o0 = { [key0]: 1 };", ['S5-COMPUTED-NAME']));
  test('MS-38', () => expectMutation('INSERT', 'BODY', 'function helper0() { return 1; }', ['S5-EXTRA-FUNCTION']));
  test('MS-39', () => expectMutation('INSERT', 'BODY', 'const g1 = ((x: number) => x); g1(1);', ['S5-EXTRA-FUNCTION']));
  test('MS-34', () => expectMutation('INSERT', 'POSTCASE', "const nm0 = 'se' + 't'; (caseSnap as never)[nm0]();", ['S5-ELEMENT-ACCESS']));
  test('MS-35', () => expectMutation('INSERT', 'POSTCASE', 'const { exists: exists0 } = caseSnap;', ['S5-BINDING-PATTERN']));
  test('MS-40', () => expectMutation('INSERT', 'POSTCASE', 'const s0 = caseSnap.data.call(caseSnap);', ['S4-PROPERTY-NAME', 'S8c-CALL']));
  test('MS-41', () => expectMutation('INSERT', 'POSTCASE', 'const s1 = caseSnap.data.bind(caseSnap);', ['S4-PROPERTY-NAME', 'S8c-BIND']));
  test('MS-42', () => expectMutation('INSERT', 'POSTCASE', 'const d2 = Object.getPrototypeOf(caseSnap);', ['S4-PROPERTY-NAME', 'S8c-OBJECT-API']));
  test('MS-43', () => expectMutation('INSERT', 'POSTCASE', 'const o2 = Object.assign({}, caseSnap);', ['S4-PROPERTY-NAME', 'S8c-OBJECT-API']));
  test('MS-44', () => expectMutation('INSERT', 'BODY', 'const t1 = ({} as { role: unknown }).role;', ['S4-PROPERTY-NAME']));
  test('MS-45', () => expectMutation('INSERT', 'BODY', 'const t2 = (rawAuth as { token: unknown }).token;', ['S4-PROPERTY-NAME']));
  test('MS-46', () => expectMutation('INSERT', 'BODY', 'const n0 = request.branchId;', ['S4-PROPERTY-NAME']));
  test('MS-47', () =>
    expectMutation(
      'INSERT',
      'BODY',
      "console.error({ operation: 'x', stage, code: 'unavailable', note: 'y' });",
      ['EXCLUDED-FIELD', 'RCQ-IP-09-ENVELOPE', 'RCQ-IP-09-LOGGER-COUNT'],
    ));
  test('MS-48', () => expectMutation('INSERT', 'BODY', "console.warn({ operation: 'x' });", ['S4-PROPERTY-NAME'] ) );
  test('MS-49', () => expectMutation('INSERT', 'BODY', 'const sid0 = request.shiftId;', ['S4-PROPERTY-NAME']));
  test('MS-50', () =>
    expectMutation(
      'INSERT',
      'POSTCASE',
      "console.error({ operation: 'getShiftCloseCaseFigures', stage, code: 'unavailable' });",
      ['RCQ-IP-09-LOGGER-COUNT'],
    ));
  test('MS-51', () =>
    expectMutation(
      'INSERT',
      'POSTCASE',
      "console.error({ operation: 'x', stage, code: 'unavailable', rawToken: 'x' });",
      ['EXCLUDED-FIELD', 'RCQ-IP-09-ENVELOPE', 'RCQ-IP-09-LOGGER-COUNT'],
    ));
  test('MS-52', () => expectMutation('INSERT', 'BODY', 'const t3 = (rawAuth as { rawToken: unknown }).rawToken;', ['EXCLUDED-FIELD', 'S4-PROPERTY-NAME']));
  test('MS-53', () => expectMutation('INSERT', 'BODY', 'const u0 = (rawAuth as { uid: unknown }).uid;', ['EXCLUDED-FIELD', 'S4-PROPERTY-NAME']));
  test('MS-54', () => expectMutation('INSERT', 'POSTCASE', 'const x4 = request.id;', ['S9-ID-RECEIVER']));
  test('MS-55', () => expectMutation('INSERT', 'POSTCASE', 'const y0 = { id: 1 }.id;', ['S9-ID-MISUSE', 'S9-ID-RECEIVER']));
  test('MS-56', () =>
    expectMutation(
      'REPLACE',
      "    const caseSnap = await database.collection('shiftCloseCases').doc(shiftId).get();",
      "    let caseSnap = await database.collection('shiftCloseCases').doc(shiftId).get();",
      ['S9-SNAPSHOT-BINDING'],
    ));
  test('MS-57', () => expectMutation('INSERT', 'POSTCASE', 'const caseSnapAlias0 = caseSnap; const z0 = caseSnapAlias0.id;', ['S9-ID-RECEIVER']));
  test('MS-58', () => expectMutation('INSERT', 'POSTCASE', 'const w0 = caseSnap.id;', ['S9-ID-COUNT']));
  test('MS-59', () =>
    expectMutation(
      'REPLACE',
      "    throw new HttpsError('invalid-argument', 'คำขอไม่ถูกต้อง');",
      '    return responseUnavailableDataAnomaly();',
      ['S8D-ERROR-BOUNDARY'],
    ));
  test('MS-60', () =>
    expectMutation(
      'REPLACE',
      "    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');",
      '    return responseUnavailableDataAnomaly();',
      ['S8D-ERROR-BOUNDARY'],
    ));
  test('MS-61', () => expectMutation('INSERT', 'BODY', "if (request === null) { throw new HttpsError('internal', 'x'); }", ['S8D-ERROR-BOUNDARY']));
  test('MS-62', () =>
    expectMutation(
      'INSERT',
      'POSTCASE',
      "console.error({ operation: 'getShiftCloseCaseFigures', stage, code: 'unavailable' });",
      ['RCQ-IP-09-LOGGER-COUNT'],
    ));
});

describe('Static guard — shell positive fixtures (PS-B1 .. PS-B9)', () => {
  test('PS-B1 — located: the untouched import { db } from ./db is accepted', () => {
    expect(SHELL_BASELINE_V3.includes("import { db } from './db';")).toBe(true);
    expect(analyzeShell(SHELL_BASELINE_V3)).toEqual([]);
  });
  test('PS-B2 — located: performGetShiftCloseCaseFigures(db, request.data, request.auth) is accepted', () => {
    expect(SHELL_BASELINE_V3.includes('performGetShiftCloseCaseFigures(db, request.data, request.auth)')).toBe(true);
  });
  test('PS-B3 — located: each of the three untouched read chains is accepted', () => {
    for (const name of ['shiftCloseCases', 'shiftCloseValidationRuns', 'shiftCloseEvidence']) {
      expect(SHELL_BASELINE_V3.includes(`database.collection('${name}')`)).toBe(true);
    }
  });
  test('PS-B4 — located: the single existing console.error envelope is accepted', () => {
    const violations = analyzeShell(SHELL_BASELINE_V3);
    expect(violations.filter((v) => v.code.startsWith('RCQ-IP-09'))).toEqual([]);
  });
  test('PS-B5', () => expectPositive('POSTCASE', 'if (!caseSnap.exists) { void 0; }'));
  test('PS-B6', () => expectPositive('POSTCASE', 'const again0 = caseSnap.data();'));
  test('PS-B7', () => expectPositive('BODY', 'const sid1 = readCuratedRequestShiftId(request);'));
  test('PS-B8 — located: the three .id accesses are each bound to their frozen snapshot receiver', () => {
    const violations = analyzeShell(SHELL_BASELINE_V3);
    expect(violations.filter((v) => v.code.startsWith('S9-'))).toEqual([]);
  });
  test('PS-B9 — located: the two HttpsError constructions are accepted by S8d', () => {
    const violations = analyzeShell(SHELL_BASELINE_V3);
    expect(violations.filter((v) => v.code === 'S8D-ERROR-BOUNDARY')).toEqual([]);
  });
});

// ============================================================================
// The frozen SHELL_BASELINE_V3 source text (byte-identical to the shipped
// functions/src/getShiftCloseCaseFigures.ts) — the fixture under guard.
// ============================================================================
const SHELL_BASELINE_V3 = `/**
 * getShiftCloseCaseFigures — I/O shell. [Packet 5 / UI-B2 / Packet S]
 * onCall wiring + exactly three direct document reads. Every decision is
 * delegated to the pure getShiftCloseCaseFiguresCore module.
 *
 * K1 boundary:
 *   invalid request      -> HttpsError('invalid-argument'), zero reads, no union member
 *   unexpected exception -> exactly one safe log, then HttpsError('internal')
 *   validated outcomes   -> one of the seven business-union members
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import {
  caseDecisionResponse,
  caseDecisionView,
  curateCallableAuth,
  curateCaseDocument,
  curateEvidenceDocument,
  curateRequestView,
  curateRunDocument,
  decideAuthorization,
  decideShiftCloseCaseFigures,
  evidenceDecisionResponse,
  evidenceDecisionView,
  readCuratedCaseSelectedRunId,
  readCuratedRequestShiftId,
  readCuratedRunEvidenceId,
  responseCaseNotFound,
  responseProvisionalNoSelectedRun,
  responseUnavailableDataAnomaly,
  runDecisionResponse,
  runDecisionView,
  type GetShiftCloseCaseFiguresResponse,
} from './getShiftCloseCaseFiguresCore';

/* MARKER:IMPORTS */

export async function performGetShiftCloseCaseFigures(
  database: Firestore,
  rawRequest: unknown,
  rawAuth: unknown,
): Promise<GetShiftCloseCaseFiguresResponse> {
  const request = curateRequestView(rawRequest);
  if (request === null) {
    throw new HttpsError('invalid-argument', 'คำขอไม่ถูกต้อง');
  }

  const denial = decideAuthorization(curateCallableAuth(rawAuth), request);
  if (denial !== null) return denial;

  const shiftId = readCuratedRequestShiftId(request);
  let stage: 'read_case' | 'read_run' | 'read_evidence' = 'read_case';

  /* MARKER:BODY */

  try {
    const caseSnap = await database.collection('shiftCloseCases').doc(shiftId).get();

    /* MARKER:POSTCASE */

    if (!caseSnap.exists) return responseCaseNotFound();
    const caseDecision = curateCaseDocument(request, caseSnap.id, caseSnap.data());
    const caseStatus = caseDecisionResponse(caseDecision);
    if (caseStatus !== null) return caseStatus;
    const caseView = caseDecisionView(caseDecision);
    if (caseView === null) return responseUnavailableDataAnomaly();

    const selectedRunId = readCuratedCaseSelectedRunId(caseView);
    if (selectedRunId === null) return responseProvisionalNoSelectedRun();

    stage = 'read_run';
    const runSnap = await database.collection('shiftCloseValidationRuns').doc(selectedRunId).get();
    if (!runSnap.exists) return responseUnavailableDataAnomaly();
    const runDecision = curateRunDocument(caseView, runSnap.id, runSnap.data());
    const runStatus = runDecisionResponse(runDecision);
    if (runStatus !== null) return runStatus;
    const runView = runDecisionView(runDecision);
    if (runView === null) return responseUnavailableDataAnomaly();

    const evidenceId = readCuratedRunEvidenceId(runView);

    stage = 'read_evidence';
    const evidenceSnap = await database.collection('shiftCloseEvidence').doc(evidenceId).get();
    if (!evidenceSnap.exists) return responseUnavailableDataAnomaly();
    const evidenceDecision = curateEvidenceDocument(
      caseView,
      runView,
      evidenceSnap.id,
      evidenceSnap.data(),
    );
    const evidenceStatus = evidenceDecisionResponse(evidenceDecision);
    if (evidenceStatus !== null) return evidenceStatus;
    const evidenceView = evidenceDecisionView(evidenceDecision);
    if (evidenceView === null) return responseUnavailableDataAnomaly();

    return decideShiftCloseCaseFigures(runView, evidenceView);
  } catch {
    console.error({ operation: 'getShiftCloseCaseFigures', stage, code: 'unavailable' });
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
}

/* MARKER:HANDLER */

export const getShiftCloseCaseFigures = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\\/\\/localhost:\\d+$/, /^https:\\/\\/.*\\.firebaseapp\\.com$/, /^https:\\/\\/.*\\.web\\.app$/],
  },
  async (request) => {
    return performGetShiftCloseCaseFigures(db, request.data, request.auth);
  },
);
`;
