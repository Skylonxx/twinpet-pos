import { describe, expect, test } from 'vitest';
import {
  assertReversalEvidenceCoversCompletion,
  buildReceivingReversalEvidence,
  ReceivingCompletionEvidenceError,
  REVERSAL_EVIDENCE_VERSION,
  type CanonicalCompletionLine,
} from './reversalEvidence';
import type { ReversalEvidenceEffect } from '../types';

describe('buildReceivingReversalEvidence', () => {
  test('captures version, source, effects, and derived checksums', () => {
    const core = buildReceivingReversalEvidence([
      { productId: 'p1', lotId: 'lot-1', qtyBase: 5 },
      { productId: 'p2', lotId: 'lot-2', qtyBase: 3 },
    ]);

    expect(core).toEqual({
      version: REVERSAL_EVIDENCE_VERSION,
      source: 'receiving_completion',
      itemCount: 2,
      totalQtyBase: 8,
      effects: [
        { productId: 'p1', lotId: 'lot-1', qtyBase: 5 },
        { productId: 'p2', lotId: 'lot-2', qtyBase: 3 },
      ],
    });
  });

  test('itemCount and totalQtyBase are derived from effects (cannot drift)', () => {
    const core = buildReceivingReversalEvidence([
      { productId: 'p1', lotId: 'lot-1', qtyBase: 2.5 },
      { productId: 'p1', lotId: 'lot-2', qtyBase: 1.25 },
      { productId: 'p3', lotId: 'lot-3', qtyBase: 4 },
    ]);
    expect(core.itemCount).toBe(3);
    expect(core.totalQtyBase).toBeCloseTo(7.75, 10);
  });

  test('copies effect entries (snapshot is detached from the caller array)', () => {
    const input = [{ productId: 'p1', lotId: 'lot-1', qtyBase: 5 }];
    const core = buildReceivingReversalEvidence(input);
    input[0].qtyBase = 999;
    expect(core.effects[0].qtyBase).toBe(5); // snapshot unaffected by later mutation
  });

  test('an empty completion yields a zero-count snapshot', () => {
    expect(buildReceivingReversalEvidence([])).toEqual({
      version: REVERSAL_EVIDENCE_VERSION,
      source: 'receiving_completion',
      itemCount: 0,
      totalQtyBase: 0,
      effects: [],
    });
  });
});

// ─── H1 completeness invariant (Phase 7B-H1 blocker) ─────────────────────────

