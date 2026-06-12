/**
 * Catch-site → durable rejection log bridge  [Phase 7B-H7-E]
 *
 * The single, fully-guarded entry point a UI catch site uses to record a pre-queue
 * fail-closed reversal-evidence rejection (`Transfer/ReceivingReversalEvidenceError`)
 * into the latent H7-C durable log. It builds the H7-A `ReversalRejectionRecord` and
 * fire-and-forgets the best-effort `recordReversalRejection` write.
 *
 * CONTRACT (non-negotiable — this is the first production caller of the log):
 *   - Returns `void` (NOT a Promise) so a catch site can never `await` it and there is
 *     no floating promise to leave unhandled.
 *   - NEVER throws into the caller: BOTH the H7-A builder (which validates fail-closed
 *     and can throw) AND the async log dispatch are guarded. A failure is swallowed.
 *   - The async log promise carries its own `.catch(() => {})` — no unhandled rejection.
 *   - Forensic only: builds via `buildReversalRejectionRecord`, writes via
 *     `recordReversalRejection` (which touches only the `rejections` store). It does not
 *     mutate stock/ledger/intents/markers, change schema, or read queue state.
 *   - `evidenceSource` is omitted — it is not resolved at the throw point.
 *
 * Callers MUST compute and surface/throw the operator-visible F1/G1 message BEFORE
 * calling this helper; logging is a side effect that cannot block or alter that UX.
 */

import type { ReversalLocalStore } from './reversalLocalStore';
import { recordReversalRejection } from './reversalRejectionLog';
import {
  buildReversalRejectionRecord,
  type ReversalRejectionSourceType,
} from '../../inventory/reversalRejectionRecord';

export interface EvidenceRejectionInput {
  sourceType: ReversalRejectionSourceType;
  sourceId: string;
  branchId: string;
  evidenceCode: string;
  evidenceMessage: string;
  staffId?: string | null;
  observedDocumentUpdatedAt?: string | null;
  /** Injectable clock for deterministic tests; defaults to the current time (ISO 8601). */
  now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

/**
 * Best-effort, fire-and-forget durable logging of an evidence rejection. Synchronous,
 * returns `void`, and never throws — see the module contract above.
 */
export function recordEvidenceRejection(store: ReversalLocalStore, input: EvidenceRejectionInput): void {
  try {
    const record = buildReversalRejectionRecord({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      branchId: input.branchId,
      evidenceCode: input.evidenceCode,
      evidenceMessage: input.evidenceMessage,
      staffId: input.staffId,
      observedDocumentUpdatedAt: input.observedDocumentUpdatedAt,
      // evidenceSource intentionally omitted — not resolved at the catch site.
      createdAt: (input.now ?? defaultNow)(),
    });

    void recordReversalRejection(store, record).catch(() => {
      // best-effort only — the durable log never affects the fail-closed UX.
    });
  } catch {
    // best-effort only — a build/validation failure must never escape into the catch site.
  }
}
