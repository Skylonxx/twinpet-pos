/**
 * PK-4 Sync Center — read composition only.
 * Opens nothing. Per-channel failure isolation. No mutation calls.
 */

import { createSaleIntentJournal, type SaleIntentJournal } from './saleIntentJournal';
import { listQueue } from './offlineReversalQueue';
import { createIndexedDbReversalStore, type ReversalLocalStore } from './reversalLocalStore';
import {
  createShiftCloseIntentJournal,
  type ShiftCloseIntentJournal,
} from './shiftCloseIntentStore';
import {
  createShiftOpenIntentJournal,
  type ShiftOpenIntentJournal,
} from './shiftOpenIntentStore';
import {
  readSyncOrchestratorState,
  type SyncOrchestratorState,
} from './syncOrchestrator';
import {
  SALE_INTENT_TRACKED_STATUSES,
  type ActiveSyncScope,
  type SyncCenterChannelRead,
  type SyncCenterReadResult,
} from './syncCenterModel';
import { listVoidIntents } from './voidIntentStore';
import type { SaleIntentEntry } from './saleIntentJournalTypes';
import type { ShiftCloseIntentEntry } from './shiftCloseIntentTypes';
import type { ShiftOpenIntentEntry } from './shiftOpenIntentTypes';
import { listPrivilegedEvidenceForBranch } from './privilegedEvidenceStore';
import type { PrivilegedEvidenceJournalRecordV1 } from './privilegedEvidenceTypes';
import { getCanonicalSyncContext } from './canonicalSyncContext';

export type SyncCenterReaderDeps = {
  reversalStore?: ReversalLocalStore;
  closeJournal?: Pick<ShiftCloseIntentJournal, 'listCloseIntents'>;
  openJournal?: Pick<ShiftOpenIntentJournal, 'listOpenIntents'>;
  saleJournal?: Pick<SaleIntentJournal, 'listSaleIntentsByStatus'>;
  readOrchestratorState?: () => SyncOrchestratorState;
  isOnline?: boolean;
};

function asFailed<T>(reason: unknown): SyncCenterChannelRead<T> {
  const text = reason instanceof Error ? reason.message : String(reason ?? 'unavailable');
  return { ok: false, reason: text || 'unavailable' };
}

async function isolate<T>(work: () => Promise<SyncCenterChannelRead<T>>): Promise<SyncCenterChannelRead<T>> {
  try {
    return await work();
  } catch (err) {
    return asFailed(err);
  }
}

export async function readSyncCenterSources(
  scope: ActiveSyncScope,
  deps?: SyncCenterReaderDeps,
): Promise<SyncCenterReadResult> {
  const store = deps?.reversalStore ?? createIndexedDbReversalStore();
  const closeJournal = deps?.closeJournal ?? createShiftCloseIntentJournal();
  const openJournal = deps?.openJournal ?? createShiftOpenIntentJournal();
  const saleJournal = deps?.saleJournal ?? createSaleIntentJournal();
  const readOrch = deps?.readOrchestratorState ?? readSyncOrchestratorState;

  const reversal = await isolate(async () => {
    const all = await listQueue(store);
    const rows = all.filter((intent) => intent.branchId === scope.branchId);
    return { ok: true as const, rows };
  });

  const voidIntent = await isolate(async () => {
    const all = await listVoidIntents(store);
    const rows = all.filter(
      (rec) => rec.branchId === scope.branchId && rec.deviceId === scope.deviceId,
    );
    return { ok: true as const, rows };
  });

  const shiftClose = await isolate<ShiftCloseIntentEntry>(async () => {
    const listed = await closeJournal.listCloseIntents();
    if (!listed.ok) return asFailed(listed.code);
    const rows = listed.value.filter(
      (entry) =>
        entry.branchId === scope.branchId &&
        (entry.deviceId === scope.deviceId || entry.deviceId === null),
    );
    return { ok: true as const, rows };
  });

  const shiftOpen = await isolate<ShiftOpenIntentEntry>(async () => {
    const listed = await openJournal.listOpenIntents();
    if (!listed.ok) return asFailed(listed.code);
    const rows = listed.value.filter(
      (entry) =>
        entry.branchId === scope.branchId &&
        (entry.deviceId === scope.deviceId || entry.deviceId === null),
    );
    return { ok: true as const, rows };
  });

  const saleIntent = await isolate<SaleIntentEntry>(async () => {
    const listed = await saleJournal.listSaleIntentsByStatus([...SALE_INTENT_TRACKED_STATUSES]);
    if (!listed.ok) return asFailed(listed.code);
    const rows = listed.value.filter(
      (entry) => entry.branchId === scope.branchId && entry.deviceId === scope.deviceId,
    );
    return { ok: true as const, rows };
  });

  // SEC-001 Packet E / E-2 — read-only, branch-scoped privileged-evidence
  // presentation. Fails closed (no rows) whenever the canonical mutation
  // context is unmounted, unavailable, or scoped to a different branch than
  // this read — never inferred from stale cached privileged rows. Reuses
  // the same durable store handle as the other channels above; no second
  // durable-store open site is introduced.
  //
  // RC-E2-002 — `listPrivilegedEvidenceForBranch` reports `unreadableCount`
  // for any parser-invalid row it could not enumerate. A caller cannot tell
  // which row (or which target) an unreadable row belonged to, so any
  // `unreadableCount > 0` must fail the whole privileged read closed rather
  // than present the readable rows as a complete, healthy set — mirroring
  // D-3's `probeOpenPrivilegedRowForTargetInTxn` fail-closed contract.
  const privilegedEvidence = await isolate<PrivilegedEvidenceJournalRecordV1>(async () => {
    const canonical = getCanonicalSyncContext();
    if (!canonical || canonical.branchId !== scope.branchId) {
      return asFailed('canonical_sync_context_unavailable');
    }
    const { rows, unreadableCount } = await listPrivilegedEvidenceForBranch(store, scope.branchId);
    if (unreadableCount > 0) {
      return asFailed('privileged_evidence_unreadable');
    }
    return { ok: true as const, rows };
  });

  let lastCycle: SyncOrchestratorState['lastCycle'] = null;
  let webLocksAvailable = false;
  let ch4AttemptExhaustedIds: string[] = [];
  try {
    const orch = readOrch();
    lastCycle = orch.lastCycle;
    webLocksAvailable = orch.webLocksAvailable;
    ch4AttemptExhaustedIds = orch.ch4AttemptExhaustedIds;
  } catch {
    lastCycle = null;
    webLocksAvailable = false;
    ch4AttemptExhaustedIds = [];
  }

  return {
    scope,
    reversal,
    voidIntent,
    shiftClose,
    shiftOpen,
    saleIntent,
    orchestrator: {
      lastCycle,
      webLocksAvailable,
      ch4AttemptExhaustedIds,
    },
    isOnline: deps?.isOnline ?? (typeof navigator !== 'undefined' ? navigator.onLine !== false : true),
    privilegedEvidence,
  };
}
