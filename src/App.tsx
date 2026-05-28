import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import GuestRoute from './components/GuestRoute';
import ProtectedRoute from './components/ProtectedRoute';
import CustomerPage from './pages/CustomerPage';
import DashboardPage from './pages/DashboardPage';
import ExportReportPage from './pages/ExportReportPage';
import BranchTransferPage from './pages/inventory/BranchTransferPage';
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
import DocumentSettings from './pages/settings/DocumentSettings';
import SettingsPage from './pages/SettingsPage';
import StaffManagementPage from './pages/StaffManagementPage';
import StockReportPage from './pages/StockReportPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<GuestRoute />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/pos" element={<POSPage />} />
          <Route path="/products" element={<ProductCRUDPage />} />
          <Route path="/receiving" element={<ReceivingPage />} />
          <Route path="/receiving/history/edit/:id" element={<ReceivingEditPage />} />
          <Route path="/receiving/history" element={<ReceivingHistoryPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/inventory/adjust" element={<InventoryAdjustmentPage />} />
          <Route path="/inventory/transfer" element={<BranchTransferPage />} />
          <Route path="/sales-history" element={<SalesHistoryPage />} />
          <Route path="/receivables" element={<ReceivablesPage />} />
          <Route path="/customers" element={<CustomerPage />} />
          <Route path="/stock-report" element={<StockReportPage />} />
          <Route path="/profit-report" element={<ProfitReportPage />} />
          <Route path="/staff" element={<StaffManagementPage />} />
          <Route path="/export" element={<ExportReportPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="document" replace />} />
            <Route path="document" element={<DocumentSettings />} />
            <Route path="branch" element={<SettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
