// @vitest-environment jsdom
/**
 * D-ASC7 — the legacy staff-management mutation UI is retired from the
 * shipped app. `/staff` and `/admin/staff` redirect to the Admin & Security
 * Center (`/settings/admin-security`), no navigation entry points at the old
 * pages, and both a Quick PIN admin and a password admin end up in the new
 * center (password-required state vs. the center itself) — never in the
 * legacy edit / toggle / delete controls.
 *
 * Every page module is stubbed; the settings page stub mounts the REAL
 * AdminSecurityCenter so the landing state is the shipped one.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  passwordSession: false,
  operator: { id: 'admin1', role: 'admin' } as { id: string; role: string },
  fetchOverview: null as null | (() => Promise<unknown>),
}));

vi.mock('./lib/firebase', () => ({
  app: undefined,
  auth: undefined,
  db: undefined,
  collections: { settings: 'settings', branches: 'branches' },
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));

const { stub, outlet } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: () => `PAGE:${name}` }),
  outlet: async () => {
    const { Outlet } = await import('react-router-dom');
    return { default: () => <Outlet /> };
  },
}));

vi.mock('./components/GuestRoute', outlet);
vi.mock('./components/ProtectedRoute', outlet);
vi.mock('./components/PosShellRoute', outlet);
vi.mock('./layouts/SettingsLayout', outlet);
vi.mock('./layouts/AdminLayout', outlet);
vi.mock('./components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('./pages/CustomerPage', () => stub('CustomerPage'));
vi.mock('./pages/DashboardPage', () => stub('DashboardPage'));
vi.mock('./pages/ExportReportPage', () => stub('ExportReportPage'));
vi.mock('./pages/inventory/TransferPage', () => stub('TransferPage'));
vi.mock('./pages/inventory/InventoryAdjustmentPage', () => stub('InventoryAdjustmentPage'));
vi.mock('./pages/inventory/InventoryPage', () => stub('InventoryPage'));
vi.mock('./pages/LoginPage', () => stub('LoginPage'));
vi.mock('./pages/POSPage', () => stub('POSPage'));
vi.mock('./pages/ProductCRUDPage', () => stub('ProductCRUDPage'));
vi.mock('./pages/ProfitReportPage', () => stub('ProfitReportPage'));
vi.mock('./pages/ReceivingPage', () => stub('ReceivingPage'));
vi.mock('./pages/ReceivingHistoryPage', () => stub('ReceivingHistoryPage'));
vi.mock('./pages/ReceivingEditPage', () => stub('ReceivingEditPage'));
vi.mock('./pages/SalesHistoryPage', () => stub('SalesHistoryPage'));
vi.mock('./pages/ReceivablesPage', () => stub('ReceivablesPage'));
vi.mock('./pages/admin/AdminDashboardPage', () => stub('AdminDashboardPage'));
vi.mock('./pages/WorkspaceSelector', () => stub('WorkspaceSelector'));
vi.mock('./pages/admin/AdminProductManagementPage', () => stub('AdminProductManagementPage'));
vi.mock('./pages/admin/AdminReceivingPage', () => stub('AdminReceivingPage'));
vi.mock('./pages/admin/AdminTransferPage', () => stub('AdminTransferPage'));
vi.mock('./pages/admin/AdminTransferCreatePage', () => stub('AdminTransferCreatePage'));
vi.mock('./pages/admin/AdminStockReportPage', () => stub('AdminStockReportPage'));
vi.mock('./pages/admin/ReconciliationExceptionsPage', () => stub('ReconciliationExceptionsPage'));
vi.mock('./pages/admin/BranchManagementPage', () => stub('BranchManagementPage'));
vi.mock('./pages/admin/TierManagementPage', () => stub('TierManagementPage'));
vi.mock('./pages/admin/AdminSupplierManagementPage', () => stub('AdminSupplierManagementPage'));
vi.mock('./pages/admin/SortingSettingsPage', () => stub('SortingSettingsPage'));
vi.mock('./pages/admin/QuickMenuSettingsPage', () => stub('QuickMenuSettingsPage'));
vi.mock('./pages/settings/DocumentSettings', () => stub('DocumentSettings'));
vi.mock('./pages/ManualReviewOpsPage', () => stub('ManualReviewOpsPage'));
vi.mock('./pages/StockReportPage', () => stub('StockReportPage'));
vi.mock('./pages/SupplierPage', () => stub('SupplierPage'));
vi.mock('./pages/ShiftCloseReviewPage', () => stub('ShiftCloseReviewPage'));
vi.mock('./pages/ShiftCloseAlertDetailPage', () => stub('ShiftCloseAlertDetailPage'));
vi.mock('./pages/SyncCenterPage', () => stub('SyncCenterPage'));
// Legacy pages: if anything still routed to them, this marker would render.
vi.mock('./pages/StaffManagementPage', () => stub('StaffManagementPage'));
vi.mock('./pages/admin/AdminStaffManagementPage', () => stub('AdminStaffManagementPage'));
vi.mock('./pages/SettingsPage', async () => {
  const { default: AdminSecurityCenter } = await vi.importActual<typeof import('./pages/settings/AdminSecurityCenter')>(
    './pages/settings/AdminSecurityCenter',
  );
  const { navItemBySlug } = await vi.importActual<typeof import('./lib/settings/settingsNav')>('./lib/settings/settingsNav');
  function SettingsPageStub() {
    const location = useLocation();
    const slug = location.pathname.split('/').pop() ?? '';
    return (
      <div>
        <div data-testid="location">{location.pathname}</div>
        {navItemBySlug(slug)?.section === 'admin' ? (
          <AdminSecurityCenter
            operator={h.operator}
            branchId="LDP-001"
            deps={{
              service: {
                isAdminPasswordSession: async () => h.passwordSession,
                fetchOverview: async () => (h.fetchOverview ? h.fetchOverview() : { ok: false, code: 'not_authorized' }),
              },
              invoke: null,
              fetchBranches: async () => [],
            }}
          />
        ) : (
          `SETTINGS:${slug}`
        )}
      </div>
    );
  }
  return { default: SettingsPageStub };
});

import { AppRoutes } from './App';
import { ALL_NAV_ITEMS } from './config/navigation';
import { ADMIN_NAV } from './config/adminNavigation';
import { ADMIN_SECURITY_CENTER_PATH, navItemBySlug } from './lib/settings/settingsNav';
import { __resetAdminSecurityServiceForTests } from './lib/adminSecurity/adminSecurityService';

const LEGACY_CONTROL_TEXT = /แก้ไข|ลบ|ระงับ|Actions|สิทธิ์ตาม Role|PAGE:(Admin)?StaffManagementPage/;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetAdminSecurityServiceForTests();
  h.passwordSession = false;
  h.operator = { id: 'admin1', role: 'admin' };
  h.fetchOverview = null;
});
afterEach(cleanup);

describe('D-ASC7 — legacy staff routes are closed', () => {
  it('the center path is the settings admin section', () => {
    expect(ADMIN_SECURITY_CENTER_PATH).toBe('/settings/admin-security');
    expect(navItemBySlug('admin-security')?.section).toBe('admin');
  });

  for (const path of ['/staff', '/admin/staff']) {
    it(`a Quick PIN admin deep-linking ${path} lands on the center's password-required state, not legacy controls`, async () => {
      renderAt(path);
      expect(await screen.findByTestId('admin-password-required')).toBeTruthy();
      expect(screen.getByTestId('location').textContent).toBe('/settings/admin-security');
      expect(screen.queryByText(/PAGE:(Admin)?StaffManagementPage/)).toBeNull();
      expect(document.body.textContent ?? '').not.toMatch(LEGACY_CONTROL_TEXT);
      expect(screen.queryByText('เพิ่มผู้ใช้งาน')).toBeNull();
    });

    it(`a password admin deep-linking ${path} also uses the new center`, async () => {
      h.passwordSession = true;
      h.fetchOverview = async () => ({
        ok: true,
        users: [
          {
            userId: 'admin1', firstName: 'Ad', lastName: 'Min', username: 'admin', role: 'admin', branchIds: ['ALL'],
            isActive: true, authVersion: 2, quickPinState: 'set', securityAdminClassification: 'PASSWORD_ADMIN',
          },
        ],
        events: [],
      });
      renderAt(path);
      expect(await screen.findByText('Admin password session')).toBeTruthy();
      expect(await screen.findByText('Security Admin')).toBeTruthy();
      expect(screen.getByTestId('location').textContent).toBe('/settings/admin-security');
      expect(screen.getByTestId('admin-security-center')).toBeTruthy();
      expect(screen.queryByText(/PAGE:(Admin)?StaffManagementPage/)).toBeNull();
    });
  }

  it('no navigation entry points at the legacy pages', () => {
    const mainPaths = ALL_NAV_ITEMS.map((i) => i.path);
    const adminPaths = ADMIN_NAV.map((i) => i.path as string);
    for (const legacy of ['/staff', '/admin/staff']) {
      expect(mainPaths).not.toContain(legacy);
      expect(adminPaths).not.toContain(legacy);
    }
  });

  it('the route tree no longer imports or renders the legacy mutation pages', () => {
    const src = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');
    expect(src).not.toMatch(/StaffManagementPage/);
    expect(src).toMatch(/path="\/staff" element={<Navigate to={ADMIN_SECURITY_CENTER_PATH} replace \/>}/);
    expect(src).toMatch(/path="staff" element={<Navigate to={ADMIN_SECURITY_CENTER_PATH} replace \/>}/);
  });

  it('unrelated routes are unaffected', async () => {
    renderAt('/dashboard');
    expect(await screen.findByText('PAGE:DashboardPage')).toBeTruthy();
    cleanup();
    renderAt('/admin/branches');
    expect(await screen.findByText('PAGE:BranchManagementPage')).toBeTruthy();
  });
});
