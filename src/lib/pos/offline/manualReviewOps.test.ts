import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildManualReviewResolvePayload,
  canViewManualReviewOps,
} from './manualReviewOps';
import {
  createOfflineReversal,
  listQueue,
  readLocalStock,
  resolveManualReview,
} from './offlineReversalQueue';
import { ManualReviewResolveError } from './offlineReversalLogic';
import { createInMemoryReversalStore } from './reversalLocalStore';
import { recordEvidenceRejection } from './recordEvidenceRejection';
import { listReversalRejections } from './reversalRejectionLog';
import type { CreateReversalInput, OfflineReversalIntent } from './offlineReversalTypes';

// ─── Authority gate ──────────────────────────────────────────────────────────

describe('canViewManualReviewOps', () => {
  test('Manager and Admin may view/execute', () => {
    expect(canViewManualReviewOps('manager')).toBe(true);
    expect(canViewManualReviewOps('admin')).toBe(true);
  });

  test('standard Staff cannot — and neither can unknown/absent roles', () => {
    expect(canViewManualReviewOps('staff')).toBe(false);
    expect(canViewManualReviewOps(null)).toBe(false);
    expect(canViewManualReviewOps(undefined)).toBe(false);
    expect(canViewManualReviewOps('cashier')).toBe(false);
  });
});

// ─── Payload mapping ─────────────────────────────────────────────────────────

describe('buildManualReviewResolvePayload', () => {
  test('Manager/Admin maps actor + form to the exact resolve payload (with note)', () => {
    const res = buildManualReviewResolvePayload(
      { id: 'mgr-1', role: 'manager' },
      { reasonCode: 'reconciled_in_firestore', note: 'นับแล้ว' },
    );
    expect(res).toEqual({
      ok: true,
      input: {
        resolvedByStaffId: 'mgr-1',
        resolvedByRole: 'manager',
        reasonCode: 'reconciled_in_firestore',
        note: 'นับแล้ว',
      },
    });
  });

  test('omits note when blank/whitespace and trims reasonCode', () => {
    const res = buildManualReviewResolvePayload(
      { id: 'admin-1', role: 'admin' },
      { reasonCode: '  fixed  ', note: '   ' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.reasonCode).toBe('fixed');
      expect('note' in res.input).toBe(false);
    }
  });

  test('missing reasonCode blocks submission', () => {
    const res = buildManualReviewResolvePayload(
      { id: 'mgr-1', role: 'manager' },
      { reasonCode: '   ' },
    );
    expect(res).toEqual({ ok: false, error: 'missing_reason' });
  });

  test('Staff (or missing actor id) is unauthorized — cannot build a payload', () => {
    expect(
      buildManualReviewResolvePayload({ id: 'stf-1', role: 'staff' }, { reasonCode: 'x' }),
    ).toEqual({ ok: false, error: 'unauthorized' });
    expect(
      buildManualReviewResolvePayload({ id: null, role: 'manager' }, { reasonCode: 'x' }),
    ).toEqual({ ok: false, error: 'unauthorized' });
  });
});

// ─── Integration with the real H2 helper (device-local store, no Firestore) ──

const createInput: CreateReversalInput = {
  businessId: 'b1',
  sourceType: 'receiving',
  sourceId: 'GRN-001',
  action: 'void',
  createdByStaffId: 'mgr-1',
  actorRole: 'manager',
  branchId: 'b1',
  reasonCode: 'mis-entry',
  originalEffects: [{ productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: 5 }],
};

let store: ReturnType<typeof createInMemoryReversalStore>;
beforeEach(() => {
  store = createInMemoryReversalStore();
});

async function seedManualReviewIntent(): Promise<OfflineReversalIntent> {
  const intent = await createOfflineReversal(store, createInput, { now: () => '2026-06-10T00:00:00.000Z' });
  return store.transact(['intents'], 'readwrite', async (txn) => {
    const manual: OfflineReversalIntent = { ...intent, status: 'manual_review_required' };
    await txn.put('intents', intent.id, manual);
    return manual;
  });
}

