import { describe, it, expect } from 'vitest';
import {
  recordReversalRejection,
  listReversalRejections,
  type RecordRejectionOutcome,
} from './reversalRejectionLog';
import {
  createInMemoryReversalStore,
  createIndexedDbReversalStore,
  type ReversalLocalStore,
  type ReversalStoreName,
  type ReversalTxn,
} from './reversalLocalStore';
import {
  buildReversalRejectionRecord,
  type ReversalRejectionRecord,
  type ReversalRejectionRecordInput,
} from '../../inventory/reversalRejectionRecord';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const transferInput: ReversalRejectionRecordInput = {
  sourceType: 'transfer',
  sourceId: 'TR-1001',
  branchId: 'branch-origin',
  evidenceCode: 'header_total_qty_mismatch',
  evidenceMessage: 'ไม่สามารถยกเลิกโอนได้: หลักฐานโอนสินค้าไม่ตรงกับยอดรวม',
  evidenceSource: 'header_snapshot',
  staffId: 'user-7',
  observedDocumentUpdatedAt: '2026-06-12T08:30:00.000Z',
  createdAt: '2026-06-12T09:00:00.000Z',
};

const receivingInput: ReversalRejectionRecordInput = {
  sourceType: 'receiving',
  sourceId: 'GRN-2002',
  branchId: 'branch-a',
  evidenceCode: 'missing_lot_id',
  evidenceMessage: 'ไม่สามารถยกเลิกรับเข้าได้: มีรายการสินค้าที่ไม่มีรหัสล็อต',
  createdAt: '2026-06-12T09:05:00.000Z',
};

const WHITELIST = new Set([
  'recordId',
  'sourceType',
  'sourceId',
  'branchId',
  'evidenceCode',
  'evidenceMessage',
  'evidenceSource',
  'staffId',
  'observedDocumentUpdatedAt',
  'createdAt',
]);

/** Decorator whose `transact` always rejects with a generic error (not "unavailable"). */
function alwaysFailingStore(): ReversalLocalStore {
  return {
    transact() {
      return Promise.reject(new Error('induced storage fault'));
    },
  };
}

/** Decorator that throws inside `put` to `faultOn` — to prove atomic abort discards the write. */
function faultingPutStore(inner: ReversalLocalStore, faultOn: ReversalStoreName): ReversalLocalStore {
  return {
    transact(stores, mode, fn) {
      return inner.transact(stores, mode, (txn: ReversalTxn) => {
        const wrapped: ReversalTxn = {
          get: (s, k) => txn.get(s, k),
          getAll: (s) => txn.getAll(s),
          put: (s, k, v) => {
            if (s === faultOn) throw new Error('induced put fault');
            return txn.put(s, k, v);
          },
          delete: (s, k) => txn.delete(s, k),
        };
        return fn(wrapped);
      });
    },
  };
}

// ─── Write / list round trip ─────────────────────────────────────────────────

describe('H7-C: recordReversalRejection / listReversalRejections round trip', () => {
  it('records then lists a transfer rejection', async () => {
    const store = createInMemoryReversalStore();
    expect(await recordReversalRejection(store, buildReversalRejectionRecord(transferInput))).toBe('recorded');
    const rows = await listReversalRejections(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: 'transfer', sourceId: 'TR-1001', evidenceCode: 'header_total_qty_mismatch' });
  });

  it('persists both transfer and receiving source types and round-trips them', async () => {
    const store = createInMemoryReversalStore();
    await recordReversalRejection(store, buildReversalRejectionRecord(transferInput));
    await recordReversalRejection(store, buildReversalRejectionRecord(receivingInput));
    const all = await listReversalRejections(store);
    expect(all.map((r) => r.sourceType).sort()).toEqual(['receiving', 'transfer']);
  });
});

// ─── Duplicate / idempotency ─────────────────────────────────────────────────

