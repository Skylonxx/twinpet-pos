import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { UomUnit } from '../types';
import { getDevUomUnits, saveDevUomUnits } from './devMock';

export const DEFAULT_UNIT_NAMES = [
  'ชิ้น',
  'กิโลกรัม',
  'แพ็ค',
  'กล่อง',
  'โหล',
  'ลัง',
  'ถุง',
  'ขวด',
];

function slugCode(name: string): string {
  const ascii = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 6);
  return ascii || 'UNIT';
}

/** Normalize Firestore/dev records — strips legacy global factor fields */
export function normalizeMasterUnit(data: Record<string, unknown>, id: string): UomUnit {
  const name = String(data.name ?? id).trim();
  return {
    id,
    name,
    code: String(data.code ?? slugCode(name)).trim() || slugCode(name),
    isActive: data.isActive !== false,
  };
}

/** Master unit list + legacy current value (if not in master list) for select dropdowns */
export function buildUnitSelectOptions(masterUnits: string[], current?: string): string[] {
  const cleaned = masterUnits.map((u) => u.trim()).filter(Boolean);
  const cur = current?.trim();
  if (cur && !cleaned.includes(cur)) {
    return [cur, ...cleaned];
  }
  return cleaned;
}

/** Sub-unit picker: global names minus base unit and units already used on this product */
export function buildSubUnitSelectOptions(
  masterUnits: string[],
  baseUnit: string,
  usedUnits: string[],
  current?: string,
): string[] {
  const base = baseUnit.trim();
  const currentUnit = current?.trim();
  const blocked = new Set(
    usedUnits
      .map((u) => u.trim())
      .filter((u) => u && u !== currentUnit),
  );
  blocked.add(base);

  const pool = masterUnits.filter((u) => {
    const name = u.trim();
    if (!name) return false;
    if (name === currentUnit) return true;
    return !blocked.has(name);
  });

  return buildUnitSelectOptions(pool, current);
}

export function createUomUnit(name: string, overrides?: Partial<UomUnit>): UomUnit {
  const trimmed = name.trim();
  const id = overrides?.id ?? `uom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    name: trimmed,
    code: overrides?.code ?? slugCode(trimmed),
    isActive: overrides?.isActive ?? true,
  };
}

function defaultSeedUnits(): UomUnit[] {
  return DEFAULT_UNIT_NAMES.map((name, i) =>
    createUomUnit(name, { id: `uom-seed-${i}`, code: slugCode(name) }),
  );
}

function syncNamesToUnits(existing: UomUnit[], names: string[]): UomUnit[] {
  const byName = new Map(existing.map((u) => [u.name, u]));
  const next: UomUnit[] = [];

  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const prev = byName.get(name);
    next.push(prev ?? createUomUnit(name));
  }

  return next.length > 0 ? next : defaultSeedUnits();
}

export function useUomUnits() {
  const [units, setUnits] = useState<UomUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const snapshotRef = useRef<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!isFirebaseConfigured || !db) {
        const dev = getDevUomUnits().map((u) => normalizeMasterUnit(u as unknown as Record<string, unknown>, u.id));
        const next = dev.length > 0 ? dev : defaultSeedUnits();
        setUnits(next);
        snapshotRef.current = JSON.stringify(next);
        return;
      }

      const snap = await getDocs(query(collection(db, collections.uomUnits), orderBy('name', 'asc')));
      const loaded = snap.docs.map((d) => normalizeMasterUnit(d.data() as Record<string, unknown>, d.id));
      const next = loaded.length > 0 ? loaded : defaultSeedUnits();
      setUnits(next);
      snapshotRef.current = JSON.stringify(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unitNames = useMemo(
    () => units.filter((u) => u.isActive).map((u) => u.name),
    [units],
  );

  const persistUnits = useCallback(async (next: UomUnit[]) => {
    setSaving(true);
    try {
      const cleaned = next.map((u) => normalizeMasterUnit(u as unknown as Record<string, unknown>, u.id));

      if (!isFirebaseConfigured || !db) {
        saveDevUomUnits(cleaned);
        setUnits(cleaned);
        snapshotRef.current = JSON.stringify(cleaned);
        return;
      }

      const prevIds = new Set(units.map((u) => u.id));
      const nextIds = new Set(cleaned.map((u) => u.id));

      for (const id of prevIds) {
        if (!nextIds.has(id)) {
          await deleteDoc(doc(db, collections.uomUnits, id));
        }
      }

      for (const unit of cleaned) {
        await setDoc(doc(db, collections.uomUnits, unit.id), unit, { merge: true });
      }

      setUnits(cleaned);
      snapshotRef.current = JSON.stringify(cleaned);
    } finally {
      setSaving(false);
    }
  }, [units]);

  const saveAll = useCallback(
    async (next: UomUnit[]) => {
      await persistUnits(next);
    },
    [persistUnits],
  );

  const saveUnitNames = useCallback(
    async (names: string[]) => {
      const next = syncNamesToUnits(units, names);
      await persistUnits(next);
    },
    [persistUnits, units],
  );

  const isDirty = useCallback(() => {
    return JSON.stringify(units) !== snapshotRef.current;
  }, [units]);

  const cancel = useCallback(() => {
    void load();
  }, [load]);

  return {
    units,
    setUnits,
    unitNames,
    loading,
    saving,
    saveAll,
    saveUnitNames,
    isDirty,
    cancel,
    reload: load,
  };
}
