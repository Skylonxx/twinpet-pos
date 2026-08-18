import {
  collection,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  orderBy,
  query,
  where,
  type Query,
  type QuerySnapshot,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from '../pos/deviceId';
import type { AsyncOrder, Order, OrderItem, Payment } from '../types';
import { buildPendingOverlay, mergeWithOverlay } from './asyncOverlay';
import { getDevSalesRecords, resetDevSalesRecords } from './devMock';
import {
  canonicalDataSignature,
  chronologyInputFromOrder,
  effectiveRevision,
  foldHighWater,
  parseChronology,
  queryServerBacked,
  readRevision,
  rowVerdict,
  sortChronologyStable,
  type AuxiliaryObservation,
  type HighWaterMap,
  type SnapshotMeta,
} from './historyFreshness';
import { type SaleRecord } from './types';

type PrimaryState = 'IN_FLIGHT' | 'RESOLVED_SERVER' | 'RESOLVED_CACHE' | 'FAILED';
type QualState = 'NOT_NEEDED' | 'NEEDED' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED';

type FsmCell = {
  primary: PrimaryState;
  qual: QualState;
  published: AuxiliaryObservation;
};

type Fsm = {
  dataGeneration: number;
  signature: string;
  cells: Map<number, FsmCell>;
  canonicalMeta: SnapshotMeta;
  itemMemo: Map<string, OrderItem[]>;
  highWater: HighWaterMap;
};

function emptyCell(): FsmCell {
  return { primary: 'IN_FLIGHT', qual: 'NOT_NEEDED', published: 'ABSENT' };
}

function logSalesHistoryError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'unknown';

  console.error(`[SalesHistory] ${context}`, {
    code,
    message,
    err,
  });

  if (
    message.includes('index') ||
    message.includes('FAILED_PRECONDITION') ||
    code === 'failed-precondition'
  ) {
    console.error(
      '[SalesHistory] อาจต้องสร้าง Firestore Index สำหรับ orders (branchId + createdAt) — ดูลิงก์ใน error message ด้านบน หรือใช้ query แบบ fallback',
    );
  }
}

function chunkIds(ids: string[], size = 10): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function snapMeta(snap: { metadata: { fromCache: boolean; hasPendingWrites: boolean } }): SnapshotMeta {
  return {
    fromCache: snap.metadata.fromCache === true,
    hasPendingWrites: snap.metadata.hasPendingWrites === true,
  };
}

function paymentsFromSnap(snap: QuerySnapshot, into: Map<string, Payment[]>): void {
  snap.forEach((d) => {
    const payment = { ...(d.data() as Payment), id: d.id };
    const list = into.get(payment.orderId) ?? [];
    list.push(payment);
    into.set(payment.orderId, list);
  });
}

function allChunksServerBacked(snaps: Array<{ metadata: { fromCache: boolean; hasPendingWrites: boolean } }>): boolean {
  return snaps.every((s) => s.metadata.fromCache === false && s.metadata.hasPendingWrites === false);
}

function buildOrdersQuery(branchId: string, withOrderBy: boolean): Query {
  const base = collection(db!, collections.orders);
  if (withOrderBy) {
    return query(base, where('branchId', '==', branchId), orderBy('createdAt', 'desc'));
  }
  return query(base, where('branchId', '==', branchId));
}

function mapCanonicalRecords(
  orders: Order[],
  paymentMap: Map<string, Payment[]>,
  queryMeta: SnapshotMeta,
  docMetas: Map<string, SnapshotMeta>,
  highWater: HighWaterMap,
  voidIntentIds: Set<string>,
  decorations: Map<string, AsyncOrder>,
  paymentPublished: AuxiliaryObservation,
): SaleRecord[] {
  return orders.map((order) => {
    const revision = readRevision(order);
    const eff = effectiveRevision(revision);
    const chrono = parseChronology(chronologyInputFromOrder(order));
    const docMeta = docMetas.get(order.id) ?? queryMeta;
    const overlay = decorations.get(order.id);
    const verdict = rowVerdict({
      canonicalPresent: true,
      overlayOnly: false,
      queryMeta,
      docMeta,
      revision,
      highWater: eff != null ? highWater.get(order.id) : undefined,
      chronologyValid: chrono.kind === 'VALID' || revision.kind === 'ABSENT',
      unreconciledVoidIntent: voidIntentIds.has(order.id) && order.status !== 'voided',
      voidAnomaly: overlay?.voidAnomaly,
      voidRevisionFault: overlay?.voidRevisionFault,
      localReconciliationAnomaly: false,
    });
    const record: SaleRecord = {
      order,
      payments: paymentMap.get(order.id) ?? [],
      items: [],
      verdict: verdict.verdict,
      verdictReason: verdict.reason,
    };
    // Hook-layer CURRENT gate: stale/failed payment AUX must not promote CURRENT.
    // paymentObservation is not an input to rowVerdict / AUTHORITATIVE (E08).
    if (record.verdict === 'CURRENT' && paymentPublished !== 'SERVER_OBSERVED') {
      record.verdict = 'UNPROVEN';
      record.verdictReason = record.verdictReason ?? 'QUERY_CACHE_RESOLVED';
    }
    return record;
  });
}

