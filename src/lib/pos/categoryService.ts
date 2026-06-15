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
  /**
   * UI-10 best-seller MEMBERSHIP (global product flag), threaded down so the
   * sorting modal's `best-sellers` group can scope to flagged products only.
   * Distinct from `sorting['best-sellers']`, which is per-branch ORDERING.
   */
  isBestSeller?: boolean;
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

/** Thai-dictionary order by `name`. Pure — never mutates input. */
export function sortByThaiName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => thaiCollator.compare(a.name, b.name));
}

/**
 * Self-healing, branch-scoped product ordering. Takes the saved `order` (the
 * array of product ids from the sharded sorting doc) and returns a NEW array:
 *   • products whose id appears in `order` come first, in array order;
 *   • products NOT in `order` (new / never-ranked) are appended in Thai-name order;
 *   • ids in `order` with no live product ("ghosts") are dropped on read;
 *   • a missing / empty `order` degrades to pure Thai-name order (never blank).
 *
 * The live `products` set is authoritative — `order` only ranks it. This is what
 * lets a single reference array stay correct as products are created/deleted
 * without any per-document index rewrites. Never mutates the input array.
 */
export function sortProductsByCustomOrder<T extends SortableProduct>(
  products: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order || order.length === 0) return sortByThaiName(products);

  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index); // first occurrence wins (dedupe)
  });

  const ranked: T[] = [];
  const unranked: T[] = [];
  for (const p of products) {
    if (rank.has(p.id)) ranked.push(p);
    else unranked.push(p);
  }
  ranked.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  // Ghost ids (in `order` but no live product) never enter `ranked`, so they
  // are dropped automatically. Unranked products self-append alphabetically.
  return [...ranked, ...sortByThaiName(unranked)];
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
