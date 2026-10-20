// @vitest-environment jsdom
// Gate 008 (Codex re-review 007 residuals) — over the REAL IndexedDB-backed
// close-intent journal (`fake-indexeddb`; a "restart" / "second window" is a
// new journal instance over the same persisted database):
//   008-A  a legacy W4 claim is a strict fence: mandatory nonblank owner,
//          positive SAFE-integer epoch that strictly increases; corrupt /
//          overflowing epochs and invalid fences fail closed (nothing written,
//          no legacy server read, no W4).
//   008-B  the sweep summary is `ok` ONLY when nothing is pending, owed,
//          failed or unknown; every other state is scoped to its close.
// Only exports that exist on the parent (`e68253a`) are imported by name, so
// the same file runs there for the red proof (new helpers via the namespace).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SHIFT_CLOSE_INTENT_DB_NAME,
  createIndexedDbShiftCloseIntentStore,
  createShiftCloseIntentJournal,
  type ShiftCloseIntentJournal,
} from './shiftCloseIntentStore';
import * as reconciler from './shiftCloseReconciler';
import {
  retryOutstandingNormalizations,
  runShiftCloseReconciliationSweep,
  shiftCloseConfirmationDocFromData,
  shiftCloseNormalizationIssue,
  type ShiftCloseConfirmationReader,
} from './shiftCloseReconciler';

const CLOSED_AT = new Date('2026-10-19T10:00:00Z');
const corr = (i: number) => `${i.toString(16).padStart(8, '0')}-3333-4333-8333-333333333333`;
const LEASE_MS = 60_000;

/** One local clock for every journal of a test (process and journal clocks move together). */
const clock = { now: 5_000_000 };
function journal(): ShiftCloseIntentJournal {
  return createShiftCloseIntentJournal({ now: () => clock.now });
}

function snapshot(shiftId: string, branchId = 'LDP-001', deviceId = 'DEV1') {
  return {
    shiftId, branchId, staffId: 'staff-1', staffName: 'ทดสอบ', startingCash: 500, expectedCash: 1000, expectedQr: 0,
    expectedKbank: 0, expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 3, actualCashCount: 1500,
    variance: 0, note: '', deviceId,
  };
}

let corrSeq = 0;
/** A journaled close, `local_closed_pending` (an offline close / a finalized online close). Returns its correlation id. */
async function seedPending(shiftId: string, branchId = 'LDP-001', deviceId = 'DEV1'): Promise<string> {
  const id = corr(corrSeq++);
  const created = await createShiftCloseIntentJournal({ now: () => clock.now, generateCloseCorrelationId: () => id }).upsertCloseIntent(
    snapshot(shiftId, branchId, deviceId),
  );
  if (!created.ok) throw new Error(`seed ${shiftId}`);
  return id;
}

/** A pre-B2.2 `synced` close (normalization field absent = W4 never checked). */
async function seedLegacy(shiftId: string, branchId = 'LDP-001', deviceId = 'DEV1'): Promise<string> {
  const id = await seedPending(shiftId, branchId, deviceId);
  const synced = await journal().markSynced(shiftId);
  if (!synced.ok) throw new Error(`seed synced ${shiftId}`);
  return id;
}

async function raw(shiftId: string): Promise<Record<string, unknown> | undefined> {
  return createIndexedDbShiftCloseIntentStore().transact(['shiftCloseIntents'], 'readonly', (txn) =>
    txn.get<Record<string, unknown>>('shiftCloseIntents', shiftId),
  );
}

async function patchRaw(shiftId: string, patch: Record<string, unknown>) {
  const current = await raw(shiftId);
  await createIndexedDbShiftCloseIntentStore().transact(['shiftCloseIntents'], 'readwrite', (txn) =>
    txn.put('shiftCloseIntents', shiftId, { ...current, ...patch }),
  );
}

