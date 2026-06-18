import { useSyncExternalStore } from 'react';

/**
 * POS display preferences (Phase 7C-UI-01 foundation; UI-04 wiring fix).
 *
 * A localStorage-backed store for cashier-facing layout preferences. The Settings
 * page → "การแสดงผลสินค้า (POS)" section EDITS them via the exported setters; the
 * POS screen CONSUMES them (grid density, text scale, stock visibility, and the
 * independent product-name / price text scales).
 *
 * Single source of truth (UI-04): the preferences live in ONE module-level store
 * that every `usePOSPreferences()` consumer subscribes to via `useSyncExternalStore`.
 * Previously each call held its own `useState` copy, so the Settings editor and the
 * POS grid mounted INDEPENDENT states — an edit persisted to localStorage but never
 * notified the already-mounted POS instance, so the product cards never re-rendered
 * (the UI-04 UAT failure). With the shared store an edit updates the one value and
 * re-renders every consumer immediately; a `storage` event keeps other tabs in sync.
 *
 * Safety: every storage access is wrapped (private-mode / quota / SSR safe),
 * parsed values are validated against the allowed unions, and any invalid or
 * corrupt stored value silently falls back to the defaults. State stays purely
 * in-memory when storage is unavailable.
 */
export type POSGridColumns = 4 | 5 | 6;
export type POSFontSize = 'small' | 'normal' | 'large';

export type POSPreferences = {
  gridColumns: POSGridColumns;
  fontSize: POSFontSize;
  /** UI-04: whether product cards show the stock-count indicator. */
  showStock: boolean;
  /** UI-04: product-name text scale on product cards (independent of `priceFontSize`). */
  productNameFontSize: POSFontSize;
  /** UI-04: price text scale on product cards (independent of `productNameFontSize`). */
  priceFontSize: POSFontSize;
  setGridColumns: (value: POSGridColumns) => void;
  setFontSize: (value: POSFontSize) => void;
  setShowStock: (value: boolean) => void;
  setProductNameFontSize: (value: POSFontSize) => void;
  setPriceFontSize: (value: POSFontSize) => void;
};

const STORAGE_KEY = 'twinpet_pos_prefs';
const DEFAULT_GRID_COLUMNS: POSGridColumns = 5;
const DEFAULT_FONT_SIZE: POSFontSize = 'normal';
// UI-04 defaults preserve the exact current product-card presentation: stock
// visible, and both text scales at 'normal' (×1, no change to existing sizing).
const DEFAULT_SHOW_STOCK = true;
const DEFAULT_PRODUCT_NAME_FONT_SIZE: POSFontSize = 'normal';
const DEFAULT_PRICE_FONT_SIZE: POSFontSize = 'normal';

const VALID_GRID_COLUMNS: readonly POSGridColumns[] = [4, 5, 6];
const VALID_FONT_SIZES: readonly POSFontSize[] = ['small', 'normal', 'large'];

function isGridColumns(value: unknown): value is POSGridColumns {
  return typeof value === 'number' && VALID_GRID_COLUMNS.includes(value as POSGridColumns);
}

function isFontSize(value: unknown): value is POSFontSize {
  return typeof value === 'string' && VALID_FONT_SIZES.includes(value as POSFontSize);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Resolve localStorage defensively — returns null in SSR / private-mode / blocked contexts. */
function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Read + validate the stored preferences, recovering to defaults on any failure. */
type StoredPreferences = {
  gridColumns: POSGridColumns;
  fontSize: POSFontSize;
  showStock: boolean;
  productNameFontSize: POSFontSize;
  priceFontSize: POSFontSize;
};

function readStoredPreferences(): StoredPreferences {
  const fallback: StoredPreferences = {
    gridColumns: DEFAULT_GRID_COLUMNS,
    fontSize: DEFAULT_FONT_SIZE,
    showStock: DEFAULT_SHOW_STOCK,
    productNameFontSize: DEFAULT_PRODUCT_NAME_FONT_SIZE,
    priceFontSize: DEFAULT_PRICE_FONT_SIZE,
  };
  const storage = safeStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const obj = parsed as Record<string, unknown>;
    return {
      gridColumns: isGridColumns(obj.gridColumns) ? obj.gridColumns : DEFAULT_GRID_COLUMNS,
      fontSize: isFontSize(obj.fontSize) ? obj.fontSize : DEFAULT_FONT_SIZE,
      showStock: isBoolean(obj.showStock) ? obj.showStock : DEFAULT_SHOW_STOCK,
      productNameFontSize: isFontSize(obj.productNameFontSize)
        ? obj.productNameFontSize
        : DEFAULT_PRODUCT_NAME_FONT_SIZE,
      priceFontSize: isFontSize(obj.priceFontSize) ? obj.priceFontSize : DEFAULT_PRICE_FONT_SIZE,
    };
  } catch {
    return fallback;
  }
}

