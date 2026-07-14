import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  toPositiveEntryMinor,
  toNonNegativeTotalMinor,
  classifyCashEntry,
  canonicalOrder,
  foldCashEntriesSnapshot,
  drawerCashParityMatches,
  roundMoneyKernel,
} from '../shiftCloseValidationCore';
import { CAP_SNAPSHOT_ENTRIES, MAX_ENTRY_BAHT, MAX_TOTAL_BAHT, type ShiftCashEntrySnapshot } from '../shiftCloseValidationTypes';

function entry(overrides: Partial<Record<string, unknown>> = {}): ShiftCashEntrySnapshot {
  return {
    id: 'e1',
    type: 'pay_in',
    amount: 10.5,
    note: 'note',
    staffId: 'staff-1',
    staffName: 'Staff One',
    at: 1000,
    ...overrides,
  };
}

describe('toPositiveEntryMinor', () => {
  test('accepts a valid positive 2dp value', () => {
    expect(toPositiveEntryMinor(10.5)).toEqual({ ok: true, minor: 1050 });
  });

  test('rejects zero and negative entries', () => {
    expect(toPositiveEntryMinor(0)).toEqual({ ok: false, reason: 'non_positive_amount' });
    expect(toPositiveEntryMinor(-0)).toEqual({ ok: false, reason: 'non_positive_amount' });
    expect(toPositiveEntryMinor(-5)).toEqual({ ok: false, reason: 'non_positive_amount' });
  });

  test('rejects NaN / +Infinity / -Infinity', () => {
    expect(toPositiveEntryMinor(NaN)).toEqual({ ok: false, reason: 'non_finite_amount' });
    expect(toPositiveEntryMinor(Infinity)).toEqual({ ok: false, reason: 'non_finite_amount' });
    expect(toPositiveEntryMinor(-Infinity)).toEqual({ ok: false, reason: 'non_finite_amount' });
  });

  test('enforces the per-entry envelope bound', () => {
    expect(toPositiveEntryMinor(MAX_ENTRY_BAHT)).toEqual({ ok: true, minor: MAX_ENTRY_BAHT * 100 });
    expect(toPositiveEntryMinor(MAX_ENTRY_BAHT + 0.01)).toEqual({ ok: false, reason: 'amount_over_bound' });
  });

  test('rejects more than two decimal places', () => {
    expect(toPositiveEntryMinor(10.005)).toEqual({ ok: false, reason: 'amount_precision' });
  });
});

describe('toNonNegativeTotalMinor', () => {
  test('accepts zero (empty / one-sided fold totals are legitimate)', () => {
    expect(toNonNegativeTotalMinor(0)).toEqual({ ok: true, minor: 0 });
  });

  test('normalizes -0 to 0 rather than rejecting', () => {
    expect(toNonNegativeTotalMinor(-0)).toEqual({ ok: true, minor: 0 });
  });

  test('rejects negative totals', () => {
    expect(toNonNegativeTotalMinor(-1)).toEqual({ ok: false, reason: 'negative_total' });
  });

  test('rejects NaN / +Infinity / -Infinity', () => {
    expect(toNonNegativeTotalMinor(NaN)).toEqual({ ok: false, reason: 'non_finite_total' });
    expect(toNonNegativeTotalMinor(Infinity)).toEqual({ ok: false, reason: 'non_finite_total' });
    expect(toNonNegativeTotalMinor(-Infinity)).toEqual({ ok: false, reason: 'non_finite_total' });
  });

  test('enforces the aggregate envelope bound', () => {
    expect(toNonNegativeTotalMinor(MAX_TOTAL_BAHT).ok).toBe(true);
    expect(toNonNegativeTotalMinor(MAX_TOTAL_BAHT + 0.01)).toEqual({ ok: false, reason: 'total_over_bound' });
  });

  test('rejects more than two decimal places', () => {
    expect(toNonNegativeTotalMinor(10.005)).toEqual({ ok: false, reason: 'total_precision' });
  });
});

describe('classifyCashEntry', () => {
  test('flags a duplicate id on its second occurrence only', () => {
    const seen = new Set<string>();
    const first = classifyCashEntry(entry({ id: 'dup' }), 0, seen);
    const second = classifyCashEntry(entry({ id: 'dup' }), 1, seen);
    expect(first.foldBlockingReason).toBeNull();
    expect(second.foldBlockingReason).toBe('id_duplicate');
  });

  test('flags missing id', () => {
    const classified = classifyCashEntry(entry({ id: undefined }), 0, new Set());
    expect(classified.foldBlockingReason).toBe('id_missing');
  });

  test('flags unknown type', () => {
    const classified = classifyCashEntry(entry({ type: 'refund' }), 0, new Set());
    expect(classified.foldBlockingReason).toBe('type_unknown');
  });

  test('malformed note/staffId/staffName/at are soft flags only, verdict unaffected', () => {
    const classified = classifyCashEntry(entry({ note: null, staffId: null, staffName: null, at: 'not-a-number' }), 0, new Set());
    expect(classified.foldBlockingReason).toBeNull();
    expect(classified.softFlags).toEqual({ note: true, staffId: true, staffName: true, at: true });
  });
});

