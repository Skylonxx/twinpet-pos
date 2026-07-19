// Packet 5 / P5-D-2 — source-event routing pure core. [P1 offline-sync Packet 5]
//
// Pure, deterministic: no Firestore reads/writes, no network. The one
// exception to "no Admin SDK" is the `Timestamp` class import, used only for
// `instanceof`/`.toMillis()` shape detection when comparing a relevant
// `voidedAt` field across before/after images — mirrors the same frozen
// exception documented in shiftCloseEvidenceCaptureCore.ts.
//
// This module converts a raw Firestore `onDocumentWritten` before/after pair
// on one of the four routed source collections (asyncOrders, orders,
// cashTransactions, creditPayments) into zero or more `RouteTarget`s against
// `shiftCloseCases/{shiftId}`, then decides — GIVEN an already-read case
// snapshot — whether that target no-ops, hard-anomalies, or produces an
// enqueue write-set. The I/O shell (shiftCloseSourceEvents.ts) owns every
// Firestore read/transaction; this file only ever answers "what should
// happen" from plain data.
//
// Retry/throw taxonomy (`isRetryableFirestoreError`/`describeErrorCode`) is a
// verbatim MIRROR of the frozen Codex B1 classifier in
// shiftCloseEvidenceCaptureCore.ts (P5-D-2 authorization: "reuse or mirror
// existing safe helpers... without editing files outside the allowlist" —
// mirrored here rather than imported so this 6-file packet stays
// self-contained and never touches a file outside its allowlist).

import { Timestamp } from 'firebase-admin/firestore';

// ---------------------------------------------------------------------------
// Source kinds + relevant-field schema (frozen per the P5-D-2 authorization,
// §7 — a DIFFERENT, wider field list than shiftCloseValidationManifest.ts's
// manifest-hash field set, which is a distinct frozen P5-B concept. Extra
// fields here only make the routing gate MORE willing to enqueue, never
// less — never a correctness risk for the sweep).
// ---------------------------------------------------------------------------

export type SourceKind = 'asyncOrders' | 'orders' | 'cashTransactions' | 'creditPayments';

export const SOURCE_KINDS: readonly SourceKind[] = ['asyncOrders', 'orders', 'cashTransactions', 'creditPayments'];

export type RawImage = Record<string, unknown>;

const RELEVANT_FIELDS: Record<SourceKind, readonly string[]> = {
  asyncOrders: ['shiftId', 'branchId', 'deviceId', 'status', 'voidRequested', 'voidedAt', 'reconcileStatus', 'changeAmt', 'payments'],
  orders: ['shiftId', 'branchId', 'deviceId', 'status', 'voidRequested', 'voidedAt', 'reconcileStatus'],
  cashTransactions: ['id', 'shiftId', 'branchId', 'type', 'amount'],
  creditPayments: ['id', 'shiftId', 'paymentMethod', 'amount'],
};

const MEMBERSHIP_FIELDS: Record<SourceKind, { branch: string | null; device: string | null }> = {
  asyncOrders: { branch: 'branchId', device: 'deviceId' },
  orders: { branch: 'branchId', device: 'deviceId' },
  cashTransactions: { branch: 'branchId', device: null },
  creditPayments: { branch: null, device: null },
};

// ---------------------------------------------------------------------------
// Field-level equality — used only by the relevant-field diff gate. `null`
// and `undefined` are treated as the same "absent" value. Timestamp-shaped
// values (`voidedAt`) compare by millis via `.toMillis()`/shape detection
// rather than reference/deep-object identity. Everything else (scalars,
// `payments[]`) compares via `JSON.stringify` — sufficient for a routing
// GATE (a false-positive "changed" verdict only costs one harmless extra
// enqueue; the gate never needs cryptographic canonicalization).
// ---------------------------------------------------------------------------

function normalizeForCompare(value: unknown): unknown {
  return value === undefined ? null : value;
}

function isTimestampLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && ('seconds' in value || '_seconds' in value);
}

