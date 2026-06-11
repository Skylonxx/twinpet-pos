# Current Task Tracker — Phase 7B-H5 (implemented, awaiting Codex re-review)

> Living checkpoint doc for agents. Detailed history: `docs/reports/latest-report.md` (do not duplicate long-form evidence here).

## Current active phase

**Phase 7B-H5: Wire Client Observation Timestamp Payload**
**Status:** **IMPLEMENTED — AWAITING CODEX RE-REVIEW** (not committed; not closed). See the H5 section below for the full package.

**Clean baseline before H5:** `fb4c3b0 docs: sync phase 7b tracker after h4 closure`.

---

## Phase 7B-D3 — Docs/Context Sync After H4 Closure

**Status:** **CLOSED / COMMITTED**
**Commit:** `fb4c3b0` — `docs: sync phase 7b tracker after h4 closure`

Docs-only sync pass after Phase 7B-H4 was closed and committed (`4da7757`). Recorded H4 as CLOSED/COMMITTED, advanced the baseline to the H4 commit, and queued H5. No source code or tests modified. D3 is no longer active.

---

## Phase 7B-H5 — Wire Client Observation Timestamp Payload

**Status:** **IMPLEMENTED — AWAITING CODEX RE-REVIEW** (not committed; not closed. Codex GPT-5.5 re-review + CEO approval required before closure)
**Authorization:** Option A — APPROVED (receiving-only)
**Codex (prior pass):** REJECTED for stale docs/tracker wording only — code/tests/scope confirmed correct; this docs/tracker correction resolves that blocker.

### Goal

Wire `clientObservedDocumentUpdatedAt` into the offline/client resolver payload so Phase 7B-H4's server-side stale-client guard becomes active end-to-end for the **live receiving reversal flow**.

### What was delivered (receiving-only payload wiring)

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

- Transfer reversal wiring (routes to the legacy executor; resolver transfer path dormant).
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
