import { useCallback, useEffect, useState } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import {
  DEFAULT_EXPIRY_POLICIES,
  normalizeExpiryPolicies,
  type ExpiryPolicy,
} from './expiryPolicyTypes';

const DEV_STORAGE_KEY = 'twinpet-expiry-policies';

function readDevPolicies(): ExpiryPolicy[] {
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    if (!raw) return [...DEFAULT_EXPIRY_POLICIES];
    return normalizeExpiryPolicies(JSON.parse(raw));
  } catch {
    return [...DEFAULT_EXPIRY_POLICIES];
  }
}

function writeDevPolicies(policies: ExpiryPolicy[]): void {
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(policies));
}

export function useExpiryPolicies() {
  const [policies, setPolicies] = useState<ExpiryPolicy[]>(DEFAULT_EXPIRY_POLICIES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        if (!isFirebaseConfigured || !db) {
          if (!cancelled) setPolicies(readDevPolicies());
          return;
        }

        const snap = await getDoc(doc(db, collections.settings, 'expiryPolicies'));
        const next = snap.exists()
          ? normalizeExpiryPolicies(snap.data().policies)
          : [...DEFAULT_EXPIRY_POLICIES];
        if (!cancelled) setPolicies(next);
      } catch (err) {
        console.error('Error loading expiry policies:', err);
        if (!cancelled) setPolicies(DEFAULT_EXPIRY_POLICIES);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const savePolicies = useCallback(async (next: ExpiryPolicy[]) => {
    const cleaned = normalizeExpiryPolicies(next);
    setSaving(true);
    try {
      if (!isFirebaseConfigured || !db) {
        writeDevPolicies(cleaned);
        setPolicies(cleaned);
        return;
      }

      await setDoc(
        doc(db, collections.settings, 'expiryPolicies'),
        { policies: cleaned, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setPolicies(cleaned);
    } finally {
      setSaving(false);
    }
  }, []);

  const defaultPolicy = policies.find((p) => p.isDefault) ?? policies[0] ?? DEFAULT_EXPIRY_POLICIES[0]!;

  return { policies, defaultPolicy, loading, saving, savePolicies };
}
