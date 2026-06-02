import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { applyCrmSaleLocally } from '../../lib/customers/crmService';
import { devApplyCreditCharge, devApplyCrmAfterSale } from '../../lib/customers/devMock';
import { isFirebaseConfigured } from '../../lib/firebase';
import { roundMoney } from '../../lib/money';
import { submitAsyncOrder } from '../../lib/pos/asyncCheckout';
import { applyShiftPaymentTotals, calcShiftPaymentTotals } from '../../lib/pos/shiftService';
import { devIncrementShiftTotals } from '../../lib/pos/shiftDevMock';
import type { CartLine, CartTotals, PaymentSplit } from '../../lib/pos/types';
import type { Shift, User } from '../../lib/types';
import { RETAIL_PRICE_LEVEL_ID } from '../../lib/types';
import type { PosCustomer } from './useCart';

export type UseCheckoutArgs = {
  user: User | null;
  branchId: string | null;
  activeShift: Shift | null;
  setActiveShift: Dispatch<SetStateAction<Shift | null>>;
  showToast: (msg: string) => void;
};

/**
 * Owns the checkout side of the POS: the selected customer (incl. post-sale CRM
 * mutation), the customer-picker modal flag, the processing flag, and the
 * offline-first {@link submitAsyncOrder} call. Cart data is passed into
 * {@link confirmSale} at call time so this hook has no construction-time
 * dependency on the cart.
 */
export function useCheckout({
  user,
  branchId,
  activeShift,
  setActiveShift,
  showToast,
}: UseCheckoutArgs) {
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [processing, setProcessing] = useState(false);

  const openCustomerModal = useCallback(() => setCustomerModalOpen(true), []);
  const closeCustomerModal = useCallback(() => setCustomerModalOpen(false), []);

  const selectCustomer = useCallback((cust: PosCustomer) => {
    setCustomer(cust);
    setCustomerModalOpen(false);
  }, []);

  const clearCustomer = useCallback(() => setCustomer(null), []);

  const confirmSale = useCallback(
    async (
      payments: PaymentSplit[],
      cartLines: CartLine[],
      totals: CartTotals,
    ): Promise<string> => {
      if (!user || !branchId || cartLines.length === 0 || !activeShift) {
        throw new Error('ไม่สามารถบันทึกการขายได้');
      }
      // Offline-first: NO stock block and NO transaction. We never refuse a sale
      // for being offline or short on (snapshot) stock — oversell is tolerated and
      // reconciled server-side. "Don't block the customer's truck."
      setProcessing(true);
      try {
        const creditPaid = roundMoney(
          payments.filter((p) => p.method === 'credit').reduce((s, p) => s + p.amount, 0),
        );

        // Write the sale intent and return immediately (durably queued by
        // persistentLocalCache; settled later by the reconcileOrder function).
        const { billId } = submitAsyncOrder({
          branchId,
          staffId: user.id,
          staffName: `${user.firstName} ${user.lastName}`,
          shiftId: activeShift.id,
          lines: cartLines,
          totals,
          billDiscount: totals.billDiscount,
          fee: totals.fee,
          payments,
          customerId: customer?.id ?? null,
          customerName: customer?.name ?? null,
          priceLevelId: RETAIL_PRICE_LEVEL_ID,
        });

        // Optimistic local roll-ups so the on-screen shift + customer reflect the
        // sale instantly (incl. offline). The server reconciles authoritatively.
        setActiveShift((prev) =>
          prev ? applyShiftPaymentTotals(prev, payments, totals.grandTotal) : prev,
        );

        if (!isFirebaseConfigured) {
          // Dev (no Firebase): keep the local mock stores in sync.
          devIncrementShiftTotals(
            activeShift.id,
            calcShiftPaymentTotals(payments, totals.grandTotal),
          );
          if (customer && creditPaid > 0) {
            devApplyCreditCharge(customer.id, branchId, creditPaid, `dev-${Date.now()}`, user.id);
          }
          if (customer) devApplyCrmAfterSale(customer.id, totals.grandTotal);
        }

        if (customer) {
          setCustomer((prev) => {
            if (!prev) return prev;
            const updated = applyCrmSaleLocally(
              {
                lifetimeValue: prev.lifetimeValue,
                totalSpent: prev.lifetimeValue,
                points: prev.points,
              },
              totals.grandTotal,
            );
            return {
              ...prev,
              lifetimeValue: updated.lifetimeValue,
              points: updated.points,
              outstandingBalance:
                creditPaid > 0 ? prev.outstandingBalance + creditPaid : prev.outstandingBalance,
            };
          });
        }

        // Subtle "saved locally" confirmation when offline — NOT an error.
        if (isFirebaseConfigured && typeof navigator !== 'undefined' && navigator.onLine === false) {
          showToast('บันทึกการขายในเครื่องแล้ว · จะซิงก์อัตโนมัติเมื่อออนไลน์');
        }

        return billId;
      } finally {
        setProcessing(false);
      }
    },
    [user, branchId, activeShift, customer, setActiveShift, showToast],
  );

  return {
    customer,
    setCustomer,
    selectCustomer,
    clearCustomer,
    customerModalOpen,
    openCustomerModal,
    closeCustomerModal,
    processing,
    confirmSale,
  };
}
