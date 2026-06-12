# Current Task Tracker — Phase 7B-H6-G1 (Receiving Evidence Rejection Visibility — CLOSED)

> Living checkpoint doc for agents. Detailed history: `docs/reports/latest-report.md` (do not duplicate long-form evidence here).

## Current baseline

**Transfer Reversal Evidence sequence: FULLY CLOSED / COMMITTED**

- **H6-E2-A** — Pure Transfer Evidence Builder + Dual-Branch Invariant — CLOSED / COMMITTED — `53a2123 feat(pos): implement dual-branch transfer reversal evidence builder and invariants`
- **H6-E2-B** — Write Transfer Evidence Header at Completion — CLOSED / COMMITTED — `82d3352 feat(pos): write transfer reversal evidence header on completion`
- **H6-E2-C** — Transfer Evidence Coordinator Validation — CLOSED / COMMITTED — `fe3ff44 feat(pos): validate transfer reversal header evidence`

**Current clean baseline:** `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`

**H6-F1** — Transfer Reversal Evidence Rejection Visibility — CLOSED / COMMITTED — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`
**H6-G1** — Receiving Evidence Rejection Visibility & Void Error Handling — CLOSED / COMMITTED — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`

**Transfer and Receiving fail-closed visibility paths are both closed.** Server resolver remains authoritative. Offline queue schema unchanged. `src/lib/pos/offline` has no diff in either slice. Durable local rejection logging deferred to future separately-authorized slice.

**`stash@{0}` remains present and untouched.**

**Next step:** read-only strategic planning for the next major initiative.

---

## Phase 7B-H6-G1 — Receiving Evidence Rejection Visibility & Void Error Handling

**Status:** **CLOSED / COMMITTED** — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Scope:** UI/error-visibility only — the receiving symmetric counterpart of H6-F1. **No validation, fail-closed policy, receiving evidence validator behavior, offline queue schema/IndexedDB/`src/lib/pos/offline`, server resolver, or transfer behavior change.** The thrown `ReceivingReversalEvidenceError` (type, `code`, generic `message`) is UNCHANGED.

### Audit findings (gate before implementation)

- `ReceivingEditPage.handleVoid` calls `executeReceivingReversal` and previously had **no try/catch**, BUT its caller `ReceivingForm.handleVoidConfirm` already wraps `onVoid` in try/catch and shows `err.message` in the `rcv-error-banner` (dialog stays open). So receiving rejections were **caught and shown — but only via the single generic `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE` for all 17 codes** (the specific code was lost). This is the same message-granularity gap F1 fixed for transfers, NOT a true unhandled rejection.
- `AdminReceivingPage` voids via the **legacy `cancelReceiving`** path (no `executeReceivingReversal`, no `ReceivingReversalEvidenceError`) — needs no parity. Authorized file list is therefore sufficient; **no scope expansion required**.
- Fix kept entirely within `ReceivingEditPage.tsx`: `handleVoid` now catches `ReceivingReversalEvidenceError` and re-throws a friendly Thai message + raw code to `ReceivingForm`'s existing banner; non-evidence errors re-throw unchanged. No edit to `ReceivingForm.tsx`.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`: new exhaustive `Record<ReceivingReversalEvidenceCode, string>` (`RECEIVING_REVERSAL_EVIDENCE_MESSAGES`) + pure `getReceivingReversalEvidenceMessage(code): string` (unknown code → `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE`). Mirrors the F1 transfer helper. Thrown error/validation unchanged.
- `src/pages/ReceivingEditPage.tsx`: `handleVoid` wrapped in try/catch — `ReceivingReversalEvidenceError` re-thrown as `Error(getReceivingReversalEvidenceMessage(code) + " (รหัส: <code>)")` so the existing void-dialog banner shows the specific reason; all other errors re-thrown unchanged (not swallowed). Success/navigation/manual-review wording, validation order, authority gating, and the form's busy/`finally` cleanup all unchanged.
- `src/lib/inventory/reversalCoordinator.test.ts`: +4 H6-G1 tests (every code non-empty Thai; unknown→generic fallback; `header_total_qty_mismatch` specific; thrown error message unchanged).

### What is NOT in this slice

No change to receiving validation / `resolveReceivingReversalEffects` / `validateReceivingHeaderEvidence` / `executeReceivingReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, offline queue schema / IndexedDB / `src/lib/pos/offline`, the server resolver, transfer behavior, `transferCrud`/`transferDevMock`/`transferTypes`, `ReceivingForm.tsx`, `AdminReceivingPage`, `cancelReceiving`. No durable local rejection log (future separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ receiving message map + getReceivingReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-G1 tests; 111 file total)
src/pages/ReceivingEditPage.tsx                 (handleVoid try/catch: evidence-error display only)
```

### Evidence

