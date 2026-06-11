/**
 * Tests for the pure Transfer Reversal Evidence Builder + Dual-Branch Invariant.
 * Phase 7B-H6-E2-A — latent, no runtime wiring required.
 *
 * Tests cover all 24 required cases from the H6-E2-A specification.
 */
import { describe, expect, test } from 'vitest';
import {
  assertTransferReversalEvidenceCoversCompletion,
  buildTransferReversalEvidence,
  TransferReversalEvidenceError,
  TRANSFER_REVERSAL_EVIDENCE_VERSION,
  type TransferReversalEvidence,
  type TransferReversalEvidenceInput,
} from './transferReversalEvidence';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FROM = 'branch-A';
const TO = 'branch-B';
const NOW = '2026-06-11T00:00:00.000Z';

function makeInput(
  items: TransferReversalEvidenceInput['items'],
  overrides?: Partial<Omit<TransferReversalEvidenceInput, 'items'>>,
): TransferReversalEvidenceInput {
  return { fromBranchId: FROM, toBranchId: TO, items, createdAt: NOW, ...overrides };
}

// ─── Error assertion helpers ──────────────────────────────────────────────────

function expectBuildCode(input: TransferReversalEvidenceInput, code: string): void {
  let caught: unknown;
  try {
    buildTransferReversalEvidence(input);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TransferReversalEvidenceError);
  expect((caught as TransferReversalEvidenceError).code).toBe(code);
}

function expectInvariantCode(
  input: TransferReversalEvidenceInput,
  evidence: TransferReversalEvidence,
  code: string,
): void {
  let caught: unknown;
  try {
    assertTransferReversalEvidenceCoversCompletion(input, evidence);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TransferReversalEvidenceError);
  expect((caught as TransferReversalEvidenceError).code).toBe(code);
}

// ─── 1–9: Builder behavior ────────────────────────────────────────────────────

