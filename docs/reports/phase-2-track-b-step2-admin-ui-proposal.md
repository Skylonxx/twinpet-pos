# Phase 2 — Track B, Step 2: Reconciliation Exceptions Admin UI (PROPOSAL ONLY)

**Status:** Design proposal. **No UI implemented.** Backend (Step 1) is complete: the `retryReconcile` callable + the locked-down `asyncOrders` rules are live and tested. This Step 2 is the thin, isolated admin surface on top of them.

**Hard constraints carried in:** do not touch UI/Flowbite `stash@{0}`; do not refactor transfers; no unrelated app changes; build self-contained so a later `git stash pop` of the Flowbite migration does not conflict.

## 1. Proposed route path
`/admin/reconciliation-exceptions` — a new leaf under the existing `AdminLayout` (`/admin/*`). Admin back-office only.

**ROUTE-ONLY / DIRECT-URL access (decision).** There is **no** dashboard card, no nav link, and no menu entry in this step. The page is reached **only** by navigating directly to the URL `/admin/reconciliation-exceptions`. `AdminDashboardPage.tsx` and all navigation files are **not** modified. Surfacing a nav/dashboard entry is explicitly out of scope for Step 2 (a future, separately-approved step may add one, ideally after `stash@{0}` is applied).

## 2. Proposed isolated component/file structure
Self-contained, namespaced, **no edits to volatile layout/nav/settings/dashboard files**:
- `src/pages/admin/ReconciliationExceptionsPage.tsx` — the page (list + detail + retry).
- `src/pages/admin/ReconciliationExceptionsPage.css` — namespaced prefix `recex-` (per the project's CSS-isolation rule), plain CSS, **not** Flowbite.
- `src/lib/reconciliation/useReconciliationExceptions.ts` — read-only Firestore `onSnapshot` hook.
- `src/lib/reconciliation/retryReconcile.ts` — thin `httpsCallable` wrapper around the `retryReconcile` Cloud Function.
- `src/lib/reconciliation/retryReconcile.test.ts` — node unit test for the pure error-mapping / disable-reason logic.
- **One additive line** in `src/App.tsx` registers the route under the existing `/admin` block. **No** entry point is added anywhere else (no dashboard, no nav).

## 3. Data to display
From `asyncOrders` where `reconcileStatus == 'exception'` (already admin-readable):
- List row: `billId`, branch, `total`, `staffName`, `createdAt`, `reconcileAttempts` (vs cap), `lastReconcileError`, `lastReconcileErrorAt`, `adminRetryCount`, `lastRetryBy`/`lastRetryAt`, and a `voidRequested` flag badge.
- Detail (expand/drawer): `lines` (items), payments summary, `firstFailedAt` + first `reconcileError`, latest `lastReconcileError`. All error fields are the **sanitized** strings already stored — no raw stack is ever present.

## 4. How Admin triggers retry safely
Per-row **Retry** button → confirm dialog → calls the `retryReconcile({ orderId })` callable. The callable (server) re-arms `exception → pending_reconcile`; the existing trigger re-runs the guarded `reconcileSale`. The list is a live `onSnapshot`, so the row updates/disappears automatically on settle. Button is **disabled** when: `reconcileAttempts >= 3` (show "manual investigation required"), `voidRequested == true` (show "resolve via void path"), or a retry is in-flight. The UI never writes `asyncOrders` directly (rules forbid it).

## 5. How the UI consumes the secured backend
- **Reads:** `onSnapshot(query(collection('asyncOrders'), where('reconcileStatus','==','exception')[, branch scope]))` — equality-only needs no composite index; add one only if combined with a branch `where` + `orderBy` (see §10).
- **Writes/repair:** ONLY through `httpsCallable(getFunctions(app, REGION), 'retryReconcile')`. Map the callable's `HttpsError` codes to user messages: `permission-denied` → not authorized; `failed-precondition` → not retryable / void-pending; `resource-exhausted` → cap reached; `not-found` → already cleared.

## 6. Permission model
**Admin-only**, defense-in-depth: (a) server callable already enforces `auth.token.role === 'admin'`; (b) the route lives under `AdminLayout` (`/admin/*`) — its existing admin gate must be confirmed (see §10 route/admin-gate tests); (c) Firestore rules already restrict `asyncOrders` reads to admin/own-branch and forbid any client write of reconcile fields. No new rules required. Because access is direct-URL-only, the page must degrade safely (not crash) for any non-admin who reaches the URL.

## 7. Loading / error / empty states
- **Loading:** skeleton/spinner while the snapshot subscribes.
- **Empty:** "ไม่มีรายการกระทบยอดค้าง 🎉" (no exceptions) — the healthy default.
- **Error:** query failure (e.g., missing index / permission) shows a retal banner with the error; per-row retry failures surface a toast with the mapped callable error.
- **Per-row:** in-flight (spinner on the button), disabled-with-reason (cap / void / busy).

## 8. Avoiding conflict with `stash@{0}` (Flowbite work)
`stash@{0}` carries the Flowbite migration of settings/navigation/layout. To avoid merge conflicts:
- Build the page with **plain, namespaced CSS + existing non-Flowbite primitives** — do NOT import Flowbite components yet.
- Do NOT modify the volatile files the stash touches (`SettingsPage*`, `src/config/navigation.ts`, `AppShell`/layout) — **and do NOT modify `AdminDashboardPage.tsx`**. The ONLY app-code edit is the single additive route line in `App.tsx` (not in the stash); there is **no** dashboard/nav entry to conflict with.
- Keep everything inside the new `reconciliation/` lib folder + the one page/css, so the diff is orthogonal to the stash.

## 9. Backlog note
After the security phases close **and** `stash@{0}` (the Flowbite migration) is applied, upgrade this isolated page to Flowbite components (Table/TableHead…, Button, Badge, Modal) for visual consistency with the migrated admin surface. Until then it stays deliberately plain to remain conflict-free.

## 10. Tests needed before implementation (exact file names)
Current src tooling is vitest **`node` env**, collecting **`src/**/*.test.ts`** only — no jsdom/RTL. So all logic lives in **pure helpers** that are node-testable; React rendering is verified by a manual emulator smoke test (full RTL component tests would need new infra and are **out of scope**).

- **Route / admin-gate tests** → `src/lib/reconciliation/adminGate.test.ts`
  Tests the pure gate predicate `canViewReconciliationExceptions(role)` (true only for `'admin'`; false for `manager`/`staff`/`undefined`) — the same predicate the page uses to degrade safely for a non-admin who reaches the direct URL.
- **Query-hook tests** → `src/lib/reconciliation/exceptionRows.test.ts`
  Tests the pure mapping `mapExceptionRow(id, data)` (doc → view row, sanitized fields) and `retryDisableReason(row, inFlight)` (disabled at cap / when `voidRequested` / in-flight; enabled otherwise).
- **Callable-wrapper tests** → `src/lib/reconciliation/retryReconcile.test.ts`
  Mocks `firebase/functions` + `../firebase`; asserts `callRetryReconcile(orderId)` invokes the `retryReconcile` callable with `{ orderId }` and that `mapRetryError(code)` maps each `HttpsError` code to a user message.
- **Component/page tests:** **none in this step** — RTL/jsdom is not in the current tooling. The `.tsx` page only composes the above pure helpers + Firestore subscription; verified via emulator smoke test. (Adding RTL infra is a separate, approved step.)
- **Index:** equality-only query needs **none**; do not add a composite index in this step.
- **Rules (regression, no change expected):** a non-admin cannot read another branch's exception docs (existing `asyncOrders` read rule) — keep the rules suite green.

## 11. Step 2 Paranoid Checklist (route-only)
1. **Business Logic Integrity:** POS create, oversell, and the void flow remain **untouched** — additive route + read-only list + the existing Step-1 callable; no checkout/reconcile/void/rules changes.
2. **State Isolation:** `stash@{0}` remains **untouched** — the only app-code edit is the additive route line in `App.tsx` (not in the stash).
3. **Cross-contamination:** **no** `AdminDashboardPage.tsx`, navigation, settings/layout, Flowbite, or transfer changes; no broadened query/index; no unrelated cleanup.
4. **Devil's Advocate (one hidden risk):** access rests entirely on (a) `AdminLayout`'s gate and (b) the Firestore read rule. If `AdminLayout` admits a non-admin, the single-`where` query returns cross-branch docs the read rule **denies** → would throw `permission-denied`. Mitigation: the page checks `canViewReconciliationExceptions(role)` and renders a not-authorized state (degrades, never crashes), independent of `AdminLayout`.
