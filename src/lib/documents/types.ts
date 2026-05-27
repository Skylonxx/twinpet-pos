import type { Branch, Customer, Order, OrderItem, Payment, Settings } from '../types';

/** Branch + receipt settings merged for document rendering */
export type BranchDocumentSettings = {
  companyName: string;
  branchName: string;
  branchAddress: string;
  branchPhone: string;
  branchEmail: string;
  taxId: string;
  logoUrl: string | null;
  receiptHeader: string;
  receiptFooter: string;
  vatRegistered: boolean;
  vatRate: number;
  priceIncludesVat: boolean;
  showBarcodeOnReceipt: boolean;
  showQrOnReceipt: boolean;
  showLogoOnReceipt: boolean;
  showStaffOnReceipt: boolean;
  showSignatureOnReceipt: boolean;
  showVatOnThermal: boolean;
};

export type ThermalReceiptMode = 'receipt' | 'picklist';

export type A4DocType = 'receipt' | 'invoice' | 'full' | 'quotation' | 'delivery';

export type ThermalReceiptProps = {
  order: Order;
  orderItems: OrderItem[];
  customer?: Customer | null;
  branchSettings: BranchDocumentSettings;
  mode?: ThermalReceiptMode;
  isCopy?: boolean;
};

export type A4InvoiceProps = {
  order: Order;
  orderItems: OrderItem[];
  customer?: Customer | null;
  branchSettings: BranchDocumentSettings;
  docType: A4DocType;
  payments?: Payment[];
  docNumber?: string;
  dueDate?: Date | null;
  printedAt?: Date;
};

export type A4DocTypeConfig = {
  label: string;
  badgeColor: string;
  numPrefix: string;
  stamp: string;
  stampColor: string;
  showVat: boolean;
  showSig: boolean;
  showDue: boolean;
  needsVat: boolean;
  hidePrices?: boolean;
};

export const A4_DOC_TYPES: Record<A4DocType, A4DocTypeConfig> = {
  receipt: {
    label: 'ใบเสร็จรับเงิน',
    badgeColor: '#0F6E56',
    numPrefix: 'RCP',
    stamp: 'ชำระแล้ว',
    stampColor: '#0F6E56',
    showVat: false,
    showSig: false,
    showDue: false,
    needsVat: false,
  },
  invoice: {
    label: 'ใบกำกับภาษีอย่างย่อ',
    badgeColor: '#534AB7',
    numPrefix: 'INV',
    stamp: 'ชำระแล้ว',
    stampColor: '#0F6E56',
    showVat: true,
    showSig: false,
    showDue: false,
    needsVat: true,
  },
  full: {
    label: 'ใบกำกับภาษีเต็มรูปแบบ',
    badgeColor: '#185FA5',
    numPrefix: 'TAX',
    stamp: 'ชำระแล้ว',
    stampColor: '#0F6E56',
    showVat: true,
    showSig: true,
    showDue: false,
    needsVat: true,
  },
  quotation: {
    label: 'ใบเสนอราคา',
    badgeColor: '#854F0B',
    numPrefix: 'QUO',
    stamp: 'ยังไม่ยืนยัน',
    stampColor: '#854F0B',
    showVat: true,
    showSig: true,
    showDue: true,
    needsVat: false,
  },
  delivery: {
    label: 'ใบส่งสินค้า',
    badgeColor: '#1D9E75',
    numPrefix: 'DLV',
    stamp: 'จัดส่งแล้ว',
    stampColor: '#0F6E56',
    showVat: false,
    showSig: true,
    showDue: false,
    needsVat: false,
    hidePrices: true,
  },
};

export function mergeBranchDocumentSettings(
  branch: Pick<Branch, 'name' | 'address' | 'phone' | 'email' | 'taxId' | 'logoUrl'>,
  settings: Pick<
    Settings,
    | 'receiptHeader'
    | 'receiptFooter'
    | 'receiptLogoUrl'
    | 'vatRegistered'
    | 'vatRate'
    | 'priceIncludesVat'
    | 'showBarcodeOnReceipt'
    | 'showQrOnReceipt'
  >,
): BranchDocumentSettings {
  return {
    companyName: 'บริษัท ทวิน เพ็ท จำกัด',
    branchName: branch.name,
    branchAddress: branch.address,
    branchPhone: branch.phone,
    branchEmail: branch.email,
    taxId: branch.taxId,
    logoUrl: settings.receiptLogoUrl ?? branch.logoUrl,
    receiptHeader: settings.receiptHeader,
    receiptFooter: settings.receiptFooter,
    vatRegistered: settings.vatRegistered,
    vatRate: settings.vatRate,
    priceIncludesVat: settings.priceIncludesVat,
    showBarcodeOnReceipt: settings.showBarcodeOnReceipt,
    showQrOnReceipt: settings.showQrOnReceipt,
    showLogoOnReceipt: true,
    showStaffOnReceipt: true,
    showSignatureOnReceipt: false,
    showVatOnThermal: settings.vatRegistered,
  };
}

export const DEFAULT_BRANCH_DOCUMENT_SETTINGS: BranchDocumentSettings = {
  companyName: 'บริษัท ทวิน เพ็ท จำกัด',
  branchName: 'TwinPet Pet Shop — สาขาลาดพร้าว',
  branchAddress: '123/45 ถ.ลาดพร้าว แขวงลาดพร้าว เขตลาดพร้าว กรุงเทพมหานคร 10230',
  branchPhone: '02-123-4567',
  branchEmail: 'ladprao@twinpet.co.th',
  taxId: '0105560123456',
  logoUrl: null,
  receiptHeader: 'TwinPet Pet Shop\nสาขาลาดพร้าว',
  receiptFooter: 'ขอบคุณที่ใช้บริการ\nwww.twinpet.co.th',
  vatRegistered: true,
  vatRate: 7,
  priceIncludesVat: true,
  showBarcodeOnReceipt: true,
  showQrOnReceipt: false,
  showLogoOnReceipt: true,
  showStaffOnReceipt: true,
  showSignatureOnReceipt: false,
  showVatOnThermal: false,
};
