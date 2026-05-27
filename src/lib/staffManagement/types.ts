import type { User, UserPermissions, UserRole } from '../types';

export type StaffTab = 'staff' | 'permissions' | 'activity';

export type LogFilter = 'all' | 'login' | 'sale' | 'edit' | 'void' | 'discount';

export type PermRole = UserRole;

export type PermModuleItem = {
  key: string;
  label: string;
  desc: string;
};

export type PermModule = {
  section: string;
  icon: string;
  items: PermModuleItem[];
};

export const PERM_MODULES: PermModule[] = [
  {
    section: 'การขาย',
    icon: 'ti-shopping-cart',
    items: [
      { key: 'pos_sale', label: 'ขายสินค้า', desc: 'เปิดหน้า POS และบันทึกการขาย' },
      { key: 'pos_discount', label: 'ให้ส่วนลด', desc: 'ส่วนลดรายการและส่วนลดรวม' },
      { key: 'pos_void', label: 'ยกเลิกรายการ / Void', desc: 'ยกเลิกบิลหรือรายการสินค้า' },
      { key: 'quotation', label: 'ใบเสนอราคา', desc: 'สร้างและแก้ไขใบเสนอราคา' },
    ],
  },
  {
    section: 'สินค้าและสต็อก',
    icon: 'ti-package',
    items: [
      { key: 'product_view', label: 'ดูสินค้า', desc: 'รายการสินค้าและราคาทุน' },
      { key: 'product_edit', label: 'แก้ไขสินค้า', desc: 'เพิ่ม/แก้ไข/ลบสินค้า' },
      { key: 'stock_receive', label: 'รับสินค้าเข้า', desc: 'บันทึก GRN และ Lot FIFO' },
      { key: 'cost_view', label: 'ดูราคาทุน', desc: 'Average Cost และ FIFO Lot' },
    ],
  },
  {
    section: 'รายงาน',
    icon: 'ti-chart-bar',
    items: [
      { key: 'report_sales', label: 'รายงานการขาย', desc: 'ยอดขายรายวัน/สรุป' },
      { key: 'report_stock', label: 'รายงานสต็อก', desc: 'สินค้าคงเหลือและ FIFO' },
      { key: 'report_profit', label: 'รายงานกำไร', desc: 'กำไรขั้นต้น และ margin' },
    ],
  },
  {
    section: 'ระบบ',
    icon: 'ti-settings',
    items: [
      { key: 'employee_manage', label: 'จัดการพนักงาน', desc: 'CRUD พนักงานและสิทธิ์' },
      { key: 'settings', label: 'ตั้งค่าระบบ', desc: 'ตั้งค่าสาขา ภาษี และอื่นๆ' },
    ],
  },
];

export const DEFAULT_ROLE_PERMS: Record<PermRole, Set<string>> = {
  admin: new Set([
    'pos_sale',
    'pos_discount',
    'pos_void',
    'quotation',
    'product_view',
    'product_edit',
    'stock_receive',
    'cost_view',
    'report_sales',
    'report_stock',
    'report_profit',
    'employee_manage',
    'settings',
  ]),
  manager: new Set([
    'pos_sale',
    'pos_discount',
    'pos_void',
    'quotation',
    'product_view',
    'product_edit',
    'stock_receive',
    'cost_view',
    'report_sales',
    'report_stock',
  ]),
  staff: new Set(['pos_sale', 'product_view']),
};

export type RolePermissionMatrix = Record<PermRole, string[]>;

export const LOG_ICONS: Record<
  string,
  { icon: string; bg: string; color: string; label: string; filter: LogFilter }
