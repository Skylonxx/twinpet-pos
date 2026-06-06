# Phase 2 — Execution Plan & Scope (PROPOSAL — not implemented)

**Status:** Plan only. No `stockLots` rule, reconciliation logic, transfer, or UI change has been made. Implementation is gated on approval.

**Phase 2 focus (two tracks):**
- **A. `stockLots` write access** — close the unconstrained create/update hole characterized in Phase 0 (risk C3/I1/H2).
- **B. Reconciliation exception handling** — make a failed sale-settlement recoverable/observable, not a silent terminal `exception`.

---

## 1. Current risk summary (from Phase 0 evidence)
- **C3 (Critical):** `stockLots` `create`/`update` = `isStaff()` with **no branch scoping and no field checks** → any staff (incl. a `pos_sale`-only cashier) can create/rewrite `qtyRemaining`/`costPerUnit` on **any** lot in **any** branch, corrupting FIFO cost basis and on-hand stock. (`delete` is already manager/admin-only — correct.)
- **I1 (High):** `stockLots` reads are **not** branch-scoped → cross-branch cost-data leak.
- **H2 (High):** no permission scoping — a `pos_sale`-only terminal can mutate lots.
- **Reconcile exception (High):** on settle failure the async doc is stamped `reconcileStatus:'exception'` + `reconcileError` and rethrown (visible in logs, idempotent on re-delivery). **Gap:** an `exception` doc is effectively **terminal** — the trigger only re-fires on a new write, so a stuck sale is not auto-recovered and has no first-class alerting/requeue path beyond Cloud Functions logs.

## 2. Files likely to be affected
- `firestore.rules` — `stockLots/{lotId}` block only (and a `collectionGroup` stockLots block if introduced).
- `rules-tests/stock-lots-phase0.spec.ts` → converted to `rules-tests/stock-lots-phase2.spec.ts` (expected-behavior).
- `functions/src/reconcileOrder.ts` — **only if** Track B adds a recovery/alert affordance (e.g., a bounded `reconcileAttempts` counter or an explicit `needsAttention` flag). May be test-only if we decide to keep behavior and just document.
- `functions/src/reconcileException.test.ts` — extend for any new recovery/visibility behavior.
- `docs/reports/latest-report.md` — Phase 2 report at completion.

## 3. Tests to add/update
- **stockLots (rules):** cashier (`pos_sale`-only) create/update **DENIED**; receiving (`stock_receive`)/transfer (regular staff `product_view`)/void (`pos_void`) create/update **ALLOWED**; cross-branch **read** scoping (if added) denied for foreign-branch staff; `delete` stays manager/admin-only; non-staff denied.
- **reconcile (functions):** existing exception-stamp + rethrow + re-delivery no-op stay green; add cases for any new recovery path (e.g., attempt cap, requeue flag) — must remain idempotent.

## 4. Rules / function behavior expected to change
- **stockLots rules:** replace bare `allow create, update: if isStaff()` with `isStaff() && canMutateStock()` (reuse the Phase-1 helper) + field validation (`branchId is string`); optionally branch-scope reads. **Note:** unlike `productStocks`, a `stockLots` doc id is an auto-id (not a branch id), so the Phase-1 `branchId == docId` anti-spoof does **not** translate — scoping must be on the `branchId` field + permission, with the cross-branch transfer-dest lot creation intentionally still allowed.
- **reconcileOrder (optional, Track B):** add observability/recovery for `exception` docs (counter/flag), without changing the FIFO/oversell settlement math.

## 5. Business behavior that MUST be preserved
- Oversell / negative stock allowed; **POS checkout never blocked**.
- **Staff-initiated transfers** — including cross-branch **destination lot creation**.
- **Receiving** lot creation (manager/admin) and **void** lot restock (`pos_void`).
- FIFO settlement correctness and idempotency of reconcile.
- `stockLots` `delete` remains manager/admin-only.

## 6. What will NOT be touched
- `productStocks` rules (Phase 1 — done).
- **Transfer flow refactor / moving cross-branch writes to Cloud Functions** (still deferred to a later phase).
- UI / Flowbite work in `stash@{0}`.
- `stockMovements` rules, app UI behavior, and any non-targeted collection.

## 7. Risks of breaking current flows
- A permission gate that omits `product_view` would **break regular-staff transfers** (they create dest lots) — must reuse the Phase-1 `canMutateStock()` set.
- Adjustment (ADJUST_IN) creates lots — verify the adjustment actor holds a qualifying permission, or it will be blocked.
- Branch-scoping `stockLots` **reads** could break cross-branch lot reads relied on by reports/FIFO/dashboards — audit read call sites first.
- Track B retry/requeue changes risk **double-application** if not strictly idempotent — must preserve the existing settle idempotency guard.
- Union semantics: if a `collectionGroup` stockLots block exists/added, both blocks must be tightened together (Phase-1 lesson).

## 8. Recommended execution steps
1. Audit all `stockLots` client read/write call sites (receiving, adjustment, transfer create/cancel, void) and the permissions each actor carries.
2. Track A first (rules-only, lower risk): tighten `stockLots` create/update with `canMutateStock()` + field checks; decide on read scoping after the read audit. Convert the phase-0 spec to expected-behavior and go green under `test:rules`.
3. Track B second: characterize the stuck-`exception` recovery story; decide minimal change (likely an observability flag + documented manual requeue, avoiding auto-retry complexity). Extend `reconcileException.test.ts`.
4. Update `latest-report.md`; package + commit as its own phase boundary (mirroring Phase 1 packaging discipline).

## 9. Acceptance criteria
- All rules tests pass; all function tests pass.
- `stockLots` cashier-only create/update now **DENIED**; receiving/transfer/void create/update still **ALLOWED**; `delete` manager/admin-only; non-staff denied.
- (If read-scoping adopted) cross-branch lot read denied for foreign-branch staff; admin/own-branch allowed; no regression in reports/FIFO.
- Oversell preserved; POS checkout unblocked; staff transfers (incl. dest lot creation) preserved.
- Reconcile exceptions remain visible and idempotent; any new recovery path is covered by tests and cannot double-apply.

## 10. Rollback / safety notes
- All rule changes are isolated to `firestore.rules` (single file) — revert via `git revert`/checkout of the Phase 2 commit; redeploy with `firebase deploy --only firestore:rules` against the previous commit.
- Validate against the Firestore emulator (`test:rules`) and functions unit tests **before** any deploy; never deploy rules without a green `test:rules`.
- Keep `stash@{0}` untouched throughout.
- Commit Track A and Track B as separate, reviewable commits behind their own green test runs; do not mix with transfer-refactor or UI work.
- Phase 3 (future, separate proposal): move transfer cross-branch destination writes (productStocks + stockLots) to a Cloud Function, then tighten both to full `hasBranchAccess` branch isolation.
