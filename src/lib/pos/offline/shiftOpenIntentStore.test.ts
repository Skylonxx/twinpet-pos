import { describe, expect, test } from 'vitest';
import {
  createInMemoryShiftOpenIntentJournal,
  isStaleOpenPending,
} from './shiftOpenIntentStore';
import { SHIFT_OPEN_INTENT_STALE_AGE_MS } from './shiftOpenIntentTypes';
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

describe('shiftOpenIntentStore — PK-1', () => {
  test('persists a durable open-intent keyed by shiftId', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    const result = await journal.upsertOpenIntent(snap());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await journal.getOpenIntent('shift-open-1');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.status).toBe('local_open_pending');
    expect(stored.value?.startingCash).toBe(500);
    expect(typeof stored.value?.openedAtLocal).toBe('number');
  });

  test('identical upsert is idempotent — same shift identity, no duplicate', async () => {
    const journal = createInMemoryShiftOpenIntentJournal({
      now: (() => {
        let t = 1_000;
        return () => {
          t += 1;
          return t;
        };
      })(),
    });
    const first = await journal.upsertOpenIntent(snap());
    const second = await journal.upsertOpenIntent(snap());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.openedAtLocal).toBe(first.value.openedAtLocal);
    expect(second.value.shiftId).toBe(first.value.shiftId);

    const all = await journal.listOpenIntents();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(1);
  });

  test('conflicting business snapshot for same shiftId is rejected', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    await journal.upsertOpenIntent(snap());
    const conflict = await journal.upsertOpenIntent(snap({ startingCash: 999 }));
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe('conflict');
  });

  test('findPendingOpenForStaff returns this-device pending open only', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    await journal.upsertOpenIntent(snap());
    await journal.upsertOpenIntent(
      snap({ shiftId: 'other', staffId: 'staff-2', deviceId: 'DEV2' }),
    );

    const found = await journal.findPendingOpenForStaff('LDP-001', 'staff-1', 'DEV1');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.shiftId).toBe('shift-open-1');

    const missing = await journal.findPendingOpenForStaff('LDP-001', 'staff-1', 'DEV2');
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value).toBeUndefined();
  });

  test('markSynced / markRejectedManualAttention transitions', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    await journal.upsertOpenIntent(snap());

    const synced = await journal.markSynced('shift-open-1');
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.status).toBe('synced');

    const journal2 = createInMemoryShiftOpenIntentJournal();
    await journal2.upsertOpenIntent(snap({ shiftId: 'shift-open-2' }));
    const rejected = await journal2.markRejectedManualAttention('shift-open-2', 'rules denied');
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.status).toBe('rejected_manual_attention');
    expect(rejected.value.lastErrorMessage).toBe('rules denied');

    const foundRejected = await journal2.findRejectedOpenForDevice('DEV1');
    expect(foundRejected.ok).toBe(true);
    if (!foundRejected.ok) return;
    expect(foundRejected.value?.shiftId).toBe('shift-open-2');
  });

  test('rejected open cannot be silently upserted again', async () => {
    const journal = createInMemoryShiftOpenIntentJournal();
    await journal.upsertOpenIntent(snap());
    await journal.markRejectedManualAttention('shift-open-1', 'denied');
    const again = await journal.upsertOpenIntent(snap());
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('conflict');
  });

  test('isStaleOpenPending uses shared age threshold', () => {
    const now = Date.now();
    expect(
      isStaleOpenPending(
        {
          ...snap(),
          openedAtLocal: now - SHIFT_OPEN_INTENT_STALE_AGE_MS - 1,
          status: 'local_open_pending',
          createdAtLocal: now,
          updatedAtLocal: now,
          lastErrorMessage: null,
        },
        now,
      ),
    ).toBe(true);
  });
});
