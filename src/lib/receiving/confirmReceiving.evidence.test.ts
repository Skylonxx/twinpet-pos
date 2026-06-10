import { beforeAll, describe, expect, test } from 'vitest';
import {
  devConfirmReceiving,
  devSeedGhostLot,
  getDevReceivings,
  getDevReceivingItems,
} from './devMock';
import type { ReceivingLine } from './types';

// The dev receiving-number allocator persists a counter in localStorage, which the
// `node` test env lacks. `devConfirmReceiving` only touches it at call time, so a
// minimal in-memory shim installed before the tests run is sufficient.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const mem = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    } as Storage;
  }
});

/**
 * Phase 7B-H1 — proves the receiving COMPLETION path writes a header
 * `reversalEvidence` snapshot that matches the exact stock effects applied. The dev
 * completion mirror (`devConfirmReceiving`) is the in-memory-testable surface; the
 * Firestore path (`confirmReceiving`) builds the snapshot from the same `writePlans`
 * inside the stock-increase transaction, so it is atomic there too.
 */

function line(over: Partial<ReceivingLine> & { productId: string }): ReceivingLine {
  return {
    lineKey: `${over.productId}-k`,
    productName: over.productId,
    sku: over.productId,
    hasVat: false,
    unit: 'ชิ้น',
    unitFactor: 1,
    qty: 1,
    costPerUnit: 10,
    itemDiscount: 0,
    hasExpiry: false,
    expiryDate: '',
    ...over,
  };
}

describe('devConfirmReceiving — header reversalEvidence (Phase 7B-H1)', () => {
  test('completion writes evidence whose effects/itemCount/totalQtyBase match the applied lines', () => {
    const branchId = 'evidence-branch-1';
    const receivingId = devConfirmReceiving({
      branchId,
      staffId: 'mgr-evidence',
      staffName: 'Mgr',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [
        line({ productId: 'pa', qty: 5, unitFactor: 1 }), // qtyBase 5
        line({ productId: 'pb', qty: 2, unitFactor: 3 }), // qtyBase 6
      ],
    });

    const receiving = getDevReceivings(branchId).find((r) => r.id === receivingId)!;
    const items = getDevReceivingItems(receivingId);
    const ev = receiving.reversalEvidence;

    expect(ev).toBeTruthy();
    expect(ev!.version).toBe(1);
    expect(ev!.source).toBe('receiving_completion');
    expect(ev!.createdBy).toBe('mgr-evidence');

    // Checksums match the applied lines.
    expect(ev!.itemCount).toBe(items.length);
    expect(ev!.totalQtyBase).toBe(items.reduce((s, it) => s + it.qtyBase, 0));
    expect(ev!.totalQtyBase).toBe(11); // 5 + 6

    // Each effect mirrors the exact (productId, lotId, qtyBase) the item landed with.
    expect(ev!.effects).toEqual(
      items.map((it) => ({ productId: it.productId, lotId: it.lotId, qtyBase: it.qtyBase })),
    );
  });

  test('a single-line completion writes evidence with the matching total', () => {
    const branchId = 'evidence-branch-2';
    const draftId = devConfirmReceiving({
      branchId,
      staffId: 'mgr-evidence',
      staffName: 'Mgr',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [line({ productId: 'pc', qty: 4, unitFactor: 1 })],
    });

    const receiving = getDevReceivings(branchId).find((r) => r.id === draftId)!;
    expect(receiving.reversalEvidence).toBeTruthy();
    expect(receiving.reversalEvidence!.totalQtyBase).toBe(4);
  });
});

// ─── Lot-effect segments at completion (Phase 7B-H1 blocker — Blocker 1) ──────

describe('devConfirmReceiving — lot-level stock-effect segments', () => {
  test('normal new-lot receiving persists ONE segment with the new lot and full qty', () => {
    const branchId = 'seg-newlot';
    const receivingId = devConfirmReceiving({
      branchId,
      staffId: 'mgr',
      staffName: 'Mgr',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [line({ productId: 'sn1', qty: 6, unitFactor: 1 })],
    });
    const ev = getDevReceivings(branchId).find((r) => r.id === receivingId)!.reversalEvidence!;
    expect(ev.itemCount).toBe(1);
    expect(ev.totalQtyBase).toBe(6);
    expect(ev.effects).toHaveLength(1);
    expect(ev.effects[0].qtyBase).toBe(6);
    expect(ev.effects[0].lotId).not.toBe(''); // a real (new) lot
  });

  test('ghost + new-lot split persists SEPARATE segments for the ghost lot and the new lot', () => {
    const branchId = 'seg-ghost-split';
    devSeedGhostLot('gpx', branchId, 3); // ghost-gpx, qtyRemaining -3
    const receivingId = devConfirmReceiving({
      branchId,
      staffId: 'mgr',
      staffName: 'Mgr',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [line({ productId: 'gpx', qty: 10, unitFactor: 1 })], // 3 → ghost, 7 → new lot
    });
    const ev = getDevReceivings(branchId).find((r) => r.id === receivingId)!.reversalEvidence!;

    expect(ev.itemCount).toBe(2);
    expect(ev.totalQtyBase).toBe(10);
    // Ghost-lot reconciliation appears under the ghost lotId with the reconciled qty.
    const ghostSeg = ev.effects.find((e) => e.lotId === 'ghost-gpx');
    expect(ghostSeg).toEqual({ productId: 'gpx', lotId: 'ghost-gpx', qtyBase: 3 });
    // The remainder appears under the newly created lot.
    const newSeg = ev.effects.find((e) => e.lotId !== 'ghost-gpx');
    expect(newSeg!.qtyBase).toBe(7);
    // Product-level total still equals the line qtyBase (consistent with productStocks).
    expect(ev.effects.reduce((s, e) => s + e.qtyBase, 0)).toBe(10);
  });

  test('two lines reconciling the SAME ghost lot aggregate into one summed ghost segment', () => {
    const branchId = 'seg-ghost-dup';
    devSeedGhostLot('gpy', branchId, 8); // ghost-gpy, qtyRemaining -8
    const receivingId = devConfirmReceiving({
      branchId,
      staffId: 'mgr',
      staffName: 'Mgr',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [
        line({ productId: 'gpy', qty: 5, unitFactor: 1 }), // 5 → ghost
        line({ productId: 'gpy', qty: 5, unitFactor: 1 }), // 3 → ghost, 2 → new lot
      ],
    });
    const ev = getDevReceivings(branchId).find((r) => r.id === receivingId)!.reversalEvidence!;

    // Aggregated: one ghost segment (5+3=8) + one new-lot segment (2).
    expect(ev.itemCount).toBe(2);
    expect(ev.totalQtyBase).toBe(10);
    const ghostSeg = ev.effects.find((e) => e.lotId === 'ghost-gpy');
    expect(ghostSeg).toEqual({ productId: 'gpy', lotId: 'ghost-gpy', qtyBase: 8 });
    const newSeg = ev.effects.find((e) => e.lotId !== 'ghost-gpy');
    expect(newSeg!.qtyBase).toBe(2);
  });
});
