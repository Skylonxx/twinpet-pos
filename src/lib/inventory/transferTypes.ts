import type { ProductPickerItem } from '../../components/products/productPickerTypes';
import type { Timestamp } from '../types';

/** Form state line (before confirm) */
export type TransferLine = {
  lineKey: string;
  productId: string;
  name: string;
  sku: string;
  sourceStock: number;
  transferQty: number;
};

/**
 * Exact FIFO cut carried from the SOURCE branch on a transfer.
 * Persisted on every transfer item so costing stays exact and a later
 * cancel/edit can restore the source branch at the original cost basis.
 */
export type TransferLotDetail = {
  /** Source lot the qty was cut from ('oversell' for an un-lotted remainder). */
  lotId: string;
  /** Exact FIFO cost per base unit carried from that source lot. */
  costPerUnit: number;
  /** Base units cut from this lot. */
  qty: number;
};

export type InventoryTransferItem = {
  productId: string;
  productName: string;
  sku: string;
  sourceStock: number;
  transferQty: number;
  /** Blended (weighted) cost of this line — derived from {@link sourceLotDetails}. */
  unitCost: number;
  /** Exact source FIFO cuts (cost + qty) — financial source of truth. */
  sourceLotDetails: TransferLotDetail[];
};

export type InventoryTransferStatus = 'completed' | 'cancelled';

export type InventoryTransfer = {
  id: string;
  transferDate: string;
  fromBranchId: string;
  toBranchId: string;
  note: string;
  staffId: string;
  staffName: string;
  itemCount: number;
  status: InventoryTransferStatus;
  createdAt: Timestamp;
  /** Cancellation metadata (set by cancelBranchTransfer). */
  cancelledBy?: string;
  cancelledByName?: string;
  cancelledAt?: Timestamp;
  cancelReason?: string;
  updatedAt?: Timestamp;
};

export type CancelBranchTransferInput = {
  transferId: string;
  staffId: string;
  staffName: string;
  reason: string;
};

export type BranchTransferForm = {
  transferDate: string;
  fromBranchId: string;
  toBranchId: string;
  note: string;
  staffId: string;
  staffName: string;
};

export type BranchTransferLineInput = {
  productId: string;
  name: string;
  sku: string;
  sourceStock: number;
  transferQty: number;
};

export function lineFromPickerForTransfer(item: ProductPickerItem): TransferLine {
  return {
    lineKey: `tr-${item.id}-${Date.now()}`,
    productId: item.id,
    name: item.name,
    sku: item.sku,
    sourceStock: item.stock,
    transferQty: 0,
  };
}

export function generateTransferId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `TR-${y}${m}${day}-${suffix}`;
}
