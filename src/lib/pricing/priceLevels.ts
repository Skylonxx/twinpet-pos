/**
 * Unified price-level system (Option α). A single Firestore collection
 * (`priceLevels`) is the source of truth for every pricing tier — both
 * **Global** levels (`isGlobal: true`, `branchId: null`) and **Branch** levels
 * (`isGlobal: false`, `branchId: '<branch>'`). It replaces the legacy
 * `customerTiers` collection and the scattered hardcoded tier arrays.
 *
 * Consumers (POS, product form, customer form) read a *merged* view for the
 * active branch: global levels plus any levels scoped to that branch. The UI is
 * never blocked while loading — `DEFAULT_PRICE_LEVELS` is served as a fallback
 * so dropdowns stay interactive and the pricing engine degrades to base price
 * for unknown tiers.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { ensureFirebaseAuth } from '../firebaseAuth';
import { DEFAULT_CUSTOMER_TIER, RETAIL_PRICE_LEVEL_ID, type PriceLevel } from '../types';

export { RETAIL_PRICE_LEVEL_ID } from '../types';

/** Built-in global price levels — fallback when the collection is empty / dev mode. */
export const DEFAULT_PRICE_LEVELS: PriceLevel[] = [
  { id: RETAIL_PRICE_LEVEL_ID, name: 'ลูกค้าทั่วไป', code: 'RETAIL', order: 0, isActive: true, isGlobal: true, branchId: null },
  { id: 'wholesale', name: 'ขายส่ง', code: 'WHOLESALE', order: 1, isActive: true, isGlobal: true, branchId: null },
  { id: 'vip', name: 'ลูกค้า VIP', code: 'VIP', order: 2, isActive: true, isGlobal: true, branchId: null },
  { id: 'agent1', name: 'ตัวแทนจำกัด', code: 'AGENT1', order: 3, isActive: true, isGlobal: true, branchId: null },
  { id: 'farm_large', name: 'ฟาร์มขนาดใหญ่', code: 'FARM_LARGE', order: 4, isActive: true, isGlobal: true, branchId: null },
];

const DEV_STORAGE_KEY = 'twinpet-price-levels';

/** Generate a URL-safe price-level id from a display name. */
export function slugFromLevelName(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    // Strip combining diacritical marks (U+0300–U+036F) left by NFD decomposition.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (ascii) return ascii;
  return `level_${Date.now().toString(36)}`;
}

/** Coerce a raw Firestore doc into a fully-formed PriceLevel (back-fills new fields). */
function normalizeLevel(id: string, data: Record<string, unknown>): PriceLevel {
  const branchId = (data.branchId as string | null | undefined) ?? null;
  return {
    id,
    name: String(data.name ?? id),
    code: String(data.code ?? id).toUpperCase(),
    order: typeof data.order === 'number' ? data.order : 0,
    isActive: data.isActive !== false,
    // Legacy docs predate these fields: treat a doc with no branchId as global.
    isGlobal: typeof data.isGlobal === 'boolean' ? data.isGlobal : branchId == null,
    branchId,
    desc: typeof data.desc === 'string' ? data.desc : undefined,
  };
}

/** Sort helper — order asc, then name for stable display. */
function sortLevels(levels: PriceLevel[]): PriceLevel[] {
  return [...levels].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Keep only levels visible at the given branch: global ∪ branch-scoped. */
function visibleForBranch(levels: PriceLevel[], branchId: string | null): PriceLevel[] {
  const filtered = levels.filter((l) => l.branchId == null || l.branchId === branchId);
  // De-dupe by id: a branch-scoped level overrides a global one with the same id.
  const byId = new Map<string, PriceLevel>();
  for (const l of filtered) {
    const existing = byId.get(l.id);
    if (!existing || (l.branchId != null && existing.branchId == null)) byId.set(l.id, l);
  }
  return sortLevels([...byId.values()]);
}

function readDevLevels(): PriceLevel[] {
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    if (!raw) return DEFAULT_PRICE_LEVELS.map((l) => ({ ...l }));
    const parsed = JSON.parse(raw) as PriceLevel[];
    return parsed.length > 0 ? parsed : DEFAULT_PRICE_LEVELS.map((l) => ({ ...l }));
  } catch {
    return DEFAULT_PRICE_LEVELS.map((l) => ({ ...l }));
  }
}

