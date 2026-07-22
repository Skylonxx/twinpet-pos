// @vitest-environment jsdom

// RC-2 (R2 remediation) — focused page/render regression: an unknown-only
// server-confirmed snapshot must NEVER render as clean-success
// ("ทำรายการครบถ้วนแล้ว" / "ไม่มีการแจ้งเตือนกะการขายสำหรับสาขานี้"), and the
// malformed data must remain visible. This is the exact gap Codex's R2 review
// found: the mapper/hook were already correct in isolation, but the page's
// independent conditionals let both a warning AND a green success alert
// render at once. The hook is mocked here so this test targets ONLY the
// page's render logic, not the Firestore subscription machinery (already
// covered by useShiftCloseReviewQueue.test.ts).

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import type { ShiftCloseReviewQueueState } from '../lib/pos/shiftClose/useShiftCloseReviewQueue';
import type { ShiftCloseReviewRow } from '../lib/pos/shiftClose/shiftCloseReviewRows';

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { role: 'manager' } }),
}));
vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branchId: 'BR-001', branch: { name: 'สาขาทดสอบ' } }),
}));
vi.mock('../lib/firebase', () => ({
  isFirebaseConfigured: true,
}));

let queueState: ShiftCloseReviewQueueState;
vi.mock('../lib/pos/shiftClose/useShiftCloseReviewQueue', () => ({
  useShiftCloseReviewQueue: () => queueState,
}));

let ShiftCloseReviewPage: typeof import('./ShiftCloseReviewPage').default;

beforeAll(async () => {
  ShiftCloseReviewPage = (await import('./ShiftCloseReviewPage')).default;
});

afterEach(() => cleanup());

const CLEAN_TEXTS = ['ทำรายการครบถ้วนแล้ว', 'ไม่มีการแจ้งเตือนกะการขายสำหรับสาขานี้'];

function malformedRow(id: string, overrides: Partial<ShiftCloseReviewRow> = {}): ShiftCloseReviewRow {
  return {
    id,
    shiftId: id,
    branchId: 'BR-001',
    alertState: 'unknown',
    alertStateLabel: 'สถานะไม่ทราบ (ข้อมูลผิดปกติ)',
    reasonCode: null,
    reasonLabel: '—',
    reasonUnknown: false,
    openedAtMs: null,
    updatedAtMs: null,
    caseVersion: null,
    acknowledgedByActor: null,
    resolvedByActor: null,
    ...overrides,
  };
}

function baseState(overrides: Partial<ShiftCloseReviewQueueState> = {}): ShiftCloseReviewQueueState {
  return {
    status: 'ready',
    rows: [],
    actionableRows: [],
    malformedRows: [],
    totalCount: 0,
    loading: false,
    error: null,
    fromCache: false,
    lastSnapshotAtMs: null,
    ...overrides,
  };
}

describe('ShiftCloseReviewPage — RC-2 false-clean regression', () => {
  test('an unknown-only server-confirmed snapshot does NOT render either clean-success message', () => {
    const row = malformedRow('SHIFT-001');
    queueState = baseState({ rows: [row], malformedRows: [row], totalCount: 1 });

    render(createElement(ShiftCloseReviewPage));

    for (const text of CLEAN_TEXTS) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  test('an unknown-only server-confirmed snapshot DOES render the malformed-data warning, listing the shift ID', () => {
    const row = malformedRow('SHIFT-001');
    queueState = baseState({ rows: [row], malformedRows: [row], totalCount: 1 });

    render(createElement(ShiftCloseReviewPage));

    expect(screen.getByText(/SHIFT-001/)).toBeTruthy();
    expect(screen.getByText(/พบข้อมูลผิดรูปแบบ/)).toBeTruthy();
  });

  test('a resolved row with an unknown reason does NOT produce clean-success (alertState-only check would miss it)', () => {
    const row = malformedRow('SHIFT-RESOLVED-BAD-REASON', {
      alertState: 'resolved',
      alertStateLabel: 'แก้ไขแล้ว',
      reasonLabel: 'ไม่ทราบสาเหตุ (ข้อมูลผิดปกติ)',
      reasonUnknown: true,
    });
    queueState = baseState({ rows: [row], malformedRows: [row], totalCount: 1 });

    render(createElement(ShiftCloseReviewPage));

    for (const text of CLEAN_TEXTS) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  test('a resolved row with an unknown reason IS included in the malformed-data warning', () => {
    const row = malformedRow('SHIFT-RESOLVED-BAD-REASON', {
      alertState: 'resolved',
      alertStateLabel: 'แก้ไขแล้ว',
      reasonLabel: 'ไม่ทราบสาเหตุ (ข้อมูลผิดปกติ)',
      reasonUnknown: true,
    });
    queueState = baseState({ rows: [row], malformedRows: [row], totalCount: 1 });

    render(createElement(ShiftCloseReviewPage));

    expect(screen.getByText(/SHIFT-RESOLVED-BAD-REASON/)).toBeTruthy();
  });

  test('control: clean-success DOES render normally when there is zero actionable AND zero malformed data', () => {
    queueState = baseState({ totalCount: 0 });

    render(createElement(ShiftCloseReviewPage));

    expect(screen.getByText('ไม่มีการแจ้งเตือนกะการขายสำหรับสาขานี้')).toBeTruthy();
  });

  test('control: "ทำรายการครบถ้วนแล้ว" DOES render when totalCount > 0, zero actionable, and zero malformed', () => {
    const resolvedClean = malformedRow('SHIFT-CLEAN', {
      alertState: 'resolved',
      alertStateLabel: 'แก้ไขแล้ว',
      reasonCode: 'retry_exhausted',
      reasonLabel: 'ลองใหม่ครบจำนวนครั้งสูงสุดแล้ว',
      reasonUnknown: false,
    });
    queueState = baseState({ rows: [resolvedClean], malformedRows: [], totalCount: 1 });

    render(createElement(ShiftCloseReviewPage));

    expect(screen.getByText('ทำรายการครบถ้วนแล้ว')).toBeTruthy();
  });
});
