# Latest Report

> Rolling "latest report" for the stock-write security workstream. Updated at each phase boundary.
> **Current state:** Phase 2 Track B **Step 1 COMPLETE** (backend/rules retry safety + full client-write lockdown). Admin UI (Step 2) is **proposed only — not implemented**. Track A + Phase 1 + Phase 0 retained below.

---

## Phase 2 — Track B, Step 1 FINAL: paranoia tests + Step 1 closed

**Track B Step 1 is COMPLETE.** Backend retry safety + the full `asyncOrders` client-write lockdown are done and tested. This final patch is **test-only** (no rules/functions/behavior change) plus a Step 2 UI proposal (see below).

### Paranoia tests added (rules, test-only)
- **absent→null on protected fields:** explicit denial that a `pos_void` client can write `null` to a server-owned reconcile/audit field that is ABSENT on the stored doc (`reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`, `reconciledAt`). The `diff().affectedKeys().hasOnly(...)` gate denies these because absent→null is an *added* key.
- **create reconciledAt spoofing:** explicit denial of a non-null `reconciledAt` on create (settled-timestamp spoof), plus proof that `reconciledAt: null` (the safe initial value POS checkout uses) is allowed.

### Test results
- Rules: **83 passed (4 files)**.
- Functions: **43 passed (5 files)** — unchanged (no function code touched).

### Tech-debt note (deferred)
**Value-level constraints on the approved void fields are intentionally deferred** to a future hardening pass. The current rule allowlists *which* fields a `pos_void` client may change (`voidRequested`, `status`, `voidReason`, `voidedBy`, `voidedAt`, `updatedAt`, `deviceId`) but does not constrain their *values* (e.g. forcing `voidRequested == true` or `status == 'voided'`). Tightening values now risks breaking the legitimate offline POS void flow (which legitimately varies `voidReason`/`deviceId`/timestamps); it is logged as future work, not a Step 1 blocker.

### Admin UI
Not implemented. Proposed in **Track B Step 2** — see `docs/reports/phase-2-track-b-step2-admin-ui-proposal.md` and the summary + Paranoid Checklist below.

---

## Phase 2 — Track B, Step 1 PATCH: Restrict pos_void updates to approved void fields (RULES ONLY)

**Closes the Codex High finding.** Previously a `pos_void` client update only had reconcile/audit fields frozen, so it could still mutate **sale-payload** fields (`lines`, `payments`, `total`, `creditAmt`, `staffId`, `branchId`, …) — and `handleVoidIntent` reads reversal inputs from the async order. Now a `pos_void` client update may change **only approved void-intent fields**; everything else is frozen. Rules-only; no functions, no Admin UI, no transfer/UI-stash changes.

### Approved void-intent fields (the ONLY keys a pos_void update may change)
`voidRequested`, `status`, `voidReason`, `voidedBy`, `voidedAt`, `updatedAt`, `deviceId`.

- New rules helper `voidIntentChangesOnly()` uses `request.resource.data.diff(resource.data).affectedKeys().hasOnly([...approved])`. This is strictly stronger than the prior per-field freeze: it blocks **sale-payload mutation** AND **all server-owned reconcile/audit fields** in one gate, and (via diff) also denies absent→null writes on protected fields. `branchId` is intentionally NOT in the allowlist — the void merge re-writes the same value (not an affected key); any real change is denied.
- `safeInitialReconcileState` (create) now also constrains `reconciledAt` to the safe baseline (`null`), so a create can't spoof a settled timestamp.
- Trusted backend paths (Admin-SDK reconciler / `retryReconcile` callable) still write all these fields — they bypass rules.

### Tests run / results
- Rules: **71 passed (4 files)** — adds `pos_void` sale-payload denial tests (`lines`, `payments`, `total`, `creditAmt`, `staffId`, `branchId`), a "void + sneak sale-payload edit → whole update denied" case, and a FULL legitimate void merge (all approved fields) that still passes; existing reconcile/audit freeze, create-spoofing denials, and normal POS create all still pass.
- Functions: **43 passed (5 files)** — unchanged (no function code touched).

### Remaining gaps
None known on the `asyncOrders` client-write surface: create-spoofing and update-spoofing are both closed; `pos_void` updates are restricted to approved void-intent fields; reconcile/audit + sale-payload fields are frozen. Admin UI (exceptions list, badge, retry button) remains the only deferred Track B item (standalone route/component; Flowbite upgrade = backlog/docs only).

---

