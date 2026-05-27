import { useCallback, useEffect, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock, StockLot, StockMovement } from '../types';
import {
  devGetProduct,
  devSaveProduct,
  devSoftDeleteProduct,
  devUpdateLotCost,
  getDevLots,
  getDevMovements,
  getDevProductList,
} from './devMock';
import { formToProduct, type ProductFormData, type ProductListItem } from './types';

function tsNow(): Product['createdAt'] {
  return serverTimestamp() as Product['createdAt'];
}

function movementCreatedAtMs(createdAt: StockMovement['createdAt']): number {
  if (
    createdAt != null &&
    typeof createdAt === 'object' &&
    'toDate' in createdAt &&
    typeof (createdAt as { toDate: unknown }).toDate === 'function'
  ) {
    return (createdAt as { toDate: () => Date }).toDate().getTime();
  }
  if (
    createdAt != null &&
    typeof createdAt === 'object' &&
    'seconds' in createdAt &&
    typeof (createdAt as { seconds: unknown }).seconds === 'number'
  ) {
    return (createdAt as { seconds: number }).seconds * 1000;
  }
  return 0;
}

function sortMovementsDesc(rows: StockMovement[]): StockMovement[] {
  return [...rows].sort((a, b) => movementCreatedAtMs(b.createdAt) - movementCreatedAtMs(a.createdAt));
}

async function loadProductStocks(productId: string, branchId: string): Promise<ProductStock | null> {
  if (!db) return null;
  const ref = doc(db, collections.products, productId, collections.productStocks, branchId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() as ProductStock;
}

export function useProductCrud(branchId: string | null) {
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) {
      setProducts([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      if (!isFirebaseConfigured || !db) {
        setProducts(getDevProductList(branchId));
        return;
      }

      const snap = await getDocs(collection(db, collections.products));
      const raw = snap.docs
        .map((d) => ({ ...(d.data() as Product), id: d.id }))
        .filter((p) => !p.deletedAt);

      const list = await Promise.all(
        raw.map(async (product) => {
          const stockDoc = await loadProductStocks(product.id, branchId);
          const stock = stockDoc?.totalStockBase ?? 0;
          const branchReorderPoint = stockDoc?.reorderPoint ?? product.reorderPoint;
          return {
            ...product,
            stock,
            branchReorderPoint,
            emoji: '📦',
            retailPrice:
              product.prices.find((p) => p.priceLevelId === 'RETAIL' && p.unit === product.baseUnit)?.price ??
              product.prices[0]?.price ??
              0,
          } satisfies ProductListItem;
        }),
      );

      setProducts(list);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProduct = useCallback(
    async (form: ProductFormData, editId?: string) => {
      if (!branchId) return;
      setSaving(true);
      try {
        const id = editId ?? `prod-${Date.now()}`;
        const payload = formToProduct(form, id);

        if (!isFirebaseConfigured || !db) {
          const existing = editId ? devGetProduct(editId) : null;
          devSaveProduct(
            { ...payload, avgCost: existing?.avgCost ?? form.initialCost, deletedAt: null, createdAt: existing?.createdAt ?? tsNow(), updatedAt: tsNow() },
            {
              branchId,
              totalStockBase: existing ? (getDevProductList(branchId).find((p) => p.id === id)?.stock ?? 0) : 0,
              reorderPoint: form.reorderPoint,
              lastMovementAt: tsNow(),
              updatedAt: tsNow(),
            },
          );
          setProducts(getDevProductList(branchId));
          return id;
        }

        const ref = doc(db, collections.products, id);
        const existingSnap = editId ? await getDoc(ref) : null;
        await setDoc(
          ref,
          {
            ...payload,
            avgCost: existingSnap?.exists() ? (existingSnap.data() as Product).avgCost : form.initialCost,
            deletedAt: null,
            updatedAt: serverTimestamp(),
            ...(existingSnap?.exists() ? {} : { createdAt: serverTimestamp() }),
          },
          { merge: true },
        );

        await setDoc(
          doc(db, collections.products, id, collections.productStocks, branchId),
          {
            branchId,
            reorderPoint: form.reorderPoint,
            updatedAt: serverTimestamp(),
            ...(existingSnap?.exists()
              ? {}
              : { totalStockBase: 0, lastMovementAt: serverTimestamp() }),
          },
          { merge: true },
        );

        await load();
        return id;
      } finally {
        setSaving(false);
      }
    },
    [branchId, load],
  );

  const softDelete = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        if (!isFirebaseConfigured || !db) {
          devSoftDeleteProduct(id);
          if (branchId) setProducts(getDevProductList(branchId));
          return;
        }
        await updateDoc(doc(db, collections.products, id), {
          deletedAt: serverTimestamp(),
          isActive: false,
          updatedAt: serverTimestamp(),
        });
        await load();
      } finally {
        setSaving(false);
      }
    },
    [branchId, load],
  );

  const fetchLots = useCallback(
    async (productId: string): Promise<StockLot[]> => {
      if (!branchId) return [];
      if (!isFirebaseConfigured || !db) return getDevLots(productId, branchId);

      const q = query(
        collection(db, collections.stockLots),
        where('productId', '==', productId),
        where('branchId', '==', branchId),
        orderBy('receivedAt', 'asc'),
      );
      const snap = await getDocs(q);
      return snap.docs.map((d) => ({ ...(d.data() as StockLot), id: d.id }));
    },
    [branchId],
  );

  const fetchMovements = useCallback(
    async (productId: string): Promise<StockMovement[]> => {
      if (!branchId) return [];
      if (!isFirebaseConfigured || !db) return getDevMovements(productId, branchId);

      const mapDocs = (snap: Awaited<ReturnType<typeof getDocs>>) =>
        snap.docs.map((d) => ({ ...(d.data() as StockMovement), id: d.id }));

      const forBranch = (rows: StockMovement[]) =>
        sortMovementsDesc(rows.filter((m) => m.branchId === branchId));

      try {
        const q = query(
          collection(db, collections.stockMovements),
          where('productId', '==', productId),
          orderBy('createdAt', 'desc'),
        );
        const snap = await getDocs(q);
        return forBranch(mapDocs(snap));
      } catch (err) {
        console.error('Error fetching movements:', err);

        try {
          const fallbackQ = query(
            collection(db, collections.stockMovements),
            where('productId', '==', productId),
          );
          const snap = await getDocs(fallbackQ);
          return forBranch(mapDocs(snap));
        } catch (fallbackErr) {
          console.error('Error fetching movements:', fallbackErr);
          return [];
        }
      }
    },
    [branchId],
  );

  const updateLotCost = useCallback(
    async (lotId: string, cost: number, _productId: string) => {
      if (!isFirebaseConfigured || !db) {
        devUpdateLotCost(lotId, cost);
        if (branchId) setProducts(getDevProductList(branchId));
        return;
      }
      await updateDoc(doc(db, collections.stockLots, lotId), { costPerUnit: cost });
      await load();
    },
    [branchId, load],
  );

  return {
    products,
    loading,
    saving,
    saveProduct,
    softDelete,
    fetchLots,
    fetchMovements,
    updateLotCost,
    reload: load,
  };
}
