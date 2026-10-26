// Return/Refund V1 packet 014 — the server-authoritative attempt binding in
// the close journal (B2 attempt + 007-B finalize) and the sweep's view of it.
//
// Provenance: only symbols that exist at the parent commit (7194494) are
// imported and the binding is passed as the (new) 2nd argument of
// `prepareOnlineCloseAttempt`, so on the parent these tests run and fail on
// BEHAVIOUR (binding silently dropped, mismatching server totals adopted,
// malformed binding accepted, legacy reuse of a bound attempt), not on imports.
import { describe, expect, test } from 'vitest';
import {
  createInMemoryShiftCloseIntentJournal,
  createInMemoryShiftCloseIntentStore,
  onlineCloseAttemptKey,
  type ShiftCloseIntentJournal,
} from './shiftCloseIntentStore';
import {
  recoverOnlineCloseAttempt,
  runShiftCloseReconciliationSweep,
  shiftCloseConfirmationDocFromData,
  shiftCloseNormalizationIssue,
  type ShiftCloseConfirmationReader,
} from './shiftCloseReconciler';
import type { OnlineCloseAttemptRecord, ShiftCloseIntentBusinessSnapshot } from './shiftCloseIntentTypes';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const IDENTITY = { shiftId: 'S1', branchId: 'B1', staffId: 's1', staffName: 'Staff', deviceId: 'DEV1' };

const EXPECTED: ShiftCloseIntentBusinessSnapshot = {
  ...IDENTITY,
  startingCash: 500,
  expectedCash: 1000,
  expectedQr: 0,
  expectedKbank: 0,
  expectedCard: 0,
  expectedCredit: 0,
  payInTotal: 0,
  payOutTotal: 0,
  totalBills: 3,
  actualCashCount: 1500,
  variance: 0,
  note: '',
};

function binding(expected: ShiftCloseIntentBusinessSnapshot = EXPECTED) {
  return {
    protocol: 'server_authoritative_v1' as const,
    request: {
      contractVersion: 1 as const,
      shiftId: 'S1',
      actualCashCount: expected.actualCashCount,
      note: expected.note,
      attestedSales: {
        expectedCash: expected.expectedCash,
        expectedQr: expected.expectedQr,
        expectedKbank: expected.expectedKbank,
        expectedCard: expected.expectedCard,
        expectedCredit: expected.expectedCredit,
        totalBills: expected.totalBills,
      },
      deviceId: 'DEV1',
    },
    expected,
  };
}

/** The server committed a Return 81 that the bound expectation did not contain. */
const COMMITTED_WITH_RETURN: ShiftCloseIntentBusinessSnapshot = { ...EXPECTED, payOutTotal: 81, variance: 81 };

type Prepare = (identity: typeof IDENTITY, authoritative?: unknown) => ReturnType<ShiftCloseIntentJournal['prepareOnlineCloseAttempt']>;

function journalPair() {
  const store = createInMemoryShiftCloseIntentStore();
  const journal = createInMemoryShiftCloseIntentJournal({ store, generateCloseCorrelationId: () => UUID_A });
  const prepare = journal.prepareOnlineCloseAttempt as unknown as Prepare;
  return { store, journal, prepare };
}

async function attempts(journal: ShiftCloseIntentJournal) {
  const listed = await journal.listOnlineCloseAttempts();
  if (!listed.ok) throw new Error(`list ${listed.code}`);
  return listed.value as Array<OnlineCloseAttemptRecord & Record<string, unknown>>;
}

function closedDoc(s: ShiftCloseIntentBusinessSnapshot): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...s };
  delete fields.staffName; // W3 never writes it
  delete fields.shiftId;
  return {
    ...fields,
    status: 'closed',
    closeCorrelationId: UUID_A,
    closedAt: { toDate: () => new Date('2026-10-22T10:00:00Z') },
    closedOffline: true,
    syncState: 'pending',
  };
}