/**
 * [RC-2 fix] Exact `(seconds, nanoseconds)` identity key — NEVER `.toMillis()`,
 * which truncates to millisecond resolution and would compare two distinct
 * Firestore Timestamps within the same millisecond as equal, silently gating
 * out a real relevant-field change (Codex RC-2). A real `Timestamp` instance
 * and a plain `{seconds,nanoseconds}`/`{_seconds,_nanoseconds}`-shaped value
 * at the identical instant produce the identical key.
 */
function timestampKey(value: unknown): string | null {
  if (value instanceof Timestamp) return `${value.seconds}.${value.nanoseconds}`;
  if (isTimestampLike(value)) {
    const seconds = value.seconds ?? value._seconds;
    const nanoseconds = value.nanoseconds ?? value._nanoseconds;
    if (typeof seconds === 'number' && typeof nanoseconds === 'number') return `${seconds}.${nanoseconds}`;
  }
  return null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  const ka = timestampKey(na);
  const kb = timestampKey(nb);
  if (ka !== null || kb !== null) return ka === kb;
  if (typeof na === 'object' || typeof nb === 'object') {
    return JSON.stringify(na) === JSON.stringify(nb);
  }
  return na === nb;
}

/** True iff any of the source kind's relevant fields differ between before/after. Pre-read gate — cheap, no Firestore involved. */
export function relevantFieldsChanged(sourceKind: SourceKind, before: RawImage, after: RawImage): boolean {
  return RELEVANT_FIELDS[sourceKind].some((field) => !valuesEqual(before[field], after[field]));
}

// ---------------------------------------------------------------------------
// Membership derivation — the (shiftId, branchId, deviceId) a single image
// side (before OR after) implies. `branchId`/`deviceId` are null when the
// source kind has no such field (creditPayments) or the raw value is
// missing/malformed — "branch unknown", never coerced into a false match.
// A missing/non-string/empty `shiftId` makes the WHOLE membership invalid —
// [FROZEN §10] fails closed to zero targets, zero scan, zero writes.
// ---------------------------------------------------------------------------

export interface NormalizedMembership {
  shiftId: string;
  branchId: string | null;
  deviceId: string | null;
}

export type MembershipResult = { ok: true; membership: NormalizedMembership } | { ok: false };

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function deriveMembership(sourceKind: SourceKind, image: RawImage): MembershipResult {
  const shiftId = asNonEmptyString(image.shiftId);
  if (shiftId === null) return { ok: false };
  const cfg = MEMBERSHIP_FIELDS[sourceKind];
  const branchId = cfg.branch !== null ? asNonEmptyString(image[cfg.branch]) : null;
  const deviceId = cfg.device !== null ? asNonEmptyString(image[cfg.device]) : null;
  return { ok: true, membership: { shiftId, branchId, deviceId } };
}

function membershipEqual(a: NormalizedMembership, b: NormalizedMembership): boolean {
  return a.shiftId === b.shiftId && a.branchId === b.branchId && a.deviceId === b.deviceId;
}

// ---------------------------------------------------------------------------
// Revision-token / sourceEventId / watermark-key derivation (§9, §7).
// `sourceEventId` embeds micros (unique per delivery); the watermark key
// omits micros (identifies the SOURCE DOC, compatible with the P5-D-1
// worker's own `{collection}:{docId}` boundary-key convention — see
// `shiftCloseValidationWorker.ts`'s `sourceBoundaryEntries`). Both carry a
// `:del` discriminator for delete events (§9 "Delete events").
// ---------------------------------------------------------------------------

/** BigInt-safe micros from a Firestore Timestamp's raw {seconds, nanoseconds} — mirrors `microsOf` in shiftCloseValidationWorker.ts. */
export function microsFromSecondsNanos(seconds: number, nanoseconds: number): string {
  return (BigInt(Math.trunc(seconds)) * 1_000_000n + BigInt(Math.floor(nanoseconds / 1000))).toString();
}

