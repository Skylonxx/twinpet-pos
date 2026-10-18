/**
 * Return/Refund V1 — client contract + pure helpers (no Firebase).
 *
 * Mirrors `functions/src/saleReturnCore.ts` / `functions/src/submitSaleReturn.ts`.
 * The server is the only authority: the refund preview below is DISPLAY-ONLY
 * and is re-sent as `expectedRefundAmount`, which the server rejects
 * (`refund_mismatch`) unless it equals its own computation — so the cashier
 * never sees one amount while a different one is refunded.
 */

export type SaleReturnClassification =
  | 'RETURN_ELIGIBLE'
  | 'RETURN_UNSUPPORTED_EVIDENCE'
  | 'RETURN_NOT_ELIGIBLE';

export type SaleReturnRefundMethod = 'cash' | 'qr' | 'kbank' | 'card' | 'none';
export type MoneyRefundMethod = Exclude<SaleReturnRefundMethod, 'none'>;

export type SaleReturnContextLine = {
  lineIndex: number;
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  soldQty: number;
  returnedQty: number;
  returnableQty: number;
  soldQtyMilli: number;
  returnedQtyMilli: number;
  unitPrice: number;
  lineDiscount: number;
  lineTotal: number;
  billDiscountAlloc: number;
  feeAlloc: number;
  refundableShareMinor: number;
  refundedAmount: number;
};

export type SaleReturnContextView = {
  orderId: string;
  billId: string;
  branchId: string;
  customerName: string | null;
  saleCreatedAtMs: number;
  total: number;
  refundedTotal: number;
  returnCount: number;
  fullyReturned: boolean;
  lines: SaleReturnContextLine[];
  refundMethods: { method: MoneyRefundMethod; remaining: number }[];
};

export type SaleReturnErrorCode =
  | 'not_authorized'
  | 'branch_mismatch'
  | 'invalid_request'
  | 'order_not_found'
  | 'return_not_eligible'
  | 'return_unsupported_evidence'
  | 'over_return'
  | 'refund_mismatch'
  | 'refund_method_not_allowed'
  | 'refund_cap_exceeded'
  | 'reference_required'
  | 'shift_required'
  | 'idempotency_conflict'
  | 'invalid_credentials'
  | 'locked'
  | 'expired_approval'
  | 'replayed_approval'
  | 'self_approval_not_permitted'
  | 'approver_not_eligible'
  | 'invalid_target';

export const SALE_RETURN_ERROR_COPY: Record<SaleReturnErrorCode, string> = {
  not_authorized: 'ไม่มีสิทธิ์ทำรายการคืนสินค้า',
  branch_mismatch: 'บิลนี้ไม่ใช่ของสาขาที่คุณมีสิทธิ์',
  invalid_request: 'ข้อมูลคำขอคืนสินค้าไม่ถูกต้อง',
  order_not_found: 'ไม่พบบิลนี้บนเซิร์ฟเวอร์',
  return_not_eligible: 'บิลนี้คืนสินค้าไม่ได้',
  return_unsupported_evidence: 'ข้อมูลบิลนี้ไม่พอสำหรับการคืนสินค้า (ต้นทุน/ราคาเดิม)',
  over_return: 'จำนวนคืนเกินจำนวนที่คืนได้ (อาจมีการคืนไปแล้ว) — กรุณาโหลดข้อมูลบิลใหม่',
  refund_mismatch: 'ยอดคืนเงินไม่ตรงกับที่ระบบคำนวณ — กรุณาโหลดข้อมูลบิลใหม่',
  refund_method_not_allowed: 'ช่องทางคืนเงินนี้ใช้กับบิลนี้ไม่ได้',
  refund_cap_exceeded: 'ยอดคืนเงินเกินยอดที่ลูกค้าชำระด้วยช่องทางนี้',
  reference_required: 'กรุณาระบุเลขอ้างอิงการคืนเงิน',
  shift_required: 'ต้องเปิดกะของคุณก่อนคืนเงินสด',
  idempotency_conflict: 'คำขอนี้ถูกใช้กับข้อมูลอื่นไปแล้ว — กรุณาเริ่มรายการใหม่',
  invalid_credentials: 'PIN ผู้อนุมัติไม่ถูกต้อง',
  locked: 'ใส่ PIN ผิดหลายครั้ง ถูกล็อกชั่วคราว — กรุณารอแล้วลองใหม่',
  expired_approval: 'การอนุมัติหมดอายุ — กรุณาขออนุมัติใหม่',
  replayed_approval: 'การอนุมัตินี้ถูกใช้ไปแล้ว — กรุณาขออนุมัติใหม่',
  self_approval_not_permitted: 'ผู้อนุมัติต้องเป็นคนละคนกับผู้ทำรายการ',
  approver_not_eligible: 'ผู้อนุมัติไม่มีสิทธิ์อนุมัติการคืนสินค้า',
  invalid_target: 'ยืนยันคำขอคืนสินค้าไม่ได้ — กรุณาลองใหม่',
};

export const SALE_RETURN_OFFLINE_COPY = 'ต้องออนไลน์เพื่อคืนสินค้า/คืนเงิน';
/** Transport failure: the server MAY have committed. A retry of the same attempt never refunds twice. */
export const SALE_RETURN_UNKNOWN_OUTCOME_COPY =
  'ติดต่อเซิร์ฟเวอร์ไม่สำเร็จ — ยังไม่ทราบผล กรุณาส่งอีกครั้งเพื่อตรวจสอบ (ระบบจะไม่คืนเงินซ้ำ)';

export const SALE_RETURN_ACTION_LABEL = 'คืนสินค้า / คืนเงิน';

