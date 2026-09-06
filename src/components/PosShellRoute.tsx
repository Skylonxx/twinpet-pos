import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/hooks/useAuth';
import AppShell from './AppShell';

/** Branch guard + POS shell (dark sidebar + top bar) */
export default function PosShellRoute() {
  const { user, branchId, logout } = useAuth();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);

  // Global Admin who hasn't selected a POS branch (branchId still 'ALL')
  // → send them to the Admin back-office; they can switch via "เปลี่ยน Workspace".
  if (user?.branchIds.includes('ALL') && branchId === 'ALL') {
    return <Navigate to="/admin" replace />;
  }

  // Branch access check. Global Admins (branchIds: ['ALL']) have implicit access
  // to whichever physical branch they chose in the workspace selector.
  const hasValidBranch =
    Boolean(branchId) &&
    Boolean(user?.branchIds.includes('ALL') || (branchId && user?.branchIds.includes(branchId)));

  useEffect(() => {
    if (!hasValidBranch && !isLoggingOut && !loggedOut && !logoutError) {
      setIsLoggingOut(true);
      logout()
        .then(() => {
          setLoggedOut(true);
        })
        .catch((err: unknown) => {
          console.error('[PosShellRoute] logout failed', err);
          const msg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการออกจากระบบ';
          setLogoutError(msg);
        })
        .finally(() => {
          setIsLoggingOut(false);
        });
    }
  }, [hasValidBranch, isLoggingOut, loggedOut, logoutError, logout]);

  if (!hasValidBranch) {
    if (logoutError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div
            className="max-w-md w-full bg-white rounded-lg shadow p-6 border border-red-200"
            role="alert"
          >
            <h2 className="text-lg font-bold text-red-600 mb-2 flex items-center gap-1.5">
              <i className="ti ti-alert-circle" aria-hidden="true" />
              ข้อผิดพลาดในการล้างเซสชัน
            </h2>
            <p className="text-sm text-gray-700 mb-4">{logoutError}</p>
            <p className="text-xs text-gray-500">
              ไม่สามารถนำทางต่อไปได้เนื่องจากการล้างข้อมูลความปลอดภัยล้มเหลว
            </p>
          </div>
        </div>
      );
    }
    if (loggedOut) {
      return <Navigate to="/login" replace />;
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">กำลังออกจากระบบและล้างความปลอดภัย...</p>
      </div>
    );
  }

  return <AppShell />;
}
