/**
 * SEC-001 Packet E / E-1 — D-2 active-row precheck / restart recovery.
 *
 * Controlling authority: `TWINPET-TRUE-STANDALONE-SEC-001-PACKET-E-ARCHITECTURE-ADJUDICATION-GEMINI-017`.
 *
 * Read-only classification over the landed D-2 durable journal
 * (`listPrivilegedEvidenceForBranch`). No raw D-2 mutation happens here —
 * this module never calls `ingestAttestedPrivilegedAction`,
 * `claimPrivilegedEvidenceRow`, or `applyPrivilegedEvidenceDisposition`.
 *
 * RC-D3-002-equivalent for E-1: `unreadableCount > 0` anywhere in the branch
 * fails the WHOLE branch closed (`integrity_fault`) — a corrupted/unreadable
 * row elsewhere in the store must never be silently treated as "this one
 * target is clear".
 *
 * `OPEN_TARGET_STATUSES` mirrors the same four-member set
 * `projectPrivilegedOfflineAction.ts` uses for its own S1 pre-guard
 * (`PRIVILEGED_INTENT_QUEUED`, `SYNCING`, `SERVER_ACCEPTED`,
 * `MANUAL_ATTENTION`) — a row in one of those statuses is "active": it
 * blocks a fresh approval and surfaces as a read-only recovered/terminal
 * state instead of manager-approval controls (Section 7). `SERVER_REJECTED`
 * never blocks a fresh attempt, matching D-3's own pre-guard, but is still
 * classified (`terminal_rejected`) so a flow that is actively watching this
 * exact target (e.g. reconciling a `duplicate_target` race) can render the
 * true outcome instead of silently discarding it.
 */

import { listPrivilegedEvidenceForBranch } from '../offline/privilegedEvidenceStore';
import type { ReversalLocalStore } from '../offline/reversalLocalStore';
import type {
  PrivilegedEvidenceD2SyncStatus,
  PrivilegedEvidenceJournalRecordV1,
} from '../offline/privilegedEvidenceTypes';
import type { PrivilegedManualReviewStatus, PrivilegedServerVerdict } from '../../auth/privilegedAction/privilegedActionTypes';

export type ActiveRowClassification =
  | 'active_open'
  | 'terminal_accepted'
  | 'terminal_rejected'
  | 'manual_attention';

/** Safe, display-only projection — never carries PAA1/SSA1/OAC bytes, digests, or nonces (Section 14). */
export interface SafeActiveRowSummary {
  targetOrderId: string;
  classification: ActiveRowClassification;
  syncStatus: PrivilegedEvidenceD2SyncStatus;
  manualReviewStatus: PrivilegedManualReviewStatus;
  serverVerdict: PrivilegedServerVerdict | null;
  updatedAtMs: number;
}

export type ActiveRowPrecheckOutcome =
  | { kind: 'integrity_fault' }
  | { kind: 'clear' }
  | { kind: 'active_open'; row: SafeActiveRowSummary }
  | { kind: 'terminal_accepted'; row: SafeActiveRowSummary }
  | { kind: 'terminal_rejected'; row: SafeActiveRowSummary }
  | { kind: 'manual_attention'; row: SafeActiveRowSummary };

/** Blocks a fresh approval for the same target (mirrors D-3's S1 pre-guard exactly). */
const BLOCKING_STATUSES = new Set<PrivilegedEvidenceD2SyncStatus>([
  'PRIVILEGED_INTENT_QUEUED',
  'SYNCING',
  'SERVER_ACCEPTED',
  'MANUAL_ATTENTION',
]);

function classify(status: PrivilegedEvidenceD2SyncStatus): ActiveRowClassification {
  switch (status) {
    case 'PRIVILEGED_INTENT_QUEUED':
    case 'SYNCING':
      return 'active_open';
    case 'SERVER_ACCEPTED':
      return 'terminal_accepted';
    case 'MANUAL_ATTENTION':
      return 'manual_attention';
    case 'SERVER_REJECTED':
      return 'terminal_rejected';
  }
}

function toSafeSummary(row: PrivilegedEvidenceJournalRecordV1): SafeActiveRowSummary {
  return {
    targetOrderId: row.targetOrderId,
    classification: classify(row.syncStatus),
    syncStatus: row.syncStatus,
    manualReviewStatus: row.manualReviewStatus,
    serverVerdict: row.serverVerdict,
    updatedAtMs: row.updatedAtMs,
  };
}

/**
 * Branch-scoped target map for the whole Sales History list (read-only
 * status badges). Wrong-branch rows are excluded by
 * `listPrivilegedEvidenceForBranch`'s own `branchId` filter — this function
 * never widens that scope.
 */
export async function listActiveRowSummariesForBranch(
  store: ReversalLocalStore,
  branchId: string,
): Promise<{ rows: SafeActiveRowSummary[]; unreadableCount: number }> {
  const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, branchId);
  return { rows: rows.map(toSafeSummary), unreadableCount };
}

/**
 * Single-target precheck used both at flow-open time (Section 7) and to
 * reconcile a `duplicate_target` / `uncertain` result mid-flow. Fails the
 * whole branch closed on any unreadable row or on a durable-store read
 * failure — never treats a read exception as "no conflicting state".
 */
export async function precheckActiveRowForTarget(
  store: ReversalLocalStore,
  branchId: string,
  targetOrderId: string,
): Promise<ActiveRowPrecheckOutcome> {
  let result: { rows: SafeActiveRowSummary[]; unreadableCount: number };
  try {
    result = await listActiveRowSummariesForBranch(store, branchId);
  } catch {
    return { kind: 'integrity_fault' };
  }
  if (result.unreadableCount > 0) return { kind: 'integrity_fault' };

  const row = result.rows.find((r) => r.targetOrderId === targetOrderId);
  if (!row) return { kind: 'clear' };

  switch (row.classification) {
    case 'active_open':
      return { kind: 'active_open', row };
    case 'terminal_accepted':
      return { kind: 'terminal_accepted', row };
    case 'manual_attention':
      return { kind: 'manual_attention', row };
    case 'terminal_rejected':
      return { kind: 'terminal_rejected', row };
  }
}

/** True only for the four statuses that block a fresh approval for the same target. */
export function isBlockingActiveRowStatus(status: PrivilegedEvidenceD2SyncStatus): boolean {
  return BLOCKING_STATUSES.has(status);
}