describe('Manual Review Ops — built payload drives resolveManualReview (local only)', () => {
  test('a Manager/Admin payload resolves the local intent and drops it from the queue', async () => {
    const seeded = await seedManualReviewIntent();
    const counterBefore = await readLocalStock(store, 'p1', 'b1'); // -5 applied at create

    const payload = buildManualReviewResolvePayload(
      { id: 'mgr-9', role: 'manager' },
      { reasonCode: 'reconciled_in_firestore', note: 'ok' },
    );
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    const result = await resolveManualReview(store, seeded.id, payload.input);
    expect(result.outcome).toBe('resolved');
    expect(result.intent!.status).toBe('manual_review_resolved');

    // No more manual_review_required rows for the page to show.
    expect(await listQueue(store, ['manual_review_required'])).toHaveLength(0);
    // No stock mutation by the resolve path — internal counter unchanged.
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(counterBefore);
  });

  test('a Staff attempt is blocked at the payload boundary (no resolve call possible)', async () => {
    const seeded = await seedManualReviewIntent();
    const payload = buildManualReviewResolvePayload({ id: 'stf-1', role: 'staff' }, { reasonCode: 'x' });
    expect(payload.ok).toBe(false);

    // Even if a caller bypassed the gate and forced the H2 helper with a staff role,
    // the helper itself throws — proving defense-in-depth.
    await expect(
      resolveManualReview(store, seeded.id, {
        resolvedByStaffId: 'stf-1',
        resolvedByRole: 'staff',
        reasonCode: 'x',
      }),
    ).rejects.toBeInstanceOf(ManualReviewResolveError);
    // Intent untouched.
    expect((await listQueue(store, ['manual_review_required']))[0].id).toBe(seeded.id);
  });

  test('the page data source lists ONLY manual_review_required (device-local queue)', async () => {
    await seedManualReviewIntent();
    // A second, still-queued intent must NOT appear in the manual-review view.
    await createOfflineReversal(
      store,
      { ...createInput, sourceId: 'GRN-002' },
      { now: () => '2026-06-10T00:00:01.000Z' },
    );
    const rows = await listQueue(store, ['manual_review_required']);
    expect(rows.map((r) => r.sourceId)).toEqual(['GRN-001']);
  });

  test('does not call any network/Firestore path (only the local queue helper)', async () => {
    // Guard: make any network call blow up; the local resolve must never reach one.
    const original = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error('network not allowed in manual-review resolve');
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const seeded = await seedManualReviewIntent();
      const payload = buildManualReviewResolvePayload({ id: 'mgr-9', role: 'manager' }, { reasonCode: 'r' });
      if (!payload.ok) throw new Error('payload should be ok');
      const result = await resolveManualReview(store, seeded.id, payload.input);
      expect(result.outcome).toBe('resolved');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ─── H7-G: durable rejection log read path (the panel's data source, device-local) ──
// The page reads ONLY through `listReversalRejections(store)`. These prove the read path
// the new read-only panel depends on, against the same store abstraction the page uses.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('H7-G: Manual Review Ops durable rejection panel — read path', () => {
  test('reads recorded rejections back newest-first through the shared store', async () => {
    const s = createInMemoryReversalStore();
    // Serialized (flush between) — distinct real rejections occur sequentially, and the
    // fire-and-forget helper offers no handle to await.
    recordEvidenceRejection(s, {
      sourceType: 'receiving',
      sourceId: 'GRN-1',
      branchId: 'b1',
      evidenceCode: 'missing_lot_id',
      evidenceMessage: 'msg-recv',
      staffId: 'mgr-1',
      now: () => '2026-06-12T08:00:00.000Z',
    });
    await flush();
    recordEvidenceRejection(s, {
      sourceType: 'transfer',
      sourceId: 'TR-1',
      branchId: 'b2',
      evidenceCode: 'header_total_qty_mismatch',
      evidenceMessage: 'msg-tr',
      staffId: 'mgr-2',
      now: () => '2026-06-12T09:00:00.000Z',
    });
    await flush();

    const rows = await listReversalRejections(s);
    expect(rows.map((r) => r.sourceId)).toEqual(['TR-1', 'GRN-1']); // newest-first
    // Only the safe, page-displayed fields carry the expected values.
    expect(rows[0]).toMatchObject({
      sourceType: 'transfer',
      sourceId: 'TR-1',
      branchId: 'b2',
      evidenceCode: 'header_total_qty_mismatch',
      evidenceMessage: 'msg-tr',
      staffId: 'mgr-2',
      createdAt: '2026-06-12T09:00:00.000Z',
    });
  });

  test('an empty store yields an empty list (page renders its empty state)', async () => {
    const s = createInMemoryReversalStore();
    expect(await listReversalRejections(s)).toEqual([]);
  });

  // GUARD — in-memory store concurrent-write ordering artifact (documented in 7C-A).
  // The in-memory store double commits a readwrite transaction by REPLACING the whole store
  // map with its working copy. Two transactions started concurrently snapshot the same
  // baseline, so the last to commit overwrites the other's distinct-key write (last-commit-
  // wins). This is a property of the TEST DOUBLE only — real IndexedDB serializes readwrite
  // transactions per object store, so production code is unaffected. The consequence for
  // tests: fire-and-forget writes (as in the newest-first read-path test above) MUST be
  // serialized (await/flush between), or a write is silently lost. This guard pins the safe
  // sequential contract so a future "simplification" that drops the serialization is caught.
  test('GUARD: serialized readwrite txns to distinct keys both persist (in-memory double)', async () => {
    const s = createInMemoryReversalStore();
    await s.transact(['rejections'], 'readwrite', async (txn) => {
      await txn.put('rejections', 'k1', { id: 1 });
    });
    await s.transact(['rejections'], 'readwrite', async (txn) => {
      await txn.put('rejections', 'k2', { id: 2 });
    });
    const all = await s.transact(['rejections'], 'readonly', (txn) => txn.getAll('rejections'));
    expect(all).toHaveLength(2);
  });
});

// ─── H7-G: ManualReviewOpsPage.tsx panel (source-level, per H6-D2/H7-E precedent) ──
// The page carries a heavy Firebase/router/auth/modal harness, so panel guarantees are
// proven by static `?raw` source inspection rather than mounting. Assertions target
// structural/safety INTENT (presence, region-scoped absence, single-use) rather than
// brittle whole-page formatting details or exact element counts (stabilized in 7C-A).

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Narrow the page source to JUST the durable-rejection panel region — from its marker
 * comment to the start of the resolve `Modal` — so structural assertions ("no action
 * affordance inside the panel") target the panel itself and are immune to harmless changes
 * elsewhere on the page (and to the page's total button count).
 */
function rejectionPanelRegion(source: string): string {
  const start = source.indexOf('Phase 7B-H7-G — Durable rejection log');
  const end = source.indexOf('<Modal show={target');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('H7-G: ManualReviewOpsPage.tsx durable rejection panel (source-level)', () => {
  let source: string;
  beforeEach(async () => {
    source = (await import('../../../pages/ManualReviewOpsPage.tsx?raw')).default;
  });

  test('reads the durable log only via listReversalRejections(store)', () => {
    expect(source).toContain('listReversalRejections(store)');
    expect(source).toContain('refreshRejections');
  });

  test('introduces NO write/mutation API for rejections', () => {
    // No durable-log write bridge and no direct store write are reachable from the page.
    expect(source).not.toContain('recordEvidenceRejection');
    expect(source).not.toContain('recordReversalRejection');
  });

  test('reuses the existing Manager/Admin gate (no second gate)', () => {
    // The panel load is gated on the same `canResolve` flag; the whole page early-returns
    // the not-authorized Alert before the panel renders.
    expect(source).toContain('canViewManualReviewOps(user?.role)');
    expect(source).toMatch(/if \(!canResolve\)/);
    expect(source).toContain('เฉพาะผู้จัดการ/ผู้ดูแลระบบ');
  });

  test('the rejection loader is gated and clears data for non-authorized roles', () => {
    expect(source).toMatch(/refreshRejections[\s\S]*?if \(!canResolve\)[\s\S]*?setRejections\(\[\]\)/);
  });

  test('the durable rejection panel is read-only — NO button or action affordance inside it', () => {
    // Intent over count: scope to the panel region and assert it carries no <Button> and no
    // action/mutation wiring (resolve/delete/retry/sync/export), instead of pinning a brittle
    // whole-page `<Button>` total that any unrelated layout change would break.
    const panel = rejectionPanelRegion(source);
    expect(panel).not.toContain('<Button');
    for (const affordance of ['onClick', 'openResolve', 'submitResolve', 'resolveManualReview']) {
      expect(panel).not.toContain(affordance);
    }
  });

  test('the existing manual-review QUEUE retains its resolve action (outside the panel)', () => {
    // Stabilization must not silently drop the queue's resolve affordance: assert it still
    // exists (the row resolve button wiring + the modal confirm), independent of any count.
    expect(source).toContain('onClick={() => openResolve(it)}');
    expect(source).toContain('void submitResolve()');
  });

  test('displays only the safe H7-A record fields', () => {
    for (const field of [
      'r.createdAt',
      'r.sourceType',
      'r.sourceId',
      'r.branchId',
      'r.evidenceCode',
      'r.evidenceMessage',
      'r.staffId',
    ]) {
      expect(source).toContain(field);
    }
  });

  test('recordId is internal-only — used exactly once, as the React row key, never rendered', () => {
    // Robust over spacing/layout: `r.recordId` must appear EXACTLY ONCE, and that single use
    // is the row `key` (an internal React concern), so it can never reach a visible cell or
    // a `title`. Adding any displayed recordId cell would push the count to 2 and fail here.
    expect(countOccurrences(source, 'r.recordId')).toBe(1);
    expect(source).toContain('key={r.recordId}');
  });

  test('does NOT expose hashes or other non-display record internals', () => {
    expect(source).not.toContain('serializeReversalRejectionRecord');
    expect(source).not.toContain('observedDocumentUpdatedAt');
  });

  test('clearly labels the panel as a local-device-only forensic log', () => {
    expect(source).toContain('บันทึกการปฏิเสธหลักฐาน (อุปกรณ์นี้)');
    expect(source).toContain('เฉพาะเครื่องนี้');
    expect(source).toContain('ไม่ได้ซิงก์');
    expect(source).toContain('audit log');
  });

  test('leaves the existing manual-review queue read/resolve path intact', () => {
    expect(source).toContain("listQueue(store, ['manual_review_required'])");
    expect(source).toContain('resolveManualReview(store');
    expect(source).toContain('buildManualReviewResolvePayload');
  });
});
