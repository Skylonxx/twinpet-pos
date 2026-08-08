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

  test('server absence with remoteCreateState none may reissue write once', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const reissue = vi.fn(async () => {
      const claim = await journal.claimRemoteCreateAttempt(created.value.shiftId);
      expect(claim.ok && claim.value).toBe('claimed');
      return 'issued' as const;
    });
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
    expect(stored.ok && stored.value?.remoteCreateState).toBe('outstanding');
  });

  test('server absence while create outstanding does not reissue (no duplicate W0)', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const claimed = await journal.claimRemoteCreateAttempt(created.value.shiftId);
    expect(claimed.ok && claimed.value).toBe('claimed');

    const reissue = vi.fn(async () => 'issued' as const);
    const first = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({ ok: true, doc: { exists: false } }),
      reissueOpenWrite: reissue,
    });
    const second = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({ ok: true, doc: { exists: false } }),
      reissueOpenWrite: reissue,
    });

    expect(first.reissued).toBe(false);
    expect(second.reissued).toBe(false);
    expect(reissue).not.toHaveBeenCalled();
    expect(first.outcome).toBe('still_pending');
    expect(second.outcome).toBe('still_pending');
  });

  test('repeated sequential absence sweeps cannot enqueue duplicate W0 while outstanding', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let issueCount = 0;
    const reissue = vi.fn(async () => {
      const claim = await journal.claimRemoteCreateAttempt(created.value.shiftId);
      if (!claim.ok || claim.value === 'already_outstanding') return 'skipped' as const;
      issueCount += 1;
      return 'issued' as const;
    });

    for (let i = 0; i < 5; i += 1) {
      await reconcileShiftOpenIntent(created.value, {
        journal,
        deviceId: 'DEV1',
        readConfirmation: async () => ({ ok: true, doc: { exists: false } }),
        reissueOpenWrite: reissue,
      });
    }

    expect(issueCount).toBe(1);
    expect(reissue).toHaveBeenCalledTimes(1);
    const stored = await journal.getOpenIntent('shift-open-1');
    expect(stored.ok && stored.value?.shiftId).toBe('shift-open-1');
    expect(stored.ok && stored.value?.remoteCreateState).toBe('outstanding');
  });

  test('concurrent absence sweeps cannot both issue W0', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let issueCount = 0;
    const reissue = vi.fn(async () => {
      const claim = await journal.claimRemoteCreateAttempt(created.value.shiftId);
      if (!claim.ok || claim.value === 'already_outstanding') return 'skipped' as const;
      issueCount += 1;
      return 'issued' as const;
    });

    const deps = {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({ ok: true as const, doc: { exists: false } }),
      reissueOpenWrite: reissue,
    };

    const [a, b, c] = await Promise.all([
      reconcileShiftOpenIntent(created.value, deps),
      reconcileShiftOpenIntent(created.value, deps),
      runShiftOpenReconciliationSweep(deps),
    ]);

    // Durable CAS + in-process single-flight: exactly one create issue.
    expect(issueCount).toBe(1);
    expect(reissue).toHaveBeenCalledTimes(1);
    // Concurrent waiters may observe the same reissued=true result; that is not a write storm.
    expect(a.outcome).toBe('still_pending');
    expect(b.outcome).toBe('still_pending');
    expect(c.every((r) => r.outcome === 'still_pending')).toBe(true);
    const stored = await journal.getOpenIntent('shift-open-1');
    expect(stored.ok && stored.value?.shiftId).toBe('shift-open-1');
    expect(stored.ok && stored.value?.remoteCreateState).toBe('outstanding');
  });

  test('safe reissue after none-state happens once; subsequent sweeps stay single-flight', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const created = await journal.upsertOpenIntent(snap());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const reissue = vi.fn(async () => {
      const claim = await journal.claimRemoteCreateAttempt(created.value.shiftId);
      if (!claim.ok || claim.value === 'already_outstanding') return 'skipped' as const;
      return 'issued' as const;
    });

    const first = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({ ok: true, doc: { exists: false } }),
      reissueOpenWrite: reissue,
    });
    const second = await reconcileShiftOpenIntent(created.value, {
      journal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({ ok: true, doc: { exists: false } }),
      reissueOpenWrite: reissue,
    });

    expect(first.reissued).toBe(true);
    expect(second.reissued).toBe(false);
    expect(reissue).toHaveBeenCalledTimes(1);
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
