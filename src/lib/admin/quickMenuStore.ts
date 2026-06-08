import {
  doc,
  getDoc,
  getDocFromCache,
  onSnapshot,
  runTransaction,
  type DocumentReference,
} from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { db, isFirebaseConfigured } from '../firebase';

/**
 * Quick Menus (Virtual Categories) — admin-curated, branch-scoped shortcut tabs
 * that surface a hand-picked, explicitly-ordered set of products at the front of
 * the POS category bar, independent of each product's physical category.
 *
 * Storage: a single document per branch at
 *   `pos_configs/branches/{branchId}/quick_menus`  →  { menus: QuickMenu[] }
 * One small doc (a few menus × a few dozen ids) — comfortably under 1 MiB — so a
 * whole-array read-modify-write inside a transaction is the simplest safe model.
 * The POS reads it statically via the inventory repository (Light Path); the
 * admin page subscribes live via {@link useQuickMenus}.
 */

export type QuickMenu = {
  id: string;
  name: string;
  icon?: string;
  productIds: string[];
  isActive: boolean;
  order: number;
};

export type QuickMenuDoc = {
  menus: QuickMenu[];
};

function isOfflineLikeFirestoreError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    const msg = err.message || '';
    if (code === 'unavailable') return true;
    if (msg.includes('ERR_INTERNET_DISCONNECTED')) return true;
    if (msg.includes('WebChannelConnection')) return true;
    if (msg.includes('transport errored')) return true;
    if (msg.includes('offline')) return true;
  }
  return false;
}

export function quickMenusDocRef(branchId: string): DocumentReference {
  // pos_configs (col) / branches (doc) / {branchId} (col) / quick_menus (doc)
  return doc(db!, 'pos_configs', 'branches', branchId, 'quick_menus');
}

// ── Dev (no-Firebase) fallback ───────────────────────────────────────────────
const DEV_KEY = 'twinpet-quick-menus';
type DevStore = Record<string, QuickMenu[]>;

function readDev(): DevStore {
  try {
    const raw = localStorage.getItem(DEV_KEY);
    return raw ? (JSON.parse(raw) as DevStore) : {};
  } catch {
    return {};
  }
}

function writeDev(store: DevStore): void {
  localStorage.setItem(DEV_KEY, JSON.stringify(store));
}

function genId(): string {
  return `qm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function sortByOrder(menus: QuickMenu[]): QuickMenu[] {
  return [...menus].sort((a, b) => a.order - b.order);
}

/** Parse + normalize the stored array into well-formed, order-sorted menus. */
function parseMenus(data: unknown): QuickMenu[] {
  const raw = (data as { menus?: unknown })?.menus;
  if (!Array.isArray(raw)) return [];
  const menus: QuickMenu[] = [];
  raw.forEach((m, i) => {
    if (!m || typeof (m as QuickMenu).id !== 'string') return;
    const entry = m as Partial<QuickMenu>;
    menus.push({
      id: entry.id as string,
      name: typeof entry.name === 'string' ? entry.name : 'เมนูด่วน',
      icon: typeof entry.icon === 'string' && entry.icon ? entry.icon : undefined,
      productIds: Array.isArray(entry.productIds)
        ? entry.productIds.filter((x): x is string => typeof x === 'string')
        : [],
      isActive: entry.isActive !== false,
      order: typeof entry.order === 'number' ? entry.order : i,
    });
  });
  return sortByOrder(menus);
}

/** Strip `undefined` (Firestore rejects it) before persisting. */
function toFirestore(menus: QuickMenu[]): Record<string, unknown>[] {
  return menus.map((m) => {
    const out: Record<string, unknown> = {
      id: m.id,
      name: m.name,
      productIds: m.productIds,
      isActive: m.isActive,
      order: m.order,
    };
    if (typeof m.icon === 'string' && m.icon) out.icon = m.icon;
    return out;
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** One-shot read of a branch's quick menus (order-sorted). Used by the POS repo. */
export async function getQuickMenus(branchId: string): Promise<QuickMenu[]> {
  if (!isFirebaseConfigured || !db) {
    return sortByOrder(readDev()[branchId] ?? []);
  }
  let snap;
  try {
    snap = await getDoc(quickMenusDocRef(branchId));
  } catch (err) {
    if (isOfflineLikeFirestoreError(err)) {
      console.warn('[quickMenuStore] offline/transport error, trying cache', err);
      snap = await getDocFromCache(quickMenusDocRef(branchId));
    } else {
      throw err;
    }
  }
  return snap.exists() ? parseMenus(snap.data()) : [];
}

// ── Mutations (whole-array read-modify-write, transactional) ───────────────────

async function mutate(branchId: string, fn: (menus: QuickMenu[]) => QuickMenu[]): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDev();
    store[branchId] = fn(sortByOrder(store[branchId] ?? []));
    writeDev(store);
    return;
  }
  const ref = quickMenusDocRef(branchId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? parseMenus(snap.data()) : [];
    const next = fn(current);
    tx.set(ref, { menus: toFirestore(next) });
  });
}

export async function createQuickMenu(
  branchId: string,
  input: { name: string; icon?: string; productIds?: string[]; isActive?: boolean },
): Promise<string> {
  const id = genId();
  await mutate(branchId, (menus) => [
    ...menus,
    {
      id,
      name: input.name.trim() || 'เมนูด่วน',
      icon: input.icon,
      productIds: input.productIds ?? [],
      isActive: input.isActive ?? true,
      order: menus.length,
    },
  ]);
  return id;
}

export async function updateQuickMenu(
  branchId: string,
  id: string,
  patch: Partial<Omit<QuickMenu, 'id'>>,
): Promise<void> {
  await mutate(branchId, (menus) => menus.map((m) => (m.id === id ? { ...m, ...patch } : m)));
}

export async function deleteQuickMenu(branchId: string, id: string): Promise<void> {
  await mutate(branchId, (menus) =>
    menus.filter((m) => m.id !== id).map((m, i) => ({ ...m, order: i })),
  );
}

/** Reorder the menus themselves (compacts `order` to 0,1,2,…). */
export async function reorderQuickMenus(branchId: string, orderedIds: string[]): Promise<void> {
  await mutate(branchId, (menus) => {
    const byId = new Map(menus.map((m) => [m.id, m]));
    const next: QuickMenu[] = [];
    orderedIds.forEach((id) => {
      const m = byId.get(id);
      if (m) {
        next.push({ ...m, order: next.length });
        byId.delete(id);
      }
    });
    // Preserve any menus not present in `orderedIds` (defensive) at the end.
    for (const m of byId.values()) next.push({ ...m, order: next.length });
    return next;
  });
}

// ── Live hook (admin page) ─────────────────────────────────────────────────────

/**
 * Live branch quick menus for the admin editor. In dev (no Firebase) there is no
 * snapshot stream, so callers use `refresh()` after a mutation to re-read.
 */
export function useQuickMenus(branchId: string | null): {
  menus: QuickMenu[];
  loading: boolean;
  refresh: () => void;
} {
  const [menus, setMenus] = useState<QuickMenu[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!branchId) {
      setMenus([]);
      setLoading(false);
      return;
    }
    if (!isFirebaseConfigured || !db) {
      setMenus(sortByOrder(readDev()[branchId] ?? []));
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = onSnapshot(
      quickMenusDocRef(branchId),
      (snap) => {
        setMenus(snap.exists() ? parseMenus(snap.data()) : []);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [branchId, tick]);

  return { menus, loading, refresh };
}
