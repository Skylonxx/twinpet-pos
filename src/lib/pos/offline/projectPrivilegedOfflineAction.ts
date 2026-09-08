/**
 * SEC-001 Packet D / D-3 — Machine Seam Projection.
 *
 * Controlling authority: `TWINPET-TRUE-STANDALONE-SEC-001-PACKET-D-D3-ARCHITECTURE-ADJUDICATION-GEMINI-013`,
 * hardened by `TWINPET-TRUE-STANDALONE-SEC-001-PACKET-D-D3-CODEX-RC-ADJUDICATION-GEMINI-014`.
 *
 * GD-D3-001 OPTION A — the sole production owner of the
 * `requestOfflineAttestation -> binding verify -> ingestAttestedPrivilegedAction`
 * sequence. No caller (Packet E included) may retain or re-ingest the signed
 * envelope; it lives only in this function's stack frame.
 *
 * RC-D3-001 — the production export is exactly one argument. It closes over
 * the real canonical-sync-context source, the real durable-store factory,
 * the real D-1B `requestOfflineAttestation`, and the real D-2
 * `ingestAttestedPrivilegedAction`. There is no public runtime
 * authority/durability override surface: a production caller cannot
 * substitute an in-memory store, a fake canonical context, a fake D-1B
 * attestation, or a fake D-2 ingest. Tests control these dependencies via
 * `vi.mock`/module-level test seams local to the test file (see
 * `projectPrivilegedOfflineAction.test.ts`), never through the exported
 * production signature.
 *
 * `projected` means only: signed evidence is durably captured in D-2 and
 * pending adjudication. This module never decides a server verdict, never
 * reports a completed void, and never writes any local void/business state
 * (GD-D3-004 — no orchestrator nudge either).
 */

import { getCanonicalSyncContext } from './canonicalSyncContext';
import { createIndexedDbReversalStore, type ReversalLocalStore } from './reversalLocalStore';
import {
  ingestAttestedPrivilegedAction,
  listPrivilegedEvidenceForBranch,
  type IngestContext,
} from './privilegedEvidenceStore';
import type { PrivilegedEvidenceJournalRecordV1 } from './privilegedEvidenceTypes';
import {
  requestOfflineAttestation,
  type OfflineAttestationEnvelope,
} from '../../auth/privilegedAction/offlineAttestation';
import type { PrivilegedActionId } from '../../auth/privilegedAction/privilegedActionTypes';

export interface ProjectPrivilegedOfflineActionInput {
  actionId: PrivilegedActionId;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  managerStaffId: string;
  pin: string;
  localIntentId: string;
  initiatingStaffId: string;
}

export type ProjectPrivilegedOfflineActionOutcome =
  | { kind: 'projected'; record: PrivilegedEvidenceJournalRecordV1 }
  | { kind: 'already_projected'; record: PrivilegedEvidenceJournalRecordV1 }
  | { kind: 'duplicate_target' }
  | { kind: 'not_approved'; errorCode: string | null }
  | { kind: 'unavailable' }
  | { kind: 'integrity_conflict' }
  | { kind: 'durable_unavailable' }
  | { kind: 'uncertain' };

/** S1 — the same open-status set D-2's atomic exclusion enforces. `SERVER_REJECTED` does not block. */
const OPEN_TARGET_STATUSES = new Set<PrivilegedEvidenceJournalRecordV1['syncStatus']>([
  'PRIVILEGED_INTENT_QUEUED',
  'SYNCING',
  'SERVER_ACCEPTED',
  'MANUAL_ATTENTION',
]);

function mapIngestOutcome(
  outcome: Awaited<ReturnType<typeof ingestAttestedPrivilegedAction>>,
): ProjectPrivilegedOfflineActionOutcome {
  switch (outcome.kind) {
    case 'created':
      return { kind: 'projected', record: outcome.record };
    case 'idempotent_noop':
      return { kind: 'already_projected', record: outcome.record };
    case 'duplicate_target':
    case 'legacy_conflict':
      return { kind: 'duplicate_target' };
    case 'binding_conflict':
    case 'unreadable':
      return { kind: 'integrity_conflict' };
    case 'not_approved_local':
      return { kind: 'not_approved', errorCode: null };
  }
}

