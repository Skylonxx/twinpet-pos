import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/hooks/useAuth';
import AppShell from './AppShell';

/** Branch guard + POS shell (dark sidebar + top bar) */
export default function PosShellRoute() {
  const { user, branchId, logout } = useAuth();

  // Global Admin who hasn't selected a POS branch (branchId still 'ALL')
  // → send them to the Admin back-office; they can switch via "เปลี่ยน Workspace".
  if (user?.branchIds.includes('ALL') && branchId === 'ALL') {
    return <Navigate to="/admin" replace />;
  }

  // Branch access check. Global Admins (branchIds: ['ALL']) have implicit access
  // to whichever physical branch they chose in the workspace selector.
  const hasValidBranch =
    branchId &&
    (user?.branchIds.includes('ALL') || user?.branchIds.includes(branchId));

  if (!hasValidBranch) {
    void logout();
    return <Navigate to="/login" replace />;
  }

  return <AppShell />;
}
