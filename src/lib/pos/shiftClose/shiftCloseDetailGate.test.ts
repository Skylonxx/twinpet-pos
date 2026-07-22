import { describe, it, expect } from 'vitest';
import {
  canViewShiftCloseAlertDetail,
  shouldStartShiftCloseAlertDetailQuery,
  validateRouteShiftId,
} from './shiftCloseDetailGate';

describe('canViewShiftCloseAlertDetail (manager/admin gate)', () => {
  it('is true for manager and admin', () => {
    expect(canViewShiftCloseAlertDetail('manager')).toBe(true);
    expect(canViewShiftCloseAlertDetail('admin')).toBe(true);
  });

  it('is false for staff, cashier, null, undefined, and unknown roles', () => {
    expect(canViewShiftCloseAlertDetail('staff')).toBe(false);
    expect(canViewShiftCloseAlertDetail('cashier')).toBe(false);
    expect(canViewShiftCloseAlertDetail(null)).toBe(false);
    expect(canViewShiftCloseAlertDetail(undefined)).toBe(false);
    expect(canViewShiftCloseAlertDetail('some-unknown-role')).toBe(false);
  });
});

describe('validateRouteShiftId', () => {
  it('is FALSE for empty string, null, and undefined', () => {
    expect(validateRouteShiftId('').ok).toBe(false);
    expect(validateRouteShiftId(null).ok).toBe(false);
    expect(validateRouteShiftId(undefined).ok).toBe(false);
  });

  it('is FALSE for "." and ".."', () => {
    expect(validateRouteShiftId('.').ok).toBe(false);
    expect(validateRouteShiftId('..').ok).toBe(false);
  });

  it('is FALSE for a segment containing "/"', () => {
    expect(validateRouteShiftId('abc/def').ok).toBe(false);
    expect(validateRouteShiftId('/abc').ok).toBe(false);
  });

  it('is FALSE for an oversized ID (> 1500 chars)', () => {
    expect(validateRouteShiftId('x'.repeat(1501)).ok).toBe(false);
  });

  it('is TRUE for a normal shiftId, returning it verbatim', () => {
    const result = validateRouteShiftId('SHIFT-001');
    expect(result.ok).toBe(true);
    expect(result.ok && result.shiftId).toBe('SHIFT-001');
  });

  // React Router v7 already URL-decodes params before this validator sees
  // them — a legal doc ID that happens to contain a literal `%` sequence must
  // pass through byte-for-byte, never re-decoded/corrupted by a second
  // decodeURIComponent pass.
  it('passes a legal percent-containing ID through unchanged (no double-decode corruption)', () => {
    const raw = 'SHIFT-2026%2520weird';
    const result = validateRouteShiftId(raw);
    expect(result.ok).toBe(true);
    expect(result.ok && result.shiftId).toBe(raw);
  });
});

describe('shouldStartShiftCloseAlertDetailQuery (must NOT start under any disqualifying condition)', () => {
  it('is FALSE for a non-manager/admin role, even with everything else ready', () => {
    for (const role of ['staff', 'cashier', null, undefined] as const) {
      expect(shouldStartShiftCloseAlertDetailQuery(role, true, true, 'BR-001', 'SHIFT-001')).toBe(false);
    }
  });

  it('is FALSE when Firebase is not configured', () => {
    expect(shouldStartShiftCloseAlertDetailQuery('manager', false, true, 'BR-001', 'SHIFT-001')).toBe(false);
  });

  it('is FALSE when db is missing', () => {
    expect(shouldStartShiftCloseAlertDetailQuery('manager', true, false, 'BR-001', 'SHIFT-001')).toBe(false);
  });

  it('is FALSE when branchId is null', () => {
    expect(shouldStartShiftCloseAlertDetailQuery('manager', true, true, null, 'SHIFT-001')).toBe(false);
  });

  it('is FALSE when branchId is undefined', () => {
    expect(shouldStartShiftCloseAlertDetailQuery('manager', true, true, undefined, 'SHIFT-001')).toBe(false);
  });

  it("is FALSE when branchId === 'ALL' (unscoped global-admin pseudo-branch)", () => {
    expect(shouldStartShiftCloseAlertDetailQuery('admin', true, true, 'ALL', 'SHIFT-001')).toBe(false);
  });

  it('is FALSE when the route shiftId is empty', () => {
    expect(shouldStartShiftCloseAlertDetailQuery('manager', true, true, 'BR-001', '')).toBe(false);
  });

  it('is FALSE for an invalid route segment (contains "/")', () => {
    expect(shouldStartShiftCloseAlertDetailQuery('manager', true, true, 'BR-001', 'a/b')).toBe(false);
  });

  it('is TRUE only when every condition holds: manager/admin, Firebase ready, db present, real branchId, valid shiftId', () => {
    expect(shouldStartShiftCloseAlertDetailQuery('manager', true, true, 'BR-001', 'SHIFT-001')).toBe(true);
    expect(shouldStartShiftCloseAlertDetailQuery('admin', true, true, 'BR-002', 'SHIFT-002')).toBe(true);
  });
});
