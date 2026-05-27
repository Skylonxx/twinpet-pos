import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Branch } from '../types';
import { useAuth } from './useAuth';

const BRANCH_STORAGE_KEY = 'twinpet_branch_id';

export type UseBranchResult = {
  branchId: string | null;
  branch: Branch | null;
  allowedBranchIds: string[];
  isLoading: boolean;
  error: Error | null;
  setBranchId: (branchId: string) => void;
  hasBranchAccess: (branchId: string) => boolean;
};

export function useBranch(): UseBranchResult {
  const { user, branchId: sessionBranchId, setBranchId: setSessionBranchId, isAuthenticated } =
    useAuth();

  const [branch, setBranch] = useState<Branch | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const allowedBranchIds = useMemo(
    () => user?.branchIds ?? [],
    [user?.branchIds],
  );

  const branchId = useMemo(() => {
    if (!isAuthenticated || !user) return null;

    if (sessionBranchId && allowedBranchIds.includes(sessionBranchId)) {
      return sessionBranchId;
    }

    const stored = localStorage.getItem(BRANCH_STORAGE_KEY);
    if (stored && allowedBranchIds.includes(stored)) {
      return stored;
    }

    return allowedBranchIds[0] ?? null;
  }, [isAuthenticated, user, sessionBranchId, allowedBranchIds]);

  const hasBranchAccess = useCallback(
    (id: string) => allowedBranchIds.includes(id),
    [allowedBranchIds],
  );

  const setBranchId = useCallback(
    (id: string) => {
      if (!hasBranchAccess(id)) {
        throw new Error('คุณไม่มีสิทธิ์เข้าถึงสาขานี้');
      }
      localStorage.setItem(BRANCH_STORAGE_KEY, id);
      setSessionBranchId(id);
    },
    [hasBranchAccess, setSessionBranchId],
  );

  useEffect(() => {
    if (!branchId || !isAuthenticated) {
      setBranch(null);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setBranch({
        id: branchId,
        name: branchId,
        address: '',
        phone: '',
        email: '',
        taxId: '',
        logoUrl: null,
        isActive: true,
        createdAt: null as never,
        updatedAt: null as never,
      });
      return;
    }

    setIsLoading(true);
    setError(null);

    const branchRef = doc(db, collections.branches, branchId);
    const unsubscribe = onSnapshot(
      branchRef,
      (snap) => {
        setIsLoading(false);
        if (!snap.exists()) {
          setBranch(null);
          return;
        }
        setBranch({ ...(snap.data() as Branch), id: snap.id });
      },
      (err) => {
        setIsLoading(false);
        setError(err);
        setBranch(null);
      },
    );

    return unsubscribe;
  }, [branchId, isAuthenticated]);

  useEffect(() => {
    if (branchId) {
      localStorage.setItem(BRANCH_STORAGE_KEY, branchId);
    }
  }, [branchId]);

  return {
    branchId,
    branch,
    allowedBranchIds,
    isLoading,
    error,
    setBranchId,
    hasBranchAccess,
  };
}

/** Load all branches the current user can access */
export function useAllowedBranches(): {
  branches: Branch[];
  isLoading: boolean;
  error: Error | null;
} {
  const { allowedBranchIds } = useBranch();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!allowedBranchIds.length) {
      setBranches([]);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setBranches(
        allowedBranchIds.map((id) => ({
          id,
          name: id,
          address: '',
          phone: '',
          email: '',
          taxId: '',
          logoUrl: null,
          isActive: true,
          createdAt: null as never,
          updatedAt: null as never,
        })),
      );
      return;
    }

    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const results: Branch[] = [];
        const chunkSize = 10;

        for (let i = 0; i < allowedBranchIds.length; i += chunkSize) {
          const chunk = allowedBranchIds.slice(i, i + chunkSize);
          const snap = await getDocs(
            query(
              collection(db!, collections.branches),
              where('id', 'in', chunk.length ? chunk : ['__none__']),
            ),
          );
          snap.forEach((d) => {
            results.push({ ...(d.data() as Branch), id: d.id });
          });
        }

        for (const id of allowedBranchIds) {
          if (results.some((b) => b.id === id)) continue;
          const direct = await getDoc(doc(db!, collections.branches, id));
          if (direct.exists()) {
            results.push({ ...(direct.data() as Branch), id: direct.id });
          }
        }

        if (!cancelled) {
          setBranches(results);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [allowedBranchIds]);

  return { branches, isLoading, error };
}
