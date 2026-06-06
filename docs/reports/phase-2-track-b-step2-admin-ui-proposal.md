# Phase 2 — Track B, Step 2: Reconciliation Exceptions Admin UI (PROPOSAL ONLY)

**Status:** Design proposal. **No UI implemented.** Backend (Step 1) is complete: the `retryReconcile` callable + the locked-down `asyncOrders` rules are live and tested. This Step 2 is the thin, isolated admin surface on top of them.

**Hard constraints carried in:** do not touch UI/Flowbite `stash@{0}`; do not refactor transfers; no unrelated app changes; build self-contained so a later `git stash pop` of the Flowbite migration does not conflict.

## 1. Proposed route path
`/admin/reconciliation-exceptions` — a new leaf under the existing `AdminLayout` (`/admin/*`). Admin back-office only.

## 2. Proposed isolated component/file structure
Self-contained, namespaced, **no edits to volatile layout/nav/settings files**:
- `src/pages/admin/ReconciliationExceptionsPage.tsx` — the page (list + detail + retry).
- `src/pages/admin/ReconciliationExceptionsPage.css` — namespaced prefix `recex-` (per the project's CSS-isolation rule), plain CSS, **not** Flowbite.
- `src/lib/reconciliation/useReconciliationExceptions.ts` — read-only Firestore `onSnapshot` hook.
- `src/lib/reconciliation/retryReconcile.ts` — thin `httpsCallable` wrapper around the `retryReconcile` Cloud Function.
- **One additive line** in `src/App.tsx` to register the route under `/admin`. Entry point surfaced from the existing Admin dashboard (a card/link) rather than editing the stashed navigation config — see §8.

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
**Admin-only**, defense-in-depth: (a) server callable already enforces `auth.token.role === 'admin'`; (b) the route/entry is gated to admin in the client (hide for non-admin); (c) Firestore rules already restrict `asyncOrders` reads to admin/own-branch and forbid any client write of reconcile fields. No new rules required.

## 7. Loading / error / empty states
- **Loading:** skeleton/spinner while the snapshot subscribes.
- **Empty:** "ไม่มีรายการกระทบยอดค้าง 🎉" (no exceptions) — the healthy default.
- **Error:** query failure (e.g., missing index / permission) shows a retal banner with the error; per-row retry failures surface a toast with the mapped callable error.
- **Per-row:** in-flight (spinner on the button), disabled-with-reason (cap / void / busy).

## 8. Avoiding conflict with `stash@{0}` (Flowbite work)
`stash@{0}` carries the Flowbite migration of settings/navigation/layout. To avoid merge conflicts:
- Build the page with **plain, namespaced CSS + existing non-Flowbite primitives** — do NOT import Flowbite components yet.
- Do NOT modify the volatile files the stash touches (`SettingsPage*`, `src/config/navigation.ts`, `AppShell`/layout). Register the route with a single additive line in `App.tsx`; surface the entry from the Admin dashboard (a self-contained card), not by editing the stashed nav config.
- Keep everything inside the new `reconciliation/` lib folder + the one page/css, so the diff is orthogonal to the stash.

## 9. Backlog note
After the security phases close **and** `stash@{0}` (the Flowbite migration) is applied, upgrade this isolated page to Flowbite components (Table/TableHead…, Button, Badge, Modal) for visual consistency with the migrated admin surface. Until then it stays deliberately plain to remain conflict-free.

## 10. Tests needed before implementation
- **Callable wrapper** (`retryReconcile.ts`): invokes with `orderId`; maps each `HttpsError` code to a user-facing message; surfaces success.
- **Query hook** (`useReconciliationExceptions.ts`): subscribes to the exception query, maps fields, handles empty + error.
- **Component** (RTL): renders rows; Retry disabled at cap / when `voidRequested` / while in-flight; confirm dialog gates the call; loading/empty/error states render.
- **Index**: if the production list filters by branch + `orderBy(createdAt)`, add the composite index to `firestore.indexes.json` and verify the query before shipping (equality-only needs none).
- **Rules** (regression, no change expected): a non-admin cannot read another branch's exception docs (already covered by the `asyncOrders` read rule) — keep green.
