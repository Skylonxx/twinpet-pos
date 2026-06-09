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

/**
 * Phase 7B-3: security-first default — when the branch settings doc (or the
 * field) is missing, Staff void/reversal requires a PIN.
 */
export const DEFAULT_REQUIRES_PASSWORD_FOR_VOID = true;

export function useBranchSettings(branchId: string | null): {
  paymentMethods: Record<PaymentMethod, boolean>;
  /** Phase 7B-3: whether Staff must enter a PIN before void/reversal (default true). */
  requiresPasswordForVoid: boolean;
  loading: boolean;
} {
  const [paymentMethods, setPaymentMethods] = useState(DEFAULT_PAYMENT_METHODS);
  const [requiresPasswordForVoid, setRequiresPasswordForVoid] = useState(
    DEFAULT_REQUIRES_PASSWORD_FOR_VOID,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!branchId) {
      setPaymentMethods(DEFAULT_PAYMENT_METHODS);
      setRequiresPasswordForVoid(DEFAULT_REQUIRES_PASSWORD_FOR_VOID);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setPaymentMethods(DEFAULT_PAYMENT_METHODS);
      setRequiresPasswordForVoid(DEFAULT_REQUIRES_PASSWORD_FOR_VOID);
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
          setRequiresPasswordForVoid(DEFAULT_REQUIRES_PASSWORD_FOR_VOID);
          return;
        }
        const data = snap.data() as Settings;
        setPaymentMethods({ ...DEFAULT_PAYMENT_METHODS, ...data.paymentMethods });
        // Missing field → security-first default (true).
        setRequiresPasswordForVoid(data.requiresPasswordForVoid ?? DEFAULT_REQUIRES_PASSWORD_FOR_VOID);
      },
      () => {
        setLoading(false);
        setPaymentMethods(DEFAULT_PAYMENT_METHODS);
        setRequiresPasswordForVoid(DEFAULT_REQUIRES_PASSWORD_FOR_VOID);
      },
    );

    return unsub;
  }, [branchId]);

  return { paymentMethods, requiresPasswordForVoid, loading };
}