/**
 * [RC-RR1 / Candidate A] BigInt-safe micros from a CloudEvent envelope
 * `event.time` ISO-8601 string — the only revision source available for
 * deletes. NEVER routes through `Date.parse(iso) * 1000`: `Date.parse`
 * truncates any fractional-seconds component to millisecond resolution, so
 * two distinct CloudEvent times differing only below the millisecond (e.g.
 * `.000100Z` vs `.000900Z`) would collapse to an identical `revisionToken`,
 * manufacturing an artificial tie (RC-RR1). Instead, the fractional-seconds
 * substring is parsed directly and truncated (never rounded) to microsecond
 * resolution — matching Firestore's documented microsecond-accurate server
 * write-time precision, not the nanosecond headroom its `Timestamp` type
 * reserves but does not populate.
 */
export function microsFromIsoString(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!match) {
    // Fail closed exactly like the prior implementation: an unparseable
    // input yields NaN, and BigInt(NaN) throws rather than silently
    // producing a wrong revision token.
    return (BigInt(Date.parse(iso)) * 1000n).toString();
  }
  const [, wholeSecondsPart, fractionDigits, offset] = match;
  const wholeMillis = Date.parse(`${wholeSecondsPart}${offset}`);
  if (Number.isNaN(wholeMillis)) {
    return (BigInt(wholeMillis) * 1000n).toString();
  }
  const seconds = Math.floor(wholeMillis / 1000);
  const micros = (fractionDigits ?? '').padEnd(6, '0').slice(0, 6);
  const fractionalMicros = micros.length > 0 ? Number(micros) : 0;
  return (BigInt(seconds) * 1_000_000n + BigInt(fractionalMicros)).toString();
}

// ---------------------------------------------------------------------------
// Route-target generation (§6-§7).
// ---------------------------------------------------------------------------

export interface RouteTarget {
  shiftId: string;
  branchId: string | null;
  deviceId: string | null;
  sourceKind: SourceKind;
  sourceId: string;
  /** Unique per delivery: `{sourceKind}:{sourceId}[:del]:{micros}`. */
  sourceEventId: string;
  /** Identifies the source DOC (no micros): `{sourceKind}:{sourceId}[:del]` — the frozen watermark boundary key. */
  watermarkKey: string;
  /** Decimal-string micros, BigInt-safe beyond Number.MAX_SAFE_INTEGER. */
  revisionToken: string;
  /**
   * [RC-RR1 / Candidate D] CloudEvent envelope `event.id` — a globally
   * unique, platform-assigned token, stable across Eventarc redelivery of
   * the SAME event. Folded into the ledger's dedup key material ONLY (see
   * `buildLedgerEntryKey`); never into `watermarkKey`/`commitBoundaryDocKeys`,
   * which must stay exactly `{sourceKind}:{sourceId}[:del]` for compatibility
   * with the P5-D-1 worker's shared boundary-key contract.
   */
  eventId: string;
}

export interface SourceEventInput {
  sourceKind: SourceKind;
  sourceId: string;
  /** `undefined` iff the document did not exist before this write (create). */
  before: RawImage | undefined;
  /** `undefined` iff the document does not exist after this write (delete). */
  after: RawImage | undefined;
  /** Firestore `updateTime` micros of the write, as a decimal string. Required for create/update; ignored for delete. */
  updateTimeMicros: string | null;
  /** CloudEvent envelope `event.time` micros, as a decimal string. Always present; the only revision source for deletes. */
  eventTimeMicros: string;
  /** CloudEvent envelope `event.id` — always present. See `RouteTarget.eventId`. */
  eventId: string;
}

export type RoutePlanResult = { kind: 'no_targets' } | { kind: 'targets'; targets: readonly RouteTarget[] };

/**
 * Plans routing for one source-document write. Pure: given the same inputs,
 * always returns the same targets. Never touches Firestore.
 *
 * Ordering (frozen): relevant-field diff gate runs first (exits before any
 * target/case work on non-relevant churn), THEN membership is derived from
 * whichever image side(s) exist, THEN identical (shiftId, branchId,
 * deviceId) memberships across before/after are deduped to one target —
 * any other divergence (branch move, device move, shiftId move, or a
 * mixture) produces one target PER distinct membership, all sharing the
 * same `sourceEventId`/`watermarkKey`/`revisionToken` since they originate
 * from the same underlying document write.
 */
