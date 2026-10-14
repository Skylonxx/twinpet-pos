import AdminLayout from '../../layouts/AdminLayout';
import { useAuth } from '../../lib/hooks/useAuth';
import AdminSecurityCenter from './AdminSecurityCenter';
import '../SettingsPage.css';

/**
 * D-ASC10 — the Admin & Security Center for an ALL-workspace session (global
 * admin, no concrete POS branch chosen). Rendered in the Admin back-office
 * shell, NOT the POS AppShell: no branch-bound POS boot hooks, no branch
 * settings page. No terminal branch is passed, so branch-bound approval
 * actions (OAC reissue, approval lockout) stay disabled; the password-admin
 * gate inside the center is unchanged.
 */
export default function AdminSecurityAllWorkspacePage() {
  const { user } = useAuth();
  return (
    <AdminLayout>
      <div className="stg-page" data-testid="admin-security-all-workspace">
        <div className="stg-body">
          <div className="stg-main">
            <AdminSecurityCenter operator={user} branchId={null} />
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
