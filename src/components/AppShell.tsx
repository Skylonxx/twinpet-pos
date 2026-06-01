import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ALL_NAV_ITEMS,
  isNavItemActive,
  NAV_CATEGORIES,
  type NavCategory,
} from '../config/navigation';
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

/** The category whose route is currently active (for default accordion open). */
function activeCategoryId(pathname: string): string | null {
  return (
    NAV_CATEGORIES.find((cat) =>
      cat.items.some((item) => isNavItemActive(item.path, pathname)),
    )?.id ?? null
  );
}

export default function AppShell() {
  const { user, logout, branchId } = useAuth();
  const { branch } = useBranch();
  const location = useLocation();

  // Click-to-expand sidebar (no hover). Collapsed = icon rail. Default closed.
  const [open, setOpen] = useState(false);
  // Single-open accordion — defaults to the category holding the active route.
  const [expandedCategory, setExpandedCategory] = useState<string | null>(() =>
    activeCategoryId(location.pathname),
  );

  const branchDisplay = branch?.name ?? (branchId ? getBranchLabel(branchId) : '—');

  const pageTitle =
    ALL_NAV_ITEMS.find((item) => isNavItemActive(item.path, location.pathname))?.label ??
    'TwinPet POS';

  const toggleSidebar = () => setOpen((v) => !v);

  const handleCategoryClick = (cat: NavCategory) => {
    if (!open) {
      // Collapsed: expand the rail AND open the clicked category.
      setOpen(true);
      setExpandedCategory(cat.id);
      return;
    }
    setExpandedCategory((cur) => (cur === cat.id ? null : cat.id));
  };

  return (
    <div className="app-shell w-full min-h-screen">
      <aside
        className={`app-shell-sidebar${open ? ' is-open' : ''}`}
        aria-label="แถบนำทาง"
      >
        <div className="app-shell-head">
          <button
            type="button"
            className="app-shell-hamburger"
            onClick={toggleSidebar}
            aria-label={open ? 'ย่อเมนู' : 'ขยายเมนู'}
            aria-expanded={open}
            title={open ? 'ย่อเมนู' : 'ขยายเมนู'}
          >
            <i className="ti ti-menu-2" aria-hidden="true" />
          </button>
          <div className="app-shell-logo" title="TwinPet POS">
            <span className="app-shell-logo-mark">P</span>
            <span className="app-shell-logo-text">TwinPet</span>
          </div>
        </div>

        <nav className="app-shell-nav" aria-label="เมนูหลัก">
          {NAV_CATEGORIES.map((cat) => {
            const catActive = cat.items.some((item) =>
              isNavItemActive(item.path, location.pathname),
            );
            const isExpanded = open && expandedCategory === cat.id;

            return (
              <div key={cat.id} className="app-shell-cat">
                <button
                  type="button"
                  className={`app-shell-cat-head${catActive ? ' active' : ''}${
                    isExpanded ? ' expanded' : ''
                  }`}
                  onClick={() => handleCategoryClick(cat)}
                  aria-expanded={isExpanded}
                  title={cat.label}
                >
                  <i className={`app-shell-cat-icon ti ${cat.icon}`} aria-hidden="true" />
                  <span className="app-shell-cat-label">{cat.label}</span>
                  <i
                    className={`app-shell-cat-chevron ti ${
                      isExpanded ? 'ti-chevron-up' : 'ti-chevron-down'
                    }`}
                    aria-hidden="true"
                  />
                </button>

                {isExpanded && (
                  <div className="app-shell-sub">
                    {cat.items.map((item) => {
                      const active = isNavItemActive(item.path, location.pathname);
                      return (
                        <NavLink
                          key={item.path}
                          to={item.path}
                          className={`app-shell-sub-link${active ? ' active' : ''}`}
                          title={item.label}
                        >
                          <i className={`ti ${item.icon}`} aria-hidden="true" />
                          <span className="app-shell-sub-label">{item.label}</span>
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="app-shell-nav-spacer" />

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
                <div className="app-shell-user-role">{ROLE_LABELS[user.role]}</div>
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
