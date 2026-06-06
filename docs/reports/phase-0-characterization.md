# Phase 0 — Stock-Write Risk Characterization (Option C)

**Status:** Complete for Critical + highly-impactful High risks in scope.
**Scope:** `productStocks` write access, `stockLots` write access, reconciliation exception handling.
**Constraints honored:** no `firestore.rules` change, no Cloud Function change, no transfer refactor, no app-behavior change, no fixes. Characterization tests + this report only.

**Finalized business decisions applied:**
1. Regular staff **are** allowed to execute branch transfers → cross-branch `productStocks`/`stockLots` writes by staff are an **approved** capability (transfer destination leg). The risk is that they are **unconstrained**, not that they exist.
2. Oversell / negative stock **is allowed**; POS must **never** block a sale → "no stock-sufficiency guard" is **required behavior**, not a bug.
3. Phase 0 is done when all Critical + highly-impactful High risks are proven with tests/evidence.

---

## 1. Tests added or updated

| File | Type | Status | Coverage |
|---|---|---|---|
| `rules-tests/product-stocks-phase0.spec.ts` | rules (emulator) | **updated** | productStocks read/write/delete; cross-branch (reframed to "approved-but-unconstrained"); spoof; permission gap; oversell never-block; admin-SDK negative write |
| `rules-tests/stock-lots-phase0.spec.ts` | rules (emulator) | **added** | stockLots read/create/update/delete; cross-branch; arbitrary qty/cost; cashier mutate; delete genuinely mgr/admin-only |
| `functions/src/reconcileException.test.ts` | functions unit (no emulator) | **added** | sale-path reconcile exception stamping + rethrow; re-delivery no-op; happy path; settled no-op |

**Run commands**
```
# Rules (Critical/High access characterization)
firebase emulators:exec --only firestore --project demo-twinpet \
  "npx vitest run --config vitest.rules.config.ts"

# Functions (reconcile exception handling)
npm --prefix functions run test:unit
```

**Results (this run):** rules **33 passed (3 files)**; functions **25 passed (4 files)**. All green.

> Note: `product-stocks-phase0.spec.ts` was created in the prior Phase-0 step; this task only **adjusted labels/comments** to match decisions #1/#2 and added one "sale never blocked" case. No assertion was loosened.

---

## 2. Current behavior proven

### productStocks (`firestore.rules:142-162`)
- **Writes are effectively `isStaff()` only.** Two match blocks cover the path; Firestore grants on the **union**, so the broad nested `allow write: if isStaff()` wins and the branch-scoped collection-group rule is dead weight for writes.
- **Reads ARE branch-isolated** — foreign-branch staff are denied cross-branch stock reads; admins pass.
- **`allow delete: if isAdmin()` is a NO-OP.** `allow write` subsumes delete, so **any staff can delete any** stock doc — own *and* cross-branch. (Proven; this assertion initially failed against the wrong assumption and was corrected to reality.)
- **branchId spoof passes:** writing to branch B's doc while stamping `branchId:"A"` succeeds (payload trusted over doc id via `requestProductStockBranchId`).
- **No permission scoping:** a `pos_sale`-only cashier can mutate stock.
- **Oversell never blocked:** a `pos_sale` staff can create an `asyncOrder` for a product with no stock doc; the Admin-SDK decrement (`reconcileOrder.ts:375-388`) has no sufficiency guard and may drive `totalStockBase` negative — rules-exempt.

### stockLots (`firestore.rules:300-309`)
- **read / create / update = `isStaff()`** with **no branch scoping and no field checks** → any staff can read, create, and rewrite `qtyRemaining`/`costPerUnit` on **any** lot for **any** branch (proven), including a `pos_sale`-only cashier.
- **delete = `isManagerOrAdmin()` and is REAL** — unlike productStocks, this block uses explicit `create/update/delete` (not `write`), so staff delete is correctly **denied**; manager/admin succeed.

### Reconciliation exception handling (`reconcileOrder.ts:197-237`)
- A pending sale whose settlement transaction **throws** is stamped `reconcileStatus:'exception'` + `reconcileError` (+ `reconciledAt`) and **rethrown** for retry/alerting — failures are made visible, never silently dropped.
- A doc already in `exception` (or `settled`) is a **no-op on re-delivery** — no settle attempt, no re-stamp → no reprocessing loop.
- Happy path settles without stamping an error or rethrowing.
- (Void-intent routing + void-failure surfacing remain covered by the pre-existing `reconcileTrigger.test.ts` / `voidIntent.test.ts`.)

---

## 3. Critical / High risks now covered by tests