describe('H7-C: deterministic recordId idempotency', () => {
  it('identical content → one stored row, second write reports duplicate', async () => {
    const store = createInMemoryReversalStore();
    const rec = buildReversalRejectionRecord(transferInput);
    expect(await recordReversalRejection(store, rec)).toBe('recorded');
    expect(await recordReversalRejection(store, rec)).toBe('duplicate');
    expect(await listReversalRejections(store)).toHaveLength(1);
  });

  it('distinct createdAt → distinct rows (both retained)', async () => {
    const store = createInMemoryReversalStore();
    const a = buildReversalRejectionRecord(transferInput);
    const b = buildReversalRejectionRecord({ ...transferInput, createdAt: '2026-06-12T10:00:00.000Z' });
    expect(a.recordId).not.toBe(b.recordId);
    expect(await recordReversalRejection(store, a)).toBe('recorded');
    expect(await recordReversalRejection(store, b)).toBe('recorded');
    expect(await listReversalRejections(store)).toHaveLength(2);
  });
});

// ─── Best-effort / non-throwing ──────────────────────────────────────────────

describe('H7-C: best-effort write never throws into the caller', () => {
  it('returns "unavailable" when IndexedDB is unavailable (node env)', async () => {
    // The real IndexedDB-backed store's transact rejects with "IndexedDB unavailable"
    // when there is no IndexedDB (node/SSR). recordReversalRejection must swallow it.
    const store = createIndexedDbReversalStore();
    let outcome: RecordRejectionOutcome | undefined;
    await expect(
      (async () => {
        outcome = await recordReversalRejection(store, buildReversalRejectionRecord(transferInput));
      })(),
    ).resolves.toBeUndefined();
    expect(outcome).toBe('unavailable');
  });

  it('returns "failed" on a generic storage fault (no throw)', async () => {
    const outcome = await recordReversalRejection(alwaysFailingStore(), buildReversalRejectionRecord(transferInput));
    expect(outcome).toBe('failed');
  });

  it('aborts cleanly when the underlying put faults — no row committed, no throw', async () => {
    const inMem = createInMemoryReversalStore();
    const store = faultingPutStore(inMem, 'rejections');
    const outcome = await recordReversalRejection(store, buildReversalRejectionRecord(transferInput));
    expect(outcome).toBe('failed');
    // Abort discarded the working copy → nothing committed.
    expect(inMem.dump().rejections).toEqual({});
    expect(await listReversalRejections(inMem)).toHaveLength(0);
  });

  it('simulated catch-site wrapper still completes its F1/G1 message when logging fails', async () => {
    // Mirrors how a FUTURE catch site would behave — NOT real catch-site wiring.
    // The fail-closed message is determined FIRST; logging is fire-and-forget + swallowed.
    async function simulatedCatchSite(
      store: ReversalLocalStore,
      record: ReversalRejectionRecord,
    ): Promise<{ message: string }> {
      const message = `เหตุผลที่ปฏิเสธ (รหัส: ${record.evidenceCode})`;
      void recordReversalRejection(store, record).catch(() => {
        /* forensic log is best-effort; never affects UX */
      });
      return { message };
    }
    const result = await simulatedCatchSite(alwaysFailingStore(), buildReversalRejectionRecord(transferInput));
    expect(result.message).toBe('เหตุผลที่ปฏิเสธ (รหัส: header_total_qty_mismatch)');
  });
});

// ─── No over-collection ──────────────────────────────────────────────────────

describe('H7-C: no over-collection at persistence', () => {
  it('persisted record keys stay within the H7-A whitelist', async () => {
    const store = createInMemoryReversalStore();
    await recordReversalRejection(store, buildReversalRejectionRecord(transferInput));
    const stored = (await listReversalRejections(store))[0];
    for (const key of Object.keys(stored)) {
      expect(WHITELIST.has(key)).toBe(true);
    }
  });
});

