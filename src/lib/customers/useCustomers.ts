import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { CreditAccount, CreditTransaction, Customer, Order, PriceLevel } from '../types';
import { DEFAULT_CUSTOMER_TIER } from '../types';
import {
  devGenerateCustomerId,
  devGenerateMemberNo,
  devSaveCustomer,
  devSoftDeleteCustomer,
  getDevCreditAccount,
  getDevCreditTransactions,
  getDevCustomerOrders,
  getDevCustomers,
  getDevPriceLevels,
  initDevCustomers,
} from './devMock';
import type { CustomerFormData } from './types';
import { customerCrmFields, normalizeCustomerForm } from './types';

function formToCustomerFields(form: CustomerFormData) {
  const normalized = normalizeCustomerForm(form);
  const tags = normalized.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    firstName: normalized.firstName.trim(),
    lastName: normalized.lastName.trim(),
    phone: normalized.phone.trim(),
    email: normalized.email.trim() || null,
    taxId: normalized.taxId.trim() || null,
    address: normalized.address.trim() || null,
    contactType: normalized.contactType,
    bankName:
      normalized.contactType === 'supplier' ? normalized.bankName.trim() || null : null,
    bankAccount:
      normalized.contactType === 'supplier' ? normalized.bankAccount.trim() || null : null,
    priceLevelId: normalized.priceLevelId,
    creditLimit: normalized.creditLimit,
    creditDays: normalized.creditDays,
    tags,
    customerType: normalized.customerType.trim() || DEFAULT_CUSTOMER_TIER,
    note: normalized.note.trim(),
    isActive: normalized.isActive,
  };
}

