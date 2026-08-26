/**
 * Model 2 approver roster — live `users` subscription for the selected
 * concrete branch plus `ALL` (admin) candidates. Gate-first: no subscription
 * when disabled. Raw snapshots are projected immediately through
 * `approverEligibility` (RM-1). Cache-only empty is not confirmed empty.
 */

import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import {
  isEligibleApproverCandidate,
  projectApproverCandidate,
  type ApproverCandidate,
  type ApproverEligibilitySource,
} from './approverEligibility';

export type ApproverRosterStatus = 'disabled' | 'pending' | 'ready' | 'error';

export type ApproverRosterState = {
  status: ApproverRosterStatus;
  fromCache: boolean;
  candidates: ApproverCandidate[];
};

function makeInitialState(enabled: boolean): ApproverRosterState {
  return {
    status: enabled ? 'pending' : 'disabled',
    fromCache: false,
    candidates: [],
  };
}

function sourceFromDoc(id: string, data: Record<string, unknown>): ApproverEligibilitySource {
  return {
    userId: id,
    firstName: typeof data.firstName === 'string' ? data.firstName : '',
    lastName: typeof data.lastName === 'string' ? data.lastName : '',
    username: typeof data.username === 'string' ? data.username : '',
    role: typeof data.role === 'string' ? data.role : '',
    isActive: data.isActive === true,
    deletedAt: data.deletedAt ?? null,
    branchIds: data.branchIds,
  };
}

export function shouldStartApproverRosterQuery(
  enabled: boolean,
  firebaseReady: boolean,
  dbPresent: boolean,
  branchId: string | null | undefined,
): boolean {
  return (
    enabled &&
    firebaseReady &&
    dbPresent &&
    !!branchId &&
    branchId !== 'ALL'
  );
}

export function useApproverRoster(params: {
  enabled: boolean;
  branchId: string | null | undefined;
  requesterStaffId: string | null | undefined;
}): ApproverRosterState {
  const { enabled, branchId, requesterStaffId } = params;
  const gated = shouldStartApproverRosterQuery(enabled, isFirebaseConfigured, !!db, branchId);
  const resetKey = `${gated ? '1' : '0'}::${branchId ?? ''}::${requesterStaffId ?? ''}`;

  const [state, setState] = useState<ApproverRosterState>(() => makeInitialState(gated));
  const [trackedResetKey, setTrackedResetKey] = useState(resetKey);

  if (resetKey !== trackedResetKey) {
    setTrackedResetKey(resetKey);
    setState(makeInitialState(gated));
  }

  useEffect(() => {
    if (!gated) return;

    const q = query(
      collection(db!, 'users'),
      where('branchIds', 'array-contains-any', [branchId, 'ALL']),
    );
    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        const ctx = { branchId: branchId as string, requesterStaffId: requesterStaffId ?? '' };
        const candidates = snap.docs
          .map((d) => sourceFromDoc(d.id, (d.data() ?? {}) as Record<string, unknown>))
          .filter((u) => isEligibleApproverCandidate(u, ctx))
          .map(projectApproverCandidate);
        setState({
          status: 'ready',
          fromCache: snap.metadata.fromCache,
          candidates,
        });
      },
      () => {
        setState({
          status: 'error',
          fromCache: false,
          candidates: [],
        });
      },
    );

    return unsubscribe;
  }, [gated, branchId, requesterStaffId]);

  return state;
}
