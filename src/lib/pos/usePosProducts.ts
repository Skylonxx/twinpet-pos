import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  collectionGroup,
  doc,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product } from '../types';
import { RETAIL_PRICE_LEVEL_ID } from '../types';
import { DEV_POS_PRODUCTS } from './devProducts';
import type { PosProduct, UomOption } from './types';

const CATEGORY_EMOJI: Record<string, string> = {
  'อาหารสุนัข': '🐕',
  'อาหารแมว': '🐱',
  'อาหารสัตว์': '🐾',
  'ทรีทและขนม': '🍪',
  'ของเล่น': '🧸',
  'ยาและวิตามิน': '💊',
  'อุปกรณ์': '💧',
  'ทรายแมว': '🪣',
};

function isIndexError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'failed-precondition' || code === 'unimplemented';
}

function buildUomOptions(product: Product): UomOption[] {
  const retailPrices = product.prices.filter((p) => p.priceLevelId === RETAIL_PRICE_LEVEL_ID);
  const options: UomOption[] = [];

  const basePrice =
    retailPrices.find((p) => p.unit === product.baseUnit)?.price ??
    retailPrices[0]?.price ??
    0;

  options.push({
    unit: product.baseUnit,
    factor: 1,
    price: basePrice,
    barcode: product.barcode ?? null,
  });

  for (const conv of product.uomConversions) {
    const price =
      retailPrices.find((p) => p.unit === conv.unit)?.price ??
      basePrice * conv.factor;
    options.push({ unit: conv.unit, factor: conv.factor, price, barcode: conv.barcode ?? null });
  }

  const unique = new Map<string, UomOption>();
  for (const o of options) unique.set(o.unit, o);
  return [...unique.values()];
}

type StockEntry = { stock: number; overrideTierPrices?: Record<string, number> };

function toPosProduct(product: Product, entry: StockEntry): PosProduct {
  const uomOptions = buildUomOptions(product);
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? null,
    category: product.category,
    emoji: CATEGORY_EMOJI[product.category] ?? '📦',
    imageUrl: product.imageUrl ?? null,
    stock: entry.stock,
    baseUnit: product.baseUnit,
    allowNegativeStock: product.allowNegativeStock ?? false,
    tierPrices: product.tierPrices,
    overrideTierPrices: entry.overrideTierPrices,
    branchSettings: product.branchSettings,
    uomOptions,
  };
}

function mergePosProducts(rawProducts: Product[], stockByProduct: Map<string, StockEntry>): PosProduct[] {
  return rawProducts.map((p) => toPosProduct(p, stockByProduct.get(p.id) ?? { stock: 0 }));
}

export function usePosProducts(branchId: string | null) {
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!branchId) {
      setProducts([]);
      setLoading(false);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setProducts(DEV_POS_PRODUCTS);
      setLoading(false);
      return;
    }

    setLoading(true);

    let rawProducts: Product[] = [];
    const stockByProduct = new Map<string, StockEntry>();
    const perProductStockUnsubs = new Map<string, Unsubscribe>();
    let stockGroupUnsub: Unsubscribe | null = null;
    let usePerProductStock = false;

    const publish = () => {
      setProducts(mergePosProducts(rawProducts, stockByProduct));
      setLoading(false);
    };

    const clearPerProductStockListeners = () => {
      for (const unsub of perProductStockUnsubs.values()) unsub();
      perProductStockUnsubs.clear();
    };

    const syncPerProductStockListeners = (productIds: string[]) => {
      const idSet = new Set(productIds);

      for (const [id, unsub] of perProductStockUnsubs) {
        if (!idSet.has(id)) {
          unsub();
          perProductStockUnsubs.delete(id);
          stockByProduct.delete(id);
        }
      }

      for (const id of productIds) {
        if (perProductStockUnsubs.has(id)) continue;

        const stockRef = doc(
          db!,
          collections.products,
          id,
          collections.productStocks,
          branchId,
        );

        const unsub = onSnapshot(
          stockRef,
          (snap) => {
            const data = snap.exists() ? snap.data() : null;
            stockByProduct.set(id, {
              stock: (data?.totalStockBase as number) ?? 0,
              overrideTierPrices: (data?.overrideTierPrices as Record<string, number>) ?? undefined,
            });
            publish();
          },
          (err) => {
            setError(err instanceof Error ? err : new Error(String(err)));
          },
        );

        perProductStockUnsubs.set(id, unsub);
      }
    };

    const attachStockListener = () => {
      if (usePerProductStock) {
        syncPerProductStockListeners(rawProducts.map((p) => p.id));
        return;
      }

      const stockQ = query(
        collectionGroup(db!, collections.productStocks),
        where('branchId', '==', branchId),
      );

      stockGroupUnsub = onSnapshot(
        stockQ,
        (snap) => {
          for (const d of snap.docs) {
            const productId = d.ref.parent.parent?.id;
            if (!productId) continue;
            const data = d.data();
            stockByProduct.set(productId, {
              stock: (data?.totalStockBase as number) ?? 0,
              overrideTierPrices: (data?.overrideTierPrices as Record<string, number>) ?? undefined,
            });
          }
          publish();
        },
        (err) => {
          if (isIndexError(err)) {
            console.warn(
              '[usePosProducts] productStocks collectionGroup unavailable — using per-product listeners',
            );
            usePerProductStock = true;
            stockGroupUnsub?.();
            stockGroupUnsub = null;
            syncPerProductStockListeners(rawProducts.map((p) => p.id));
            return;
          }
          setError(err instanceof Error ? err : new Error(String(err)));
        },
      );
    };

    const productQ = query(
      collection(db, collections.products),
      where('isActive', '==', true),
    );

    const unsubProducts = onSnapshot(
      productQ,
      (snap) => {
        try {
          rawProducts = snap.docs
            .map((d) => ({ ...(d.data() as Product), id: d.id }))
            .filter((p) => !p.deletedAt);

          if (usePerProductStock) {
            syncPerProductStockListeners(rawProducts.map((p) => p.id));
          }

          publish();
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
          if (import.meta.env.DEV) setProducts(DEV_POS_PRODUCTS);
        }
      },
      (err) => {
        setError(err);
        if (import.meta.env.DEV) setProducts(DEV_POS_PRODUCTS);
        setLoading(false);
      },
    );

    attachStockListener();

    return () => {
      unsubProducts();
      stockGroupUnsub?.();
      clearPerProductStockListeners();
    };
  }, [branchId]);

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category));
    return ['', ...set];
  }, [products]);

  return { products, categories, loading, error };
}
