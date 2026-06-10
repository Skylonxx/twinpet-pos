/**
 * Manual Review Operations — UI-facing pure helpers  [Phase 7B-H3]
 *
 * The security-relevant glue for the local Manual Review Operations page lives HERE,
 * dependency-free and node-unit-testable (the repo has no DOM test harness). The page
 * is a thin Flowbite shell over these functions:
 *
 *   - `canViewManualReviewOps` — the authority gate (Manager/Admin only). It DELEGATES
 *     to the canonical H2 rule (`isOfflineReversalAuthoritySupported`) so the UI gate
 *     can never drift from the authority the H2 `resolveManualReview` helper itself
 *     enforces. Standard Staff are excluded — they neither see nor execute the action.
 *   - `buildManualReviewResolvePayload` — maps the actor + form into the exact
 *     `ManualReviewResolveInput` the H2 helper expects, enforcing required `reasonCode`
 *     and re-checking authority (defense-in-depth) before any resolve call is made.
 *
 * SCOPE NOTE: the page reads ONLY the local/offline IndexedDB reversal queue via the
 * existing `listQueue` abstraction — it is device-local, NOT a global Firestore/cross-
 * device dashboard, and performs NO stock mutation and NO Firestore reconciliation
 * (that remains an external manual admin process).
 */

import { isOfflineReversalAuthoritySupported, type ManualReviewResolveInput } from './offlineReversalLogic';
import type { ReversalActorRole } from './offlineReversalTypes';

/**
 * Whether a role may view AND execute manual-review resolution. Manager/Admin only —
 * delegates to the canonical H2 authority rule so the two can never diverge. Staff,
 * unknown, or absent roles → `false` (the page renders a not-authorized state and the
 * resolve action is never offered).
 */
export function canViewManualReviewOps(role: string | null | undefined): boolean {
  return role != null && isOfflineReversalAuthoritySupported(role as ReversalActorRole);
}

/** The two operator-supplied form fields for a resolution. */
export type ManualReviewResolveFormValues = {
  reasonCode: string;
  note?: string;
};

/** Discriminated result of mapping the form to the H2 payload. */
export type BuildResolvePayloadResult =
  | { ok: true; input: ManualReviewResolveInput }
  | { ok: false; error: 'unauthorized' | 'missing_reason' };

/**
 * Map the acting user + form into the exact `ManualReviewResolveInput` for the H2
 * `resolveManualReview` helper. Blocks submission (returns `ok: false`) when the actor
 * is not Manager/Admin (or has no id) or when `reasonCode` is blank. `note` is included
 * only when non-blank. This never mutates stock and never queries Firestore.
 */
export function buildManualReviewResolvePayload(
  actor: { id: string | null | undefined; role: string | null | undefined },
  form: ManualReviewResolveFormValues,
): BuildResolvePayloadResult {
  if (!canViewManualReviewOps(actor.role) || !actor.id) {
    return { ok: false, error: 'unauthorized' };
  }
  const reasonCode = form.reasonCode.trim();
  if (reasonCode.length === 0) {
    return { ok: false, error: 'missing_reason' };
  }
  const note = form.note?.trim();
  return {
    ok: true,
    input: {
      resolvedByStaffId: actor.id,
      resolvedByRole: actor.role as ReversalActorRole,
      reasonCode,
      ...(note ? { note } : {}),
    },
  };
}
