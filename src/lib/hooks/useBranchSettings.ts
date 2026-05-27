import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { PaymentMethod, Settings } from '../types';

export const DEFAULT_PAYMENT_METHODS: Record<PaymentMethod, boolean> = {
  cash: true,
  qr: true,
  kbank: true,
  card: true,
  credit: true,
};

export function useBranchSettings(branchId: string | null): {
  paymentMethods: Record<PaymentMethod, boolean>;
  loading: boolean;
} {
  const [paymentMethods, setPaymentMethods] = useState(DEFAULT_PAYMENT_METHODS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!branchId) {
      setPaymentMethods(DEFAULT_PAYMENT_METHODS);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setPaymentMethods(DEFAULT_PAYMENT_METHODS);
      return;
    }

    setLoading(true);
    const ref = doc(db, collections.settings, branchId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setLoading(false);
        if (!snap.exists()) {
          setPaymentMethods(DEFAULT_PAYMENT_METHODS);
          return;
        }
        const data = snap.data() as Settings;
        setPaymentMethods({ ...DEFAULT_PAYMENT_METHODS, ...data.paymentMethods });
      },
      () => {
        setLoading(false);
        setPaymentMethods(DEFAULT_PAYMENT_METHODS);
      },
    );

    return unsub;
  }, [branchId]);

  return { paymentMethods, loading };
}