describe('buildTransferReversalEvidence — structure', () => {
  test('1. creates one dest_gain and one source_loss effect per transfer item', () => {
    const ev = buildTransferReversalEvidence(
      makeInput([{ productId: 'p1', transferQty: 5 }]),
    );
    expect(ev.effects).toHaveLength(2);
    const directions = ev.effects.map((e) => e.direction).sort();
    expect(directions).toEqual(['dest_gain', 'source_loss']);
  });

  test('2. dest_gain effect uses toBranchId', () => {
    const ev = buildTransferReversalEvidence(
      makeInput([{ productId: 'p1', transferQty: 5 }]),
    );
    const dest = ev.effects.find((e) => e.direction === 'dest_gain');
    expect(dest?.branchId).toBe(TO);
  });

  test('3. source_loss effect uses fromBranchId', () => {
    const ev = buildTransferReversalEvidence(
      makeInput([{ productId: 'p1', transferQty: 5 }]),
    );
    const src = ev.effects.find((e) => e.direction === 'source_loss');
    expect(src?.branchId).toBe(FROM);
  });

  test('4. all effect quantities are positive', () => {
    const ev = buildTransferReversalEvidence(
      makeInput([
        { productId: 'p1', transferQty: 3 },
        { productId: 'p2', transferQty: 7 },
      ]),
    );
    for (const e of ev.effects) {
      expect(e.qtyBase).toBeGreaterThan(0);
    }
  });

  test('5. itemCount is derived from number of input items (not effect rows)', () => {
    const ev = buildTransferReversalEvidence(
      makeInput([
        { productId: 'p1', transferQty: 2 },
        { productId: 'p2', transferQty: 3 },
        { productId: 'p3', transferQty: 1 },
      ]),
    );
    // 3 items → itemCount 3, effects 6 (2 per item)
    expect(ev.itemCount).toBe(3);
    expect(ev.effects).toHaveLength(6);
  });

  test('6. totalQtyBase is derived from sum of input transferQty', () => {
    const ev = buildTransferReversalEvidence(
      makeInput([
        { productId: 'p1', transferQty: 2.5 },
        { productId: 'p2', transferQty: 1.25 },
      ]),
    );
    expect(ev.totalQtyBase).toBeCloseTo(3.75, 10);
  });

  test('7. deterministic ordering is stable even if input order changes', () => {
    const itemsAsc = [
      { productId: 'p1', transferQty: 5 },
      { productId: 'p2', transferQty: 3 },
      { productId: 'p3', transferQty: 1 },
    ];
    const itemsDesc = [
      { productId: 'p3', transferQty: 1 },
      { productId: 'p2', transferQty: 3 },
      { productId: 'p1', transferQty: 5 },
    ];
    const evAsc = buildTransferReversalEvidence(makeInput(itemsAsc));
    const evDesc = buildTransferReversalEvidence(makeInput(itemsDesc));
    // Effect arrays must be identical regardless of input order.
    expect(evAsc.effects).toEqual(evDesc.effects);
    // Verify sort ordering: p1|dest_gain before p1|source_loss before p2|... etc.
    const productIds = evAsc.effects.map((e) => e.productId);
    expect(productIds).toEqual(['p1', 'p1', 'p2', 'p2', 'p3', 'p3']);
    const directions = evAsc.effects.map((e) => e.direction);
    expect(directions).toEqual([
      'dest_gain', 'source_loss',
      'dest_gain', 'source_loss',
      'dest_gain', 'source_loss',
    ]);
  });

  test('8. multiple products are handled correctly (checksums cover all products)', () => {
    const ev = buildTransferReversalEvidence(
      makeInput([
        { productId: 'alpha', transferQty: 10 },
        { productId: 'beta', transferQty: 4 },
        { productId: 'gamma', transferQty: 6 },
      ]),
    );
    expect(ev.itemCount).toBe(3);
    expect(ev.totalQtyBase).toBeCloseTo(20, 10);
    expect(ev.effects).toHaveLength(6);
    const destEffects = ev.effects.filter((e) => e.direction === 'dest_gain');
    const srcEffects = ev.effects.filter((e) => e.direction === 'source_loss');
    expect(destEffects.map((e) => e.branchId)).toEqual([TO, TO, TO]);
    expect(srcEffects.map((e) => e.branchId)).toEqual([FROM, FROM, FROM]);
  });

  test('9. two items with the same productId produce four effects and pass the invariant', () => {
    const input = makeInput([
      { productId: 'p1', transferQty: 5 },
      { productId: 'p1', transferQty: 3 },
    ]);
    const ev = buildTransferReversalEvidence(input);
    // 2 items → itemCount 2 (not 1 unique product), 4 effects.
    expect(ev.itemCount).toBe(2);
    expect(ev.totalQtyBase).toBeCloseTo(8, 10);
    expect(ev.effects).toHaveLength(4);
    // Invariant: per-product balance sums 5+3=8 for both directions.
    expect(() => assertTransferReversalEvidenceCoversCompletion(input, ev)).not.toThrow();
  });
});

// ─── 10–17: Builder input validation (rejection) ─────────────────────────────

describe('buildTransferReversalEvidence — input rejection', () => {
  test('10. missing productId rejects', () => {
    expectBuildCode(
      makeInput([{ productId: '', transferQty: 5 }]),
      'missing_product_id',
    );
  });

  test('10b. whitespace-only productId rejects', () => {
    expectBuildCode(
      makeInput([{ productId: '   ', transferQty: 5 }]),
      'missing_product_id',
    );
  });

  test('11. missing fromBranchId rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: 5 }], { fromBranchId: '' }), 'missing_from_branch');
  });

  test('11b. whitespace-only fromBranchId rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: 5 }], { fromBranchId: '  ' }), 'missing_from_branch');
  });

  test('12. missing toBranchId rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: 5 }], { toBranchId: '' }), 'missing_to_branch');
  });

  test('13. same fromBranchId and toBranchId rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: 5 }], { fromBranchId: 'X', toBranchId: 'X' }), 'same_branch');
  });

  test('13b. same branch after trim rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: 5 }], { fromBranchId: 'X ', toBranchId: ' X' }), 'same_branch');
  });

  test('14. zero quantity rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: 0 }]), 'non_positive_qty');
  });

  test('15. negative quantity rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: -1 }]), 'non_positive_qty');
  });

  test('16. NaN quantity rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: NaN }]), 'non_finite_qty');
  });

  test('16b. Infinity quantity rejects', () => {
    expectBuildCode(makeInput([{ productId: 'p1', transferQty: Infinity }]), 'non_finite_qty');
  });

  test('17. empty items array rejects', () => {
    expectBuildCode(makeInput([]), 'empty_items');
  });

  test('17b. null items rejects', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expectBuildCode(makeInput(null as any), 'missing_items');
  });
});

// ─── 18–22: Invariant validation (rejection) ─────────────────────────────────