/** Authoritative closed docs (W4 owed: `syncState: 'pending'`) + counters of reads, W4 API attempts and effective transitions. */
function createServer() {
  const docs = new Map<string, Record<string, unknown>>();
  const reads: string[] = [];
  const w4Attempts: string[] = [];
  const transitions: string[] = [];
  const state = { w4FailuresLeft: 0, readsFail: false };
  const close = (shiftId: string, closeCorrelationId: string, over: Record<string, unknown> = {}) => {
    docs.set(shiftId, {
      status: 'closed', closedAt: { toDate: () => CLOSED_AT }, syncState: 'pending', deviceId: 'DEV1', branchId: 'LDP-001',
      staffId: 'staff-1', startingCash: 500, expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
      payInTotal: 0, payOutTotal: 0, totalBills: 3, actualCashCount: 1500, variance: 0, note: '', closeCorrelationId, ...over,
    });
  };
  const readConfirmation: ShiftCloseConfirmationReader = async (id) => {
    reads.push(id);
    if (state.readsFail) return { ok: false };
    const d = docs.get(id);
    return d ? { ok: true, doc: shiftCloseConfirmationDocFromData({ ...d }) } : { ok: true, doc: { exists: false } };
  };
  /** The production W4 contract: one conditional transaction; a failure THROWS. */
  const normalizeSyncState = async (id: string, expected?: { closeCorrelationId: string | null; deviceId: string }) => {
    w4Attempts.push(id);
    if (state.w4FailuresLeft > 0) {
      state.w4FailuresLeft -= 1;
      throw Object.assign(new Error('W4 unavailable'), { code: 'unavailable' });
    }
    const d = docs.get(id);
    if (!d || d.status !== 'closed') return 'precondition_failed' as const;
    if (expected && (d.deviceId !== expected.deviceId || (d.closeCorrelationId ?? null) !== expected.closeCorrelationId)) {
      return 'precondition_failed' as const;
    }
    if (d.syncState === 'synced') return 'already_synced' as const;
    if (d.syncState !== 'pending') return 'precondition_failed' as const;
    docs.set(id, { ...d, syncState: 'synced' });
    transitions.push(id);
    return 'written' as const;
  };
  return { docs, reads, w4Attempts, transitions, state, close, readConfirmation, normalizeSyncState };
}

function sweepDeps(server: ReturnType<typeof createServer>, j: ShiftCloseIntentJournal = journal()) {
  return { journal: j, readConfirmation: server.readConfirmation, normalizeSyncState: server.normalizeSyncState, deviceId: 'DEV1' };
}

