import { useLocation } from 'react-router-dom';
import { ADMIN_SECURITY_CENTER_PATH } from '../lib/settings/settingsNav';
import { useAuth } from '../lib/hooks/useAuth';
import AdminSecurityAllWorkspacePage from '../pages/settings/AdminSecurityAllWorkspacePage';
import PosShellRoute from './PosShellRoute';

/**
 * Route element in front of the POS shell (D-ASC10).
 *
 * The Admin & Security Center is identity/security administration, not a POS
 * branch transaction surface, so an ALL-workspace session (global admin, no
 * branch chosen) may open EXACTLY `/settings/admin-security`; it is rendered
 * outside the POS shell (see AdminSecurityAllWorkspacePage). Every other path
 * — and every concrete-branch session, including on the center itself — goes
 * through the unchanged `PosShellRoute` branch guard, so all other POS routes
 * still redirect an ALL session to `/admin`. Being the same element for the
 * whole POS route tree, it never remounts the POS shell on navigation.
 */
export default function PosShellGate() {
  const { user, branchId } = useAuth();
  const { pathname } = useLocation();
  if (user?.branchIds.includes('ALL') && branchId === 'ALL' && pathname === ADMIN_SECURITY_CENTER_PATH) {
    return <AdminSecurityAllWorkspacePage />;
  }
  return <PosShellRoute />;
}
