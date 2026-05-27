import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock, StockLot, StockMovement } from '../types';
import { getDevStockReportData } from './devMock';
import {
  buildProductRows,
  computeCogsFromMovements,
  movementDisplayType,
  productVisual,
  tsToDate,
  type StockReportMovement,
  type StockReportProduct,
} from './types';

export function useStockReport(branchId: string | null) {
  const [products, setProducts] = useState<StockReportProduct[]>([]);
  const [movements, setMovements] = useState<StockReportMovement[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const loadDev = useCallback(() => {
    if (!branchId) return { products: [] as StockReportProduct[], movements: [] as StockReportMovement[], categories: [] as string[] };
    const dev = getDevStockReportData(branchId);
    const rows = buildProductRows(
      dev.products,
      dev.stocks,
      dev.reorderMap,
      dev.lotsByProduct,
      dev.cogsByProduct,
    ).map((r) => {
      const v = dev.visualMap.get(r.id);
      return v ? { ...r, emoji: v.emoji, iconBg: v.iconBg } : r;
    });
    const mv = dev.movements.map((m) => {
      const p = rows.find((r) => r.id === m.productId);
      return {
        ...m,
        productName: p?.name ?? m.productId,
        productSku: p?.sku ?? '',
        emoji: p?.emoji ?? '📦',
        iconBg: p?.iconBg ?? '#EEEDFE',
        displayType: movementDisplayType(m.type),
        staffName: 'พนักงาน',
      };
    });
    const cats = [...new Set(rows.map((r) => r.category))].sort();
    return { products: rows, movements: mv, categories: cats };
  }, [branchId]);

  useEffect(() => {
    if (!branchId) {
      setProducts([]);
      setMovements([]);
      setCategories([]);
      setLoading(false);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      const dev = loadDev();
      setProducts(dev.products);
      setMovements(dev.movements);
      setCategories(dev.categories);
      setLoading(false);
      setLastUpdated(new Date());
      return;
    }

    setLoading(true);
    let cancelled = false;

    const productMap = new Map<string, Product>();
    const stockMap = new Map<string, number>();
    const reorderMap = new Map<string, number>();
    let lotsByProduct = new Map<string, StockLot[]>();
    let rawMovements: StockMovement[] = [];

    async function rebuild() {
      const cogsDefault = computeCogsFromMovements(rawMovements, '', '');
      const rows = buildProductRows(
        [...productMap.values()].filter((p) => p.isActive && !p.deletedAt),
        stockMap,
        reorderMap,
        lotsByProduct,
        cogsDefault,
      );
      const mv: StockReportMovement[] = rawMovements.map((m) => {
        const p = rows.find((r) => r.id === m.productId);
        const visual = p ?? productVisual(productMap.get(m.productId)?.category ?? '');
        return {
          ...m,
          productName: p?.name ?? productMap.get(m.productId)?.name ?? m.productId,
          productSku: p?.sku ?? productMap.get(m.productId)?.sku ?? '',
          emoji: p?.emoji ?? visual.emoji,
          iconBg: p?.iconBg ?? visual.iconBg,
          displayType: movementDisplayType(m.type),
          staffName: m.createdBy,
        };
      });
      if (!cancelled) {
        setProducts(rows);
        setMovements(mv.sort((a, b) => tsToDate(b.createdAt).getTime() - tsToDate(a.createdAt).getTime()));
        setCategories([...new Set(rows.map((r) => r.category))].sort());
        setLoading(false);
        setLastUpdated(new Date());
      }
    }

    async function loadStocks(productIds: string[]) {
      if (!branchId) return;
      stockMap.clear();
      reorderMap.clear();
      await Promise.all(
        productIds.map(async (pid) => {
          const ref = doc(db!, collections.products, pid, collections.productStocks, branchId);
          const snap = await getDoc(ref);
          if (!snap.exists()) return;
          const data = snap.data() as ProductStock;
          stockMap.set(pid, data.totalStockBase ?? 0);
          reorderMap.set(pid, data.reorderPoint ?? 0);
        }),
      );
    }

    const unsubProducts = onSnapshot(
      query(collection(db!, collections.products), where('isActive', '==', true)),
      async (snap) => {
        productMap.clear();
        snap.forEach((d) => productMap.set(d.id, { ...(d.data() as Product), id: d.id }));
        await loadStocks([...productMap.keys()]);
        void rebuild();
      },
    );

    const unsubLots = onSnapshot(
      query(
        collection(db!, collections.stockLots),
        where('branchId', '==', branchId),
        where('isDepleted', '==', false),
        orderBy('receivedAt', 'asc'),
      ),
      (snap) => {
        lotsByProduct = new Map();
        snap.forEach((d) => {
          const lot = { ...(d.data() as StockLot), id: d.id };
          const list = lotsByProduct.get(lot.productId) ?? [];
          list.push(lot);
          lotsByProduct.set(lot.productId, list);
        });
        void rebuild();
      },
    );

    const unsubMovements = onSnapshot(
      query(
        collection(db!, collections.stockMovements),
        where('branchId', '==', branchId),
        orderBy('createdAt', 'desc'),
      ),
      (snap) => {
        rawMovements = snap.docs.map((d) => ({ ...(d.data() as StockMovement), id: d.id }));
        void rebuild();
      },
      async () => {
        const fallback = await getDocs(
          query(collection(db!, collections.stockMovements), where('branchId', '==', branchId)),
        );
        rawMovements = fallback.docs.map((d) => ({ ...(d.data() as StockMovement), id: d.id }));
        void rebuild();
      },
    );

    return () => {
      cancelled = true;
      unsubProducts();
      unsubLots();
      unsubMovements();
    };
  }, [branchId, loadDev]);

  const refresh = useCallback(() => {
    if (!branchId) return;
    if (!isFirebaseConfigured || !db) {
      const dev = loadDev();
      setProducts(dev.products);
      setMovements(dev.movements);
      setCategories(dev.categories);
      setLastUpdated(new Date());
    }
  }, [branchId, loadDev]);

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  return { products, movements, categories, loading, lastUpdated, refresh, productMap };
}

export function applyCogsRange(
  products: StockReportProduct[],
  movements: StockMovement[],
  from: string,
  to: string,
): StockReportProduct[] {
  const cogsMap = computeCogsFromMovements(movements, from, to);
  return products.map((p) => ({
    ...p,
    cogsMonth: cogsMap.get(p.id) ?? p.cogsMonth,
  }));
}