describe('canonicalOrder', () => {
  test('orders by (at ASC, id ASC UTF-8), with stable originalIndex tie-break for malformed/duplicate keys', () => {
    const seen = new Set<string>();
    const e1 = classifyCashEntry(entry({ id: 'b', at: 100 }), 0, seen);
    const e2 = classifyCashEntry(entry({ id: 'a', at: 100 }), 1, seen);
    const e3 = classifyCashEntry(entry({ id: 'z', at: 50 }), 2, seen);
    const ordered = canonicalOrder([e1, e2, e3]);
    expect(ordered.map((e) => e.raw.id)).toEqual(['z', 'a', 'b']);
  });

  test('shuffled input array order does not change the canonical order', () => {
    const seen1 = new Set<string>();
    const a = [
      classifyCashEntry(entry({ id: 'a', at: 1 }), 0, seen1),
      classifyCashEntry(entry({ id: 'b', at: 2 }), 1, seen1),
      classifyCashEntry(entry({ id: 'c', at: 3 }), 2, seen1),
    ];
    const seen2 = new Set<string>();
    const b = [
      classifyCashEntry(entry({ id: 'c', at: 3 }), 0, seen2),
      classifyCashEntry(entry({ id: 'a', at: 1 }), 1, seen2),
      classifyCashEntry(entry({ id: 'b', at: 2 }), 2, seen2),
    ];
    expect(canonicalOrder(a).map((e) => e.raw.id)).toEqual(canonicalOrder(b).map((e) => e.raw.id));
  });

  test('duplicate malformed (at,id) keys get a deterministic final tie-break by original index', () => {
    const seen = new Set<string>();
    const first = classifyCashEntry(entry({ id: 'dup', at: 5 }), 0, seen);
    const second = classifyCashEntry(entry({ id: 'dup', at: 5 }), 1, seen);
    const ordered = canonicalOrder([second, first]);
    expect(ordered[0].originalIndex).toBe(0);
    expect(ordered[1].originalIndex).toBe(1);
  });
});

describe('foldCashEntriesSnapshot', () => {
  test('empty input folds to zero and is fold-capable', () => {
    const fold = foldCashEntriesSnapshot([]);
    expect(fold.payInMinor).toBe(0n);
    expect(fold.payOutMinor).toBe(0n);
    expect(fold.meta.cashEntriesOverflowed).toBe(false);
  });

  test('CashEntriesSnapshotMeta carries no superseded `truncated` field (R4 replaced it)', () => {
    const fold = foldCashEntriesSnapshot([entry({ id: '1' })]);
    expect('truncated' in fold.meta).toBe(false);
    expect(Object.keys(fold.meta)).not.toContain('truncated');
  });

  test('folds pay_in and pay_out independently, order-independent', () => {
    const entries = [entry({ id: '1', type: 'pay_in', amount: 100 }), entry({ id: '2', type: 'pay_out', amount: 40 })];
    const fold = foldCashEntriesSnapshot(entries);
    expect(fold.payInMinor).toBe(10000n);
    expect(fold.payOutMinor).toBe(4000n);
  });

  test('a fold-blocking entry forces insufficient_evidence (null fold), never a silent partial fold', () => {
    const entries = [entry({ id: '1', type: 'pay_in', amount: 100 }), entry({ id: '2', type: 'unknown-type', amount: 40 })];
    const fold = foldCashEntriesSnapshot(entries);
    expect(fold.payInMinor).toBeNull();
    expect(fold.payOutMinor).toBeNull();
    expect(fold.meta.foldBlockingCount).toBe(1);
    expect(fold.meta.firstFoldBlockingReason).toBe('type_unknown');
  });

  test('overflow beyond CAP_SNAPSHOT_ENTRIES blocks the fold (cashEntriesOverflowed)', () => {
    const entries = Array.from({ length: CAP_SNAPSHOT_ENTRIES + 1 }, (_, i) => entry({ id: `e${i}`, at: i, amount: 1 }));
    const fold = foldCashEntriesSnapshot(entries);
    expect(fold.meta.cashEntriesOverflowed).toBe(true);
    expect(fold.meta.sourceEntryCount).toBe(CAP_SNAPSHOT_ENTRIES + 1);
    expect(fold.payInMinor).toBeNull();
  });

  test('exactly at the cap is complete, not overflowed', () => {
    const entries = Array.from({ length: CAP_SNAPSHOT_ENTRIES }, (_, i) => entry({ id: `e${i}`, at: i, amount: 1 }));
    const fold = foldCashEntriesSnapshot(entries);
    expect(fold.meta.cashEntriesOverflowed).toBe(false);
    expect(fold.payInMinor).toBe(BigInt(CAP_SNAPSHOT_ENTRIES) * 100n);
  });
});

