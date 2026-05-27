import type { ProductStock, StockMovement } from '../types';
import { getDevProductList } from '../productCrud/devMock';
import {
  generateTransferId,
  type BranchTransferForm,
  type BranchTransferLineInput,
  type InventoryTransfer,
  type InventoryTransferItem,
} from './transferTypes';

function ts(d = new Date()): InventoryTransfer['createdAt'] {
  return { toDate: () => d } as InventoryTransfer['createdAt'];
}

const devTransfers: InventoryTransfer[] = [];
const devTransferItems: Record<string, InventoryTransferItem[]> = {};
const devBranchStocks: Record<string, Record<string, ProductStock>> = {};
let devMovements: StockMovement[] = [];

function initBranchStocks(branchId: string) {
  if (!devBranchStocks[branchId]) devBranchStocks[branchId] = {};
  for (const p of getDevProductList(branchId)) {
    if (!devBranchStocks[branchId][p.id]) {
      devBranchStocks[branchId][p.id] = {
        branchId,
        totalStockBase: p.stock,
        reorderPoint: p.branchReorderPoint,
        lastMovementAt: ts(),
        updatedAt: ts(),
      };
    }
  }
}

function getStock(branchId: string, productId: string): ProductStock {
  initBranchStocks(branchId);
  return (
    devBranchStocks[branchId][productId] ?? {
      branchId,
      totalStockBase: 0,
      reorderPoint: 10,
      lastMovementAt: ts(),
      updatedAt: ts(),
    }
  );
}

export function devConfirmBranchTransfer(
  form: BranchTransferForm,
  items: BranchTransferLineInput[],
): string {
  initBranchStocks(form.fromBranchId);
  initBranchStocks(form.toBranchId);

  const transferId = generateTransferId();
  const now = new Date();
  const savedItems: InventoryTransferItem[] = [];

  for (const line of items) {
    const product = getDevProductList(form.fromBranchId).find((p) => p.id === line.productId);
    const unitCost = product?.avgCost ?? 0;
    const source = getStock(form.fromBranchId, line.productId);

    if (line.transferQty > source.totalStockBase) {
      throw new Error(`สต็อกไม่เพียงพอ: ${line.name}`);
    }

    source.totalStockBase -= line.transferQty;
    source.updatedAt = ts(now);
    source.lastMovementAt = ts(now);
    devBranchStocks[form.fromBranchId][line.productId] = source;

    const dest = getStock(form.toBranchId, line.productId);
    dest.totalStockBase += line.transferQty;
    dest.updatedAt = ts(now);
    dest.lastMovementAt = ts(now);
    devBranchStocks[form.toBranchId][line.productId] = dest;

    savedItems.push({
      productId: line.productId,
      productName: line.name,
      sku: line.sku,
      sourceStock: line.sourceStock,
      transferQty: line.transferQty,
      unitCost,
    });

    devMovements.push({
      id: `mov-out-${Date.now()}-${line.productId}`,
      productId: line.productId,
      branchId: form.fromBranchId,
      type: 'transfer_out',
      qty: -line.transferQty,
      costPerUnit: unitCost,
      refId: transferId,
      refType: 'inventoryTransfer',
      note: form.note,
      createdBy: form.staffId,
      createdAt: ts(now),
    });

    devMovements.push({
      id: `mov-in-${Date.now()}-${line.productId}`,
      productId: line.productId,
      branchId: form.toBranchId,
      type: 'transfer_in',
      qty: line.transferQty,
      costPerUnit: unitCost,
      refId: transferId,
      refType: 'inventoryTransfer',
      note: form.note,
      createdBy: form.staffId,
      createdAt: ts(now),
    });
  }

  const doc: InventoryTransfer = {
    id: transferId,
    transferDate: form.transferDate,
    fromBranchId: form.fromBranchId,
    toBranchId: form.toBranchId,
    note: form.note,
    staffId: form.staffId,
    staffName: form.staffName,
    itemCount: savedItems.length,
    status: 'completed',
    createdAt: ts(now),
  };

  devTransfers.unshift(doc);
  devTransferItems[transferId] = savedItems;

  return transferId;
}

export function devGetTransfers(branchId: string): InventoryTransfer[] {
  return devTransfers.filter(
    (t) => t.fromBranchId === branchId || t.toBranchId === branchId,
  );
}
