import { describe, test, expect } from 'vitest';
import {
  canConfirmDestructiveAction,
  getResetStateOnClose,
  isPinInputVisible,
  isModalVisible,
  handlePreventEnter
} from './destructiveConfirmLogic';
import type { DestructiveConfirmState } from './destructiveConfirmLogic';

describe('DestructiveConfirmModal pure logic', () => {
  const baseState: DestructiveConfirmState = {
    open: true,
    loading: false,
    reasonRequired: false,
    reason: '',
    requiresPin: false,
    pin: '',
    pinLength: 4,
  };

  test('1. closed modal renders nothing', () => {
    expect(isModalVisible({ ...baseState, open: false })).toBe(false);
  });

  test('2. confirm cannot run while modal closed', () => {
    expect(canConfirmDestructiveAction({ ...baseState, open: false })).toBe(false);
  });

  test('3. reason-required blocks Confirm until provided', () => {
    expect(canConfirmDestructiveAction({ ...baseState, reasonRequired: true, reason: '  ' })).toBe(false);
    expect(canConfirmDestructiveAction({ ...baseState, reasonRequired: true, reason: 'Lost' })).toBe(true);
  });

  test('4. requiresPin true shows PIN input', () => {
    expect(isPinInputVisible({ ...baseState, requiresPin: true })).toBe(true);
  });

  test('5. Confirm disabled until PIN length is complete', () => {
    const s = { ...baseState, requiresPin: true, pinLength: 4 };
    expect(canConfirmDestructiveAction({ ...s, pin: '123' })).toBe(false);
    expect(canConfirmDestructiveAction({ ...s, pin: '1234' })).toBe(true);
  });

  test('6. requiresPin false hides PIN input', () => {
    expect(isPinInputVisible({ ...baseState, requiresPin: false })).toBe(false);
  });

  test('7. Manager/Admin no-PIN path still requires Confirm', () => {
    // If reason is not required and no PIN is required, confirm should be enabled on open
    expect(canConfirmDestructiveAction({ ...baseState, requiresPin: false })).toBe(true);
  });

  test('8. loading prevents double-submit', () => {
    expect(canConfirmDestructiveAction({ ...baseState, loading: true })).toBe(false);
  });

  test('9. PIN is cleared on close/reopen', () => {
    const s = { ...baseState, pin: '9999', reason: 'Some reason', loading: true };
    const reset = getResetStateOnClose(s);
    expect(reset.pin).toBe('');
    expect(reset.reason).toBe('');
    expect(reset.open).toBe(false);
    expect(reset.loading).toBe(false);
  });

  test('10. handlePreventEnter stops propagation and defaults on Enter', () => {
    let defaultPrevented = false;
    let propStopped = false;
    handlePreventEnter({
      key: 'Enter',
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { propStopped = true; },
    });
    expect(defaultPrevented).toBe(true);
    expect(propStopped).toBe(true);
  });

  test('11. handlePreventEnter ignores non-Enter keys', () => {
    let defaultPrevented = false;
    let propStopped = false;
    handlePreventEnter({
      key: 'Escape',
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { propStopped = true; },
    });
    expect(defaultPrevented).toBe(false);
    expect(propStopped).toBe(false);
  });
});
