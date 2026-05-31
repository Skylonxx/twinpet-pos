export type NavItem = {
  path: string;
  label: string;
  icon: string;
};

export type NavCategory = {
  id: string;
  label: string;
  icon: string;
  items: NavItem[];
};

/**
 * Sidebar navigation grouped into collapsible accordion categories.
 * The flat {@link ALL_NAV_ITEMS} list is derived from these for page-title /
 * active-route lookups.
 */
export const NAV_CATEGORIES: NavCategory[] = [
  {
    id: 'sales',
    label: 'การขาย',
    icon: 'ti-shopping-cart',
    items: [
      { path: '/pos', label: 'ขาย', icon: 'ti-shopping-cart' },
      { path: '/sales-history', label: 'ประวัติขาย', icon: 'ti-receipt' },
    ],
  },
  {
    id: 'reports',
    label: 'ภาพรวม',
    icon: 'ti-chart-bar',
    items: [
      { path: '/dashboard', label: 'ภาพรวม', icon: 'ti-chart-bar' },
      { path: '/profit-report', label: 'กำไร', icon: 'ti-report-money' },
      { path: '/export', label: 'Export', icon: 'ti-file-export' },
    ],
  },
  {
    id: 'inventory',
    label: 'สินค้าและคลัง',
    icon: 'ti-package',
    items: [
      { path: '/products', label: 'สินค้า', icon: 'ti-package' },
      { path: '/stock-report', label: 'สต็อก', icon: 'ti-box' },
      { path: '/inventory', label: 'จัดการสต็อก', icon: 'ti-box-seam' },
      { path: '/inventory/transfer', label: 'โอนย้าย', icon: 'ti-arrows-exchange' },
    ],
  },
  {
    id: 'purchasing',
    label: 'สั่งซื้อและรับเข้า',
    icon: 'ti-truck-delivery',
    items: [
      { path: '/receiving', label: 'รับเข้า', icon: 'ti-truck-delivery' },
      { path: '/receiving/history', label: 'ประวัติรับเข้า', icon: 'ti-history' },
      { path: '/suppliers', label: 'ผู้จำหน่าย', icon: 'ti-truck' },
    ],
  },
  {
    id: 'customers',
    label: 'ลูกค้าและลูกหนี้',
    icon: 'ti-users',
    items: [
      { path: '/customers', label: 'ลูกค้า', icon: 'ti-users' },
      { path: '/receivables', label: 'สมุดบัญชีลูกหนี้', icon: 'ti-notebook' },
    ],
  },
  {
    id: 'system',
    label: 'ระบบ',
    icon: 'ti-settings',
    items: [
      { path: '/staff', label: 'พนักงาน', icon: 'ti-user-cog' },
      { path: '/settings', label: 'ตั้งค่า', icon: 'ti-settings' },
      { path: '/admin/branches', label: 'จัดการสาขา', icon: 'ti-building-store' },
    ],
  },
];

/** Flat list of every navigable item across all categories. */
export const ALL_NAV_ITEMS: NavItem[] = NAV_CATEGORIES.flatMap((c) => c.items);

/** True when `pathname` should mark this nav item as the active route. */
export function isNavItemActive(path: string, pathname: string): boolean {
  switch (path) {
    case '/settings':
      return pathname.startsWith('/settings');
    case '/admin/branches':
      return pathname.startsWith('/admin/branches');
    case '/inventory':
      return pathname.startsWith('/inventory') && !pathname.startsWith('/inventory/transfer');
    case '/inventory/transfer':
      return pathname.startsWith('/inventory/transfer');
    case '/receiving/history':
      return pathname.startsWith('/receiving/history');
    case '/receiving':
      return pathname.startsWith('/receiving') && !pathname.startsWith('/receiving/history');
    default:
      return pathname === path;
  }
}
