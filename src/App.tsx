import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import GuestRoute from './components/GuestRoute';
import ProtectedRoute from './components/ProtectedRoute';
import PosShellRoute from './components/PosShellRoute';
import CustomerPage from './pages/CustomerPage';
import DashboardPage from './pages/DashboardPage';
import ExportReportPage from './pages/ExportReportPage';
import TransferPage from './pages/inventory/TransferPage';
import InventoryAdjustmentPage from './pages/inventory/InventoryAdjustmentPage';
import InventoryPage from './pages/inventory/InventoryPage';
import LoginPage from './pages/LoginPage';
import POSPage from './pages/POSPage';
import ProductCRUDPage from './pages/ProductCRUDPage';
import ProfitReportPage from './pages/ProfitReportPage';
import ReceivingPage from './pages/ReceivingPage';
import ReceivingHistoryPage from './pages/ReceivingHistoryPage';
import ReceivingEditPage from './pages/ReceivingEditPage';
import SalesHistoryPage from './pages/SalesHistoryPage';
import ReceivablesPage from './pages/ReceivablesPage';
import SettingsLayout from './layouts/SettingsLayout';
import AdminLayout from './layouts/AdminLayout';
import AdminDashboardPage from './pages/admin/AdminDashboardPage';
import WorkspaceSelector from './pages/WorkspaceSelector';
import AdminProductManagementPage from './pages/admin/AdminProductManagementPage';
import AdminReceivingPage from './pages/admin/AdminReceivingPage';
import AdminTransferPage from './pages/admin/AdminTransferPage';
import AdminTransferCreatePage from './pages/admin/AdminTransferCreatePage';
import AdminStockReportPage from './pages/admin/AdminStockReportPage';
import BranchManagementPage from './pages/admin/BranchManagementPage';
import TierManagementPage from './pages/admin/TierManagementPage';
import AdminStaffManagementPage from './pages/admin/AdminStaffManagementPage';
import AdminSupplierManagementPage from './pages/admin/AdminSupplierManagementPage';
import SortingSettingsPage from './pages/admin/SortingSettingsPage';
import DocumentSettings from './pages/settings/DocumentSettings';
import SettingsPage from './pages/SettingsPage';
import {
  FIRST_SETTINGS_SLUG,
  SETTINGS_NAV_ITEMS,
} from './lib/settings/settingsNav';
import StaffManagementPage from './pages/StaffManagementPage';
import StockReportPage from './pages/StockReportPage';
import SupplierPage from './pages/SupplierPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<GuestRoute />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route path="/workspace-selector" element={<WorkspaceSelector />} />

          <Route element={<PosShellRoute />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/pos" element={<POSPage />} />
            <Route path="/products" element={<ProductCRUDPage />} />
            <Route path="/receiving" element={<ReceivingPage />} />
            <Route path="/receiving/history/edit/:id" element={<ReceivingEditPage />} />
            <Route path="/receiving/history" element={<ReceivingHistoryPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/inventory/adjust" element={<InventoryAdjustmentPage />} />
            <Route path="/inventory/transfer" element={<TransferPage />} />
            <Route
              path="/inventory/transfer/history"
              element={<Navigate to="/inventory/transfer" replace />}
            />
            <Route path="/sales-history" element={<SalesHistoryPage />} />
            <Route path="/receivables" element={<ReceivablesPage />} />
            <Route path="/customers" element={<CustomerPage />} />
            <Route path="/suppliers" element={<SupplierPage />} />
            <Route path="/stock-report" element={<StockReportPage />} />
            <Route path="/profit-report" element={<ProfitReportPage />} />
            <Route path="/staff" element={<StaffManagementPage />} />
            <Route path="/export" element={<ExportReportPage />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to={FIRST_SETTINGS_SLUG} replace />} />
              {SETTINGS_NAV_ITEMS.map((item) => (
                <Route
                  key={item.slug}
                  path={item.slug}
                  element={item.scope === 'system' ? <DocumentSettings /> : <SettingsPage />}
                />
              ))}
              {/* Back-compat redirects for the previous two-page URLs */}
              <Route path="document" element={<Navigate to="/settings/general" replace />} />
              <Route path="branch" element={<Navigate to="/settings/branch-info" replace />} />
            </Route>
          </Route>

          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboardPage />} />
            <Route path="branches" element={<BranchManagementPage />} />
            <Route path="staff" element={<AdminStaffManagementPage />} />
            <Route path="products" element={<AdminProductManagementPage />} />
            <Route path="suppliers" element={<AdminSupplierManagementPage />} />
            <Route path="price-levels" element={<TierManagementPage />} />
            <Route path="receiving" element={<AdminReceivingPage />} />
            <Route path="transfers" element={<AdminTransferPage />} />
            <Route path="transfers/new" element={<AdminTransferCreatePage />} />
            <Route path="stock-report" element={<AdminStockReportPage />} />
            <Route path="sorting" element={<SortingSettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
