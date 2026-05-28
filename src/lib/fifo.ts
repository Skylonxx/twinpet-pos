import {
  collection,
  doc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  orderBy,
  type DocumentReference,
  type DocumentSnapshot,
} from 'firebase/firestore';
import { collections, db } from './firebase';
import { buildCrmSaleUpdateFields } from './customers/crmService';
import {
  commitReceiptCounterInTransaction,
  readReceiptCounterInTransaction,
  resolveReceiptNumberConfig,
} from './pos/billId';
import { calcShiftPaymentTotals } from './pos/shiftService';
import type { CartLine, PaymentSplit } from './pos/types';
import { getLineTotal } from './pos/cartUtils';
import type {
  CreditAccount,
  LotRef,
  Order,
  OrderItem,
  Payment,
  Product,
  ProductStock,
  Customer,
  Shift,
  CreditTransaction,
} from './types';

export type CompleteSaleInput = {
  branchId: string;
  staffId: string;
  staffName: string;
  shiftId: string;
  lines: CartLine[];
  billDiscount: number;
  fee: number;
  grandTotal: number;
  subtotal: number;
  payments: PaymentSplit[];
  customerId?: string | null;
  customerName?: string | null;
  priceLevelId?: string;
};

type LotUpdate = {
  ref: DocumentReference;
  newQty: number;
  costPerUnit: number;
  cutQty: number;
};

type MutableLot = {
  ref: DocumentReference;
  id: string;
  qtyRemaining: number;
  costPerUnit: number;
};

async function queryLots(productId: string, branchId: string) {
  if (!db) return [];
  const snap = await getDocs(
    query(
      collection(db, collections.stockLots),
      where('productId', '==', productId),
      where('branchId', '==', branchId),
      where('isDepleted', '==', false),
      orderBy('receivedAt', 'asc'),
    ),
  );
  return snap.docs;
}

function cloneLots(lotDocs: Awaited<ReturnType<typeof queryLots>>): MutableLot[] {
  return lotDocs.map((lotDoc) => {
    const lot = lotDoc.data();
    return {
      ref: lotDoc.ref,
      id: lotDoc.id,
      qtyRemaining: lot.qtyRemaining ?? 0,
      costPerUnit: lot.costPerUnit ?? 0,
    };
  });
}

function planFifoCutFromState(
  lots: MutableLot[],
  qtyBase: number,
): { updates: LotUpdate[]; lotRefs: LotRef[]; remaining: number } {
  let remaining = qtyBase;
  const updates: LotUpdate[] = [];
  const lotRefs: LotRef[] = [];

  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.qtyRemaining <= 0) continue;

    const cut = Math.min(remaining, lot.qtyRemaining);
    lotRefs.push({ lotId: lot.id, qty: cut, cost: lot.costPerUnit });
    updates.push({
      ref: lot.ref,
      newQty: lot.qtyRemaining - cut,
      costPerUnit: lot.costPerUnit,
      cutQty: cut,
    });
    lot.qtyRemaining -= cut;
    remaining -= cut;
  }

  return { updates, lotRefs, remaining };
}

function mergeLotUpdates(updates: LotUpdate[]): LotUpdate[] {
  const byRef = new Map<string, LotUpdate>();
  for (const u of updates) {
    const existing = byRef.get(u.ref.path);
    if (!existing) {
      byRef.set(u.ref.path, { ...u });
      continue;
    }
    existing.newQty = u.newQty;
    existing.cutQty += u.cutQty;
  }
  return [...byRef.values()];
}

function resolveOversellCost(
  sourceLots: MutableLot[],
  product: Product | undefined,
  line: CartLine,
): number {
  for (let i = sourceLots.length - 1; i >= 0; i--) {
    const cost = sourceLots[i]?.costPerUnit ?? 0;
    if (cost > 0) return cost;
  }
  if (product?.avgCost && product.avgCost > 0) return product.avgCost;
  const retail = product?.prices?.find((p) => p.priceLevelId === 'RETAIL')?.price;
  if (retail && retail > 0) return retail;
  return line.unitPrice;
}

