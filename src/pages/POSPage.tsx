import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ItemDiscountModal from '../components/pos/ItemDiscountModal';
import CustomerPickerModal, { type PosCustomerPick } from '../components/customers/CustomerPickerModal';
import PaymentModal, { type PaymentReceiptLine } from '../components/PaymentModal';
import ProductPickerDialog, { posProductToPickerItem } from '../components/products/ProductPickerDialog';
import CashTransactionModal from '../components/pos/CashTransactionModal';
import { CloseShiftModal, OpenShiftModal } from '../components/pos/ShiftModals';
import {
  HoldBillNoteModal,
  SuspendedBillsListModal,
} from '../components/pos/SuspendedBillModals';
import NumpadDialog from '../components/pos/NumpadDialog';
import UomModal from '../components/pos/UomModal';
import { getBranchLabel } from '../lib/branches';
import { fmtBaht } from '../lib/dashboard/format';
import { completePosSale } from '../lib/fifo';
import { isFirebaseConfigured } from '../lib/firebase';
import {
  calcCartTotals,
  cartLineKey,
  formatMoney,
  getLineTotal,
  validateAddToCartStock,
  validateCartStock,
} from '../lib/pos/cartUtils';
import { allocateDevReceiptNumber } from '../lib/pos/billId';
import { DEV_CATEGORY_GRADIENTS } from '../lib/pos/devProducts';
import { applyShiftPaymentTotals, calcShiftPaymentTotals, getActiveShift } from '../lib/pos/shiftService';
import { applyCrmSaleLocally } from '../lib/customers/crmService';
import { customerTierLabel, useCustomerTiers } from '../lib/customers/customerTiers';
import { devIncrementShiftTotals } from '../lib/pos/shiftDevMock';
import { devApplyCrmAfterSale, devApplyCreditCharge } from '../lib/customers/devMock';
import { POS_FEATURES } from '../lib/config/features';
import { cartLinesToRecord } from '../lib/pos/suspendedBills';
import type { SuspendedBill } from '../lib/pos/suspendedBills';
import { useSuspendedBills } from '../lib/pos/useSuspendedBills';
import ProductImageThumb from '../components/products/ProductImageThumb';
import { usePosProducts } from '../lib/pos/usePosProducts';
import { resolvePosUnitPrice } from '../lib/pos/tierPricing';
import type { CartLine, ItemDiscountType, PosProduct, UomOption } from '../lib/pos/types';
import type { PaymentSplit } from '../lib/pos/types';
import type { Shift } from '../lib/types';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import './POSPage.css';

const CATEGORY_GRADIENTS: Record<string, string> = {
  ...DEV_CATEGORY_GRADIENTS,
  'กรายแมว': 'linear-gradient(135deg,#6B62C9,#3C3489)',
  'อาหารเสริม': 'linear-gradient(135deg,#185FA5,#0B3D6B)',
};

type PosCustomer = PosCustomerPick;

function getActivePriceForCustomer(
  product: PosProduct,
  option: UomOption,
  customer: PosCustomer | null,
): { unitPrice: number; originalPrice: number } {
  const tier = customer?.customerType?.trim() || null;
  return resolvePosUnitPrice(product, option, tier);
}

function priceChanged(a: number, b: number): boolean {
  return Math.round(a * 100) !== Math.round(b * 100);
}

function repriceCartLines(
  cart: Record<string, CartLine>,
  products: PosProduct[],
  customer: PosCustomer | null,
): Record<string, CartLine> {
  if (Object.keys(cart).length === 0) return cart;
  let changed = false;
  const next = { ...cart };
  for (const [key, line] of Object.entries(cart)) {
    const product = products.find((p) => p.id === line.productId);
    if (!product) continue;
    const option = product.uomOptions.find((o) => o.unit === line.unit);
    if (!option) continue;
    const { unitPrice, originalPrice } = getActivePriceForCustomer(product, option, customer);
    if (priceChanged(line.unitPrice, unitPrice) || priceChanged(line.originalPrice ?? 0, originalPrice)) {
      next[key] = { ...line, unitPrice, originalPrice };
      changed = true;
    }
  }
  return changed ? next : cart;
}

