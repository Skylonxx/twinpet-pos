# Twinpet POS — Project Context & System Rules

> Root context for all agents. Read this before `Task.md`, `AGENTS.md`, and role/skill docs.

---

## What this is

Twinpet is a **multi-branch pet retail ERP/POS** (2–3 branches). Single React codebase targeting web now and Capacitor native later.

**Core domains:** POS · Inventory · Receiving · Suppliers · Customers · Reports

**Production anchors:** Firebase project `twinpet-pos` · region `asia-southeast1` · Firestore database `pos-db`

---

## Non-negotiable system rules

1. **Inventory accuracy > speed.** Stock truth must not silently diverge.
2. **No duplicate source of truth.** One authoritative path per mutation.
3. **Prefer Firestore transactions** for stock changes that must be atomic.
4. **Every schema change** must consider existing collections and legacy docs.
5. **Multi-branch support must not break.** Branch scoping is a first-class constraint.
6. **Offline-first POS.** Checkout and destructive intents are client-first; server settlement is async. Never block checkout on stock verification. Use async-safe wording (`Pending sync`, not false “completed”).
7. **Oversell is allowed.** POS must not block a sale; reconciliation happens server-side.
8. **FIFO costing.** Stock cuts from `stockLots` ordered by `receivedAt` ASC. POS reads `productStocks.totalStockBase` — do not sum lots in the UI.
9. **Defense in depth.** Security must not rely on UI-only gates. Rules + server paths enforce authority.
10. **Do not assume correctness because it compiles.** Evidence required.

---

## Architecture mandates

- **Single React codebase** — no React Native rewrite; Capacitor for native shell when ready.
- **Offline durability:** browser IndexedDB + Firestore persistence today; native durable storage (e.g. Capacitor SQLite) planned for critical queues.
- **Server-authoritative settlement:** `reconcileOrder`, `resolveReversal`, `retryReconcile` own reconcile/reversal fields clients must not spoof. The reversal resolver additionally enforces a **stale-client guard** (Phase 7B-H4): a reversal whose client-observed document version is older than the live server `updatedAt` is rejected (`stale_client_observation`) before any mutation.
- **Hardware later:** printer/scanner integrations behind adapter interfaces — no web-only assumptions baked into core logic.

See `docs/skills/SKILL-GLOBAL-ARCHITECTURE.md` and `docs/skills/SKILL-OFFLINE-FIRST-POS.md`.

---

## Agent workflow

| Layer | Location | Purpose |
|-------|----------|---------|
| Roles | `docs/ai-roles/` | Who does what (developer, reviewer, tech-lead, …) |
| Skills | `docs/skills/` | Project-specific constraints (UI, rules, evidence, routing) |
| Reports | `docs/reports/latest-report.md` | Rolling phase history and evidence |
| Risks | `docs/reviews/baseline-risk-review.md` | Architecture risk baseline |

**Prompt routing:** Execute only when explicitly addressed (`TO: Cursor Agent`, `TO: Codex`, etc.). Naming a role file alone is not permission. See `AGENTS.md`.

**Developer gate:** Run `docs/skills/SKILL-DEVELOPER-SELF-REVIEW.md` before requesting Codex review.

**Reviewer gate:** Run Paranoid Checklist in `docs/ai-roles/reviewer.md` before approve/pass/close.

---

## Hard restrictions (unless Tech Lead / CEO explicitly approves)

| Do NOT | Reason |
|--------|--------|
| Touch `stash@{0}` | Flowbite/UI migration WIP — conflict risk |
| Apply/drop/modify Flowbite stash | Same |
| Refactor transfer logic | Dedicated future track |
| Deploy / delete live functions | Environment-auditor + explicit approval only |
| Modify rules/functions outside approved scope | Security surface |
| Expand scope without approval | Scope discipline |

---

## Key offline-reversal concepts (Phase 7B)

Phase 7B delivers a complete offline reversal lifecycle for Goods-Receiving and Transfer voids. The following tracks are closed and committed:

- **7B-3D-2** — server resolver `functions/src/resolveReversal.ts`: Cloud Function that authorizes and applies a reversal server-side. Unchanged throughout Phase 7B.
- **7B-3D-3** — client offline reversal queue + local IndexedDB correction + POS overlay: a Manager/Admin can reverse offline, correct local stock immediately in IndexedDB, and queue the intent for server settlement on reconnect. The POS overlay (`reversalStockOverlay`) surfaces pending reversal deltas in the inventory grid.
- **7B-H1** — receiving header `reversalEvidence` snapshot (fail-closed at reversal): completion atomically persists a lot-effect-segment evidence set; reversal uses the header as the authoritative source of truth, or fails closed.
- **7B-H2** — `manual_review_required → manual_review_resolved` local transition: when a Manager/Admin has reconciled Firestore stock externally, they can locally clear a `manual_review_required` intent so the POS overlay on that device stops showing the pending delta. The local stock counter is **not** touched; the correction history is preserved for audit. Eligibility is `manual_review_required` with `applied && !reversed` only.
- **7B-H3** — local/device-visible Manual Review Ops UI (CLOSED / COMMITTED — `4d69143`): a Manager/Admin-only page (`/manual-review`) that lists `manual_review_required` intents **from this device's local IndexedDB queue only** and provides a controlled action to execute the H2 `resolveManualReview` transition. **This is NOT a global Firestore admin dashboard** — it cannot see other devices' or branches' queues. It does **not** perform Firestore reconciliation (that remains an external manual admin process outside the app). It does **not** mutate stock directly. Staff cannot access it.
- **7B-H4** — server-side stale-client guard in `resolveReversal.ts` (CLOSED / COMMITTED — `4da7757`): rejects reversals where `clientObservedDocumentUpdatedAt` is older than the live server `updatedAt` with structured reject code `stale_client_observation` (status `rejected`). Mutation-free: zero stock, zero lots, no state advance, no audit/intent-ledger write on a stale rejection. Guard is placed after authority check and before every status check and write in both `resolveReceivingReversal` and `resolveTransferReversal`. Conservative: absent observation ⇒ not stale; equal instants ⇒ fresh. **Accepted hidden risk (CEO Option B):** the guard is partially inert in production until `clientObservedDocumentUpdatedAt` is populated by the client/offline resolver payload — that wiring is the H5 follow-up.

- **7B-H5** — Wire Client Observation Timestamp Payload (receiving-only, CLOSED / COMMITTED — `4762d97`): the live receiving void path now captures the loaded receiving doc's `updatedAt`, converts it defensively to ISO 8601 (`toObservedDocumentUpdatedAtIso`), persists it on the durable offline intent as the internal field `observedDocumentUpdatedAt`, and `toResolveRequest` forwards it to the resolver as `clientObservedDocumentUpdatedAt` — so the H4 guard is active end-to-end for receiving reversals. Backward compatible (legacy intents omit the field; H4 stays inert/fresh), idempotency unchanged (observation excluded from id derivation), local stock correction unchanged. **No server resolver change.** Transfer wiring, manual-review server calls, global Admin UI, and multi-device propagation remain out of scope. **Milestone: End-to-End Receiving Reversal Hardening is functionally complete** (H4 server-side guard + H5 client payload wiring together).

- **7B-H6-C** — Server Resolver Activation (CLOSED / COMMITTED — `68f46e2`): the transfer reversal resolver is activated for the live model: eligibility is centralized in `isTransferStatusReversible(status)` with `REVERSIBLE_TRANSFER_STATES = {'completed'}`, so a `completed` transfer is admitted into the existing strict guards (authority, stale-client, already-reversed, dest stock/lot sufficiency, idempotency/audit) — never unconditionally reversible. No client/UI/offline-queue change; activation was latent until H6-D client wiring.

- **7B-H6-D1** — Latent queue-first transfer executor (COMMITTED — `4aa8065`): `executeTransferReversal` mirrors the receiving executor (fail-closed validation, dual-branch effects, queue-first create + sync) but was NOT wired into any UI; superseded by H6-D2.

- **7B-H6-D2** — UI Route Wiring & Legacy Path Retirement (CLOSED / COMMITTED — `bb30881`): `decideReversalRoute('transfer')` returns `transfer_queue_first`; `TransferHistoryPage` + `AdminTransferPage` route the confirmed cancel through `executeTransferReversal` queue-first and the legacy direct `cancelBranchTransfer` is RETIRED from both pages (a `canBranchReverseTransfer` origin-branch gate blocks destination-only users in the branch-scoped page). `cancelBranchTransfer`/`editBranchTransfer` in `transferCrud.ts` untouched. D2-α removed the stale `TRANSFER_REVERSAL_DEFERRED_NOTE` and tightened whitespace validation.

- **7B-H6-E1** — Transfer `updatedAt` Stamping (CLOSED / COMMITTED — `8a3d03f`): `confirmBranchTransfer` and `devConfirmBranchTransfer` stamp `updatedAt` at transfer completion alongside `createdAt`, activating the transfer stale-client guard end-to-end for new transfers. Timestamp-only: no evidence/checksum snapshot, no resolver/offline-queue change, no legacy backfill.

- **7B-H6-E2-A** — Pure Transfer Evidence Builder + Dual-Branch Invariant (CLOSED / COMMITTED — `53a2123`): new pure file `src/lib/inventory/transferReversalEvidence.ts` with `buildTransferReversalEvidence` builder and `assertTransferReversalEvidenceCoversCompletion` invariant. 41 tests covering evidence math, dual-branch balance, and branch-direction binding. No runtime wiring, no header write, no coordinator validation.

- **7B-H6-E2-B** — Write Transfer Evidence Header at Completion (CLOSED / COMMITTED — `82d3352`): `reversalEvidence?: TransferReversalEvidence` added to `InventoryTransfer` in `transferTypes.ts`; `confirmBranchTransfer` builds + asserts + persists evidence atomically in the Phase-3 `tx.set`; `devConfirmBranchTransfer` mirrors this. Evidence `createdAt` is a client ISO string; header timestamps remain server-authoritative. No coordinator validation.

**Transfer Reversal Evidence sequence: FULLY CLOSED / COMMITTED**

