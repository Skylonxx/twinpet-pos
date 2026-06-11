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

**Current baseline before H6-C:** `7bd74c1 docs: record transfer reversal state model architecture decision`

**Active slice:** Phase 7B-H6-C — Server Resolver Activation + Tests (server resolver + tests only; implemented, awaiting Codex review; not committed). The transfer reversal resolver is activated for the live model: eligibility is centralized in `isTransferStatusReversible(status)` with `REVERSIBLE_TRANSFER_STATES = {'completed'}`, so a `completed` transfer is admitted into the existing strict guards (authority, stale-client, already-reversed, dest stock/lot sufficiency, idempotency/audit) — never unconditionally reversible. **No client routing, UI, offline-queue, or legacy `cancelBranchTransfer` change** — activation is latent in production until the future H6-D client wiring.

### H6 Transfer State Model — Architecture Decision (CEO Option A)

Current production Transfer state model is two-state: `completed` | `cancelled`. Live transfers are created directly as `completed`. The existing `resolveTransferReversal` server branch is dormant because it gates on `sent`/`received` — states no live transfer currently carries.

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
- The H4 stale-client guard is fully active end-to-end for the **receiving** path (H5 committed). The transfer resolver path is dormant — H6-C will activate it for `completed` transfers, but H6-C is planning-only until Tech Lead approves; no Transfer resolver code may be written yet.

---

## Evidence standard

Never claim success without proof. Reports must distinguish **passed / failed / not run / deferred**. See `docs/skills/SKILL-RELEASE-EVIDENCE.md`.