## Phase 2 — Track B, Step 1 PATCH: Freeze ALL server-owned reconcile/audit fields (RULES ONLY)

**Closes the Codex High finding.** The previous `asyncOrders` update rule froze only `reconcileStatus` + `reconcileAttempts`, so a `pos_void` client could still mutate other server-owned reconcile/audit fields. **Now ALL of them are frozen on client updates.** Rules-only change; no functions, no Admin UI, no transfer/UI-stash changes.

- New rules helper `reconcileAuditFrozen(req, res)` requires every server-owned field to be **unchanged** on a client update: `reconcileStatus`, `reconcileAttempts`, `reconciledAt`, `reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`. The `asyncOrders` update rule now gates on it (still requires `pos_void` + branch access).
- These fields move **only** via the Admin-SDK reconciler / `retryReconcile` callable, which bypass rules. Approved void fields (`voidRequested`, `status`, `voidReason`, `voidedBy`, `voidedAt`, `updatedAt`) remain writable, so the offline void-intent merge still works. POS checkout (create) and oversell are unaffected.

### Tests run / results
- Rules: **63 passed (4 files)** — adds a per-field update-denial test for each server-owned field (incl. `reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`, `reconciledAt`) + a "sneak an audit field into a void merge → whole update denied" case; normal POS create, approved void merge, and create-spoofing denials still pass.
- Functions: **43 passed (5 files)** — unchanged (no function code touched); retry admin-only, voidRequested+exception rejection, concurrent-retry idempotency, and successful-retry audit behavior all still green.

### Remaining gaps
None known for the client-write surface: create-spoofing and update-spoofing of server-owned reconcile/audit fields are both closed. Admin UI (exceptions list, badge, retry button) remains the only deferred Track B item (standalone route/component; Flowbite upgrade = backlog/docs only).

---

## Phase 2 — Track B, Step 1 FOLLOW-UP: Hardened Retry Guards (BACKEND/RULES ONLY)

**Still backend-only — no Admin UI implemented** (no page, no dashboard badge, no retry button, no Flowbite migration). `stash@{0}` untouched; no transfer refactor; no unrelated app changes. Closes the remaining safety gaps before any UI work.

