/**
 * Pure admin-gate predicate for the route-only Reconciliation Exceptions page.
 * Kept dependency-free so it is node-unit-testable (see adminGate.test.ts) and so
 * the page can degrade SAFELY (render a not-authorized state) for any non-admin
 * who reaches the direct URL — independent of the AdminLayout route guard.
 */
export function canViewReconciliationExceptions(role: string | null | undefined): boolean {
  return role === 'admin';
}