function reader(doc: Record<string, unknown>): ShiftCloseConfirmationReader {
  return async () => ({ ok: true, doc: shiftCloseConfirmationDocFromData({ ...doc }) });
}

const CLOSED_AT_MS = Date.parse('2026-10-22T10:00:00Z');

/** What the server proves for a close it authored: the canonical idempotent replay (contract v1 §6). */
function replayCallable(snapshot: ShiftCloseIntentBusinessSnapshot) {
  return async (): Promise<unknown> => ({
    ok: true,
    contractVersion: 1,
    closeProtocol: 'server_authoritative_v1',
    idempotentReplay: true,
    shiftId: snapshot.shiftId,
    closeCorrelationId: UUID_A,
    closedAtMillis: CLOSED_AT_MS,
    snapshot: { ...snapshot },
    persistedClose: { status: 'closed', closedOffline: true, syncStateAtClose: 'pending' },
    provenance: { salesTotals: { status: 'attested_unverified', reason: 'sale_sync_completeness_not_provable' } },
  });
}

/** The server proof object the validated success yields (015). */
function serverProof(snapshot: ShiftCloseIntentBusinessSnapshot) {
  return { protocol: 'server_authoritative_v1' as const, shiftId: snapshot.shiftId, closeCorrelationId: UUID_A, closedAtMillis: CLOSED_AT_MS, snapshot };
}

type Finalize = (
  s: ShiftCloseIntentBusinessSnapshot,
  id: string,
  o?: undefined,
  p?: unknown,
) => ReturnType<ShiftCloseIntentJournal['finalizeOnlineClose']>;

describe('014 binding is written with the attempt and never rewritten', () => {
  test('prepare persists the binding; read back / list return it exactly', async () => {
    const { journal, prepare } = journalPair();
    const p = await prepare(IDENTITY, binding());
    expect(p.ok && p.value.kind).toBe('prepared');
    const [a] = await attempts(journal);
    expect(a!.authoritative).toEqual(binding());
    expect(a!.closeCorrelationId).toBe(UUID_A);
  });

  test('an existing bound attempt is returned unchanged for a different binding (caller decides; nothing rewritten)', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const other = binding({ ...EXPECTED, actualCashCount: 1499, variance: -1 });
    const p = await prepare(IDENTITY, other);
    expect(p.ok && p.value.kind === 'prepared' && (p.value.attempt as Record<string, unknown>).authoritative).toEqual(binding());
    expect((await attempts(journal))[0]!.authoritative).toEqual(binding());
  });

  test('commit-observed marking and supersession keep the binding', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    await journal.markOnlineCloseAttemptCommitObserved('S1', UUID_A);
    const [a] = await attempts(journal);
    expect('commitObservedAtLocal' in a!).toBe(true);
    expect(a!.authoritative).toEqual(binding());
  });

  test('the legacy (transaction) close never reuses a bound attempt', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const legacy = await journal.prepareOnlineCloseAttempt(IDENTITY);
    expect(legacy).toMatchObject({ ok: false, code: 'conflict' });
  });

  test('a binding inconsistent with its own attempt / request is refused and nothing is stored', async () => {
    const { journal, prepare } = journalPair();
    const bad = binding();
    const r1 = await prepare(IDENTITY, { ...bad, expected: { ...EXPECTED, deviceId: 'DEV2' } });
    expect(r1).toMatchObject({ ok: false, code: 'conflict' });
    const r2 = await prepare(IDENTITY, { ...bad, request: { ...bad.request, actualCashCount: 1 } });
    expect(r2).toMatchObject({ ok: false, code: 'conflict' });
    const r3 = await prepare(IDENTITY, { ...bad, request: { ...bad.request, payOutTotal: 0 } });
    expect(r3).toMatchObject({ ok: false, code: 'conflict' });
    expect(await attempts(journal)).toEqual([]);
  });

  test('a stored malformed binding makes the attempt unreadable (fail closed, never ignored)', async () => {
    const { store, journal } = journalPair();
    await store.transact(['shiftCloseIntents'], 'readwrite', (txn) =>
      txn.put('shiftCloseIntents', onlineCloseAttemptKey('S1'), {
        kind: 'onlineCloseAttempt',
        version: 1,
        ...IDENTITY,
        closeCorrelationId: UUID_A,
        preparedAtLocal: 1,
        authoritative: { protocol: 'server_authoritative_v1', request: {}, expected: null },
      }),
    );
    expect(await journal.listOnlineCloseAttempts()).toMatchObject({ ok: false, code: 'conflict' });
  });
});

