import { useCallback, useEffect, useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { ensureFirebaseAuth } from '../firebaseAuth';
import type { Supplier } from '../types';

// ─── Form ────────────────────────────────────────────────────────────────────

export type SupplierFormData = {
  code: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  taxId: string;
  address: string;
  bankName: string;
  bankAccount: string;
  note: string;
  isActive: boolean;
  /** 'ALL' sentinel or array of specific branch IDs */
  allowedBranchIds: string[];
};

export function emptySupplierForm(): SupplierFormData {
  return {
    code: '',
    name: '',
    contactName: '',
    phone: '',
    email: '',
    taxId: '',
    address: '',
    bankName: '',
    bankAccount: '',
    note: '',
    isActive: true,
    allowedBranchIds: ['ALL'],
  };
}

export function supplierToForm(s: Supplier): SupplierFormData {
  return {
    code: s.code,
    name: s.name,
    contactName: s.contactName,
    phone: s.phone,
    email: s.email ?? '',
    taxId: s.taxId ?? '',
    address: s.address ?? '',
    bankName: s.bankName ?? '',
    bankAccount: s.bankAccount ?? '',
    note: s.note,
    isActive: s.isActive,
    allowedBranchIds: [...s.allowedBranchIds],
  };
}

export function validateSupplierForm(form: SupplierFormData, mode: 'create' | 'edit'): string | null {
  if (mode === 'create' && !form.code.trim()) return 'กรุณากรอกรหัสผู้จำหน่าย';
  if (!form.name.trim()) return 'กรุณากรอกชื่อผู้จำหน่าย';
  if (!form.phone.trim()) return 'กรุณากรอกเบอร์โทรศัพท์';
  if (form.allowedBranchIds.length === 0) return 'กรุณาเลือกสาขาที่ใช้งานได้อย่างน้อย 1 สาขา';
  return null;
}

// ─── Dev mock ─────────────────────────────────────────────────────────────────

let devSuppliers: Supplier[] = [
  {
    id: 'sup-001',
    code: 'SUP-001',
    name: 'บริษัท เพ็ทฟู้ดส์ จำกัด',
    contactName: 'คุณสมชาย',
    phone: '02-123-4567',
    email: 'info@petfoods.co.th',
    taxId: '0105560000001',
    address: '99/1 ถ.พระราม 2 กรุงเทพฯ',
    bankName: 'กสิกรไทย',
    bankAccount: '123-4-56789-0',
    note: 'ซัพพลายเออร์หลักอาหารสุนัข',
    isActive: true,
    allowedBranchIds: ['ALL'],
    createdAt: { toDate: () => new Date() } as Supplier['createdAt'],
    updatedAt: { toDate: () => new Date() } as Supplier['updatedAt'],
    deletedAt: null,
  },
  {
    id: 'sup-002',
    code: 'SUP-002',
    name: 'ห้างหุ้นส่วน ท็อปเพ็ท',
    contactName: 'คุณมานี',
    phone: '081-234-5678',
    email: null,
    taxId: null,
    address: null,
    bankName: null,
    bankAccount: null,
    note: '',
    isActive: true,
    allowedBranchIds: ['LDP-001'],
    createdAt: { toDate: () => new Date() } as Supplier['createdAt'],
    updatedAt: { toDate: () => new Date() } as Supplier['updatedAt'],
    deletedAt: null,
  },
];

/** Exposed so the POS-side hook can reuse the same mock data. */
export function getDevSuppliers(): Supplier[] {
  return devSuppliers.filter((s) => !s.deletedAt);
}

/** Inject a supplier into the dev mock array (used by POS create). */
export function devAddSupplier(s: Supplier): void {
  devSuppliers.push(s);
}

/** Update an existing supplier in the dev mock array (used by POS edit). */
export function devUpdateSupplier(s: Supplier): void {
  const idx = devSuppliers.findIndex((x) => x.id === s.id);
  if (idx >= 0) {
    devSuppliers[idx] = s;
  }
}

function devSave(s: Supplier): void {
  const idx = devSuppliers.findIndex((x) => x.id === s.id);
  if (idx >= 0) {
    devSuppliers[idx] = s;
  } else {
    devSuppliers.push(s);
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSupplierManagement() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const subscribeOrLoad = useCallback(() => {
    if (!isFirebaseConfigured || !db) {
      setSuppliers(devSuppliers.filter((s) => !s.deletedAt));
      setLoading(false);
      return () => {};
    }

    void ensureFirebaseAuth();

    setLoading(true);
    setError(null);

    const q = query(
      collection(db, collections.suppliers),
      orderBy('code', 'asc'),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setSuppliers(
          snap.docs
            .map((d) => ({ ...(d.data() as Supplier), id: d.id }))
            .filter((s) => !s.deletedAt),
        );
        setLoading(false);
      },
      (err) => {
        console.error('[useSupplierManagement] snapshot failed', err);
        setError(err.message);
        setLoading(false);
      },
    );

    return unsub;
  }, []);

  useEffect(() => {
    const unsub = subscribeOrLoad();
    return unsub;
  }, [subscribeOrLoad]);

  const saveSupplier = useCallback(
    async (form: SupplierFormData, editId?: string): Promise<void> => {
      const mode = editId ? 'edit' : 'create';
      const err = validateSupplierForm(form, mode);
      if (err) throw new Error(err);

      if (!isFirebaseConfigured || !db) {
        if (editId) {
          const existing = devSuppliers.find((s) => s.id === editId);
          if (!existing) throw new Error('ไม่พบข้อมูลผู้จำหน่าย');
          devSave({
            ...existing,
            name: form.name.trim(),
            contactName: form.contactName.trim(),
            phone: form.phone.trim(),
            email: form.email.trim() || null,
            taxId: form.taxId.trim() || null,
            address: form.address.trim() || null,
            bankName: form.bankName.trim() || null,
            bankAccount: form.bankAccount.trim() || null,
            note: form.note.trim(),
            isActive: form.isActive,
            allowedBranchIds: form.allowedBranchIds,
            updatedAt: { toDate: () => new Date() } as Supplier['updatedAt'],
          });
        } else {
          const id = `sup-${Date.now()}`;
          devSave({
            id,
            code: form.code.trim().toUpperCase(),
            name: form.name.trim(),
            contactName: form.contactName.trim(),
            phone: form.phone.trim(),
            email: form.email.trim() || null,
            taxId: form.taxId.trim() || null,
            address: form.address.trim() || null,
            bankName: form.bankName.trim() || null,
            bankAccount: form.bankAccount.trim() || null,
            note: form.note.trim(),
            isActive: form.isActive,
            allowedBranchIds: form.allowedBranchIds,
            createdAt: { toDate: () => new Date() } as Supplier['createdAt'],
            updatedAt: { toDate: () => new Date() } as Supplier['updatedAt'],
            deletedAt: null,
          });
        }
        setSuppliers(devSuppliers.filter((s) => !s.deletedAt));
        return;
      }

      await ensureFirebaseAuth();
      const now = serverTimestamp();

      if (editId) {
        const ref = doc(db, collections.suppliers, editId);
        await updateDoc(ref, {
          name: form.name.trim(),
          contactName: form.contactName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim() || null,
          taxId: form.taxId.trim() || null,
          address: form.address.trim() || null,
          bankName: form.bankName.trim() || null,
          bankAccount: form.bankAccount.trim() || null,
          note: form.note.trim(),
          isActive: form.isActive,
          allowedBranchIds: form.allowedBranchIds,
          updatedAt: now,
        });
      } else {
        const code = form.code.trim().toUpperCase();
        const ref = doc(db, collections.suppliers, code);
        const existing = await getDocs(
          query(collection(db, collections.suppliers)),
        ).then((s) => s.docs.find((d) => d.id === code));
        if (existing) throw new Error(`รหัส "${code}" มีอยู่แล้ว`);

        await setDoc(ref, {
          code,
          name: form.name.trim(),
          contactName: form.contactName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim() || null,
          taxId: form.taxId.trim() || null,
          address: form.address.trim() || null,
          bankName: form.bankName.trim() || null,
          bankAccount: form.bankAccount.trim() || null,
          note: form.note.trim(),
          isActive: form.isActive,
          allowedBranchIds: form.allowedBranchIds,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    },
    [],
  );

  const softDeleteSupplier = useCallback(async (id: string): Promise<void> => {
    if (!isFirebaseConfigured || !db) {
      devSuppliers = devSuppliers.map((s) =>
        s.id === id
          ? { ...s, deletedAt: { toDate: () => new Date() } as Supplier['deletedAt'] }
          : s,
      );
      setSuppliers(devSuppliers.filter((s) => !s.deletedAt));
      return;
    }
    await ensureFirebaseAuth();
    await updateDoc(doc(db, collections.suppliers, id), {
      deletedAt: serverTimestamp(),
      isActive: false,
      updatedAt: serverTimestamp(),
    });
  }, []);

  return { suppliers, loading, error, saveSupplier, softDeleteSupplier };
}

// ─── helpers re-exported ──────────────────────────────────────────────────────

export function supplierInitials(s: Supplier): string {
  return (s.name.trim()[0] ?? 'S').toUpperCase();
}

export function fmtBranchScope(ids: string[]): string {
  if (ids.includes('ALL')) return 'ทุกสาขา';
  return ids.join(', ');
}