export function useSalesHistory(branchId: string | null) {
  const [records, setRecords] = useState<SaleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingRecords, setPendingRecords] = useState<SaleRecord[]>([]);
  const [asyncById, setAsyncById] = useState<Map<string, AsyncOrder>>(() => new Map());
  const [paymentObservation, setPaymentObservation] = useState<AuxiliaryObservation>('ABSENT');
  const [queryMeta, setQueryMeta] = useState<SnapshotMeta>({ fromCache: true, hasPendingWrites: false });

  const ordersRef = useRef<Order[]>([]);
  const paymentMapRef = useRef<Map<string, Payment[]>>(new Map());
  const docMetasRef = useRef<Map<string, SnapshotMeta>>(new Map());
  const voidIntentRef = useRef<Set<string>>(new Set());
  const asyncByIdRef = useRef<Map<string, AsyncOrder>>(new Map());

  const fsmRef = useRef<Fsm>({
    dataGeneration: 0,
    signature: '',
    cells: new Map(),
    canonicalMeta: { fromCache: true, hasPendingWrites: false },
    itemMemo: new Map(),
    highWater: new Map(),
  });

  const publishRecords = useCallback(() => {
    const fsm = fsmRef.current;
    const cell = fsm.cells.get(fsm.dataGeneration);
    const mapped = mapCanonicalRecords(
      ordersRef.current,
      paymentMapRef.current,
      fsm.canonicalMeta,
      docMetasRef.current,
      fsm.highWater,
      voidIntentRef.current,
      asyncByIdRef.current,
      cell?.published ?? 'ABSENT',
    );
    setRecords(mapped);
    setPaymentObservation(cell?.published ?? 'ABSENT');
    setQueryMeta(fsm.canonicalMeta);
  }, []);

  const fetchPaymentsPrimary = useCallback(async (generation: number, orderIds: string[]): Promise<void> => {
    if (!db) return;
    const fsm = fsmRef.current;
    const chunks = chunkIds(orderIds);
    const map = new Map<string, Payment[]>();
    const snaps: QuerySnapshot[] = [];
    try {
      for (const chunk of chunks) {
        if (chunk.length === 0) continue;
        const snap = await getDocs(
          query(collection(db, collections.payments), where('orderId', 'in', chunk)),
        );
        snaps.push(snap);
        paymentsFromSnap(snap, map);
      }
    } catch (err) {
      if (generation !== fsmRef.current.dataGeneration) return;
      const cell = fsm.cells.get(generation);
      if (cell) {
        cell.primary = 'FAILED';
        cell.published = 'ERROR';
        cell.qual = 'NOT_NEEDED';
      }
      logSalesHistoryError('โหลด payments ไม่สำเร็จ', err);
      throw err;
    }
    if (generation !== fsmRef.current.dataGeneration) return;
    const cell = fsm.cells.get(generation);
    if (!cell) return;
    paymentMapRef.current = map;
    if (allChunksServerBacked(snaps)) {
      cell.primary = 'RESOLVED_SERVER';
      cell.published = 'SERVER_OBSERVED';
      cell.qual = 'NOT_NEEDED';
      publishRecords();
      return;
    }
    cell.primary = 'RESOLVED_CACHE';
    cell.published = 'CACHE_OBSERVED';
    publishRecords();
    tryQualifyRef.current();
  }, [publishRecords]);

  const dispatchQualificationFromServer = useCallback((capturedG: number) => {
    void (async () => {
      if (!db) return;
      const ids = ordersRef.current.map((o) => o.id);
      const chunks = chunkIds(ids);
      const map = new Map<string, Payment[]>();
      try {
        const snaps: QuerySnapshot[] = [];
        for (const chunk of chunks) {
          if (chunk.length === 0) continue;
          const snap = await getDocsFromServer(
            query(collection(db, collections.payments), where('orderId', 'in', chunk)),
          );
          if (snap.metadata.fromCache === true) {
            throw new Error('qualification_cache_contract_violation');
          }
          snaps.push(snap);
          paymentsFromSnap(snap, map);
        }
        if (capturedG !== fsmRef.current.dataGeneration) return;
        const cell = fsmRef.current.cells.get(capturedG);
        if (!cell) return;
        cell.qual = 'SUCCEEDED';
        cell.published = 'SERVER_OBSERVED';
        paymentMapRef.current = map;
        publishRecords();
      } catch {
        if (capturedG !== fsmRef.current.dataGeneration) return;
        const cell = fsmRef.current.cells.get(capturedG);
        if (!cell) return;
        cell.qual = 'FAILED';
        cell.published = 'CACHE_OBSERVED';
        publishRecords();
      }
    })();
  }, [publishRecords]);

  const dispatchQualRef = useRef(dispatchQualificationFromServer);
  dispatchQualRef.current = dispatchQualificationFromServer;

  function tryQualifyPayments(): void {
    const fsm = fsmRef.current;
    const capturedG = fsm.dataGeneration;
    const cell = fsm.cells.get(capturedG);
    if (!cell) return;
    if (cell.qual !== 'NOT_NEEDED') return;
    if (cell.primary !== 'RESOLVED_CACHE') return;
    if (!queryServerBacked(fsm.canonicalMeta)) return;
    // [Q-TRY] BEGIN
    cell.qual = 'IN_FLIGHT';
    dispatchQualRef.current(capturedG);
    // [Q-TRY] END
  }

  const tryQualifyRef = useRef(tryQualifyPayments);
  tryQualifyRef.current = tryQualifyPayments;

  const refresh = useCallback(() => {
    if (!branchId) {
      setRecords([]);
      return;
    }
    if (!isFirebaseConfigured || !db) {
      setRecords(resetDevSalesRecords(branchId));
      return;
    }
    setReloadToken((t) => t + 1);
  }, [branchId]);

  useEffect(() => {
    if (!branchId) {
      setRecords([]);
      setLoading(false);
      setError(null);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setLoading(false);
      setError(null);
      setRecords(getDevSalesRecords(branchId));
      return;
    }

    setLoading(true);
    setError(null);

    let cancelled = false;
    let unsub = () => {};
    let useOrderBy = true;

    const subscribe = (withOrderBy: boolean) => {
      unsub();
      const q = buildOrdersQuery(branchId, withOrderBy);

      console.info(
        `[SalesHistory] เริ่ม subscribe orders — branchId=${branchId}, orderBy=${withOrderBy}`,
      );

      unsub = onSnapshot(
        q,
        { includeMetadataChanges: true },
        (snap) => {
          try {
            const orders = snap.docs.map((d) => ({ ...(d.data() as Order), id: d.id }));
            const docMetas = new Map<string, SnapshotMeta>();
            snap.docs.forEach((d) => docMetas.set(d.id, snapMeta(d)));
            docMetasRef.current = docMetas;
            ordersRef.current = orders;

            const fsm = fsmRef.current;
            fsm.canonicalMeta = snapMeta(snap);

            for (const change of snap.docChanges()) {
              if (change.type === 'removed') {
                const prefix = `${fsm.dataGeneration}:`;
                for (const key of [...fsm.itemMemo.keys()]) {
                  if (key.endsWith(`:${change.doc.id}`) || key === `${prefix}${change.doc.id}`) {
                    fsm.itemMemo.delete(key);
                  }
                }
              }
            }

            let highWater = fsm.highWater;
            for (const order of orders) {
              const rev = readRevision(order);
              const eff = effectiveRevision(rev);
              if (eff != null && eff > 0) highWater = foldHighWater(highWater, order.id, eff);
            }
            fsm.highWater = highWater;

            const signature = canonicalDataSignature(
              orders.map((o) => ({
                id: o.id,
                status: o.status,
                updatedAt: o.updatedAt,
                total: o.total,
                historyRev: o.historyRev,
              })),
            );

            const generationChanged = signature !== fsm.signature || fsm.dataGeneration === 0;
            if (generationChanged) {
              fsm.signature = signature;
              fsm.dataGeneration += 1;
              fsm.itemMemo = new Map();
              fsm.cells.set(fsm.dataGeneration, emptyCell());
              void fetchPaymentsPrimary(fsm.dataGeneration, orders.map((o) => o.id)).catch((err) => {
                if (!cancelled) {
                  setError(err instanceof Error ? err : new Error(String(err)));
                  setLoading(false);
                }
              });
            }

            tryQualifyRef.current();
            publishRecords();
            setError(null);
            setLoading(false);
          } catch (err) {
            logSalesHistoryError('ประมวลผล orders snapshot ไม่สำเร็จ', err);
            if (!cancelled) {
              setError(err instanceof Error ? err : new Error(String(err)));
              setLoading(false);
            }
          }
        },
        (err) => {
          logSalesHistoryError('subscribe orders ไม่สำเร็จ', err);

          if (cancelled) return;

          const message = err instanceof Error ? err.message : String(err);
          const missingIndex =
            message.includes('index') ||
            message.includes('FAILED_PRECONDITION') ||
            (err as { code?: string }).code === 'failed-precondition';

          if (useOrderBy && missingIndex) {
            console.warn('[SalesHistory] ใช้ fallback query (branchId เท่านั้น) เนื่องจากไม่มี composite index');
            useOrderBy = false;
            subscribe(false);
            return;
          }

          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        },
      );
    };

    subscribe(true);

    return () => {
      cancelled = true;
      unsub();
    };
  }, [branchId, reloadToken, fetchPaymentsPrimary, publishRecords]);

  useEffect(() => {
    if (!branchId || !isFirebaseConfigured || !db) {
      setPendingRecords([]);
      voidIntentRef.current = new Set();
      setAsyncById(new Map());
      return;
    }
    const q = query(
      collection(db, 'asyncOrders'),
      where('branchId', '==', branchId),
      where('deviceId', '==', getDeviceId()),
    );
    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        const orders = snap.docs.map((d) => ({ ...(d.data() as AsyncOrder), id: d.id }));
        const byId = new Map(orders.map((o) => [o.id, o]));
        asyncByIdRef.current = byId;
        setAsyncById(byId);
        setPendingRecords(buildPendingOverlay(orders));
        voidIntentRef.current = new Set(orders.filter((o) => o.voidRequested === true).map((o) => o.id));
        publishRecords();
      },
      (err) => console.warn('[SalesHistory] async-overlay listener error', err),
    );
    return unsub;
  }, [branchId, publishRecords]);

  const loadItems = useCallback(
    async (orderId: string): Promise<OrderItem[]> => {
      const pending = pendingRecords.find((r) => r.order.id === orderId);
      if (pending) return pending.items;

      if (!isFirebaseConfigured || !db) {
        const rec = records.find((r) => r.order.id === orderId);
        return rec?.items ?? [];
      }

      const g = fsmRef.current.dataGeneration;
      const key = `${g}:${orderId}`;
      const hit = fsmRef.current.itemMemo.get(key);
      if (hit) return hit;

      try {
        const snap = await getDocs(collection(db, collections.orders, orderId, collections.orderItems));
        const items = snap.docs.map((d) => ({ ...(d.data() as OrderItem), id: d.id }));
        if (g === fsmRef.current.dataGeneration) {
          fsmRef.current.itemMemo.set(key, items);
        }
        return items;
      } catch (err) {
        logSalesHistoryError(`โหลด orderItems ไม่สำเร็จ (orderId=${orderId})`, err);
        throw err;
      }
    },
    [records, pendingRecords],
  );

  const syncDevRecords = useCallback(() => {
    if (branchId) setRecords(getDevSalesRecords(branchId));
  }, [branchId]);

  const sortedRecords = useMemo(() => {
    const merged = mergeWithOverlay(records, pendingRecords, asyncById).map((r) => {
      if (r.localReconciliationAnomaly) {
        return {
          ...r,
          verdict: 'ERROR' as const,
          verdictReason: 'ROW_LOCAL_RECONCILIATION_ANOMALY' as const,
        };
      }
      if (r.pendingSync) {
        const overlayVerdict = rowVerdict({
          canonicalPresent: false,
          overlayOnly: true,
          queryMeta,
          docMeta: queryMeta,
          revision: { kind: 'ABSENT' },
          highWater: undefined,
          chronologyValid: true,
          unreconciledVoidIntent: false,
          voidAnomaly: r.voidAnomaly,
          voidRevisionFault: r.voidRevisionFault,
        });
        return {
          ...r,
          verdict: overlayVerdict.verdict,
          verdictReason: overlayVerdict.reason,
        };
      }
      if (r.voidAnomaly || r.voidRevisionFault) {
        const gated = rowVerdict({
          canonicalPresent: true,
          overlayOnly: false,
          queryMeta,
          docMeta: queryMeta,
          revision: readRevision(r.order),
          highWater: undefined,
          chronologyValid: true,
          unreconciledVoidIntent: r.verdictReason === 'VOID_INTENT_UNRECONCILED',
          voidAnomaly: r.voidAnomaly,
          voidRevisionFault: r.voidRevisionFault,
          localReconciliationAnomaly: r.localReconciliationAnomaly,
        });
        return {
          ...r,
          verdict: gated.verdict,
          verdictReason: gated.reason,
        };
      }
      return r;
    });
    const sortable = merged.map((record) => ({
      ...chronologyInputFromOrder(record.order),
      id: record.order.id,
      record,
    }));
    return sortChronologyStable(sortable).map((row) => row.record);
  }, [records, pendingRecords, asyncById, queryMeta]);

  return {
    records: sortedRecords,
    loading,
    error,
    loadItems,
    syncDevRecords,
    refresh,
    paymentObservation,
    queryMeta,
  };
}