// ── Shared reactive store (UI-04 single source of truth) ─────────────────────
// One module-level value + a listener set. Every usePOSPreferences() consumer
// subscribes to it, so an edit on the Settings page re-renders the POS product
// cards immediately — the wiring the per-instance useState version was missing.

// Lazily initialised from storage at module load (defaults under SSR / node, where
// safeStorage() returns null). The reference only changes on a real update, so
// `getSnapshot` stays cached as useSyncExternalStore requires.
let currentState: StoredPreferences = readStoredPreferences();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function persist(state: StoredPreferences): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full / unavailable — keep the in-memory state authoritative */
  }
}

/** Apply a validated patch: persist + notify, skipping a no-op so consumers don't churn. */
function setState(patch: Partial<StoredPreferences>): void {
  const next: StoredPreferences = { ...currentState, ...patch };
  if (
    next.gridColumns === currentState.gridColumns &&
    next.fontSize === currentState.fontSize &&
    next.showStock === currentState.showStock &&
    next.productNameFontSize === currentState.productNameFontSize &&
    next.priceFontSize === currentState.priceFontSize
  ) {
    return;
  }
  currentState = next;
  persist(currentState);
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoredPreferences {
  return currentState;
}

// Deterministic server/SSR snapshot — the defaults, matching the pre-hydration
// client render so useSyncExternalStore never warns about a snapshot mismatch.
const SERVER_SNAPSHOT: StoredPreferences = {
  gridColumns: DEFAULT_GRID_COLUMNS,
  fontSize: DEFAULT_FONT_SIZE,
  showStock: DEFAULT_SHOW_STOCK,
  productNameFontSize: DEFAULT_PRODUCT_NAME_FONT_SIZE,
  priceFontSize: DEFAULT_PRICE_FONT_SIZE,
};

function getServerSnapshot(): StoredPreferences {
  return SERVER_SNAPSHOT;
}

// Cross-tab sync: another tab editing the same key re-hydrates this tab's store.
// (The `storage` event fires only in OTHER tabs, never the writer, so no loop.)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    currentState = readStoredPreferences();
    emitChange();
  });
}

// Stable setters (module-level → referentially constant across renders). Each
// validates its input so a bad caller can never poison the shared store.
function setGridColumns(value: POSGridColumns): void {
  if (isGridColumns(value)) setState({ gridColumns: value });
}
function setFontSize(value: POSFontSize): void {
  if (isFontSize(value)) setState({ fontSize: value });
}
function setShowStock(value: boolean): void {
  if (isBoolean(value)) setState({ showStock: value });
}
function setProductNameFontSize(value: POSFontSize): void {
  if (isFontSize(value)) setState({ productNameFontSize: value });
}
function setPriceFontSize(value: POSFontSize): void {
  if (isFontSize(value)) setState({ priceFontSize: value });
}

/**
 * Internal shared store powering {@link usePOSPreferences}. Exported for the UI-04
 * contract tests (vitest runs in a node env with no DOM/React, so the reactive
 * single-source-of-truth behaviour is asserted here directly). App code must use
 * the hook so it subscribes and re-renders — do not read this store directly.
 */
export const posPreferencesStore = {
  subscribe,
  getSnapshot,
  setGridColumns,
  setFontSize,
  setShowStock,
  setProductNameFontSize,
  setPriceFontSize,
};

export function usePOSPreferences(): POSPreferences {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    gridColumns: state.gridColumns,
    fontSize: state.fontSize,
    showStock: state.showStock,
    productNameFontSize: state.productNameFontSize,
    priceFontSize: state.priceFontSize,
    setGridColumns,
    setFontSize,
    setShowStock,
    setProductNameFontSize,
    setPriceFontSize,
  };
}