export function planSourceEventRouting(input: SourceEventInput): RoutePlanResult {
  const isDelete = input.after === undefined;
  const isCreate = input.before === undefined && input.after !== undefined;
  const isUpdate = input.before !== undefined && input.after !== undefined;

  if (!isDelete && !isCreate && !isUpdate) return { kind: 'no_targets' };

  if (isUpdate && !relevantFieldsChanged(input.sourceKind, input.before as RawImage, input.after as RawImage)) {
    return { kind: 'no_targets' };
  }

  const discriminator = isDelete ? ':del' : '';
  const revisionToken = isDelete ? input.eventTimeMicros : (input.updateTimeMicros as string);
  const sourceEventId = `${input.sourceKind}:${input.sourceId}${discriminator}:${revisionToken}`;
  const watermarkKey = `${input.sourceKind}:${input.sourceId}${discriminator}`;

  const memberships: NormalizedMembership[] = [];
  if (isCreate || isUpdate) {
    const m = deriveMembership(input.sourceKind, input.after as RawImage);
    if (m.ok) memberships.push(m.membership);
  }
  if (isDelete || isUpdate) {
    const m = deriveMembership(input.sourceKind, input.before as RawImage);
    if (m.ok) memberships.push(m.membership);
  }

  const deduped: NormalizedMembership[] = [];
  for (const m of memberships) {
    if (!deduped.some((d) => membershipEqual(d, m))) deduped.push(m);
  }

  if (deduped.length === 0) return { kind: 'no_targets' };

  const targets: RouteTarget[] = deduped.map((m) => ({
    shiftId: m.shiftId,
    branchId: m.branchId,
    deviceId: m.deviceId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceEventId,
    watermarkKey,
    revisionToken,
    eventId: input.eventId,
  }));

  return { kind: 'targets', targets };
}

// ---------------------------------------------------------------------------
// Frozen watermark rule (§9) — shared-contract-compatible with the P5-D-1
// worker's `lastObservedCommitMicros`/`commitBoundaryDocKeys` fields
// (`buildSelectionCaseUpdate` in shiftCloseValidationWorkerCore.ts). Decimal
// strings compared via BigInt — safe beyond Number.MAX_SAFE_INTEGER.
// ---------------------------------------------------------------------------

export type WatermarkDecision =
  | { kind: 'stale' }
  | { kind: 'duplicate' }
  | { kind: 'append'; nextCommitBoundaryDocKeys: readonly string[] }
  | { kind: 'advance'; nextLastObservedCommitMicros: string; nextCommitBoundaryDocKeys: readonly string[] };

export function decideWatermark(params: {
  currentLastObservedCommitMicros: string;
  currentCommitBoundaryDocKeys: readonly string[];
  revisionToken: string;
  watermarkKey: string;
}): WatermarkDecision {
  const current = BigInt(params.currentLastObservedCommitMicros || '0');
  const incoming = BigInt(params.revisionToken);
  if (incoming < current) return { kind: 'stale' };
  if (incoming === current) {
    if (params.currentCommitBoundaryDocKeys.includes(params.watermarkKey)) return { kind: 'duplicate' };
    return { kind: 'append', nextCommitBoundaryDocKeys: [...params.currentCommitBoundaryDocKeys, params.watermarkKey] };
  }
  return { kind: 'advance', nextLastObservedCommitMicros: incoming.toString(), nextCommitBoundaryDocKeys: [params.watermarkKey] };
}

// ---------------------------------------------------------------------------
// Enqueue write-set (§8) — the EXACT allowed field whitelist. `updatedAt`
// (serverTimestamp sentinel) and the `nextEligibleAtMillis` -> `nextEligibleAt`
// Timestamp conversion are added by the I/O shell, mirroring
// shiftCloseValidationWorkerCore.ts's `nextEligibleAtMillis` convention —
// this pure core never constructs a FieldValue/Timestamp write sentinel.
// ---------------------------------------------------------------------------