type Summary = {
  status: string;
  owed: number | null;
  pendingCloses?: number | null;
  counts: Record<string, number>;
  results: Array<{ shiftId: string; outcome: string; remoteW4?: string }>;
  closeCounts?: Record<string, number>;
  attention?: Array<{ shiftId: string | null; branchId: string | null; condition: string }>;
  attempted?: number;
  advanced?: number;
};
const summaryOf = (r: unknown) => (r as { normalization: Summary }).normalization;
const scoped = (s: Summary) => (s.attention ?? []).map((a) => `${a.branchId}/${a.shiftId}:${a.condition}`).sort();

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(SHIFT_CLOSE_INTENT_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await deleteDb();
  // Far from any earlier sweep: the per-device single-flight join (Date.now) never joins across tests.
  clock.now += 10 * 60_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const claimInput = (owner: unknown) =>
  ({ deviceId: 'DEV1', skipShiftIds: [], limit: 10, leaseMs: LEASE_MS, owner }) as unknown as Parameters<
    ShiftCloseIntentJournal['claimLegacyNormalizationChecks']
  >[0];

// ── 008-A ─────────────────────────────────────────────────────────────────

describe('008-A — a legacy W4 claim needs a nonblank NEW owner (runtime, not only TypeScript)', () => {
  test.each([
    ['missing (undefined)', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['a number', 42],
    ['null', null],
    ['over-long (300 chars)', 'x'.repeat(300)],
  ])('owner %s → refused with a typed reason; the record is byte-identical; nothing claimed', async (_label, owner) => {
    await seedLegacy('L0');
    const before = await raw('L0');
    const r = await journal().claimLegacyNormalizationChecks(claimInput(owner));
    // Parent: { ok: true } — the record was claimed (epoch bumped) with no owner.
    expect(r).toMatchObject({ ok: false, code: 'conflict', reason: 'owner_invalid' });
    expect(await raw('L0')).toEqual(before);
  });

  test('an expired claim of owner A at epoch 5: an owner-less claim must NOT leave A in place; a valid claim REPLACES A with the new owner at epoch 6', async () => {
    await seedLegacy('L0');
    await patchRaw('L0', {
      syncStateNormalizationCheckSeq: 5,
      syncStateNormalizationClaimOwner: 'sweep-A',
      syncStateNormalizationClaimedAtLocal: clock.now - 2 * LEASE_MS,
    });
    const before = await raw('L0');
    const ownerless = await journal().claimLegacyNormalizationChecks(claimInput(undefined));
    // Parent: ok — epoch 6 stamped while owner "sweep-A" was inherited from the old record (A's renewal would then pass).
    expect(ownerless.ok).toBe(false);
    expect(await raw('L0')).toEqual(before);
    // A's old fence still fails to renew after a proper reclaim.
    const claimed = await journal().claimLegacyNormalizationChecks(claimInput('sweep-B'));
    expect(claimed.ok && claimed.value.map((e) => [e.syncStateNormalizationClaimOwner, e.syncStateNormalizationCheckSeq])).toEqual([['sweep-B', 6]]);
    expect(await journal().renewLegacyNormalizationClaim('L0', { owner: 'sweep-A', epoch: 5 })).toEqual({ ok: true, value: 'claim_lost' });
    expect(await journal().renewLegacyNormalizationClaim('L0', { owner: 'sweep-A', epoch: 6 })).toEqual({ ok: true, value: 'claim_lost' });
    expect(await journal().renewLegacyNormalizationClaim('L0', { owner: 'sweep-B', epoch: 6 })).toEqual({ ok: true, value: 'owned' });
  });
});

const CORRUPT_EPOCHS: Array<[string, unknown]> = [
  ['Number.MAX_VALUE (MAX_VALUE + 1 === MAX_VALUE)', Number.MAX_VALUE],
  ['MAX_SAFE_INTEGER + 1 (unsafe)', Number.MAX_SAFE_INTEGER + 1],
  ['2 ** 60 (unsafe)', 2 ** 60],
  ['fractional 1.5', 1.5],
  ['negative -3', -3],
  ['zero', 0],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['a string "7"', '7'],
  ['null', null],
  ['an object', { n: 7 }],
];

describe('008-A — the persisted epoch is parsed BEFORE arithmetic; a corrupt or exhausted epoch fails closed', () => {
  test.each(CORRUPT_EPOCHS)('stored epoch %s (expired claim of an old owner) → claim refused epoch_invalid; all records byte-identical; the sweep reads / W4s nothing', async (_label, bad) => {
    const id0 = await seedLegacy('L0');
    const id1 = await seedLegacy('L1');
    await patchRaw('L0', {
      syncStateNormalizationCheckSeq: bad,
      syncStateNormalizationClaimOwner: 'sweep-OLD',
      syncStateNormalizationClaimedAtLocal: clock.now - 2 * LEASE_MS,
    });
    const before = [await raw('L0'), await raw('L1')];
    const r = await journal().claimLegacyNormalizationChecks(claimInput('sweep-NEW'));
    // Parent: ok, and for MAX_VALUE the "new" epoch equals the old one (no strict increase).
    expect(r).toMatchObject({ ok: false, code: 'conflict', reason: 'epoch_invalid' });
    expect([await raw('L0'), await raw('L1')]).toEqual(before);

    const server = createServer();
    server.close('L0', id0);
    server.close('L1', id1);
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(server.reads).toEqual([]);
    expect(server.w4Attempts).toEqual([]);
    expect(summaryOf(res)).toMatchObject({ status: 'degraded', counts: { claim_failed: 2 }, owed: 2 });
    expect([await raw('L0'), await raw('L1')]).toEqual(before);
    // The corrupt optional field never makes the close itself unreadable.
    const got = await journal().getCloseIntent('L0');
    expect(got.ok && got.value?.status).toBe('synced');
    const listed = await journal().listCloseIntents();
    expect(listed.ok && listed.value.length).toBe(2);
  });

  test('stored epoch MAX_SAFE_INTEGER → epoch_exhausted (no exact successor), nothing written, nothing read', async () => {
    const id = await seedLegacy('L0');
    await patchRaw('L0', { syncStateNormalizationCheckSeq: Number.MAX_SAFE_INTEGER, syncStateNormalizationClaimedAtLocal: clock.now - 2 * LEASE_MS });
    const before = await raw('L0');
    // Parent: ok with epoch MAX_SAFE_INTEGER + 1 (an unsafe, inexact number).
    expect(await journal().claimLegacyNormalizationChecks(claimInput('sweep-NEW'))).toMatchObject({ ok: false, reason: 'epoch_exhausted' });
    expect(await raw('L0')).toEqual(before);
    const server = createServer();
    server.close('L0', id);
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(server.reads).toEqual([]);
    expect(server.w4Attempts).toEqual([]);
    expect(summaryOf(res).status).toBe('degraded');
  });

  test('the last exact epoch is usable: MAX_SAFE_INTEGER − 1 → claimed at exactly MAX_SAFE_INTEGER (strictly larger, safe); the next claim is exhausted, never wrapped / reset / reused', async () => {
    await seedLegacy('L0');
    await patchRaw('L0', { syncStateNormalizationCheckSeq: Number.MAX_SAFE_INTEGER - 1 });
    const first = await journal().claimLegacyNormalizationChecks(claimInput('sweep-1'));
    expect(first.ok && first.value.map((e) => e.syncStateNormalizationCheckSeq)).toEqual([Number.MAX_SAFE_INTEGER]);
    clock.now += 2 * LEASE_MS;
    expect(await journal().claimLegacyNormalizationChecks(claimInput('sweep-2'))).toMatchObject({ ok: false, reason: 'epoch_exhausted' });
    expect((await raw('L0'))?.syncStateNormalizationClaimOwner).toBe('sweep-1');
  });

  test('scope of the refusal: a corrupt epoch on ANOTHER device’s legacy close, or on an already-settled close, does not block this device’s claim', async () => {
    await seedLegacy('L0');
    await seedLegacy('X0', 'LDP-001', 'DEV2');
    await seedLegacy('D0');
    await patchRaw('X0', { syncStateNormalizationCheckSeq: Number.MAX_VALUE });
    await patchRaw('D0', { syncStateNormalizationCheckSeq: Number.NaN, syncStateNormalization: 'done' });
    const r = await journal().claimLegacyNormalizationChecks(claimInput('sweep-1'));
    expect(r.ok && r.value.map((e) => [e.shiftId, e.syncStateNormalizationCheckSeq, e.syncStateNormalizationClaimOwner])).toEqual([['L0', 1, 'sweep-1']]);
  });

  test('ordinary migration: an entry WITHOUT a sequence is claimed at epoch 1; renew owned; record recorded; a stored malformed OWNER is simply replaced by the next claim', async () => {
    await seedLegacy('L0');
    await seedLegacy('L1');
    await patchRaw('L1', { syncStateNormalizationCheckSeq: 3, syncStateNormalizationClaimOwner: 99 });
    const r = await journal().claimLegacyNormalizationChecks(claimInput('sweep-1'));
    expect(r.ok && r.value.map((e) => [e.shiftId, e.syncStateNormalizationCheckSeq, e.syncStateNormalizationClaimOwner]).sort()).toEqual([
      ['L0', 4, 'sweep-1'],
      ['L1', 4, 'sweep-1'],
    ]);
    expect(await journal().renewLegacyNormalizationClaim('L0', { owner: 'sweep-1', epoch: 4 })).toEqual({ ok: true, value: 'owned' });
    const corr0 = (await raw('L0'))?.closeCorrelationId as string;
    expect(await journal().recordLegacyNormalization('L0', corr0, 'done', { owner: 'sweep-1', epoch: 4 })).toEqual({ ok: true, value: 'recorded' });
    expect((await raw('L0'))?.syncStateNormalization).toBe('done');
  });
});

describe('008-A — renew and fenced record fail closed on an invalid fence or a corrupt stored claim', () => {
  test.each([
    ['owner missing', { epoch: 1 }],
    ['owner blank', { owner: ' ', epoch: 1 }],
    ['epoch fractional', { owner: 'sweep-1', epoch: 1.5 }],
    ['epoch MAX_VALUE', { owner: 'sweep-1', epoch: Number.MAX_VALUE }],
    ['epoch a string', { owner: 'sweep-1', epoch: '1' }],
    ['epoch 0', { owner: 'sweep-1', epoch: 0 }],
  ])('fence %s → refused fence_invalid, nothing written (renew and record)', async (_label, fence) => {
    await seedLegacy('L0');
    await journal().claimLegacyNormalizationChecks(claimInput('sweep-1'));
    const before = await raw('L0');
    const f = fence as unknown as { owner: string; epoch: number };
    // Parent: a structured `claim_lost` (indistinguishable from a handover).
    expect(await journal().renewLegacyNormalizationClaim('L0', f)).toMatchObject({ ok: false, reason: 'fence_invalid' });
    expect(await journal().recordLegacyNormalization('L0', before?.closeCorrelationId as string, 'done', f)).toMatchObject({ ok: false, reason: 'fence_invalid' });
    expect(await raw('L0')).toEqual(before);
  });

  test.each([
    ['epoch corrupted to MAX_VALUE', { syncStateNormalizationCheckSeq: Number.MAX_VALUE }],
    ['epoch corrupted to a string', { syncStateNormalizationCheckSeq: '1' }],
    ['owner corrupted to a number', { syncStateNormalizationClaimOwner: 7 }],
    ['owner corrupted to blank', { syncStateNormalizationClaimOwner: '' }],
  ])('claimed entry %s while the sweep waits on its read → renew refused epoch_invalid → claim_failed, NO W4, degraded; record bytes kept', async (_label, corruption) => {
    const id = await seedLegacy('L0');
    const server = createServer();
    server.close('L0', id);
    const inner = server.readConfirmation;
    let snapshotAfterCorruption: Record<string, unknown> | undefined;
    const corruptingRead: ShiftCloseConfirmationReader = async (shiftId) => {
      await patchRaw('L0', corruption);
      snapshotAfterCorruption = await raw('L0');
      return inner(shiftId);
    };
    const res = await runShiftCloseReconciliationSweep({ ...sweepDeps(server), readConfirmation: corruptingRead });
    expect(server.w4Attempts).toEqual([]);
    // Parent: claim_lost and status ok.
    expect(summaryOf(res).results).toEqual([{ shiftId: 'L0', outcome: 'claim_failed' }]);
    expect(summaryOf(res).status).toBe('degraded');
    expect(await raw('L0')).toEqual(snapshotAfterCorruption);
  });
});

describe('008-A — fence across windows and restarts (real journal instances over one database)', () => {
  test('two windows claim at the same instant with distinct owners → DISJOINT entries; each fence is held by exactly its owner; epochs strictly increase', async () => {
    for (let i = 0; i < 4; i += 1) await seedLegacy(`L${i}`);
    const [a, b] = await Promise.all([
      journal().claimLegacyNormalizationChecks({ deviceId: 'DEV1', skipShiftIds: [], limit: 2, leaseMs: LEASE_MS, owner: 'win-A' }),
      journal().claimLegacyNormalizationChecks({ deviceId: 'DEV1', skipShiftIds: [], limit: 2, leaseMs: LEASE_MS, owner: 'win-B' }),
    ]);
    if (!a.ok || !b.ok) throw new Error('claims');
    const ids = [...a.value, ...b.value].map((e) => e.shiftId);
    expect(new Set(ids).size).toBe(4);
    const epochA = a.value[0]!.syncStateNormalizationCheckSeq!;
    const epochB = b.value[0]!.syncStateNormalizationCheckSeq!;
    expect(epochA).not.toBe(epochB);
    for (const e of a.value) {
      expect(await journal().renewLegacyNormalizationClaim(e.shiftId, { owner: 'win-A', epoch: epochA })).toEqual({ ok: true, value: 'owned' });
      expect(await journal().renewLegacyNormalizationClaim(e.shiftId, { owner: 'win-B', epoch: epochB })).toEqual({ ok: true, value: 'claim_lost' });
    }
  });

  test('restart: a brand-new journal sees the persisted owner + epoch; after the lease a re-claim gets a strictly larger epoch and the pre-restart fence is lost', async () => {
    await seedLegacy('L0');
    const first = await journal().claimLegacyNormalizationChecks(claimInput('before-restart'));
    if (!first.ok) throw new Error('claim');
    const fence = { owner: 'before-restart', epoch: first.value[0]!.syncStateNormalizationCheckSeq! };
    const restarted = journal();
    expect(await restarted.renewLegacyNormalizationClaim('L0', fence)).toEqual({ ok: true, value: 'owned' });
    clock.now += 2 * LEASE_MS;
    const second = await journal().claimLegacyNormalizationChecks(claimInput('after-restart'));
    expect(second.ok && second.value[0]!.syncStateNormalizationCheckSeq).toBe(fence.epoch + 1);
    expect(await journal().renewLegacyNormalizationClaim('L0', fence)).toEqual({ ok: true, value: 'claim_lost' });
  });
});

// ── 008-B ─────────────────────────────────────────────────────────────────

describe('008-B — a confirmed close with an unfinished W4 is never a clean sweep', () => {
  test('pending close → markSynced persisted (outstanding) → remote W4 THROWS → synced/outstanding, owed 1, unresolved and scoped; a later successful W4 → done, owed 0, ok', async () => {
    const id = await seedPending('shift-A', 'LDP-001');
    const server = createServer();
    server.close('shift-A', id);
    server.state.w4FailuresLeft = 1;
    const first = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(first).toEqual([expect.objectContaining({ shiftId: 'shift-A', outcome: 'confirmed', normalized: false })]);
    expect((await raw('shift-A'))).toMatchObject({ status: 'synced', syncStateNormalization: 'outstanding' });
    // Parent: status 'ok' with owed 1.
    expect(summaryOf(first)).toMatchObject({ status: 'unresolved', owed: 1, pendingCloses: 0 });
    expect(scoped(summaryOf(first))).toEqual(['LDP-001/shift-A:w4_failed']);
    expect(shiftCloseNormalizationIssue(summaryOf(first) as never)).toBe('w4_failed=1');
    expect(server.transitions).toEqual([]);

    const second = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(summaryOf(second)).toMatchObject({ status: 'ok', owed: 0, pendingCloses: 0, attention: [], results: [{ shiftId: 'shift-A', outcome: 'normalized', remoteW4: 'written' }] });
    expect(shiftCloseNormalizationIssue(summaryOf(second) as never)).toBeNull();
    expect(server.transitions).toEqual(['shift-A']);
    expect((await raw('shift-A'))?.syncStateNormalization).toBe('done');
  });

  test('existing synced/outstanding close → its retry W4 fails (retry_later) → not ok; the read failing too → not ok; later success → ONE effective transition, ok', async () => {
    const id = await seedPending('shift-A');
    const server = createServer();
    server.close('shift-A', id);
    server.state.w4FailuresLeft = 1;
    await runShiftCloseReconciliationSweep(sweepDeps(server)); // records outstanding; W4 #1 fails
    server.state.w4FailuresLeft = 1;
    const retry = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(summaryOf(retry).results).toEqual([{ shiftId: 'shift-A', outcome: 'retry_later', remoteW4: 'failed' }]);
    // Parent: { status: 'ok', counts: { retry_later: 1 }, owed: 1 }.
    expect(summaryOf(retry)).toMatchObject({ status: 'unresolved', owed: 1 });
    expect(scoped(summaryOf(retry))).toEqual(['LDP-001/shift-A:w4_failed']);
    server.state.readsFail = true;
    const unreadable = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(summaryOf(unreadable)).toMatchObject({ status: 'unresolved', counts: { retry_later: 1 }, owed: 1 });
    expect(scoped(summaryOf(unreadable))).toEqual(['LDP-001/shift-A:retry_later']);
    server.state.readsFail = false;
    const healed = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(summaryOf(healed)).toMatchObject({ status: 'ok', owed: 0, attention: [] });
    expect(server.w4Attempts).toEqual(['shift-A', 'shift-A', 'shift-A']);
    expect(server.transitions).toEqual(['shift-A']);
  });
});

describe('008-B — a failed local journal transition of a pending close is never a clean sweep', () => {
  test('server proof valid, markSynced returns { ok: false } → NO W4; degraded despite a synced-only owed count of 0; recovers only once the transition persists', async () => {
    const id = await seedPending('shift-A', 'LDP-002');
    const server = createServer();
    server.close('shift-A', id, { branchId: 'LDP-002' });
    const down = { ...journal(), markSynced: async () => ({ ok: false as const, code: 'unavailable' as const, message: 'IndexedDB unavailable' }) };
    for (let i = 0; i < 2; i += 1) {
      const res = await runShiftCloseReconciliationSweep(sweepDeps(server, down as ShiftCloseIntentJournal));
      expect(res).toEqual([expect.objectContaining({ shiftId: 'shift-A', outcome: 'unreachable', journalWriteFailed: 'mark_synced' })]);
      // Parent: { status: 'ok', owed: 0 } — the failed durable transition was invisible.
      expect(summaryOf(res)).toMatchObject({ status: 'degraded', owed: 0, pendingCloses: 1, closeCounts: { journal_write_failed: 1 } });
      expect(scoped(summaryOf(res))).toEqual(['LDP-002/shift-A:close_journal_write_failed']);
      expect(server.w4Attempts).toEqual([]);
      expect((await raw('shift-A'))?.status).toBe('local_closed_pending');
    }
    const healed = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(healed).toEqual([expect.objectContaining({ shiftId: 'shift-A', outcome: 'confirmed', normalized: true, normalizationRecorded: true })]);
    expect(summaryOf(healed)).toMatchObject({ status: 'ok', owed: 0, pendingCloses: 0, attention: [] });
    expect(server.transitions).toEqual(['shift-A']);
  });

  test('server proves a MISMATCH but the manual-attention transition does not persist → degraded (distinct reason), no W4; once it persists the close is settled (rejected) and the sweep is ok', async () => {
    const id = await seedPending('shift-A');
    const server = createServer();
    server.close('shift-A', id, { actualCashCount: 9999, variance: 8499 });
    const down = { ...journal(), markRejectedManualAttention: async () => ({ ok: false as const, code: 'quota' as const }) };
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server, down as ShiftCloseIntentJournal));
    expect(res).toEqual([expect.objectContaining({ outcome: 'unreachable', journalWriteFailed: 'mark_rejected_manual_attention' })]);
    // Parent: { status: 'ok', owed: 0 }.
    expect(summaryOf(res)).toMatchObject({ status: 'degraded', pendingCloses: 1 });
    expect(scoped(summaryOf(res))).toEqual(['LDP-001/shift-A:close_journal_write_failed']);
    const healed = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(healed.map((r) => r.outcome)).toEqual(['identity_mismatch']);
    expect(summaryOf(healed)).toMatchObject({ status: 'ok', pendingCloses: 0 });
    expect(server.w4Attempts).toEqual([]);
  });

  test('a pending close the server has not confirmed yet (open doc) or could not be read → unresolved, scoped (never ok)', async () => {
    const idA = await seedPending('shift-A');
    await seedPending('shift-B', 'LDP-009');
    const server = createServer();
    server.docs.set('shift-A', { status: 'open', branchId: 'LDP-001', closeCorrelationId: idA });
    const res = await runShiftCloseReconciliationSweep({
      ...sweepDeps(server),
      readConfirmation: async (shiftId) => (shiftId === 'shift-B' ? { ok: false } : server.readConfirmation(shiftId)),
    });
    expect(res.map((r) => r.outcome).sort()).toEqual(['still_pending', 'unreachable']);
    // Parent: status 'ok'.
    expect(summaryOf(res)).toMatchObject({ status: 'unresolved', pendingCloses: 2 });
    expect(scoped(summaryOf(res))).toEqual(['LDP-001/shift-A:close_unconfirmed', 'LDP-009/shift-B:close_unreachable']);
  });
});

