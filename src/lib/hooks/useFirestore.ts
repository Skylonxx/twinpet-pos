import { useCallback, useMemo } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';
import {
  useCollectionData,
  useDocumentData,
} from 'react-firebase-hooks/firestore';
import { collections, db, type CollectionName } from '../firebase';

type WithId<T> = T & { id: string };

function requireDb() {
  if (!db) {
    throw new Error(
      'Firestore is not configured. Add VITE_FIREBASE_* variables to .env.local',
    );
  }
  return db;
}

function collectionRef(name: CollectionName) {
  return collection(requireDb(), name);
}

function documentRef(name: CollectionName, id: string) {
  return doc(requireDb(), name, id);
}

/** Realtime list hook for a top-level collection */
export function useFirestoreCollection<T extends DocumentData>(
  collectionName: CollectionName,
  queryConstraints: QueryConstraint[] = [],
) {
  const ref = useMemo(() => {
    if (!db) return null;
    const base = collection(db, collectionName);
    return queryConstraints.length > 0
      ? query(base, ...queryConstraints)
      : base;
  }, [collectionName, queryConstraints]);

  const [data, loading, error] = useCollectionData<T>(
    ref as Query<T> | null,
  );

  const items = useMemo(
    () => (data ?? []) as WithId<T>[],
    [data],
  );

  return { data: items, loading, error };
}

/** Realtime document hook */
export function useFirestoreDocument<T extends DocumentData>(
  collectionName: CollectionName,
  documentId: string | null | undefined,
) {
  const ref = useMemo(() => {
    if (!db || !documentId) return null;
    return doc(db, collectionName, documentId);
  }, [collectionName, documentId]);

  const [data, loading, error] = useDocumentData<T>(
    ref as import('firebase/firestore').DocumentReference<T> | null,
  );

  const item = useMemo(() => {
    if (!data || !documentId) return null;
    return { ...data, id: documentId } as WithId<T>;
  }, [data, documentId]);

  return { data: item, loading, error };
}

export function useFirestoreMutations<T extends DocumentData>(
  collectionName: CollectionName,
) {
  const create = useCallback(
    async (payload: T, documentId?: string) => {
      const firestore = requireDb();
      const withTimestamps = {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      if (documentId) {
        const ref = doc(firestore, collectionName, documentId);
        await setDoc(ref, withTimestamps);
        return documentId;
      }

      const ref = await addDoc(collectionRef(collectionName), withTimestamps);
      return ref.id;
    },
    [collectionName],
  );

  const update = useCallback(
    async (documentId: string, payload: Partial<T>) => {
      await updateDoc(documentRef(collectionName, documentId), {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    },
    [collectionName],
  );

  const remove = useCallback(
    async (documentId: string) => {
      await deleteDoc(documentRef(collectionName, documentId));
    },
    [collectionName],
  );

  const softDelete = useCallback(
    async (documentId: string) => {
      await updateDoc(documentRef(collectionName, documentId), {
        deletedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    },
    [collectionName],
  );

  return { create, update, remove, softDelete };
}

/** Subcollection realtime list */
export function useFirestoreSubcollection<T extends DocumentData>(
  parentCollection: CollectionName,
  parentId: string | null | undefined,
  subcollectionName: string,
) {
  const ref = useMemo(() => {
    if (!db || !parentId) return null;
    return collection(
      db,
      parentCollection,
      parentId,
      subcollectionName,
    );
  }, [parentCollection, parentId, subcollectionName]);

  // A CollectionReference is a Query at runtime; the firebase SDK's two-param
  // Query<App, Db> generics need the through-`unknown` cast (TS-recommended).
  const [data, loading, error] = useCollectionData<T>(
    ref as unknown as Query<T> | null,
  );

  const items = useMemo(
    () => (data ?? []) as WithId<T>[],
    [data],
  );

  return { data: items, loading, error };
}

export function useFirestoreSubcollectionMutations<T extends DocumentData>(
  parentCollection: CollectionName,
  parentId: string,
  subcollectionName: string,
) {
  const subRef = useCallback(
    (itemId?: string) => {
      const firestore = requireDb();
      if (itemId) {
        return doc(
          firestore,
          parentCollection,
          parentId,
          subcollectionName,
          itemId,
        );
      }
      return collection(
        firestore,
        parentCollection,
        parentId,
        subcollectionName,
      );
    },
    [parentCollection, parentId, subcollectionName],
  );

  const create = useCallback(
    async (payload: T, itemId?: string) => {
      const data = { ...payload, createdAt: serverTimestamp() };
      if (itemId) {
        await setDoc(subRef(itemId) as ReturnType<typeof doc>, data);
        return itemId;
      }
      const ref = await addDoc(subRef() as ReturnType<typeof collection>, data);
      return ref.id;
    },
    [subRef],
  );

  const update = useCallback(
    async (itemId: string, payload: Partial<T>) => {
      await updateDoc(
        subRef(itemId) as import('firebase/firestore').DocumentReference<T>,
        payload as DocumentData,
      );
    },
    [subRef],
  );

  const remove = useCallback(
    async (itemId: string) => {
      await deleteDoc(subRef(itemId) as ReturnType<typeof doc>);
    },
    [subRef],
  );

  return { create, update, remove };
}

export { collections };