type ScanMatch = { product: PosProduct; option: UomOption | null };

function findByScanCode(products: PosProduct[], code: string): ScanMatch | undefined {
  const trimmed = code.trim();
  if (!trimmed) return undefined;

  for (const p of products) {
    // Top-level barcode or SKU — keep existing UomModal behaviour
    if (p.sku === trimmed || (p.barcode != null && p.barcode === trimmed)) {
      return { product: p, option: null };
    }
    // UOM-specific barcode — auto-select that unit, bypass UomModal
    const matchedOption = p.uomOptions.find(
      (o) => o.barcode != null && o.barcode === trimmed,
    );
    if (matchedOption) {
      return { product: p, option: matchedOption };
    }
  }

  return undefined;
}

export default function POSPage() {
  const { user, branchId } = useAuth();
  const { branch } = useBranch();
  const { products, categories, loading } = usePosProducts(branchId);
  const { bills: suspendedBills, count: suspendedCount, addBill, removeBill } =
    useSuspendedBills(branchId);
  const { tiers: customerTiers } = useCustomerTiers();

  const pickerProducts = useMemo(() => products.map(posProductToPickerItem), [products]);

  const [search, setSearch] = useState('');
  const [customer, setCustomer] = useState<PosCustomer | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState('');
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [billDiscValue, setBillDiscValue] = useState(0);
  const [billDiscPercent, setBillDiscPercent] = useState(false);
  const [feeRate, setFeeRate] = useState(0);
  const [showExtraOptions, setShowExtraOptions] = useState(false);

  const [uomProduct, setUomProduct] = useState<PosProduct | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [discountLineKey, setDiscountLineKey] = useState<string | null>(null);
  const [qtyNumpadLineKey, setQtyNumpadLineKey] = useState<string | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [shiftReady, setShiftReady] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [holdNoteOpen, setHoldNoteOpen] = useState(false);
  const [suspendedListOpen, setSuspendedListOpen] = useState(false);
  const [showCashTx, setShowCashTx] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const branchDisplay = branch?.name ?? (branchId ? getBranchLabel(branchId) : '—');

  const cartLines = useMemo(() => Object.values(cart), [cart]);

  const totals = useMemo(
    () => calcCartTotals(cartLines, billDiscValue, billDiscPercent, feeRate),
    [cartLines, billDiscValue, billDiscPercent, feeRate],
  );

  const receiptLines = useMemo<PaymentReceiptLine[]>(
    () =>
      cartLines.map((line) => ({
        productName: line.productName,
        sku: line.sku,
        qty: line.qty,
        unit: line.unit,
        lineTotal: getLineTotal(line),
      })),
    [cartLines],
  );

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const matchQ =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q);
      const matchCat = !activeCategory || p.category === activeCategory;
      return matchQ && matchCat;
    });
  }, [products, search, activeCategory]);

  const categoryList = useMemo(
    () => categories.filter((c) => c !== ''),
    [categories],
  );

  const cartQtyByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of cartLines) {
      map.set(line.productId, (map.get(line.productId) ?? 0) + line.qty);
    }
    return map;
  }, [cartLines]);

  const discountLine = discountLineKey ? cart[discountLineKey] ?? null : null;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const focusSearch = useCallback(() => {
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const addToCart = useCallback(
    (product: PosProduct, option: UomOption) => {
      const stockErr = validateAddToCartStock(product, option, 1, cart);
      if (stockErr) {
        showToast(stockErr);
        return;
      }
      const key = cartLineKey(product.id, option.unit);
      const { unitPrice, originalPrice } = getActivePriceForCustomer(product, option, customer);
      setCart((prev) => {
        const existing = prev[key];
        if (existing) {
          return {
            ...prev,
            [key]: { ...existing, qty: existing.qty + 1 },
          };
        }
        return {
          ...prev,
          [key]: {
            lineKey: key,
            productId: product.id,
            productName: product.name,
            category: product.category,
            sku: product.sku,
            unit: option.unit,
            unitFactor: option.factor,
            unitPrice,
            originalPrice,
            qty: 1,
            discount: { type: 'none', val: 0 },
          },
        };
      });
    },
    [customer, cart, showToast],
  );

  const onProductClick = useCallback(
    (product: PosProduct) => {
      if (product.uomOptions.length > 1) {
        setUomProduct(product);
      } else {
        addToCart(product, product.uomOptions[0]!);
      }
    },
    [addToCart],
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      const trimmed = search.trim();
      if (!trimmed) return;

      e.preventDefault();
      const match = findByScanCode(products, trimmed);
      if (match) {
        if (match.option) {
          // UOM-specific barcode: add that unit directly, no modal
          addToCart(match.product, match.option);
        } else {
          // Top-level barcode/SKU: existing flow (shows UomModal when multi-UOM)
          onProductClick(match.product);
        }
        setSearch('');
        focusSearch();
      } else {
        showToast('ไม่พบสินค้านี้');
      }
    },
    [search, products, addToCart, onProductClick, focusSearch, showToast],
  );

  const handleCustomerSelect = useCallback(
    (cust: PosCustomer) => {
      setCustomer(cust);
      setCart((prev) => repriceCartLines(prev, products, cust));
      setCustomerModalOpen(false);
      focusSearch();
    },
    [focusSearch, products],
  );

  const handleClearCustomer = useCallback(() => {
    setCustomer(null);
    setCart((prev) => repriceCartLines(prev, products, null));
  }, [products]);

  const handleCustomerModalClose = useCallback(() => {
    setCustomerModalOpen(false);
    focusSearch();
  }, [focusSearch]);

  const changeQty = useCallback(
    (lineKey: string, delta: number) => {
      setCart((prev) => {
        const line = prev[lineKey];
        if (!line) return prev;
        const qty = line.qty + delta;
        if (qty <= 0) {
          const next = { ...prev };
          delete next[lineKey];
          return next;
        }
        if (delta > 0) {
          const product = products.find((p) => p.id === line.productId);
          const option = product?.uomOptions.find((o) => o.unit === line.unit);
          if (product && option) {
            const stockErr = validateAddToCartStock(product, option, delta, prev);
            if (stockErr) {
              showToast(stockErr);
              return prev;
            }
          }
        }
        return { ...prev, [lineKey]: { ...line, qty } };
      });
    },
    [products, showToast],
  );

  const removeLine = useCallback((lineKey: string) => {
    setCart((prev) => {
      const next = { ...prev };
      delete next[lineKey];
      return next;
    });
  }, []);

  const setLineQty = useCallback(
    (lineKey: string, newQty: number): boolean => {
      const line = cart[lineKey];
      if (!line) return false;
      if (newQty <= 0) {
        removeLine(lineKey);
        return true;
      }
      if (newQty === line.qty) return true;
      const delta = newQty - line.qty;
      if (delta > 0) {
        const product = products.find((p) => p.id === line.productId);
        const option = product?.uomOptions.find((o) => o.unit === line.unit);
        if (product && option) {
          const stockErr = validateAddToCartStock(product, option, delta, cart);
          if (stockErr) {
            showToast(stockErr);
            return false;
          }
        }
      }
      setCart((prev) => {
        const current = prev[lineKey];
        if (!current) return prev;
        return { ...prev, [lineKey]: { ...current, qty: newQty } };
      });
      return true;
    },
    [cart, products, removeLine, showToast],
  );

  const handlePaymentConfirm = useCallback(
    async (payments: PaymentSplit[]): Promise<string> => {
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
        if (isFirebaseConfigured) {
          const billId = await completePosSale({
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
          setActiveShift((prev) =>
            prev ? applyShiftPaymentTotals(prev, payments, totals.grandTotal) : prev,
          );
          if (customer) {
            const creditPaid = payments
              .filter((p) => p.method === 'credit')
              .reduce((s, p) => s + p.amount, 0);
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
          return billId;
        }
        await new Promise((r) => window.setTimeout(r, 600));
        devIncrementShiftTotals(activeShift.id, calcShiftPaymentTotals(payments, totals.grandTotal));
        const creditPaid = payments
          .filter((p) => p.method === 'credit')
          .reduce((s, p) => s + p.amount, 0);
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
    [user, branchId, cartLines, totals, customer, showToast, activeShift, products],
  );

  const handleCashTxSuccess = useCallback(async () => {
    if (user && branchId) {
      const shift = await getActiveShift(branchId, user.id);
      setActiveShift(shift);
    }
    setShowCashTx(false);
  }, [user, branchId]);

  const clearPosCart = useCallback(() => {
    setCart({});
    setBillDiscValue(0);
    setBillDiscPercent(false);
    setFeeRate(0);
    setCustomer(null);
  }, []);

  const handleNewSale = useCallback(() => {
    clearPosCart();
    setPaymentOpen(false);
    focusSearch();
  }, [clearPosCart, focusSearch]);

  const handleClearCartClick = useCallback(() => {
    if (cartLines.length === 0) return;
    if (!window.confirm('ล้างสินค้าในตะกร้าทั้งหมด?')) return;
    setCart({});
    setBillDiscValue(0);
    setBillDiscPercent(false);
    setFeeRate(0);
    showToast('ล้างตะกร้าแล้ว');
    focusSearch();
  }, [cartLines.length, focusSearch, showToast]);

  const handleHoldClick = useCallback(() => {
    if (cartLines.length === 0) {
      showToast('ไม่มีสินค้าในตะกร้า');
      return;
    }
    setHoldNoteOpen(true);
  }, [cartLines.length, showToast]);

  const handleHoldConfirm = useCallback(
    (note: string) => {
      const totalsNow = calcCartTotals(
        cartLines,
        billDiscValue,
        billDiscPercent,
        feeRate,
      );
      const bill: SuspendedBill = {
        id: crypto.randomUUID(),
        note,
        cartItems: cartLines.map((line) => ({ ...line, discount: { ...line.discount } })),
        customerId: customer?.id ?? null,
        discount: billDiscValue,
        createdAt: new Date().toISOString(),
        customer: customer ? { ...customer } : null,
        discountPercent: billDiscPercent,
        feeRate,
        totalAmount: totalsNow.grandTotal,
        itemCount: totalsNow.totalQty,
      };
      addBill(bill);
      clearPosCart();
      setHoldNoteOpen(false);
      showToast('พักบิลเรียบร้อย');
      focusSearch();
    },
    [
      addBill,
      billDiscPercent,
      billDiscValue,
      cartLines,
      clearPosCart,
      customer,
      feeRate,
      focusSearch,
      showToast,
    ],
  );

  const handleRestoreBill = useCallback(
    (bill: SuspendedBill) => {
      if (cartLines.length > 0) {
        showToast('กรุณาชำระหรือพักบิลปัจจุบันก่อนเรียกคืน');
        return;
      }
      setCart(cartLinesToRecord(bill.cartItems));
      setCustomer(bill.customer);
      setBillDiscValue(bill.discount);
      setBillDiscPercent(bill.discountPercent);
      setFeeRate(bill.feeRate);
      removeBill(bill.id);
      setSuspendedListOpen(false);
      showToast('เรียกคืนบิลแล้ว');
      focusSearch();
    },
    [cartLines.length, focusSearch, removeBill, showToast],
  );

  useEffect(() => {
    setCart((prev) => repriceCartLines(prev, products, customer));
  }, [customer, products]);

  useEffect(() => {
    if (!user || !branchId) {
      setShiftReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const shift = await getActiveShift(branchId, user.id);
        if (!cancelled) setActiveShift(shift);
      } finally {
        if (!cancelled) setShiftReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, branchId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        if (cartLines.length > 0 && activeShift) setPaymentOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cartLines.length, activeShift]);

  return (
    <div className="pos-page">
      <header className="pos-topbar">
        <div className="pos-search-group">
          <div className="pos-topbar-search">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              id="pos-search"
              ref={searchInputRef}
              autoFocus
              placeholder="ค้นหา name/serial/barcode (Ctrl+f)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <button
            type="button"
            className="pos-add-prod-btn"
            onClick={() => setPickerOpen(true)}
          >
            <i className="ti ti-plus" aria-hidden="true" /> เลือกสินค้า
          </button>
        </div>
        {activeShift && (
          <div className="pos-topbar-actions">
            <button
              type="button"
              className="pos-topbar-btn pos-topbar-btn--secondary"
              onClick={() => setShowCashTx(true)}
            >
              💵 นำเงินเข้า/ออก
            </button>
            <button
              type="button"
              className="pos-topbar-btn pos-topbar-btn--close"
              onClick={() => setShowCloseShift(true)}
            >
              🔒 ปิดกะ
            </button>
          </div>
        )}
      </header>

      <div className="pos-content-row">
        <div className="pos-product-area">
          <div className="pos-cat-bar">
            <button
              type="button"
              className={`pos-cat-pill${!activeCategory ? ' on' : ''}`}
              style={
                !activeCategory
                  ? { background: 'var(--p600)', color: 'white' }
                  : undefined
              }
              onClick={() => setActiveCategory('')}
            >
              ทั้งหมด
            </button>
            {categoryList.map((cat) => {
              const gradient = CATEGORY_GRADIENTS[cat];
              const isOn = activeCategory === cat;
              if (gradient) {
                return (
                  <button
                    key={cat}
                    type="button"
                    className={`pos-cat-pill has-bg${isOn ? ' on' : ''}`}
                    onClick={() => setActiveCategory(cat)}
                  >
                    <span className="pos-cat-bg" style={{ background: gradient }} />
                    <span className="pos-cat-overlay" />
                    <span className="pos-cat-text">{cat}</span>
                  </button>
                );
              }
              return (
                <button
                  key={cat}
                  type="button"
                  className={`pos-cat-pill${isOn ? ' on' : ''}`}
                  style={
                    isOn
                      ? { background: 'var(--p600)', color: 'white' }
                      : undefined
                  }
                  onClick={() => setActiveCategory(cat)}
                >
                  {cat}
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="pos-loading-overlay">กำลังโหลดสินค้า...</div>
          ) : (
            <div className="pos-product-grid">
              {filteredProducts.map((p) => {
                const qty = cartQtyByProduct.get(p.id) ?? 0;
                const baseOption = p.uomOptions[0];
                const displayPrice = baseOption
                  ? getActivePriceForCustomer(p, baseOption, customer).unitPrice
                  : 0;
                return (
                  <div key={p.id} className="pos-prod-wrap">
                    <button
                      type="button"
                      className={`pos-prod-card${qty > 0 ? ' in-cart' : ''}`}
                      onClick={() => onProductClick(p)}
                    >
                      <ProductImageThumb imageUrl={p.imageUrl} alt={p.name} variant="pos" className="pos-prod-img" />
                      <div className="pos-prod-info">
                        <div className="pos-prod-name">{p.name}</div>
                        <div className="pos-prod-bottom">
                          <span className="pos-prod-price">฿{formatMoney(displayPrice)}</span>
                          <span className="pos-prod-stock">{p.stock}</span>
                        </div>
                      </div>
                    </button>
                    {qty > 0 && <div className="pos-cart-badge">{qty}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <aside className="pos-cart">
          <div className="pos-cart-hd">
            <div className="pos-cart-hd-actions">
              <button
                type="button"
                className="pos-suspended-btn"
                onClick={() => setSuspendedListOpen(true)}
                disabled={suspendedCount === 0}
              >
                บิลที่พักไว้ ({suspendedCount})
              </button>
              <button
                type="button"
                className="pos-hold-btn"
                onClick={handleHoldClick}
                disabled={cartLines.length === 0}
              >
                <i className="ti ti-clock-pause" style={{ fontSize: 11 }} aria-hidden="true" />{' '}
                พักบิล
              </button>
              <button
                type="button"
                className="pos-cart-clear-btn"
                onClick={handleClearCartClick}
                disabled={cartLines.length === 0}
                aria-label="ล้างตะกร้า"
                title="ล้างตะกร้า"
              >
                <i className="ti ti-trash-x" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="pos-cust-bar">
            {customer ? (
              <>
                <i className="ti ti-user pos-cust-icon" aria-hidden="true" />
                <div className="pos-cust-selected">
                  <div className="pos-cust-text">
                    <span className="pos-cust-name">{customer.name}</span>
                    <span className="pos-cust-meta">
                      {customerTierLabel(customerTiers, customer.customerType)}
                      {POS_FEATURES.enableLoyaltyPoints ? ` · ${customer.points} แต้ม` : ''}
                      {customer.outstandingBalance > 0
                        ? ` · ค้างชำระ ฿${customer.outstandingBalance.toLocaleString('th-TH')}`
                        : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="pos-cust-clear"
                    onClick={handleClearCustomer}
                    aria-label="ลบลูกค้า"
                  >
                    <i className="ti ti-x" aria-hidden="true" />
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="pos-cust-pick" onClick={() => setCustomerModalOpen(true)}>
                <i className="ti ti-user-plus" aria-hidden="true" />
                เลือกลูกค้า
              </button>
            )}
          </div>

          <div className="pos-cart-items">
            {cartLines.length === 0 ? (
              <div className="pos-cart-empty">ยังไม่มีสินค้า</div>
            ) : (
              cartLines.map((line) => {
                const finalPrice = getLineTotal(line);
                const hasDisc = line.discount.type !== 'none';
                const hasTierDisc =
                  line.originalPrice != null && line.originalPrice > line.unitPrice;
                return (
                  <div key={line.lineKey} className="pos-ci">
                    <div className="pos-ci-name">
                      {line.productName}
                      {line.unit !== 'ชิ้น' && (
                        <span className="pos-ci-uom">{line.unit}</span>
                      )}
                      {hasDisc && <span className="pos-ci-disc-tag">มีส่วนลด</span>}
                      {hasTierDisc && !hasDisc && (
                        <span className="pos-ci-tier-tag">ราคาสมาชิก</span>
                      )}
                    </div>

                    <div className="pos-ci-price-bar">
                      <div className="pos-ci-price-row">
                        {hasTierDisc && (
                          <del className="pos-ci-orig-price">
                            {fmtBaht(line.originalPrice!, { decimals: 2 })}
                          </del>
                        )}
                        <span
                          className={
                            hasTierDisc ? 'pos-ci-tier-unit' : 'pos-ci-unit-at'
                          }
                        >
                          @ {fmtBaht(line.unitPrice, { decimals: 2 })}
                        </span>
                      </div>
                      <div className={`pos-ci-line-total${hasDisc ? ' has-disc' : ''}`}>
                        {fmtBaht(finalPrice, { decimals: 2 })}
                      </div>
                    </div>

                    <div className="pos-ci-toolbar">
                      <div className="pos-ci-qty-group">
                        <button
                          type="button"
                          className="pos-ci-qty-seg"
                          onClick={() => changeQty(line.lineKey, -1)}
                          aria-label="ลดจำนวน"
                        >
                          <i className="ti ti-minus" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="pos-ci-qty-val"
                          onClick={() => setQtyNumpadLineKey(line.lineKey)}
                          aria-label={`จำนวน ${line.qty} — แตะเพื่อแก้ไข`}
                        >
                          {line.qty}
                        </button>
                        <button
                          type="button"
                          className="pos-ci-qty-seg"
                          onClick={() => changeQty(line.lineKey, 1)}
                          aria-label="เพิ่มจำนวน"
                        >
                          <i className="ti ti-plus" aria-hidden="true" />
                        </button>
                      </div>
                      <button
                        type="button"
                        className="pos-ci-icon-btn"
                        onClick={() => setDiscountLineKey(line.lineKey)}
                        aria-label="แก้ไขราคา / ส่วนลด"
                      >
                        <i className="ti ti-pencil" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="pos-ci-icon-btn pos-ci-icon-btn--danger"
                        onClick={() => removeLine(line.lineKey)}
                        aria-label="ลบ"
                      >
                        <i className="ti ti-trash" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <footer className="pos-cart-footer">
            <button
              type="button"
              className="pos-cf-extra-toggle"
              onClick={() => setShowExtraOptions((prev) => !prev)}
            >
              <span>
                {showExtraOptions ? 'ซ่อนส่วนลด / ค่าธรรมเนียม' : 'เพิ่มส่วนลด / ค่าธรรมเนียม'}
              </span>
              <i
                className={`ti ti-chevron-${showExtraOptions ? 'up' : 'down'}`}
                aria-hidden="true"
              />
            </button>
            {showExtraOptions && (
              <>
                <div className="pos-cf-row">
                  <span className="pos-cf-lbl">ลดท้ายบิล</span>
                  <div className="pos-disc-row">
                    <input
                      className="pos-disc-inp"
                      type="number"
                      min={0}
                      value={billDiscValue}
                      onChange={(e) => setBillDiscValue(parseFloat(e.target.value) || 0)}
                    />
                    <button
                      type="button"
                      className={`pos-disc-tog${!billDiscPercent ? ' on' : ''}`}
                      onClick={() => setBillDiscPercent(false)}
                    >
                      ฿
                    </button>
                    <button
                      type="button"
                      className={`pos-disc-tog${billDiscPercent ? ' on' : ''}`}
                      onClick={() => setBillDiscPercent(true)}
                    >
                      %
                    </button>
                  </div>
                </div>
                <div className="pos-cf-row">
                  <span className="pos-cf-lbl">ค่าธรรมเนียม</span>
                  <div className="pos-fee-chips">
                    {([0, 1, 3] as const).map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        className={`pos-fee-chip${feeRate === rate ? ' on' : ''}`}
                        onClick={() => setFeeRate(rate)}
                      >
                        {rate === 0 ? 'ไม่มี' : `${rate}%`}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            <div className="pos-cf-row">
              <span className="pos-cf-lbl">รวม</span>
              <span className="pos-cf-val">฿{formatMoney(totals.subtotal)}</span>
            </div>
            {totals.billDiscount > 0 && (
              <div className="pos-cf-row">
                <span className="pos-cf-lbl">ส่วนลด</span>
                <span className="pos-cf-val" style={{ color: '#1d9e75' }}>
                  -฿{formatMoney(totals.billDiscount)}
                </span>
              </div>
            )}
            {totals.fee > 0 && (
              <div className="pos-cf-row">
                <span className="pos-cf-lbl">ค่าธรรมเนียม</span>
                <span className="pos-cf-val" style={{ color: '#ba7517' }}>
                  ฿{formatMoney(totals.fee)}
                </span>
              </div>
            )}
            <div className="pos-grand-row">
              <span className="pos-gt-lbl">รวมสุทธิ</span>
              <span className="pos-gt-val">฿{formatMoney(totals.grandTotal)}</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--g400)', textAlign: 'right' }}>
              {totals.itemCount} รายการ | {totals.totalQty} ชิ้น
            </div>
            <button
              type="button"
              className="pos-checkout-btn"
              disabled={cartLines.length === 0 || !activeShift}
              onClick={() => setPaymentOpen(true)}
            >
              <i className="ti ti-cash" aria-hidden="true" /> ชำระเงิน (F12)
            </button>
          </footer>
        </aside>
      </div>

      <UomModal
        product={uomProduct}
        onSelect={(opt) => {
          if (uomProduct) addToCart(uomProduct, opt);
          setUomProduct(null);
        }}
        onClose={() => setUomProduct(null)}
      />

      <ItemDiscountModal
        line={discountLine}
        onSave={(type: ItemDiscountType, val: number) => {
          if (!discountLineKey) return;
          setCart((prev) => {
            const line = prev[discountLineKey];
            if (!line) return prev;
            return {
              ...prev,
              [discountLineKey]: { ...line, discount: { type, val } },
            };
          });
        }}
        onClose={() => setDiscountLineKey(null)}
      />

      <ProductPickerDialog
        open={pickerOpen}
        products={pickerProducts}
        onConfirm={(selected) => {
          for (const item of selected) {
            const product = products.find((p) => p.id === item.id);
            if (product) onProductClick(product);
          }
        }}
        onClose={() => setPickerOpen(false)}
      />

      <CustomerPickerModal
        open={customerModalOpen}
        branchId={branchId}
        onClose={handleCustomerModalClose}
        onSelect={handleCustomerSelect}
      />

      <PaymentModal
        open={paymentOpen}
        branchId={branchId}
        shopName={`TwinPet — สาขา${branchDisplay}`}
        grandTotal={totals.grandTotal}
        subtotal={totals.subtotal}
        billDiscount={totals.billDiscount}
        fee={totals.fee}
        lines={receiptLines}
        customerId={customer?.id ?? null}
        customerName={customer?.name ?? null}
        customerCreditLimit={customer?.creditLimit ?? 0}
        customerOutstandingBalance={customer?.outstandingBalance ?? 0}
        processing={processing}
        onClose={() => {
          if (processing) return;
          setPaymentOpen(false);
          focusSearch();
        }}
        onConfirm={handlePaymentConfirm}
        onNewSale={handleNewSale}
      />

      {shiftReady && !activeShift && user && branchId && (
        <OpenShiftModal
          branchId={branchId}
          staffId={user.id}
          staffName={`${user.firstName} ${user.lastName}`}
          onSuccess={setActiveShift}
        />
      )}

      {showCashTx && activeShift && (
        <CashTransactionModal
          shift={activeShift}
          onClose={() => setShowCashTx(false)}
          onSuccess={() => void handleCashTxSuccess()}
        />
      )}

      {showCloseShift && activeShift && (
        <CloseShiftModal
          shift={activeShift}
          onClose={() => setShowCloseShift(false)}
          onSuccess={() => {
            setActiveShift(null);
            setShowCloseShift(false);
            handleNewSale();
          }}
        />
      )}

      <HoldBillNoteModal
        open={holdNoteOpen}
        onClose={() => setHoldNoteOpen(false)}
        onConfirm={handleHoldConfirm}
      />

      <SuspendedBillsListModal
        open={suspendedListOpen}
        bills={suspendedBills}
        onClose={() => setSuspendedListOpen(false)}
        onRestore={handleRestoreBill}
      />

      <NumpadDialog
        open={qtyNumpadLineKey !== null}
        title={qtyNumpadLineKey ? cart[qtyNumpadLineKey]?.productName : undefined}
        initialValue={qtyNumpadLineKey ? (cart[qtyNumpadLineKey]?.qty ?? 1) : 1}
        onClose={() => setQtyNumpadLineKey(null)}
        onConfirm={(qty) => {
          if (qtyNumpadLineKey && setLineQty(qtyNumpadLineKey, qty)) {
            setQtyNumpadLineKey(null);
          }
        }}
      />

      {toast && (
        <div className="pos-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
