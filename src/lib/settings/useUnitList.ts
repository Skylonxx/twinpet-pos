import { useCallback, useEffect, useState } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';

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

/** Master unit list + legacy current value (if not in master list) for select dropdowns */
export function buildUnitSelectOptions(masterUnits: string[], current?: string): string[] {
  const cleaned = masterUnits.map((u) => u.trim()).filter(Boolean);
  const cur = current?.trim();
  if (cur && !cleaned.includes(cur)) {
    return [cur, ...cleaned];
  }
  return cleaned;
}

const DEV_STORAGE_KEY = 'twinpet-unit-names';

function readDevUnits(): string[] {
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    if (!raw) return [...DEFAULT_UNIT_NAMES];
    const parsed = JSON.parse(raw) as string[];
    return parsed.length > 0 ? parsed : [...DEFAULT_UNIT_NAMES];
  } catch {
    return [...DEFAULT_UNIT_NAMES];
  }
}

function writeDevUnits(units: string[]): void {
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(units));
}

export function useUnitList() {
  const [units, setUnits] = useState<string[]>(DEFAULT_UNIT_NAMES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        if (!isFirebaseConfigured || !db) {
          if (!cancelled) setUnits(readDevUnits());
          return;
        }

        const snap = await getDoc(doc(db, collections.settings, 'units'));
        const names = snap.exists()
          ? ((snap.data().names as string[] | undefined) ?? DEFAULT_UNIT_NAMES)
          : DEFAULT_UNIT_NAMES;
        if (!cancelled) setUnits(names.length > 0 ? names : DEFAULT_UNIT_NAMES);
      } catch (err) {
        console.error('Error loading unit list:', err);
        if (!cancelled) setUnits(DEFAULT_UNIT_NAMES);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveUnits = useCallback(async (next: string[]) => {
    const cleaned = [...new Set(next.map((u) => u.trim()).filter(Boolean))];
    if (cleaned.length === 0) return;

    setSaving(true);
    try {
      if (!isFirebaseConfigured || !db) {
        writeDevUnits(cleaned);
        setUnits(cleaned);
        return;
      }

      await setDoc(
        doc(db, collections.settings, 'units'),
        { names: cleaned, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setUnits(cleaned);
    } finally {
      setSaving(false);
    }
  }, []);

  return { units, loading, saving, saveUnits };
}
