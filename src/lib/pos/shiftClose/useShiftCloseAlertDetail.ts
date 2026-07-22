import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../../firebase';
import { shouldStartShiftCloseAlertDetailQuery, validateRouteShiftId } from './shiftCloseDetailGate';
import { mapShiftCloseReviewRow, type ShiftCloseReviewRow } from './shiftCloseReviewRows';
import {
  computeIntegrityCautions,
  mapShiftCloseCaseProjection,
  type IntegrityCaution,
  type ShiftCloseCaseProjection,
} from './shiftCloseDetailProjection';

export type ShiftCloseSourceStatus = 'disabled' | 'pending' | 'ready' | 'error';
export type ShiftCloseSourceErrorKind = 'permission-denied' | 'generic' | null;

export type ShiftCloseAlertSourceState = {
  status: ShiftCloseSourceStatus;
  fromCache: boolean;
  /** Meaningful only when `status === 'ready'`. */
  empty: boolean;
  errorType: ShiftCloseSourceErrorKind;
  row: ShiftCloseReviewRow | null;
};

export type ShiftCloseCaseSourceState = {
  status: ShiftCloseSourceStatus;
  fromCache: boolean;
  /** Meaningful only when `status === 'ready'`. */
  empty: boolean;
  errorType: ShiftCloseSourceErrorKind;
  projection: ShiftCloseCaseProjection | null;
};

export type ShiftCloseAlertDetailState = {
  /** Whether the route `:shiftId` segment passed `validateRouteShiftId`. */
  routeValid: boolean;
  alert: ShiftCloseAlertSourceState;
  case: ShiftCloseCaseSourceState;
  integrityCautions: IntegrityCaution[];
};

/** Server-confirmed (not cache, not pending/error) zero-doc result for a source. */
export function isSourceConfirmedEmpty(source: { status: ShiftCloseSourceStatus; fromCache: boolean; empty: boolean }): boolean {
  return source.status === 'ready' && !source.fromCache && source.empty;
}

function makeInitialAlertState(enabled: boolean): ShiftCloseAlertSourceState {
  return { status: enabled ? 'pending' : 'disabled', fromCache: false, empty: false, errorType: null, row: null };
}

function makeInitialCaseState(enabled: boolean): ShiftCloseCaseSourceState {
  return { status: enabled ? 'pending' : 'disabled', fromCache: false, empty: false, errorType: null, projection: null };
}

/**
 * Live, read-only, dual-source subscription for the Shift Close Alert Detail
 * page (UI-B core, Packet 5).
 *
 * FALLBACK A (frozen plan §8) — ADOPTED, with emulator evidence: the
 * documented primary shape (`where('branchId','==',activeBranchId) +
 * where(documentId(),'==',canonicalRouteShiftId) + limit(1)`) was tried
 * first. Emulator rules-test evidence
 * (rules-tests/shift-close-p5c.spec.ts, "fail-closed, not silently empty" /
 * "genuinely nonexistent" cases) proved it CANNOT be used: firestore.rules'
 * `allow read: if isManagerOrAdmin() && hasBranchAccess(resource.data.branchId)`
 * dereferences `resource.data` on a null `resource` for ANY read of a
 * nonexistent document — `get` and `list` alike — which Firestore evaluates
 * as a runtime rule error and denies. Since most shifts close with NO alert/
 * case doc at all, the documented primary shape would deny the overwhelmingly
 * common "nothing to see here" case exactly like a real permission problem.
 * Switching query shape does not change this — it is intrinsic to the
 * (unauthorized-to-change) rule text, not the query. Per §8's own fallback
 * contract, the missing-vs-denied distinction is EXPLICITLY DROPPED here:
 * both collections are read via a direct single-document listener
 * (`doc(db, collection, shiftId)`), and the page renders neutral
 * absent/inaccessible wording for the ambiguous case — see
 * ShiftCloseAlertDetailPage's `permissionDenied` branch. No whole-branch
 * client filtering exists anywhere in this module.
 *
 * Because a direct document reference carries no `branchId` predicate, this
 * hook performs a CLIENT-SIDE branch veto after a successful read: a doc that
 * exists but whose stored `branchId` does not match the active branch is
 * treated as absent for this branch (never rendered), preserving the
 * branch-scoped contract even though the rules would technically allow a
 * global admin to read it.
 *
 * `{ includeMetadataChanges: true }` is mandatory on both listeners: without
 * it, a cache-delivered snapshot that later becomes server-confirmed (with
 * identical doc contents) would never re-fire, leaving the page stuck
 * reporting "offline/unconfirmed" even once the server has actually agreed.
 *
 * SECURITY: `role`/`branchId`/`routeShiftIdRaw` feed
 * `shouldStartShiftCloseAlertDetailQuery` (the gate). When the gate is false,
 * the effect never subscribes — this hook never writes.
 *
 * Generation key = enabled + role + activeBranchId + canonicalRouteShiftId.
 * State resets happen DURING RENDER (React's "adjusting state when a prop
 * changes" pattern — see useShiftCloseReviewQueue's RC-1/RC-4 precedent), and
 * a per-effect-run `cancelled` flag guards against a stale generation's
 * next/error/metadata-only callback mutating state after its own cleanup.
 */
