import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ItemDiscountModal from '../components/pos/ItemDiscountModal';
import CustomerPickerModal from '../components/customers/CustomerPickerModal';
import PaymentModal from '../components/PaymentModal';
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
import { formatMoney, getLineTotal } from '../lib/pos/cartUtils';
import { getActiveShift } from '../lib/pos/shiftService';
import { priceLevelLabel, usePriceLevels } from '../lib/pricing/priceLevels';
import { POS_FEATURES } from '../lib/config/features';
import type { SuspendedBill } from '../lib/pos/suspendedBills';
import { useSuspendedBills } from '../lib/pos/useSuspendedBills';
import ProductImageThumb from '../components/products/ProductImageThumb';
import { usePosProducts } from '../lib/pos/usePosProducts';
import type { ItemDiscountType, PosProduct, UomOption } from '../lib/pos/types';
import type { Shift } from '../lib/types';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import { getActivePriceForCustomer, useCart } from '../hooks/pos/useCart';
import { useCheckout } from '../hooks/pos/useCheckout';
import './POSPage.css';


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
  const { priceLevels: customerTiers } = usePriceLevels(branchId);

  const pickerProducts = useMemo(() => products.map(posProductToPickerItem), [products]);

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [showExtraOptions, setShowExtraOptions] = useState(false);

  const [uomProduct, setUomProduct] = useState<PosProduct | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [discountLineKey, setDiscountLineKey] = useState<string | null>(null);
  const [qtyNumpadLineKey, setQtyNumpadLineKey] = useState<string | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [shiftReady, setShiftReady] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [holdNoteOpen, setHoldNoteOpen] = useState(false);
  const [suspendedListOpen, setSuspendedListOpen] = useState(false);
  const [showCashTx, setShowCashTx] = useState(false);
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [catSearch, setCatSearch] = useState('');

  const searchInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Checkout owns the customer; the cart re-prices against it. Checkout is set
  // up first so the cart can read `checkout.customer` (no circular dependency —
  // checkout receives live cart data only at `confirmSale` call time).
  const checkout = useCheckout({
    user,
    branchId,
    products,
    activeShift,
    setActiveShift,
    showToast,
  });
  const { customer } = checkout;

  const cart = useCart({ products, customer, showToast });
  const { cartLines, totals } = cart;

  const branchDisplay = branch?.name ?? (branchId ? getBranchLabel(branchId) : '—');

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

  const discountLine = discountLineKey ? cart.cart[discountLineKey] ?? null : null;

  const focusSearch = useCallback(() => {
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const onProductClick = useCallback(
    (product: PosProduct) => {
      if (product.uomOptions.length > 1) {
        setUomProduct(product);
      } else {
        cart.addToCart(product, product.uomOptions[0]!);
      }
    },
    [cart],
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
          cart.addToCart(match.product, match.option);
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
    [search, products, cart, onProductClick, focusSearch, showToast],
  );

  const clearPosCart = useCallback(() => {
    cart.clearCart();
    checkout.clearCustomer();
  }, [cart, checkout]);

  const handleNewSale = useCallback(() => {
    clearPosCart();
    setPaymentOpen(false);
    focusSearch();
  }, [clearPosCart, focusSearch]);

  const handleClearCartClick = useCallback(() => {
    if (cartLines.length === 0) return;
    if (!window.confirm('ล้างสินค้าในตะกร้าทั้งหมด?')) return;
    cart.clearCart();
    showToast('ล้างตะกร้าแล้ว');
    focusSearch();
  }, [cartLines.length, cart, focusSearch, showToast]);

  const handleHoldClick = useCallback(() => {
    if (cartLines.length === 0) {
      showToast('ไม่มีสินค้าในตะกร้า');
      return;
    }
    setHoldNoteOpen(true);
  }, [cartLines.length, showToast]);

  const handleHoldConfirm = useCallback(
    (note: string) => {
      const bill: SuspendedBill = {
        id: crypto.randomUUID(),
        note,
        cartItems: cartLines.map((line) => ({ ...line, discount: { ...line.discount } })),
        customerId: customer?.id ?? null,
        discount: cart.billDiscValue,
        createdAt: new Date().toISOString(),
        customer: customer ? { ...customer } : null,
        discountPercent: cart.billDiscPercent,
        feeRate: cart.feeRate,
        totalAmount: totals.grandTotal,
        itemCount: totals.totalQty,
      };
      addBill(bill);
      clearPosCart();
      setHoldNoteOpen(false);
      showToast('พักบิลเรียบร้อย');
      focusSearch();
    },
    [addBill, cart, cartLines, clearPosCart, customer, totals, focusSearch, showToast],
  );

  const handleRestoreBill = useCallback(
    (bill: SuspendedBill) => {
      if (cartLines.length > 0) {
        showToast('กรุณาชำระหรือพักบิลปัจจุบันก่อนเรียกคืน');
        return;
      }
      cart.restoreCart(bill);
      checkout.setCustomer(bill.customer);
      removeBill(bill.id);
      setSuspendedListOpen(false);
      showToast('เรียกคืนบิลแล้ว');
      focusSearch();
    },
    [cartLines.length, cart, checkout, removeBill, focusSearch, showToast],
  );

  const handleCashTxSuccess = useCallback(async () => {
    if (user && branchId) {
      const shift = await getActiveShift(branchId, user.id);
      setActiveShift(shift);
    }
    setShowCashTx(false);
  }, [user, branchId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user || !branchId) {
        if (!cancelled) setShiftReady(true);
        return;
      }
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
              onClick={() => setSuspendedListOpen(true)}
              disabled={suspendedCount === 0}
            >
              บิลที่พักไว้ ({suspendedCount})
            </button>
            <button
              type="button"
              className="pos-topbar-btn pos-topbar-btn--secondary"
              onClick={handleHoldClick}
              disabled={cartLines.length === 0}
            >
              พักบิล
            </button>
            <button
              type="button"
              className="pos-topbar-btn pos-topbar-btn--secondary"
              onClick={() => setShowCashTx(true)}
            >
              นำเงินเข้า/ออก
            </button>
            <button
              type="button"
              className="pos-topbar-btn pos-topbar-btn--close"
              onClick={() => setShowCloseShift(true)}
            >
              ปิดกะ
            </button>
            <button
              type="button"
              className="pos-topbar-btn pos-topbar-btn--clear"
              onClick={handleClearCartClick}
              disabled={cartLines.length === 0}
            >
              <i className="ti ti-trash" aria-hidden="true" /> ล้างตะกร้า
            </button>
          </div>
        )}
      </header>

      <div className="pos-content-row">
        <div className="pos-product-area">
          <div className="pos-cat-bar">
            <button
              type="button"
              className="pos-cat-trigger-btn"
              onClick={() => {
                setCatSearch('');
                setCatModalOpen(true);
              }}
            >
              ค้นหาหมวดหมู่ ▾
            </button>
            <button
              type="button"
              className={`pos-cat-pill${!activeCategory ? ' on' : ''}`}
              onClick={() => setActiveCategory('')}
            >
              ทั้งหมด
            </button>
            {categoryList.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`pos-cat-pill${activeCategory === cat ? ' on' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="pos-loading-overlay">กำลังโหลดสินค้า...</div>
          ) : (
            <div className="pos-product-grid">
              {filteredProducts.map((p) => {
                const qty = cart.cartQtyByProduct.get(p.id) ?? 0;
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
          <div className="pos-cust-bar">
            <div className="pos-cust-main">
            {customer ? (
              <>
                <i className="ti ti-user pos-cust-icon" aria-hidden="true" />
                <div className="pos-cust-selected">
                  <div className="pos-cust-text">
                    <span className="pos-cust-name">{customer.name}</span>
                    <span className="pos-cust-meta">
                      {priceLevelLabel(customerTiers, customer.customerType)}
                      {POS_FEATURES.enableLoyaltyPoints ? ` · ${customer.points} แต้ม` : ''}
                      {customer.outstandingBalance > 0
                        ? ` · ค้างชำระ ฿${customer.outstandingBalance.toLocaleString('th-TH')}`
                        : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="pos-cust-clear"
                    onClick={checkout.clearCustomer}
                    aria-label="ลบลูกค้า"
                  >
                    <i className="ti ti-x" aria-hidden="true" />
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="pos-cust-pick" onClick={checkout.openCustomerModal}>
                <i className="ti ti-user-plus" aria-hidden="true" />
                เลือกลูกค้า
              </button>
            )}
            </div>
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
                          onClick={() => cart.changeQty(line.lineKey, -1)}
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
                          onClick={() => cart.changeQty(line.lineKey, 1)}
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
                        onClick={() => cart.removeLine(line.lineKey)}
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
                      value={cart.billDiscValue}
                      onChange={(e) => cart.setBillDiscValue(parseFloat(e.target.value) || 0)}
                    />
                    <button
                      type="button"
                      className={`pos-disc-tog${!cart.billDiscPercent ? ' on' : ''}`}
                      onClick={() => cart.setBillDiscPercent(false)}
                    >
                      ฿
                    </button>
                    <button
                      type="button"
                      className={`pos-disc-tog${cart.billDiscPercent ? ' on' : ''}`}
                      onClick={() => cart.setBillDiscPercent(true)}
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
                        className={`pos-fee-chip${cart.feeRate === rate ? ' on' : ''}`}
                        onClick={() => cart.setFeeRate(rate)}
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
          if (uomProduct) cart.addToCart(uomProduct, opt);
          setUomProduct(null);
        }}
        onClose={() => setUomProduct(null)}
      />

      <ItemDiscountModal
        line={discountLine}
        onSave={(type: ItemDiscountType, val: number) => {
          if (!discountLineKey) return;
          cart.setLineDiscount(discountLineKey, type, val);
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
        open={checkout.customerModalOpen}
        branchId={branchId}
        onClose={() => {
          checkout.closeCustomerModal();
          focusSearch();
        }}
        onSelect={(cust) => {
          checkout.selectCustomer(cust);
          focusSearch();
        }}
      />

      <PaymentModal
        open={paymentOpen}
        branchId={branchId}
        shopName={`TwinPet — สาขา${branchDisplay}`}
        grandTotal={totals.grandTotal}
        subtotal={totals.subtotal}
        billDiscount={totals.billDiscount}
        fee={totals.fee}
        lines={cart.receiptLines}
        customerId={customer?.id ?? null}
        customerName={customer?.name ?? null}
        customerCreditLimit={customer?.creditLimit ?? 0}
        customerOutstandingBalance={customer?.outstandingBalance ?? 0}
        processing={checkout.processing}
        onClose={() => {
          if (checkout.processing) return;
          setPaymentOpen(false);
          focusSearch();
        }}
        onConfirm={(payments) => checkout.confirmSale(payments, cartLines, totals)}
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

      {catModalOpen && (
        <div
          className="pos-category-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setCatModalOpen(false)}
        >
          <div className="pos-category-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pos-category-modal-hd">
              <span>เลือกหมวดหมู่</span>
              <button
                type="button"
                className="pos-category-close"
                onClick={() => setCatModalOpen(false)}
              >
                ปิด
              </button>
            </div>
            <div className="pos-picker-search">
              <input
                placeholder="พิมพ์เพื่อค้นหาหมวดหมู่..."
                value={catSearch}
                onChange={(e) => setCatSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div className="pos-category-grid">
              {!catSearch.trim() && (
                <button
                  type="button"
                  className={`pos-category-cell${!activeCategory ? ' active' : ''}`}
                  onClick={() => {
                    setActiveCategory('');
                    setCatModalOpen(false);
                  }}
                >
                  ทั้งหมด
                </button>
              )}
              {categoryList
                .filter((cat) =>
                  cat.toLowerCase().includes(catSearch.trim().toLowerCase()),
                )
                .map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`pos-category-cell${activeCategory === cat ? ' active' : ''}`}
                    onClick={() => {
                      setActiveCategory(cat);
                      setCatModalOpen(false);
                    }}
                  >
                    {cat}
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      <NumpadDialog
        open={qtyNumpadLineKey !== null}
        title={qtyNumpadLineKey ? cart.cart[qtyNumpadLineKey]?.productName : undefined}
        initialValue={qtyNumpadLineKey ? (cart.cart[qtyNumpadLineKey]?.qty ?? 1) : 1}
        onClose={() => setQtyNumpadLineKey(null)}
        onConfirm={(qty) => {
          if (qtyNumpadLineKey && cart.setLineQty(qtyNumpadLineKey, qty)) {
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