describe('assertTransferReversalEvidenceCoversCompletion — invariant rejection', () => {
  function goodInput() {
    return makeInput([
      { productId: 'p1', transferQty: 5 },
      { productId: 'p2', transferQty: 3 },
    ]);
  }

  function goodEvidence(): TransferReversalEvidence {
    return buildTransferReversalEvidence(goodInput());
  }

  test('invariant passes for correctly built evidence', () => {
    const input = goodInput();
    const ev = goodEvidence();
    expect(() => assertTransferReversalEvidenceCoversCompletion(input, ev)).not.toThrow();
  });

  test('18. asymmetric evidence (removed source_loss) rejects', () => {
    const input = goodInput();
    const ev = goodEvidence();
    // Remove one source_loss effect — balance is now asymmetric.
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: ev.effects.filter((e) => !(e.productId === 'p1' && e.direction === 'source_loss')),
    };
    expectInvariantCode(input, tampered, 'dest_source_balance_mismatch');
  });

  test('18b. tampered quantity (dest_gain inflated) rejects', () => {
    const input = goodInput();
    const ev = goodEvidence();
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: ev.effects.map((e) =>
        e.productId === 'p1' && e.direction === 'dest_gain'
          ? { ...e, qtyBase: e.qtyBase + 1 }
          : e,
      ),
    };
    expectInvariantCode(input, tampered, 'dest_source_balance_mismatch');
  });

  test('18c. extra product in evidence not present in input rejects', () => {
    const input = goodInput();
    const ev = goodEvidence();
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: [
        ...ev.effects,
        { productId: 'p-injected', branchId: TO, direction: 'dest_gain', qtyBase: 1, lotId: null },
        { productId: 'p-injected', branchId: FROM, direction: 'source_loss', qtyBase: 1, lotId: null },
      ],
    };
    expectInvariantCode(input, tampered, 'dest_source_balance_mismatch');
  });

  test('19. mismatched itemCount rejects', () => {
    const input = goodInput();
    const ev: TransferReversalEvidence = { ...goodEvidence(), itemCount: 99 };
    expectInvariantCode(input, ev, 'itemcount_mismatch');
  });

  test('20. mismatched totalQtyBase rejects', () => {
    const input = goodInput();
    const ev: TransferReversalEvidence = { ...goodEvidence(), totalQtyBase: 0.5 };
    expectInvariantCode(input, ev, 'totalqty_mismatch');
  });

  test('21. invalid branchId in an effect rejects', () => {
    const input = goodInput();
    const ev = goodEvidence();
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: ev.effects.map((e, i) =>
        i === 0 ? { ...e, branchId: 'unknown-branch' } : e,
      ),
    };
    expectInvariantCode(input, tampered, 'effect_invalid_branch');
  });

  test('22. invalid direction in an effect rejects', () => {
    const input = goodInput();
    const ev = goodEvidence();
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: ev.effects.map((e, i) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        i === 0 ? { ...e, direction: 'invalid_direction' as any } : e,
      ),
    };
    expectInvariantCode(input, tampered, 'effect_invalid_direction');
  });

  test('wrong_version rejects', () => {
    const input = goodInput();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev: TransferReversalEvidence = { ...goodEvidence(), version: 2 as any };
    expectInvariantCode(input, ev, 'wrong_version');
  });

  test('wrong_source rejects', () => {
    const input = goodInput();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev: TransferReversalEvidence = { ...goodEvidence(), source: 'receiving_completion' as any };
    expectInvariantCode(input, ev, 'wrong_source');
  });

  // ── Branch-direction invariant (Codex blocker fix) ────────────────────────

  test('branch-direction: all branches swapped (dest_gain on from, source_loss on to) rejects', () => {
    // Product totals still balance (qty is unchanged), but direction-branch binding is wrong.
    // This is the core Codex blocker: a tampered evidence where from/to are swapped within
    // the valid {from, to} set must fail, not pass due to membership-only check.
    const input = goodInput();
    const ev = goodEvidence();
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: ev.effects.map((e) => ({
        ...e,
        branchId: e.direction === 'dest_gain' ? FROM : TO,
      })),
    };
    expectInvariantCode(input, tampered, 'effect_invalid_branch');
  });

  test('branch-direction: evidence fromBranchId differs from input fromBranchId rejects', () => {
    const input = goodInput();
    const ev: TransferReversalEvidence = { ...goodEvidence(), fromBranchId: 'wrong-origin' };
    expectInvariantCode(input, ev, 'branch_header_mismatch');
  });

  test('branch-direction: evidence toBranchId differs from input toBranchId rejects', () => {
    const input = goodInput();
    const ev: TransferReversalEvidence = { ...goodEvidence(), toBranchId: 'wrong-dest' };
    expectInvariantCode(input, ev, 'branch_header_mismatch');
  });

  test('branch-direction: only dest_gain effects use fromBranchId rejects', () => {
    const input = goodInput();
    const ev = goodEvidence();
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: ev.effects.map((e) =>
        e.direction === 'dest_gain' ? { ...e, branchId: FROM } : e,
      ),
    };
    expectInvariantCode(input, tampered, 'effect_invalid_branch');
  });

  test('branch-direction: only source_loss effects use toBranchId rejects', () => {
    const input = goodInput();
    const ev = goodEvidence();
    const tampered: TransferReversalEvidence = {
      ...ev,
      effects: ev.effects.map((e) =>
        e.direction === 'source_loss' ? { ...e, branchId: TO } : e,
      ),
    };
    expectInvariantCode(input, tampered, 'effect_invalid_branch');
  });
});