describe('008-B — failed claim / unreadable or unknown journal state', () => {
  test('claim persistence fails → no legacy server read / W4, claim_failed, degraded', async () => {
    const id = await seedLegacy('L0');
    const server = createServer();
    server.close('L0', id);
    const down = { ...journal(), claimLegacyNormalizationChecks: async () => ({ ok: false as const, code: 'tx_failed' as const }) };
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server, down as ShiftCloseIntentJournal));
    expect(server.reads).toEqual([]);
    expect(server.w4Attempts).toEqual([]);
    expect(summaryOf(res)).toMatchObject({ status: 'degraded', counts: { claim_failed: 1 }, owed: 1 });
    expect(scoped(summaryOf(res))).toEqual(['LDP-001/L0:claim_failed']);
  });

  test('the journal cannot be listed → journal_unreadable, a scoped-UNKNOWN item (no invented shift), nothing read', async () => {
    const server = createServer();
    const down = { ...journal(), listCloseIntents: async () => ({ ok: false as const, code: 'unavailable' as const }) };
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server, down as ShiftCloseIntentJournal));
    expect(summaryOf(res)).toMatchObject({ status: 'journal_unreadable', owed: null });
    expect(summaryOf(res).attention).toEqual([{ shiftId: null, branchId: null, condition: 'journal_unreadable' }]);
    expect(server.reads).toEqual([]);
  });

  test('the journal list THROWS → still a resolved journal_unreadable summary (never a rejected sweep)', async () => {
    const server = createServer();
    const throwing = { ...journal(), listCloseIntents: async () => { throw new Error('disk I/O error'); } };
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server, throwing as unknown as ShiftCloseIntentJournal));
    // Parent: the sweep promise rejected.
    expect(summaryOf(res).status).toBe('journal_unreadable');
  });

  test('the FINAL state cannot be read after the work → owed / pending UNKNOWN (null, never 0) → degraded owed_unreadable', async () => {
    const id = await seedPending('shift-A');
    const server = createServer();
    server.close('shift-A', id);
    const base = journal();
    let lists = 0;
    const flaky = {
      ...base,
      listCloseIntents: async () => {
        lists += 1;
        return lists <= 2 ? base.listCloseIntents() : { ok: false as const, code: 'unavailable' as const };
      },
    };
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server, flaky as ShiftCloseIntentJournal));
    expect(summaryOf(res)).toMatchObject({ status: 'degraded', owed: null, pendingCloses: null });
    expect(summaryOf(res).attention).toEqual([{ shiftId: null, branchId: null, condition: 'owed_unreadable' }]);
  });

  test('the online close attempts cannot be listed → degraded attempts_unreadable (was silently [])', async () => {
    const server = createServer();
    const down = { ...journal(), listOnlineCloseAttempts: async () => ({ ok: false as const, code: 'unavailable' as const }) };
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server, down as ShiftCloseIntentJournal));
    // Parent: status 'ok'.
    expect(summaryOf(res)).toMatchObject({ status: 'degraded', attempts: null });
    expect(summaryOf(res).attention).toEqual([{ shiftId: null, branchId: null, condition: 'attempts_unreadable' }]);
  });
});

