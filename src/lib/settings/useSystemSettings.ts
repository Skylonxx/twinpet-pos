import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import {
  DEFAULT_SYSTEM_SETTINGS,
  mergeSystemSettings,
  type SystemSettingsForm,
} from './systemTypes';

const DEV_STORAGE_KEY = 'twinpet-system-settings';

function readDevSettings(): SystemSettingsForm {
  try {
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SYSTEM_SETTINGS };
    return mergeSystemSettings(JSON.parse(raw) as Partial<SystemSettingsForm>);
  } catch {
    return { ...DEFAULT_SYSTEM_SETTINGS };
  }
}

function writeDevSettings(form: SystemSettingsForm): void {
  localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(form));
}

export function useSystemSettings() {
  const [form, setForm] = useState<SystemSettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savedRef = useRef<SystemSettingsForm | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        if (!isFirebaseConfigured || !db) {
          const dev = readDevSettings();
          if (!cancelled) {
            setForm(dev);
            savedRef.current = dev;
          }
          return;
        }

        const snap = await getDoc(doc(db, collections.settings, 'system'));
        const merged = mergeSystemSettings(
          snap.exists() ? (snap.data() as Partial<SystemSettingsForm>) : undefined,
        );
        if (!cancelled) {
          setForm(merged);
          savedRef.current = merged;
        }
      } catch (err) {
        console.error('Error loading system settings:', err);
        if (!cancelled) {
          const fallback = { ...DEFAULT_SYSTEM_SETTINGS };
          setForm(fallback);
          savedRef.current = fallback;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateForm = useCallback((patch: Partial<SystemSettingsForm>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const isDirty = useCallback(() => {
    if (!form || !savedRef.current) return false;
    return JSON.stringify(form) !== JSON.stringify(savedRef.current);
  }, [form]);

  const cancel = useCallback(() => {
    if (savedRef.current) setForm({ ...savedRef.current });
  }, []);

  const save = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    try {
      if (!isFirebaseConfigured || !db) {
        writeDevSettings(form);
        savedRef.current = { ...form };
        return;
      }

      await setDoc(
        doc(db, collections.settings, 'system'),
        {
          ...form,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      savedRef.current = { ...form };
    } finally {
      setSaving(false);
    }
  }, [form]);

  return {
    form,
    loading,
    saving,
    updateForm,
    save,
    cancel,
    isDirty,
  };
}
