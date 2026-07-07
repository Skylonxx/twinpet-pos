import { useState, type ComponentProps, type FC } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Sidebar,
  SidebarItems,
  SidebarItemGroup,
  SidebarItem,
  SidebarCollapse,
} from './ui';
import {
  ALL_NAV_ITEMS,
  isNavItemActive,
  NAV_CATEGORIES,
  type NavCategory,
} from '../config/navigation';
import { getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import { useSaleIntentSweepBoot } from '../lib/pos/offline/saleIntentSweepBoot';
import type { UserRole } from '../lib/types';

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  manager: 'Manager',
  staff: 'Staff',
};

function userInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`;
}

/**
 * Adapter: flowbite-react Sidebar icons expect an SVG component (FC<svg props>),
 * but this app uses Tabler icon *fonts* (`<i class="ti ...">`). This wraps a
 * Tabler glyph in a component matching the expected signature; flowbite passes
 * its icon theme classes through as `className`.
 */
function tablerIcon(name: string): FC<ComponentProps<'svg'>> {
  return function TablerIcon({ className }: ComponentProps<'svg'>) {
    return <i className={`ti ${name} ${className ?? ''}`} aria-hidden="true" />;
  };
}

/**
 * SidebarItem rendered as a react-router <NavLink>. flowbite's SidebarItemProps
 * doesn't type the `to` prop, so widen it (as={NavLink} forwards `to` through).
 */
const NavSidebarItem = SidebarItem as unknown as FC<
  ComponentProps<typeof SidebarItem> & { to: string }
>;

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

  // Fail-open, once-per-tab startup Sale Intent sweep. Mounts here (structurally
  // past ProtectedRoute + PosShellRoute guards); silent no-op on every skip path.
  useSaleIntentSweepBoot();

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
    <div className="flex w-full h-screen overflow-hidden bg-[var(--g50)] font-sans">
      <Sidebar collapsed={!open} aria-label="แถบนำทาง" className="z-50 shrink-0">
        {/* Head: hamburger + logo */}
        <div className="flex min-h-[44px] items-center gap-2 px-1 pb-2">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={open ? 'ย่อเมนู' : 'ขยายเมนู'}
            aria-expanded={open}
            title={open ? 'ย่อเมนู' : 'ขยายเมนู'}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-transparent text-[22px] text-white/75 transition hover:bg-white/10 hover:text-white"
          >
            <i className="ti ti-menu-2" aria-hidden="true" />
          </button>
          {open && (
            <div className="flex items-center gap-2.5 overflow-hidden" title="TwinPet POS">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--p600)] text-sm font-semibold text-white"
                style={{ fontFamily: "'Prompt', sans-serif" }}
              >
                P
              </span>
              <span
                className="whitespace-nowrap text-[15px] font-semibold text-white"
                style={{ fontFamily: "'Prompt', sans-serif" }}
              >
                TwinPet
              </span>
            </div>
          )}
        </div>

        <SidebarItems>
          <SidebarItemGroup>
            {NAV_CATEGORIES.map((cat) => (
              <SidebarCollapse
                key={cat.id}
                label={cat.label}
                icon={tablerIcon(cat.icon)}
                open={open && expandedCategory === cat.id}
                onClick={() => handleCategoryClick(cat)}
              >
                {cat.items.map((item) => (
                  <NavSidebarItem
                    key={item.path}
                    as={NavLink}
                    to={item.path}
                    icon={tablerIcon(item.icon)}
                    active={isNavItemActive(item.path, location.pathname)}
                  >
                    {item.label}
                  </NavSidebarItem>
                ))}
              </SidebarCollapse>
            ))}
          </SidebarItemGroup>
        </SidebarItems>

        {/* Footer: user block + logout */}
        <div className="mt-1 flex flex-col gap-1.5 border-t border-white/10 pt-2">
          {user && (
            <div className="flex items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5">
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-white/15 bg-[var(--p400)] text-[10px] font-medium text-white"
                aria-hidden="true"
              >
                {userInitials(user.firstName, user.lastName)}
              </div>
              {open && (
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-medium text-white/90">
                    {user.firstName} {user.lastName}
                  </div>
                  <div className="text-[10px] text-white/45">{ROLE_LABELS[user.role]}</div>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => void logout()}
            title="ออกจากระบบ"
            className={`flex h-9 items-center gap-2 rounded-lg text-xs text-white/45 transition hover:bg-white/10 hover:text-white/85 ${
              open ? 'justify-start px-3' : 'justify-center'
            }`}
          >
            <i className="ti ti-logout" aria-hidden="true" />
            {open && <span>ออกจากระบบ</span>}
          </button>
        </div>
      </Sidebar>

      <div className="flex-1 flex flex-col w-full min-w-0 overflow-hidden">
        <header className="h-12 flex-shrink-0 flex items-center gap-3 px-4 bg-white border-b-[0.5px] border-[var(--g200)]">
          <div
            className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border-[0.5px] border-[var(--p200)] bg-[var(--p50)] px-2.5 py-1 text-xs font-medium text-[var(--p800)] cursor-default select-none"
            title="สาขาปัจจุบัน"
          >
            <i className="ti ti-building-store text-[13px] text-[var(--p600)]" aria-hidden="true" />
            สาขา{branchDisplay}
          </div>
          <span
            className="text-sm font-medium text-[var(--text-primary)]"
            style={{ fontFamily: "'Prompt', sans-serif" }}
          >
            {pageTitle}
          </span>
          <div className="flex-1" />
        </header>

        <main className="flex-1 overflow-auto min-h-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
