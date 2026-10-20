// Gate 007-C — the sync orchestrator's REAL shift channel (default runCh2,
// real sweep over a real fake-IndexedDB journal) publishes the shift-close W4
// normalization outcome instead of discarding it; the Sync Center reads it.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { User as FirebaseUser } from 'firebase/auth';

const fake = vi.hoisted(() => ({
  /** Authoritative legacy closed docs (pending W4) by shift id. */
  docs: new Map<string, Record<string, unknown>>(),
  w4Attempts: [] as string[],
  /** Journal method overrides applied to every journal the orchestrator creates. */
  journalOverride: {} as Record<string, unknown>,
}));

vi.mock('../deviceId', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deviceId')>()),
  getDeviceId: () => 'DEV1',
}));

vi.mock('../shiftService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shiftService')>();
  const { shiftCloseConfirmationDocFromData } = await import('./shiftCloseReconciler');
  return {
    ...actual,
    readShiftCloseConfirmation: async (id: string) => {
      const d = fake.docs.get(id);
      return d ? { ok: true as const, doc: shiftCloseConfirmationDocFromData({ ...d }) } : { ok: true as const, doc: { exists: false } };
    },
    normalizeShiftCloseSyncState: async (id: string) => {
      fake.w4Attempts.push(id);
      const d = fake.docs.get(id)!;
      if (d.syncState === 'synced') return 'already_synced' as const;
      fake.docs.set(id, { ...d, syncState: 'synced' });
      return 'written' as const;
    },
    readShiftOpenConfirmation: async () => ({ ok: false as const }),
    reissueShiftOpenWrite: async () => undefined,
  };
});

vi.mock('./shiftCloseIntentStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shiftCloseIntentStore')>();
  return {
    ...actual,
    createShiftCloseIntentJournal: (deps?: Parameters<typeof actual.createShiftCloseIntentJournal>[0]) => ({
      ...actual.createShiftCloseIntentJournal(deps),
      ...fake.journalOverride,
    }),
  };
});

import { createShiftCloseIntentJournal, SHIFT_CLOSE_INTENT_DB_NAME } from './shiftCloseIntentStore';
import {
  __resetSyncOrchestratorForTests,
  maybeStartSyncOrchestrator,
  readSyncOrchestratorState,
  requestSyncOrchestratorCycle,
  type ChannelRunResult,
  type SyncOrchestratorAuthContext,
  type SyncOrchestratorDeps,
} from './syncOrchestrator';
import { buildSyncCenterAggregate, resolveActiveSyncScope } from './syncCenterModel';