> = {
  LOGIN: { icon: 'ti-login', bg: '#EAF3DE', color: '#3B6D11', label: 'เข้าระบบ', filter: 'login' },
  LOGOUT: { icon: 'ti-logout', bg: '#F1EFE8', color: '#5F5E5A', label: 'ออกระบบ', filter: 'login' },
  SALE: { icon: 'ti-shopping-cart', bg: '#EEEDFE', color: '#534AB7', label: 'การขาย', filter: 'sale' },
  DISCOUNT: { icon: 'ti-tag', bg: '#FAEEDA', color: '#854F0B', label: 'ส่วนลด', filter: 'discount' },
  VOID: { icon: 'ti-trash', bg: '#FCEBEB', color: '#A32D2D', label: 'Void', filter: 'void' },
  EDIT: { icon: 'ti-edit', bg: '#E6F1FB', color: '#185FA5', label: 'แก้ไข', filter: 'edit' },
  ROLE_CHANGE: { icon: 'ti-shield', bg: '#EEEDFE', color: '#534AB7', label: 'เปลี่ยน Role', filter: 'edit' },
  PERM_CHANGE: { icon: 'ti-shield-lock', bg: '#FAEEDA', color: '#854F0B', label: 'แก้ไขสิทธิ์', filter: 'edit' },
  STAFF_CREATE: { icon: 'ti-user-plus', bg: '#E1F5EE', color: '#0F6E56', label: 'เพิ่มพนักงาน', filter: 'edit' },
  STAFF_DELETE: { icon: 'ti-user-minus', bg: '#FCEBEB', color: '#A32D2D', label: 'ลบพนักงาน', filter: 'edit' },
  STAFF_TOGGLE: { icon: 'ti-toggle-left', bg: '#E6F1FB', color: '#185FA5', label: 'สถานะพนักงาน', filter: 'edit' },
};

const AVATAR_CLASSES = ['sm-av-purple', 'sm-av-teal', 'sm-av-coral', 'sm-av-blue', 'sm-av-amber'] as const;

export function userInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`;
}

export function avatarClass(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash += userId.charCodeAt(i);
  return AVATAR_CLASSES[hash % AVATAR_CLASSES.length]!;
}

export function roleLabel(role: UserRole): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  return 'Staff';
}

export function roleBadgeClass(role: UserRole): string {
  if (role === 'admin') return 'sm-role-admin';
  if (role === 'manager') return 'sm-role-manager';
  return 'sm-role-staff';
}

export function matrixToPermissions(keys: Iterable<string>): UserPermissions {
  const set = new Set(keys);
  return {
    canVoidOrder: set.has('pos_void'),
    canEditPrice: set.has('pos_discount') || set.has('product_edit'),
    canViewReport: set.has('report_sales') || set.has('report_stock') || set.has('report_profit'),
    canManageStock: set.has('stock_receive') || set.has('product_edit'),
    canManageStaff: set.has('employee_manage'),
  };
}

export function permissionsForRole(
  role: UserRole,
  matrix: RolePermissionMatrix,
): UserPermissions {
  return matrixToPermissions(matrix[role] ?? []);
}

export function cloneDefaultMatrix(): RolePermissionMatrix {
  return {
    admin: [...DEFAULT_ROLE_PERMS.admin],
    manager: [...DEFAULT_ROLE_PERMS.manager],
    staff: [...DEFAULT_ROLE_PERMS.staff],
  };
}

export function setsFromMatrix(matrix: RolePermissionMatrix): Record<PermRole, Set<string>> {
  return {
    admin: new Set(matrix.admin),
    manager: new Set(matrix.manager),
    staff: new Set(matrix.staff),
  };
}

export function matrixFromSets(sets: Record<PermRole, Set<string>>): RolePermissionMatrix {
  return {
    admin: [...sets.admin],
    manager: [...sets.manager],
    staff: [...sets.staff],
  };
}

export function formatLastLogin(ts: User['lastLoginAt']): string {
  if (!ts) return 'ยังไม่เคย';
  const d = ts.toDate();
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `วันนี้ ${time}`;
  return d.toLocaleDateString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function logFilterMatch(action: string, filter: LogFilter): boolean {
  if (filter === 'all') return true;
  const meta = LOG_ICONS[action];
  return meta?.filter === filter;
}

export type StaffFormData = {
  firstName: string;
  lastName: string;
  username: string;
  password: string;
  pin: string;
  role: UserRole;
  branchIds: string[];
};

export const ROLE_PERMISSIONS_DOC_ID = '_rolePermissions';