// ─── In-memory parity (dump) ─────────────────────────────────────────────────

describe('H7-C: in-memory parity', () => {
  it('dump().rejections reflects committed rows only', async () => {
    const store = createInMemoryReversalStore();
    const rec = buildReversalRejectionRecord(transferInput);
    await recordReversalRejection(store, rec);
    expect(Object.keys(store.dump().rejections)).toEqual([rec.recordId]);
  });

  it('exposes the rejections store alongside the four existing stores', () => {
    const store = createInMemoryReversalStore();
    expect(Object.keys(store.dump()).sort()).toEqual([
      'intents',
      'ledger',
      'markers',
      'privilegedEvidence',
      'rejections',
      'stock',
      'voidIntents',
    ]);
  });

  it('writing a rejection does not disturb the four stock-correction stores', async () => {
    const store = createInMemoryReversalStore();
    await store.transact(['intents', 'stock', 'ledger', 'markers'], 'readwrite', async (txn) => {
      await txn.put('intents', 'i1', { id: 'i1' });
      await txn.put('stock', 's1', { qty: 5 });
      await txn.put('ledger', 'l1', { row: 1 });
      await txn.put('markers', 'm1', { applied: true });
    });
    await recordReversalRejection(store, buildReversalRejectionRecord(transferInput));
    const dump = store.dump();
    expect(dump.intents).toEqual({ i1: { id: 'i1' } });
    expect(dump.stock).toEqual({ s1: { qty: 5 } });
    expect(dump.ledger).toEqual({ l1: { row: 1 } });
    expect(dump.markers).toEqual({ m1: { applied: true } });
  });
});

// ─── Sorting / filtering ─────────────────────────────────────────────────────

describe('H7-C: listReversalRejections ordering and filters', () => {
  async function seed(store: ReversalLocalStore) {
    await recordReversalRejection(
      store,
      buildReversalRejectionRecord({ ...transferInput, sourceId: 'TR-A', createdAt: '2026-06-12T09:00:00.000Z' }),
    );
    await recordReversalRejection(
      store,
      buildReversalRejectionRecord({ ...receivingInput, branchId: 'branch-a', createdAt: '2026-06-12T09:10:00.000Z' }),
    );
    await recordReversalRejection(
      store,
      buildReversalRejectionRecord({ ...transferInput, sourceId: 'TR-B', branchId: 'branch-a', createdAt: '2026-06-12T09:20:00.000Z' }),
    );
  }

  it('lists newest-first by createdAt', async () => {
    const store = createInMemoryReversalStore();
    await seed(store);
    const times = (await listReversalRejections(store)).map((r) => r.createdAt);
    expect(times).toEqual(['2026-06-12T09:20:00.000Z', '2026-06-12T09:10:00.000Z', '2026-06-12T09:00:00.000Z']);
  });

  it('filters by sourceType', async () => {
    const store = createInMemoryReversalStore();
    await seed(store);
    const rows = await listReversalRejections(store, { sourceType: 'transfer' });
    expect(rows.map((r) => r.sourceId)).toEqual(['TR-B', 'TR-A']);
  });

  it('filters by branchId', async () => {
    const store = createInMemoryReversalStore();
    await seed(store);
    const rows = await listReversalRejections(store, { branchId: 'branch-a' });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.branchId === 'branch-a')).toBe(true);
  });

  it('combines sourceType and branchId filters', async () => {
    const store = createInMemoryReversalStore();
    await seed(store);
    const rows = await listReversalRejections(store, { sourceType: 'transfer', branchId: 'branch-a' });
    expect(rows.map((r) => r.sourceId)).toEqual(['TR-B']);
  });
});

// ─── SEC-001 N3 Phase 2 — shared-store positive shape fence ──────────────────
//
// The `rejections` store is now shared: the N3 unreadable-row recovery writes its
// forensic captures there, inside the same transaction that deletes the row. This
// reader must therefore return ONLY H7-A rejection records. The fence is a
// positive shape test, not an exclusion by capture name, so it also holds against
// any future co-tenant shape.

