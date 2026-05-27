import type { ProductStock, StockMovement } from '../types';
import { getDevProductList } from '../productCrud/devMock';
import {
  computeLineImpact,
  computeTotalValueImpact,
  generateAdjId,
  newStock,
  type ConfirmInventoryAdjustmentInput,
  type InventoryAdjustment,
  type InventoryAdjustmentItem,
} from './types';

function ts(d = new Date()): InventoryAdjustment['createdAt'] {
  return { toDate: () => d } as InventoryAdjustment['createdAt'];
}

const devAdjustments: InventoryAdjustment[] = [];
const devAdjustmentItems: Record<string, InventoryAdjustmentItem[]> = {};
let devStocks: Record<string, ProductStock> = {};
let devMovements: StockMovement[] = [];

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

export function devConfirmInventoryAdjustment(input: ConfirmInventoryAdjustmentInput): string {
  initStocks(input.branchId);

  const adjustmentId = generateAdjId();
  const now = new Date();
  const items: InventoryAdjustmentItem[] = [];

  for (const line of input.lines) {
    const product = getDevProductList(input.branchId).find((p) => p.id === line.productId);
    const avgCost = product?.avgCost ?? 0;
    const { unitCost, valueImpact } = computeLineImpact(line.adjustQty, avgCost);
    const stock = devStocks[line.productId];

    items.push({
      productId: line.productId,
      productName: line.name,
      sku: line.sku,
      currentStock: line.currentStock,
      adjustQty: line.adjustQty,
      newStock: newStock(line),
      unitCost,
      valueImpact,
    });

    if (stock) {
      stock.totalStockBase += line.adjustQty;
      stock.lastMovementAt = ts(now);
      stock.updatedAt = ts(now);
    }

    devMovements.push({
      id: `mov-${Date.now()}-${line.productId}`,
      productId: line.productId,
      branchId: input.branchId,
      type: 'adjust',
      qty: line.adjustQty,
      costPerUnit: unitCost,
      refId: adjustmentId,
      refType: 'inventoryAdjustment',
      note: input.reason,
      createdBy: input.staffId,
      createdAt: ts(now),
    });
  }

  const totalValueImpact = computeTotalValueImpact(items);

  const doc: InventoryAdjustment = {
    id: adjustmentId,
    branchId: input.branchId,
    adjustDate: input.adjustDate,
    reason: input.reason,
    note: input.note,
    staffId: input.staffId,
    staffName: input.staffName,
    itemCount: items.length,
    totalValueImpact,
    status: 'completed',
    createdAt: ts(now),
  };

  devAdjustments.unshift(doc);
  devAdjustmentItems[adjustmentId] = items;

  return adjustmentId;
}

export function devGetAdjustments(branchId: string): InventoryAdjustment[] {
  return devAdjustments.filter((a) => a.branchId === branchId);
}

export function devResetInventoryMock(): void {
  devAdjustments.length = 0;
  Object.keys(devAdjustmentItems).forEach((k) => delete devAdjustmentItems[k]);
  devStocks = {};
  devMovements = [];
}
