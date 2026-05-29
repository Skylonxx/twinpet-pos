import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { fetchActiveBranches } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';

/** Auth guard only — renders nested routes without a layout shell */
export default function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  useEffect(() => {
    if (isAuthenticated) {
      void fetchActiveBranches();
    }
  }, [isAuthenticated]);

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

  return <Outlet />;
}
