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
import type { DiscardUnreadablePrivilegedEvidenceInput } from './privilegedEvidenceStore';

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

// ─── SEC-001 N3 Phase 2 — unreadable privileged-evidence discard request ─────

/** The two operator-supplied form fields for an unreadable-row discard. */
export type UnreadableEvidenceDiscardFormValues = {
  reasonCode: string;
  note?: string;
};

/** The device's canonical acting scope, as the page resolved it. Never guessed. */
export type UnreadableEvidenceDiscardScope = {
  branchId: string | null | undefined;
  deviceId: string | null | undefined;
};

/** Discriminated result of mapping the actor + scope + form to the store input. */
export type BuildUnreadableEvidenceDiscardResult =
  | { ok: true; input: DiscardUnreadablePrivilegedEvidenceInput }
  | { ok: false; error: 'unauthorized' | 'missing_reason' | 'scope_unavailable' };

/**
 * Map the acting Manager/Admin + canonical scope + form into the exact input the
 * D-2 discard mutator expects — the same shape/role the H2 resolve payload
 * builder has, for the same reason: the page must not be the only thing standing
 * between an operator and a destructive call.
 *
 * It re-checks authority (defense in depth; the store re-checks again), requires
 * a non-blank `reasonCode`, and requires a real branch/device scope — an Admin
 * viewing all branches has none, and a guessed branch must never reach an audit
 * record. `key` is carried through as the opaque, untrusted storage handle the
 * Phase 1 diagnostic reported; this builder never parses, classifies, inspects,
 * or normalizes raw evidence, and performs no mutation of any kind.
 */
export function buildUnreadableEvidenceDiscardRequest(
  actor: { id: string | null | undefined; role: string | null | undefined },
  target: { key: string },
  scope: UnreadableEvidenceDiscardScope | null,
  form: UnreadableEvidenceDiscardFormValues,
  nowMs: number,
): BuildUnreadableEvidenceDiscardResult {
  if (!canViewManualReviewOps(actor.role) || !actor.id) {
    return { ok: false, error: 'unauthorized' };
  }
  const reasonCode = form.reasonCode.trim();
  if (reasonCode.length === 0) {
    return { ok: false, error: 'missing_reason' };
  }
  const branchId = scope?.branchId?.trim();
  const deviceId = scope?.deviceId?.trim();
  if (!branchId || !deviceId) {
    return { ok: false, error: 'scope_unavailable' };
  }
  const note = form.note?.trim();
  return {
    ok: true,
    input: {
      key: target.key,
      actorStaffId: actor.id,
      actorRole: actor.role as ReversalActorRole,
      branchId,
      deviceId,
      reasonCode,
      ...(note ? { note } : {}),
      nowMs,
    },
  };
}