- **Client spoofing on `asyncOrders` create is blocked.** New rules helper `safeInitialReconcileState` permits only the safe baseline (`reconcileStatus` absent or `'pending_reconcile'`) and forbids seeding any server-owned control field (`reconcileAttempts`, `reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`). Normal POS checkout + offline void-intent creates still pass.
- **Attempt counting is atomic/transaction-safe.** The exception path now writes `reconcileAttempts: FieldValue.increment(1)` (server-side increment against current stored state) instead of `priorAttempts + 1` from the (possibly stale) event payload — safe under duplicate trigger deliveries / concurrent attempts.
- **Concurrent retry is tested.** A simulated Admin double-click (two concurrent `performReconcileRetry`) re-arms **exactly once**: one fulfilled, one rejected (`failed-precondition`), `adminRetryCount == 1`, no stock/lot writes — proven against a serialized fake transaction.
- **voidRequested + exception conflict secured (tested).** Admin retry of an `exception` order with `voidRequested == true` is rejected (`failed-precondition`): not re-armed to `pending_reconcile`, no write, no stock mutation. The void path owns that order.
- **Audit preservation on successful retry.** New `buildRecoveryAuditPatch` (merged into `reconcileSale`'s settled write) **clears** the active error state (`reconcileError`/`lastReconcileError`/`lastReconcileErrorAt`/`firstFailedAt` via `FieldValue.delete()`) and, when a prior failure was recovered, **preserves** the sanitized previous error in `previousReconcileError` (+ `reconcileRecoveredAt`). Only the already-sanitized string is kept — never raw stack/internal detail.

### Tests run / results
- Functions: **43 passed (5 files)** — adds concurrent-retry idempotency, `buildRecoveryAuditPatch` (clear + history / first-time no-history), and atomic-increment assertions; existing reconcile/void/retry tests still green.
- Rules: **52 passed (4 files)** — adds create-spoofing denials (reconcileStatus/attempts/error/audit fields) + normal POS create + void-materialize create pass; Track A + Phase 1 still green.

### Still deferred (separate step)
Admin UI (exceptions list, dashboard badge, retry button) as a **standalone route/component**; the Flowbite upgrade for that UI remains **backlog/docs only**.

---

## Phase 2 — Track B, Step 1: Reconciliation Retry Safety (BACKEND ONLY)

**Scope executed = backend safety + tests + rules + docs only.** No Admin UI was implemented (no page, no dashboard badge, no retry button, no Flowbite migration). No transfer refactor, no UI/Flowbite `stash@{0}` changes, no unrelated app changes.

### Admin UI isolation strategy (for the later, separate step)
When the Admin UI is approved, it must be built as a **standalone component/route** (e.g. a dedicated "Reconciliation Exceptions" admin route + thin callable hook), and must **not** modify volatile layout/settings/navigation files that conflict with `stash@{0}` Flowbite work. The Flowbite upgrade needed for that future UI is **backlog/documentation only** at this time — not started here.

### What was implemented (backend)
- **Exception logging (enriched, sanitized):** on a failed settle, `reconcileOnWrite` now writes `reconcileStatus:'exception'`, `reconcileAttempts` (incremented), `lastReconcileError` + `lastReconcileErrorAt`, `reconciledAt`, and — **only on the first failure** — `reconcileError` + `firstFailedAt` (preserved debugging anchor). All admin-facing error fields go through `sanitizeReconcileError` (message only, single-lined, truncated to 300 chars). The raw/full error stays in Cloud Functions logs via the rethrow — never in Firestore.
- **Retry trigger (callable, admin-only):** new `retryReconcile` `onCall` (`functions/src/retryReconcile.ts`), core extracted as `performReconcileRetry(db, orderId, auth)` for unit testing. Requires `auth.token.role === 'admin'`; normal staff/clients cannot use it.
- **Server-owned status:** `firestore.rules` `asyncOrders` update tightened so non-admin clients **cannot** flip `reconcileStatus` or `reconcileAttempts` (immutable across client updates); the legitimate offline void-intent merge still passes. Reconcile state moves only via the Admin-SDK reconciler / callable (which bypass rules).

### Retry CAP = 3
`RECONCILE_RETRY_CAP = 3` total settlement attempts (initial automatic failure + admin retries combined; `reconcileAttempts` counts every failed settle, `adminRetryCount`/`lastRetryBy`/`lastRetryAt` give admin-retry audit). At/over the cap the callable refuses with `resource-exhausted` → **manual investigation required**.

### Idempotency strategy (no double stock deduction)
`reconcileSale` settles in **one atomic transaction**, so an `exception` means **nothing committed** → re-running cannot double-deduct. The callable **never calls `reconcileSale`**; it only transactionally re-arms `exception → pending_reconcile`, and the existing trigger re-runs the guarded settle (whose in-transaction `reconcileStatus !== 'pending_reconcile'` guard makes stale/duplicate deliveries no-ops). An already-`settled` order is a safe no-op; a non-`exception` order is rejected.

### voidRequested + exception handling
A `voidRequested` exception order is **never** re-armed to `pending_reconcile` (the callable rejects it with `failed-precondition`) — the void path owns it (the trigger routes `voidRequested → handleVoidIntent` first). Defined in code and covered by tests.

### Manual console repair = emergency-only fallback
Directly editing `reconcileStatus` in the Firestore console remains an **emergency-only** fallback and is **not normal operation**. The governed, audited path is the `retryReconcile` callable (admin-only, capped). Settled-but-orphaned read-model repair stays the separate `sweeper` tooling.

### Tests run / results
- Functions: **40 passed (5 files)** — adds `retryReconcile.test.ts` (admin-only; re-arm + idempotency; cap; voidRequested) and extends `reconcileException.test.ts` (attempt increment, first-error preservation, `sanitizeReconcileError` truncation/single-line). Existing reconcile/void behavior still green.
- Rules: **47 passed (4 files)** — adds `async-orders-phase2b.spec.ts` (non-admin cannot flip `reconcileStatus`/`reconcileAttempts`; legit void merge still passes; non-`pos_void` still blocked). Track A + Phase 1 still green.

### Deferred to the next (separate) step
Admin UI: exceptions list page, dashboard badge, retry button, and the Flowbite upgrade for that UI — **not implemented here**.

---

## Phase 2 — Track A: stockLots Write Hardening (COMPLETE)

**Status: Track A complete.** `stockLots` write hardening is finished: create is permission-gated and requires a branchId, update is permission-gated and the `branchId` invariant is enforced (immutable + non-removable). `stockLots` read behavior is intentionally unchanged. **Track B (reconciliation exception handling) remains deferred.**

### Rules (`firestore.rules`, `stockLots/{lotId}`) — final Track A state
- `allow create: if isStaff() && canMutateStock() && request.resource.data.branchId is string;`
- `allow update: if isStaff() && canMutateStock() && request.resource.data.get('branchId', null) == resource.data.branchId;`
- `allow read: if isStaff();` — **UNCHANGED** (intentional).
- `allow delete: if isManagerOrAdmin();` — **UNCHANGED**.

`canMutateStock()` (added in Phase 1) = `isAdmin()` OR any of `stock_receive` / `product_edit` / `pos_void` / `product_view`. It blocks `pos_sale`-only cashiers from fabricating/rewriting lot qty/cost, while preserving receiving (`stock_receive`), staff-initiated transfer dest-lot creation (regular staff carry `product_view`), and void restock (`pos_void`).

**branchId invariant (enforced + tested):** on create `branchId` must be present and a string; on update it must stay present and **equal** the existing value (`.get(_, null)` gives a clean deny on removal). Cross-branch dest-lot creation by stock-capable staff is intentionally still allowed (branch isolation of that leg is a later phase).

### Tests
- `rules-tests/stock-lots-phase2.spec.ts` (replaced the Phase 0 characterization spec): pos_sale-only create/update **DENIED**; create without `branchId` **DENIED**; **branchId mutation on update DENIED**; **branchId removal on update DENIED**; valid same-branchId update **ALLOWED**; receiving/transfer/void create+update **ALLOWED**; reads + delete **unchanged**.

### Test results
- Rules: **43 passed (3 files)** — `product-stocks-phase1`, `stock-lots-phase2`, `firestore-permissions`.
- Functions: **25 passed (4 files)** — unchanged (no function code touched).

### Behavior preserved
stockLots **reads intentionally unchanged** (cross-branch visibility / transfer planning / aggregate reporting intact); staff-initiated transfers; receiving; void restock; oversell/negative stock; productStocks Phase 1 behavior (still green); delete still manager/admin-only.

### Not touched
Track B / reconciliation logic, transfer refactor, `productStocks` rules, UI/Flowbite `stash@{0}`, app behavior.

---

## Phase 1 — productStocks Rules Hardening

### 0. Packaging (finalized)
Phase 1 was reviewed by Codex; packaging finalized (Phase 2 not started). The Phase 1 change set is **staged** (git index), separated from unrelated work:

**Staged (Phase 1 change set):**
- `firestore.rules` (modified)
- `docs/reports/latest-report.md` (added)
- `rules-tests/product-stocks-phase1.spec.ts` (added)
- `rules-tests/stock-lots-phase0.spec.ts` (added)
- `functions/src/reconcileException.test.ts` (added)

**Deliberately NOT in the Phase 1 change set:** `stash@{0}` (Batches 1–3 UI/settings work), and untracked `docs/reports/phase-0-characterization.md` (Phase 0 artifact), `.cursor/`, `AGENTS.md`, `docs/reviews/`.

**Re-verified results:** rules **36 passed (3 files)**; functions **25 passed (4 files)**. No productStocks logic change was required (no packaging/test mismatch).

### 1. Housekeeping summary
Before touching any rules/tests, the working tree was inspected. It carried unrelated tracked modifications from earlier batches (1–3: Flowbite UI / settings / UOM / transfer-UI). To avoid mixing UI refactoring with security hardening, those were **stashed** (reversible) so the Phase 1 staged package contains only the security-hardening artifacts: `firestore.rules`, `docs/reports/latest-report.md`, `rules-tests/product-stocks-phase1.spec.ts`, `rules-tests/stock-lots-phase0.spec.ts`, and `functions/src/reconcileException.test.ts`. Pre-existing **untracked** items (`.cursor/`, `AGENTS.md`, `docs/reviews/`) were left in place (they cannot leak into a tracked diff).

### 2. Files committed / stashed / separated before Phase 1
Stashed as `stash@{0}` — "WIP: Batches 1-3 UI/settings/UOM/transfer-UI (unrelated to stock-security Phase 1)":
`rp.md`, `src/lib/settings/devMock.ts`, `src/lib/settings/settingsNav.ts`, `src/lib/settings/systemTypes.ts`, `src/lib/settings/useUomUnits.ts`, `src/lib/types.ts`, `src/pages/SettingsPage.tsx`, `src/pages/inventory/TransferHistoryPage.tsx`, `src/pages/inventory/TransferPage.tsx`, `src/pages/settings/DocumentSettings.tsx`. Restore later with `git stash pop`.

### 3. Phase 1 files changed
- `firestore.rules` — productStocks hardening (the only rules-logic change in the package).
- `rules-tests/product-stocks-phase1.spec.ts` — added (replaces `product-stocks-phase0.spec.ts`, which was removed).
- `rules-tests/stock-lots-phase0.spec.ts` — unchanged (stockLots not in this phase).
- `functions/src/reconcileException.test.ts` — unchanged (Phase 0).
- `docs/reports/latest-report.md` — this report.

### 4. Rules changes summary
`products/{pid}/productStocks/{branch}` and the `collectionGroup('productStocks')` block were both hardened identically (rules grant on the **union** of matching blocks, so both must match):
- **Anti-spoof:** `request.resource.data.branchId == <docId>` is now required → branchId spoofing is impossible.
- **Permission gate:** writes require `canMutateStock()` (a new helper) — `isAdmin()` OR any of `stock_receive` / `product_edit` / `pos_void` / `product_view`. This **blocks pos_sale-only cashiers** while keeping regular staff (who carry `product_view`) able to initiate transfers.
- **Removed broad `allow write: if isStaff()`** → replaced with scoped `allow create, update`.
- **Delete is genuinely admin-only:** split into `allow create, update` + `allow delete: if isAdmin()`, so delete is no longer silently subsumed by a broad `write`.
- Removed the spoof-enabling `requestProductStockBranchId()` helper (now unused).

### 5. Tests updated
Phase 0 characterization (`product-stocks-phase0.spec.ts`) was converted into Phase 1 expected-behavior (`product-stocks-phase1.spec.ts`): the insecure cases (branchId spoof, pos_sale-only write, staff delete) now assert **DENIED**; own-branch writes, the cross-branch transfer-dest write, admin delete, and oversell assert **allowed**. Added a manager (non-admin) delete-denied case.

### 6. Test results
- Rules: **36 passed (3 files)** — `product-stocks-phase1`, `stock-lots-phase0`, `firestore-permissions`.
- Functions: **25 passed (4 files)**.

Acceptance criteria: all rules + function tests pass; Phase-0 insecure cases now fail (spoof, pos_sale-only, non-admin delete); own-branch ops pass; admin delete passes; non-admin delete fails; oversell preserved; staff-initiated transfer preserved.

### 7. Behavior intentionally preserved
- **Oversell / negative stock** — sales never reach these rules (POS checkout decrements via the `reconcileOrder` Cloud Function / Admin SDK, which bypasses rules); no client-side POS stock write was added.
- **Staff-initiated branch transfers** — the cross-branch destination write stays allowed (stamps `branchId == toBranch == docId`; regular staff carry `product_view`).
- **Receiving** — manager/admin carry `stock_receive`/`product_edit` → still write stock.
- **Void restock** — `pos_void` qualifies under `canMutateStock()`.

### 8. Known remaining risks
- **Cross-branch write breadth (accepted for now):** any stock-capable staffer can still write *another* branch's stock (needed for the transfer dest leg, since rules can't tell a transfer from an arbitrary write). branchId-spoof is closed, but branch isolation of the dest leg is not — that is Phase 2.
- **`stockLots` writes** were unscoped at Phase 1 time — **now hardened in Phase 2 Track A** (permission gate + branchId invariant); see the Phase 2 section above.
- **`product_view` as a write gate is intentionally weak** — it draws the line between a pos_sale-only terminal and a real staffer, not true least-privilege.
- **Value integrity** (absolute vs increment) is not enforceable in rules — only a Cloud Function can guarantee it.