describe('N3 Phase 2: listReversalRejections positive-shape fence', () => {
  /** A capture-shaped row exactly as the recovery path writes it. */
  const captureRow = {
    captureKind: 'privileged_evidence_unreadable_discard_v1',
    captureRecordId: 'privileged_evidence_unreadable_discard:9000000:corrupt-1',
    sourceStore: 'privilegedEvidence',
    rawKey: 'corrupt-1',
    rawValue: { garbage: true },
    classification: 'no_server_evidence_detected',
    branchId: 'branch-origin',
    deviceId: 'dev-1',
    actorStaffId: 'mgr-1',
    actorRole: 'manager',
    reasonCode: 'unreadable_row_support_cleared',
    discardedAtMs: 9_000_000,
  };

  async function seedRejections(
    store: ReversalLocalStore,
    rows: Array<[string, unknown]>,
  ): Promise<void> {
    for (const [key, value] of rows) {
      await store.transact(['rejections'], 'readwrite', async (txn) => {
        await txn.put('rejections', key, value);
      });
    }
  }

  it('never returns a recovery capture as a ReversalRejectionRecord', async () => {
    const store = createInMemoryReversalStore();
    await seedRejections(store, [[captureRow.captureRecordId, captureRow]]);
    expect(await listReversalRejections(store)).toEqual([]);
  });

  it('keeps genuine transfer and receiving records alongside a capture, newest-first', async () => {
    const store = createInMemoryReversalStore();
    const transfer = buildReversalRejectionRecord(transferInput); // 09:00
    const receiving = buildReversalRejectionRecord(receivingInput); // 09:05
    await seedRejections(store, [
      [transfer.recordId, transfer],
      [captureRow.captureRecordId, captureRow],
      [receiving.recordId, receiving],
    ]);

    const rows = await listReversalRejections(store);
    expect(rows.map((r) => r.sourceId)).toEqual(['GRN-2002', 'TR-1001']);
    expect(rows.every((r) => r.sourceType === 'transfer' || r.sourceType === 'receiving')).toBe(true);
  });

  it('existing sourceType / branchId filters still apply once the fence has run', async () => {
    const store = createInMemoryReversalStore();
    const transfer = buildReversalRejectionRecord(transferInput);
    const receiving = buildReversalRejectionRecord(receivingInput);
    await seedRejections(store, [
      [transfer.recordId, transfer],
      [captureRow.captureRecordId, captureRow],
      [receiving.recordId, receiving],
    ]);

    expect((await listReversalRejections(store, { sourceType: 'transfer' })).map((r) => r.sourceId)).toEqual([
      'TR-1001',
    ]);
    expect((await listReversalRejections(store, { branchId: 'branch-a' })).map((r) => r.sourceId)).toEqual([
      'GRN-2002',
    ]);
    // The capture's branchId matches the transfer record's branch — the fence, not
    // the filter, is what keeps it out.
    expect(captureRow.branchId).toBe('branch-origin');
    expect(
      (await listReversalRejections(store, { branchId: 'branch-origin' })).map((r) => r.sourceId),
    ).toEqual(['TR-1001']);
  });

  it('rejects other malformed shapes too (positive test, not an exclusion list)', async () => {
    const store = createInMemoryReversalStore();
    const transfer = buildReversalRejectionRecord(transferInput);
    await seedRejections(store, [
      [transfer.recordId, transfer],
      ['junk-1', { recordId: 'junk-1', sourceType: 'something_else' }],
      ['junk-2', { sourceType: 'transfer' }],
      ['junk-3', null],
      ['junk-4', 'not-an-object'],
    ]);
    expect((await listReversalRejections(store)).map((r) => r.recordId)).toEqual([transfer.recordId]);
  });
});
