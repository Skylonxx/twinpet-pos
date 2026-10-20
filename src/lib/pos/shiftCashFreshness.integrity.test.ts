// Return/Refund V1 — C1-R1 R1-B: the pure cash-entry identity checker. The
// behavior of the real close is proven in shiftService.cashIntegrity.test.ts;
// this pins the checker's own contract (which sources/shapes are accepted).
import { describe, expect, test } from 'vitest';
import type { ShiftCashEntry } from '../types';
import { checkCashEntryIntegrity, mergeCashEntries } from './shiftCashFreshness';

const e = (id: string, over: Partial<ShiftCashEntry> = {}): ShiftCashEntry => ({
  id,
  type: 'pay_out',
  amount: 81,
  note: 'n',
  staffId: 's1',
  staffName: 'S',
  at: 1,
  ...over,
});
const RFD = `rfd_${'b'.repeat(40)}`;

describe('checkCashEntryIntegrity', () => {
  test('no sources, empty lists and absent (undefined) sources are fine', () => {
    expect(checkCashEntryIntegrity([])).toEqual({ ok: true });
    expect(checkCashEntryIntegrity([{ label: 'local', entries: [] }, { label: 'server', entries: undefined }])).toEqual({ ok: true });
  });

  test('a field-identical mirror across local / cache / server is accepted (distinct object copies)', () => {
    expect(
      checkCashEntryIntegrity([
        { label: 'local', entries: [e('a'), e(RFD)] },
        { label: 'cache', entries: [{ ...e('a') }, { ...e(RFD) }] },
        { label: 'server', entries: [{ ...e('a') }, { ...e(RFD) }, e('z', { type: 'pay_in' })] },
      ]),
    ).toEqual({ ok: true });
  });

  test('duplicate id inside one source is refused even when the objects are identical', () => {
    expect(checkCashEntryIntegrity([{ label: 'server', entries: [e(RFD), { ...e(RFD) }] }])).toEqual({
      ok: false,
      reason: 'duplicate_id_in_source',
      source: 'server',
      id: RFD,
    });
  });

  test('same id across sources with ANY differing compared field is a collision (type, amount, note, staff, time)', () => {
    for (const diff of [{ type: 'pay_in' as const }, { amount: 1 }, { note: 'x' }, { staffId: 's2' }, { staffName: 'T' }, { at: 2 }]) {
      expect(
        checkCashEntryIntegrity([
          { label: 'local', entries: [e(RFD)] },
          { label: 'server', entries: [e(RFD, diff)] },
        ]),
      ).toEqual({ ok: false, reason: 'conflicting_id_across_sources', source: 'server', id: RFD, otherSource: 'local' });
    }
  });

  test('ids are case-sensitive: rfd_X and RFD_X are different movements', () => {
    expect(
      checkCashEntryIntegrity([{ label: 'server', entries: [e(RFD), e(RFD.toUpperCase(), { amount: 4 })] }]),
    ).toEqual({ ok: true });
  });

  test('money-bearing malformed entries are refused and never coerced', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'x',
      7,
      [e('a')],
      { ...e('a'), id: undefined },
      { ...e('a'), id: '' },
      { ...e('a'), id: '  ' },
      { ...e('a'), id: 3 },
      { ...e('a'), type: 'refund' },
      { ...e('a'), type: undefined },
      { ...e('a'), amount: '5' },
      { ...e('a'), amount: Number.NaN },
      { ...e('a'), amount: Number.POSITIVE_INFINITY },
      { ...e('a'), amount: Number.NEGATIVE_INFINITY },
      { ...e('a'), amount: -1 },
      { ...e('a'), amount: 0 },
      { ...e('a'), amount: null },
    ];
    for (const entry of bad) {
      const verdict = checkCashEntryIntegrity([{ label: 'cache', entries: [entry] }]);
      expect(verdict).toMatchObject({ ok: false, reason: 'malformed_entry', source: 'cache' });
    }
  });

  test('a sparse list hole is malformed', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(checkCashEntryIntegrity([{ label: 'local', entries: [e('a'), , e('b')] }])).toMatchObject({ ok: false, reason: 'malformed_entry' });
  });

  test('a present-but-not-a-list source is corrupt (null, object, string, number)', () => {
    for (const bad of [null, { 0: e('a') }, 'oops', 3, true]) {
      expect(checkCashEntryIntegrity([{ label: 'server', entries: bad }])).toEqual({ ok: false, reason: 'not_a_list', source: 'server' });
    }
  });

  test('non-money fields may be absent (historical entry) — only compared across sources', () => {
    const thin = { id: 'h1', type: 'pay_in', amount: 5 } as unknown as ShiftCashEntry;
    expect(checkCashEntryIntegrity([{ label: 'server', entries: [thin] }, { label: 'cache', entries: [{ ...thin }] }])).toEqual({ ok: true });
  });

  test('mergeCashEntries is unchanged: a pure first-wins union (display), which is exactly why the close checks first', () => {
    expect(mergeCashEntries([e(RFD, { amount: 1 })], [e(RFD, { amount: 81 })]).map((x) => x.amount)).toEqual([1]);
  });
});
