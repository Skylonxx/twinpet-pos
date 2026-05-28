import type { ReceivingLine } from './types';

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function generateFallbackBillNo(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `RCV-${y}${m}${day}-${suffix}`;
}

export function buildReceivingNote(parts: {
  billNo: string;
  receiveDate: string;
  billDate: string;
  note: string;
}): string {
  return [
    parts.billNo && `เลขที่บิล: ${parts.billNo}`,
    parts.receiveDate && `วันที่รับเข้า: ${parts.receiveDate}`,
    parts.billDate && `วันที่ซื้อในบิล: ${parts.billDate}`,
    parts.note.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
}

export type ParsedReceivingNote = {
  purchaseBillNo: string;
  receiveDate: string;
  billDate: string;
  freeNote: string;
};

export function parseReceivingNote(note: string): ParsedReceivingNote {
  const parts = note.split(' · ').map((p) => p.trim());
  let purchaseBillNo = '';
  let receiveDate = '';
  let billDate = '';
  const free: string[] = [];

  for (const part of parts) {
    if (part.startsWith('เลขที่บิล:')) {
      purchaseBillNo = part.replace('เลขที่บิล:', '').trim();
    } else if (part.startsWith('วันที่รับเข้า:')) {
      receiveDate = part.replace('วันที่รับเข้า:', '').trim();
    } else if (part.startsWith('วันที่ซื้อในบิล:')) {
      billDate = part.replace('วันที่ซื้อในบิล:', '').trim();
    } else if (part) {
      free.push(part);
    }
  }

  return {
    purchaseBillNo,
    receiveDate,
    billDate,
    freeNote: free.join(' · '),
  };
}

export function timestampToIsoDate(value: unknown): string {
  if (
    value != null &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString().slice(0, 10);
  }
  return todayIso();
}

export function updateReceivingLine(
  lines: ReceivingLine[],
  lineKey: string,
  patch: Partial<ReceivingLine>,
): ReceivingLine[] {
  return lines.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l));
}

export type ReceivingFormValues = {
  lines: ReceivingLine[];
  supplierId: string | null;
  supplierName: string;
  billDate: string;
  receiveDate: string;
  purchaseBillNo: string;
  note: string;
  discType: 'pct' | 'thb';
  discValue: number;
  vatOn: boolean;
  vatInc: boolean;
};

export type ReceivingFormSubmitPayload = ReceivingFormValues & {
  finalDiscount: number;
  composedNote: string;
};

export function emptyReceivingFormValues(): ReceivingFormValues {
  const today = todayIso();
  return {
    lines: [],
    supplierId: null,
    supplierName: '',
    billDate: today,
    receiveDate: today,
    purchaseBillNo: '',
    note: '',
    discType: 'thb',
    discValue: 0,
    vatOn: false,
    vatInc: false,
  };
}

export function buildSubmitPayload(values: ReceivingFormValues): ReceivingFormSubmitPayload {
  const billNo = values.purchaseBillNo.trim() || generateFallbackBillNo();
  const linesSubtotal = values.lines.reduce(
    (s, l) => s + Math.max(0, l.qty * l.costPerUnit - (l.itemDiscount || 0)),
    0,
  );
  const finalDiscount =
    values.discType === 'pct'
      ? Math.max(0, linesSubtotal * (values.discValue / 100))
      : Math.min(values.discValue, linesSubtotal);

  return {
    ...values,
    finalDiscount,
    composedNote: buildReceivingNote({
      billNo,
      receiveDate: values.receiveDate,
      billDate: values.billDate,
      note: values.note,
    }),
  };
}
