import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * POS display preferences (Phase 7C-UI-01 foundation).
 *
 * A localStorage-backed store for cashier-facing layout preferences that the
 * POS screen *consumes* but does not edit — the preference UI will live on a
 * future Settings page, which can call the exported setters. UI-01 only wires
 * the read path (grid density + text scale) plus a safe, validated persistence
 * layer.
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
  setGridColumns: (value: POSGridColumns) => void;
  setFontSize: (value: POSFontSize) => void;
};

const STORAGE_KEY = 'twinpet_pos_prefs';
const DEFAULT_GRID_COLUMNS: POSGridColumns = 5;
const DEFAULT_FONT_SIZE: POSFontSize = 'normal';

const VALID_GRID_COLUMNS: readonly POSGridColumns[] = [4, 5, 6];
const VALID_FONT_SIZES: readonly POSFontSize[] = ['small', 'normal', 'large'];

function isGridColumns(value: unknown): value is POSGridColumns {
  return typeof value === 'number' && VALID_GRID_COLUMNS.includes(value as POSGridColumns);
}

function isFontSize(value: unknown): value is POSFontSize {
  return typeof value === 'string' && VALID_FONT_SIZES.includes(value as POSFontSize);
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
function readStoredPreferences(): { gridColumns: POSGridColumns; fontSize: POSFontSize } {
  const fallback = { gridColumns: DEFAULT_GRID_COLUMNS, fontSize: DEFAULT_FONT_SIZE };
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
    };
  } catch {
    return fallback;
  }
}

export function usePOSPreferences(): POSPreferences {
  const [gridColumns, setGridColumns] = useState<POSGridColumns>(DEFAULT_GRID_COLUMNS);
  const [fontSize, setFontSize] = useState<POSFontSize>(DEFAULT_FONT_SIZE);
  // Guards the persistence effect so the initial default render never clobbers a
  // valid stored value before hydration has run.
  const hydrated = useRef(false);

  // Hydrate once on mount (client only — keeps first render deterministic/SSR-safe).
  useEffect(() => {
    const stored = readStoredPreferences();
    setGridColumns(stored.gridColumns);
    setFontSize(stored.fontSize);
    hydrated.current = true;
  }, []);

  // Persist on change, but only after hydration. Never throws on quota/unavailable.
  useEffect(() => {
    if (!hydrated.current) return;
    const storage = safeStorage();
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ gridColumns, fontSize }));
    } catch {
      /* storage full / unavailable — keep the in-memory state authoritative */
    }
  }, [gridColumns, fontSize]);

  // Setters validate their input so a bad caller can never poison the state/store.
  const setGridColumnsSafe = useCallback((value: POSGridColumns) => {
    if (isGridColumns(value)) setGridColumns(value);
  }, []);

  const setFontSizeSafe = useCallback((value: POSFontSize) => {
    if (isFontSize(value)) setFontSize(value);
  }, []);

  return {
    gridColumns,
    fontSize,
    setGridColumns: setGridColumnsSafe,
    setFontSize: setFontSizeSafe,
  };
}
