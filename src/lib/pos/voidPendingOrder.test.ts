import { describe, test, expect } from 'vitest';
import { buildPendingVoidFields } from './voidPendingOrder';

describe('buildPendingVoidFields', () => {
  test('sets the queueable void-intent flags', () => {
    const fields = buildPendingVoidFields({ reason: 'ลูกค้าเปลี่ยนใจ', voidedBy: 'staff-1' });
    expect(fields).toEqual({
      voidRequested: true,
      status: 'voided',
      voidReason: 'ลูกค้าเปลี่ยนใจ',
      voidedBy: 'staff-1',
    });
  });

  test('combines reason + note as "reason — note"', () => {
    const fields = buildPendingVoidFields({
      reason: 'สินค้าผิด',
      note: 'หยิบผิดรส',
      voidedBy: 'staff-1',
    });
    expect(fields.voidReason).toBe('สินค้าผิด — หยิบผิดรส');
  });

  test('trims the note and ignores a whitespace-only note', () => {
    expect(
      buildPendingVoidFields({ reason: 'ราคาผิด', note: '  ', voidedBy: 's' }).voidReason,
    ).toBe('ราคาผิด');
    expect(
      buildPendingVoidFields({ reason: 'ราคาผิด', note: '  พิมพ์ผิด  ', voidedBy: 's' }).voidReason,
    ).toBe('ราคาผิด — พิมพ์ผิด');
  });

  test('always flags voidRequested + status voided (drives the tombstone + ledger exclusion)', () => {
    const fields = buildPendingVoidFields({ reason: 'x', voidedBy: 'y' });
    expect(fields.voidRequested).toBe(true);
    expect(fields.status).toBe('voided');
  });
});
