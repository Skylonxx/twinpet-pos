# Phase 2 — Track B: Reconciliation Alerting + Admin Repair Flow (DESIGN PROPOSAL)

**Status:** Design proposal only. **No code implemented.** Approval gate before any implementation.

**Business intent:** A manual Admin Repair Flow is a required safety net, but reconciliation exceptions must stay **rare** — never daily ops. POS checkout and stock mutation must remain robust and concurrent-safe. Track B adds *visibility* + a *governed, idempotent retry*, not an always-on auto-repair engine.

**Grounding facts (verified in code):**
- `ReconcileStatus = 'pending_reconcile' | 'settled' | 'exception'` (`reconcileOrder.ts`).
- `reconcileSale` runs the **entire** settlement (FIFO lot cuts, stock decrement, canonical `orders`/`orderItems`/`payments`, credit, shift/device seq) in **one** `db.runTransaction`, flipping `reconcileStatus → 'settled'` in the same tx. → **All-or-nothing.** An `exception` means the transaction aborted and **nothing committed** (confirmed by `sweeper.ts` header).
- On failure, `reconcileOnWrite` already stamps `reconcileStatus:'exception' + reconcileError + reconciledAt` and rethrows. An `exception` doc is **terminal**: the trigger only re-fires on a new write, and `reconcileStatus !== 'pending_reconcile'` short-circuits — so today recovery needs a manual console edit.
- `sweeper.ts` (`sweepStuckOrders`/`repairSettledOrder`) repairs **settled-but-orphaned read models** only; it explicitly does **not** re-reconcile. Track B is complementary, not a replacement.
- Admin callable pattern = `onCall` + `request.auth` custom claims (`verifyPinLogin` in `index.ts`); Admin SDK bypasses Firestore rules.

---

## 1. Exception logging

**Where:** stays on the `asyncOrders/{orderId}` doc (single source of truth; admin-readable; already where state lives). No new collection needed for this phase.

**Fields written on failure** (enrich the existing catch in `reconcileOnWrite`):
| Field | Meaning |
|---|---|
| `reconcileStatus: 'exception'` | the lock/state (existing) |
| `reconcileError` | **first** error message — written once, never overwritten (preserve original cause) |
| `firstFailedAt` | server timestamp of first failure (set once) |
| `lastReconcileError` | latest error message (overwritten each failure) |
| `lastReconcileErrorAt` | server timestamp of latest failure |
| `reconcileAttempts` | `FieldValue.increment(1)` — counts settle attempts, drives the storm cap |

Original-error preservation: `reconcileError` + `firstFailedAt` are written only when not already present (guarded read in the catch, or `create`-only semantics); `lastReconcileError*` always update. Full history is out of scope (optional future `asyncOrders/{id}/reconcileAttempts` subcollection).

**Admin visibility:** `asyncOrders` is already admin-readable (`allow read: if isAdmin() || …`). A query `where('reconcileStatus','==','exception')` surfaces them (equality-only = no composite index; add one only if we also `orderBy`/filter by branch — see §4).

## 2. Admin retry trigger

**Pattern:** a new **HTTPS callable** `retryReconcile({ orderId })` (mirrors `verifyPinLogin`), running with Admin SDK. Chosen over a client-side status write so we never loosen `asyncOrders` write rules and the repair is centrally guarded + audited.

**What it does (transactionally):** read the doc; **only if** `reconcileStatus === 'exception'` and `reconcileAttempts < CAP`, flip `reconcileStatus → 'pending_reconcile'`, stamp `lastRetryBy`/`lastRetryAt`. The existing `onDocumentWritten` trigger then re-runs `reconcileSale` via the normal path. (Alternative considered: call `reconcileSale` directly from the callable — rejected to keep a single settlement code path.)

**Permissions:** admin only — `request.auth.token.role === 'admin'` (throw `HttpsError('permission-denied')` otherwise). Manager/staff cannot retry.

**What Admin sees before retrying:** order id, branch, `billId`, total, line items, `reconcileError` (first) + `lastReconcileError`, `reconcileAttempts`, `firstFailedAt`/`lastReconcileErrorAt`. Retry button disabled when status ≠ `exception` or attempts ≥ CAP (then show "needs manual investigation").

## 3. Idempotency / double-deduction prevention

**Core guarantee:** because settlement is one atomic transaction, an `exception` = **no** committed writes. Re-arming to `pending_reconcile` and re-running the full settle therefore cannot double-deduct — there is nothing to undo. This is the linchpin and is already true in code.

**Already-settled detection:** `reconcileStatus === 'settled'` is terminal. Two guards:
1. The callable refuses to re-arm anything not currently `exception`.
2. The in-transaction guard inside `reconcileSale` (`if order.reconcileStatus !== 'pending_reconcile' return`) means even a stale/duplicate trigger delivery on an already-settled doc is a no-op.

**Allowed status transitions (enforced):**
- `pending_reconcile → settled` (success) or `→ exception` (failure) — by the trigger.
- `exception → pending_reconcile` — **only** via `retryReconcile` (admin), transactionally, attempts-capped.
- `settled` = terminal (read-model orphans handled by the sweeper, never re-reconciled).
- Void tombstone (`status:'voided'`, `reconcileStatus:'settled'`) untouched.

