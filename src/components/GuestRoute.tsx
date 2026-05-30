import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/hooks/useAuth';

export default function GuestRoute() {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        กำลังโหลด...
      </div>
    );
  }

  if (isAuthenticated) {
    // Global Admin → go straight to the Admin back-office.
    // They can switch to POS via "เปลี่ยน Workspace" in the Admin top-bar.
    if (user?.branchIds.includes('ALL')) {
      return <Navigate to="/admin" replace />;
    }
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
