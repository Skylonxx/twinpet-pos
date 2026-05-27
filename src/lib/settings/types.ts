import type {
  Branch,
  PaymentMethod,
  PriceLevel,
  Settings,
  SettingsNotifications,
  UomUnit,
} from '../types';

export type SettingsSection =
  | 'branch'
  | 'vat'
  | 'pricelevel'
  | 'uom'
  | 'payment'
  | 'receipt'
  | 'notification'
  | 'pos'
  | 'admin';

export type BranchFormData = {
  name: string;
  address: string;
  phone: string;
  email: string;
  taxId: string;
  website: string;
  logoUrl: string | null;
};

export type SettingsExtras = {
  showVatOnReceipt: boolean;
  showCustomerTaxId: boolean;
  showLogoOnReceipt: boolean;
  defaultCreditLimit: number;
  defaultCreditDays: number;
  creditRequireApproval: boolean;
  companyName: string;
  invoiceNumberFormat: string;
  webhookUrl: string;
  posPrinter: string;
  posPaperSize: string;
  autoPrintReceipt: boolean;
  printReceiptCopy: boolean;
  posLockOnIdle: boolean;
  fullActivityLog: boolean;
  backupSchedule: string;
  backupRetentionDays: number;
};

export type SettingsFormData = BranchFormData &
  Omit<
    Settings,
    'branchId' | 'updatedAt' | 'receiptLogoUrl'
  > & {
    receiptLogoUrl: string | null;
  } &
  SettingsExtras;

export type PriceLevelRow = PriceLevel & { desc: string };

export type UomRow = UomUnit;

export type NotifEventKey = 'lowStock' | 'voidOrder' | 'overCredit' | 'dailySummary';

export type NotifEventDef = {
  key: NotifEventKey;
  icon: string;
  bg: string;
  fc: string;
  label: string;
};

export const NOTIF_EVENTS: NotifEventDef[] = [
  { key: 'lowStock', icon: 'ti-alert-triangle', bg: '#FAEEDA', fc: '#854F0B', label: 'สต็อกต่ำกว่า Reorder Point' },
  { key: 'voidOrder', icon: 'ti-trash', bg: '#FCEBEB', fc: '#A32D2D', label: 'มีการ Void บิล' },
  { key: 'overCredit', icon: 'ti-clock-dollar', bg: '#FAEEDA', fc: '#854F0B', label: 'หนี้เกินวงเงินหรือเกินกำหนด' },
  { key: 'dailySummary', icon: 'ti-report-money', bg: '#EEEDFE', fc: '#534AB7', label: 'ยอดขายรายวันสรุปตอนปิดร้าน' },
];

export type PayMethodDef = {
  key: PaymentMethod;
  icon: string;
  label: string;
  desc: string;
  color: string;
  bg: string;
};

export const PAY_METHOD_DEFS: PayMethodDef[] = [
  { key: 'cash', icon: 'ti-cash', label: 'เงินสด', desc: 'พิมพ์ Quick Bills ได้', color: '#0F6E56', bg: '#E1F5EE' },
  { key: 'qr', icon: 'ti-qrcode', label: 'PromptPay QR', desc: 'QR PromptPay กลาง', color: '#7A1FA2', bg: '#FBE8F9' },
  { key: 'kbank', icon: 'ti-building-bank', label: 'QR Kbank', desc: 'QR KBank สาขา', color: '#1F6E00', bg: '#E8F5E0' },
  { key: 'card', icon: 'ti-credit-card', label: 'EDC บัตร', desc: 'เครื่องรูดบัตร EDC', color: '#534AB7', bg: '#EEEDFE' },
  { key: 'credit', icon: 'ti-clock-dollar', label: 'เชื่อ', desc: 'บันทึกหนี้ค้างชำระ', color: '#854F0B', bg: '#FAEEDA' },
];

export const NAV_SECTIONS: Array<{
  header?: string;
  items: Array<{ id: SettingsSection; icon: string; label: string; badge?: number }>;
}> = [
  {
    header: 'ข้อมูลสาขา',
    items: [{ id: 'branch', icon: 'ti-building-store', label: 'ข้อมูลสาขา' }],
  },
  {
    header: 'ราคา & ภาษี',
    items: [
      { id: 'vat', icon: 'ti-receipt-tax', label: 'VAT & ภาษี' },
      { id: 'pricelevel', icon: 'ti-layers-difference', label: 'ระดับราคา' },
      { id: 'uom', icon: 'ti-ruler', label: 'UOM & หน่วยนับ' },
    ],
  },
  {
    header: 'การชำระเงิน & เอกสาร',
    items: [
      { id: 'payment', icon: 'ti-credit-card', label: 'ช่องทางชำระเงิน' },
      { id: 'receipt', icon: 'ti-receipt', label: 'ใบเสร็จ & Invoice' },
    ],
  },
  {
    header: 'ระบบ',
    items: [
      { id: 'notification', icon: 'ti-bell', label: 'การแจ้งเตือน', badge: 3 },
      { id: 'pos', icon: 'ti-device-desktop', label: 'เครื่อง POS' },
      { id: 'admin', icon: 'ti-shield-lock', label: 'Admin & ความปลอดภัย' },
    ],
  },
];