function writeDevLevels(levels: PriceLevel[]): void {
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(levels));
}

/** Display name for a price-level id, falling back to the raw id. */
export function priceLevelLabel(levels: PriceLevel[], id: string | null | undefined): string {
  const key = (id ?? '').trim() || DEFAULT_CUSTOMER_TIER;
  return levels.find((l) => l.id === key)?.name ?? key;
}

/** Active levels only — for selection dropdowns. */
export function activePriceLevels(levels: PriceLevel[]): PriceLevel[] {
  return levels.filter((l) => l.isActive);
}

export async function addPriceLevelDoc(level: PriceLevel): Promise<void> {
  const id = level.id.trim();
  if (!id || !level.name.trim()) throw new Error('กรุณาระบุชื่อระดับราคา');

  if (!isFirebaseConfigured || !db) {
    const current = readDevLevels();
    if (current.some((l) => l.id === id)) throw new Error('มีระดับราคานี้อยู่แล้ว');
    writeDevLevels([...current, level]);
    return;
  }
  await ensureFirebaseAuth();
  await setDoc(doc(db as Firestore, collections.priceLevels, id), level);
}

export async function deletePriceLevelDoc(id: string): Promise<void> {
  const levelId = id.trim();
  if (!levelId) return;
  if (levelId === RETAIL_PRICE_LEVEL_ID) throw new Error('ไม่สามารถลบระดับราคา retail ได้');

  if (!isFirebaseConfigured || !db) {
    writeDevLevels(readDevLevels().filter((l) => l.id !== levelId));
    return;
  }
  await ensureFirebaseAuth();
  await deleteDoc(doc(db as Firestore, collections.priceLevels, levelId));
}

/**
 * Subscribe to the unified price levels visible at `branchId` (global + branch).
 * Returns a non-blocking list (defaults until the snapshot resolves) plus CRUD
 * helpers for the management UI.
 */
export function usePriceLevels(branchId: string | null = null) {
  const [all, setAll] = useState<PriceLevel[]>(DEFAULT_PRICE_LEVELS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      setAll(readDevLevels());
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const unsub = onSnapshot(
      collection(db, collections.priceLevels),
      (snap) => {
        const mapped = snap.docs.map((d) => normalizeLevel(d.id, d.data() as Record<string, unknown>));
        setAll(mapped.length > 0 ? mapped : DEFAULT_PRICE_LEVELS.map((l) => ({ ...l })));
        setLoading(false);
      },
      (err) => {
        setError(err);
        setAll(DEFAULT_PRICE_LEVELS.map((l) => ({ ...l })));
        setLoading(false);
      },
    );

    return () => unsub();
  }, []);

  const priceLevels = visibleForBranch(all, branchId);

  const addLevel = useCallback(
    async (name: string, idInput?: string) => {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('กรุณาระบุชื่อระดับราคา');
      const id = (idInput?.trim() || slugFromLevelName(trimmedName)).toLowerCase();
      const order = all.reduce((max, l) => Math.max(max, l.order), 0) + 1;
      setSaving(true);
      setError(null);
      try {
        await addPriceLevelDoc({
          id,
          name: trimmedName,
          code: id.toUpperCase(),
          order,
          isActive: true,
          isGlobal: true,
          branchId: null,
        });
        if (!isFirebaseConfigured) setAll(readDevLevels());
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [all],
  );

  const removeLevel = useCallback(async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      await deletePriceLevelDoc(id);
      if (!isFirebaseConfigured) setAll(readDevLevels());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  return { priceLevels, loading, saving, error, addLevel, removeLevel };
}

/** One-shot fetch (non-hook contexts) of levels visible at a branch. */
export async function fetchPriceLevels(branchId: string | null = null): Promise<PriceLevel[]> {
  if (!isFirebaseConfigured || !db) return visibleForBranch(readDevLevels(), branchId);
  const snap = await getDocs(collection(db, collections.priceLevels));
  const mapped = snap.docs.map((d) => normalizeLevel(d.id, d.data() as Record<string, unknown>));
  const source = mapped.length > 0 ? mapped : DEFAULT_PRICE_LEVELS.map((l) => ({ ...l }));
  return visibleForBranch(source, branchId);
}
