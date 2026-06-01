import type { ProductBranchSetting, ProductCategory } from '../types';

/**
 * Pure, framework-agnostic, BRANCH-SCOPED sorting / visibility / ordering
 * utilities for the multi-branch Category & Product ranking system. No React,
 * no Firestore — safe to reuse across projects and trivially unit-testable.
 *
 * Safety guarantees enforced here:
 *  - Immutability: every function clones before `.sort()` (never mutates input).
 *  - Thai-correct ordering via `Intl.Collator('th')` so vowels (เ แ โ ใ) don't
 *    sort before consonants (ก-ฮ) the way raw Unicode comparison would.
 *  - Branch isolation: order/visibility are read from `branchSettings[branchId]`,
 *    so one branch's configuration never affects another.
 */

/** Sentinel category key for the virtual "best sellers" product ranking. */
export const BEST_SELLERS_KEY = 'best-sellers';

/** Shared Thai-aware collator — `base` sensitivity ignores case/diacritic noise. */
const thaiCollator = new Intl.Collator('th', { sensitivity: 'base' });

/** Minimal product shape required to rank products by branch-scoped custom order. */
export interface SortableProduct {
  id: string;
  name: string;
  category: string;
  branchSettings?: Record<string, ProductBranchSetting>;
}

/** True when a category is visible on the given branch's POS screen (default: visible). */
export function isCategoryVisible(category: ProductCategory, branchId: string): boolean {
  return category.branchSettings?.[branchId]?.isVisibleInPos !== false;
}

/** True when a product is visible on the given branch's POS grids (default: visible). */
export function isProductVisible(product: SortableProduct, branchId: string): boolean {
  return product.branchSettings?.[branchId]?.isVisibleInPos !== false;
}

/** Returns only the categories visible for `branchId`. Pure — does not mutate input. */
export function getVisibleCategories(
  categories: readonly ProductCategory[],
  branchId: string,
): ProductCategory[] {
  return categories.filter((c) => isCategoryVisible(c, branchId));
}

/**
 * Returns a NEW array ordered by this branch's `displayOrder` (ascending),
 * breaking ties with Thai dictionary order on `name`. Unconfigured categories
 * (no setting for this branch) sink to the end.
 */
export function sortCategories(
  categories: readonly ProductCategory[],
  branchId: string,
): ProductCategory[] {
  return [...categories].sort((a, b) => {
    const ao = a.branchSettings?.[branchId]?.displayOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.branchSettings?.[branchId]?.displayOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return thaiCollator.compare(a.name, b.name);
  });
}

/**
 * Returns a NEW array of products ordered by this branch's custom rank for
 * `categoryKey` (`branchSettings[branchId].sortOrders[categoryKey]`), then Thai
 * name. Never mutates the input array.
 */
export function sortProductsByCustomOrder<T extends SortableProduct>(
  products: readonly T[],
  categoryKey: string,
  branchId: string,
): T[] {
  const rankOf = (p: T): number => {
    const custom = p.branchSettings?.[branchId]?.sortOrders?.[categoryKey];
    return typeof custom === 'number' ? custom : Number.MAX_SAFE_INTEGER;
  };
  return [...products].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    return thaiCollator.compare(a.name, b.name);
  });
}

/**
 * Builds a fresh `{ id: order }` map ranking items by Thai dictionary order
 * (ก-ฮ). Branch-agnostic by design — the caller persists the result under the
 * relevant `branchSettings[branchId]` path. Never mutates input.
 */
export function generateAlphabeticalOrder<T extends { id: string; name: string }>(
  items: readonly T[],
): Record<string, number> {
  const sorted = [...items].sort((a, b) => thaiCollator.compare(a.name, b.name));
  const order: Record<string, number> = {};
  sorted.forEach((item, index) => {
    order[item.id] = index;
  });
  return order;
}

/**
 * Returns a NEW `branchSettings` map with `categoryKey` removed from every
 * branch's `sortOrders` (used when a category is deleted globally). Never mutates.
 */
export function stripCategoryFromBranchSettings(
  branchSettings: Record<string, ProductBranchSetting> | undefined,
  categoryKey: string,
): Record<string, ProductBranchSetting> | undefined {
  if (!branchSettings) return branchSettings;
  let changed = false;
  const next: Record<string, ProductBranchSetting> = {};
  for (const [branchId, setting] of Object.entries(branchSettings)) {
    if (setting.sortOrders && categoryKey in setting.sortOrders) {
      changed = true;
      const nextOrders: Record<string, number> = {};
      for (const [key, value] of Object.entries(setting.sortOrders)) {
        if (key !== categoryKey) nextOrders[key] = value;
      }
      next[branchId] = { ...setting, sortOrders: nextOrders };
    } else {
      next[branchId] = setting;
    }
  }
  return changed ? next : branchSettings;
}

/**
 * Ghost-active-category fallback. If `activeCategory` is no longer among the
 * (already branch-filtered) visible categories, returns `defaultValue` (default
 * '' = "all") so the POS never shows a blank grid. Matches by id or name.
 */
export function resolveActiveCategory(
  activeCategory: string,
  visibleCategories: readonly ProductCategory[],
  defaultValue = '',
): string {
  if (!activeCategory) return activeCategory;
  const stillVisible = visibleCategories.some(
    (c) => c.id === activeCategory || c.name === activeCategory,
  );
  return stillVisible ? activeCategory : defaultValue;
}
