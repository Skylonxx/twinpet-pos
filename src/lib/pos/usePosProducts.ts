import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product } from '../types';
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

function buildUomOptions(product: Product): UomOption[] {
  const retailPrices = product.prices.filter((p) => p.priceLevelId === 'RETAIL');
  const options: UomOption[] = [];

  const basePrice =
    retailPrices.find((p) => p.unit === product.baseUnit)?.price ??
    retailPrices[0]?.price ??
    0;

  options.push({
    unit: product.baseUnit,
    factor: 1,
    price: basePrice,
  });

  for (const conv of product.uomConversions) {
    const price =
      retailPrices.find((p) => p.unit === conv.unit)?.price ??
      basePrice * conv.factor;
    options.push({ unit: conv.unit, factor: conv.factor, price });
  }

  const unique = new Map<string, UomOption>();
  for (const o of options) unique.set(o.unit, o);
  return [...unique.values()];
}

function toPosProduct(product: Product, stock: number): PosProduct {
  const uomOptions = buildUomOptions(product);
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? null,
    category: product.category,
    emoji: CATEGORY_EMOJI[product.category] ?? '📦',
    stock,
    baseUnit: product.baseUnit,
    allowNegativeStock: product.allowNegativeStock ?? false,
    tierPrices: product.tierPrices,
    uomOptions,
  };
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
    const q = query(
      collection(db, collections.products),
      where('isActive', '==', true),
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        try {
          const raw = snap.docs
            .map((d) => ({ ...(d.data() as Product), id: d.id }))
            .filter((p) => !p.deletedAt);

          const withStock = await Promise.all(
            raw.map(async (product) => {
              const stockRef = doc(
                db!,
                collections.products,
                product.id,
                collections.productStocks,
                branchId,
              );
              const stockSnap = await getDoc(stockRef);
              const stock = stockSnap.exists()
                ? (stockSnap.data()?.totalStockBase as number) ?? 0
                : 0;
              return toPosProduct(product, stock);
            }),
          );

          setProducts(withStock);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
          if (import.meta.env.DEV) setProducts(DEV_POS_PRODUCTS);
        } finally {
          setLoading(false);
        }
      },
      (err) => {
        setError(err);
        if (import.meta.env.DEV) setProducts(DEV_POS_PRODUCTS);
        setLoading(false);
      },
    );

    return unsub;
  }, [branchId]);

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category));
    return ['', ...set];
  }, [products]);

  return { products, categories, loading, error };
}
