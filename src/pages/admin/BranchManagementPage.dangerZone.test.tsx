// @vitest-environment jsdom

/**
 * 018 — Danger Zone UI: resets that would touch shifts, cash, sales or inventory
 * are disabled with an explicit safety notice and never reach a confirm or a
 * write. (019 also retired the master data hard deletes — see
 * BranchManagementPage.uatRetired.test.tsx.)
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('firebase/firestore', async () =>
  (await import('../../lib/admin/clearTestData.fakeFirestore')).fakeFirestoreModule);
vi.mock('../../lib/firebase', async () =>
  (await import('../../lib/admin/clearTestData.fakeFirestore')).fakeFirebaseModule);
vi.mock('../../lib/firebaseAuth', async () =>
  (await import('../../lib/admin/clearTestData.fakeFirestore')).fakeFirebaseAuthModule);
vi.mock('../../lib/admin/branchManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/admin/branchManagement')>()),
  useBranchManagement: () => ({ branches: [], loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('../../lib/seedData', () => ({ seedMockData: vi.fn() }));

import { fakeDb } from '../../lib/admin/clearTestData.fakeFirestore';
import BranchManagementPage from './BranchManagementPage';

const BLOCKED_LABELS = [
  'ลบประวัติการขายทั้งหมด',
  'ลบประวัติการรับเข้าและโอนสินค้า',
  'ลบประวัติ Movement และ FIFO',
  'รีเซ็ตสต็อกสินค้าเป็น 0',
  'Factory Reset',
  'Hard Delete Products',
];

function button(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: new RegExp(label.replace(/[()]/g, '\\$&')) });
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fakeDb.reset();
  fakeDb.seed('orders/o1');
  fakeDb.seed('stockMovements/m1');
  fakeDb.seed('shifts/s1', { status: 'closed' });
  fakeDb.seed('cashTransactions/ordinary1');
  fakeDb.seed('cashTransactions/rfd_ret1', { source: 'sale_refund' });
  fakeDb.seed('suppliers/sup1');
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('018 — Danger Zone UI reset safety', () => {
  test('every shift/cash/sales/inventory reset button is disabled behind a visible safety notice', () => {
    render(createElement(BranchManagementPage));
    for (const label of BLOCKED_LABELS) {
      expect(button(label).disabled, label).toBe(true);
    }
    const notice = document.getElementById('admin-danger-blocked-notice')!;
    expect(notice.getAttribute('role')).toBe('note');
    expect(notice.textContent).toContain('ไม่มีข้อมูลถูกลบ');
    expect(notice.textContent).toContain('Factory Reset');
  });

  test('clicking Factory Reset asks nothing, writes nothing and never shows success', async () => {
    render(createElement(BranchManagementPage));
    fireEvent.click(button('Factory Reset'));
    fireEvent.click(button('ลบประวัติการขายทั้งหมด'));
    // Give any (wrongly) started async run a chance to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(fakeDb.ops).toEqual([]);
    expect(fakeDb.committedWrites).toBe(0);
    expect(fakeDb.has('shifts/s1')).toBe(true);
    expect(fakeDb.has('orders/o1')).toBe(true);
    expect(screen.queryByText(/สำเร็จ/)).toBeNull();
  });
});
