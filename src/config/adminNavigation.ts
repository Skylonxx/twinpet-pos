import { ADMIN_SECURITY_CENTER_PATH } from '../lib/settings/settingsNav';

/**
 * HQ admin sidebar entries (consumed by AdminLayout).
 *
 * D-ASC7: no Staff entry — staff/account management lives only in the
 * Admin & Security Center (/settings/admin-security); /admin/staff redirects there.
 * D-ASC10: that center is reachable from the ALL workspace, so the back-office
 * links to it directly (the only in-app way there without choosing a branch).
 */
export const ADMIN_NAV = [
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
  {
    path: ADMIN_SECURITY_CENTER_PATH,
    end: true,
    label: 'Admin & ความปลอดภัย',
    icon: 'ti-shield-lock',
  },
] as const;
