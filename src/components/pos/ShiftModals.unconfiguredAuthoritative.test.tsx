// @vitest-environment jsdom

// Return/Refund V1 packet 016 — Codex-015: the close modal over the REAL
// `closeShift` with an unconfigured Firebase. Gate ON: the refusal is shown and
// the Z-Report is never rendered (the dev mock never closes the shift). Gate
// OFF: the unconfigured dev close still renders its Z exactly as before.
//
// Provenance: only symbols that exist at the parent commit (bd46a0a) are
// imported (the gate constant is mocked by name, test-only); on the parent the
// ON case renders a Z from the dev mock, so it fails on BEHAVIOUR.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  gate: { on: false },
  readServerShiftCash: vi.fn(),
}));

vi.mock('../../lib/firebase', () => ({
  isFirebaseConfigured: false,
  db: undefined,
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

vi.mock('../../lib/pos/shiftCashFreshness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftCashFreshness')>();
  return { ...actual, readServerShiftCash: mocks.readServerShiftCash };
});

vi.mock('../../lib/pos/shiftCloseAuthoritativeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftCloseAuthoritativeClient')>();
  return {
    ...actual,
    get SERVER_AUTHORITATIVE_CLOSE_ENABLED() {
      return mocks.gate.on;
    },
  };
});

vi.mock('../../lib/pos/shiftDevMock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftDevMock')>();
  return { ...actual, devCloseShift: vi.fn(actual.devCloseShift) };
});

import { CloseShiftModal } from './ShiftModals';
import * as devMock from '../../lib/pos/shiftDevMock';
import type { Shift } from '../../lib/types';

const UNCONFIGURED = 'ยังไม่ได้ตั้งค่าการเชื่อมต่อเซิร์ฟเวอร์ (Firebase)';
const Z_TITLE = 'ปิดกะสำเร็จ — Z-Report';
const devCloseShift = vi.mocked(devMock.devCloseShift);

let staffSeq = 0;
function openDevShift(): Shift {
  const staffId = `staff-016-modal-${(staffSeq += 1)}`;
  devMock.devOpenShift('LDP-001', staffId, 'ทดสอบ ระบบ', 500);
  const shift = devMock.devGetActiveShift('LDP-001', staffId);
  if (!shift) throw new Error('fixture: dev shift not opened');
  return shift;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function confirmClose(count: string) {
  fireEvent.change(screen.getByLabelText(/นับเงินสดในลิ้นชัก/), { target: { value: count } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
  });
  await flush();
}

beforeEach(() => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  mocks.gate.on = false;
  mocks.readServerShiftCash.mockReset();
  mocks.readServerShiftCash.mockResolvedValue({ ok: true, exists: true, status: 'open', cashEntries: [] });
  devCloseShift.mockClear();
});

afterEach(() => cleanup());

describe('016 — close modal over an unconfigured Firebase', () => {
  test('[RED-parent] gate ON ⇒ the Thai refusal is shown and NO Z-Report is rendered', async () => {
    mocks.gate.on = true;
    const shift = openDevShift();
    render(createElement(CloseShiftModal, { shift, onClose: vi.fn(), onSuccess: vi.fn() }));
    await flush();

    await confirmClose('500');

    expect(screen.queryByText(Z_TITLE)).toBeNull();
    expect(screen.getByText((text) => text.includes(UNCONFIGURED))).toBeTruthy();
    expect(devCloseShift).not.toHaveBeenCalled();
    expect(devMock.devGetActiveShift(shift.branchId, shift.staffId)?.status).toBe('open');
  });

  test('[GREEN-guard] gate OFF ⇒ the unconfigured dev close renders its Z exactly as before', async () => {
    const shift = openDevShift();
    render(createElement(CloseShiftModal, { shift, onClose: vi.fn(), onSuccess: vi.fn() }));
    await flush();

    await confirmClose('500');

    expect(devCloseShift).toHaveBeenCalledWith(shift.id, 500, '');
    expect(screen.getByText(Z_TITLE)).toBeTruthy();
    expect(screen.queryByText((text) => text.includes(UNCONFIGURED))).toBeNull();
  });
});
