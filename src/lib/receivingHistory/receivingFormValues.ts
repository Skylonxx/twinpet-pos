import type { ReceivingFormSubmitPayload } from '../receiving/receivingFormUtils';
import { receivingItemToLine } from './types';
import {
  emptyReceivingFormValues,
  parseReceivingNote,
  timestampToIsoDate,
  type ReceivingFormValues,
} from '../receiving/receivingFormUtils';
import type { EditReceivingLine, DraftReceivingLine } from './types';
import type { Receiving, ReceivingItem } from '../types';

export function formLinesToEditLines(
  lines: ReceivingFormSubmitPayload['lines'],
  existingItemIds: Set<string>,
): EditReceivingLine[] {
  return lines.map((line) => ({
    ...line,
    itemId: existingItemIds.has(line.lineKey) ? line.lineKey : undefined,
  }));
}

export function formLinesToDraftLines(
  lines: ReceivingFormSubmitPayload['lines'],
  existingItemIds: Set<string>,
): DraftReceivingLine[] {
  return formLinesToEditLines(lines, existingItemIds);
}

export function receivingFormValuesFromRecord(
  receiving: Receiving,
  items: ReceivingItem[],
): ReceivingFormValues {
  const parsed = parseReceivingNote(receiving.note);
  const fallbackDate = timestampToIsoDate(receiving.receivedAt);

  return {
    lines: items.map((item) => receivingItemToLine(item)),
    supplierId: receiving.supplierId,
    supplierName: receiving.supplierName === '—' ? '' : receiving.supplierName,
    billDate: parsed.billDate || fallbackDate,
    receiveDate: parsed.receiveDate || fallbackDate,
    purchaseBillNo: parsed.purchaseBillNo,
    note: parsed.freeNote,
    discType: 'thb',
    discValue: receiving.discountAmt,
    vatOn: receiving.vatRate > 0,
    vatInc: false,
  };
}

export { emptyReceivingFormValues };
