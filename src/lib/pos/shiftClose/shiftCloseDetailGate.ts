/**
 * Pure admin-gate + route-param validation for the route-only Shift Close
 * Alert Detail page (`/shift-close-review/:shiftId`, UI-B core). Kept
 * dependency-free so it is node-unit-testable (see shiftCloseDetailGate.test.ts)
 * and so the page can degrade SAFELY for any non-manager/admin or malformed
 * route segment that reaches the direct URL — independent of the
 * PosShellRoute route guard. This is a UX gate only; the real security
 * boundary is firestore.rules `isManagerOrAdmin() && hasBranchAccess(...)`
 * on both `shiftCloseAlerts` and `shiftCloseCases`.
 */
import { canViewShiftCloseReview } from './shiftCloseReviewGate';

/** Same manager/admin gate as UI-A — re-exported under the UI-B name for call-site clarity. */
export const canViewShiftCloseAlertDetail = canViewShiftCloseReview;

/**
 * Firestore document IDs cannot be empty, contain `/`, or equal `.`/`..`.
 * React Router v7 already URL-decodes path params before `useParams()`
 * delivers them — this validator must NOT call `decodeURIComponent` again
 * (a legal ID that happens to contain literal `%`-sequences must pass
 * through byte-for-byte, never re-decoded/corrupted).
 */
const MAX_FIRESTORE_DOC_ID_LENGTH = 1500;

export type ShiftIdValidation = { ok: true; shiftId: string } | { ok: false };

export function validateRouteShiftId(raw: string | null | undefined): ShiftIdValidation {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false };
  if (raw === '.' || raw === '..') return { ok: false };
  if (raw.includes('/')) return { ok: false };
  if (raw.length > MAX_FIRESTORE_DOC_ID_LENGTH) return { ok: false };
  return { ok: true, shiftId: raw };
}

/**
 * Whether the `shiftCloseAlerts`/`shiftCloseCases` single-document
 * subscriptions may START. `role` is gated through
 * `canViewShiftCloseAlertDetail`; a non-manager/admin, an unconfigured
 * Firestore, a missing `db`, a missing/unscoped `branchId`, or an invalid
 * route `shiftId` all yield `false` — the hook then issues NO read/subscription.
 */
export function shouldStartShiftCloseAlertDetailQuery(
  role: string | null | undefined,
  firebaseReady: boolean,
  dbPresent: boolean,
  branchId: string | null | undefined,
  routeShiftIdRaw: string | null | undefined,
): boolean {
  return (
    canViewShiftCloseAlertDetail(role) &&
    firebaseReady &&
    dbPresent &&
    !!branchId &&
    branchId !== 'ALL' &&
    validateRouteShiftId(routeShiftIdRaw).ok
  );
}