// ─── 23: Source lot identity is audit-only ────────────────────────────────────

describe('source lot identity — audit-only, no over-rejection', () => {
  test('23a. single-lot source carries lotId for audit and passes the invariant', () => {
    const input = makeInput([
      {
        productId: 'p1',
        transferQty: 5,
        sourceLotDetails: [{ lotId: 'lot-001', qty: 5, costPerUnit: 10 }],
      },
    ]);
    const ev = buildTransferReversalEvidence(input);
    const srcEffect = ev.effects.find((e) => e.direction === 'source_loss');
    // Single-lot: lotId is preserved as audit detail.
    expect(srcEffect?.lotId).toBe('lot-001');
    // Dest gain has no lot assignment at this stage.
    const destEffect = ev.effects.find((e) => e.direction === 'dest_gain');
    expect(destEffect?.lotId).toBeNull();
    expect(() => assertTransferReversalEvidenceCoversCompletion(input, ev)).not.toThrow();
  });

  test('23b. multi-lot source uses null lotId and does NOT over-reject', () => {
    const input = makeInput([
      {
        productId: 'p1',
        transferQty: 8,
        sourceLotDetails: [
          { lotId: 'lot-001', qty: 5, costPerUnit: 10 },
          { lotId: 'lot-002', qty: 3, costPerUnit: 12 },
        ],
      },
    ]);
    // Builder must not fail or over-reject multi-lot input.
    const ev = buildTransferReversalEvidence(input);
    const srcEffect = ev.effects.find((e) => e.direction === 'source_loss');
    // Multi-lot: lotId is null (product×branch counter-based; no lot gate).
    expect(srcEffect?.lotId).toBeNull();
    // qtyBase still equals transferQty — the total is preserved.
    expect(srcEffect?.qtyBase).toBe(8);
    // Invariant passes: aggregate source loss == aggregate dest gain == input qty.
    expect(() => assertTransferReversalEvidenceCoversCompletion(input, ev)).not.toThrow();
  });

  test('23c. absent sourceLotDetails uses null lotId and passes invariant', () => {
    const input = makeInput([{ productId: 'p1', transferQty: 3 }]);
    const ev = buildTransferReversalEvidence(input);
    const srcEffect = ev.effects.find((e) => e.direction === 'source_loss');
    expect(srcEffect?.lotId).toBeNull();
    expect(() => assertTransferReversalEvidenceCoversCompletion(input, ev)).not.toThrow();
  });
});

// ─── 24: No runtime wiring required ──────────────────────────────────────────

describe('24. no runtime wiring required', () => {
  test('all functions are pure and require no external dependencies', () => {
    // This test passes by its own existence: the module has no Firestore/queue imports
    // and every function in the suite runs without any injected deps or mocks.
    const input = makeInput([{ productId: 'p1', transferQty: 10 }]);
    const ev = buildTransferReversalEvidence(input);
    expect(() => assertTransferReversalEvidenceCoversCompletion(input, ev)).not.toThrow();
    expect(ev.version).toBe(TRANSFER_REVERSAL_EVIDENCE_VERSION);
    expect(ev.source).toBe('transfer_completion');
  });
});
