// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ReconciliationExceptionsPage from '../../pages/admin/ReconciliationExceptionsPage';

vi.mock('../../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { role: 'admin', branchIds: ['ALL'] } }),
}));

vi.mock('../../lib/reconciliation/adminGate', () => ({
  canViewReconciliationExceptions: (role: string) => role === 'admin',
}));

vi.mock('../../lib/reconciliation/retryReconcile', () => ({
  callRetryReconcile: vi.fn(),
}));

const state = {
  rows: [] as Array<Record<string, unknown>>,
  loading: false,
  error: null as string | null,
  fromCache: false,
  overCap: false,
  atLimit: false,
};

vi.mock('../../lib/reconciliation/useReconciliationExceptions', () => ({
  useReconciliationExceptions: () => state,
}));

afterEach(() => {
  cleanup();
  state.rows = [];
  state.loading = false;
  state.error = null;
  state.fromCache = false;
  state.overCap = false;
  state.atLimit = false;
});

describe('ReconciliationExceptionsPage V9 UI', () => {
  test('N06 server-confirmed empty may render clean success', () => {
    state.rows = [];
    state.fromCache = false;
    state.overCap = false;
    state.atLimit = false;
    render(createElement(ReconciliationExceptionsPage));
    expect(screen.getByText(/ไม่มีรายการกระทบยอดค้าง/)).toBeTruthy();
    expect(screen.queryByText(/เกินขีดจำกัดการสอบถาม/)).toBeNull();
  });

  test('N05 cache-empty does not render confirmed-empty success', () => {
    state.rows = [];
    state.fromCache = true;
    render(createElement(ReconciliationExceptionsPage));
    expect(screen.queryByText(/ไม่มีรายการกระทบยอดค้าง/)).toBeNull();
    expect(screen.getByText(/ยังไม่ยืนยันจากเซิร์ฟเวอร์/)).toBeTruthy();
  });

  test('N08 query error renders failure not clean success', () => {
    state.fromCache = false;
    state.error = 'permission-denied';
    render(createElement(ReconciliationExceptionsPage));
    expect(screen.getByText(/โหลดข้อมูลไม่สำเร็จ/)).toBeTruthy();
    expect(screen.queryByText(/ไม่มีรายการกระทบยอดค้าง/)).toBeNull();
    state.error = null;
  });

  test('N09 V9-only row exposes no retry action', () => {
    state.rows = [
      {
        id: 'v9',
        billId: 'B1',
        branchId: 'br1',
        staffName: 'x',
        total: 1,
        reconcileAttempts: 0,
        lastReconcileError: 'revision_malformed',
        voidRequested: false,
        kinds: ['void_revision_fault'],
        faultDisplay: 'revision_malformed',
        rawFault: 'revision_malformed',
      },
    ];
    render(createElement(ReconciliationExceptionsPage));
    expect(screen.queryByText('รีทราย')).toBeNull();
    expect(screen.getByText(/ไม่มีรีทราย/)).toBeTruthy();
    state.rows = [];
  });

  test('N12 over-cap copy is explicit', () => {
    state.overCap = true;
    state.fromCache = false;
    state.rows = [{ id: 'a', billId: 'B', branchId: 'b', staffName: 's', total: 1, reconcileAttempts: 0, lastReconcileError: 'e', voidRequested: false, kinds: ['exception'] }];
    const { rerender } = render(createElement(ReconciliationExceptionsPage));
    expect(screen.getByText(/เกินขีดจำกัดการสอบถาม/)).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.queryByText(/ไม่มีรายการกระทบยอดค้าง/)).toBeNull();

    state.rows = [];
    rerender(createElement(ReconciliationExceptionsPage));
    expect(screen.getByText(/เกินขีดจำกัดการสอบถาม/)).toBeTruthy();
    expect(screen.queryByText('B')).toBeNull();
    expect(screen.queryByText(/ไม่มีรายการกระทบยอดค้าง/)).toBeNull();
  });

  test('N13 exactly-at-limit 50 warns that more may exist; 49 does not', () => {
    state.atLimit = true;
    state.rows = [{ id: 'a', billId: 'B', branchId: 'b', staffName: 's', total: 1, reconcileAttempts: 0, lastReconcileError: 'e', voidRequested: false, kinds: ['exception'] }];
    const { rerender } = render(createElement(ReconciliationExceptionsPage));
    expect(screen.getByText(/อาจมีมากกว่านี้/)).toBeTruthy();
    state.atLimit = false;
    rerender(createElement(ReconciliationExceptionsPage));
    expect(screen.queryByText(/อาจมีมากกว่านี้/)).toBeNull();
  });
});