export function useShiftCloseAlertDetail(
  role: string | null | undefined,
  branchId: string | null | undefined,
  routeShiftIdRaw: string | null | undefined,
): ShiftCloseAlertDetailState {
  const validation = validateRouteShiftId(routeShiftIdRaw);
  const shiftId = validation.ok ? validation.shiftId : '';
  const enabled = shouldStartShiftCloseAlertDetailQuery(role, isFirebaseConfigured, !!db, branchId, routeShiftIdRaw);

  const genKey = `${enabled ? '1' : '0'}::${role ?? ''}::${branchId ?? ''}::${shiftId}`;

  const [alertState, setAlertState] = useState<ShiftCloseAlertSourceState>(() => makeInitialAlertState(enabled));
  const [caseState, setCaseState] = useState<ShiftCloseCaseSourceState>(() => makeInitialCaseState(enabled));
  const [trackedGenKey, setTrackedGenKey] = useState(genKey);

  if (genKey !== trackedGenKey) {
    setTrackedGenKey(genKey);
    setAlertState(makeInitialAlertState(enabled));
    setCaseState(makeInitialCaseState(enabled));
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const alertRef = doc(db!, 'shiftCloseAlerts', shiftId);
    const unsubAlert = onSnapshot(
      alertRef,
      { includeMetadataChanges: true },
      (snap) => {
        if (cancelled) return;
        const exists = snap.exists();
        const data = exists ? (snap.data() as Record<string, unknown>) : null;
        const belongsToActiveBranch = !!data && data.branchId === branchId;
        setAlertState({
          status: 'ready',
          fromCache: snap.metadata.fromCache,
          empty: !belongsToActiveBranch,
          errorType: null,
          row: belongsToActiveBranch ? mapShiftCloseReviewRow(snap.id, data!) : null,
        });
      },
      (err) => {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        setAlertState({
          status: 'error',
          fromCache: false,
          empty: false,
          errorType: code === 'permission-denied' ? 'permission-denied' : 'generic',
          row: null,
        });
      },
    );

    const caseRef = doc(db!, 'shiftCloseCases', shiftId);
    const unsubCase = onSnapshot(
      caseRef,
      { includeMetadataChanges: true },
      (snap) => {
        if (cancelled) return;
        const exists = snap.exists();
        const data = exists ? (snap.data() as Record<string, unknown>) : null;
        const belongsToActiveBranch = !!data && data.branchId === branchId;
        setCaseState({
          status: 'ready',
          fromCache: snap.metadata.fromCache,
          empty: !belongsToActiveBranch,
          errorType: null,
          projection: belongsToActiveBranch ? mapShiftCloseCaseProjection(snap.id, data!) : null,
        });
      },
      (err) => {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        setCaseState({
          status: 'error',
          fromCache: false,
          empty: false,
          errorType: code === 'permission-denied' ? 'permission-denied' : 'generic',
          projection: null,
        });
      },
    );

    return () => {
      cancelled = true;
      unsubAlert();
      unsubCase();
    };
  }, [enabled, role, branchId, shiftId]);

  const integrityCautions = computeIntegrityCautions({
    alert: alertState.row,
    alertConfirmedEmpty: isSourceConfirmedEmpty(alertState),
    kase: caseState.projection,
    caseConfirmedEmpty: isSourceConfirmedEmpty(caseState),
  });

  return {
    routeValid: validation.ok,
    alert: alertState,
    case: caseState,
    integrityCautions,
  };
}
