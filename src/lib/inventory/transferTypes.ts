import type { ProductPickerItem } from '../../components/products/productPickerTypes';
import type { Timestamp } from '../types';
import type { AdjustmentReason } from './types';

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
  /**
   * Original receipt time (ms) of the source lot — the FIFO chronology key.
   * The destination lot inherits this (NOT the transfer arrival time) so stock
   * age continues seamlessly across branches, and a cancel restores the source
   * lot at its original receipt time. Optional for backward compatibility with
   * legacy transfer items saved before chronology tracking.
   */
  receivedAtMs?: number;
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

// ──────────────────────────────────────────────────────────────────────────
// Phase 7B-2 — Origin-Controlled Discrepancy Handling
//
// When a destination branch physically receives a quantity that differs from
// what the origin shipped, it may ONLY *report* the discrepancy (metadata).
// Recording a report never mutates stock or lots. The origin branch holds sole
// authority to resolve it, and resolution flows exclusively through the existing
// Inventory Adjustment path (no new FIFO source) so inventory stays auditable.
// ──────────────────────────────────────────────────────────────────────────

export type TransferDiscrepancyStatus = 'reported' | 'resolved';

/** One product line of a destination-reported transfer discrepancy. */
export type TransferDiscrepancyLine = {
  productId: string;
  productName: string;
  sku: string;
  /** Quantity the origin shipped (from the transfer item) — base units. */
  expectedQty: number;
  /** Quantity the destination actually received — base units. */
  actualQty: number;
  /** actualQty − expectedQty (negative = short received, positive = over). */
  difference: number;
};

/**
 * A destination-reported transfer discrepancy. **METADATA ONLY** — creating one
 * never changes stock or lots. Only an origin-authorised Inventory Adjustment
 * (see `resolveTransferDiscrepancy`) may correct inventory quantities, and the
 * resolution links back here via {@link resolutionAdjustmentId} for audit.
 */
export type TransferDiscrepancy = {
  id: string;
  transferId: string;
  /** Origin branch — the SOLE authority allowed to resolve. */
  fromBranchId: string;
  /** Destination branch — the only branch allowed to report. */
  toBranchId: string;
  status: TransferDiscrepancyStatus;
  reason: string;
  lines: TransferDiscrepancyLine[];
  // Report audit (destination).
  reportedByStaffId: string;
  reportedByStaffName: string;
  reportedByBranchId: string;
  reportedAt: Timestamp;
  // Resolution audit (origin) — set only once resolved.
  resolvedByStaffId?: string;
  resolvedByStaffName?: string;
  resolvedByBranchId?: string;
  resolvedAt?: Timestamp;
  /** Inventory adjustment that resolved it (origin authority, exact link). */
  resolutionAdjustmentId?: string;
};

export type ReportTransferDiscrepancyLineInput = {
  productId: string;
  /** Quantity actually received at the destination — base units. */
  actualQty: number;
};

export type ReportTransferDiscrepancyInput = {
  transferId: string;
  /** Reporting branch — MUST equal the transfer destination (`toBranchId`). */
  branchId: string;
  staffId: string;
  staffName: string;
  reason: string;
  lines: ReportTransferDiscrepancyLineInput[];
};

export type ResolveTransferDiscrepancyInput = {
  transferId: string;
  discrepancyId: string;
  /** Resolving branch — MUST equal the transfer origin (`fromBranchId`). */
  branchId: string;
  staffId: string;
  staffName: string;
  adjustDate: string;
  /** Adjustment reason for the reconciling correction. Defaults to stock count. */
  reason?: AdjustmentReason;
};

export function generateDiscrepancyId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `DISC-${y}${m}${day}-${suffix}`;
}
