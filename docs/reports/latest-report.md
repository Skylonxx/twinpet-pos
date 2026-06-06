# Latest Report

> Rolling "latest report" for the stock-write security workstream. Updated at each phase boundary.
> **Current state:** Phase 2 Track A COMPLETE — stockLots write hardening done (incl. branchId invariant). Track B (reconciliation) deferred. Phase 1 + Phase 0 retained below.

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
