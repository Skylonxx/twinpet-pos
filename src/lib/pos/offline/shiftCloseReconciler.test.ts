// Packet 7C-B2 — pure reconciliation logic. No Firestore/IndexedDB import here;
// the confirmation reader, normalizer, and journal are all injected fakes, so
// these tests exercise `reconcileShiftCloseIntent` / `runShiftCloseReconciliationSweep`
// in isolation from the network and browser storage.

import { describe, expect, test, vi } from 'vitest';
import {
  reconcileShiftCloseIntent,
  runShiftCloseReconciliationSweep,
  type ReconcileShiftCloseIntentDeps,
  type ShiftCloseConfirmationDoc,
  type ShiftCloseConfirmationRead,
} from './shiftCloseReconciler';
import { createInMemoryShiftCloseIntentJournal } from './shiftCloseIntentStore';
import type { ShiftCloseIntentEntry, ShiftCloseIntentSnapshot } from './shiftCloseIntentTypes';

const DEVICE = 'DEV1';

function makeSnapshot(overrides: Partial<ShiftCloseIntentSnapshot> = {}): ShiftCloseIntentSnapshot {
  return {
    shiftId: 'shift-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ ระบบ',
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
    closedAtLocal: Date.now(),
    deviceId: DEVICE,
    ...overrides,
  };
}

async function makeEntry(overrides: Partial<ShiftCloseIntentSnapshot> = {}): Promise<{
  journal: ReturnType<typeof createInMemoryShiftCloseIntentJournal>;
  entry: ShiftCloseIntentEntry;
}> {
  const journal = createInMemoryShiftCloseIntentJournal();
  const res = await journal.upsertCloseIntent(makeSnapshot(overrides));
  if (!res.ok) throw new Error('setup failed');
  return { journal, entry: res.value };
}

function resolvedTimestamp(d: Date): { toDate: () => Date } {
  return { toDate: () => d };
}

/** A confirmed doc whose identity matches `makeSnapshot()`'s defaults exactly. */
function makeConfirmedDoc(overrides: Partial<ShiftCloseConfirmationDoc> = {}): ShiftCloseConfirmationDoc {
  return {
    exists: true,
    status: 'closed',
    closedAt: resolvedTimestamp(new Date('2026-07-09T10:00:00.000Z')),
    closedOffline: true,
    syncState: 'pending',
    deviceId: DEVICE,
    branchId: 'LDP-001',
    staffId: 'staff-1',
    startingCash: 500,
    actualCashCount: 1500,
    variance: 0,
    expectedCash: 1000,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    payInTotal: 0,
    payOutTotal: 0,
    totalBills: 3,
    note: '',
    ...overrides,
  };
}

function reader(read: ShiftCloseConfirmationRead): ReconcileShiftCloseIntentDeps['readConfirmation'] {
  return vi.fn().mockResolvedValue(read);
}

