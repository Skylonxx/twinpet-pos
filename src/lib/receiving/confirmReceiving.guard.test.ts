import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReceivingLine } from './types';

/**
 * Phase 7B-H1 blocker — proves the canonical completeness invariant is WIRED into the
 * completion path: it is called with the canonical completion input + the single
 * planned stock-effect set, and a throw from it ABORTS completion before the receiving
 * is marked completed. The validator's own logic is covered by `reversalEvidence.test.ts`;
 * here it is replaced by a plain spy so we can assert call wiring and abort behavior.
 */

// The dev id allocator needs localStorage (absent in the `node` test env).
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

vi.mock('./reversalEvidence', async (importActual) => {
  const actual = await importActual<typeof import('./reversalEvidence')>();
  // Keep the real builder; replace the invariant with a spy (default: passes).
  return { ...actual, assertReversalEvidenceCoversCompletion: vi.fn() };
});

const { devConfirmReceiving, devSaveReceivingDraft, getDevReceivings, getDevReceivingItems } =
  await import('./devMock');
const { assertReversalEvidenceCoversCompletion } = await import('./reversalEvidence');
const coversSpy = vi.mocked(assertReversalEvidenceCoversCompletion);

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

beforeEach(() => coversSpy.mockReset());

describe('completion enforces the canonical completeness invariant', () => {
  test('new-doc completion calls the invariant with the canonical input + planned effects', () => {
    const branchId = 'guard-wiring-1';
    const receivingId = devConfirmReceiving({
      branchId,
      staffId: 'mgr-evidence',
      staffName: 'Mgr',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [
        line({ productId: 'gp1', qty: 5, unitFactor: 1 }), // qtyBase 5
        line({ productId: 'gp2', qty: 2, unitFactor: 3 }), // qtyBase 6
      ],
    });

    expect(coversSpy).toHaveBeenCalledTimes(1);
    const [canonicalArg, plannedArg] = coversSpy.mock.calls[0];
    // arg0 = canonical completion input (one entry per line, product + base qty).
    expect(canonicalArg).toEqual([
      { productId: 'gp1', qtyBase: 5 },
      { productId: 'gp2', qtyBase: 6 },
    ]);
    // arg1 = the single planned effect set that ALSO becomes the persisted evidence.
    const items = getDevReceivingItems(receivingId);
    const plannedFromItems = items.map((it) => ({
      productId: it.productId,
      lotId: it.lotId,
      qtyBase: it.qtyBase,
    }));
    expect(plannedArg).toEqual(plannedFromItems);
    const ev = getDevReceivings(branchId).find((r) => r.id === receivingId)!.reversalEvidence!;
    expect(ev.effects).toEqual(plannedFromItems);
  });

  test('draft-finalize completion also calls the invariant', () => {
    const branchId = 'guard-wiring-2';
    const draftId = devSaveReceivingDraft({
      branchId,
      staffId: 'mgr-evidence',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [line({ productId: 'gp3', qty: 4, unitFactor: 1 })],
    });
    coversSpy.mockClear();

    devConfirmReceiving({
      branchId,
      staffId: 'mgr-evidence',
      staffName: 'Mgr',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      receivingId: draftId,
      lines: [line({ productId: 'gp3', qty: 4, unitFactor: 1 })],
    });

    expect(coversSpy).toHaveBeenCalledTimes(1);
    expect(coversSpy.mock.calls[0][0]).toEqual([{ productId: 'gp3', qtyBase: 4 }]);
    expect(getDevReceivings(branchId).find((r) => r.id === draftId)!.status).toBe('completed');
  });

  test('new-doc path: a thrown invariant aborts completion (no completed receiving created)', () => {
    coversSpy.mockImplementationOnce(() => {
      throw new Error('boom: canonical coverage failed');
    });
    const branchId = 'guard-newdoc-fail';
    expect(() =>
      devConfirmReceiving({
        branchId,
        staffId: 'mgr-evidence',
        staffName: 'Mgr',
        supplierId: null,
        supplierName: 'S',
        note: '',
        finalDiscount: 0,
        lines: [line({ productId: 'gp9', qty: 5, unitFactor: 1 })],
      }),
    ).toThrow(/boom/);
    expect(getDevReceivings(branchId)).toHaveLength(0); // never recorded as completed
  });

  test('draft-finalize path: a thrown invariant aborts completion (doc stays draft)', () => {
    const branchId = 'guard-finalize-fail';
    const draftId = devSaveReceivingDraft({
      branchId,
      staffId: 'mgr-evidence',
      supplierId: null,
      supplierName: 'S',
      note: '',
      finalDiscount: 0,
      lines: [line({ productId: 'gp7', qty: 5, unitFactor: 1 })],
    });
    expect(getDevReceivings(branchId).find((r) => r.id === draftId)!.status).toBe('draft');

    coversSpy.mockImplementationOnce(() => {
      throw new Error('boom: canonical coverage failed');
    });
    expect(() =>
      devConfirmReceiving({
        branchId,
        staffId: 'mgr-evidence',
        staffName: 'Mgr',
        supplierId: null,
        supplierName: 'S',
        note: '',
        finalDiscount: 0,
        receivingId: draftId,
        lines: [line({ productId: 'gp7', qty: 5, unitFactor: 1 })],
      }),
    ).toThrow(/boom/);
    // Fail-closed: still a draft, never marked completed.
    expect(getDevReceivings(branchId).find((r) => r.id === draftId)!.status).toBe('draft');
  });
});