describe('014 007-B finalize enforces the bound expectation', () => {
  test('committed snapshot ≠ expected ⇒ attempt_expectation_mismatch; nothing written; attempt retained', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const r = await journal.finalizeOnlineClose(COMMITTED_WITH_RETURN, UUID_A);
    expect(r).toMatchObject({ ok: false, code: 'conflict', reason: 'attempt_expectation_mismatch' });
    expect((await journal.getCloseIntent('S1')).ok && (await journal.getCloseIntent('S1'))).toMatchObject({ value: undefined });
    expect(await attempts(journal)).toHaveLength(1);
  });

  test('committed snapshot === expected ⇒ finalized, attempt consumed (idempotent re-finalize)', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const fin = journal.finalizeOnlineClose as unknown as Finalize;
    const r = await fin(EXPECTED, UUID_A, undefined, serverProof(EXPECTED)); // 015: with the callable's proof
    expect(r).toMatchObject({ ok: true, consumedAttempt: true });
    expect(await attempts(journal)).toEqual([]);
    expect(await journal.finalizeOnlineClose(EXPECTED, UUID_A)).toMatchObject({ ok: true, consumedAttempt: false });
  });
});

describe('014 the boot / reconnect sweep cannot adopt unexpected server totals', () => {
  test('recoverOnlineCloseAttempt: closed with this id but different totals ⇒ manual_attention, no entry', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const [a] = await attempts(journal);
    const r = await recoverOnlineCloseAttempt(a!, { journal, readConfirmation: reader(closedDoc(COMMITTED_WITH_RETURN)), deviceId: 'DEV1' });
    expect(r.outcome).toBe('manual_attention');
    expect(await journal.getCloseIntent('S1')).toEqual({ ok: true, value: undefined });
  });

  test('recoverOnlineCloseAttempt: closed with this id and the expected totals ⇒ recovered', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const [a] = await attempts(journal);
    const r = await recoverOnlineCloseAttempt(a!, {
      journal,
      readConfirmation: reader(closedDoc(EXPECTED)),
      deviceId: 'DEV1',
      authoritativeCallable: replayCallable(EXPECTED), // 015: the shift doc alone is not enough
    });
    expect(r.outcome).toBe('recovered');
  });

  test('the sweep summary reports the refused server-authoritative attempt (never a clean state)', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: reader(closedDoc(COMMITTED_WITH_RETURN)),
      normalizeSyncState: async () => 'written',
      deviceId: 'DEV1',
    });
    expect(swept.normalization.status).toBe('unresolved');
    expect(swept.normalization.attention).toEqual([{ shiftId: 'S1', branchId: 'B1', condition: 'attempt_manual_attention' }]);
    expect(shiftCloseNormalizationIssue(swept.normalization)).toBe('attempt_manual_attention=1');
  });

  test('an unreachable server read of a bound attempt is reported too', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: async () => ({ ok: false }),
      normalizeSyncState: async () => 'written',
      deviceId: 'DEV1',
    });
    expect(swept.normalization.attention).toEqual([{ shiftId: 'S1', branchId: 'B1', condition: 'attempt_unreachable' }]);
  });

  test('a still-open shift (unknown outcome, nothing committed) is an UNRESOLVED owed close, never clean (015 F3)', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: reader({ ...closedDoc(EXPECTED), status: 'open', closeCorrelationId: null, closedAt: null }),
      normalizeSyncState: async () => 'written',
      deviceId: 'DEV1',
    });
    expect(swept.normalization.status).toBe('unresolved');
    expect(swept.normalization.attention).toEqual([{ shiftId: 'S1', branchId: 'B1', condition: 'attempt_unresolved' }]);
    expect(swept.normalization.attempts).toEqual({ not_closed: 1 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Packet 015 — F5 (strict persisted binding schema), F1 store boundary, F3 scoping.
// [RED-parent] cases use only parent symbols; they fail there on behaviour.
// ═════════════════════════════════════════════════════════════════════════

/** A binding for a numerically coherent close: variance = actual − (start + cash + payIn − payOut). */
function coherent(over: Partial<ShiftCloseIntentBusinessSnapshot> = {}): ShiftCloseIntentBusinessSnapshot {
  const base = { ...EXPECTED, ...over };
  const variance =
    'variance' in over
      ? (over.variance as number)
      : base.actualCashCount - (base.startingCash + base.expectedCash + base.payInTotal - base.payOutTotal);
  return { ...base, variance };
}

function rawAttempt(authoritative: unknown): Record<string, unknown> {
  return { kind: 'onlineCloseAttempt', version: 1, ...IDENTITY, closeCorrelationId: UUID_A, preparedAtLocal: 1, authoritative };
}

describe('015-F5 the authoritative binding is validated against the exact contract at every journal boundary', () => {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  type Mutation = [label: string, mutate: (b: ReturnType<typeof binding>) => unknown];
  const MALFORMED: Mutation[] = [
    ['fractional totalBills (request + expected)', (b) => { b.request.attestedSales.totalBills = 2.5; b.expected.totalBills = 2.5; return b; }],
    ['negative totalBills', (b) => { b.request.attestedSales.totalBills = -1; b.expected.totalBills = -1; return b; }],
    ['totalBills over 100000', (b) => { b.request.attestedSales.totalBills = 100_001; b.expected.totalBills = 100_001; return b; }],
    ['off-cent actualCashCount (request + expected)', (b) => { b.request.actualCashCount = 1500.005; b.expected.actualCashCount = 1500.005; b.expected.variance = 0.005; return b; }],
    ['off-cent attested expectedCash (request + expected)', (b) => { b.request.attestedSales.expectedCash = 1000.005; b.expected.expectedCash = 1000.005; b.expected.variance = -0.005; return b; }],
    ['float-noise attested money (0.1 + 0.2)', (b) => { b.request.attestedSales.expectedQr = 0.1 + 0.2; b.expected.expectedQr = 0.1 + 0.2; return b; }],
    ['over-bound money (1e11)', (b) => { b.request.actualCashCount = 1e11; b.expected.actualCashCount = 1e11; return b; }],
    ['negative expected money', (b) => { b.request.attestedSales.expectedCard = -5; b.expected.expectedCard = -5; return b; }],
    ['off-cent expected startingCash', (b) => { b.expected.startingCash = 500.001; return b; }],
    ['negative expected payOutTotal', (b) => { b.expected.payOutTotal = -81; b.expected.variance = 1500 - (500 + 1000 + 81); return b; }],
    ['off-cent expected payInTotal', (b) => { b.expected.payInTotal = 0.001; return b; }],
    ['nonsensical variance (does not equal actual − expected drawer)', (b) => { b.expected.variance = 12345; return b; }],
    ['contradictory variance sign', (b) => { b.expected.payOutTotal = 81; return b; }], // variance still 0 ≠ 81
    ['extra key in expected', (b) => ({ ...b, expected: { ...b.expected, injected: 1 } })],
    ['missing key in expected (variance)', (b) => { const e = { ...b.expected } as Record<string, unknown>; delete e.variance; return { ...b, expected: e }; }],
    ['missing key in expected (startingCash)', (b) => { const e = { ...b.expected } as Record<string, unknown>; delete e.startingCash; return { ...b, expected: e }; }],
    ['extra key in request.attestedSales', (b) => ({ ...b, request: { ...b.request, attestedSales: { ...b.request.attestedSales, expectedVoucher: 1 } } })],
    ['extra key in request', (b) => ({ ...b, request: { ...b.request, payOutTotal: 0 } })],
    ['request contractVersion 2', (b) => ({ ...b, request: { ...b.request, contractVersion: 2 } })],
    ['note longer than 1000', (b) => { const n = 'x'.repeat(1001); b.request.note = n; b.expected.note = n; return b; }],
    ['non-string note', (b) => ({ ...b, request: { ...b.request, note: 5 }, expected: { ...b.expected, note: 5 } })],
    ['expected totalBills ≠ request totalBills', (b) => { b.expected.totalBills = 4; return b; }],
    ['extra top-level key', (b) => ({ ...b, extra: true })],
    ['null expected', (b) => ({ ...b, expected: null })],
    ['wrong protocol', (b) => ({ ...b, protocol: 'server_authoritative_v2' })],
  ];

  test.each(MALFORMED)(
    '[RED-parent] prepare refuses a binding with %s and stores nothing',
    async (_label, mutate) => {
      const { journal, prepare } = journalPair();
      const r = await prepare(IDENTITY, mutate(clone(binding())));
      expect(r).toMatchObject({ ok: false, code: 'conflict' });
      expect(await attempts(journal)).toEqual([]);
    },
  );

  test.each(MALFORMED)(
    '[RED-parent] a stored attempt with %s makes the journal read fail closed (never trusted, never ignored)',
    async (_label, mutate) => {
      const { store, journal } = journalPair();
      await store.transact(['shiftCloseIntents'], 'readwrite', (txn) =>
        txn.put('shiftCloseIntents', onlineCloseAttemptKey('S1'), rawAttempt(mutate(clone(binding())))),
      );
      expect(await journal.listOnlineCloseAttempts()).toMatchObject({ ok: false, code: 'conflict' });
    },
  );

  test('[RED-parent] a deviceId over 200 characters is refused (contract bound)', async () => {
    const id = { ...IDENTITY, deviceId: 'D'.repeat(201) };
    const b = binding();
    b.request.deviceId = id.deviceId;
    b.expected = { ...b.expected, deviceId: id.deviceId };
    const { journal, prepare } = journalPair();
    expect(await prepare(id, b)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await attempts(journal)).toEqual([]);
  });

  test('[GREEN-guard] a coherent satang-exact binding (Return 81 expected, large totals, bills 100000) is accepted and read back exactly', async () => {
    for (const expected of [
      coherent({ payOutTotal: 81, actualCashCount: 1419 }),
      coherent({ expectedCash: 9_999_999.99, actualCashCount: 10_000_499.99, startingCash: 500 }),
      coherent({ totalBills: 100_000 }),
      coherent({ actualCashCount: 0, startingCash: 0, expectedCash: 0, totalBills: 0 }),
    ]) {
      const { journal, prepare } = journalPair();
      const b = binding(expected);
      const r = await prepare(IDENTITY, b);
      expect(r.ok && r.value.kind).toBe('prepared');
      expect((await attempts(journal))[0]!.authoritative).toEqual(b);
    }
  });

  test('[GREEN-guard] a legacy attempt (no binding) is untouched by the strict schema', async () => {
    const { journal } = journalPair();
    const r = await journal.prepareOnlineCloseAttempt(IDENTITY);
    expect(r.ok && r.value.kind).toBe('prepared');
    expect((await attempts(journal))[0]).not.toHaveProperty('authoritative');
  });
});

describe('015-F1 the store finalizer refuses an authoritative attempt without server-replay proof', () => {
  test('[RED-parent] finalizeOnlineClose(snapshot, id) with NO proof on a bound attempt ⇒ conflict; nothing written; attempt retained', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const r = await journal.finalizeOnlineClose(EXPECTED, UUID_A);
    expect(r).toMatchObject({ ok: false, code: 'conflict', reason: 'attempt_authority_unproven' });
    expect(await journal.getCloseIntent('S1')).toEqual({ ok: true, value: undefined });
    expect(await attempts(journal)).toHaveLength(1);
  });

  test('[GREEN-only] a proof for another UUID / shift / snapshot / protocol is refused; the matching proof finalizes', async () => {
    const proof = { protocol: 'server_authoritative_v1' as const, shiftId: 'S1', closeCorrelationId: UUID_A, closedAtMillis: 1_760_000_000_000, snapshot: EXPECTED };
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
    const fin = journal.finalizeOnlineClose as unknown as (s: ShiftCloseIntentBusinessSnapshot, id: string, o?: undefined, p?: unknown) => ReturnType<ShiftCloseIntentJournal['finalizeOnlineClose']>;
    for (const bad of [
      { ...proof, closeCorrelationId: '22222222-2222-4222-8222-222222222222' },
      { ...proof, shiftId: 'S2' },
      { ...proof, snapshot: { ...EXPECTED, note: 'x' } },
      { ...proof, protocol: 'legacy' },
      { ...proof, closedAtMillis: Number.NaN },
      null,
      'true',
    ]) {
      expect(await fin(EXPECTED, UUID_A, undefined, bad)).toMatchObject({ ok: false, code: 'conflict', reason: 'attempt_authority_unproven' });
    }
    expect(await attempts(journal)).toHaveLength(1);
    expect(await fin(EXPECTED, UUID_A, undefined, proof)).toMatchObject({ ok: true, consumedAttempt: true });
  });

  test('[GREEN-guard] a LEGACY attempt finalizes exactly as before (no proof parameter involved)', async () => {
    const { journal } = journalPair();
    await journal.prepareOnlineCloseAttempt(IDENTITY);
    expect(await journal.finalizeOnlineClose({ ...EXPECTED }, UUID_A)).toMatchObject({ ok: true, consumedAttempt: true });
  });
});

describe('015-F3 the sweep reports every unresolved open attempt, scoped by branch and shift', () => {
  test('[RED-parent] two open attempts of different branches are both reported with their own branch/shift scope', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    let n = 0;
    const ids = [UUID_A, '33333333-3333-4333-8333-333333333333'];
    const journal = createInMemoryShiftCloseIntentJournal({ store, generateCloseCorrelationId: () => ids[n++] ?? null });
    const prepare = journal.prepareOnlineCloseAttempt as unknown as Prepare;
    const idB = { shiftId: 'S2', branchId: 'B2', staffId: 's2', staffName: 'Staff2', deviceId: 'DEV1' };
    const expB = { ...EXPECTED, ...idB };
    const bindB = binding(expB);
    bindB.request.shiftId = 'S2';
    await prepare(IDENTITY, binding());
    await prepare(idB, bindB);
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: async () => ({ ok: true, doc: shiftCloseConfirmationDocFromData({ status: 'open', closedAt: null }) }),
      normalizeSyncState: async () => 'written',
      deviceId: 'DEV1',
    });
    expect(swept.normalization.status).toBe('unresolved');
    expect([...swept.normalization.attention].sort((a, b) => String(a.shiftId).localeCompare(String(b.shiftId)))).toEqual([
      { shiftId: 'S1', branchId: 'B1', condition: 'attempt_unresolved' },
      { shiftId: 'S2', branchId: 'B2', condition: 'attempt_unresolved' },
    ]);
    expect(shiftCloseNormalizationIssue(swept.normalization)).toBe('attempt_unresolved=2');
  });

  test('[GREEN-only] a LEGACY open attempt keeps its historical (non-attention) semantics — recorded as a separate residual', async () => {
    const { journal } = journalPair();
    await journal.prepareOnlineCloseAttempt(IDENTITY);
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: reader({ ...closedDoc(EXPECTED), status: 'open', closeCorrelationId: null, closedAt: null }),
      normalizeSyncState: async () => 'written',
      deviceId: 'DEV1',
    });
    expect(swept.normalization.status).toBe('ok');
    expect(swept.normalization.attempts).toEqual({ not_closed: 1 });
  });
});
