import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from './firebase';
import { ensureFirebaseAuth } from './firebaseAuth';
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

/** Treat missing isActive as active (legacy / seed docs without the field). */
function isBranchActive(branch: Branch): boolean {
  return branch.isActive !== false;
}

function mapBranchDocs(
  docs: { id: string; data: () => Record<string, unknown> }[],
): Branch[] {
  return docs.map((d) => ({ ...(d.data() as Branch), id: d.id }));
}

/** Fetch branches from Firestore (or dev seed) and refresh the label cache. */
export async function fetchActiveBranches(): Promise<Branch[]> {
  if (!isFirebaseConfigured || !db) {
    const branches = sortBranches(getDevBranches());
    seedBranchLabelCache(branches);
    return branches;
  }

  // Login reads branches before PIN verify — need anonymous Auth for rules.
  await ensureFirebaseAuth();

  const snap = await getDocs(collection(db, collections.branches));
  const allBranches = mapBranchDocs(snap.docs);
  const activeBranches = allBranches.filter(isBranchActive);

  const branches = sortBranches(
    activeBranches.length > 0 ? activeBranches : allBranches,
  );

  if (activeBranches.length === 0 && allBranches.length > 0) {
    console.warn(
      '[branches] no branches with isActive !== false — showing all branches as fallback',
      allBranches.map((b) => ({ id: b.id, name: b.name, isActive: b.isActive })),
    );
  }

  if (allBranches.length === 0) {
    console.warn('[branches] branches collection is empty');
  }

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
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[branches] fetchActiveBranches failed', error);
      setError(error);
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