describe('assertReversalEvidenceCoversCompletion', () => {
  const canonical: CanonicalCompletionLine[] = [
    { productId: 'p1', qtyBase: 5 },
    { productId: 'p2', qtyBase: 3 },
  ];
  // The matching planned effect set the completion path would produce (1:1, lot-backed).
  const planned: ReversalEvidenceEffect[] = [
    { productId: 'p1', lotId: 'lot-1', qtyBase: 5 },
    { productId: 'p2', lotId: 'lot-2', qtyBase: 3 },
  ];

  function expectCode(
    lines: readonly CanonicalCompletionLine[],
    effects: readonly ReversalEvidenceEffect[],
    code: string,
  ) {
    let caught: unknown;
    try {
      assertReversalEvidenceCoversCompletion(lines, effects);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReceivingCompletionEvidenceError);
    expect((caught as ReceivingCompletionEvidenceError).code).toBe(code);
  }

  test('passes when planned effects exactly cover the canonical lines (any order)', () => {
    expect(() => assertReversalEvidenceCoversCompletion(canonical, planned)).not.toThrow();
    // Order-independent: same set in a different order still passes.
    expect(() =>
      assertReversalEvidenceCoversCompletion(canonical, [planned[1], planned[0]]),
    ).not.toThrow();
  });

  test('passes when ONE line splits into multiple lot segments (ghost reconciles + new lot)', () => {
    // Line p1 qty 10 → ghost-A 3 + ghost-B 2 + new-C 5; per-product total 10 == 10.
    expect(() =>
      assertReversalEvidenceCoversCompletion(
        [{ productId: 'p1', qtyBase: 10 }],
        [
          { productId: 'p1', lotId: 'ghost-A', qtyBase: 3 },
          { productId: 'p1', lotId: 'ghost-B', qtyBase: 2 },
          { productId: 'p1', lotId: 'new-C', qtyBase: 5 },
        ],
      ),
    ).not.toThrow();
  });

  test('passes for duplicate (productId, qtyBase) lines backed by distinct lots', () => {
    expect(() =>
      assertReversalEvidenceCoversCompletion(
        [
          { productId: 'p1', qtyBase: 5 },
          { productId: 'p1', qtyBase: 5 },
        ],
        [
          { productId: 'p1', lotId: 'lot-a', qtyBase: 5 },
          { productId: 'p1', lotId: 'lot-b', qtyBase: 5 },
        ],
      ),
    ).not.toThrow();
  });

  test('a canonical stock-affecting line omitted from planned effects rejects (total)', () => {
    // p2 dropped → planned total 5 ≠ canonical total 8.
    expectCode(canonical, [planned[0]], 'total_qty_mismatch');
  });

  test('a planned effect with no canonical counterpart rejects (total)', () => {
    expectCode(canonical, [...planned, { productId: 'p3', lotId: 'lot-3', qtyBase: 1 }], 'total_qty_mismatch');
  });

  test('a product dropped and replaced by another (same total) rejects on per-product coverage', () => {
    // p2 (qty 3) replaced by p3 (qty 3): grand total still 8, but the product SETS differ.
    expectCode(
      canonical,
      [
        { productId: 'p1', lotId: 'lot-1', qtyBase: 5 },
        { productId: 'p3', lotId: 'lot-x', qtyBase: 3 }, // should have been p2
      ],
      'product_coverage_mismatch',
    );
  });

  test('a quantity swap between products (same total) rejects on per-product coverage', () => {
    expectCode(
      canonical,
      [
        { productId: 'p1', lotId: 'lot-1', qtyBase: 3 }, // swapped
        { productId: 'p2', lotId: 'lot-2', qtyBase: 5 }, // swapped
      ],
      'product_coverage_mismatch',
    );
  });

  test("a single product's segments over-summing its line total rejects (total)", () => {
    // p1 line qty 5, but segments sum to 7 → grand total 7 ≠ 5.
    expectCode(
      [{ productId: 'p1', qtyBase: 5 }],
      [
        { productId: 'p1', lotId: 'lot-1', qtyBase: 5 },
        { productId: 'p1', lotId: 'lot-2', qtyBase: 2 },
      ],
      'total_qty_mismatch',
    );
  });

  test('totalQtyBase mismatch rejects', () => {
    expectCode(
      [{ productId: 'p1', qtyBase: 5 }],
      [{ productId: 'p1', lotId: 'lot-1', qtyBase: 6 }],
      'total_qty_mismatch',
    );
  });

  test('a planned effect missing lotId rejects (stock-affecting effect lacks lot)', () => {
    expectCode(
      [{ productId: 'p1', qtyBase: 5 }],
      [{ productId: 'p1', lotId: '', qtyBase: 5 }],
      'effect_missing_lot_id',
    );
  });

  test('a planned effect missing productId rejects', () => {
    expectCode(
      [{ productId: 'p1', qtyBase: 5 }],
      [{ productId: '', lotId: 'lot-1', qtyBase: 5 }],
      'effect_missing_product_id',
    );
  });

  test('a planned effect with non-finite qty rejects', () => {
    expectCode(
      [{ productId: 'p1', qtyBase: 5 }],
      [{ productId: 'p1', lotId: 'lot-1', qtyBase: Number.NaN }],
      'effect_non_finite_qty',
    );
  });

  test('a planned effect with non-positive qty rejects', () => {
    expectCode(
      [{ productId: 'p1', qtyBase: 5 }],
      [{ productId: 'p1', lotId: 'lot-1', qtyBase: 0 }],
      'effect_non_positive_qty',
    );
  });

  test('a canonical line missing productId rejects', () => {
    expectCode([{ productId: '', qtyBase: 5 }], [{ productId: 'p1', lotId: 'lot-1', qtyBase: 5 }], 'line_missing_product_id');
  });

  test('a canonical line with non-positive qty rejects', () => {
    expectCode([{ productId: 'p1', qtyBase: 0 }], [{ productId: 'p1', lotId: 'lot-1', qtyBase: 0 }], 'line_non_positive_qty');
  });

  test('fractional base-unit quantities are compared within float tolerance', () => {
    expect(() =>
      assertReversalEvidenceCoversCompletion(
        [
          { productId: 'p1', qtyBase: 2.5 },
          { productId: 'p2', qtyBase: 1.25 },
        ],
        [
          { productId: 'p1', lotId: 'l1', qtyBase: 2.5 },
          { productId: 'p2', lotId: 'l2', qtyBase: 1.25 },
        ],
      ),
    ).not.toThrow();
  });
});
