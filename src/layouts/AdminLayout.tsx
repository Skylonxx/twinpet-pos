import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/hooks/useAuth';
import './AdminLayout.css';

const ADMIN_NAV = [
  {
    path: '/admin',
    end: true,
    label: 'Dashboard',
    icon: 'ti-layout-dashboard',
  },
  {
    path: '/admin/branches',
    end: false,
    label: 'Branches',
    icon: 'ti-building-store',
  },
  {
    path: '/admin/staff',
    end: false,
    label: 'Staff',
    icon: 'ti-users',
  },
  {
    path: '/admin/products',
    end: false,
    label: 'Products',
    icon: 'ti-package',
  },
  {
    path: '/admin/suppliers',
    end: false,
    label: 'Suppliers',
    icon: 'ti-building-factory-2',
  },
  {
    path: '/admin/receiving',
    end: false,
    label: 'Receiving (HQ)',
    icon: 'ti-truck-delivery',
  },
] as const;

export default function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const activeNav = ADMIN_NAV.find((item) =>
    item.end ? location.pathname === item.path : location.pathname.startsWith(item.path),
  );

  const isGlobalAdmin = user?.branchIds.includes('ALL') ?? false;
  const displayName = user ? `${user.firstName} ${user.lastName}`.trim() : '';

  const handleLogout = () => {
    void logout();
  };

  return (
    <div className="admin-layout">
      <header className="admin-layout-topbar">
        <div className="admin-layout-topbar-icon">
          <i className="ti ti-shield-lock" aria-hidden="true" />
        </div>
        <div>
          <div className="admin-layout-topbar-title">Admin Backoffice</div>
          <div className="admin-layout-topbar-sub">
            จัดการระบบหลังบ้าน — {activeNav?.label ?? 'Dashboard'}
          </div>
        </div>

        <div className="admin-layout-topbar-spacer" />

        {displayName && (
          <div className="admin-layout-topbar-user">
            <i className="ti ti-user-shield" aria-hidden="true" />
            <span>{displayName}</span>
          </div>
        )}

        {isGlobalAdmin && (
          <button
            type="button"
            className="admin-layout-topbar-btn"
            onClick={() => navigate('/workspace-selector')}
            title="เปลี่ยนโหมดการทำงาน"
          >
            <i className="ti ti-layout-grid" aria-hidden="true" />
            เปลี่ยน Workspace
          </button>
        )}

        <button
          type="button"
          className="admin-layout-topbar-btn admin-layout-topbar-btn--logout"
          onClick={handleLogout}
          title="ออกจากระบบ"
        >
          <i className="ti ti-logout" aria-hidden="true" />
          ออกจากระบบ
        </button>
      </header>

      <div className="admin-layout-body">
        <aside className="admin-layout-sidebar" aria-label="เมนู Admin">
          <div className="admin-layout-sidebar-header">เมนูหลัก</div>
          <nav className="admin-layout-nav">
            {ADMIN_NAV.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                className={({ isActive }) =>
                  `admin-layout-nav-item${isActive ? ' active' : ''}`
                }
              >
                <i className={`ti ${item.icon}`} aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="admin-layout-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
