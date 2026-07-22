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
import { MemoryRouter } from 'react-router-dom';
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

function renderPage() {
  return render(createElement(MemoryRouter, null, createElement(ShiftCloseReviewPage)));
}

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

    renderPage();

    for (const text of CLEAN_TEXTS) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });

  test('an unknown-only server-confirmed snapshot DOES render the malformed-data warning, listing the shift ID', () => {
    const row = malformedRow('SHIFT-001');
    queueState = baseState({ rows: [row], malformedRows: [row], totalCount: 1 });

    renderPage();

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

    renderPage();

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

    renderPage();

    expect(screen.getByText(/SHIFT-RESOLVED-BAD-REASON/)).toBeTruthy();
  });

  test('control: clean-success DOES render normally when there is zero actionable AND zero malformed data', () => {
    queueState = baseState({ totalCount: 0 });

    renderPage();

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

    renderPage();

    expect(screen.getByText('ทำรายการครบถ้วนแล้ว')).toBeTruthy();
  });
});

// Packet 5 / UI-B core — the queue must expose a real, accessible link into
// the read-only detail route using the canonical `row.id` (never the raw
// stored `row.shiftId`, which may differ — see shiftCloseDetailProjection's
// stored-ID-mismatch integrity check), URL-encoded so a doc ID containing
// reserved characters still round-trips.
describe('ShiftCloseReviewPage — UI-B detail link (row -> /shift-close-review/:shiftId)', () => {
  function rowWithId(id: string, overrides: Partial<ShiftCloseReviewRow> = {}): ShiftCloseReviewRow {
    return {
      id,
      shiftId: id,
      branchId: 'BR-001',
      alertState: 'open',
      alertStateLabel: 'เปิดอยู่',
      reasonCode: null,
      reasonLabel: '—',
      reasonUnknown: false,
      openedAtMs: null,
      updatedAtMs: null,
      caseVersion: 1,
      acknowledgedByActor: null,
      resolvedByActor: null,
      ...overrides,
    };
  }

  test('renders a real, keyboard-focusable <a> link (not a mouse-only row onClick)', () => {
    const row = rowWithId('SHIFT-001');
    queueState = baseState({ rows: [row], actionableRows: [row], totalCount: 1 });

    renderPage();

    const link = screen.getByText('ดูรายละเอียด').closest('a');
    expect(link).toBeTruthy();
    expect(link?.tagName).toBe('A');
  });

  test('the link target uses the canonical row.id, URL-encoded', () => {
    const row = rowWithId('SHIFT/WEIRD ID');
    queueState = baseState({ rows: [row], actionableRows: [row], totalCount: 1 });

    renderPage();

    const link = screen.getByText('ดูรายละเอียด').closest('a');
    expect(link?.getAttribute('href')).toBe(`/shift-close-review/${encodeURIComponent('SHIFT/WEIRD ID')}`);
  });

  test('the link uses row.id even when the stored shiftId field differs (stored-ID-mismatch case)', () => {
    const row = rowWithId('DOC-ID-001', { shiftId: 'STORED-DIFFERENT-ID' });
    queueState = baseState({ rows: [row], actionableRows: [row], totalCount: 1 });

    renderPage();

    const link = screen.getByText('ดูรายละเอียด').closest('a');
    expect(link?.getAttribute('href')).toBe(`/shift-close-review/${encodeURIComponent('DOC-ID-001')}`);
  });

  test('does not regress existing UI-A malformed-row rendering alongside the new link column', () => {
    const row = malformedRow('SHIFT-001');
    queueState = baseState({ rows: [row], malformedRows: [row], totalCount: 1 });

    renderPage();

    expect(screen.getByText(/พบข้อมูลผิดรูปแบบ/)).toBeTruthy();
  });

  // RC-2.3 remediation: the row link was an inline text link with no
  // minimum touch target. `min-h-11` (44px) is the project's standard
  // mobile/tablet touch-target class (see BackToQueueLink and
  // CopyShiftIdButton on the detail page for the same convention).
  test('the row detail link has a >=44px touch target class', () => {
    const row = rowWithId('SHIFT-001');
    queueState = baseState({ rows: [row], actionableRows: [row], totalCount: 1 });

    renderPage();

    const link = screen.getByText('ดูรายละเอียด').closest('a');
    expect(link?.className).toContain('min-h-11');
  });
});
