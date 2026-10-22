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
    const r = await journal.finalizeOnlineClose(EXPECTED, UUID_A);
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
    const r = await recoverOnlineCloseAttempt(a!, { journal, readConfirmation: reader(closedDoc(EXPECTED)), deviceId: 'DEV1' });
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

  test('a still-open shift (unknown outcome, nothing committed) is not a sync failure', async () => {
    const { journal, prepare } = journalPair();
    await prepare(IDENTITY, binding());
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
