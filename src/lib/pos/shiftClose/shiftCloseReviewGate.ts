/**
 * Pure admin-gate predicate for the route-only Shift Close Review page
 * (`/shift-close-review`, UI-A). Kept dependency-free so it is node-unit-testable
 * (see shiftCloseReviewGate.test.ts) and so the page can degrade SAFELY (render a
 * not-authorized state) for any non-manager/admin who reaches the direct URL —
 * independent of the PosShellRoute route guard. This is a UX gate only; the real
 * security boundary is firestore.rules `isManagerOrAdmin() && hasBranchAccess(...)`.
 */
export function canViewShiftCloseReview(role: string | null | undefined): boolean {
  return role === 'manager' || role === 'admin';
}

/**
 * Whether the shiftCloseAlerts Firestore subscription may START. `role` is
 * gated through `canViewShiftCloseReview`; a non-manager/admin, an unconfigured
 * Firestore, a missing `db`, a missing `branchId`, or the unscoped `'ALL'`
 * pseudo-branch all yield `false` — the hook then issues NO read/subscription.
 */
export function shouldStartShiftCloseReviewQuery(
  role: string | null | undefined,
  firebaseReady: boolean,
  dbPresent: boolean,
  branchId: string | null | undefined,
): boolean {
  return (
    canViewShiftCloseReview(role) &&
    firebaseReady &&
    dbPresent &&
    !!branchId &&
    branchId !== 'ALL'
  );
}