const CLOSED_AT = new Date('2026-10-19T10:00:00Z');
const uuid = (i: number) => `${i.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;

async function seedLegacy(n: number) {
  let t = 1_000;
  let id = 0;
  const journal = createShiftCloseIntentJournal({ now: () => (t += 1), generateCloseCorrelationId: () => uuid(id++) });
  for (let i = 0; i < n; i += 1) {
    const created = await journal.upsertCloseIntent({
      shiftId: `L${i}`, branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', startingCash: 500, expectedCash: 1000,
      expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 3,
      actualCashCount: 1500, variance: 0, note: '', deviceId: 'DEV1',
    });
    if (!created.ok) throw new Error('seed');
    await journal.markSynced(`L${i}`); // pre-B2.2 legacy shape
    fake.docs.set(`L${i}`, {
      status: 'closed', closedAt: { toDate: () => CLOSED_AT }, syncState: 'pending', deviceId: 'DEV1', branchId: 'LDP-001',
      staffId: 'staff-1', startingCash: 500, expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
      payInTotal: 0, payOutTotal: 0, totalBills: 3, actualCashCount: 1500, variance: 0, note: '', closeCorrelationId: uuid(i),
    });
  }
}

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(SHIFT_CLOSE_INTENT_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

const ok = (channel: ChannelRunResult['channel']) => async (): Promise<ChannelRunResult> => ({ channel, status: 'ok', itemsAdvanced: 0 });

/** Every channel stubbed EXCEPT shift_intent, which runs the production default (runCh2 omitted). */
function deps(): SyncOrchestratorDeps {
  return {
    now: () => Date.now(),
    random: () => 0.5,
    navigatorRef: { onLine: true } as unknown as Navigator,
    getClaims: async () => ({ claims: { staffId: 'staff-1' } }),
    createLookup: (() => async () => ({ exists: true })) as unknown as SyncOrchestratorDeps['createLookup'],
    runCh4: ok('offline_reversal'),
    runCh5: ok('void_intent'),
    runCh1: ok('sale_intent'),
    runCh3: ok('trusted_resume'),
    countTerminal: async () => 0,
    runPrivilegedEvidenceSweep: (async () => ({})) as unknown as SyncOrchestratorDeps['runPrivilegedEvidenceSweep'],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => undefined,
    setIntervalFn: () => 0,
    clearIntervalFn: () => undefined,
  };
}

const ctx: { current: SyncOrchestratorAuthContext } = {
  current: { session: {}, branchId: 'LDP-001', firebaseUser: { uid: 'u1' } as unknown as FirebaseUser },
};

async function runCycle() {
  const d = deps();
  maybeStartSyncOrchestrator(ctx, d);
  await requestSyncOrchestratorCycle('test', ctx, d);
  const state = readSyncOrchestratorState();
  return { state, shift: state.lastCycle?.channels.find((c) => c.channel === 'shift_intent') };
}

function lastSyncCheckAtMs(state: ReturnType<typeof readSyncOrchestratorState>) {
  const resolved = resolveActiveSyncScope('LDP-001', 'DEV1');
  if (!resolved.ok) throw new Error(resolved.reason);
  return buildSyncCenterAggregate(
    {
      scope: resolved.scope,
      reversal: { ok: true, rows: [] },
      voidIntent: { ok: true, rows: [] },
      shiftClose: { ok: true, rows: [] },
      shiftOpen: { ok: true, rows: [] },
      saleIntent: { ok: true, rows: [] },
      orchestrator: { lastCycle: state.lastCycle, webLocksAvailable: false, ch4AttemptExhaustedIds: [] },
      isOnline: true,
    },
    Date.now(),
  ).lastSyncCheckAtMs;
}

beforeEach(async () => {
  __resetSyncOrchestratorForTests();
  await deleteDb();
  fake.docs.clear();
  fake.w4Attempts.length = 0;
  fake.journalOverride = {};
});

afterEach(() => {
  __resetSyncOrchestratorForTests();
});

describe('sync orchestrator shift_intent channel — W4 normalization outcome (gate 007-C)', () => {
  test('legacy claim cannot be persisted → the published channel is FAILED with the reason; the Sync Center shows no clean last check; nothing W4-ed', async () => {
    await seedLegacy(2);
    fake.journalOverride = {
      claimLegacyNormalizationChecks: async () => ({ ok: false, code: 'unavailable', message: 'IndexedDB unavailable' }),
    };
    const { state, shift } = await runCycle();
    // Parent: { status: 'ok', itemsAdvanced: 0 } — the failure was invisible.
    expect(shift).toMatchObject({ status: 'failed', errorClass: 'shift_close_normalization:claim_failed=2' });
    expect(state.lastErrorAtMs).not.toBeNull();
    expect(lastSyncCheckAtMs(state)).toBeNull();
    expect(fake.w4Attempts).toEqual([]);
  });

  test('healthy store → channel ok with the normalization progress counted; one W4 per owed close', async () => {
    await seedLegacy(2);
    const { state, shift } = await runCycle();
    expect(shift).toMatchObject({ status: 'ok', itemsAttempted: 2, itemsAdvanced: 2 });
    expect(fake.w4Attempts.sort()).toEqual(['L0', 'L1']);
    expect(typeof lastSyncCheckAtMs(state)).toBe('number');
  });
});
