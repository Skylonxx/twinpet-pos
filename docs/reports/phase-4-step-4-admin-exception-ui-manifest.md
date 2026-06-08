# Phase 4 Step 4: Admin Exception UI Manifest

**Status**: Planning / Manifest Only

## 1. Step 4 Scope Summary
**IN Scope**:
- Refactoring `ReconciliationExceptionsPage.tsx` to abide by `SKILL-UI-IMPECCABLE.md`.
- Migrating the current plain-CSS implementation to use `flowbite-react` components.
- Improving Anti-Silent Failure UX (red toasts/alerts for retry failures).
- Preserving the `retryReconcile` callable integration and admin-gated route logic.

**OUT of Scope**:
- Modifying `firestore.rules` or Cloud Functions.
- Altering the `retryReconcile` backend contract or reconciliation behavior.
- Modifying POS / checkout / payment / auth / stock / transfer flows.
- Applying or popping `stash@{0}`.
- Adopting external vendor SKILL.md files.

---

## 2. File Scope Lock
Implementation must be strictly limited to the following files:

**Target implementation files**:
- `src/pages/admin/ReconciliationExceptionsPage.tsx`: Upgrade layout to `flowbite-react` (Table, Button, Badge, Alert/Toast). High risk of visual regression, low risk to business logic since data fetching is encapsulated.
- `src/pages/admin/ReconciliationExceptionsPage.css`: Clean up legacy `recex-` plain CSS in favor of Tailwind utilities.

**Read-only dependencies**:
- `src/lib/reconciliation/useReconciliationExceptions.ts`
- `src/lib/reconciliation/retryReconcile.ts`
- `src/lib/reconciliation/exceptionRows.ts`
- `src/App.tsx` (routing)

---

## 3. `retryReconcile` Contract Inspection
- **Callable Name**: `retryReconcile`
- **Request Payload**: `{ orderId: string }`
- **Response Shape**: Implicitly void/success or throws an error.
- **Client Wrapper**: `callRetryReconcile(orderId: string)` in `retryReconcile.ts`.
- **Current Error Behavior**: Throws an exception, catches it, maps code via `mapRetryError(code)`, and displays it.
- **Must Preserve**: The UI MUST NEVER write to `asyncOrders` directly to "fix" an exception. It must strictly call the wrapper and let the server re-arm the status.

---

## 4. Admin Route/Access Plan
- **Route Path**: `/admin/reconciliation-exceptions`
- **Route-Only Strategy**: The page is currently accessible only by directly typing the URL. It is strongly recommended to **keep it route-only** for this step to avoid modifying `AdminDashboardPage.tsx` or navigation components, which are known to be part of the `stash@{0}` UI refactor. Modifying them now risks merge conflicts.
- **Admin Gate**: `canViewReconciliationExceptions(user?.role)` dictates the `isAdmin` boolean. This boolean controls both the UI rendering (fallback error div) and the subscription hook (`useReconciliationExceptions(isAdmin)`).
- **Data Protection**: Non-admins trigger no Firestore reads.

---

## 5. Exception List/Query Plan
- **Hook**: `useReconciliationExceptions`
- **Query Shape**: Equality-only `where('reconcileStatus', '==', 'exception')`.
- **Index**: No composite index is needed (no `orderBy`). Sorting is done in-memory on the client.
- **States**: The UI accurately handles `loading` (Spinner), `empty` (no exceptions), and `error` (Firestore permission/network failures).

---

## 6. Retry Action UX Plan
- **Button Behavior**: `onClick` triggers the callable. Disabled if `disabled !== null` (computed by `retryDisableReason`).
- **Pending State**: Button shows a loading spinner or '...' and disables while `busyId === r.id`.
- **Anti-Silent Failure**: System rejections are trapped and displayed via a prominent Toast/Alert.
- **Async-Safe Wording**: Success shows "ส่งคำขอรีทรายแล้ว — ระบบกำลังประมวลผลใหม่" (Retry requested — processing), which is accurate since the callable only re-arms the status; the trigger actually performs the settle.

---

## 7. Impeccable.style Plan
- **Flowbite React Components**: `Table`, `Button`, `Badge` (for voidRequested labels), `Spinner` (for busy state), `Alert` or `Toast` (for success/failure messaging).
- **No Blocking Modal Spinners**: Button-level loading state allows the admin to continue viewing the list.
- **Responsiveness**: The `Table` will be wrapped in a responsive container (`overflow-x-auto`) to prevent horizontal clipping at 320px/768px.
- **CSS Discipline**: Tailwind utilities for margins, layout, and colors. No arbitrary inline styles.

---

## 8. Test/Check Plan
- [ ] Non-admin access correctly renders unauthorized message and starts no query.
- [ ] Exception list correctly shows empty state or populated Table.
- [ ] Retry button is disabled while pending.
- [ ] Retry rejection surfaces a prominent red error Toast/Alert.
- [ ] No direct Firestore mutation executed by the UI.
- [ ] `npm run build` succeeds without type errors.
- [ ] Responsive checks at 320px / 768px / 1080px (Ensure table scrolls horizontally on mobile).

---

## 9. Report/Release Evidence Plan
- Apply `SKILL-RELEASE-EVIDENCE.md`.
- `npm run build` output must be captured when the code is implemented.
- The next step report must explicitly distinguish passed/failed/deferred checks.

---

## 10. Questions for Tech Lead / CEO
1. **Route-Only Scope**: Is it acceptable to leave this as a route-only/direct URL page to avoid `stash@{0}` conflicts, or must we add a dashboard card/link now?
2. **Table Pagination**: Are we okay with an unpaginated in-memory table list, assuming the total concurrent exception count is operationally very small?

---

## 11. Paranoid Checklist
- [x] **Business Logic Integrity**: `retryReconcile` backend contract and reconciliation behavior are fully preserved.
- [x] **State Isolation**: `stash@{0}` inspected only, not applied/popped.
- [x] **Cross-contamination**: No rules/functions/POS/checkout/auth/stock/transfer scope included.
- [x] **Devil's Advocate**: One hidden risk in the Admin Exception UI implementation is mobile responsiveness. The `Table` component from `flowbite-react` must be properly encapsulated in an `overflow-x-auto` wrapper, otherwise it will break the viewport width on 320px screens.