- **H6-E2-A** — Pure Transfer Evidence Builder + Dual-Branch Invariant — CLOSED / COMMITTED — `53a2123`
- **H6-E2-B** — Write Transfer Evidence Header at Completion — CLOSED / COMMITTED — `82d3352`
- **H6-E2-C** — Transfer Evidence Coordinator Validation — CLOSED / COMMITTED — `fe3ff44`

- **7B-H6-F1** — Transfer Reversal Evidence Rejection Visibility (CLOSED / COMMITTED — `3a3d202`): UI/display-only — `getTransferReversalEvidenceMessage(code)` maps each `TransferReversalEvidenceCode` → friendly Thai message; transfer cancel pages surface the message + raw code when a `TransferReversalEvidenceError` is caught; Manual Review Ops shows a read-only `evidenceSource` column via a page-local label helper. No validation/fail-closed/offline-queue-schema/`src/lib/pos/offline`-runtime/server-resolver/transfer-write-path change.

- **7B-H6-G1** — Receiving Evidence Rejection Visibility & Void Error Handling (CLOSED / COMMITTED — `e80b2a3`): UI/error-visibility only — receiving symmetric counterpart of F1. `getReceivingReversalEvidenceMessage(code)` maps each `ReceivingReversalEvidenceCode` → friendly Thai message; `ReceivingEditPage.handleVoid` wrapped in try/catch — `ReceivingReversalEvidenceError` re-thrown with friendly message + raw code to `ReceivingForm`'s existing void-dialog banner (non-evidence errors re-thrown unchanged). Audit confirmed rejection was already caught generically; `AdminReceivingPage` uses legacy `cancelReceiving` path (no parity needed). No validation/fail-closed/offline-queue/`src/lib/pos/offline`/server-resolver/transfer-behavior change. Durable local rejection logging deferred.

**Transfer and Receiving fail-closed visibility paths are both closed.**

**Current clean baseline:** `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`

**Next step:** read-only strategic planning for the next major initiative.

### H6 Transfer State Model — Architecture Decision (CEO Option A)

Current production Transfer state model is two-state: `completed` | `cancelled`. Live transfers are created directly as `completed`. **At the H6-B audit (point-in-time, since superseded):** the `resolveTransferReversal` server branch was dormant because it gated on `sent`/`received` — states no live transfer carries. **H6-C has since activated the resolver for `completed` transfers under strict server-authoritative guards** (committed `68f46e2`); this paragraph records the decision rationale, not the current state.

**CEO decision:** `completed` is approved as the reversible state for queue-first Transfer Reversal. This means "eligible for reversal under strict server-authoritative guards," NOT "always reversible." The same guard stack applies: authority, stale-client, idempotency, already-reversed, stock/lot sufficiency.

**Full `sent → received → completed` lifecycle refactor is deferred and not part of the H6 implementation track.**

**H6-C implementation constraints (when authorized):**
- Reversible-state eligibility must be centralized in one helper — do not scatter `status === 'completed'` checks.
- Destination stock/lot sufficiency required before reversal.
- Source lot restoration must preserve original cost and `receivedAt` evidence.
- Stale-client guard must remain active when client payload is wired.
- Idempotency and already-reversed checks mandatory.
- No transfer lifecycle refactor unless separately authorized.

**Future scalability:** If a `sent → received → completed` workflow is introduced later, only the centralized eligibility helper needs to change — not resolver logic everywhere. This is controlled technical debt, not blocking debt.

**Key boundaries that must be preserved:**

- Firestore reconciliation of stock is always an **external manual admin process** — no part of the Phase 7B client UI automates it.
- The H3 UI is **per-device and per-branch local only** — a global ops dashboard across devices or branches does not exist.
- Staff cannot resolve `manual_review_required` intents — Manager/Admin only.
- The H4 stale-client guard is fully active end-to-end for the **receiving** path (H5 committed). For transfers, **H6-C activated the server resolver for `completed` transfers under strict guards (committed `68f46e2`), H6-D1 added the latent queue-first executor (`4aa8065`), H6-D2 wired the targeted UI surfaces to queue-first reversal (legacy direct cancel retired), H6-E1 stamps `updatedAt` at completion, H6-E2-A built the pure evidence builder + dual-branch invariant (committed `53a2123`), H6-E2-B persists `reversalEvidence` atomically on the transfer header at completion (committed `82d3352`), H6-E2-C makes the coordinator PREFER and fail-closed-validate that header evidence at reversal time (committed `fe3ff44`), H6-F1 surfaces operator-visible Thai rejection messages + raw code for transfer evidence errors (committed `3a3d202`), and H6-G1 surfaces operator-visible Thai rejection messages + raw code for receiving evidence errors via `ReceivingEditPage.handleVoid` (committed `e80b2a3`)** — server resolver remains unchanged and authoritative (re-reads items). No offline queue schema change; `src/lib/pos/offline` has no diff in either visibility slice. **Transfer and Receiving fail-closed visibility paths are both closed; durable local rejection logging deferred.**

---

## Evidence standard

Never claim success without proof. Reports must distinguish **passed / failed / not run / deferred**. See `docs/skills/SKILL-RELEASE-EVIDENCE.md`.
