import type { Branch, PosDevice, PriceLevel, Settings, UomUnit } from '../types';
import { DEFAULT_NOTIFICATIONS, DEFAULT_EXTRAS, type PriceLevelRow, type SettingsExtras } from './types';

function ts(date = new Date()): Branch['createdAt'] {
  return { toDate: () => date } as Branch['createdAt'];
}

export const DEV_BRANCH: Branch = {
  id: 'LDP-001',
  name: 'TwinPet ลาดพร้าว',
  address: '123/45 ถ.ลาดพร้าว แขวงลาดพร้าว เขตลาดพร้าว กรุงเทพฯ 10230',
  phone: '02-123-4567',
  email: 'ladprao@twinpet.co.th',
  taxId: '0105560123456',
  logoUrl: null,
  isActive: true,
  createdAt: ts(),
  updatedAt: ts(),
};

export const DEV_BRANCH_BKK: Branch = {
  id: 'BKK-002',
  name: 'TwinPet เอกมัย',
  address: '88/12 ถ.สุขุมวิท แขวงคลองตัน เขตวัฒนา กรุงเทพฯ 10110',
  phone: '02-987-6543',
  email: 'ekamai@twinpet.co.th',
  taxId: '0105560123456',
  logoUrl: null,
  isActive: true,
  createdAt: ts(),
  updatedAt: ts(),
};

export const DEV_SETTINGS: Settings = {
  branchId: 'LDP-001',
  vatRegistered: true,
  vatRate: 7,
  priceIncludesVat: true,
  paymentMethods: { cash: true, qr: true, kbank: true, card: true, credit: true },
  receiptHeader: 'TwinPet Pet Shop\nสาขาลาดพร้าว',
  receiptFooter: 'ขอบคุณที่ใช้บริการ\nTel: 02-123-4567',
  receiptLogoUrl: null,
  showBarcodeOnReceipt: true,
  showQrOnReceipt: false,
  pinMaxAttempts: 5,
  sessionTimeoutMin: 30,
  notifications: DEFAULT_NOTIFICATIONS,
  lineNotifyToken: 'abc123token',
  allowNegativeStock: false,
  negativeStockWarning: true,
  parkedOrderExpiryHours: 4,
  updatedAt: ts(),
};

export const DEV_EXTRAS: SettingsExtras = { ...DEFAULT_EXTRAS };

export const DEV_PRICE_LEVELS: PriceLevelRow[] = [
  { id: 'RETAIL', name: 'ราคาปลีก', code: 'RETAIL', order: 1, isActive: true, desc: 'ราคามาตรฐานทั่วไป' },
  { id: 'MEMBER', name: 'ราคาสมาชิก', code: 'MEMBER', order: 2, isActive: true, desc: 'ส่วนลด 5-10% จากราคาปลีก' },
  { id: 'WHOLESALE', name: 'ราคาส่ง', code: 'WHOLESALE', order: 3, isActive: true, desc: 'สำหรับการซื้อจำนวนมาก' },
  { id: 'SPECIAL', name: 'ราคาพิเศษ', code: 'SPECIAL', order: 4, isActive: false, desc: 'โปรโมชั่นหรือตามเงื่อนไข' },
];

export const DEV_UOM_UNITS: UomUnit[] = [
  { id: 'uom-pc', name: 'ชิ้น', code: 'PC', isActive: true },
  { id: 'uom-pack', name: 'แพ็ค', code: 'PACK', isActive: true },
  { id: 'uom-box', name: 'กล่อง', code: 'BOX', isActive: true },
  { id: 'uom-doz', name: 'โหล', code: 'DOZ', isActive: true },
  { id: 'uom-kg', name: 'กิโลกรัม', code: 'KG', isActive: true },
  { id: 'uom-bag', name: 'ถุง', code: 'BAG', isActive: false },
];

export const DEV_DEVICES: PosDevice[] = [
  {
    id: 'dev-1',
    branchId: 'LDP-001',
    name: 'POS-01',
    type: 'desktop',
    token: 'tok-001',
    isOnline: true,
    lastSeenAt: ts(),
    currentUserId: 'u1',
    createdAt: ts(),
  },
  {
    id: 'dev-2',
    branchId: 'LDP-001',
    name: 'POS-02',
    type: 'tablet',
    token: 'tok-002',
    isOnline: true,
    lastSeenAt: ts(),
    currentUserId: 'u2',
    createdAt: ts(),
  },
  {
    id: 'dev-3',
    branchId: 'LDP-001',
    name: 'POS-03',
    type: 'mobile',
    token: 'tok-003',
    isOnline: false,
    lastSeenAt: ts(new Date(Date.now() - 86400000)),
    currentUserId: null,
    createdAt: ts(),
  },
];

let devBranch = { ...DEV_BRANCH };
let devSettings = { ...DEV_SETTINGS };
let devExtras = { ...DEV_EXTRAS };
let devPriceLevels = DEV_PRICE_LEVELS.map((p) => ({ ...p }));
let devUom = DEV_UOM_UNITS.map((u) => ({ ...u }));
let devDevices = DEV_DEVICES.map((d) => ({ ...d }));

export function getDevBranch() {
  return { ...devBranch };
}

export function getDevSettings() {
  return { ...devSettings, notifications: JSON.parse(JSON.stringify(devSettings.notifications)) };
}

export function getDevExtras() {
  return { ...devExtras };
}

export function getDevPriceLevels() {
  return devPriceLevels.map((p) => ({ ...p }));
}

export function getDevUomUnits() {
  return devUom.map((u) => ({ ...u }));
}

export function saveDevUomUnits(units: UomUnit[]) {
  devUom = units.map((u) => ({ ...u }));
}

export function getDevBranches(): Branch[] {
  return [devBranch, DEV_BRANCH_BKK].filter((b) => b.isActive);
}

export function getDevDevices() {
  return devDevices.map((d) => ({ ...d }));
}

export function saveDevData(data: {
  branch: typeof devBranch;
  settings: Settings;
  extras: SettingsExtras;
  priceLevels: PriceLevelRow[];
  devices: PosDevice[];
}) {
  devBranch = { ...data.branch };
  devSettings = { ...data.settings, updatedAt: ts() };
  devExtras = { ...data.extras };
  devPriceLevels = data.priceLevels.map((p) => ({ ...p }));
  devDevices = data.devices.map((d) => ({ ...d }));
}

export function devForceLogout(deviceId: string) {
  devDevices = devDevices.map((d) =>
    d.id === deviceId ? { ...d, isOnline: false, currentUserId: null } : d,
  );
}

export function devRemoveDevice(deviceId: string) {
  devDevices = devDevices.filter((d) => d.id !== deviceId);
}

export function devAddDevice(device: PosDevice) {
  devDevices = [...devDevices, device];
}

export function priceLevelToRow(p: PriceLevel): PriceLevelRow {
  return { ...p, desc: '' };
}

export function rowToPriceLevel(p: PriceLevelRow): PriceLevel {
  const { desc: _d, ...rest } = p;
  return rest;
}
