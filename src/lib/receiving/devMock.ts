import type { ProductStock, Receiving, ReceivingItem, StockLot, StockMovement } from '../types';
import type { CancelReceivingInput, SaveReceivingDraftInput, UpdateReceivingInput } from '../receivingHistory/types';
import { DRAFT_LOT_ID } from '../receivingHistory/types';
import { getDevProductList } from '../productCrud/devMock';
import { allocateDevReceivingNumber } from './receivingId';
import {
  lineCostBase,
  lineQtyBase,
  lineSubtotal,
  receivingGrandTotal,
  receivingSubtotal,
  type ConfirmReceivingInput,
} from './types';

function ts(d = new Date()): Receiving['createdAt'] {
  return { toDate: () => d } as Receiving['createdAt'];
}

const devReceivings: Receiving[] = [];
const devReceivingItems = new Map<string, ReceivingItem[]>();
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
  const receivingId = input.receivingId ?? allocateDevReceivingNumber();
  const isFinalizingDraft = Boolean(input.receivingId);
  const now = new Date();

  if (isFinalizingDraft) {
    const existing = devReceivings.find((r) => r.id === receivingId);
    if (!existing) throw new Error('ไม่พบเอกสารรับเข้า');
    if (existing.branchId !== input.branchId) {
      throw new Error('เอกสารนี้ไม่ใช่ของสาขาปัจจุบัน');
    }
    if (existing.status !== 'draft') {
      throw new Error('เอกสารนี้ไม่ใช่แบบร่าง');
    }
    devReceivingItems.set(receivingId, []);
  }

  const savedItems: ReceivingItem[] = [];

  for (const line of input.lines) {
    const qtyBase = lineQtyBase(line);
    const costBase = lineCostBase(line);
    const itemId = `item-${receivingId}-${line.productId}-${savedItems.length}`;
    const lotId = `lot-${receivingId}-${line.productId}-${savedItems.length}`;
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
        id: lotId,
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

    savedItems.push({
      id: itemId,
      productId: line.productId,
      productSnap: { name: line.productName, sku: line.sku },
      unit: line.unit,
      unitFactor: line.unitFactor,
      qty: line.qty,
      qtyBase,
      costPerUnit: line.costPerUnit,
      costBase,
      discountAmt: line.itemDiscount,
      lineTotal: lineSubtotal(line),
      lotId: incoming > 0 ? lotId : ghosts[0]?.id ?? lotId,
    });

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

  devReceivingItems.set(receivingId, savedItems);

  if (isFinalizingDraft) {
    const existing = devReceivings.find((r) => r.id === receivingId)!;
    existing.supplierId = input.supplierId;
    existing.supplierName = input.supplierName.trim() || '—';
    existing.status = 'completed';
    existing.subtotal = linesSubtotal;
    existing.discountAmt = billDiscount;
    existing.total = grandTotal;
    existing.payStatus = 'paid';
    existing.paidAmt = grandTotal;
    existing.note = input.note;
    existing.receivedAt = ts(now);
    existing.updatedAt = ts(now);
    return receivingId;
  }

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

export function getDevReceivings(branchId?: string) {
  const list = [...devReceivings];
  if (!branchId) return list;
  return list.filter((r) => r.branchId === branchId);
}

export function getDevReceivingItems(receivingId: string): ReceivingItem[] {
  return [...(devReceivingItems.get(receivingId) ?? [])];
}

export function getDevLots() {
  return [...devLots];
}

export function getDevReceivingMovements() {
  return [...devMovements];
}

export function getDevReceivingStocks() {
  return devStocks;
}

export function devUpdateReceiving(input: UpdateReceivingInput): void {
  const receiving = devReceivings.find((r) => r.id === input.receivingId);
  if (!receiving) throw new Error('ไม่พบเอกสารรับเข้า');
  if (receiving.status === 'cancelled') {
    throw new Error('ไม่สามารถแก้ไขเอกสารที่ยกเลิกแล้ว');
  }
  if (receiving.status === 'draft') {
    throw new Error('ใช้บันทึกแบบร่างหรือยืนยันรับเข้าสำหรับเอกสารแบบร่าง');
  }

  const items = devReceivingItems.get(input.receivingId) ?? [];
  const newItemIds = new Set(
    input.lines.map((l) => l.itemId).filter((id): id is string => !!id),
  );

  function adjustStock(productId: string, delta: number) {
    const stock = devStocks[productId] ?? {
      branchId: input.branchId,
      totalStockBase: 0,
      reorderPoint: 10,
      lastMovementAt: ts(),
      updatedAt: ts(),
    };
    devStocks[productId] = {
      ...stock,
      totalStockBase: stock.totalStockBase + delta,
      updatedAt: ts(),
    };
  }

  function reverseItem(item: ReceivingItem) {
    adjustStock(item.productId, -item.qtyBase);
    const lot = devLots.find((l) => l.id === item.lotId);
    if (lot) {
      lot.qtyRemaining -= item.qtyBase;
      lot.qtyReceived = Math.max(0, lot.qtyReceived - item.qtyBase);
      lot.isDepleted = lot.qtyRemaining <= 0;
    }
    const mvIdx = devMovements.findIndex(
      (m) => m.refId === input.receivingId && m.productId === item.productId,
    );
    if (mvIdx >= 0) devMovements.splice(mvIdx, 1);
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx >= 0) items.splice(idx, 1);
  }

  for (const item of [...items]) {
    if (!newItemIds.has(item.id)) reverseItem(item);
  }

  for (const line of input.lines) {
    const qtyBase = lineQtyBase(line);
    const costBase = lineCostBase(line);
    const existing = line.itemId ? items.find((i) => i.id === line.itemId) : undefined;

    if (existing && existing.productId === line.productId) {
      const delta = qtyBase - existing.qtyBase;
      adjustStock(line.productId, delta);
      const lot = devLots.find((l) => l.id === existing.lotId);
      if (lot) {
        lot.qtyRemaining += delta;
        lot.qtyReceived = Math.max(0, lot.qtyReceived + delta);
        lot.costPerUnit = costBase;
        lot.isDepleted = lot.qtyRemaining <= 0;
      }
      existing.productSnap = { name: line.productName, sku: line.sku };
      existing.unit = line.unit;
      existing.unitFactor = line.unitFactor;
      existing.qty = line.qty;
      existing.qtyBase = qtyBase;
      existing.costPerUnit = line.costPerUnit;
      existing.costBase = costBase;
      existing.discountAmt = line.itemDiscount;
      existing.lineTotal = lineSubtotal(line);
      const mv = devMovements.find(
        (m) => m.refId === input.receivingId && m.productId === existing.productId,
      );
      if (mv) {
        mv.qty = qtyBase;
        mv.costPerUnit = costBase;
        mv.note = input.note;
      }
    } else {
      if (existing) reverseItem(existing);
      const lotId = `lot-${input.receivingId}-${line.productId}-${Date.now()}`;
      devLots.push({
        id: lotId,
        productId: line.productId,
        branchId: input.branchId,
        receivingId: input.receivingId,
        costPerUnit: costBase,
        qtyReceived: qtyBase,
        qtyRemaining: qtyBase,
        receivedAt: ts(),
        expiryDate: null,
        isDepleted: qtyBase <= 0,
        isGhost: false,
        createdAt: ts(),
      });
      adjustStock(line.productId, qtyBase);
      const itemId = existing?.id ?? `item-${input.receivingId}-${line.productId}-${Date.now()}`;
      items.push({
        id: itemId,
        productId: line.productId,
        productSnap: { name: line.productName, sku: line.sku },
        unit: line.unit,
        unitFactor: line.unitFactor,
        qty: line.qty,
        qtyBase,
        costPerUnit: line.costPerUnit,
        costBase,
        discountAmt: line.itemDiscount,
        lineTotal: lineSubtotal(line),
        lotId,
      });
      devMovements.push({
        id: `mv-${input.receivingId}-${line.productId}-${Date.now()}`,
        productId: line.productId,
        branchId: input.branchId,
        type: 'receive',
        qty: qtyBase,
        costPerUnit: costBase,
        refId: input.receivingId,
        refType: 'receiving',
        note: input.note,
        createdBy: input.staffId,
        createdAt: ts(),
      });
    }
  }

  receiving.supplierId = input.supplierId;
  receiving.supplierName = input.supplierName.trim() || '—';
  receiving.note = input.note;
  receiving.subtotal = receivingSubtotal(input.lines);
  receiving.discountAmt = Math.max(0, input.finalDiscount || 0);
  receiving.total = receivingGrandTotal(input.lines, receiving.discountAmt);
  receiving.paidAmt = receiving.total;
  receiving.updatedAt = ts();
  devReceivingItems.set(input.receivingId, items);
}