export const DEFAULT_NOTIFICATIONS: SettingsNotifications = {
  lowStock: { line: true, email: false },
  voidOrder: { line: true, email: false },
  overCredit: { line: true, email: true },
  dailySummary: { line: true, email: false },
};

export function branchToForm(branch: Branch): BranchFormData {
  return {
    name: branch.name,
    address: branch.address,
    phone: branch.phone,
    email: branch.email,
    taxId: branch.taxId,
    website: 'www.twinpet.co.th',
    logoUrl: branch.logoUrl,
  };
}

export function settingsToForm(
  settings: Settings,
  branch: Branch,
  extras?: Partial<SettingsExtras>,
): SettingsFormData {
  const b = branchToForm(branch);
  const e = { ...DEFAULT_EXTRAS, ...extras };
  return {
    ...b,
    vatRegistered: settings.vatRegistered,
    vatRate: settings.vatRate,
    priceIncludesVat: settings.priceIncludesVat,
    paymentMethods: { ...settings.paymentMethods },
    receiptHeader: settings.receiptHeader,
    receiptFooter: settings.receiptFooter,
    receiptLogoUrl: settings.receiptLogoUrl,
    showBarcodeOnReceipt: settings.showBarcodeOnReceipt,
    showQrOnReceipt: settings.showQrOnReceipt,
    pinMaxAttempts: settings.pinMaxAttempts,
    sessionTimeoutMin: settings.sessionTimeoutMin,
    notifications: JSON.parse(JSON.stringify(settings.notifications)) as SettingsNotifications,
    lineNotifyToken: settings.lineNotifyToken ?? '',
    allowNegativeStock: settings.allowNegativeStock,
    negativeStockWarning: settings.negativeStockWarning,
    parkedOrderExpiryHours: settings.parkedOrderExpiryHours,
    ...e,
  };
}

export const DEFAULT_EXTRAS: SettingsExtras = {
  showVatOnReceipt: true,
  showCustomerTaxId: true,
  showLogoOnReceipt: true,
  defaultCreditLimit: 5000,
  defaultCreditDays: 30,
  creditRequireApproval: false,
  companyName: 'บริษัท ทวิน เพ็ท จำกัด',
  invoiceNumberFormat: 'INV-{YYYY}{MM}-{NNN}',
  webhookUrl: '',
  posPrinter: 'Epson TM-T82X (USB)',
  posPaperSize: '80mm',
  autoPrintReceipt: true,
  printReceiptCopy: false,
  posLockOnIdle: true,
  fullActivityLog: true,
  backupSchedule: 'daily',
  backupRetentionDays: 30,
};

export function formToBranch(form: SettingsFormData, branchId: string): Omit<Branch, 'createdAt' | 'updatedAt' | 'isActive'> & { id: string } {
  return {
    id: branchId,
    name: form.name,
    address: form.address,
    phone: form.phone,
    email: form.email,
    taxId: form.taxId,
    logoUrl: form.logoUrl,
  };
}

export function formToSettings(form: SettingsFormData, branchId: string): Omit<Settings, 'updatedAt'> {
  return {
    branchId,
    vatRegistered: form.vatRegistered,
    vatRate: form.vatRate,
    priceIncludesVat: form.priceIncludesVat,
    paymentMethods: { ...form.paymentMethods },
    receiptHeader: form.receiptHeader,
    receiptFooter: form.receiptFooter,
    receiptLogoUrl: form.receiptLogoUrl,
    showBarcodeOnReceipt: form.showBarcodeOnReceipt,
    showQrOnReceipt: form.showQrOnReceipt,
    pinMaxAttempts: form.pinMaxAttempts,
    sessionTimeoutMin: form.sessionTimeoutMin,
    notifications: form.notifications,
    lineNotifyToken: form.lineNotifyToken || null,
    allowNegativeStock: form.allowNegativeStock,
    negativeStockWarning: form.negativeStockWarning,
    parkedOrderExpiryHours: form.parkedOrderExpiryHours,
  };
}

export function formToExtras(form: SettingsFormData): SettingsExtras {
  return {
    showVatOnReceipt: form.showVatOnReceipt,
    showCustomerTaxId: form.showCustomerTaxId,
    showLogoOnReceipt: form.showLogoOnReceipt,
    defaultCreditLimit: form.defaultCreditLimit,
    defaultCreditDays: form.defaultCreditDays,
    creditRequireApproval: form.creditRequireApproval,
    companyName: form.companyName,
    invoiceNumberFormat: form.invoiceNumberFormat,
    webhookUrl: form.webhookUrl,
    posPrinter: form.posPrinter,
    posPaperSize: form.posPaperSize,
    autoPrintReceipt: form.autoPrintReceipt,
    printReceiptCopy: form.printReceiptCopy,
    posLockOnIdle: form.posLockOnIdle,
    fullActivityLog: form.fullActivityLog,
    backupSchedule: form.backupSchedule,
    backupRetentionDays: form.backupRetentionDays,
  };
}
