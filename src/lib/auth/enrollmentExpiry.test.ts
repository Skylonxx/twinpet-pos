import { describe, expect, it } from 'vitest';
import { classifyEnr1ConfirmWindow, ENR1_CONFIRM_SAFETY_MARGIN_MS } from './enrollmentExpiry';

const EXPIRES = 1_790_001_800_000;

describe('classifyEnr1ConfirmWindow (TPOS-R7 0.1.6 confirm-time ENR1 expiry gate)', () => {
  it('uses a five-minute safety margin', () => {
    expect(ENR1_CONFIRM_SAFETY_MARGIN_MS).toBe(5 * 60 * 1000);
  });

  it('comfortably valid -> ok', () => {
    expect(classifyEnr1ConfirmWindow(EXPIRES, EXPIRES - 29 * 60_000)).toBe('ok');
  });

  it('boundary: exactly the margin remaining -> ok; one millisecond less -> too close', () => {
    expect(classifyEnr1ConfirmWindow(EXPIRES, EXPIRES - ENR1_CONFIRM_SAFETY_MARGIN_MS)).toBe('ok');
    expect(classifyEnr1ConfirmWindow(EXPIRES, EXPIRES - ENR1_CONFIRM_SAFETY_MARGIN_MS + 1)).toBe('too_close_to_expiry');
  });

  it('inside the safety margin -> too_close_to_expiry', () => {
    expect(classifyEnr1ConfirmWindow(EXPIRES, EXPIRES - 60_000)).toBe('too_close_to_expiry');
    expect(classifyEnr1ConfirmWindow(EXPIRES, EXPIRES - 1)).toBe('too_close_to_expiry');
  });

  it('exactly expired and after expiry -> expired', () => {
    expect(classifyEnr1ConfirmWindow(EXPIRES, EXPIRES)).toBe('expired');
    expect(classifyEnr1ConfirmWindow(EXPIRES, EXPIRES + 1)).toBe('expired');
  });

  it('picked while valid, confirm delayed until unsafe -> refused at confirm time', () => {
    const pickedAt = EXPIRES - 20 * 60_000;
    expect(classifyEnr1ConfirmWindow(EXPIRES, pickedAt)).toBe('ok');
    expect(classifyEnr1ConfirmWindow(EXPIRES, pickedAt + 16 * 60_000)).toBe('too_close_to_expiry');
    expect(classifyEnr1ConfirmWindow(EXPIRES, pickedAt + 21 * 60_000)).toBe('expired');
  });

  it('non-finite inputs fail closed as expired', () => {
    expect(classifyEnr1ConfirmWindow(Number.NaN, EXPIRES - 29 * 60_000)).toBe('expired');
    expect(classifyEnr1ConfirmWindow(Number.POSITIVE_INFINITY, EXPIRES)).toBe('expired');
    expect(classifyEnr1ConfirmWindow(EXPIRES, Number.NaN)).toBe('expired');
  });
});