/**
 * Section 6 — bounded same-envelope local ingest uncertainty. At most one
 * retry, same envelope bytes / adjudicationId / binding, never a second
 * attestation. A second rejection/throw resolves to `uncertain` (never
 * success). If the first attempt actually landed durably despite throwing,
 * the retry's own identical-bytes ingest converges to `idempotent_noop`
 * (mapped to `already_projected`) via D-2's own idempotency check.
 */
async function ingestWithBoundedRetry(
  store: ReversalLocalStore,
  envelope: OfflineAttestationEnvelope,
  ctx: IngestContext,
  nowMs: number,
): Promise<ProjectPrivilegedOfflineActionOutcome> {
  try {
    const outcome = await ingestAttestedPrivilegedAction(store, envelope, ctx, nowMs);
    return mapIngestOutcome(outcome);
  } catch {
    try {
      const retryOutcome = await ingestAttestedPrivilegedAction(store, envelope, ctx, nowMs);
      return mapIngestOutcome(retryOutcome);
    } catch {
      return { kind: 'uncertain' };
    }
  }
}

/**
 * S0 -> S1 -> S2 -> S3 -> S4 -> S5, in that exact authority order. See file
 * header and the controlling D-3 implementation prompt for the full
 * contract. RC-D3-001: exactly one argument — no runtime authority/
 * durability override parameter.
 */
export async function projectPrivilegedOfflineAction(
  input: ProjectPrivilegedOfflineActionInput,
): Promise<ProjectPrivilegedOfflineActionOutcome> {
  const store = createIndexedDbReversalStore();
  const nowMs = Date.now();

  // S0 — canonical sync context. The caller never supplies branchId/deviceId.
  const canonicalCtx = getCanonicalSyncContext();
  if (!canonicalCtx) return { kind: 'unavailable' };
  const { branchId, deviceId } = canonicalCtx;

  // S1 — cheap pre-guard. Only a read; never mints approval evidence.
  let branchEvidence: Awaited<ReturnType<typeof listPrivilegedEvidenceForBranch>>;
  try {
    branchEvidence = await listPrivilegedEvidenceForBranch(store, branchId);
  } catch {
    return { kind: 'durable_unavailable' };
  }
  // RC-D3-002 — an unreadable/corrupted privileged row anywhere in the store
  // must never be silently treated as "no conflicting privileged state".
  // Fail closed before any attestation is minted.
  if (branchEvidence.unreadableCount > 0) return { kind: 'integrity_conflict' };
  const preGuardConflict = branchEvidence.rows.some(
    (row) => row.targetOrderId === input.targetOrderId && OPEN_TARGET_STATUSES.has(row.syncStatus),
  );
  if (preGuardConflict) return { kind: 'duplicate_target' };

  // S2 — D-1B attestation. D-1B owns every approval/security validation.
  const attestationResult = await requestOfflineAttestation({
    managerStaffId: input.managerStaffId,
    actionId: input.actionId,
    targetOrderId: input.targetOrderId,
    targetOrderUtc7Date: input.targetOrderUtc7Date,
    localIntentId: input.localIntentId,
    pin: input.pin,
  });
  if (!attestationResult.ok) {
    return { kind: 'not_approved', errorCode: attestationResult.errorCode };
  }
  const envelope = attestationResult.attestation;

  // S3 — synchronous binding verification. Verify only, never rewrite.
  const bindingOk =
    envelope.verifiedBranchId === branchId &&
    envelope.actionId === input.actionId &&
    envelope.targetOrderId === input.targetOrderId &&
    envelope.localIntentId === input.localIntentId &&
    envelope.evidenceSeed.approvalResult === 'APPROVED_LOCAL';
  if (!bindingOk) {
    // Discard the returned material in-memory: no ingest, no repair, no rewrite.
    return { kind: 'integrity_conflict' };
  }

  // S4 — durable D-2 ingest, with the atomic target-level exclusion enabled.
  const ingestCtx: IngestContext = {
    ingestStaffId: input.initiatingStaffId,
    ingestDeviceId: deviceId,
    expectNoOpenRowForTarget: true,
  };
  // S5 — return. No orchestrator nudge, no Firestore write, no local void
  // write, no UI behavior: this function performs none of those and calls
  // nothing that does.
  return ingestWithBoundedRetry(store, envelope, ingestCtx, nowMs);
}
