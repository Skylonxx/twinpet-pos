import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Branch, PosDevice, Settings } from '../types';
import {
  devAddDevice,
  devForceLogout,
  devRemoveDevice,
  getDevBranch,
  getDevDevices,
  getDevExtras,
  getDevPriceLevels,
  getDevSettings,
  priceLevelToRow,
  rowToPriceLevel,
  saveDevData,
} from './devMock';
import { uploadSettingsImage } from './storage';
import {
  branchToForm,
  DEFAULT_EXTRAS,
  DEFAULT_NOTIFICATIONS,
  formToBranch,
  formToExtras,
  formToSettings,
  settingsToForm,
  type PriceLevelRow,
  type SettingsFormData,
} from './types';

function defaultBranch(branchId: string): Branch {
  const now = serverTimestamp() as Branch['createdAt'];
  return {
    id: branchId,
    name: '',
    address: '',
    phone: '',
    email: '',
    taxId: '',
    logoUrl: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

function defaultSettings(branchId: string): Settings {
  return {
    branchId,
    vatRegistered: false,
    vatRate: 7,
    priceIncludesVat: true,
    paymentMethods: { cash: true, qr: true, kbank: true, card: true, credit: true },
    receiptHeader: '',
    receiptFooter: '',
    receiptLogoUrl: null,
    showBarcodeOnReceipt: true,
    showQrOnReceipt: false,
    pinMaxAttempts: 5,
    sessionTimeoutMin: 30,
    notifications: DEFAULT_NOTIFICATIONS,
    lineNotifyToken: null,
    allowNegativeStock: false,
    negativeStockWarning: true,
    parkedOrderExpiryHours: 4,
    requiresPasswordForVoid: true, // Phase 7B-3: security-first default.
    updatedAt: serverTimestamp() as Settings['updatedAt'],
  };
}

async function loadExtras(firestore: Firestore, branchId: string) {
  const snap = await getDoc(doc(firestore, collections.settings, branchId));
  if (!snap.exists()) return { ...DEFAULT_EXTRAS };
  const data = snap.data() as Record<string, unknown>;
  return {
    ...DEFAULT_EXTRAS,
    showVatOnReceipt: (data.showVatOnReceipt as boolean) ?? DEFAULT_EXTRAS.showVatOnReceipt,
    showCustomerTaxId: (data.showCustomerTaxId as boolean) ?? DEFAULT_EXTRAS.showCustomerTaxId,
    showLogoOnReceipt: (data.showLogoOnReceipt as boolean) ?? DEFAULT_EXTRAS.showLogoOnReceipt,
    defaultCreditLimit: (data.defaultCreditLimit as number) ?? DEFAULT_EXTRAS.defaultCreditLimit,
    defaultCreditDays: (data.defaultCreditDays as number) ?? DEFAULT_EXTRAS.defaultCreditDays,
    creditRequireApproval: (data.creditRequireApproval as boolean) ?? DEFAULT_EXTRAS.creditRequireApproval,
    companyName: (data.companyName as string) ?? DEFAULT_EXTRAS.companyName,
    invoiceNumberFormat: (data.invoiceNumberFormat as string) ?? DEFAULT_EXTRAS.invoiceNumberFormat,
    webhookUrl: (data.webhookUrl as string) ?? DEFAULT_EXTRAS.webhookUrl,
    posPrinter: (data.posPrinter as string) ?? DEFAULT_EXTRAS.posPrinter,
    posPaperSize: (data.posPaperSize as string) ?? DEFAULT_EXTRAS.posPaperSize,
    autoPrintReceipt: (data.autoPrintReceipt as boolean) ?? DEFAULT_EXTRAS.autoPrintReceipt,
    printReceiptCopy: (data.printReceiptCopy as boolean) ?? DEFAULT_EXTRAS.printReceiptCopy,
    posLockOnIdle: (data.posLockOnIdle as boolean) ?? DEFAULT_EXTRAS.posLockOnIdle,
    fullActivityLog: (data.fullActivityLog as boolean) ?? DEFAULT_EXTRAS.fullActivityLog,
    backupSchedule: (data.backupSchedule as string) ?? DEFAULT_EXTRAS.backupSchedule,
    backupRetentionDays: (data.backupRetentionDays as number) ?? DEFAULT_EXTRAS.backupRetentionDays,
  };
}

export function useSettings(branchId: string | null) {
  const [form, setForm] = useState<SettingsFormData | null>(null);
  const [priceLevels, setPriceLevels] = useState<PriceLevelRow[]>([]);
  const [devices, setDevices] = useState<PosDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const snapshotRef = useRef<string>('');
  // Track the price level IDs that came from Firestore so we can deleteDoc removed ones on save
  const firestorePriceLevelIdsRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!branchId) {
      setForm(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      if (!isFirebaseConfigured || !db) {
        const branch = getDevBranch();
        const settings = getDevSettings();
        const extras = getDevExtras();
        const nextForm = settingsToForm(settings, branch, extras);
        const devPls = getDevPriceLevels();
        const devDevs = getDevDevices();
        setForm(nextForm);
        setPriceLevels(devPls);
        setDevices(devDevs);
        firestorePriceLevelIdsRef.current = new Set(devPls.map((p) => p.id));
        snapshotRef.current = JSON.stringify({ nextForm, priceLevels: devPls, devices: devDevs });
        return;
      }

      const [branchSnap, settingsSnap, plSnap, devSnap] = await Promise.all([
        getDoc(doc(db, collections.branches, branchId)),
        getDoc(doc(db, collections.settings, branchId)),
        getDocs(query(collection(db, collections.priceLevels), orderBy('order', 'asc'))),
        getDocs(query(collection(db, collections.posDevices), where('branchId', '==', branchId))),
      ]);

      const branch = branchSnap.exists()
        ? ({ ...branchSnap.data(), id: branchSnap.id } as Branch)
        : defaultBranch(branchId);
      const settings = settingsSnap.exists()
        ? (settingsSnap.data() as Settings)
        : defaultSettings(branchId);
      const extras = await loadExtras(db, branchId);

      const pls = plSnap.docs.map((d) =>
        priceLevelToRow({ ...(d.data() as PriceLevelRow), id: d.id }),
      );
      const devs = devSnap.docs.map((d) => ({ ...(d.data() as PosDevice), id: d.id }));

      const nextForm = settingsToForm(settings, branch, extras);
      setForm(nextForm);
      setPriceLevels(pls);
      setDevices(devs);
      firestorePriceLevelIdsRef.current = new Set(pls.map((p) => p.id));
      snapshotRef.current = JSON.stringify({ nextForm, priceLevels: pls, devices: devs });
    } catch (err) {
      console.error('[useSettings] load failed', err);
      // Fall back to defaults so the page renders instead of hanging on the loading spinner
      const fallbackBranch = defaultBranch(branchId);
      const fallbackSettings = defaultSettings(branchId);
      setForm(settingsToForm(fallbackSettings, fallbackBranch));
      setPriceLevels([]);
      setDevices([]);
      firestorePriceLevelIdsRef.current = new Set();
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateForm = useCallback((patch: Partial<SettingsFormData>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
  }, []);

  const save = useCallback(async () => {
    if (!branchId || !form) return;
    setSaving(true);
    try {
      const branchPayload = formToBranch(form, branchId);
      const settingsPayload = formToSettings(form, branchId);
      const extrasPayload = formToExtras(form);

      if (!isFirebaseConfigured || !db) {
        saveDevData({
          branch: { ...getDevBranch(), ...branchPayload, updatedAt: getDevBranch().updatedAt },
          settings: { ...settingsPayload, updatedAt: getDevSettings().updatedAt },
          extras: extrasPayload,
          priceLevels,
          devices,
        });
        setLastSavedAt(new Date());
        snapshotRef.current = JSON.stringify({ form, priceLevels, devices });
        return;
      }

      await setDoc(
        doc(db, collections.branches, branchId),
        { ...branchPayload, updatedAt: serverTimestamp(), isActive: true },
        { merge: true },
      );

      await setDoc(
        doc(db, collections.settings, branchId),
        { ...settingsPayload, ...extrasPayload, updatedAt: serverTimestamp() },
        { merge: true },
      );

      // Delete any price levels that were removed from the UI since last load/save
      const currentPriceLevelIds = new Set(priceLevels.map((p) => p.id));
      for (const id of firestorePriceLevelIdsRef.current) {
        if (!currentPriceLevelIds.has(id)) {
          await deleteDoc(doc(db, collections.priceLevels, id));
        }
      }
      // Write/update remaining levels
      for (const pl of priceLevels) {
        await setDoc(doc(db, collections.priceLevels, pl.id), rowToPriceLevel(pl), { merge: true });
      }
      // Keep the ref in sync so subsequent saves within the same session work correctly
      firestorePriceLevelIdsRef.current = new Set(currentPriceLevelIds);

      setLastSavedAt(new Date());
      snapshotRef.current = JSON.stringify({ form, priceLevels, devices });
    } finally {
      setSaving(false);
    }
  }, [branchId, form, priceLevels, devices]);

  /**
   * Phase 7B-3B: persist ONLY `requiresPasswordForVoid` (+ updatedAt). This is a
   * narrow, field-scoped write — the single settings write a Manager is permitted
   * by firestore.rules (the full-doc Save below stays Admin-only). Updates the
   * form + dirty snapshot in place so the main Save button state is unaffected.
   */
  const saveVoidPasswordSetting = useCallback(
    async (value: boolean) => {
      if (!branchId || !form) return;
      const nextForm = { ...form, requiresPasswordForVoid: value };
      setForm(nextForm);
      snapshotRef.current = JSON.stringify({ form: nextForm, priceLevels, devices });

      if (!isFirebaseConfigured || !db) {
        saveDevData({
          branch: getDevBranch(),
          settings: { ...getDevSettings(), requiresPasswordForVoid: value },
          extras: getDevExtras(),
          priceLevels,
          devices,
        });
        return;
      }

      await setDoc(
        doc(db, collections.settings, branchId),
        { requiresPasswordForVoid: value, updatedAt: serverTimestamp() },
        { merge: true },
      );
    },
    [branchId, form, priceLevels, devices],
  );

  const cancel = useCallback(() => {
    void load();
  }, [load]);

  const isDirty = useCallback(() => {
    if (!form) return false;
    return JSON.stringify({ form, priceLevels, devices }) !== snapshotRef.current;
  }, [form, priceLevels, devices]);

  const uploadLogo = useCallback(
    async (file: File, kind: 'branch' | 'receipt') => {
      if (!branchId) return;
      const url = await uploadSettingsImage(branchId, file, kind === 'branch' ? 'branch-logo' : 'receipt-logo');
      if (kind === 'branch') {
        updateForm({ logoUrl: url });
      } else {
        updateForm({ receiptLogoUrl: url });
      }
      return url;
    },
    [branchId, updateForm],
  );

  const forceLogoutDevice = useCallback(
    async (deviceId: string) => {
      if (!isFirebaseConfigured || !db) {
        devForceLogout(deviceId);
        setDevices(getDevDevices());
        return;
      }
      await updateDoc(doc(db, collections.posDevices, deviceId), {
        isOnline: false,
        currentUserId: null,
      });
      setDevices((list) =>
        list.map((d) => (d.id === deviceId ? { ...d, isOnline: false, currentUserId: null } : d)),
      );
    },
    [],
  );

  const removeDevice = useCallback(async (deviceId: string) => {
    if (!isFirebaseConfigured || !db) {
      devRemoveDevice(deviceId);
      setDevices(getDevDevices());
      return;
    }
    await updateDoc(doc(db, collections.posDevices, deviceId), { isOnline: false, currentUserId: null });
    setDevices((list) => list.filter((d) => d.id !== deviceId));
  }, []);

  const addDevice = useCallback(
    async (name: string, token: string, type: PosDevice['type']) => {
      if (!branchId) return;
      const id = `dev-${Date.now()}`;
      const device: PosDevice = {
        id,
        branchId,
        name,
        token,
        type,
        isOnline: false,
        lastSeenAt: null,
        currentUserId: null,
        createdAt: serverTimestamp() as PosDevice['createdAt'],
      };
      if (!isFirebaseConfigured || !db) {
        devAddDevice(device);
        setDevices(getDevDevices());
        return;
      }
      await setDoc(doc(db, collections.posDevices, id), device);
      setDevices((list) => [...list, device]);
    },
    [branchId],
  );

  return {
    form,
    setForm,
    updateForm,
    priceLevels,
    setPriceLevels,
    devices,
    setDevices,
    loading,
    saving,
    lastSavedAt,
    save,
    saveVoidPasswordSetting,
    cancel,
    isDirty,
    uploadLogo,
    forceLogoutDevice,
    removeDevice,
    addDevice,
    reload: load,
  };
}

export { branchToForm, settingsToForm };
