import { useCallback, useEffect, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { DEV_BRANCH, DEV_BRANCH_BKK } from '../settings/devMock';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { ensureFirebaseAuth } from '../firebaseAuth';
import type { Branch } from '../types';

export type BranchFormInput = {
  id: string;
  name: string;
  isActive: boolean;
};

function sortBranches(branches: Branch[]): Branch[] {
  return [...branches].sort((a, b) => a.id.localeCompare(b.id, 'th'));
}

function mapBranchDocs(
  docs: { id: string; data: () => Record<string, unknown> }[],
): Branch[] {
  return docs.map((d) => ({ ...(d.data() as Branch), id: d.id }));
}

export function validateBranchForm(
  input: BranchFormInput,
  mode: 'create' | 'edit',
): string | null {
  const id = input.id.trim();
  const name = input.name.trim();

  if (mode === 'create' && !id) {
    return 'กรุณากรอก Branch ID';
  }
  if (mode === 'create' && !/^[A-Za-z0-9-]+$/.test(id)) {
    return 'Branch ID ใช้ได้เฉพาะตัวอักษร ตัวเลข และ -';
  }
  if (!name) {
    return 'กรุณากรอกชื่อสาขา';
  }
  return null;
}

/** One-time fetch of every branch document (admin master data). */
export async function fetchAllBranches(): Promise<Branch[]> {
  if (!isFirebaseConfigured || !db) {
    return sortBranches([DEV_BRANCH, DEV_BRANCH_BKK]);
  }

  await ensureFirebaseAuth();
  const snap = await getDocs(collection(db, collections.branches));
  return sortBranches(mapBranchDocs(snap.docs));
}

export async function createBranch(input: BranchFormInput): Promise<void> {
  const validationError = validateBranchForm(input, 'create');
  if (validationError) throw new Error(validationError);

  if (!isFirebaseConfigured || !db) {
    throw new Error('ไม่รองรับการเพิ่มสาขาในโหมด dev');
  }

  await ensureFirebaseAuth();

  const branchId = input.id.trim().toUpperCase();
  const name = input.name.trim();
  const ref = doc(db, collections.branches, branchId);
  const existing = await getDoc(ref);

  if (existing.exists()) {
    throw new Error(`Branch ID "${branchId}" มีอยู่แล้ว`);
  }

  await setDoc(ref, {
    name,
    address: '',
    phone: '',
    email: '',
    taxId: '',
    logoUrl: null,
    isActive: input.isActive,
    deletedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateBranch(
  branchId: string,
  input: Pick<BranchFormInput, 'name' | 'isActive'>,
): Promise<void> {
  const validationError = validateBranchForm(
    { id: branchId, name: input.name, isActive: input.isActive },
    'edit',
  );
  if (validationError) throw new Error(validationError);

  if (!isFirebaseConfigured || !db) {
    throw new Error('ไม่รองรับการแก้ไขสาขาในโหมด dev');
  }

  await ensureFirebaseAuth();

  const ref = doc(db, collections.branches, branchId);
  const existing = await getDoc(ref);
  if (!existing.exists()) {
    throw new Error('ไม่พบสาขานี้ในระบบ');
  }

  await updateDoc(ref, {
    name: input.name.trim(),
    isActive: input.isActive,
    updatedAt: serverTimestamp(),
  });
}

export function branchIsActive(branch: Branch): boolean {
  return branch.isActive !== false;
}

export function branchToFormInput(branch: Branch): BranchFormInput {
  return {
    id: branch.id,
    name: branch.name ?? '',
    isActive: branchIsActive(branch),
  };
}

export function emptyBranchForm(): BranchFormInput {
  return { id: '', name: '', isActive: true };
}

export function useBranchManagement() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchAllBranches();
      setBranches(list);
    } catch (err) {
      console.error('[useBranchManagement] fetch failed', err);
      setError(err instanceof Error ? err.message : 'โหลดข้อมูลสาขาไม่สำเร็จ');
      setBranches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { branches, loading, error, refresh };
}
