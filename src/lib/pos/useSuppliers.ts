import { useEffect, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { devAddSupplier, devUpdateSupplier, getDevSuppliers } from '../admin/supplierManagement';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { ensureFirebaseAuth } from '../firebaseAuth';
import type { Supplier } from '../types';

// ─── POS supplier creation ────────────────────────────────────────────────────

export type PosSupplierForm = {
  name: string;
  contactName: string;
  phone: string;
  email: string;
  taxId: string;
  address: string;
  bankName: string;
  bankAccount: string;
  note: string;
};

function generateSupplierCode(branchId: string): string {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${branchId}-${suffix}`;
}

/**
 * POS-side supplier creation.
 * `allowedBranchIds` is locked to `[branchId]` — branch-local supplier only.
 * HQ admin can later widen visibility from the Admin › Suppliers page.
 */
export async function createPosSupplier(
  branchId: string,
  form: PosSupplierForm,
): Promise<Supplier> {
  const code = generateSupplierCode(branchId);

  if (!isFirebaseConfigured || !db) {
    const fakeTs = { toDate: () => new Date() } as Supplier['createdAt'];
    const newSupplier: Supplier = {
      id: code,
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
      isActive: true,
      allowedBranchIds: [branchId],
      createdAt: fakeTs,
      updatedAt: fakeTs,
      deletedAt: null,
    };
    devAddSupplier(newSupplier);
    return newSupplier;
  }

  await ensureFirebaseAuth();
  const ref = doc(db, collections.suppliers, code);
  const now = serverTimestamp();
  const data: Omit<Supplier, 'id'> = {
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
    isActive: true,
    allowedBranchIds: [branchId],
    createdAt: now as Supplier['createdAt'],
    updatedAt: now as Supplier['updatedAt'],
    deletedAt: null,
  };

  await setDoc(ref, data);
  return { ...data, id: code };
}

/**
 * POS-side supplier update.
 * Staff can only update suppliers that already include their branchId in allowedBranchIds
 * (enforced by Firestore rules). Editable fields: name, contactName, phone, taxId, address.
 * The code (document ID) and allowedBranchIds are immutable from the POS side.
 */
export async function updatePosSupplier(
  existing: Supplier,
  form: PosSupplierForm,
): Promise<Supplier> {
  const fakeTs = { toDate: () => new Date() } as Supplier['updatedAt'];
  const updated: Supplier = {
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
    updatedAt: fakeTs,
  };

  if (!isFirebaseConfigured || !db) {
    devUpdateSupplier(updated);
    return updated;
  }

  await ensureFirebaseAuth();
  const ref = doc(db, collections.suppliers, existing.id);
  await updateDoc(ref, {
    name: updated.name,
    contactName: updated.contactName,
    phone: updated.phone,
    email: updated.email,
    taxId: updated.taxId,
    address: updated.address,
    bankName: updated.bankName,
    bankAccount: updated.bankAccount,
    note: updated.note,
    updatedAt: serverTimestamp(),
  });
  return updated;
}

/**
 * Real-time list of active suppliers visible to a given branch.
 *
 * Firestore query uses `array-contains-any` so it returns docs where
 * `allowedBranchIds` contains `'ALL'` OR the specific `branchId`.
 * Soft-deleted and inactive suppliers are filtered out client-side.
 */
export function useActiveSuppliers(branchId: string): Supplier[] {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  useEffect(() => {
    if (!branchId) return;

    if (!isFirebaseConfigured || !db) {
      const dev = getDevSuppliers().filter(
        (s) =>
          s.isActive &&
          (s.allowedBranchIds.includes('ALL') ||
            s.allowedBranchIds.includes(branchId)),
      );
      dev.sort((a, b) => a.code.localeCompare(b.code));
      setSuppliers(dev);
      return;
    }

    void ensureFirebaseAuth();

    // Deduplicate in case branchId === 'ALL' (shouldn't happen in practice)
    const queryValues = Array.from(new Set(['ALL', branchId]));

    const q = query(
      collection(db, collections.suppliers),
      where('allowedBranchIds', 'array-contains-any', queryValues),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => ({ ...(d.data() as Supplier), id: d.id }))
          .filter((s) => s.isActive && !s.deletedAt);
        rows.sort((a, b) => a.code.localeCompare(b.code));
        setSuppliers(rows);
      },
      (err) => {
        console.error('[useActiveSuppliers] snapshot error', err);
        // keep whatever we had before rather than wipe the list
      },
    );

    return unsub;
  }, [branchId]);

  return suppliers;
}
