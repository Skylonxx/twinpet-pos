/** System-wide document & tax settings — Firestore `settings/system` */
export type TaxType = 'vat_inclusive' | 'vat_exclusive' | 'no_vat';

export type DocumentPrefixes = {
  salesReceipt: string;
  taxInvoiceShort: string;
  taxInvoiceFull: string;
  quotation: string;
  deliveryNote: string;
  receiving: string;
  purchaseOrder: string;
  creditNote: string;
  salesOrder: string;
};

export type LinePrefixes = {
  productSku: string;
  productBarcode: string;
  serialNumber: string;
  lotNumber: string;
};

export type SystemSettings = {
  taxType: TaxType;
  vatRate: number;
  currencyCode: string;
  currencySymbol: string;
  currencyName: string;
  generalNote: string;
  docPrefixes: DocumentPrefixes;
  linePrefixes: LinePrefixes;
  dateFormat: string;
  docNumberPadding: number;
  copyWatermark: string;
  fiscalYearStartMonth: number;
};

export type SystemSettingsForm = SystemSettings;

export const TAX_TYPE_OPTIONS: { value: TaxType; label: string; desc: string }[] = [
  {
    value: 'vat_inclusive',
    label: 'ราคารวม VAT',
    desc: 'ราคาขายที่แสดงรวมภาษีมูลค่าเพิ่มแล้ว',
  },
  {
    value: 'vat_exclusive',
    label: 'ราคาไม่รวม VAT',
    desc: 'แสดงราคาก่อนภาษี และคำนวณ VAT แยกตอนสรุปยอด',
  },
  {
    value: 'no_vat',
    label: 'ไม่คิดภาษี',
    desc: 'ไม่ออกใบกำกับภาษี / ไม่คำนวณ VAT',
  },
];

export const CURRENCY_OPTIONS = [
  { code: 'THB', symbol: '฿', name: 'บาท' },
  { code: 'USD', symbol: '$', name: 'ดอลลาร์สหรัฐ' },
  { code: 'EUR', symbol: '€', name: 'ยูโร' },
];

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  taxType: 'vat_inclusive',
  vatRate: 7,
  currencyCode: 'THB',
  currencySymbol: '฿',
  currencyName: 'บาท',
  generalNote: '',
  docPrefixes: {
    salesReceipt: 'RCP',
    taxInvoiceShort: 'INV',
    taxInvoiceFull: 'TAX',
    quotation: 'QUO',
    deliveryNote: 'DLV',
    receiving: 'RCV',
    purchaseOrder: 'PO',
    creditNote: 'CN',
    salesOrder: 'SO',
  },
  linePrefixes: {
    productSku: 'SKU',
    productBarcode: 'BAR',
    serialNumber: 'SN',
    lotNumber: 'LOT',
  },
  dateFormat: 'dd/MM/yyyy',
  docNumberPadding: 4,
  copyWatermark: 'สำเนา / COPY',
  fiscalYearStartMonth: 1,
};

export const DOC_PREFIX_FIELDS: {
  key: keyof DocumentPrefixes;
  label: string;
  hint: string;
}[] = [
  { key: 'salesReceipt', label: 'ใบเสร็จรับเงิน', hint: 'เช่น RCP-20250526-0001' },
  { key: 'taxInvoiceShort', label: 'ใบกำกับภาษีอย่างย่อ', hint: 'เช่น INV-20250526-0001' },
  { key: 'taxInvoiceFull', label: 'ใบกำกับภาษีเต็มรูปแบบ', hint: 'เช่น TAX-20250526-0001' },
  { key: 'quotation', label: 'ใบเสนอราคา', hint: 'เช่น QUO-20250526-0001' },
  { key: 'deliveryNote', label: 'ใบส่งสินค้า', hint: 'เช่น DLV-20250526-0001' },
  { key: 'receiving', label: 'ใบรับเข้าสินค้า', hint: 'เช่น RCV-20250526-0001' },
  { key: 'purchaseOrder', label: 'ใบสั่งซื้อ', hint: 'เช่น PO-20250526-0001' },
  { key: 'creditNote', label: 'ใบลดหนี้', hint: 'เช่น CN-20250526-0001' },
  { key: 'salesOrder', label: 'ใบสั่งขาย', hint: 'เช่น SO-20250526-0001' },
];

export const LINE_PREFIX_FIELDS: {
  key: keyof LinePrefixes;
  label: string;
  hint: string;
}[] = [
  { key: 'productSku', label: 'รหัสสินค้า (SKU)', hint: 'คำนำหน้ารหัสสินค้าในระบบ' },
  { key: 'productBarcode', label: 'บาร์โค้ด', hint: 'คำนำหน้ารหัสบาร์โค้ด' },
  { key: 'serialNumber', label: 'หมายเลขซีเรียล', hint: 'สำหรับสินค้าที่ติดตามซีเรียล' },
  { key: 'lotNumber', label: 'Lot / Batch', hint: 'คำนำหน้า Lot สต็อก' },
];

export function mergeSystemSettings(data: Partial<SystemSettings> | undefined): SystemSettings {
  const base = DEFAULT_SYSTEM_SETTINGS;
  if (!data) return { ...base };
  return {
    ...base,
    ...data,
    docPrefixes: { ...base.docPrefixes, ...data.docPrefixes },
    linePrefixes: { ...base.linePrefixes, ...data.linePrefixes },
  };
}