export async function completePosSale(input: CompleteSaleInput): Promise<string> {
  if (!db) {
    throw new Error('Firestore is not configured');
  }
  const firestore = db;

  const receiptConfig = await resolveReceiptNumberConfig(firestore, input.branchId);

  const lotsByProduct = new Map<string, MutableLot[]>();
  for (const line of input.lines) {
    if (!lotsByProduct.has(line.productId)) {
      const lotDocs = await queryLots(line.productId, input.branchId);
      lotsByProduct.set(line.productId, cloneLots(lotDocs));
    }
  }

  const uniqueProductIds = [...new Set(input.lines.map((l) => l.productId))];

  const billIdResult = await runTransaction(firestore, async (tx) => {
    const orderRef = doc(collection(firestore, collections.orders));
    const orderItemsCol = collection(orderRef, collections.orderItems);

    const paidAmt = input.payments.reduce((s, p) => s + p.amount, 0);
    const creditAmt = input.payments
      .filter((p) => p.method === 'credit')
      .reduce((s, p) => s + p.amount, 0);

    if (creditAmt > 0 && !input.customerId) {
      throw new Error('ต้องเลือกลูกค้าก่อนบันทึกเชื่อ');
    }

    // ── Phase 1: all reads ──
    const receiptAllocation = await readReceiptCounterInTransaction(tx, firestore, receiptConfig);
    const billId = receiptAllocation.billId;

    const shiftRef = doc(firestore, collections.shifts, input.shiftId);
    const shiftSnap = await tx.get(shiftRef);

    const stockSnaps = new Map<string, DocumentSnapshot>();
    const productSnaps = new Map<string, DocumentSnapshot>();
    for (const productId of uniqueProductIds) {
      const productStockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        input.branchId,
      );
      stockSnaps.set(productId, await tx.get(productStockRef));
      productSnaps.set(productId, await tx.get(doc(firestore, collections.products, productId)));
    }

    let customerRef: DocumentReference | null = null;
    let customerSnap: DocumentSnapshot | null = null;
    let credRef: DocumentReference | null = null;
    let credSnap: DocumentSnapshot | null = null;
    if (input.customerId) {
      customerRef = doc(firestore, collections.customers, input.customerId);
      customerSnap = await tx.get(customerRef);
      if (creditAmt > 0) {
        credRef = doc(firestore, collections.creditAccounts, input.customerId);
        credSnap = await tx.get(credRef);
      }
    }

    // ── Phase 2: validate & plan (in memory) ──
    if (!shiftSnap.exists()) {
      throw new Error('ไม่พบกะที่เปิดอยู่');
    }
    const shiftData = shiftSnap.data() as Shift;
    if (shiftData.status !== 'open') {
      throw new Error('กะนี้ถูกปิดแล้ว');
    }
    if (shiftData.branchId !== input.branchId || shiftData.staffId !== input.staffId) {
      throw new Error('กะไม่ตรงกับสาขาหรือพนักงาน');
    }

    const { netCash, qrTotal, kbankTotal, cardTotal, creditTotal } = calcShiftPaymentTotals(
      input.payments,
      input.grandTotal,
    );

    const stockRemaining = new Map<string, number>();
    for (const productId of uniqueProductIds) {
      const snap = stockSnaps.get(productId);
      stockRemaining.set(
        productId,
        (snap?.data() as ProductStock | undefined)?.totalStockBase ?? 0,
      );
    }

    const lotStates = new Map<string, MutableLot[]>();
    for (const [productId, lots] of lotsByProduct) {
      lotStates.set(
        productId,
        lots.map((l) => ({ ...l, qtyRemaining: l.qtyRemaining })),
      );
    }

    const itemWrites: Array<{ ref: DocumentReference; data: OrderItem }> = [];
    const stockDeduct = new Map<string, number>();
    const allLotUpdates: LotUpdate[] = [];

    for (const line of input.lines) {
      const qtyBase = line.qty * line.unitFactor;
      const productData = productSnaps.get(line.productId)?.data() as Product | undefined;
      const allowNegative = productData?.allowNegativeStock === true;
      const available = stockRemaining.get(line.productId) ?? 0;

      if (!allowNegative && available < qtyBase) {
        throw new Error(
          `สต็อกไม่พอ: ${line.productName} เหลือ ${available} ต้องการ ${qtyBase}`,
        );
      }

      stockRemaining.set(line.productId, available - qtyBase);
      stockDeduct.set(line.productId, (stockDeduct.get(line.productId) ?? 0) + qtyBase);

      const sourceLots = lotsByProduct.get(line.productId) ?? [];
      const lots = lotStates.get(line.productId) ?? [];
      const { updates, lotRefs, remaining } = planFifoCutFromState(lots, qtyBase);

      if (remaining > 0) {
        if (!allowNegative) {
          throw new Error(`สต็อกล็อตไม่พอสำหรับ ${line.productName}`);
        }
        const fallbackCost = resolveOversellCost(sourceLots, productData, line);
        lotRefs.push({
          lotId: 'oversell',
          qty: remaining,
          cost: fallbackCost,
        });
      }

      allLotUpdates.push(...updates);

      const lineFifoCost = lotRefs.reduce((s, r) => s + r.qty * r.cost, 0);
      const itemRef = doc(orderItemsCol);
      const lineTotal = getLineTotal(line);

      itemWrites.push({
        ref: itemRef,
        data: {
          id: itemRef.id,
          productId: line.productId,
          productSnap: {
            name: line.productName,
            sku: line.sku,
            category: line.category,
          },
          unit: line.unit,
          unitFactor: line.unitFactor,
          qty: line.qty,
          qtyBase,
          unitPrice: line.unitPrice,
          originalPrice: line.originalPrice ?? line.unitPrice,
          discountAmt: line.unitPrice * line.qty - lineTotal,
          lineTotal,
          fifoCost: lineFifoCost,
          lotRefs,
        },
      });
    }

    if (creditAmt > 0 && input.customerId) {
      if (!customerSnap?.exists()) {
        throw new Error('ไม่พบข้อมูลลูกค้า');
      }
      const customer = customerSnap.data() as Customer;
      const currentOutstanding = customer.outstandingBalance ?? 0;
      if (customer.creditLimit > 0 && currentOutstanding + creditAmt > customer.creditLimit) {
        throw new Error('ยอดเชื่อเกินวงเงินที่กำหนด');
      }
    }

    // ── Phase 3: all writes ──
    commitReceiptCounterInTransaction(tx, receiptAllocation);

    tx.update(shiftRef, {
      expectedCash: increment(netCash),
      expectedQr: increment(qrTotal),
      expectedKbank: increment(kbankTotal),
      expectedCard: increment(cardTotal),
      expectedCredit: increment(creditTotal),
      totalBills: increment(1),
    });

    for (const u of mergeLotUpdates(allLotUpdates)) {
      tx.update(u.ref, {
        qtyRemaining: u.newQty,
        isDepleted: u.newQty === 0,
      });
    }

    for (const productId of uniqueProductIds) {
      const deduct = stockDeduct.get(productId) ?? 0;
      if (deduct <= 0) continue;

      const productStockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        input.branchId,
      );

      tx.update(productStockRef, {
        totalStockBase: increment(-deduct),
        lastMovementAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]!;
      const itemWrite = itemWrites[i]!;
      const qtyBase = itemWrite.data.qtyBase;
      const lotRefs = itemWrite.data.lotRefs;
      const firstCost = lotRefs[0]?.cost ?? 0;

      const movementRef = doc(collection(firestore, collections.stockMovements));
      tx.set(movementRef, {
        id: movementRef.id,
        productId: line.productId,
        branchId: input.branchId,
        type: 'sale',
        qty: -qtyBase,
        costPerUnit: firstCost,
        refId: billId,
        refType: 'order',
        note: '',
        createdBy: input.staffId,
        createdAt: serverTimestamp(),
      });
    }

    const orderData: Order = {
      id: orderRef.id,
      billId,
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      customerSnap: input.customerName
        ? { name: input.customerName, phone: '', taxId: null }
        : null,
      staffId: input.staffId,
      staffName: input.staffName,
      status: creditAmt > 0 && paidAmt < input.grandTotal ? 'pending_payment' : 'completed',
      subtotal: input.subtotal,
      discountAmt: input.lines.reduce(
        (s, l) => s + (l.unitPrice * l.qty - getLineTotal(l)),
        0,
      ),
      billDiscount: input.billDiscount,
      vatRate: 0,
      vatAmt: 0,
      surcharge: input.fee,
      total: input.grandTotal,
      paidAmt,
      changeAmt: Math.max(0, paidAmt - input.grandTotal),
      creditAmt,
      priceLevelId: input.priceLevelId ?? 'RETAIL',
      note: '',
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      printCount: 0,
      createdAt: serverTimestamp() as never,
      updatedAt: serverTimestamp() as never,
    };

    tx.set(orderRef, orderData);

    for (const { ref, data } of itemWrites) {
      tx.set(ref, data);
    }

    for (const pay of input.payments) {
      if (pay.amount <= 0) continue;
      const payRef = doc(collection(firestore, collections.payments));
      const payment: Payment = {
        id: payRef.id,
        orderId: orderRef.id,
        branchId: input.branchId,
        method: pay.method,
        amount: pay.amount,
        ref: null,
        createdAt: serverTimestamp() as never,
      };
      tx.set(payRef, payment);
    }

    if (input.customerId && customerRef && customerSnap?.exists()) {
      const customerUpdates: Record<string, unknown> = {
        ...buildCrmSaleUpdateFields(input.grandTotal),
      };
      if (creditAmt > 0) {
        customerUpdates.outstandingBalance = increment(creditAmt);
        customerUpdates.lastCreditPurchaseDate = Timestamp.now();

        if (credRef && credSnap?.exists()) {
          const account = credSnap.data() as CreditAccount;
          const newUsed = account.creditUsed + creditAmt;
          tx.update(credRef, {
            creditUsed: increment(creditAmt),
            creditBalance: account.creditLimit - newUsed,
            lastTransAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          const creditTxRef = doc(collection(firestore, collections.creditTransactions));
          const creditTx: CreditTransaction = {
            id: creditTxRef.id,
            customerId: input.customerId,
            branchId: input.branchId,
            type: 'charge',
            amount: creditAmt,
            balance: account.creditLimit - newUsed,
            refOrderId: orderRef.id,
            note: '',
            createdBy: input.staffId,
            createdAt: serverTimestamp() as never,
            dueDate: null,
            isPaid: false,
            paidAt: null,
          };
          tx.set(creditTxRef, creditTx);
        }
      }
      tx.update(customerRef, customerUpdates);
    }

    return billId;
  });

  return billIdResult;
}