export interface CaseSnapshotView {
  caseVersion: number;
  sourceRevision: number;
  pendingRevalidation: boolean;
  lastObservedCommitMicros: string;
  commitBoundaryDocKeys: readonly string[];
  branchId: string | null;
  /**
   * [RC-1] The last `sourceEventId` this router durably applied to the case.
   * [RC-RR1] Retained as a redundant "most recent" mirror / observability
   * field only — no longer the authoritative dedup signal, since it is a
   * one-slot memory that cannot represent more than one tied sibling at the
   * same revision. See `recentEnqueuedSourceEventIds`.
   */
  lastEnqueuedSourceEventId: string | null;
  /**
   * [RC-RR1 / Candidate E] Bounded FIFO ledger (cap `MAX_LEDGER_SIZE`) of
   * ledger keys (`buildLedgerEntryKey(sourceEventId, eventId)`) this router
   * has durably applied. Unlike the one-slot `lastEnqueuedSourceEventId`
   * mirror, this can remember every distinct sibling tied at one revision
   * (e.g. two unrelated delete events sharing a commit), which is what
   * closes the RC-RR1 gap: a P5-D-1 sweep wholesale-replaces
   * `commitBoundaryDocKeys` from a live source scan that can never
   * re-include a deleted document, but this ledger is NOT written by the
   * worker's selection write-set (ignored by it, exactly like the scalar
   * mirror) and so survives the sweep intact. Absent on a case created
   * before this remediation — defaults to `[]` (see the I/O shell's
   * defensive read).
   */
  recentEnqueuedSourceEventIds: readonly string[];
}

export interface EnqueueWriteSet {
  caseVersion: number;
  sourceRevision: number;
  pendingRevalidation: true;
  processingState: 'queued';
  lastObservedCommitMicros: string;
  commitBoundaryDocKeys: readonly string[];
  lastEnqueuedSourceEventId: string;
  recentEnqueuedSourceEventIds: readonly string[];
  /** Present ONLY on a false -> true `pendingRevalidation` transition (§8). */
  nextEligibleAtMillis?: number;
}

/** [RC-RR1 / Candidate E] Ledger capacity — a generous, named, easily-tunable bound well above realistic same-commit fan-out (mirrors the "naturally bounded by one commit's fan-out" precedent already accepted for `commitBoundaryDocKeys`). */
export const MAX_LEDGER_SIZE = 24;

/**
 * [RC-RR1 / Candidate E] The ledger's dedup key. Folding in `eventId`
 * (in addition to the derived `sourceEventId`) distinguishes a genuine
 * Eventarc redelivery of the SAME CloudEvent (identical `sourceEventId` AND
 * identical `eventId` -> duplicate) from the residual same-derived-revision
 * identity-collision risk (identical `sourceEventId` but a DIFFERENT
 * `eventId` -> a distinct event, never wrongly deduped).
 */
export function buildLedgerEntryKey(sourceEventId: string, eventId: string): string {
  return `${sourceEventId}#${eventId}`;
}

/** FIFO-prunes the ledger to `MAX_LEDGER_SIZE` after appending `nextKey`. */
function pruneLedger(current: readonly string[], nextKey: string): string[] {
  const appended = [...current, nextKey];
  return appended.length > MAX_LEDGER_SIZE ? appended.slice(appended.length - MAX_LEDGER_SIZE) : appended;
}

export function buildEnqueueWriteSet(params: {
  caseView: CaseSnapshotView;
  watermark: Extract<WatermarkDecision, { kind: 'append' | 'advance' }>;
  sourceEventId: string;
  eventId: string;
  nowMillis: number;
}): EnqueueWriteSet {
  const wasPending = params.caseView.pendingRevalidation;
  const nextLastObservedCommitMicros =
    params.watermark.kind === 'advance' ? params.watermark.nextLastObservedCommitMicros : params.caseView.lastObservedCommitMicros;

  const write: EnqueueWriteSet = {
    caseVersion: params.caseView.caseVersion + 1,
    sourceRevision: params.caseView.sourceRevision + 1,
    pendingRevalidation: true,
    processingState: 'queued',
    lastObservedCommitMicros: nextLastObservedCommitMicros,
    commitBoundaryDocKeys: params.watermark.nextCommitBoundaryDocKeys,
    lastEnqueuedSourceEventId: params.sourceEventId,
    recentEnqueuedSourceEventIds: pruneLedger(params.caseView.recentEnqueuedSourceEventIds, buildLedgerEntryKey(params.sourceEventId, params.eventId)),
  };
  if (!wasPending) {
    write.nextEligibleAtMillis = params.nowMillis + 60_000;
  }
  return write;
}