### 9. Recommended Phase 2 note — transfer destination write isolation
Move the branch-transfer **destination** stock/lot write (and the cancel-reversal counterparty write) into a Cloud Function (Admin SDK), so the client only writes its **own** branch plus the `inventoryTransfers` doc. Once no legitimate cross-branch client write remains, tighten these rules further to `hasBranchAccess(stockBranchId)` for all client writes — closing the residual cross-branch breadth. This requires a transfer-flow refactor (explicitly deferred from Phase 1) and should be scoped/approved separately. The same `stockLots` hardening (branch scoping + transfer-dest carve-out) should ride along in that phase.

---

## Phase 0 — Stock-Write Risk Characterization (Option C)

### 1. Phase 0 summary
Read-only characterization of current Firestore-rules behavior for stock writes, scoped to `productStocks` write access, `stockLots` write access, and reconciliation exception handling. No `firestore.rules`, Cloud Function, transfer-flow, or app-behavior changes were made — only characterization tests and reporting. Finalized business decisions applied: (1) regular staff may execute branch transfers; (2) oversell/negative stock is allowed and POS must never block a sale; (3) Phase 0 is done when all Critical + highly-impactful High risks are proven with tests.

### 2. Tests added/updated
| File | Type | Status |
|---|---|---|
| `rules-tests/product-stocks-phase0.spec.ts` | rules (emulator) | added/updated |
| `rules-tests/stock-lots-phase0.spec.ts` | rules (emulator) | added |
| `functions/src/reconcileException.test.ts` | functions unit | added |