describe('reconcileShiftCloseIntent', () => {
  test('confirmation-grade read + closed + resolved closedAt + full identity match -> confirmed', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: reader({ ok: true, doc: makeConfirmedDoc() }),
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('confirmed');
    expect(result.closedAtServer).toEqual(new Date('2026-07-09T10:00:00.000Z'));

    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('synced');
  });

  test('doc exists but status is not "closed" -> still_pending, no journal transition', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ status: 'open' }) }),
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('still_pending');
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('local_closed_pending');
  });

  test('closedAt is an unresolved estimate (no toDate) -> still_pending, never confirmed', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ closedAt: null }) }),
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('still_pending');
  });

  test('doc does not exist -> still_pending, never fabricates rejection', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: reader({ ok: true, doc: { exists: false } }),
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('still_pending');
  });

  test('reader reports unreachable (ok: false) -> unreachable, journal stays pending', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: reader({ ok: false }),
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('unreachable');
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('local_closed_pending');
  });

  test('reader throws -> treated as unreachable, never propagates', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: vi.fn().mockRejectedValue(new Error('boom')),
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('unreachable');
  });

  test('identity mismatch (actualCashCount disagrees) -> rejected_manual_attention, no totals rewrite', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ actualCashCount: 999 }) }),
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('identity_mismatch');
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('rejected_manual_attention');
    // The frozen local snapshot's own actualCashCount is never rewritten.
    expect(stored.ok && stored.value?.actualCashCount).toBe(1500);
  });

  test('identity mismatch on branchId/staffId/deviceId also flags manual attention', async () => {
    const { journal, entry } = await makeEntry();
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ deviceId: 'OTHER-DEVICE' }) }),
      deviceId: DEVICE,
    });
    expect(result.outcome).toBe('identity_mismatch');
  });

  test('device scoping: entry authored by a foreign device is never reconciled (no network call)', async () => {
    const { journal, entry } = await makeEntry({ deviceId: 'FOREIGN' });
    const readConfirmation = reader({ ok: true, doc: makeConfirmedDoc() });
    const result = await reconcileShiftCloseIntent(entry, {
      journal,
      readConfirmation,
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('still_pending');
    expect(readConfirmation).not.toHaveBeenCalled();
  });

  test('idempotent: an already-synced entry short-circuits without a network call', async () => {
    const { journal, entry } = await makeEntry();
    await journal.markSynced(entry.shiftId);
    const syncedEntry = { ...entry, status: 'synced' as const };
    const readConfirmation = reader({ ok: true, doc: makeConfirmedDoc() });

    const result = await reconcileShiftCloseIntent(syncedEntry, {
      journal,
      readConfirmation,
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('confirmed');
    expect(readConfirmation).not.toHaveBeenCalled();
  });

  test('rejected_manual_attention entry short-circuits to still_pending without a network call', async () => {
    const { journal, entry } = await makeEntry();
    await journal.markRejectedManualAttention(entry.shiftId, 'x');
    const rejectedEntry = { ...entry, status: 'rejected_manual_attention' as const };
    const readConfirmation = reader({ ok: true, doc: makeConfirmedDoc() });

    const result = await reconcileShiftCloseIntent(rejectedEntry, {
      journal,
      readConfirmation,
      deviceId: DEVICE,
    });

    expect(result.outcome).toBe('still_pending');
    expect(readConfirmation).not.toHaveBeenCalled();
  });

  describe('Variant C normalization', () => {
    test('confirmed + doc.syncState pending + own device -> one normalize write, normalized:true', async () => {
      const { journal, entry } = await makeEntry();
      const normalizeSyncState = vi.fn().mockResolvedValue(undefined);

      const result = await reconcileShiftCloseIntent(entry, {
        journal,
        readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ syncState: 'pending' }) }),
        normalizeSyncState,
        deviceId: DEVICE,
      });

      expect(result.outcome).toBe('confirmed');
      expect(result.normalized).toBe(true);
      expect(normalizeSyncState).toHaveBeenCalledTimes(1);
      expect(normalizeSyncState).toHaveBeenCalledWith('shift-1');
    });

    test('already-synced doc does not normalize', async () => {
      const { journal, entry } = await makeEntry();
      const normalizeSyncState = vi.fn().mockResolvedValue(undefined);

      const result = await reconcileShiftCloseIntent(entry, {
        journal,
        readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ syncState: 'synced' }) }),
        normalizeSyncState,
        deviceId: DEVICE,
      });

      expect(result.outcome).toBe('confirmed');
      expect(normalizeSyncState).not.toHaveBeenCalled();
    });

    test('no normalizer injected (Variant A) -> confirms without attempting any doc write', async () => {
      const { journal, entry } = await makeEntry();
      const result = await reconcileShiftCloseIntent(entry, {
        journal,
        readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ syncState: 'pending' }) }),
        deviceId: DEVICE,
      });

      expect(result.outcome).toBe('confirmed');
      expect(result.normalized).toBeUndefined();
    });

    test('normalization failure leaves the confirmed journal state intact (best-effort, no throw)', async () => {
      const { journal, entry } = await makeEntry();
      const normalizeSyncState = vi.fn().mockRejectedValue(new Error('write failed'));

      const result = await reconcileShiftCloseIntent(entry, {
        journal,
        readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ syncState: 'pending' }) }),
        normalizeSyncState,
        deviceId: DEVICE,
      });

      expect(result.outcome).toBe('confirmed');
      expect(result.normalized).toBe(false);
      const stored = await journal.getCloseIntent('shift-1');
      expect(stored.ok && stored.value?.status).toBe('synced');
    });

    test('re-running reconcile on the now-synced entry does not normalize a second time', async () => {
      const { journal, entry } = await makeEntry();
      const normalizeSyncState = vi.fn().mockResolvedValue(undefined);
      const deps: ReconcileShiftCloseIntentDeps = {
        journal,
        readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ syncState: 'pending' }) }),
        normalizeSyncState,
        deviceId: DEVICE,
      };

      await reconcileShiftCloseIntent(entry, deps);
      expect(normalizeSyncState).toHaveBeenCalledTimes(1);

      const syncedEntry = { ...entry, status: 'synced' as const };
      await reconcileShiftCloseIntent(syncedEntry, deps);
      expect(normalizeSyncState).toHaveBeenCalledTimes(1); // unchanged — no second write
    });
  });

  // Codex Finding 5 — the store API fails soft (`{ ok: false }`) on IndexedDB
  // unavailable/quota/tx failure rather than throwing. A failed local journal
  // transition write must NOT be reported as a completed transition, even when
  // the server proof itself is real.
  describe('journal transition write failure handling', () => {
    /** A journal whose transition writes fail soft, but whose reads succeed. */
    function journalWithFailingTransitions(
      base: ReturnType<typeof createInMemoryShiftCloseIntentJournal>,
    ) {
      const markSynced = vi.fn().mockResolvedValue({ ok: false as const, code: 'unavailable' as const });
      const markRejectedManualAttention = vi
        .fn()
        .mockResolvedValue({ ok: false as const, code: 'unavailable' as const });
      return {
        journal: {
          upsertCloseIntent: base.upsertCloseIntent,
          getCloseIntent: base.getCloseIntent,
          listCloseIntents: base.listCloseIntents,
          markSynced,
          markRejectedManualAttention,
        },
        markSynced,
        markRejectedManualAttention,
      };
    }

    test('failed markSynced -> unreachable (retryable), NOT confirmed, and no Variant C normalization write', async () => {
      const { journal: base, entry } = await makeEntry();
      const { journal, markSynced } = journalWithFailingTransitions(base);
      const normalizeSyncState = vi.fn().mockResolvedValue(undefined);

      const result = await reconcileShiftCloseIntent(entry, {
        journal,
        readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ syncState: 'pending' }) }),
        normalizeSyncState,
        deviceId: DEVICE,
      });

      expect(result.outcome).toBe('unreachable');
      expect(markSynced).toHaveBeenCalledTimes(1);
      // Must NOT normalize the doc while the local journal is still pending.
      expect(normalizeSyncState).not.toHaveBeenCalled();
    });

    test('failed markRejectedManualAttention -> unreachable (retryable), NOT identity_mismatch', async () => {
      const { journal: base, entry } = await makeEntry();
      const { journal, markRejectedManualAttention } = journalWithFailingTransitions(base);

      const result = await reconcileShiftCloseIntent(entry, {
        journal,
        readConfirmation: reader({ ok: true, doc: makeConfirmedDoc({ actualCashCount: 999 }) }),
        deviceId: DEVICE,
      });

      expect(result.outcome).toBe('unreachable');
      expect(markRejectedManualAttention).toHaveBeenCalledTimes(1);
    });
  });
});

