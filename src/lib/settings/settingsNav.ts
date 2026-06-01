/**
 * Single source of truth for the unified Settings navigation.
 *
 * Both the router (App.tsx) and the sidebar (SettingsLayout.tsx) consume this so
 * the URL structure and the menu can never drift apart. Each item maps a flat
 * URL slug (under /settings/<slug>) to a persistence `scope` and the internal
 * `section` id that the scope's page renders.
 *
 * - scope 'system'  → rendered by DocumentSettings (useSystemSettings)
 * - scope 'branch'  → rendered by SettingsPage     (useSettings + useUomUnits)
 */
export type SettingsScope = 'system' | 'branch';

export interface SettingsNavItem {
  /** URL segment under /settings (e.g. "branch-info" → /settings/branch-info). */
  slug: string;
  label: string;
  icon: string;
  scope: SettingsScope;
  /** Internal section/tab id the page switches on (SettingsSection | DocTab). */
  section: string;
  badge?: number;
}

export interface SettingsNavGroup {
  header: string;
  items: SettingsNavItem[];
}

/**
 * Shared via React Router's `<Outlet context>`: each settings page reports its
 * unsaved-changes state up to SettingsLayout, which uses it to guard cross-scope
 * navigation (switching scope remounts the page and would otherwise drop edits).
 */
export interface SettingsOutletContext {
  setDirty: (dirty: boolean) => void;
}

export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    header: 'ตั้งค่าทั่วไป & เอกสาร',
    items: [
      { slug: 'general', label: 'ทั่วไป & ภาษี', icon: 'ti-receipt-tax', scope: 'system', section: 'general' },
      { slug: 'doc-prefix', label: 'คำนำหน้าเอกสาร', icon: 'ti-file-invoice', scope: 'system', section: 'docPrefix' },
      { slug: 'line-prefix', label: 'คำนำหน้ารายการ', icon: 'ti-list-numbers', scope: 'system', section: 'linePrefix' },
      { slug: 'other', label: 'อื่นๆ', icon: 'ti-dots', scope: 'system', section: 'other' },
    ],
  },
  {
    header: 'ตั้งค่าสาขา & POS',
    items: [
      { slug: 'branch-info', label: 'ข้อมูลสาขา', icon: 'ti-building-store', scope: 'branch', section: 'branch' },
      { slug: 'vat-tax', label: 'VAT & ภาษี', icon: 'ti-receipt-tax', scope: 'branch', section: 'vat' },
      { slug: 'price-levels', label: 'ระดับราคา', icon: 'ti-layers-difference', scope: 'branch', section: 'pricelevel' },
      { slug: 'uom', label: 'UOM & หน่วยนับ', icon: 'ti-ruler', scope: 'branch', section: 'uom' },
      { slug: 'expiry-policy', label: 'นโยบายวันหมดอายุ', icon: 'ti-calendar-x', scope: 'branch', section: 'expiryPolicy' },
      { slug: 'payment', label: 'ช่องทางชำระเงิน', icon: 'ti-credit-card', scope: 'branch', section: 'payment' },
      { slug: 'receipt', label: 'ใบเสร็จ & Invoice', icon: 'ti-receipt', scope: 'branch', section: 'receipt' },
      { slug: 'notifications', label: 'การแจ้งเตือน', icon: 'ti-bell', scope: 'branch', section: 'notification', badge: 3 },
      { slug: 'pos-devices', label: 'เครื่อง POS', icon: 'ti-device-desktop', scope: 'branch', section: 'pos' },
      { slug: 'admin-security', label: 'Admin & ความปลอดภัย', icon: 'ti-shield-lock', scope: 'branch', section: 'admin' },
    ],
  },
];

/** Flat list of every nav item across all groups. */
export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = SETTINGS_NAV_GROUPS.flatMap((g) => g.items);

/** The slug the bare /settings route should redirect to. */
export const FIRST_SETTINGS_SLUG = SETTINGS_NAV_ITEMS[0]!.slug;

/** Resolve a URL slug to its nav item (undefined if unknown). */
export function navItemBySlug(slug: string): SettingsNavItem | undefined {
  return SETTINGS_NAV_ITEMS.find((item) => item.slug === slug);
}