### 3. Test results
- Rules suite: **33 passed (3 files)** under `firebase emulators:exec --only firestore --project demo-twinpet "npx vitest run --config vitest.rules.config.ts"`.
- Functions suite: **25 passed (4 files)** under `npm --prefix functions run test:unit`.

### 4. Current behavior proven
- **productStocks writes are effectively `isStaff()` only** (two match blocks → permissive union; broad nested `allow write: if isStaff()` wins). Reads ARE branch-isolated.
- **`allow delete: if isAdmin()` is a NO-OP** — `allow write` subsumes delete, so any staff can delete any stock doc, including cross-branch.
- **branchId spoof passes** — writing branch B's doc while stamping `branchId:"A"` succeeds (payload trusted over doc id).
- **No permission scoping** — a `pos_sale`-only cashier can mutate stock.
- **Oversell never blocked** — sale create has no stock check; the Admin-SDK decrement (`reconcileOrder.ts:375-388`) has no sufficiency guard and may go negative (rules-exempt).
- **stockLots read/create/update = `isStaff()`**, no branch scoping, arbitrary qty/cost; **delete IS genuinely manager/admin-only** (explicit `delete` clause, not subsumed).
- **Reconcile exceptions are surfaced**: a failing sale settle is stamped `reconcileStatus:'exception'` + `reconcileError` and rethrown; already-`exception`/`settled` docs are no-ops on re-delivery (no reprocessing loop).