export function devSaveReceivingDraft(input: SaveReceivingDraftInput): string {
  const receivingId = input.receivingId ?? allocateDevReceivingNumber();
  const now = new Date();
  const linesSubtotal = receivingSubtotal(input.lines);
  const billDiscount = Math.max(0, input.finalDiscount || 0);
  const grandTotal = receivingGrandTotal(input.lines, billDiscount);

  const savedItems: ReceivingItem[] = input.lines.map((line, index) => {
    const qtyBase = lineQtyBase(line);
    const costBase = lineCostBase(line);
    return {
      id: line.itemId ?? `item-${receivingId}-${line.productId}-${index}`,
      productId: line.productId,
      productSnap: { name: line.productName, sku: line.sku },
      unit: line.unit,
      unitFactor: line.unitFactor,
      qty: line.qty,
      qtyBase,
      costPerUnit: line.costPerUnit,
      costBase,
      discountAmt: line.itemDiscount,
      lineTotal: lineSubtotal(line),
      lotId: DRAFT_LOT_ID,
    };
  });

  devReceivingItems.set(receivingId, savedItems);

  if (input.receivingId) {
    const existing = devReceivings.find((r) => r.id === receivingId);
    if (!existing) throw new Error('ไม่พบเอกสารรับเข้า');
    if (existing.branchId !== input.branchId) {
      throw new Error('เอกสารนี้ไม่ใช่ของสาขาปัจจุบัน');
    }
    if (existing.status !== 'draft') {
      throw new Error('เอกสารนี้ไม่ใช่แบบร่าง');
    }
    existing.supplierId = input.supplierId;
    existing.supplierName = input.supplierName.trim() || '—';
    existing.subtotal = linesSubtotal;
    existing.discountAmt = billDiscount;
    existing.total = grandTotal;
    existing.paidAmt = 0;
    existing.payStatus = 'pending';
    existing.note = input.note;
    existing.updatedAt = ts(now);
    return receivingId;
  }

  devReceivings.push({
    id: receivingId,
    branchId: input.branchId,
    supplierId: input.supplierId,
    supplierName: input.supplierName.trim() || '—',
    staffId: input.staffId,
    status: 'draft',
    subtotal: linesSubtotal,
    discountAmt: billDiscount,
    vatRate: 0,
    vatAmt: 0,
    total: grandTotal,
    payStatus: 'pending',
    paidAmt: 0,
    note: input.note,
    receivedAt: ts(now),
    createdAt: ts(now),
    updatedAt: ts(now),
  });

  return receivingId;
}

