import { collection, deleteDoc, doc, onSnapshot, orderBy, query, setDoc } from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { CategoryBranchSetting, ProductCategory } from '../types';

export const DEFAULT_PRODUCT_CATEGORIES: ProductCategory[] = [
  { id: 'general', name: 'ทั่วไป' },
];

const DEV_STORAGE_KEY = 'twinpet-product-categories';

function readDevCategories(): ProductCategory[] {
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    if (!raw) return DEFAULT_PRODUCT_CATEGORIES.map((c) => ({ ...c }));
    const parsed = JSON.parse(raw) as ProductCategory[];
    return parsed.length > 0 ? parsed : DEFAULT_PRODUCT_CATEGORIES.map((c) => ({ ...c }));
  } catch {
    return DEFAULT_PRODUCT_CATEGORIES.map((c) => ({ ...c }));
  }
}

function writeDevCategories(categories: ProductCategory[]): void {
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(categories));
}

function sanitizeCategories(categories: ProductCategory[]): ProductCategory[] {
  const seen = new Set<string>();
  const cleaned: ProductCategory[] = [];
  for (const cat of categories) {
    const id = cat.id.trim();
    const name = cat.name.trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    // Preserve the branch-scoped POS settings map when present.
    const entry: ProductCategory = { id, name };
    if (cat.branchSettings && Object.keys(cat.branchSettings).length > 0) {
      entry.branchSettings = cat.branchSettings;
    }
    cleaned.push(entry);
  }
  return cleaned.length > 0 ? cleaned : DEFAULT_PRODUCT_CATEGORIES.map((c) => ({ ...c }));
}

function mapCategoryDocs(
  docs: Array<{ id: string; data: () => Record<string, unknown> }>,
): ProductCategory[] {
  const mapped = docs.map((d) => {
    const data = d.data();
    const id = String(data.id ?? d.id).trim();
    const name = String(data.name ?? id).trim();
    const entry: ProductCategory = { id, name };
    if (data.branchSettings && typeof data.branchSettings === 'object') {
      entry.branchSettings = data.branchSettings as ProductCategory['branchSettings'];
    }
    return entry;
  });
  return sanitizeCategories(mapped);
}

export function slugFromCategoryName(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (ascii) return ascii;
  return `cat_${Date.now().toString(36)}`;
}

/** Resolve stored product.category (id or legacy name) to display name. */
export function resolveCategoryName(value: string, categories: ProductCategory[]): string {
  const match = categories.find((c) => c.id === value || c.name === value);
  return match?.name ?? value;
}

/** Match product.category against centralized category filter (by id). */
export function matchesCategoryFilter(
  productCategory: string,
  filterCategoryId: string,
  categories: ProductCategory[],
): boolean {
  if (!filterCategoryId) return true;
  const cat = categories.find((c) => c.id === filterCategoryId);
  if (cat) return productCategory === cat.id || productCategory === cat.name;
  return productCategory === filterCategoryId;
}

export async function addProductCategory(category: ProductCategory): Promise<void> {
  const id = category.id.trim();
  const name = category.name.trim();
  if (!id || !name) throw new Error('กรุณาระบุชื่อหมวดหมู่');

  if (!isFirebaseConfigured || !db) {
    const current = readDevCategories();
    if (current.some((c) => c.id === id)) throw new Error('มีหมวดหมู่นี้อยู่แล้ว');
    writeDevCategories(sanitizeCategories([...current, { id, name }]));
    return;
  }

  await setDoc(doc(db, collections.categories, id), { id, name });
}

/**
 * Persists a category's POS presentation for ONE branch only. Merge-writes under
 * `branchSettings[branchId]` so other branches' settings are never touched.
 */
export async function saveCategoryBranchSetting(
  categoryId: string,
  branchId: string,
  patch: Partial<CategoryBranchSetting>,
): Promise<void> {
  const id = categoryId.trim();
  if (!id || !branchId) throw new Error('ต้องระบุหมวดหมู่และสาขา');

  // Drop undefined values — Firestore rejects them and merge should keep priors.
  const cleanPatch: Partial<CategoryBranchSetting> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (cleanPatch as Record<string, unknown>)[key] = value;
    }
  }

  if (!isFirebaseConfigured || !db) {
    const current = readDevCategories();
    const next = current.map((c) => {
      if (c.id !== id) return c;
      const prev = c.branchSettings?.[branchId];
      const merged: CategoryBranchSetting = {
        displayOrder: cleanPatch.displayOrder ?? prev?.displayOrder ?? 0,
        isVisibleInPos: cleanPatch.isVisibleInPos ?? prev?.isVisibleInPos ?? true,
        ...(prev ?? {}),
        ...cleanPatch,
      };
      return { ...c, branchSettings: { ...c.branchSettings, [branchId]: merged } };
    });
    writeDevCategories(sanitizeCategories(next));
    return;
  }

  await setDoc(
    doc(db, collections.categories, id),
    { id, branchSettings: { [branchId]: cleanPatch } },
    { merge: true },
  );
}

export async function deleteProductCategory(id: string): Promise<void> {
  const catId = id.trim();
  if (!catId) return;
  if (catId === 'general') throw new Error('ไม่สามารถลบหมวดหมู่ทั่วไปได้');

  if (!isFirebaseConfigured || !db) {
    const current = readDevCategories();
    writeDevCategories(sanitizeCategories(current.filter((c) => c.id !== catId)));
    await cascadeCleanupAfterCategoryDelete(catId);
    return;
  }

  await deleteDoc(doc(db, collections.categories, catId));
  await cascadeCleanupAfterCategoryDelete(catId);
}

/**
 * Strips the deleted category's orphan rank keys from all products. Best-effort:
 * the category is already gone even if cleanup throws, so we never block the delete.
 */
async function cascadeCleanupAfterCategoryDelete(categoryId: string): Promise<void> {
  try {
    const { cascadeDeleteCategory } = await import('../admin/sortingStore');
    await cascadeDeleteCategory(categoryId);
  } catch (err) {
    console.warn('[categoryService] cascadeDeleteCategory failed:', err);
  }
}

export function useCategories() {
  const [categories, setCategories] = useState<ProductCategory[]>(DEFAULT_PRODUCT_CATEGORIES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      setCategories(readDevCategories());
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const q = query(collection(db, collections.categories), orderBy('name', 'asc'));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const mapped = mapCategoryDocs(snap.docs);
        setCategories(
          mapped.length > 0 ? mapped : DEFAULT_PRODUCT_CATEGORIES.map((c) => ({ ...c })),
        );
        setLoading(false);
      },
      (err) => {
        setError(err);
        setCategories(DEFAULT_PRODUCT_CATEGORIES.map((c) => ({ ...c })));
        setLoading(false);
      },
    );

    return () => unsub();
  }, []);

  const addCategory = useCallback(async (name: string, idInput?: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('กรุณาระบุชื่อหมวดหมู่');
    const id = (idInput?.trim() || slugFromCategoryName(trimmedName)).toLowerCase();
    setSaving(true);
    setError(null);
    try {
      await addProductCategory({ id, name: trimmedName });
      if (!isFirebaseConfigured) setCategories(readDevCategories());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  const removeCategory = useCallback(async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      await deleteProductCategory(id);
      if (!isFirebaseConfigured) setCategories(readDevCategories());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  return { categories, loading, saving, error, addCategory, removeCategory };
}
