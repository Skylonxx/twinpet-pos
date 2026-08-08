import { describe, expect, test, vi } from 'vitest';
import { createInMemoryShiftOpenIntentJournal } from './shiftOpenIntentStore';
import {
  reconcileShiftOpenIntent,
  runShiftOpenReconciliationSweep,
  type ShiftOpenConfirmationRead,
} from './shiftOpenReconciler';
import type { ShiftOpenIntentBusinessSnapshot } from './shiftOpenIntentTypes';

function snap(
  overrides: Partial<ShiftOpenIntentBusinessSnapshot> = {},
): ShiftOpenIntentBusinessSnapshot {
  return {
    shiftId: 'shift-open-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ ระบบ',
    startingCash: 500,
    deviceId: 'DEV1',
    ...overrides,
  };
}

function serverOpenDoc(
  overrides: Partial<{
    branchId: string;
    staffId: string;
    staffName: string;
    startingCash: number;
    openedAt: { toDate: () => Date };
  }> = {},
): ShiftOpenConfirmationRead {
  return {
    ok: true,
    doc: {
      exists: true,
      status: 'open',
      openedAt: { toDate: () => new Date('2026-08-08T10:00:00.000Z') },
      branchId: 'LDP-001',
      staffId: 'staff-1',
      staffName: 'ทดสอบ ระบบ',
      startingCash: 500,
      ...overrides,
    },
  };
}

describe('shiftOpenReconciler — PK-1', () => {
  test('confirmation-grade server match -> synced / confirmed', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => serverOpenDoc(),
    });

    expect(result.outcome).toBe('confirmed');
    expect(result.openedAtServer?.toISOString()).toBe('2026-08-08T10:00:00.000Z');
    const stored = await journal.getOpenIntent('shift-open-1');
    expect(stored.ok && stored.value?.status).toBe('synced');
  });

  test('server absence stays pending and may reissue write', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const reissue = vi.fn(async () => undefined);
    const result = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({ ok: true, doc: { exists: false } }),
      reissueOpenWrite: reissue,
    });

    expect(result.outcome).toBe('still_pending');
    expect(result.reissued).toBe(true);
    expect(reissue).toHaveBeenCalledTimes(1);
    const stored = await journal.getOpenIntent('shift-open-1');
    expect(stored.ok && stored.value?.status).toBe('local_open_pending');
  });

  test('unreachable read stays pending — never rejected', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({ ok: false }),
    });
    expect(result.outcome).toBe('unreachable');
  });

  test('identity mismatch -> rejected_manual_attention', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => serverOpenDoc({ startingCash: 1 }),
    });
    expect(result.outcome).toBe('identity_mismatch');
    const stored = await journal.getOpenIntent('shift-open-1');
    expect(stored.ok && stored.value?.status).toBe('rejected_manual_attention');
  });

  test('local markSynced failure cannot be reported as confirmed', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    vi.spyOn(journal, 'markSynced').mockResolvedValue({
      ok: false,
      code: 'unavailable',
    });

    const result = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => serverOpenDoc(),
    });
    expect(result.outcome).toBe('unreachable');
  });

  test('sweep is single-pass over this-device pending opens only', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    await journal.upsertOpenIntent(snap());
    await journal.upsertOpenIntent(snap({ shiftId: 'other', deviceId: 'DEV2' }));

    const results = await runShiftOpenReconciliationSweep({
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => serverOpenDoc(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.shiftId).toBe('shift-open-1');
    expect(results[0]?.outcome).toBe('confirmed');
  });
});