export function devCancelReceiving(input: CancelReceivingInput): void {
  const reason = input.reason.trim();
  if (!reason) throw new Error('กรุณาระบุเหตุผลการยกเลิก');

  const receiving = devReceivings.find((r) => r.id === input.receivingId);
  if (!receiving) throw new Error('ไม่พบเอกสารรับเข้า');
  if (receiving.branchId !== input.branchId) {
    throw new Error('เอกสารนี้ไม่ใช่ของสาขาปัจจุบัน');
  }
  if (receiving.status === 'cancelled') {
    throw new Error('เอกสารนี้ถูกยกเลิกแล้ว');
  }

  const items = devReceivingItems.get(input.receivingId) ?? [];
  const voidNote = input.note?.trim() ? `${reason} — ${input.note.trim()}` : reason;

  function adjustStock(productId: string, delta: number) {
    const stock = devStocks[productId] ?? {
      branchId: input.branchId,
      totalStockBase: 0,
      reorderPoint: 10,
      lastMovementAt: ts(),
      updatedAt: ts(),
    };
    devStocks[productId] = {
      ...stock,
      totalStockBase: stock.totalStockBase + delta,
      updatedAt: ts(),
    };
  }

  for (const item of items) {
    adjustStock(item.productId, -item.qtyBase);
    const lot = devLots.find((l) => l.id === item.lotId);
    if (lot) {
      lot.qtyRemaining -= item.qtyBase;
      lot.qtyReceived = Math.max(0, lot.qtyReceived - item.qtyBase);
      lot.isDepleted = lot.qtyRemaining <= 0;
    }
    const mvIdx = devMovements.findIndex(
      (m) =>
        m.refId === input.receivingId &&
        m.productId === item.productId &&
        m.type === 'receive',
    );
    if (mvIdx >= 0) devMovements.splice(mvIdx, 1);
    devMovements.push({
      id: `mv-void-${input.receivingId}-${item.productId}-${Date.now()}`,
      productId: item.productId,
      branchId: input.branchId,
      type: 'void',
      qty: item.qtyBase,
      costPerUnit: item.costBase,
      refId: input.receivingId,
      refType: 'receiving',
      note: voidNote,
      createdBy: input.staffId,
      createdAt: ts(),
    });
  }

  receiving.status = 'cancelled';
  receiving.note = [receiving.note, `ยกเลิก: ${voidNote}`].filter(Boolean).join(' · ');
  receiving.updatedAt = ts();
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
