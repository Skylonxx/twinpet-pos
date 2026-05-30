import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { applyCrmSaleLocally } from '../../lib/customers/crmService';
import { devApplyCreditCharge, devApplyCrmAfterSale } from '../../lib/customers/devMock';
import { completePosSale } from '../../lib/fifo';
import { isFirebaseConfigured } from '../../lib/firebase';
import { roundMoney } from '../../lib/money';
import { allocateDevReceiptNumber } from '../../lib/pos/billId';
import { validateCartStock } from '../../lib/pos/cartUtils';
import { applyShiftPaymentTotals, calcShiftPaymentTotals } from '../../lib/pos/shiftService';
import { devIncrementShiftTotals } from '../../lib/pos/shiftDevMock';
import type { CartLine, CartTotals, PaymentSplit, PosProduct } from '../../lib/pos/types';
import type { Shift, User } from '../../lib/types';
import type { PosCustomer } from './useCart';

export type UseCheckoutArgs = {
  user: User | null;
  branchId: string | null;
  products: PosProduct[];
  activeShift: Shift | null;
  setActiveShift: Dispatch<SetStateAction<Shift | null>>;
  showToast: (msg: string) => void;
};

/**
 * Owns the checkout side of the POS: the selected customer (incl. post-sale CRM
 * mutation), the customer-picker modal flag, the processing flag, and the
 * {@link completePosSale} call. Cart data is passed into {@link confirmSale} at
 * call time so this hook has no construction-time dependency on the cart.
 */
export function useCheckout({
  user,
  branchId,
  products,
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
      const stockErr = validateCartStock(products, cartLines);
      if (stockErr) {
        showToast(stockErr);
        throw new Error(stockErr);
      }
      setProcessing(true);
      try {
        const creditPaid = roundMoney(
          payments.filter((p) => p.method === 'credit').reduce((s, p) => s + p.amount, 0),
        );

        if (isFirebaseConfigured) {
          const saleResult = await completePosSale({
            branchId,
            staffId: user.id,
            staffName: `${user.firstName} ${user.lastName}`,
            shiftId: activeShift.id,
            lines: cartLines,
            subtotal: totals.subtotal,
            billDiscount: totals.billDiscount,
            fee: totals.fee,
            grandTotal: totals.grandTotal,
            payments,
            customerId: customer?.id ?? null,
            customerName: customer?.name ?? null,
            priceLevelId: 'RETAIL',
          });
          // Soft warning: the sale already succeeded; just notify the cashier.
          if (saleResult.hasOverdueCredit) {
            showToast('แจ้งเตือน: ลูกค้ามียอดค้างชำระเกินกำหนดเวลา (Overdue)');
          }
          setActiveShift((prev) =>
            prev ? applyShiftPaymentTotals(prev, payments, totals.grandTotal) : prev,
          );
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
          return saleResult.billId;
        }

        await new Promise((r) => window.setTimeout(r, 600));
        devIncrementShiftTotals(activeShift.id, calcShiftPaymentTotals(payments, totals.grandTotal));
        if (customer && creditPaid > 0) {
          devApplyCreditCharge(
            customer.id,
            branchId,
            creditPaid,
            `dev-${Date.now()}`,
            user.id,
          );
        }
        if (customer) {
          devApplyCrmAfterSale(customer.id, totals.grandTotal);
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
        setActiveShift((prev) =>
          prev ? applyShiftPaymentTotals(prev, payments, totals.grandTotal) : prev,
        );
        return allocateDevReceiptNumber();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
        throw err;
      } finally {
        setProcessing(false);
      }
    },
    [user, branchId, products, activeShift, customer, showToast, setActiveShift],
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