export const RETURN_REASONS = [
  'สินค้าชำรุด/เสียหาย',
  'สินค้าหมดอายุ',
  'ลูกค้าเปลี่ยนใจ',
  'ขายผิดรายการ',
  'อื่นๆ',
] as const;

export const REFUND_METHOD_LABEL: Record<SaleReturnRefundMethod, string> = {
  cash: 'เงินสด (จ่ายจากลิ้นชัก)',
  qr: 'QR / พร้อมเพย์ (โอนคืนเอง)',
  kbank: 'โอนธนาคาร (โอนคืนเอง)',
  card: 'บัตร (ทำรายการคืนที่เครื่องเอง)',
  none: 'ไม่มีการคืนเงิน',
};

export function classificationCopy(classification: SaleReturnClassification, reason: string | null): string {
  if (classification === 'RETURN_ELIGIBLE') return '';
  if (classification === 'RETURN_UNSUPPORTED_EVIDENCE') {
    if (reason === 'credit_sale_unsupported') return 'บิลที่มีการชำระแบบเงินเชื่อยังไม่รองรับการคืนสินค้าในเวอร์ชันนี้';
    if (reason === 'vat_unsupported') return 'บิลที่มี VAT ยังไม่รองรับการคืนสินค้าในเวอร์ชันนี้';
    return 'บิลเก่านี้ไม่มีข้อมูลต้นทุน/ราคาเดิมครบ — ระบบไม่คืนสินค้าแบบเดา';
  }
  switch (reason) {
    case 'voided':
      return 'บิลนี้ถูกยกเลิกแล้ว คืนสินค้าไม่ได้';
    case 'void_in_progress':
    case 'void_terminal_marker':
      return 'บิลนี้มีการยกเลิกค้างอยู่ คืนสินค้าไม่ได้';
    case 'fully_returned':
      return 'บิลนี้คืนสินค้าครบทุกรายการแล้ว';
    case 'not_settled':
      return 'บิลยังไม่ปิดยอดกับเซิร์ฟเวอร์ — คืนสินค้าได้หลังซิงก์เสร็จ';
    case 'canonical_not_completed':
      return 'บิลค้างชำระ/เงินเชื่อ คืนสินค้าไม่ได้ในเวอร์ชันนี้';
    case 'reconcile_exception':
      return 'บิลนี้มีปัญหาการซิงก์ ต้องให้ผู้จัดการตรวจสอบก่อน';
    default:
      return 'บิลนี้คืนสินค้าไม่ได้';
  }
}

/** Quantity → integer milli-units; `null` if not exact to 0.001 or not positive-finite. */
export function qtyToMilli(qty: number): number | null {
  if (!Number.isFinite(qty)) return null;
  const scaled = qty * 1000;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6 * Math.max(1, Math.abs(scaled))) return null;
  return rounded;
}

/** Server-mirrored cumulative refund: round-half-up(share × cum / sold), in satang. */
export function cumulativeRefundMinor(shareMinor: number, soldQtyMilli: number, cumQtyMilli: number): number {
  if (soldQtyMilli <= 0 || cumQtyMilli <= 0 || shareMinor <= 0) return 0;
  const cum = BigInt(Math.min(cumQtyMilli, soldQtyMilli));
  const sold = BigInt(soldQtyMilli);
  const share = BigInt(shareMinor);
  return Number((2n * share * cum + sold) / (2n * sold));
}

/** Display-only refund preview (satang) for returning `qtyMilli` more units of a line. */
export function previewLineRefundMinor(line: SaleReturnContextLine, qtyMilli: number): number {
  if (qtyMilli <= 0) return 0;
  return (
    cumulativeRefundMinor(line.refundableShareMinor, line.soldQtyMilli, line.returnedQtyMilli + qtyMilli) -
    cumulativeRefundMinor(line.refundableShareMinor, line.soldQtyMilli, line.returnedQtyMilli)
  );
}

export type ReturnDraftLine = { lineIndex: number; qty: number };

export type ReturnDraftCheck =
  | { ok: true; lines: { lineIndex: number; productId: string; qty: number }[]; refundMinor: number }
  | { ok: false; message: string };

/** Pure draft validation used by the UI before asking for approval. */
export function checkReturnDraft(context: SaleReturnContextView, draft: readonly ReturnDraftLine[]): ReturnDraftCheck {
  const byIndex = new Map(context.lines.map((l) => [l.lineIndex, l]));
  const out: { lineIndex: number; productId: string; qty: number }[] = [];
  let refundMinor = 0;
  for (const d of draft) {
    if (!(d.qty > 0)) continue;
    const line = byIndex.get(d.lineIndex);
    if (!line) return { ok: false, message: 'ไม่พบรายการสินค้าในบิล' };
    const milli = qtyToMilli(d.qty);
    if (milli == null || milli <= 0) return { ok: false, message: `จำนวนคืนของ ${line.productName} ไม่ถูกต้อง` };
    if (line.returnedQtyMilli + milli > line.soldQtyMilli) {
      return { ok: false, message: `${line.productName} คืนได้สูงสุด ${line.returnableQty} ${line.unit}` };
    }
    refundMinor += previewLineRefundMinor(line, milli);
    out.push({ lineIndex: line.lineIndex, productId: line.productId, qty: d.qty });
  }
  if (out.length === 0) return { ok: false, message: 'กรุณาระบุจำนวนสินค้าที่คืนอย่างน้อย 1 รายการ' };
  return { ok: true, lines: out, refundMinor };
}

export function minorToBaht(minor: number): number {
  return Math.round(minor) / 100;
}