// ---------------------------------------------------------------------------
// Per-target decision (§8, §10 fail-closed behavior) — the single pure
// dispatch point the I/O shell calls once per target, AFTER its own case
// `get`. Order (frozen, RC-1/RC-RR1/RC-RR1-E-1 remediation):
//
//   1. case absent -> no-op.
//   2. branch mismatch -> ALWAYS checked first among the "is this a live
//      anomaly" questions, so a real branch inconsistency is flagged and
//      logged regardless of any dedup state or processing order (two
//      same-shiftId targets sharing one write must not let one silently
//      swallow the other's anomaly).
//   3. [RC-RR1] durable ledger dedup: `recentEnqueuedSourceEventIds` is a
//      bounded FIFO set of ledger keys, NEVER touched by the P5-D-1 worker's
//      own selection write, so it survives a sweep that wholesale-replaces
//      `commitBoundaryDocKeys` from its own live scan (which can never
//      re-include a deleted document — Codex RC-1/RC-RR1). Unlike the
//      one-slot `lastEnqueuedSourceEventId` mirror it replaces as the
//      authoritative signal, the ledger can hold every distinct sibling tied
//      at one revision, closing the RC-RR1 multi-tied-delete counterexample.
//      A ledger HIT is conclusive: it is the exact same CloudEvent -> no-op.
//   4. the frozen watermark rule (§9) — stale -> no-op (always; an older
//      revision is unambiguously not a new event, regardless of ledger
//      state); append/advance -> enqueue.
//   5. [RC-RR1-E-1] watermark `duplicate` (equal revision, source boundary
//      key already recorded) is NOT, by itself, conclusive proof of "same
//      event" — step 3 already proved this specific CloudEvent (this exact
//      `sourceEventId`+`eventId` pair) was NOT previously recorded. Codex's
//      RC-RR1-E-1 finding: without this step, a genuinely distinct CloudEvent
//      that happens to collide on derived `sourceEventId`/revision (the
//      residual same-source identity-collision risk Candidate E's CloudEvent
//      `id` strengthening exists to catch) was wrongly swallowed by the
//      watermark's `duplicate` classification whenever the source boundary
//      key was still present (i.e., every case EXCEPT the post-sweep
//      boundary-replaced state RC-RR1's original test already covered). So a
//      ledger MISS reaching this point is treated as a genuinely distinct
//      event: it enqueues, appending its own ledger entry, WITHOUT touching
//      `lastObservedCommitMicros`/`commitBoundaryDocKeys` (nothing new to
//      record there — the boundary key is already correctly present; only
//      the shared `watermarkKey`/`commitBoundaryDocKeys` STRING CONVENTION
//      stays frozen, never the CloudEvent id).
//
// Step 3 also naturally absorbs the "two same-shiftId targets born from one
// write" case (branch/device-only moves): whichever target's branch matches
// wins the watermark advance and appends to the ledger; a same-branch
// sibling (sharing the identical `sourceEventId`/`eventId`) hits step 3
// directly — "exactly one CAS effect" — without depending on watermark
// boundary-key bookkeeping surviving untouched.
// ---------------------------------------------------------------------------

export type TargetDecision =
  | { kind: 'case_absent' }
  | { kind: 'branch_mismatch'; caseBranchId: string; targetBranchId: string }
  | { kind: 'noop_duplicate_source_event' }
  | { kind: 'noop_watermark' }
  | { kind: 'enqueue'; write: EnqueueWriteSet };

