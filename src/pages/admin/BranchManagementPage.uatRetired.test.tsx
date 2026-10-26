// @vitest-environment jsdom

/**
 * 019 — Branch Management UI: the customers / suppliers / categories hard deletes and
 * the Seed Zone action are retired. Their controls are disabled behind a visible,
 * accessible explanation; click, keyboard and a directly invoked React handler can
 * never reach a confirm, the seeder, a write, or a success message.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const seedMockDataSpy = vi.hoisted(() => vi.fn());
vi.mock('../../lib/seedData', () => ({ seedMockData: seedMockDataSpy }));

import { fakeDb } from '../../lib/admin/clearTestData.fakeFirestore';
import {
  UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE,
  UAT_SEED_RETIRED_MESSAGE,
} from '../../lib/admin/uatToolRetired';
import BranchManagementPage from './BranchManagementPage';

const HARD_DELETE_LABELS = ['Hard Delete Customers', 'Hard Delete Suppliers', 'Hard Delete Categories'];
const SEED_LABEL = /นำเข้าข้อมูลตัวอย่าง/;

function button(label: string | RegExp): HTMLButtonElement {
  const name = typeof label === 'string' ? new RegExp(label.replace(/[()]/g, '\\$&')) : label;
  return screen.getByRole('button', { name });
}

function describedBy(el: HTMLElement): HTMLElement {
  const id = el.getAttribute('aria-describedby');
  expect(id, 'a retired control must point at its explanation').toBeTruthy();
  const target = document.getElementById(id!);
  expect(target, `#${id} must exist`).not.toBeNull();
  return target!;
}

function reactProps(el: HTMLElement): { onClick?: () => unknown } {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  return (key ? (el as unknown as Record<string, unknown>)[key] : {}) as { onClick?: () => unknown };
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fakeDb.reset();
  seedMockDataSpy.mockReset();
  fakeDb.seed('customers/cust1', { outstandingBalance: 300 });
  fakeDb.seed('creditAccounts/cust1', { creditUsed: 300 });
  fakeDb.seed('suppliers/sup1');
  fakeDb.seed('categories/cat1');
  fakeDb.seed('products/PROD-001/productStocks/B1', { totalStockBase: 7 });
  fakeDb.seed('stockLots/PROD-001_B1_seed', { qtyRemaining: 3 });
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function expectNothingHappened(before: Map<string, unknown>) {
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(seedMockDataSpy).not.toHaveBeenCalled();
  expect(fakeDb.ops).toEqual([]);
  expect(fakeDb.committedWrites).toBe(0);
  expect(new Map(fakeDb.docs)).toEqual(before);
  expect(screen.queryByText(/สำเร็จ|นำเข้าข้อมูลสำเร็จ|✅/)).toBeNull();
}

describe('019 — retired controls are disabled and explained', () => {
  test('the three master hard deletes are disabled and described by the retirement notice', () => {
    render(createElement(BranchManagementPage));
    for (const label of HARD_DELETE_LABELS) {
      const el = button(label);
      expect(el.disabled, label).toBe(true);
      expect(describedBy(el).textContent, label).toContain(UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE);
      expect(describedBy(el).getAttribute('role')).toBe('note');
    }
  });

  test('Hard Delete Products stays blocked by the 018 notice (not the 019 one)', () => {
    render(createElement(BranchManagementPage));
    const el = button('Hard Delete Products');
    expect(el.disabled).toBe(true);
    expect(describedBy(el).id).toBe('admin-danger-blocked-notice');
  });

  test('the Seed Zone action is disabled, explained and carries no handler', () => {
    render(createElement(BranchManagementPage));
    const el = button(SEED_LABEL);
    expect(el.disabled).toBe(true);
    expect(el.textContent).toContain('ปิดใช้งาน');
    expect(describedBy(el).textContent).toContain(UAT_SEED_RETIRED_MESSAGE);
    expect(reactProps(el).onClick, 'no seed handler may be wired').toBeUndefined();
  });

  test('Seed Zone copy no longer claims a runnable seed, 10 products, zero stock or safe re-runs', () => {
    render(createElement(BranchManagementPage));
    const zone = screen.getByRole('region', { name: 'Seed Mock Data' });
    expect(zone.textContent).not.toMatch(/10 รายการ|เริ่มต้น 0|รันซ้ำได้/);
    expect(zone.textContent).toContain('ปิดใช้งาน');
    expect(zone.textContent).toContain('ล็อต FIFO');
  });
});

describe('019 — retired controls cannot run by click, keyboard or direct handler', () => {
  test('click and keyboard on every retired control: no confirm, seeder, read, write or success', async () => {
    render(createElement(BranchManagementPage));
    const before = new Map(fakeDb.docs);
    for (const el of [...HARD_DELETE_LABELS.map(button), button(SEED_LABEL)]) {
      fireEvent.click(el);
      fireEvent.keyDown(el, { key: 'Enter' });
      fireEvent.keyUp(el, { key: ' ' });
      fireEvent.keyDown(el, { key: ' ' });
    }
    // Give any (wrongly) started async run a chance to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectNothingHappened(before);
  });

  test.each(HARD_DELETE_LABELS)('%s: a directly invoked onClick refuses with an error alert, no confirm and no write', async (label) => {
    render(createElement(BranchManagementPage));
    const before = new Map(fakeDb.docs);
    const onClick = reactProps(button(label)).onClick;
    expect(typeof onClick).toBe('function');
    await act(async () => {
      await onClick!();
    });
    expectNothingHappened(before);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('❌');
    expect(alert.textContent).toContain(UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE);
  });
});
