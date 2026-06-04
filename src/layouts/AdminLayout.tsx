import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/hooks/useAuth';

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
    path: '/admin/price-levels',
    end: false,
    label: 'Price Levels',
    icon: 'ti-layers-difference',
  },
  {
    path: '/admin/receiving',
    end: false,
    label: 'Receiving (HQ)',
    icon: 'ti-truck-delivery',
  },
  {
    path: '/admin/transfers',
    end: false,
    label: 'Transfers (HQ)',
    icon: 'ti-arrows-exchange',
  },
  {
    path: '/admin/stock-report',
    end: false,
    label: 'Stock Report (HQ)',
    icon: 'ti-box',
  },
  {
    path: '/admin/sorting',
    end: false,
    label: 'ตั้งค่าการจัดเรียง (POS)',
    icon: 'ti-arrows-sort',
  },
  {
    path: '/admin/quick-menus',
    end: false,
    label: 'ตั้งค่าเมนูด่วน (Quick Menus)',
    icon: 'ti-bolt',
  },
] as const;

// Shared topbar button styling (Tailwind; replaces .admin-layout-topbar-btn).
const TOPBAR_BTN =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[var(--g200)] bg-transparent px-3 text-xs text-[#5f5e5a] transition hover:border-[#888780] hover:bg-[var(--g50)] hover:text-[var(--text-primary)]';

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
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[var(--g50)] font-sans text-[var(--text-primary)]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-[var(--g200)] bg-white px-5">
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-[var(--p50)] text-[18px] text-[var(--p600)]">
          <i className="ti ti-shield-lock" aria-hidden="true" />
        </div>
        <div>
          <div className="text-[15px] font-semibold">Admin Backoffice</div>
          <div className="text-xs text-[#5f5e5a]">
            จัดการระบบหลังบ้าน — {activeNav?.label ?? 'Dashboard'}
          </div>
        </div>

        <div className="flex-1" />

        {displayName && (
          <div className="flex items-center gap-1.5 whitespace-nowrap px-1 text-xs text-[#5f5e5a]">
            <i className="ti ti-user-shield text-sm text-[var(--p600)]" aria-hidden="true" />
            <span>{displayName}</span>
          </div>
        )}

        {isGlobalAdmin && (
          <button
            type="button"
            className={TOPBAR_BTN}
            onClick={() => navigate('/workspace-selector')}
            title="เปลี่ยนโหมดการทำงาน"
          >
            <i className="ti ti-layout-grid" aria-hidden="true" />
            เปลี่ยน Workspace
          </button>
        )}

        <button
          type="button"
          className={`${TOPBAR_BTN} border-[rgba(226,75,74,0.3)] text-[#c0392b] hover:border-[#e24b4a] hover:bg-[#fef2f2] hover:text-[#a32d2d]`}
          onClick={handleLogout}
          title="ออกจากระบบ"
        >
          <i className="ti ti-logout" aria-hidden="true" />
          ออกจากระบบ
        </button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className="flex w-60 shrink-0 flex-col overflow-y-auto border-r-[0.5px] border-[var(--g200)] bg-white"
          aria-label="เมนู Admin"
        >
          <div className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-[0.04em] text-[#888780]">
            เมนูหลัก
          </div>
          <nav className="flex flex-col gap-0.5 px-2 pb-4">
            {ADMIN_NAV.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] no-underline transition ${
                    isActive
                      ? 'bg-[var(--p50)] font-medium text-[var(--p600)]'
                      : 'text-[#5f5e5a] hover:bg-[var(--g50)] hover:text-[var(--text-primary)]'
                  }`
                }
              >
                <i className={`ti ${item.icon} shrink-0 text-base`} aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
