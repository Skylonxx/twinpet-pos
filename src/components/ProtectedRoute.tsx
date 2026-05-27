import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/hooks/useAuth';
import AppShell from './AppShell';

/** Auth + branch guard; renders AppShell layout with nested routes */
export default function ProtectedRoute() {
  const { isAuthenticated, isLoading, user, branchId, logout } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        กำลังโหลด...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!branchId || !user?.branchIds.includes(branchId)) {
    void logout();
    return <Navigate to="/login" replace />;
  }

  return <AppShell />;
}