| ID | Sev | Risk | Evidence |
|---|---|---|---|
| C1 | Critical | Any staff sets arbitrary `totalStockBase` on any product/branch (`productStocks` write = isStaff) | product-stocks: own + cross-branch write succeed |
| C2 | Critical | Any staff can **delete** any `productStocks` doc (write subsumes delete; admin-only clause is a no-op), incl. cross-branch | product-stocks DELETE: staff own + cross-branch succeed |
| C3 | Critical | Any staff create/update arbitrary `stockLots` (qty/cost) for any branch → corrupts FIFO cost & stock | stock-lots CREATE/UPDATE: own + cross-branch + cashier succeed |
| H1 | High | branchId **spoof** defeats a naive branch rule (payload trusted over doc id) | product-stocks: spoof write succeeds |
| H2 | High | **No permission scoping** — `pos_sale`-only cashier can mutate stock & lots | product-stocks + stock-lots cashier cases |
| H3 | High | Reconcile **exception** must be visible & non-looping | reconcileException: exception stamp + rethrow; re-delivery no-op |
| H4 | High (accepted) | Cross-branch stock write is needed for staff transfers (decision #1) but **unconstrained** | product-stocks/stock-lots cross-branch cases (labelled approved-but-unconstrained) |
| D2 | n/a (required) | Oversell must never block a sale (decision #2) | oversell: asyncOrder create with no stock; negative Admin-SDK write |
| I1 | High | `stockLots` reads are **not** branch-scoped (cross-branch cost-data leak) | stock-lots READ: cross-branch read succeeds |

All Critical (C1–C3) and the highly-impactful High risks (H1–H4, I1) plus the two business-decision invariants (D2, transfers) are now pinned by passing tests.

---

## 4. Risks remaining uncovered (and why)

| Risk | Why not covered in Phase 0 |
|---|---|
| **avgCost drift** | Explicitly **deferred** to a later phase per instruction. |
| **End-to-end oversell settle (full FIFO)** | `reconcileSale` is not exported and uses **transactional queries** (`.where().orderBy()`), which the lightweight in-memory fake doesn't model. Oversell is instead evidenced at the rules layer + by code (`reconcileOrder.ts:328/346-354/375`). A query-capable settle soak is a follow-up if deeper proof is wanted. |
| **stockMovements write rules** (cross-branch `transfer_in` allowance, `firestore.rules:311-322`) | Out of the three named focus areas; not characterized this pass. |
| **Live app transfer transaction** actually committing the dest leg | We proved the *rule* permits it; an integration test through `transferCrud.ts` was out of scope (no transfer refactor / behavior change). |
| **Void reversal correctness** | Already covered by pre-existing `voidIntent.test.ts` / `voidReversal.test.ts`; not duplicated. |

---

## 5. Accidental unrelated working-tree changes detected

Phase 0 added **only** new files: `rules-tests/stock-lots-phase0.spec.ts`, `functions/src/reconcileException.test.ts`, this report, and label-only edits to the existing `rules-tests/product-stocks-phase0.spec.ts`. **`firestore.rules`, all function source, and all app code were left untouched.**

However, the working tree carries **pre-existing, unrelated modifications from earlier batches (Batches 1–3)** that are **not** part of Phase 0:

```
 M rp.md
 M src/lib/settings/devMock.ts
 M src/lib/settings/settingsNav.ts
 M src/lib/settings/systemTypes.ts
 M src/lib/settings/useUomUnits.ts
 M src/lib/types.ts
 M src/pages/SettingsPage.tsx
 M src/pages/inventory/TransferHistoryPage.tsx
 M src/pages/inventory/TransferPage.tsx
 M src/pages/settings/DocumentSettings.tsx
?? .cursor/  AGENTS.md  docs/reviews/
```

These are the settings/UOM/transfer-UI changes from prior sessions, left in place (not reverted, not extended). Flagging for awareness — they should be committed or stashed separately from the Phase-0 test additions so the rules-hardening history stays clean. No transient artifacts remain (the emulator `firestore-debug.log` was removed).

---

## 6. Recommended next step for Phase 1 (NOT implemented)

Acceptance gate: flip the `CURRENT (insecure)` cases to `assertFails`, keep all own-branch / admin / read / oversell / transfer cases green.

1. **`productStocks` — fix the delete no-op + anti-spoof + permission gate.** In the *nested* block (the one that governs): stop using bare `allow write: if isStaff()`. Require `request.resource.data.branchId == stockBranchId` (kills H1 spoof) and a stock-mutation gate that excludes `pos_sale`-only cashiers (H2). Express delete explicitly as admin-only so it is no longer subsumed (C2). Mirror the predicate in the collection-group block so they can't drift.
2. **`stockLots` — add branch scoping + field discipline.** Scope create/update to `hasBranchAccess(request.resource.data.branchId)` with a transfer-destination carve-out, and exclude `pos_sale`-only cashiers (C3, H2, I1). Keep delete manager/admin.
3. **Preserve the two business invariants:** do **not** add any stock-sufficiency guard (decision #2), and keep staff able to initiate transfers (decision #1).
4. **Residual that Phase 1 cannot close by rules alone:** because staff transfers are allowed and a `productStocks`/`stockLots` write carries no transfer context, full branch isolation of the **destination** leg still requires moving it server-side (Cloud Function) — that is **Phase 2** and explicitly out of Phase 1 scope. Phase 1 should document the remaining cross-branch allowance it knowingly retains.

Do not implement any of the above yet — Phase 1 is a separate, approved change.
