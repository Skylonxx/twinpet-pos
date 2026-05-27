import { collection, deleteDoc, doc, getDocs, onSnapshot, orderBy, query, setDoc } from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { CustomerTier } from '../types';
import { DEFAULT_CUSTOMER_TIER } from '../types';

export const DEFAULT_CUSTOMER_TIERS: CustomerTier[] = [
  { id: DEFAULT_CUSTOMER_TIER, name: 'ลูกค้าทั่วไป' },
  { id: 'wholesale', name: 'ขายส่ง' },
  { id: 'vip', name: 'ลูกค้า VIP' },
  { id: 'agent1', name: 'ตัวแทนจำกัด' },
  { id: 'farm_large', name: 'ฟาร์มขนาดใหญ่' },
];

const DEV_STORAGE_KEY = 'twinpet-customer-tiers';

function readDevTiers(): CustomerTier[] {
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    if (!raw) return DEFAULT_CUSTOMER_TIERS.map((t) => ({ ...t }));
    const parsed = JSON.parse(raw) as CustomerTier[];
    return parsed.length > 0 ? parsed : DEFAULT_CUSTOMER_TIERS.map((t) => ({ ...t }));
  } catch {
    return DEFAULT_CUSTOMER_TIERS.map((t) => ({ ...t }));
  }
}

function writeDevTiers(tiers: CustomerTier[]): void {
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(tiers));
}

function sanitizeTiers(tiers: CustomerTier[]): CustomerTier[] {
  const seen = new Set<string>();
  const cleaned: CustomerTier[] = [];
  for (const tier of tiers) {
    const id = tier.id.trim();
    const name = tier.name.trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    cleaned.push({ id, name });
  }
  return cleaned.length > 0 ? cleaned : DEFAULT_CUSTOMER_TIERS.map((t) => ({ ...t }));
}

function mapTierDocs(docs: Array<{ id: string; data: () => Record<string, unknown> }>): CustomerTier[] {
  const tiers = docs.map((d) => {
    const data = d.data();
    const id = String(data.id ?? d.id).trim();
    const name = String(data.name ?? id).trim();
    return { id, name };
  });
  return sanitizeTiers(tiers);
}

export function customerTierLabel(tiers: CustomerTier[], tierId: string): string {
  const key = tierId?.trim() || DEFAULT_CUSTOMER_TIER;
  return tiers.find((t) => t.id === key)?.name ?? key;
}

export function customerTierOptions(tiers: CustomerTier[]): CustomerTier[] {
  return sanitizeTiers(tiers);
}

/** Generate a URL-safe tier id from a display name (fallback when id is blank). */
export function slugFromTierName(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (ascii) return ascii;
  return `tier_${Date.now().toString(36)}`;
}

export async function addCustomerTier(tier: CustomerTier): Promise<void> {
  const id = tier.id.trim();
  const name = tier.name.trim();
  if (!id || !name) throw new Error('กรุณาระบุชื่อกลุ่มลูกค้า');

  if (!isFirebaseConfigured || !db) {
    const current = readDevTiers();
    if (current.some((t) => t.id === id)) throw new Error('มีกลุ่มลูกค้านี้อยู่แล้ว');
    writeDevTiers(sanitizeTiers([...current, { id, name }]));
    return;
  }

  await setDoc(doc(db, collections.customerTiers, id), { id, name });
}

export async function deleteCustomerTier(id: string): Promise<void> {
  const tierId = id.trim();
  if (!tierId) return;
  if (tierId === DEFAULT_CUSTOMER_TIER) throw new Error('ไม่สามารถลบกลุ่ม retail ได้');

  if (!isFirebaseConfigured || !db) {
    const current = readDevTiers();
    writeDevTiers(sanitizeTiers(current.filter((t) => t.id !== tierId)));
    return;
  }

  await deleteDoc(doc(db, collections.customerTiers, tierId));
}

export function useCustomerTiers() {
  const [tiers, setTiers] = useState<CustomerTier[]>(DEFAULT_CUSTOMER_TIERS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      setTiers(readDevTiers());
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const q = query(collection(db, collections.customerTiers), orderBy('id', 'asc'));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const mapped = mapTierDocs(snap.docs);
        setTiers(mapped.length > 0 ? mapped : DEFAULT_CUSTOMER_TIERS.map((t) => ({ ...t })));
        setLoading(false);
      },
      (err) => {
        setError(err);
        setTiers(DEFAULT_CUSTOMER_TIERS.map((t) => ({ ...t })));
        setLoading(false);
      },
    );

    return () => unsub();
  }, []);

  const refreshDev = useCallback(() => {
    if (isFirebaseConfigured) return;
    setTiers(readDevTiers());
  }, []);

  const saveDevTiers = useCallback((next: CustomerTier[]) => {
    const cleaned = sanitizeTiers(next);
    writeDevTiers(cleaned);
    setTiers(cleaned);
  }, []);

  const addTier = useCallback(async (name: string, idInput?: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('กรุณาระบุชื่อกลุ่มลูกค้า');
    const id = (idInput?.trim() || slugFromTierName(trimmedName)).toLowerCase();
    setSaving(true);
    setError(null);
    try {
      await addCustomerTier({ id, name: trimmedName });
      if (!isFirebaseConfigured) setTiers(readDevTiers());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  const removeTier = useCallback(async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      await deleteCustomerTier(id);
      if (!isFirebaseConfigured) setTiers(readDevTiers());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  return { tiers, loading, saving, error, refreshDev, saveDevTiers, addTier, removeTier };
}

/** One-shot fetch for non-hook contexts (e.g. server-side prep) */
export async function fetchCustomerTiers(): Promise<CustomerTier[]> {
  if (!isFirebaseConfigured || !db) {
    return readDevTiers();
  }
  const snap = await getDocs(query(collection(db, collections.customerTiers), orderBy('id', 'asc')));
  const mapped = mapTierDocs(snap.docs);
  return mapped.length > 0 ? mapped : DEFAULT_CUSTOMER_TIERS.map((t) => ({ ...t }));
}