describe('runShiftCloseReconciliationSweep', () => {
  test('reconciles only local_closed_pending entries authored by this device', async () => {
    const journal = createInMemoryShiftCloseIntentJournal();
    await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-own-pending' }));
    await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-foreign', deviceId: 'FOREIGN' }));
    await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-own-synced' }));
    await journal.markSynced('shift-own-synced');

    const readConfirmation = vi.fn().mockResolvedValue({ ok: true, doc: makeConfirmedDoc() });

    const results = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation,
      deviceId: DEVICE,
    });

    // Only the one own-device, still-pending entry is swept.
    expect(results).toHaveLength(1);
    expect(results[0]!.shiftId).toBe('shift-own-pending');
    expect(readConfirmation).toHaveBeenCalledTimes(1);
    expect(readConfirmation).toHaveBeenCalledWith('shift-own-pending');
  });

  test('a failed listCloseIntents() read yields no work, never throws', async () => {
    const journal = {
      upsertCloseIntent: async () => ({ ok: false as const, code: 'unavailable' as const }),
      getCloseIntent: async () => ({ ok: true as const, value: undefined }),
      listCloseIntents: async () => ({ ok: false as const, code: 'unavailable' as const }),
      markSynced: async () => ({ ok: false as const, code: 'not_found' as const }),
      markRejectedManualAttention: async () => ({ ok: false as const, code: 'not_found' as const }),
    };

    const results = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: reader({ ok: false }),
      deviceId: DEVICE,
    });

    expect(results).toEqual([]);
  });
});
