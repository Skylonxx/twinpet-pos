import type { ProductStock, Receiving, StockLot, StockMovement } from '../types';
import { getDevProductList } from '../productCrud/devMock';
import {
  generateGrnId,
  lineCostBase,
  lineQtyBase,
  receivingGrandTotal,
  receivingSubtotal,
  type ConfirmReceivingInput,
} from './types';

function ts(d = new Date()): Receiving['createdAt'] {
  return { toDate: () => d } as Receiving['createdAt'];
}

const devReceivings: Receiving[] = [];
let devLots: StockLot[] = [];
let devMovements: StockMovement[] = [];
let devStocks: Record<string, ProductStock> = {};

function initStocks(branchId: string) {
  for (const p of getDevProductList(branchId)) {
    if (!devStocks[p.id]) {
      devStocks[p.id] = {
        branchId,
        totalStockBase: p.stock,
        reorderPoint: p.branchReorderPoint,
        lastMovementAt: ts(),
        updatedAt: ts(),
      };
    }
  }
}

export function devConfirmReceiving(input: ConfirmReceivingInput): string {
  initStocks(input.branchId);
  const receivingId = generateGrnId();
  const now = new Date();

  for (const line of input.lines) {
    const qtyBase = lineQtyBase(line);
    const costBase = lineCostBase(line);
    const stock = devStocks[line.productId] ?? {
      branchId: input.branchId,
      totalStockBase: 0,
      reorderPoint: 10,
      lastMovementAt: ts(),
      updatedAt: ts(),
    };

    let incoming = qtyBase;

    const ghosts = devLots.filter(
      (l) =>
        l.productId === line.productId &&
        l.branchId === input.branchId &&
        l.isGhost &&
        !l.isDepleted &&
        l.qtyRemaining < 0,
    );

    for (const ghost of ghosts) {
      if (incoming <= 0) break;
      const deficit = Math.abs(ghost.qtyRemaining);
      const reconcileQty = Math.min(incoming, deficit);
      ghost.qtyRemaining += reconcileQty;
      ghost.costPerUnit = costBase;
      ghost.isGhost = ghost.qtyRemaining < 0;
      ghost.isDepleted = ghost.qtyRemaining === 0;
      ghost.receivingId = receivingId;
      incoming -= reconcileQty;
    }

    if (incoming > 0) {
      devLots.push({
        id: `lot-${receivingId}-${line.productId}`,
        productId: line.productId,
        branchId: input.branchId,
        receivingId,
        costPerUnit: costBase,
        qtyReceived: incoming,
        qtyRemaining: incoming,
        receivedAt: ts(now),
        expiryDate: line.hasExpiry && line.expiryDate ? ts(new Date(line.expiryDate)) : null,
        isDepleted: false,
        isGhost: false,
        createdAt: ts(now),
      });
    }

    devStocks[line.productId] = {
      ...stock,
      totalStockBase: stock.totalStockBase + qtyBase,
      lastMovementAt: ts(now),
      updatedAt: ts(now),
    };

    devMovements.push({
      id: `mv-${receivingId}-${line.productId}`,
      productId: line.productId,
      branchId: input.branchId,
      type: 'receive',
      qty: qtyBase,
      costPerUnit: costBase,
      refId: receivingId,
      refType: 'receiving',
      note: input.note,
      createdBy: input.staffId,
      createdAt: ts(now),
    });
  }

  const linesSubtotal = receivingSubtotal(input.lines);
  const billDiscount = Math.max(0, input.finalDiscount || 0);
  const grandTotal = receivingGrandTotal(input.lines, billDiscount);

  devReceivings.push({
    id: receivingId,
    branchId: input.branchId,
    supplierId: input.supplierId,
    supplierName: input.supplierName.trim() || '—',
    staffId: input.staffId,
    status: 'completed',
    subtotal: linesSubtotal,
    discountAmt: billDiscount,
    vatRate: 0,
    vatAmt: 0,
    total: grandTotal,
    payStatus: 'paid',
    paidAmt: grandTotal,
    note: input.note,
    receivedAt: ts(now),
    createdAt: ts(now),
    updatedAt: ts(now),
  });

  return receivingId;
}

export function getDevReceivings() {
  return [...devReceivings];
}

/** Seed a ghost lot for dev testing reconcile */
export function devSeedGhostLot(productId: string, branchId: string, deficit: number) {
  devLots.push({
    id: `ghost-${productId}`,
    productId,
    branchId,
    receivingId: 'GHOST',
    costPerUnit: 0,
    qtyReceived: 0,
    qtyRemaining: -deficit,
    receivedAt: ts(),
    expiryDate: null,
    isDepleted: false,
    isGhost: true,
    createdAt: ts(),
  });
  initStocks(branchId);
  if (devStocks[productId]) {
    devStocks[productId].totalStockBase -= deficit;
  }
}