### 5. Critical/High risks covered
| ID | Sev | Risk |
|---|---|---|
| C1 | Critical | Any staff sets arbitrary `totalStockBase` on any product/branch |
| C2 | Critical | Any staff can delete any `productStocks` doc (admin-only clause is a no-op) |
| C3 | Critical | Any staff create/update arbitrary `stockLots` (qty/cost), any branch |
| H1 | High | branchId spoof defeats a naive branch rule |
| H2 | High | No permission scoping — `pos_sale`-only cashier can mutate stock & lots |
| H3 | High | Reconcile exception visibility + no reprocessing loop |
| H4 | High (accepted) | Cross-branch stock write needed for staff transfers, but unconstrained |
| I1 | High | `stockLots` reads not branch-scoped (cost-data leak) |
| D2 | required | Oversell must never block a sale |

### 6. Risks still uncovered and why
- **avgCost drift** — deferred per instruction.
- **End-to-end oversell settle (full FIFO)** — `reconcileSale` is not exported and uses transactional queries; characterized via rules + code evidence instead.
- **stockMovements write rules** — out of the three focus areas.
- **Live transfer transaction commit** — proved the rule permits it; no integration test (no behavior change allowed).
- **Void reversal correctness** — already covered by `voidIntent.test.ts` / `voidReversal.test.ts`.

### 7. Unrelated working-tree changes detected
Pre-existing modifications from earlier batches (1–3), NOT part of this workstream: `rp.md`, `src/lib/settings/{devMock,settingsNav,systemTypes,useUomUnits}.ts`, `src/lib/types.ts`, `src/pages/SettingsPage.tsx`, `src/pages/inventory/{TransferHistoryPage,TransferPage}.tsx`, `src/pages/settings/DocumentSettings.tsx`; plus untracked `.cursor/`, `AGENTS.md`, `docs/reviews/`. To be separated before Phase 1 so UI work isn't mixed with security hardening.

### 8. Recommended Phase 1 starting point
Harden `productStocks` rules (only): enforce `request.resource.data.branchId == docId` (anti-spoof), replace the broad `isStaff()` write with a stock-capable-staff gate that excludes `pos_sale`-only cashiers, and make delete genuinely admin-only (stop using `write` which subsumes delete). Preserve oversell and staff-initiated transfers. Mirror predicates across the nested and collection-group blocks. Full destination-leg branch isolation is deferred to Phase 2 (server-side transfer move).
