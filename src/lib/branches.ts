import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from './firebase';
import { getDevBranches } from './settings/devMock';
import type { Branch } from './types';

const branchLabelCache = new Map<string, string>();

export function seedBranchLabelCache(branches: Branch[]): void {
  branchLabelCache.clear();
  for (const branch of branches) {
    branchLabelCache.set(branch.id, branch.name);
  }
}

export function getBranchLabel(branchId: string): string {
  return branchLabelCache.get(branchId) ?? branchId;
}

function sortBranches(branches: Branch[]): Branch[] {
  return [...branches].sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

/** Fetch active branches from Firestore (or dev seed) and refresh the label cache. */
export async function fetchActiveBranches(): Promise<Branch[]> {
  if (!isFirebaseConfigured || !db) {
    const branches = sortBranches(getDevBranches());
    seedBranchLabelCache(branches);
    return branches;
  }

  const snap = await getDocs(
    query(collection(db, collections.branches), where('isActive', '==', true)),
  );

  const branches = sortBranches(
    snap.docs.map((d) => ({ ...(d.data() as Branch), id: d.id })),
  );

  seedBranchLabelCache(branches);
  return branches;
}

export function useActiveBranches() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchActiveBranches();
      setBranches(list);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setBranches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const getLabel = useCallback(
    (branchId: string) => branches.find((b) => b.id === branchId)?.name ?? getBranchLabel(branchId),
    [branches],
  );

  return { branches, loading, error, reload, getLabel };
}
