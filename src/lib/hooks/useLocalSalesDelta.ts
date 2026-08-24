import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from '../pos/deviceId';
import {
  classifyLocalSaleRetirements,
  eligibleSnapshotFromOrders,
  selectLocalSalesDelta,
  type EligibleLocalSaleSnap,
} from '../pos/localSalesDelta';
import type { AsyncOrder } from '../types';

export type LocalSalesDeltaState = {
  delta: Map<string, number>;
  /** Increments only when a normal-settlement retirement is observed. */
  normalSettlementSeq: number;
  lastNormalSettlementOrderIds: string[];
  lastNormalSettlementProductIds: string[];
};

const EMPTY_DELTA: LocalSalesDeltaState = {
  delta: new Map(),
  normalSettlementSeq: 0,
  lastNormalSettlementOrderIds: [],
  lastNormalSettlementProductIds: [],
};

function isFailClosedBranch(branchId: string | null): boolean {
  return branchId == null || branchId === '' || branchId === 'ALL';
}

/**
 * This-terminal local-sales delta from the `asyncOrders` Firestore cache.
 * Scope: authenticated caller `branchId` + `getDeviceId()`. Fail-closed on
 * null / `ALL`. Does not use canonicalSyncContext.
 */
export function useLocalSalesDelta(branchId: string | null): LocalSalesDeltaState {
  const [state, setState] = useState<LocalSalesDeltaState>(EMPTY_DELTA);
  const previousEligibleRef = useRef<Map<string, EligibleLocalSaleSnap>>(new Map());
  const seqRef = useRef(0);

  useEffect(() => {
    if (isFailClosedBranch(branchId) || !isFirebaseConfigured || !db) {
      previousEligibleRef.current = new Map();
      seqRef.current = 0;
      setState(EMPTY_DELTA);
      return;
    }

    const deviceId = getDeviceId();
    const q = query(
      collection(db, 'asyncOrders'),
      where('branchId', '==', branchId),
      where('deviceId', '==', deviceId),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const orders = snap.docs.map((d) => ({ ...(d.data() as AsyncOrder), id: d.id }));
        const delta = selectLocalSalesDelta(orders);
        const classification = classifyLocalSaleRetirements(previousEligibleRef.current, orders);
        previousEligibleRef.current = eligibleSnapshotFromOrders(orders);

        if (classification.normalSettlement.length > 0) {
          seqRef.current += 1;
          setState({
            delta,
            normalSettlementSeq: seqRef.current,
            lastNormalSettlementOrderIds: classification.normalSettlement,
            lastNormalSettlementProductIds: classification.affectedProductIds,
          });
          return;
        }

        setState((prev) => ({
          ...prev,
          delta,
        }));
      },
      (err) => console.warn('[useLocalSalesDelta] listener error', err),
    );

    return unsub;
  }, [branchId]);

  return state;
}