**Lock/guard fields:** `reconcileStatus` is the lock; the callable's read-check-write transaction serializes concurrent retries (one wins, others see non-`exception` and no-op). `reconcileAttempts` caps repeated retries of a deterministically-poisoned order.

## 4. Operational alerting (minimum for this phase)

- **Admin "Reconciliation Exceptions" list** (new admin page): query `asyncOrders where reconcileStatus=='exception'`, show the fields from §2 + a Retry action.
- **Dashboard badge:** a count of current exceptions on the admin dashboard (cheap `count()` aggregate or the list length) so admins notice without hunting.
- **Minimum bar:** badge + list + retry. That's enough to make rare exceptions visible and actionable.
- **Index:** add a composite index to `firestore.indexes.json` only if the list uses `where(reconcileStatus)==exception` **plus** an `orderBy(createdAt)` or branch filter; pure equality needs none.
- **Explicitly deferred (not this phase):** push/LINE/webhook notifications, Cloud Logging metric + alert policy, and a scheduled `sweepStuckOrders`-style auto-retry. Noted as future once exception rate is understood.

## 5. Scope boundaries

**In Track B:**
- Enrich the exception write in `reconcileOnWrite` (attempts + timestamps + preserved first error).
- New admin-only `retryReconcile` callable (re-arm `exception → pending_reconcile`, capped, audited).
- Minimal admin surface: exceptions list page + dashboard badge + retry button.
- Tests (function + minimal rules) and an index if the query needs one.

**NOT in Track B:**
- No transfer refactor. No UI/Flowbite `stash@{0}`. No broad stock-architecture rewrite.
- No change to the settlement math, FIFO, or oversell behavior (oversell stays allowed).
- No change to `productStocks`/`stockLots` rules (Phases 1 + 2A are done).
- No auto-retry/backoff infra, no notification channels (deferred).
- No client-side reconcileStatus mutation path (repair stays server-side via callable).

## 6. Tests

**Function tests (vitest, injected fake db — no emulator):**
- `retryReconcile`: unauthenticated denied; staff/manager denied; admin allowed. Re-arms only from `exception` (rejects `settled`, `pending_reconcile`). Increments attempts; stamps `lastRetryBy/At`. Enforces attempts CAP (refuses past cap). Concurrent retries → exactly one flip (transaction guard).
- Exception enrichment (extend `reconcileException.test.ts`): on settle throw, `reconcileAttempts` increments, `lastReconcileError*` set, `reconcileError`/`firstFailedAt` set once and **not** overwritten on a second failure.
- Idempotency proofs: (a) on tx reject, the fake store shows **no** stock/lot/order writes (atomicity); (b) a re-armed `pending` settles exactly once; (c) re-delivery on `settled` is a no-op (existing coverage retained); (d) retry refuses an already-`settled` order.

**Rules tests (minimal/optional):** repair is Admin-SDK (rules-exempt), so no rule change is required. Optional defense test: a non-admin client cannot flip `reconcileStatus` on `asyncOrders` (documents that the governed path is the callable). Admin read of exception docs already covered by existing `asyncOrders` read rule.

**Cases that prove retry is safe:** atomicity (a) + single-settle (b) + settled-guard (c,d) together prove no double-deduction across failure→retry→success and across duplicate trigger deliveries.

## 7. Risks and rollback

**What can break / risks:**
- **Retry storms** → mitigated by `reconcileAttempts` CAP + UI disabling retry while `pending`/over-cap + re-arm-only-from-`exception`.
- **Poisoned (deterministic) order** retried forever → cap surfaces it as "needs manual investigation"; manual data fix remains the fallback.
- **Racing a late trigger redelivery** → in-tx status guard already serializes; no double-apply.
- **Missing index** → add before shipping the list query; pure-equality query needs none.
- **Callable auth misconfig** → covered by admin-only tests.

**Rollback:** every piece is **additive** — new callable, new admin page/badge, extra enrichment fields. To roll back: remove the `retryReconcile` export + admin UI, `git revert` the Track B commit(s). Enrichment fields are inert extra data (no migration needed). Reverting returns the system to today's behavior (exceptions stamped; manual console re-arm as fallback).

**Manual fallback that always remains:** an admin/dev can re-arm a stuck order by setting `reconcileStatus → pending_reconcile` in the console (re-fires the trigger), and `sweepStuckOrders` continues to rebuild settled-but-orphaned read models. The callable simply makes exception-retry safe, capped, and audited instead of ad-hoc.

---

### Proposed files to modify later (implementation phase, on approval)
- `functions/src/reconcileOrder.ts` — enrich the exception catch block (fields in §1).
- `functions/src/retryReconcile.ts` *(new)* — admin-only `onCall` re-arm.
- `functions/src/index.ts` — export `retryReconcile` (add to deploy list).
- `functions/src/retryReconcile.test.ts` *(new)* + extend `functions/src/reconcileException.test.ts`.
- `firestore.indexes.json` — only if the exceptions list needs a composite index.
- Client admin surface *(new, additive)* — exceptions list page + dashboard badge + retry button + a thin callable hook. No Flowbite-stash interaction.
- `docs/reports/latest-report.md` — Track B result at completion.

**Not to be touched:** `productStocks`/`stockLots` rules, transfer flow, UI/Flowbite `stash@{0}`, settlement/oversell logic, `sweeper.ts` behavior.