- `npx vitest run reversalCoordinator` → **111 passed** (+4 H6-G1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **414 passed** (25 files); `npx tsc -b` → clean
- `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

G1 improves receiving void rejection visibility, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-F1 — Transfer Reversal Evidence Rejection Visibility

**Status:** **CLOSED / COMMITTED** — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Scope:** UI/display-only visibility for the H6-E2-C fail-closed rejections. **No validation, fail-closed policy, offline queue schema/behavior, IndexedDB store, server resolver, or transfer write-path change.** The thrown `TransferReversalEvidenceError` (type, `code`, generic `message`) is UNCHANGED — F1 only makes the already-computed reason legible.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`:
  - New exhaustive `Record<TransferReversalEvidenceCode, string>` (`TRANSFER_REVERSAL_EVIDENCE_MESSAGES`) — one friendly Thai message per code (TS build fails if a code is unmapped).
  - New pure `getTransferReversalEvidenceMessage(code): string` — returns the mapped message; an unknown/unexpected code falls back to the existing `TRANSFER_EVIDENCE_INCOMPLETE_MESSAGE`.
- `src/pages/inventory/TransferHistoryPage.tsx` & `src/pages/admin/AdminTransferPage.tsx`: the cancel-handler `catch` now, **only when** the caught error `instanceof TransferReversalEvidenceError`, surfaces `getTransferReversalEvidenceMessage(err.code)` with the raw code as secondary detail (`(รหัส: <code>)`). All other errors keep the existing generic fallback. Control flow, `finally` busy-cleanup, branch gating, modal/route behavior, success flow all unchanged. (Admin's separate `editBranchTransfer` catch is untouched.)
- `src/pages/ManualReviewOpsPage.tsx`: new read-only "แหล่งหลักฐาน" column rendering a **page-local** `getEvidenceSourceLabel(source)` (`header_snapshot`→หลักฐานจากหัวเอกสาร, `legacy_subcollection`→รายการย่อยเดิม, absent/unknown→ไม่ระบุ) over the existing `it.evidenceSource` intent field. The label helper is defined inside the page module — **no runtime helper added to `src/lib/pos/offline`** (Codex blocker fix). No query/schema/store/mutation change.

### What is NOT in this slice

No change to `validateTransferHeaderEvidence` / `resolveTransferReversalEffects` / `executeTransferReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, the offline queue schema or IndexedDB stores, **any `src/lib/pos/offline` runtime code**, the server resolver, the H6-E2-B write path, transfer creation, receiving, `cancelBranchTransfer`/`editBranchTransfer`. No durable local rejection log (a future, separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ message map + getTransferReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-F1 message-map tests; 107 file total)
src/pages/inventory/TransferHistoryPage.tsx     (catch: evidence-error display only)
src/pages/admin/AdminTransferPage.tsx           (cancel catch: evidence-error display only)
src/pages/ManualReviewOpsPage.tsx               (+ page-local getEvidenceSourceLabel + read-only evidenceSource column)
```

### Codex blocker fix

Codex returned FAIL: the first cut added a runtime helper (`getEvidenceSourceLabel`) + a test to `src/lib/pos/offline/manualReviewOps.ts(.test.ts)`, which was strictly out of scope (`src/lib/pos/offline` runtime). Fix: both offline files reverted to **no diff**; the label mapping now lives **page-local** in `ManualReviewOpsPage.tsx`. Removing the 3 offline-helper tests dropped the full web count 413 → **410**.

### Evidence

- `npx vitest run reversalCoordinator` → **107 passed** (+4 H6-F1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **410 passed** (25 files); `npx tsc -b` → clean
- `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

H6-F1 improves operator visibility for local pre-queue rejection reasons, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-E2-C — Transfer Evidence Coordinator Validation

**Status:** **CLOSED / COMMITTED** — `fe3ff44 feat(pos): validate transfer reversal header evidence`.
**Authorization:** CEO Option A — APPROVED.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`:
  - `TransferReversalInput` gains `transferHeaderEvidence?: unknown` (UNTRUSTED at the boundary — never typed as `TransferReversalEvidence`).
  - `TransferReversalOutcome` gains `evidenceSource: ReversalEvidenceSource` (mirrors receiving).
  - `TransferReversalEvidenceCode` extended with 15 `header_*` codes.
  - `assertTransferReversalInput` split into `assertTransferReversalHeaderFields` (transferId/branches/staff/reason — runs on BOTH paths) + `assertTransferReversalItems` (legacy path only); the original retained as a composed wrapper.
  - new `validateTransferHeaderEvidence(raw, fromBranchId, toBranchId): OriginalStockEffect[]` — untrusted-boundary type-guards → version/source/branch checks → per-effect validity + direction-bound branch → checksums (`itemCount`/`totalQtyBase`, the latter with an explicit `Number.isFinite` guard) + dual-branch balance, all against the RAW entries; projects dest_gain→`+qty@to` and source_loss→`-qty@from` (lotId audit-only). Self-consistent; does NOT consult the item subcollection.
  - **Codex blocker fix:** `totalQtyBase` checksum now rejects non-finite values (`NaN`/±Infinity) — previously `typeof NaN === 'number'` + `Math.abs(NaN) > EPSILON === false` let a `NaN` total slip through. +3 regression tests.
  - new `resolveTransferReversalEffects(input)` — Case 1/2 header present (validate-or-throw, no fallback) → `header_snapshot`; Case 3/4 header absent → legacy item gate → `legacy_subcollection`.
  - `executeTransferReversal` now runs header-field gate → `resolveTransferReversalEffects` → sets `evidenceSource` on `CreateReversalInput` and the outcome.
- `src/pages/inventory/TransferHistoryPage.tsx` & `src/pages/admin/AdminTransferPage.tsx`: pass `transferHeaderEvidence: cancelTarget.reversalEvidence` (data argument only — no route/gating/modal change).
- `src/lib/inventory/reversalCoordinator.test.ts`: new `describe('H6-E2-C: …')` — 24 tests (valid preferred incl. empty-items, absent-falls-back, legacy-reversible, full invalid-header matrix with no-fallback/no-write proof, mapping equivalence, single/multi-lot lotId, E2-B round-trip, source tagging, Staff rejected on header path, header-field validation on header path).

### What is NOT in this slice

No transfer write-path change (`transferCrud.ts`/`transferDevMock.ts`/`transferTypes.ts` untouched). No server resolver change (`functions/` untouched — it re-reads items and remains authoritative). No offline queue schema change (`evidenceSource` already existed, optional). No receiving/manual-review/POS change. No new enum value; no new files.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts       (+transferHeaderEvidence, validateTransferHeaderEvidence, resolveTransferReversalEffects, gate split, evidenceSource)
src/lib/inventory/reversalCoordinator.test.ts  (+27 H6-E2-C tests; 103 file total)
src/pages/inventory/TransferHistoryPage.tsx     (+transferHeaderEvidence arg)
src/pages/admin/AdminTransferPage.tsx           (+transferHeaderEvidence arg)
```

### Evidence

- `npx vitest run reversalCoordinator` → **103 passed**; `transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed**
- Full web `npx vitest run` → **406 passed** (25 files); `npx tsc -b` → clean
- `functions` `resolveReversal` → **43 passed** (server unchanged)
- `git diff --check` clean; `stash@{0}` untouched; forbidden-path diff EMPTY (write-path/server/offline schema).

### Hidden risk

H6-E2-C activates fail-closed header evidence preference, so malformed post-E2-B evidence will BLOCK local queue-first reversal (→ manual review) rather than silently falling back; this is intentional, and server authority remains unchanged.

---

## Phase 7B-H6-E2-B — Write Transfer Evidence Header at Completion

**Status:** **CLOSED / COMMITTED** — `82d3352 feat(pos): write transfer reversal evidence header on completion`.
**Authorization:** CEO Option A — APPROVED.

### What was delivered

- `src/lib/inventory/transferTypes.ts`: added `import type { TransferReversalEvidence }` and `reversalEvidence?: TransferReversalEvidence` as optional field on `InventoryTransfer` (absent on legacy docs).
- `src/lib/inventory/transferCrud.ts`: in `confirmBranchTransfer`, after `linePlans` are finalized (end of Phase 2) and before Phase 3 writes, builds `TransferReversalEvidenceInput` from `linePlans` (with FIFO `sourceLotDetails`), calls `buildTransferReversalEvidence` then `assertTransferReversalEvidenceCoversCompletion` fail-closed, and adds `reversalEvidence` to the Phase-3 `tx.set` atomically with the transfer header. Evidence `createdAt` is a client ISO string (`new Date().toISOString()`); header `createdAt`/`updatedAt` remain server timestamps.
- `src/lib/inventory/transferDevMock.ts`: `devConfirmBranchTransfer` mirrors the production path — builds the same evidence input from `savedItems`, calls builder + assertion, and writes `reversalEvidence` on the in-memory doc.
- `src/lib/inventory/transferCrud.test.ts`: 8 new H6-E2-B tests in `describe('H6-E2-B: write reversalEvidence at transfer completion', ...)`.

### What is NOT in this slice

No coordinator validation against the persisted evidence in this slice. `reversalCoordinator.ts`, UI pages, server resolver, offline queue, Firestore rules — all UNCHANGED in this slice. H6-E2-C (coordinator validation) is now also CLOSED / COMMITTED — `fe3ff44`.

### Files changed (code)

```
src/lib/inventory/transferTypes.ts       (+ reversalEvidence?: TransferReversalEvidence)
src/lib/inventory/transferCrud.ts        (evidence build + tx.set update in confirmBranchTransfer)
src/lib/inventory/transferDevMock.ts     (evidence build + doc update in devConfirmBranchTransfer)
src/lib/inventory/transferCrud.test.ts   (+8 H6-E2-B tests; 18 transferCrud total)
```

### Evidence

- `npx vitest run transferCrud` → **18 passed** (+8 H6-E2-B); `npx vitest run transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **379 passed** (25 files); `npx tsc -b` → clean
- `git diff --check` clean; `stash@{0}` untouched; no diff in any forbidden file.

### Hidden risk

H6-E2-B persists the evidence snapshot at completion but does not yet validate it at reversal time — until H6-E2-C wires the coordinator to read and verify the header evidence before accepting a reversal, the snapshot is audit-only (not fail-closed on the reversal path).

---

## Phase 7B-H6-E2-A — Pure Transfer Evidence Builder + Dual-Branch Invariant

**Status:** **CLOSED / COMMITTED** — `53a2123 feat(pos): implement dual-branch transfer reversal evidence builder and invariants`.
**Authorization:** CEO Option A — APPROVED (pure evidence builder + invariant only).

### What was delivered

- New pure file `src/lib/inventory/transferReversalEvidence.ts`:
  - `TransferReversalEvidence` / `TransferReversalEvidenceEffect` / `TransferReversalEvidenceDirection` types.
  - `TransferReversalEvidenceInput` / `TransferReversalEvidenceItemInput` builder input types (decoupled from runtime transfer types).
  - `TransferReversalEvidenceError` (structured codes: builder + invariant).
  - `buildTransferReversalEvidence(input)` — validates input fail-closed; produces one `dest_gain` + one `source_loss` effect per item (both positive qty); derives `itemCount` and `totalQtyBase` from input; sorts effects deterministically by `productId|direction|branchId|lotId`. Source lot identity is audit-only (populated for single-lot; null for multi-lot — no over-rejection gate).
  - `assertTransferReversalEvidenceCoversCompletion(input, evidence)` — proves version/source, branch IDs, effect well-formedness, `itemCount` == `input.items.length`, `totalQtyBase` == sum(transferQty), and per-product dual-branch balance (dest_gain total == source_loss total == input qty for every product; extra products in effects also fail closed).
- New test file `src/lib/inventory/transferReversalEvidence.test.ts`: 41 tests (36 original + 5 branch-direction invariant tests from the Codex blocker fix) covering all 24 required specification cases plus the branch-direction binding cases.

### What is NOT in this slice

No runtime wiring. No header write. No coordinator validation. No evidence persistence. `transferCrud.ts`, `reversalCoordinator.ts`, `transferDevMock.ts`, UI, server resolver, offline queue — all UNCHANGED. H6-E2-B (header write at completion) and H6-E2-C (coordinator validation) are future slices.

### Files changed (code)

```
src/lib/inventory/transferReversalEvidence.ts       (NEW — pure builder + invariant)
src/lib/inventory/transferReversalEvidence.test.ts  (NEW — 41 tests)
```

### Evidence

- `npx vitest run transferReversalEvidence` → **41 passed**; `npx vitest run transferCrud` → **10 passed**; `npx vitest run reversalCoordinator` → **76 passed**; full web `npx vitest run` → **371 passed** (25 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (resolver UNCHANGED).
- `git diff --check` clean; `stash@{0}` untouched; no diff in any forbidden file.

### Hidden risk

H6-E2-A proves the evidence math but remains latent; it does not yet protect live queue-first local correction until a later write/validation slice is authorized.

---

## Phase 7B-H6-E1 — Transfer `updatedAt` Stamping

**Status:** **CLOSED / COMMITTED** — `8a3d03f feat(pos): stamp updatedAt on transfer completion for stale-client protection`.
**Authorization:** CEO Option A — APPROVED (timestamp-only).

### What was delivered

- `confirmBranchTransfer` (`transferCrud.ts`) Phase-3 header `tx.set` now writes `updatedAt: now` alongside the existing `createdAt: now` (both `serverTimestamp()`); `updatedAt === createdAt` at inception is expected/acceptable.
- `devConfirmBranchTransfer` (`transferDevMock.ts`) mirrors the shape, writing `updatedAt: ts(now)` on the created doc.
- No other write path changed: `cancelBranchTransfer` already stamped `updatedAt`; `editBranchTransfer` creates a fresh transfer via `confirmBranchTransfer` (so edit-created docs inherit the stamp). `InventoryTransfer.updatedAt` was already optional — no type change.

### Why this closes the gap

Pre-E1, a freshly `completed` transfer had `createdAt` but no `updatedAt`, so the server `isClientObservationStale` saw `serverDoc.updatedAt == null` → not stale (doubly inert with the omitted client observation). With E1, new transfers carry `updatedAt`, so the H6-D2 capture `toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt)` is populated AND the server has a baseline — activating the stale-client guard end-to-end. No page/coordinator/resolver edit was needed (H6-D2 was built forward-compatible).

### Legacy docs policy (accepted)

No backfill. Existing transfers without `updatedAt` stay fresh-by-default (guard fail-open); the server reversal mutation remains authoritative through the existing guards. New transfers get reliable `updatedAt`.

### Files changed (code)

```
src/lib/inventory/transferCrud.ts        (confirmBranchTransfer header: + updatedAt: now)
src/lib/inventory/transferDevMock.ts     (devConfirmBranchTransfer doc: + updatedAt: ts(now))
src/lib/inventory/transferCrud.test.ts   (+2 H6-E1 tests: production + dev/mock stamping)
```

### Evidence

- `npx vitest run transferCrud` → 10 passed; `npx vitest run reversalCoordinator` → 76 passed; full web `npx vitest run` → 330 passed (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → 43 passed (server resolver UNCHANGED; the transfer stale-guard regression already exists at `resolveReversal.test.ts` lines 454–468 and stays green).
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched (no UI, coordinator, resolver, or offline-queue diff).

### Out of scope (unchanged)

Transfer header evidence/checksum snapshot (future H6-E2), server resolver implementation, offline queue schema, Firestore rules, receiving behavior, H6-D2 UI route wiring/coordinator, `cancelBranchTransfer`/`editBranchTransfer` behavior, `sent→received` lifecycle refactor, legacy-doc backfill.

### Hidden risk

Legacy transfer docs without `updatedAt` remain fresh-by-default (stale-client guard inert for them), but new transfers now activate the guard end-to-end; additionally, a metadata-only `reportTransferDiscrepancy` writes a subcollection without advancing the header `updatedAt`, so a discrepancy report is not seen as a state advance by the guard (acceptable — it mutates no stock).

---

## Phase 7B-H6-D2 — UI Route Wiring & Legacy Path Retirement

**Status:** **CLOSED / COMMITTED** — `bb30881` `feat(pos): wire ui to queue-first transfer reversal and retire legacy path` (CEO Option B — APPROVED WITH NOTES).
**Authorization:** CEO Option A — APPROVED.

### Codex blocker fix (origin-branch authority gate)

Codex returned **FAIL**: `TransferHistoryPage` lists both outgoing (`fromBranchId`) and incoming (`toBranchId`) transfers, but the queue-first executor applies a local IndexedDB correction + queue write BEFORE server sync using `fromBranchId` as authority — so a destination-branch user could locally apply/queue a reversal they don't control. **Fix:** a pure fail-closed preflight `canBranchReverseTransfer(currentBranchId, fromBranchId)` (in `reversalCoordinator.ts`) gates BOTH the modal entry point (`onCancelTransfer` is only wired when active branch === origin) AND `handleCancel` (hard early-return before `executeTransferReversal`). `AdminTransferPage` is the global-admin surface (`hasBranchAccess` → `true` for `admin`), so it intentionally does NOT use the gate. New tests prove the helper's fail-closed behavior, the gated entry point, the guard-before-executor ordering, and that Admin stays ungated. Server resolver, offline-queue schema, and `transferCrud.ts` unchanged.

### What was delivered

- **D2-α prerequisite cleanup:**
  - Removed the now-stale `TRANSFER_REVERSAL_DEFERRED_NOTE` constant (and its tests/JSDoc references); it claimed completed transfers were not resolver-compatible, which H6-C (resolver activation) + H6-D1 (latent executor) made false.
  - Tightened `assertTransferReversalInput`: whitespace-only `productId` now fails closed as `missing_product_id`; trim-equal `fromBranchId`/`toBranchId` now fail closed as `same_branch`.
- **D2-β UI route wiring:**
  - `decideReversalRoute('transfer')` now returns `transfer_queue_first` (the `transfer_legacy_executor` route value is retired from `ReversalRoute`).
  - `TransferHistoryPage` + `AdminTransferPage` confirmed-cancel handlers now call `executeTransferReversal` queue-first, fetching transfer items fresh and building the payload (`transferId`, `fromBranchId`, `toBranchId`, items, `sourceLotDetails`, reason/note, `observedDocumentUpdatedAt` via `toObservedDocumentUpdatedAtIso`). Queue-first outcome wording mirrors the receiving reversal UX (manual-review / synced / queued-offline).
  - Legacy `cancelBranchTransfer` import + call removed from BOTH pages. `AdminTransferPage` keeps `editBranchTransfer` (and its internal `cancelBranchTransfer` step is untouched in `transferCrud.ts`).

### Timestamp handling (known limitation)

`observedDocumentUpdatedAt` is threaded WHEN the transfer doc has a convertible `updatedAt`, omitted otherwise. `confirmBranchTransfer` may not reliably stamp `updatedAt` at creation yet, so full stale-client protection for transfers is NOT claimed — that is the future **H6-E** hardening slice.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (route flip + whitespace tightening + stale-note removal + comment refresh)
src/lib/inventory/reversalCoordinator.test.ts   (route/validation tests + H6-D2 source-level mutual-exclusion tests)
src/pages/inventory/TransferHistoryPage.tsx     (queue-first migration; cancelBranchTransfer retired)
src/pages/admin/AdminTransferPage.tsx           (queue-first migration; cancelBranchTransfer retired, editBranchTransfer preserved)
```

### Evidence (post blocker fix)

- `npx vitest run reversalCoordinator` → 76 passed; full web `npx vitest run` → 328 passed (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → 43 passed (server resolver unchanged — regression green).
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

Server resolver, offline-queue schema, Firestore rules, receiving/POS/checkout/returns/RTV, `transferCrud.ts` (`cancelBranchTransfer`/`editBranchTransfer` behavior), transfer header evidence/checksum snapshot, `updatedAt` stamping at transfer completion, `sent→received` lifecycle refactor.

### Hidden risk

Page-component guarantees are proven by source-level import/call inspection (the pages carry a heavy Firebase/router/auth/modal harness), so a future refactor that re-introduces a legacy `cancelBranchTransfer` call through an alias or indirection could evade the regex guards without failing the suite.

---

## Phase 7B-H6-D1 — Transfer Queue-first Executor (LATENT)

**Status:** **IMPLEMENTED — AWAITING CODEX REVIEW** (not committed; not closed).
**Authorization:** CEO Option A — APPROVED (latent executor + tests only).

### What was delivered

- Latent `executeTransferReversal` in `reversalCoordinator.ts` mirroring `executeReceivingReversal`: fail-closed validation (`assertTransferReversalInput` + `TransferReversalEvidenceError`), dual-branch `buildTransferReversalEffects`, `observedDocumentUpdatedAt` threading, queue-first create + sync.
- Intent uses `sourceType:'transfer'`, `sourceId: transferId`, `branchId: fromBranchId` (origin — matches server authority). No offline-queue schema change.
- **Not wired into any UI (as of H6-D1; superseded by H6-D2).** At D1, `decideReversalRoute('transfer')` still returned the legacy route and the two transfer pages were untouched — capability was dead-but-tested. **H6-D2 has since flipped the route to `transfer_queue_first` and migrated both pages.**

### Dual-branch math (proven)

- Original effects: destination `+transferQty`, source `−transferQty`. Reversal engine negates → local correction destination `−qty`, source `+qty`; aggregated by product×branch.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (executeTransferReversal + builder + validation + types)
src/lib/inventory/reversalCoordinator.test.ts   (16 new H6-D1 tests)
```

### Evidence

- `npx vitest run reversalCoordinator` → 63 passed; full web `npx vitest run` → 315 passed (24 files); `npx tsc -b` → clean.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

UI route flip, transfer page migration, legacy `cancelBranchTransfer` retirement, server resolver, offline-queue schema, transfer evidence/checksum snapshot, `updatedAt`-at-completion, `sent→received` lifecycle refactor.

### Hidden risk

The executor is fully functional but unreferenced by production UI, so a future H6-D2 that forgets to also remove the legacy `cancelBranchTransfer` page calls could leave two live reversal paths for the same transfer.

---

## Phase 7B-H6-C — Server Resolver Activation + Tests

**Status:** **CLOSED / COMMITTED**
**Commit:** `68f46e2` — `feat(pos): activate server transfer reversal resolver` (CEO Option B — APPROVED WITH NOTES)
**Authorization:** CEO Option A — APPROVED (server resolver + tests only).

### What was delivered

- Activated the (previously dormant) transfer reversal resolver for the live model: `completed` is now the reversible state (H6-B Option A). Eligibility is **centralized** in `isTransferStatusReversible(status)` backed by the single-source-of-truth set `REVERSIBLE_TRANSFER_STATES = {'completed'}`; the resolver gate calls only that helper (no scattered `status === 'completed'` checks).
- `completed` is **eligible only to proceed into the existing strict downstream guards** — it is never unconditionally reversible. Guard ordering preserved: `source_document_not_found` → authority/PIN → H4 stale-client guard → `already_reversed` (cancelled/reversedBy) → eligibility gate → dest stock/lot sufficiency → dual-branch writes → intent/audit.
- No client/UI/offline-queue change. Resolver activation is **latent in production** until the future H6-D client wiring (no caller currently queues a `transfer_reversal`).

### Files changed (code)

```
functions/src/resolveReversal.ts        (centralized policy helper + gate + header comment)
functions/src/resolveReversal.test.ts   (transfer tests updated to live model + new coverage)
```

### Evidence

- `npm --prefix functions run build` → clean.
- `npx vitest run resolveReversal` → 43 passed; full functions suite `npx vitest run` → 112 passed (8 files).
- Receiving + H4 stale-guard tests remain green.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged by H6-C)

Client queue-first transfer reversal, `executeTransferReversal`, transfer UI/Admin routing, legacy `cancelBranchTransfer` retirement, transfer evidence/checksum snapshot, `updatedAt` stamping at completion, `sent→received` lifecycle refactor, Firestore rules, receiving paths.

### Hidden risk

H6-C flips the server gate so a `completed` transfer is now reversible server-side, but no client path queues a transfer reversal yet — so the activation is inert in production until H6-D, and any premature direct callable invocation would now execute a real dual-branch reversal under the guards.

---

## Phase 7B-H6-B — Transfer Reversal Architecture Decision

**Status:** **IN PROGRESS — docs-only, not yet committed.**
**Authorization:** CEO Option A — APPROVED. Docs-only architecture decision recording. No TypeScript implementation in H6-B.

### H6 Environment Audit Findings (read-only — point-in-time at the H6-B audit, SINCE SUPERSEDED by H6-C/H6-D1/H6-D2)

> These findings describe the state at the H6-B audit. **H6-C (committed `68f46e2`) activated the resolver for `completed` transfers under strict guards; H6-D1 (`4aa8065`) added the latent queue-first executor; H6-D2 wired the targeted UI surfaces.** The "dormant"/"cannot fire" rows below are historical, not current.

| Finding | Detail |
|---------|--------|
| Current Transfer state model | Two states only: `completed` \| `cancelled` |
| Live transfer creation | Transfers are created directly as `completed` (no intermediate `sent`/`received` steps in the current production path) |
| Existing server resolver transfer branch | Was dormant at the audit — gated on `sent`/`received` (states no live transfer carries). **H6-C has since activated it for `completed` transfers under strict guards.** |
| Impact | At the audit, the resolver transfer path could not fire end-to-end until the gate was updated. **H6-C updated the gate to admit `completed`; the path is now live server-side and wired in H6-D2.** |

### CEO Architecture Decision (Option A)

For the current Transfer model, **`completed` is approved as the reversible state** for future queue-first Transfer Reversal.

**Semantics clarification:**
- `completed` does NOT mean "always reversible."
- `completed` means "**eligible for reversal under strict server-authoritative guards**."
- The same guard stack (authority, stale-client, idempotency, already-reversed, stock/lot sufficiency) applies as for receiving reversals.

**Deferred:** A full `sent → received → completed` lifecycle refactor is explicitly out of scope for the H6 implementation track and must not be introduced unless separately authorized.

### Long-Term Risk Documentation

#### Technical Debt

Treating `completed` as reversible creates **controlled technical debt, not blocking debt**. It matches the current production data model exactly. Forcing a broad transfer lifecycle refactor now would be riskier and broader than the immediate problem warrants. The debt is bounded: if business requirements later introduce a multi-step workflow, only the reversible-state policy needs to change — not the resolver logic everywhere.

#### Future Scalability

If a future `sent → received → completed` workflow is introduced, the resolver remains adaptable **if and only if** H6-C centralizes reversible-state eligibility in one helper/policy (e.g. `isTransferReversible(transfer)`) and tests both accepted and rejected states against that helper. A single centralized change then covers all call sites.

#### Mitigation Pattern (H6-C must follow)

| Requirement | Rule |
|-------------|------|
| Reversible-state check | Centralized helper — do NOT scatter `status === 'completed'` checks across resolver code |
| Semantics | `completed` = "eligible under guard," never "reversible unconditionally" |
| Server authority | Final mutation always server-authoritative |
| Stock/lot sufficiency | Destination stock/lot sufficiency must be required before reversal |
| Cost preservation | Source lot restoration must preserve original cost and `receivedAt` evidence |
| Stale-client guard | Must remain active when client payload is wired (same H4/H5 pattern) |
| Idempotency | Already-reversed check mandatory |
| Lifecycle refactor | No transfer lifecycle refactor unless separately authorized |

### Next queued slice

**Phase 7B-H6-C: Server Resolver Activation + Tests — Planning Only.**
No code implementation until Tech Lead approves the H6-C execution plan.

---

## Phase 7B-D4 — Docs/Context Sync After H5 Closure

**Status:** **CLOSED / COMMITTED**
**Commit:** `f61e94e` — `docs: sync phase 7b tracker after h5 receiving hardening closure`
Docs-only sync pass after Phase 7B-H5 was closed and committed (`4762d97`). Recorded H5 as CLOSED/COMMITTED, advanced the baseline to the H5 commit, recorded End-to-End Receiving Reversal Hardening as functionally complete, and queued H6. No source code or tests modified.

---

## Phase 7B-D3 — Docs/Context Sync After H4 Closure

**Status:** **CLOSED / COMMITTED**
**Commit:** `fb4c3b0` — `docs: sync phase 7b tracker after h4 closure`

Docs-only sync pass after Phase 7B-H4 was closed and committed (`4da7757`). Recorded H4 as CLOSED/COMMITTED, advanced the baseline to the H4 commit, and queued H5. No source code or tests modified. D3 is no longer active.

---

## Phase 7B-H5 — Wire Client Observation Timestamp Payload

**Status:** **CLOSED / COMMITTED**
**Commit:** `4762d97` — `feat(pos): wire client observation timestamp for reversals`
**Authorization:** Option A — APPROVED (receiving-only). CEO Option B — APPROVED WITH NOTES (closure).
**Milestone:** End-to-End Receiving Reversal Hardening is functionally complete. H4 (server-side stale-client guard) and H5 (client/offline timestamp payload wiring) together protect the Receiving reversal flow end-to-end.

### What was delivered summary

Wired `clientObservedDocumentUpdatedAt` into the offline/client resolver payload so Phase 7B-H4's server-side stale-client guard is active end-to-end for the **live receiving reversal flow**.

### What was delivered (receiving-only payload wiring — committed)

- The receiving void page (`ReceivingEditPage.handleVoid`) captures the loaded receiving doc's `updatedAt`, converts it defensively to an ISO 8601 string (`toObservedDocumentUpdatedAtIso`), and passes it through `ReceivingReversalInput`.
- The value is persisted on the durable offline intent as the optional **internal** field `observedDocumentUpdatedAt` (ISO 8601), so a later sync forwards the same observation.
- At the sync boundary, `toResolveRequest` maps it to the **server wire** field `clientObservedDocumentUpdatedAt`, **omitting** it entirely when unavailable.
- No server resolver change (H4 guard already shipped in `4da7757`).

### Backward compatibility

- All new fields optional. Legacy queued intents (pre-H5) carry no `observedDocumentUpdatedAt` ⇒ `toResolveRequest` omits `clientObservedDocumentUpdatedAt` ⇒ H4 guard stays inert (fresh) for them. No migration required.
- Missing / malformed / unconvertible `updatedAt` ⇒ field omitted (never `''`, never `null` on the wire).

### Idempotency

- The observed timestamp is **not** part of `deriveReversalIds` (intent id / idempotency key / localMutationId) and is excluded from the server payload hash by H4's design. Tests prove two intents differing only by `observedDocumentUpdatedAt` derive identical ids.

### Files changed

```
src/pages/ReceivingEditPage.tsx                    (capture + convert at void)
src/lib/inventory/reversalCoordinator.ts           (input field + toObservedDocumentUpdatedAtIso + thread-through)
src/lib/pos/offline/offlineReversalTypes.ts        (CreateReversalInput + OfflineReversalIntent fields)
src/lib/pos/offline/offlineReversalLogic.ts        (persist on intent)
src/lib/pos/offline/syncOfflineReversals.ts        (wire field + emit in toResolveRequest)
src/lib/pos/offline/offlineReversalQueue.test.ts   (3 new H5 tests)
src/lib/pos/offline/offlineReversalLogic.test.ts   (3 new H5 tests)
src/lib/inventory/reversalCoordinator.test.ts      (8 new H5 tests)
```

### Evidence

- `npx vitest run` (web) → 298 passed (24 files).
- Server resolver `functions: npx vitest run resolveReversal` → 39 passed (**unchanged**).
- `npx tsc -b` (web) → clean; `npm --prefix functions run build` → clean.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged by H5)

- Transfer reversal wiring (out of scope for H5; at that time it routed to the legacy executor and the resolver transfer path was dormant — since changed by H6-C activation, H6-D1 executor, and H6-D2 UI wiring).
- Manual-review resolution (local-only; never calls the server).
- Global Admin UI; multi-device/server-broadcast propagation.
- POS/cart/checkout/returns/RTV; Firestore rules; server resolver logic.

### Hidden risk

The observation is captured at void time from the page's already-loaded receiving doc; if that in-memory copy is staler than Firestore at the moment of voiding, the guard could reject a reversal the operator believes is current — surfaced via the existing manual-review path, not silent data loss.

---

## Phase 7B-H4 — Resolver Hardening / Stale Client Guard

**Status:** **CLOSED / COMMITTED**
**Commit:** `4da7757` — `feat(pos): harden resolver against stale client observations`
**Authorization:** Option B — APPROVED WITH NOTES (CEO)

### What was delivered

- Server-authoritative stale-client guard in `functions/src/resolveReversal.ts`. The resolver now rejects a reversal whose client-observed document version (`clientObservedDocumentUpdatedAt`) is older than the live server document `updatedAt`.
- New structured reject code `stale_client_observation` (status `rejected`). Mutation-free: zero stock, zero lot, no reversal/manual-review state advance, no audit/intent-ledger write.
- Guard placed AFTER authority (branch + Staff PIN) and BEFORE every status check and write in both `resolveReceivingReversal` and `resolveTransferReversal`.
- Conservative & deterministic: absent observation ⇒ not stale (legacy callers unaffected); no comparable server `updatedAt` ⇒ not stale; strict `server > observed` ⇒ stale (equal instants are fresh, so retries are safe).

### Files changed

```
functions/src/resolveReversal.ts        (guard + helpers + reject code)
functions/src/resolveReversal.test.ts   (11 new H4 tests)
```

### Evidence

- `npx vitest run resolveReversal` → 39 passed.
- Full functions suite `npx vitest run` → 108 passed (8 files).
- `npm run build` (tsc) → clean.
- `git diff --check` → clean; post-commit working tree **clean**; `stash@{0}` untouched.

### Hidden risk (accepted — primary H5 requirement)

The guard only fires when the client actually sends `clientObservedDocumentUpdatedAt`; until the offline-queue client is wired to populate it (out of this slice's scope), real-world staleness is not yet detected end-to-end. **Accepted by CEO (Option B) as a non-blocking known risk.** Wiring `clientObservedDocumentUpdatedAt` into the client/offline resolver payload is the primary Phase 7B-H5 requirement.

---

## Phase 7B-H3 — Manual Review Operations UI

**Status:** **CLOSED / COMMITTED**
**Codex:** PASS WITH NOTES / no required fixes / no blockers
**Commit:** `4d69143` — `feat(pos): add manual review ops UI`

> LOCAL/device-visible queue UI only. NOT a global Firestore admin dashboard. No global Firestore queries, no stock mutation, no Firestore reconciliation (that remains an external manual admin process outside the app).

### What was delivered

- Read-only view of THIS DEVICE's `manual_review_required` intents (via `listQueue(store, ['manual_review_required'])`).
- Manager/Admin-only resolve action (`resolveManualReview` from H2) with required `reasonCode` + optional `note`.
- Authority gating: `canViewManualReviewOps` delegates to H2's `isOfflineReversalAuthoritySupported` (Manager/Admin only; Staff sees not-authorized state).
- Unit/integration tests: `manualReviewOps.test.ts` (10 passed). Full web unit suite: 284 passed (24 files). `tsc -b --noEmit`: clean.

### Architectural boundaries

- **Local/device-only:** reads the IndexedDB reversal queue on THIS device only; not a cross-device or global scan.
- **No Firestore reconciliation:** Firestore reconciliation remains an external manual admin process outside the app.
- **No stock mutation:** `resolveManualReview` leaves the internal stock counter untouched.
- **Staff blocked:** Manager/Admin only; Staff cannot see or invoke the resolution action.

---

## Phase 7B-D1 — Project Context and Task Tracking Docs

**Status:** **CLOSED / COMMITTED**
**Commit:** `dacccd1` — `docs: add project context and task tracker`

| File | Purpose |
|------|---------|
| `Context.md` | Twinpet POS Project Context & System Rules |
| `Task.md` | This checkpoint tracker |

---

## Phase 7B-H2 — Manual Review Operational Guard

**Status:** **CLOSED / COMMITTED**
**Codex:** PASS WITH NOTES / Required Fixes: None
**Tech Lead:** APPROVED / COMMIT AUTHORIZED
**Commit:** `8b48513` — `feat(pos): add manual review resolution state`

---

## Checkpoint goal (H2)

When a Manager/Admin reconciles Firestore stock but a device still has a `manual_review_required` offline intent, the POS overlay keeps showing a **ghost delta**. H2 adds a **local-only** transition to `manual_review_resolved` so that device stops overlaying — without rolling back the local correction or touching server state.

---

## What is done (this checkpoint)

| Item | State |
|------|-------|
| New status `manual_review_resolved` + `manualReviewResolution` audit block | Done |
| Pure helpers: eligibility, guard, build (`offlineReversalLogic.ts`) | Done |
| `resolveManualReview()` orchestration (`offlineReversalQueue.ts`) | Done |
| Overlay excludes `manual_review_resolved` (doc comment updated) | Done |
| Tests: `manualReviewResolution.test.ts` (15), overlay (19), queue (28), logic (16) | Green |
| Full web unit suite | 274 passed (23 files) |
| Playwright `pos-safety.spec.ts` | 2 passed |
| `resolveReversal.test.ts` (server) | 29 passed — **unchanged** |

### Approved H2 semantics (do not reinterpret)

- **Local stock counter NOT touched**; `localCorrection.reversed` stays `false`.
- **Outcomes:** `resolved | already_resolved | not_found | not_eligible`; throws only for authority / missing actor / missing reason.
- **Eligibility:** only `manual_review_required` with `applied && !reversed`. `server_rejected` is **not** resolvable.
- **Idempotent:** second call → `already_resolved`, metadata preserved.
- **Multi-device propagation:** deferred (per-device only).

---

## What is NOT in scope (H2 / D1)

- Admin UI for manual-review resolution
- Server / rules changes (`resolveReversal.ts` unchanged)
- `stash@{0}` / Flowbite migration
- Transfer-logic refactor
- Completed-transfer queue-first reversal
- Multi-device broadcast of resolution

---

## D-track context (7B-3D — foundation, not H2 scope)

Already on mainline before H2:

| Track | Delivered |
|-------|-----------|
| **7B-3D-2** | Server `resolveReversal` callable |
| **7B-3D-3** | Offline reversal queue + IndexedDB correction |
| **Post-commit integration** | Receiving/Transfer/POS wired + `reversalStockOverlay` |
| **7B-H1** | Receiving `reversalEvidence` header snapshot |

H2 sits on this stack; it does not replace or modify the server resolver.

---

## Open actions (D1 checkpoint)

| # | Action | Owner | Status |
|---|--------|-------|--------|
| 1 | Codex review of `8b48513` (H2 commit) | Codex | **Done** — PASS WITH NOTES |
| 2 | Paranoid Checklist pass on H2 diff | Codex | **Done** |
| 3 | Tech Lead go/no-go for H2 | Gemini | **Done** — APPROVED |
| 4 | Commit `Context.md` + `Task.md` (docs-only) | Developer | **Ready** |
| 5 | Tech Lead decides next implementation track | Gemini | **Done** — H3 (Manual Review Ops UI) implemented |

---

## Files in H2 scope (reference)

```
src/lib/pos/offline/offlineReversalTypes.ts
src/lib/pos/offline/offlineReversalLogic.ts
src/lib/pos/offline/offlineReversalQueue.ts
src/lib/pos/offline/reversalStockOverlay.ts          (doc comment only)
src/lib/pos/offline/manualReviewResolution.test.ts   (NEW)
src/lib/pos/offline/reversalStockOverlay.test.ts
```

---

## Forbidden touch list (all agents)

- `functions/**` (especially `resolveReversal.ts`)
- `firestore.rules`
- `Android/**`
- `.claude/settings.local.json`
- Settings / UOM files in `stash@{0}`
- `rp.md` (personal scratchpad — not part of project commits)
- `docs/reports/latest-report.md` (unless explicitly tasked to update)

---

## H2 closeout (recorded)

- Codex: **PASS WITH NOTES** — no required fixes.
- Tech Lead: **APPROVED** — commit authorized.
- Deferred (not H2 blockers): Admin UI for manual-review resolution; multi-device propagation; completed-transfer queue-first reversal.
