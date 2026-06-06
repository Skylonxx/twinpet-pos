/**
 * Pure admin-gate predicate for the route-only Reconciliation Exceptions page.
 * Kept dependency-free so it is node-unit-testable (see adminGate.test.ts) and so
 * the page can degrade SAFELY (render a not-authorized state) for any non-admin
 * who reaches the direct URL — independent of the AdminLayout route guard.
 */
export function canViewReconciliationExceptions(role: string | null | undefined): boolean {
  return role === 'admin';
}

/**
 * Whether the exceptions Firestore subscription may START. `enabled` is the
 * admin-derived gate (`canViewReconciliationExceptions(role)`); a non-admin
 * yields `false`, so `useReconciliationExceptions` issues NO read/subscription
 * at all — the security boundary, independent of AdminLayout. Also requires a
 * configured Firestore (dev/no-firebase → no query).
 */
export function shouldStartExceptionsQuery(
  enabled: boolean,
  firebaseReady: boolean,
  dbPresent: boolean,
): boolean {
  return enabled && firebaseReady && dbPresent;
}
