import { collection, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { OrderItem } from '../types';

export type LiveItemsState = 'idle' | 'loading' | 'live' | 'unavailable' | 'error';

type RequestSession = {
  branchId: string | null;
  orderId: string | null;
  attachable: boolean;
  activeAttachmentId: number | null;
  issuedSeq: number;
};

type LiveItemsObservation = {
  sourceBranchId: string;
  sourceOrderId: string;
  sourceAttachmentId: number;
  items: OrderItem[];
  state: 'loading' | 'live' | 'unavailable' | 'error';
  fromCache: boolean;
};

function rotateSession(
  session: RequestSession,
  branchId: string | null,
  orderId: string | null,
  attachable: boolean,
): RequestSession {
  if (!attachable) {
    return {
      branchId,
      orderId,
      attachable: false,
      activeAttachmentId: null,
      issuedSeq: session.issuedSeq,
    };
  }
  const nextId = session.issuedSeq + 1;
  return {
    branchId,
    orderId,
    attachable: true,
    activeAttachmentId: nextId,
    issuedSeq: nextId,
  };
}

function initialSession(
  branchId: string | null,
  orderId: string | null,
  ready: boolean,
): RequestSession {
  const attachable = branchId != null && orderId != null && ready;
  return attachable
    ? { branchId, orderId, attachable: true, activeAttachmentId: 1, issuedSeq: 1 }
    : { branchId, orderId, attachable: false, activeAttachmentId: null, issuedSeq: 0 };
}

export function useOrderItemsLive(
  branchId: string | null,
  orderId: string | null,
): {
  items: OrderItem[];
  state: LiveItemsState;
  fromCache: boolean;
} {
  const ready = isFirebaseConfigured && !!db;
  const attachable = branchId != null && orderId != null && ready;
  const [session, setSession] = useState<RequestSession>(() => initialSession(branchId, orderId, ready));
  const [observation, setObservation] = useState<LiveItemsObservation | null>(null);

  const requestChanged =
    session.branchId !== branchId || session.orderId !== orderId || session.attachable !== attachable;

  let effectiveSession = session;
  if (requestChanged) {
    effectiveSession = rotateSession(session, branchId, orderId, attachable);
    setSession(effectiveSession);
  }

  const currentAttachmentId = effectiveSession.activeAttachmentId;

  useEffect(() => {
    if (!attachable || currentAttachmentId == null || !db || branchId == null || orderId == null) {
      return;
    }
    const subscribedBranchId = branchId;
    const subscribedOrderId = orderId;
    const subscribedAttachmentId = currentAttachmentId;
    const col = collection(db, collections.orders, orderId, collections.orderItems);
    const unsub: Unsubscribe = onSnapshot(
      col,
      { includeMetadataChanges: true },
      (snap) => {
        const items = snap.docs.map((d) => ({ ...(d.data() as OrderItem), id: d.id }));
        const fromCache = snap.metadata.fromCache;
        const nextState: LiveItemsObservation['state'] =
          fromCache && items.length === 0 ? 'unavailable' : fromCache ? 'loading' : items.length === 0 ? 'unavailable' : 'live';
        setObservation((prev) => {
          const next: LiveItemsObservation = {
            sourceBranchId: subscribedBranchId,
            sourceOrderId: subscribedOrderId,
            sourceAttachmentId: subscribedAttachmentId,
            items,
            state: fromCache ? (items.length === 0 ? 'unavailable' : 'loading') : nextState,
            fromCache,
          };
          if (!fromCache && items.length > 0) next.state = 'live';
          if (!fromCache && items.length === 0) next.state = 'unavailable';
          if (prev != null && prev.sourceAttachmentId > subscribedAttachmentId) return prev;
          return next;
        });
      },
      () => {
        setObservation((prev) => {
          const next: LiveItemsObservation = {
            sourceBranchId: subscribedBranchId,
            sourceOrderId: subscribedOrderId,
            sourceAttachmentId: subscribedAttachmentId,
            items: [],
            state: 'error',
            fromCache: false,
          };
          if (prev != null && prev.sourceAttachmentId > subscribedAttachmentId) return prev;
          return next;
        });
      },
    );
    return unsub;
  }, [branchId, orderId, ready, currentAttachmentId, attachable]);

  if (branchId == null || orderId == null || !ready) {
    return { items: [], state: 'idle', fromCache: false };
  }

  const observationMatchesCurrentLifetime =
    observation != null &&
    currentAttachmentId != null &&
    observation.sourceBranchId === branchId &&
    observation.sourceOrderId === orderId &&
    observation.sourceAttachmentId === currentAttachmentId;

  if (!observationMatchesCurrentLifetime) {
    return { items: [], state: 'loading', fromCache: false };
  }

  return {
    items: observation.items,
    state: observation.state,
    fromCache: observation.fromCache,
  };
}