export function decideTargetOutcome(params: {
  target: RouteTarget;
  caseView: CaseSnapshotView | null;
  nowMillis: number;
}): TargetDecision {
  if (params.caseView === null) return { kind: 'case_absent' };
  const caseView = params.caseView;

  if (params.target.branchId !== null && caseView.branchId !== null && params.target.branchId !== caseView.branchId) {
    return { kind: 'branch_mismatch', caseBranchId: caseView.branchId, targetBranchId: params.target.branchId };
  }

  const ledgerKey = buildLedgerEntryKey(params.target.sourceEventId, params.target.eventId);
  if (caseView.recentEnqueuedSourceEventIds.includes(ledgerKey)) {
    return { kind: 'noop_duplicate_source_event' };
  }

  const watermark = decideWatermark({
    currentLastObservedCommitMicros: caseView.lastObservedCommitMicros,
    currentCommitBoundaryDocKeys: caseView.commitBoundaryDocKeys,
    revisionToken: params.target.revisionToken,
    watermarkKey: params.target.watermarkKey,
  });

  if (watermark.kind === 'stale') return { kind: 'noop_watermark' };

  if (watermark.kind === 'duplicate') {
    // [RC-RR1-E-1] The ledger already proved (step 3, above) that this exact
    // CloudEvent (sourceEventId + eventId) was never recorded — so this is a
    // genuinely distinct event despite colliding with an already-recorded
    // revision/boundary key. Enqueue it, appending its own ledger entry,
    // without altering `lastObservedCommitMicros`/`commitBoundaryDocKeys`
    // (the boundary key is already correctly present; nothing new to add).
    return {
      kind: 'enqueue',
      write: buildEnqueueWriteSet({
        caseView,
        watermark: { kind: 'append', nextCommitBoundaryDocKeys: caseView.commitBoundaryDocKeys },
        sourceEventId: params.target.sourceEventId,
        eventId: params.target.eventId,
        nowMillis: params.nowMillis,
      }),
    };
  }

  return {
    kind: 'enqueue',
    write: buildEnqueueWriteSet({ caseView, watermark, sourceEventId: params.target.sourceEventId, eventId: params.target.eventId, nowMillis: params.nowMillis }),
  };
}

// ---------------------------------------------------------------------------
// Retry/throw taxonomy — MIRRORED verbatim from shiftCloseEvidenceCaptureCore.ts's
// frozen Codex B1 classifier (see that file for the full rationale comment).
// Retryability is NEVER inferred from `error.message` text.
// ---------------------------------------------------------------------------

const TRANSIENT_NUMERIC_GRPC_CODES: ReadonlySet<number> = new Set([4, 8, 10, 14]);
const TRANSIENT_STRING_CODES: ReadonlySet<string> = new Set(['deadline-exceeded', 'resource-exhausted', 'aborted', 'unavailable']);

function extractStableCode(value: unknown): string | number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const code = (value as { code?: unknown }).code;
  if (typeof code === 'number' || typeof code === 'string') return code;
  return undefined;
}

function isTransientCode(code: string | number): boolean {
  return typeof code === 'number' ? TRANSIENT_NUMERIC_GRPC_CODES.has(code) : TRANSIENT_STRING_CODES.has(code.toLowerCase());
}

/** `true` -> stable coded transient Firestore/gRPC failure -> rethrow so `retry:true` redelivers. Checks own `code`, then one level of `error.cause.code`. */
export function isRetryableFirestoreError(error: unknown): boolean {
  const directCode = extractStableCode(error);
  if (directCode !== undefined) return isTransientCode(directCode);

  if (error !== null && typeof error === 'object') {
    const causeCode = extractStableCode((error as { cause?: unknown }).cause);
    if (causeCode !== undefined) return isTransientCode(causeCode);
  }

  return false;
}

/** Normalized code for structured logging only (never logs `.message`/payload values). */
export function describeErrorCode(error: unknown): string | number {
  const directCode = extractStableCode(error);
  if (directCode !== undefined) return directCode;
  if (error !== null && typeof error === 'object') {
    const causeCode = extractStableCode((error as { cause?: unknown }).cause);
    if (causeCode !== undefined) return causeCode;
  }
  return 'unknown';
}