export function useCustomers(branchId: string | null) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [priceLevels, setPriceLevels] = useState<PriceLevel[]>([]);
  const [creditMap, setCreditMap] = useState<Map<string, CreditAccount>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      initDevCustomers();
      setCustomers(getDevCustomers());
      setPriceLevels(getDevPriceLevels());
      const map = new Map<string, CreditAccount>();
      for (const c of getDevCustomers()) {
        const acc = getDevCreditAccount(c.id);
        if (acc) map.set(c.id, acc);
      }
      setCreditMap(map);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const custQ = query(collection(db, collections.customers), orderBy('memberNo', 'asc'));

    let cancelled = false;

    const unsub = onSnapshot(
      custQ,
      (snap) => {
        if (cancelled) return;
        setCustomers(
          snap.docs
            .map((d) => {
              const raw = { ...(d.data() as Customer), id: d.id };
              const contactType =
                raw.contactType ??
                (raw.priceLevelId === 'WHOLESALE1' || raw.priceLevelId === 'WHOLESALE2'
                  ? 'wholesale'
                  : 'retail');
              const totalSpent = raw.totalSpent ?? 0;
              return {
                ...raw,
                contactType,
                bankName: raw.bankName ?? null,
                bankAccount: raw.bankAccount ?? null,
                ...customerCrmFields(
                  {
                    firstName: raw.firstName ?? '',
                    lastName: raw.lastName ?? '',
                    contactType,
                    tags: raw.tags ?? [],
                    totalSpent,
                    lifetimeValue: raw.lifetimeValue,
                    lastVisitAt: raw.lastVisitAt ?? null,
                    customerType: raw.customerType,
                    name: raw.name,
                  },
                  raw.branchId ?? branchId ?? '',
                ),
                totalSpent,
                points: raw.points ?? 0,
              } as Customer;
            })
            .filter((c) => !c.deletedAt),
        );
        setLoading(false);
      },
      (err) => {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      },
    );

    void getDocs(collection(db, collections.priceLevels)).then((snap) => {
      if (cancelled) return;
      setPriceLevels(
        snap.docs
          .map((d) => ({ ...(d.data() as PriceLevel), id: d.id }))
          .sort((a, b) => a.order - b.order),
      );
    });

    if (branchId) {
      void getDocs(
        query(collection(db, collections.creditAccounts), where('branchId', '==', branchId)),
      ).then((snap) => {
        if (cancelled) return;
        const map = new Map<string, CreditAccount>();
        snap.forEach((d) => {
          const acc = d.data() as CreditAccount;
          map.set(acc.customerId, acc);
        });
        setCreditMap(map);
      });
    }

    return () => {
      cancelled = true;
      unsub();
    };
  }, [branchId]);

  const refreshDev = useCallback(() => {
    if (isFirebaseConfigured) return;
    initDevCustomers();
    setCustomers(getDevCustomers());
    const map = new Map<string, CreditAccount>();
    for (const c of getDevCustomers()) {
      const acc = getDevCreditAccount(c.id);
      if (acc) map.set(c.id, acc);
    }
    setCreditMap(map);
  }, []);

  const saveCustomer = useCallback(
    async (form: CustomerFormData, editId?: string): Promise<Customer> => {
      const fields = formToCustomerFields(form);
      const now = serverTimestamp() as Timestamp;

      if (!isFirebaseConfigured || !db) {
        initDevCustomers();
        const id = editId ?? devGenerateCustomerId();
        const existing = editId ? getDevCustomers().find((c) => c.id === editId) : null;
        const customer: Customer = {
          id,
          memberNo: existing?.memberNo ?? devGenerateMemberNo(),
          ...fields,
          ...customerCrmFields(
            {
              firstName: fields.firstName,
              lastName: fields.lastName,
              contactType: fields.contactType,
              tags: fields.tags,
              totalSpent: existing?.totalSpent ?? 0,
              lifetimeValue: existing?.lifetimeValue,
              lastVisitAt: existing?.lastVisitAt ?? null,
              customerType: fields.customerType,
              name: existing?.name,
            },
            branchId ?? '',
          ),
          totalSpent: existing?.totalSpent ?? 0,
          points: existing?.points ?? 0,
          createdAt: existing?.createdAt ?? ({ toDate: () => new Date() } as Timestamp),
          updatedAt: { toDate: () => new Date() } as Timestamp,
          deletedAt: null,
        };

        let creditAccount: CreditAccount | null = null;
        if (fields.creditLimit > 0 && branchId && fields.contactType !== 'supplier') {
          const prev = getDevCreditAccount(id);
          creditAccount = {
            customerId: id,
            branchId,
            creditLimit: fields.creditLimit,
            creditUsed: prev?.creditUsed ?? 0,
            creditBalance: fields.creditLimit - (prev?.creditUsed ?? 0),
            overdueAmt: prev?.overdueAmt ?? 0,
            lastTransAt: prev?.lastTransAt ?? null,
            updatedAt: { toDate: () => new Date() } as Timestamp,
          };
        }

        devSaveCustomer(customer, creditAccount);
        refreshDev();
        return customer;
      }

      if (editId) {
        const ref = doc(db, collections.customers, editId);
        const existingSnap = await getDoc(ref);
        const existing = existingSnap.exists() ? (existingSnap.data() as Customer) : undefined;
        const crm = customerCrmFields(
          {
            firstName: fields.firstName,
            lastName: fields.lastName,
            contactType: fields.contactType,
            tags: fields.tags,
            totalSpent: existing?.totalSpent ?? 0,
            lifetimeValue: existing?.lifetimeValue,
            lastVisitAt: existing?.lastVisitAt ?? null,
            customerType: fields.customerType,
            name: existing?.name,
          },
          branchId ?? existing?.branchId ?? '',
        );
        await updateDoc(ref, {
          ...fields,
          ...crm,
          updatedAt: now,
        });

        if (fields.creditLimit > 0 && branchId && fields.contactType !== 'supplier') {
          const credRef = doc(db, collections.creditAccounts, editId);
          const existingSnap = await getDoc(credRef);
          const existing = existingSnap.exists() ? (existingSnap.data() as CreditAccount) : undefined;
          await setDoc(
            credRef,
            {
              customerId: editId,
              branchId,
              creditLimit: fields.creditLimit,
              creditUsed: existing?.creditUsed ?? 0,
              creditBalance: fields.creditLimit - (existing?.creditUsed ?? 0),
              overdueAmt: existing?.overdueAmt ?? 0,
              updatedAt: now,
            },
            { merge: true },
          );
        }

        const updated = await getDoc(ref);
        return { ...(updated.data() as Customer), id: editId };
      }

      const id = doc(collection(db, collections.customers)).id;
      const memberNo = `M${String(Date.now()).slice(-6)}`;
      const customer: Customer = {
        id,
        memberNo,
        ...fields,
        ...customerCrmFields(
          {
            firstName: fields.firstName,
            lastName: fields.lastName,
            contactType: fields.contactType,
            tags: fields.tags,
            totalSpent: 0,
            customerType: fields.customerType,
          },
          branchId ?? '',
        ),
        totalSpent: 0,
        points: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      await setDoc(doc(db, collections.customers, id), customer);

      if (fields.creditLimit > 0 && branchId && fields.contactType !== 'supplier') {
        await setDoc(doc(db, collections.creditAccounts, id), {
          customerId: id,
          branchId,
          creditLimit: fields.creditLimit,
          creditUsed: 0,
          creditBalance: fields.creditLimit,
          overdueAmt: 0,
          lastTransAt: null,
          updatedAt: now,
        });
      }

      return customer;
    },
    [branchId, refreshDev],
  );

  const softDelete = useCallback(
    async (customerId: string): Promise<void> => {
      if (!isFirebaseConfigured || !db) {
        devSoftDeleteCustomer(customerId);
        refreshDev();
        return;
      }
      await updateDoc(doc(db, collections.customers, customerId), {
        deletedAt: serverTimestamp(),
        isActive: false,
        updatedAt: serverTimestamp(),
      });
    },
    [refreshDev],
  );

  return {
    customers,
    priceLevels,
    creditMap,
    loading,
    error,
    saveCustomer,
    softDelete,
    refreshDev,
  };
}

export async function loadCustomerOrders(customerId: string): Promise<Order[]> {
  if (!isFirebaseConfigured || !db) {
    return getDevCustomerOrders(customerId);
  }
  const snap = await getDocs(
    query(
      collection(db, collections.orders),
      where('customerId', '==', customerId),
      orderBy('createdAt', 'desc'),
    ),
  );
  return snap.docs.map((d) => ({ ...(d.data() as Order), id: d.id }));
}

export async function loadCreditTransactions(customerId: string): Promise<CreditTransaction[]> {
  if (!isFirebaseConfigured || !db) {
    return getDevCreditTransactions(customerId);
  }
  const snap = await getDocs(
    query(
      collection(db, collections.creditTransactions),
      where('customerId', '==', customerId),
      orderBy('createdAt', 'desc'),
    ),
  );
  return snap.docs.map((d) => ({ ...(d.data() as CreditTransaction), id: d.id }));
}