describe('drawerCashParityMatches', () => {
  test('empty fold parity-matches captured zero totals', () => {
    const fold = foldCashEntriesSnapshot([]);
    expect(drawerCashParityMatches(fold, 0, 0)).toBe(true);
  });

  test('pay-in-only shift parity-matches a zero payOutTotal', () => {
    const fold = foldCashEntriesSnapshot([entry({ id: '1', type: 'pay_in', amount: 100 })]);
    expect(drawerCashParityMatches(fold, 100, 0)).toBe(true);
  });

  test('returns null (no verdict) when the fold itself is blocked', () => {
    const fold = foldCashEntriesSnapshot([entry({ id: '1', type: 'bogus', amount: 100 })]);
    expect(drawerCashParityMatches(fold, 0, 0)).toBeNull();
  });

  test('mismatched captured totals do not parity-match', () => {
    const fold = foldCashEntriesSnapshot([entry({ id: '1', type: 'pay_in', amount: 100 })]);
    expect(drawerCashParityMatches(fold, 999, 0)).toBe(false);
  });

  test('a legacy captured total with >2dp float noise is roundMoney-normalized, not rejected (non-blocking note 1)', () => {
    // Fold of two ฿0.10 entries == 20 satang. A legacy captured payInTotal of
    // 0.1 + 0.1 == 0.20000000000000004 must round to 0.20 and parity-match.
    const fold = foldCashEntriesSnapshot([
      entry({ id: '1', type: 'pay_in', amount: 0.1 }),
      entry({ id: '2', type: 'pay_in', amount: 0.1 }),
    ]);
    expect(fold.payInMinor).toBe(20n);
    expect(drawerCashParityMatches(fold, 0.1 + 0.1, 0)).toBe(true);
  });

  test('a non-finite captured total is unverifiable (null), never silently treated as 0', () => {
    const fold = foldCashEntriesSnapshot([entry({ id: '1', type: 'pay_in', amount: 100 })]);
    expect(drawerCashParityMatches(fold, Number.NaN, 0)).toBeNull();
    expect(drawerCashParityMatches(fold, Infinity, 0)).toBeNull();
  });
});

describe('roundMoneyKernel — matches the terminal money.ts kernel', () => {
  test('rounds to 2dp using Math.round(x*100)/100', () => {
    expect(roundMoneyKernel(10.005)).toBe(10.01);
    expect(roundMoneyKernel(3.333333)).toBe(3.33);
    expect(roundMoneyKernel(0.1 + 0.2)).toBe(0.3);
  });
  test('non-finite input maps to 0 (verbatim kernel behavior)', () => {
    expect(roundMoneyKernel(Number.NaN)).toBe(0);
    expect(roundMoneyKernel(Infinity)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary tests (P5-B authorization "Boundary tests" section): the pure
// core must never import Admin SDK / Firestore / client bundle modules, and
// must never reference `shifts` as a write target.
// ---------------------------------------------------------------------------

describe('P5-B pure-core import boundaries', () => {
  const srcDir = join(__dirname, '..');
  const pureCoreFiles = [
    'shiftCloseValidationTypes.ts',
    'shiftCloseValidationCore.ts',
    'shiftCloseValidationHash.ts',
    'shiftCloseValidationState.ts',
    'shiftCloseValidationCashPairs.ts',
    'shiftCloseValidationManifest.ts',
  ];

  test('no pure-core file imports firebase-admin or Firestore', () => {
    for (const file of pureCoreFiles) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source).not.toMatch(/firebase-admin/);
      expect(source).not.toMatch(/from ['"]firebase-functions/);
    }
  });

  test('no pure-core file imports the client POS bundle (src/lib/pos/offline or src/*)', () => {
    for (const file of pureCoreFiles) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source).not.toMatch(/from ['"]\.\.\/\.\.\/src\//);
      expect(source).not.toMatch(/src\/lib\/pos\/offline/);
    }
  });

  test('no pure-core file writes to (or even names as a target) the shifts collection', () => {
    for (const file of pureCoreFiles) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source).not.toMatch(/collection\(['"]shifts['"]\)/);
      expect(source).not.toMatch(/doc\(['"]shifts\//);
    }
  });

  test('every pure-core file exists exactly at its authorized functions/src path', () => {
    const listed = readdirSync(srcDir);
    for (const file of pureCoreFiles) {
      expect(listed).toContain(file);
    }
  });
});
