export type NavItem = {
  path: string;
  label: string;
  icon: string;
};

export const MAIN_NAV: NavItem[] = [
  { path: '/pos', label: 'ขาย', icon: 'ti-shopping-cart' },
  { path: '/dashboard', label: 'ภาพรวม', icon: 'ti-chart-bar' },
  { path: '/products', label: 'สินค้า', icon: 'ti-package' },
  { path: '/receiving', label: 'รับเข้า', icon: 'ti-truck-delivery' },
  { path: '/receiving/history', label: 'ประวัติรับเข้า', icon: 'ti-history' },
  { path: '/suppliers', label: 'ผู้จำหน่าย', icon: 'ti-truck' },
  { path: '/inventory', label: 'จัดการสต็อก', icon: 'ti-box-seam' },
  { path: '/sales-history', label: 'ประวัติขาย', icon: 'ti-receipt' },
  { path: '/customers', label: 'ลูกค้า', icon: 'ti-users' },
  { path: '/receivables', label: 'สมุดบัญชีลูกหนี้', icon: 'ti-notebook' },
  { path: '/stock-report', label: 'สต็อก', icon: 'ti-box' },
  { path: '/profit-report', label: 'กำไร', icon: 'ti-report-money' },
  { path: '/staff', label: 'พนักงาน', icon: 'ti-user-cog' },
  { path: '/export', label: 'Export', icon: 'ti-file-export' },
];

export const BOTTOM_NAV: NavItem[] = [
  { path: '/settings', label: 'ตั้งค่า', icon: 'ti-settings' },
];
