import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { BOTTOM_NAV, MAIN_NAV } from '../config/navigation';
import { getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import type { UserRole } from '../lib/types';
import './AppShell.css';

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  staff: 'Staff',
};

function userInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`;
}

function NavLinks({
  items,
  ariaLabel,
}: {
  items: typeof MAIN_NAV;
  ariaLabel: string;
}) {
  const location = useLocation();

  return (
    <nav className="app-shell-nav" aria-label={ariaLabel}>
      {items.map((item) => {
        const active =
          item.path === '/settings'
            ? location.pathname.startsWith('/settings')
            : item.path === '/inventory'
              ? location.pathname.startsWith('/inventory') &&
                !location.pathname.startsWith('/inventory/transfer')
              : item.path === '/inventory/transfer'
                ? location.pathname.startsWith('/inventory/transfer')
                : item.path === '/receiving' || item.path === '/receiving/history'
                  ? location.pathname.startsWith('/receiving')
                  : location.pathname === item.path;

        return (
          <NavLink
            key={item.path}
            to={item.path}
            end={
              item.path !== '/settings' &&
              item.path !== '/inventory' &&
              item.path !== '/inventory/transfer'
            }
            className={`app-shell-nav-link${active ? ' active' : ''}`}
            title={item.label}
          >
            <i className={item.icon} aria-hidden="true" />
            <span className="app-shell-nav-label">{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export default function AppShell() {
  const { user, logout, branchId } = useAuth();
  const { branch } = useBranch();
  const location = useLocation();

  const branchDisplay =
    branch?.name ?? (branchId ? getBranchLabel(branchId) : '—');

  const pageTitle =
    [...MAIN_NAV, ...BOTTOM_NAV].find(
      (n) =>
        n.path === location.pathname ||
        (n.path === '/settings' && location.pathname.startsWith('/settings')) ||
        (n.path === '/inventory' &&
          location.pathname.startsWith('/inventory') &&
          !location.pathname.startsWith('/inventory/transfer')) ||
        (n.path === '/inventory/transfer' &&
          location.pathname.startsWith('/inventory/transfer')) ||
        (n.path === '/receiving/history' && location.pathname.startsWith('/receiving')),
    )?.label ?? 'TwinPet POS';

  return (
    <div className="app-shell w-full min-h-screen">
      <aside className="app-shell-sidebar" aria-label="แถบนำทาง">
        <div className="app-shell-logo" title="TwinPet POS">
          P
        </div>

        <NavLinks items={MAIN_NAV} ariaLabel="เมนูหลัก" />

        <div className="app-shell-nav-spacer" />

        <NavLinks items={BOTTOM_NAV} ariaLabel="เมนูระบบ" />

        <div className="app-shell-sidebar-footer">
          {user && (
            <div className="app-shell-user-block">
              <div className="app-shell-avatar" aria-hidden="true">
                {userInitials(user.firstName, user.lastName)}
              </div>
              <div className="app-shell-user-meta">
                <div className="app-shell-user-name">
                  {user.firstName} {user.lastName}
                </div>
                <div className="app-shell-user-role">
                  {ROLE_LABELS[user.role]}
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            className="app-shell-logout"
            onClick={() => void logout()}
            title="ออกจากระบบ"
          >
            <i className="ti ti-logout" aria-hidden="true" />
            <span className="app-shell-logout-label">ออกจากระบบ</span>
          </button>
        </div>
      </aside>

      <div className="app-shell-main">
        <header className="app-shell-topbar">
          <div className="app-shell-branch-badge" title="สาขาปัจจุบัน">
            <i className="ti ti-building-store" aria-hidden="true" />
            สาขา{branchDisplay}
          </div>
          <span className="app-shell-topbar-title">{pageTitle}</span>
          <div className="app-shell-topbar-spacer" />
        </header>

        <main className="app-shell-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