describe('008-B — healthy and summary-shape guards', () => {
  test('no-op healthy device → ok, nothing scoped, owed 0 / pending 0 — distinct from a confirmed close whose W4 is pending', async () => {
    const server = createServer();
    const res = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(summaryOf(res)).toMatchObject({ status: 'ok', owed: 0, pendingCloses: 0, attention: [], attempted: 0, advanced: 0 });
    expect(Object.keys(res)).toEqual([]); // the summary stays non-enumerable (array callers unchanged)
    expect(res).toEqual([]);
  });

  test('more legacy closes than one sweep may check → the unchecked rest is still OWED (w4_owed), so the sweep is not ok until all are done', async () => {
    const server = createServer();
    for (let i = 0; i < 11; i += 1) server.close(`L${i}`, await seedLegacy(`L${i}`));
    const first = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(server.transitions).toHaveLength(10);
    // Parent: status 'ok' with owed 1.
    expect(summaryOf(first)).toMatchObject({ status: 'unresolved', owed: 1 });
    expect(summaryOf(first).attention?.map((a) => a.condition)).toEqual(['w4_owed']);
    clock.now += 2 * LEASE_MS;
    const second = await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(summaryOf(second)).toMatchObject({ status: 'ok', owed: 0 });
    expect(server.transitions).toHaveLength(11);
  });

  test('a lost claim whose new owner already settled the close is a clean handover; one still being worked is unresolved', async () => {
    const id = await seedLegacy('L0');
    const server = createServer();
    server.close('L0', id);
    // Another sweep re-claims L0 while this one waits on its read, and does not finish.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ShiftCloseConfirmationReader = async (shiftId) => {
      await gate;
      return server.readConfirmation(shiftId);
    };
    const mine = runShiftCloseReconciliationSweep({ ...sweepDeps(server), readConfirmation: slow });
    for (let i = 0; i < 100 && (await raw('L0'))?.syncStateNormalizationClaimOwner === undefined; i += 1) await new Promise((r) => setTimeout(r, 5));
    clock.now += 2 * LEASE_MS;
    expect((await journal().claimLegacyNormalizationChecks(claimInput('other-sweep'))).ok).toBe(true);
    release();
    const res = await mine;
    expect(summaryOf(res).results).toEqual([{ shiftId: 'L0', outcome: 'claim_lost' }]);
    // Parent: 'ok' although the close is still owed and its new owner has not settled it.
    expect(summaryOf(res)).toMatchObject({ status: 'unresolved', owed: 1 });
    expect(scoped(summaryOf(res))).toEqual(['LDP-001/L0:claim_lost']);
    expect(server.w4Attempts).toEqual([]);
  });

  test('scoped key: the same count on another shift / branch is a DIFFERENT key; an unchanged state is the same key; ok has none', () => {
    const key = (reconciler as Record<string, unknown>).shiftCloseAttentionKey as ((s: unknown) => string | null) | undefined;
    expect(typeof key).toBe('function');
    const s = (shiftId: string, branchId: string) => ({
      status: 'degraded', results: [], counts: { claim_failed: 1 }, owed: 1, attention: [{ shiftId, branchId, condition: 'claim_failed' }],
    });
    expect(key!(s('shift-A', 'B1'))).toBe(key!(s('shift-A', 'B1')));
    expect(key!(s('shift-A', 'B1'))).not.toBe(key!(s('shift-B', 'B1')));
    expect(key!(s('shift-A', 'B1'))).not.toBe(key!(s('shift-A', 'B2')));
    expect(key!({ status: 'ok', results: [], counts: {}, owed: 0, attention: [] })).toBeNull();
  });

  test('retryOutstandingNormalizations (legacy array API) is unchanged for a healthy owed close', async () => {
    const id = await seedPending('shift-A');
    const server = createServer();
    server.close('shift-A', id);
    server.state.w4FailuresLeft = 1;
    await runShiftCloseReconciliationSweep(sweepDeps(server));
    expect(await retryOutstandingNormalizations(sweepDeps(server))).toEqual([{ shiftId: 'shift-A', outcome: 'normalized', remoteW4: 'written' }]);
  });
});
