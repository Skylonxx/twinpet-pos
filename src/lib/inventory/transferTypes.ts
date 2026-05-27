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

export type InventoryTransferItem = {
  productId: string;
  productName: string;
  sku: string;
  sourceStock: number;
  transferQty: number;
  unitCost: number;
};

export type InventoryTransfer = {
  id: string;
  transferDate: string;
  fromBranchId: string;
  toBranchId: string;
  note: string;
  staffId: string;
  staffName: string;
  itemCount: number;
  status: 'completed';
  createdAt: Timestamp;
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
