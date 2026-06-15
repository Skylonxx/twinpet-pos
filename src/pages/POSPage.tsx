import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from 'flowbite-react';
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
import SortingSettingsModal from '../components/pos/SortingSettingsModal';
import DestructiveConfirmModal from '../components/common/DestructiveConfirmModal';
import { getBranchLabel } from '../lib/branches';
import { fmtBaht } from '../lib/dashboard/format';
import { formatMoney, getLineTotal } from '../lib/pos/cartUtils';
import { getActiveShift } from '../lib/pos/shiftService';
import { priceLevelLabel, usePriceLevels } from '../lib/pricing/priceLevels';
import { POS_FEATURES } from '../lib/config/features';
import type { SuspendedBill } from '../lib/pos/suspendedBills';
import { useSuspendedBills } from '../lib/pos/useSuspendedBills';
import ProductImageThumb from '../components/products/ProductImageThumb';
import { usePosInventory } from '../hooks/pos/usePosInventory';
import { usePosSyncSignal } from '../hooks/pos/usePosSyncSignal';
import SyncIndicator from '../components/pos/SyncIndicator';
import { refreshReceiptConfigCache } from '../lib/pos/billId';
import {
  BEST_SELLERS_KEY,
  getVisibleCategories,
  resolveActiveCategory,
  sortCategories,
  sortProductsByCustomOrder,
} from '../lib/pos/categoryService';
import type { ItemDiscountType, PosProduct, UomOption } from '../lib/pos/types';
import type { Shift, ProductCategory, ShiftCashEntry } from '../lib/types';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import { useLocalLedger } from '../lib/hooks/useLocalLedger';
import { deriveShiftDrawer } from '../lib/pos/shiftLedger';
import { isFirebaseConfigured } from '../lib/firebase';
import { getActivePriceForCustomer, useCart } from '../hooks/pos/useCart';
import { useCheckout } from '../hooks/pos/useCheckout';
import './POSPage.css';


type ScanMatch = { product: PosProduct; option: UomOption | null };

function findByScanCode(products: PosProduct[], code: string): ScanMatch | undefined {
  const trimmed = code.trim();
  if (!trimmed) return undefined;

  for (const p of products) {
    // SKU is a product-level identifier (never a packaging-unit barcode) — keep the existing
    // UomModal behaviour so a multi-UOM product still prompts for the unit on an SKU scan.
    if (p.sku === trimmed) {
      return { product: p, option: null };
    }
    // A specific packaging-unit / UOM barcode wins next: resolve that exact unit and BYPASS the
    // UomModal (Phase 7C-D4-D Fix 1). The base unit's barcode mirrors the product's top-level
    // `barcode` (see posProductMapper.buildUomOptions), so a scanned product/base barcode now
    // lands here and adds the base unit directly instead of re-opening the unit picker.
    const matchedOption = p.uomOptions.find(
      (o) => o.barcode != null && o.barcode === trimmed,
    );
    if (matchedOption) {
      return { product: p, option: matchedOption };
    }
    // A product-level barcode not tied to any unit (e.g. no UOM barcodes configured) — fall
    // back to the existing UomModal behaviour.
    if (p.barcode != null && p.barcode === trimmed) {
      return { product: p, option: null };
    }
  }

  return undefined;
}

export default function POSPage() {
  const { user, branchId } = useAuth();
  const { branch } = useBranch();
  // Static, pull-based inventory: the grid no longer reacts to live Firestore
  // edits (no mid-sale reshuffle). A fresh snapshot loads on mount; the cashier
  // pulls updates on demand via the "อัปเดตข้อมูลหน้าจอ" button (refreshInventory).
  const {
    products,
    categories,
    richCategories,
    sorting,
    quickMenus,
    fromCache,
    loading,
    refreshing,
    error,
    refreshInventory,
  } = usePosInventory(branchId);
  const { bills: suspendedBills, count: suspendedCount, addBill, removeBill } =
    useSuspendedBills(branchId);
  const { priceLevels: customerTiers } = usePriceLevels(branchId);

  const pickerProducts = useMemo(() => products.map(posProductToPickerItem), [products]);

  const [search, setSearch] = useState('');
  // UI-10: the ⭐ best-sellers tab is the first/default active tab. The legacy All
  // tab — previously the empty-string sentinel — is removed, so `BEST_SELLERS_KEY`
  // is the canonical default here instead of ''.
  const [activeCategory, setActiveCategory] = useState<string>(BEST_SELLERS_KEY);
  // Selected Quick Menu (virtual category). Mutually exclusive with a physical
  // category tab — selecting one clears the other.
  const [activeQuickMenuId, setActiveQuickMenuId] = useState<string | null>(null);
  const [showExtraOptions, setShowExtraOptions] = useState(false);

  const [uomProduct, setUomProduct] = useState<PosProduct | null>(null);
  // Pending multi-UOM products waiting for unit selection AFTER the one currently shown
  // (Phase 7C-L1 / LOGIC-01). `uomProduct` is a single display slot, so a batch selection of
  // several multi-UOM products used to overwrite it (only the last survived). They are now
  // enqueued here in selection order and drained one-at-a-time into `uomProduct`.
  const [uomQueue, setUomQueue] = useState<PosProduct[]>([]);
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
  const [isSortingModalOpen, setIsSortingModalOpen] = useState(false);
  // Bill-discount numpad (Phase 7C-D4-D Fix 2): drives the custom on-screen numpad opened by
  // tapping the bill-discount field, so touch terminals don't fall back to the native keyboard.
  const [discNumpadOpen, setDiscNumpadOpen] = useState(false);

  type ConfirmModalPayload = { type: 'clearCart' } | { type: 'cancelParkedOrder'; bill: SuspendedBill };
  const [confirmModalState, setConfirmModalState] = useState<{ open: boolean; payload?: ConfirmModalPayload }>({ open: false });

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
    activeShift,
    setActiveShift,
    showToast,
  });
  const { customer } = checkout;

  const cart = useCart({ products, customer, showToast });
  const { cartLines, totals } = cart;

  // Drawer single-writer: the terminal owns its shift totals by folding its own
  // local ledger of `asyncOrders`. The stored shift doc's `expected*` fields are
  // ignored online (the reconciler no longer maintains them); we derive them live
  // — instantly, offline-safe — from the ledger for the active shift. Dev (no
  // Firebase) keeps using the mock shift store, which the dev path still updates.
  const localLedger = useLocalLedger(branchId);
  const drawerShift = useMemo(() => {
    if (!activeShift) return null;
    if (!isFirebaseConfigured) return activeShift;
    const shiftSales = localLedger.filter((s) => s.shiftId === activeShift.id);
    return deriveShiftDrawer(activeShift, shiftSales);
  }, [activeShift, localLedger]);

  // ── Admin Broadcast → Smart Auto-Sync ──────────────────────────────────────
  // One cheap listener on the branch's sync_state doc. When the admin "rings the
  // bell": if the cart is empty, pull fresh inventory immediately; if a sale is
  // in progress, surface a sticky banner and defer the refresh until checkout
  // clears the cart or the cashier opts in — so prices never shift mid-sale.
  const { lastForceUpdate, initialized: syncInitialized } = usePosSyncSignal(branchId);
  const [updateBanner, setUpdateBanner] = useState(false);
  // Broadcast timestamp already reflected on screen. Seeded from the listener's
  // first emission so a signal that pre-dates mount is never treated as fresh.
  const syncedStampRef = useRef<number | null>(null);
  const baselineSetRef = useRef(false);

  /** Pull fresh data and acknowledge the pending signal (banner + normal button). */
  const handleManualRefresh = useCallback(() => {
    syncedStampRef.current = lastForceUpdate;
    setUpdateBanner(false);
    void refreshInventory();
  }, [lastForceUpdate, refreshInventory]);

  useEffect(() => {
    if (!syncInitialized) return;
    // First emission establishes the baseline (even if null) — never a refresh.
    if (!baselineSetRef.current) {
      baselineSetRef.current = true;
      syncedStampRef.current = lastForceUpdate;
      return;
    }
    if (lastForceUpdate == null) return;
    // Ignore anything not strictly newer than what the grid already reflects.
    if (syncedStampRef.current != null && lastForceUpdate <= syncedStampRef.current) return;
    if (cartLines.length === 0) {
      // No sale in progress — swap data instantly.
      syncedStampRef.current = lastForceUpdate;
      setUpdateBanner(false);
      void refreshInventory();
    } else {
      // Sale in progress — defer; the cashier reloads via the banner, or the
      // empty-cart branch above fires automatically once checkout clears it.
      setUpdateBanner(true);
    }
  }, [syncInitialized, lastForceUpdate, cartLines.length, refreshInventory]);

  const branchDisplay = branch?.name ?? (branchId ? getBranchLabel(branchId) : '—');
  // This terminal's branch — drives all branch-scoped ordering & visibility.
  const posBranchId = branchId ?? '';

  // Active (admin-enabled) Quick Menus, strictly ordered by their `order` field
  // so the POS tab sequence always matches the admin's arrangement.
  const activeQuickMenus = useMemo(
    () => quickMenus.filter((m) => m.isActive).sort((a, b) => a.order - b.order),
    [quickMenus],
  );

  const selectCategory = useCallback((catId: string) => {
    setActiveQuickMenuId(null);
    setActiveCategory(catId);
  }, []);

  const selectQuickMenu = useCallback((id: string) => {
    // Park the physical-category selection on the best-sellers default (never '' —
    // the All tab is gone) so deselecting the quick menu lands back on ⭐ สินค้าขายดี.
    setActiveCategory(BEST_SELLERS_KEY);
    setActiveQuickMenuId(id);
  }, []);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchesSearch = (p: PosProduct) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      (p.barcode ?? '').toLowerCase().includes(q);

    // Quick Menu (virtual category): show ONLY its hand-picked products, strictly
    // in the `productIds` sequence. The self-healing reader drops ghost ids. The
    // physical-category and visibility filters intentionally do NOT apply — these
    // are deliberately curated shortcuts (often to otherwise-hidden SKUs).
    if (activeQuickMenuId) {
      const menu = activeQuickMenus.find((m) => m.id === activeQuickMenuId);
      if (!menu) return [];
      const idSet = new Set(menu.productIds);
      const scoped = products.filter((p) => idSet.has(p.id) && matchesSearch(p));
      return sortProductsByCustomOrder(scoped, menu.productIds);
    }

    // Hidden products are revealed only by an EXACT identifier match typed by a
    // clerk (hardware scans bypass this filter entirely via findByScanCode).
    const isExactCodeMatch = (p: PosProduct) =>
      q.length > 0 &&
      (p.sku.toLowerCase() === q ||
        p.name.toLowerCase() === q ||
        (p.barcode ?? '').toLowerCase() === q);

    const filtered = products.filter((p) => {
      if (p.branchSettings?.[posBranchId]?.isVisibleInPos === false) {
        // Hidden for THIS branch: excluded from category grids and the virtual
        // best-sellers tab unless explicitly summoned by exact SKU/name/barcode.
        return isExactCodeMatch(p);
      }
      // UI-10: the ⭐ สินค้าขายดี tab filters to best-seller MEMBERSHIP only
      // (`PosProduct.isBestSeller === true`, projected from the global product flag).
      // `sorting['best-sellers']` stays ORDERING-only and is applied below. While the
      // cashier is actively typing (q non-empty), search transcends the tab so ANY
      // product is still findable from the default tab (matches the old All-tab reach);
      // idle shows only the curated best-sellers.
      if (activeCategory === BEST_SELLERS_KEY) {
        return q ? matchesSearch(p) : p.isBestSeller === true;
      }
      const matchCat = !activeCategory || p.category === activeCategory;
      return matchesSearch(p) && matchCat;
    });
    // Apply this branch's custom ranking for the active group ('' shows the
    // branch "best sellers" master order) from the sharded sorting array. The
    // reader is self-healing — unranked/new products fall to the end A–Z, ghost
    // ids are dropped. Pure helper — never mutates `products`.
    //
    // The Admin editor saves a category's order under the categories-collection
    // *id* (`selectedKey = c.id`). `activeCategory` mirrors the product's stored
    // `category` field, which may be a legacy *name* — so resolve it back to the
    // canonical id before the lookup, or specific-category order is missed and
    // we wrongly fall back to alphabetical.
    const sortKey =
      activeCategory && activeCategory !== BEST_SELLERS_KEY
        ? richCategories.find((c) => c.id === activeCategory || c.name === activeCategory)?.id ??
          activeCategory
        : BEST_SELLERS_KEY;
    return sortProductsByCustomOrder(filtered, sorting[sortKey]);
  }, [
    products,
    search,
    activeCategory,
    posBranchId,
    sorting,
    richCategories,
    activeQuickMenuId,
    activeQuickMenus,
  ]);

  // Phase 7C-L3 (cashier confidence): when the current query EXACTLY matches a UOM-specific
  // barcode, surface the matched product + unit so the cashier can SEE which unit Enter will
  // add. The grid card only ever shows base-unit info (`uomOptions[0]`), which made a larger
  // unit (e.g. ลัง) barcode look like the base unit even though the direct add (D4-D) is correct.
  // Pure derivation over the SAME `findByScanCode` the scan handler uses — it NEVER adds to cart
  // and NEVER changes scan/Enter behaviour. Null for text searches, SKU / product-level matches
  // (`option === null`), and misses, so those display paths stay exactly as before.
  const scanUomHint = useMemo(() => {
    const trimmed = search.trim();
    if (!trimmed) return null;
    const match = findByScanCode(products, trimmed);
    if (match?.option) {
      return { productName: match.product.name, unit: match.option.unit };
    }
    return null;
  }, [search, products]);

  // Phase 7C-L3 Revision 2 (permanent System Status & Alert Bar): a single always-mounted bar
  // lives directly below the search header so the product grid below NEVER shifts (the previous
  // revision conditionally mounted/unmounted the hint, which pushed the content row up/down).
  // `posStatusBar` is a pure projection of `scanUomHint` into the bar's two authorized states —
  // it adds NO matcher and NEVER touches the scan/Enter/add path. Future high-priority alert /
  // promo / staff-notice states will extend this `tone`/`text` model; for THIS slice only the
  // default (idle hint) and UOM-match states exist — no backend/promo/remote-config logic.
  const posStatusBar = useMemo(() => {
    if (scanUomHint) {
      return {
        tone: 'uom' as const,
        text: `✅ พบสินค้า: ${scanUomHint.productName} — หน่วย: ${scanUomHint.unit} (กด Enter เพื่อเพิ่ม)`,
      };
    }
    return {
      tone: 'default' as const,
      text: '💡 สแกนบาร์โค้ด หรือพิมพ์ชื่อสินค้า, รหัส (SKU) เพื่อค้นหา',
    };
  }, [scanUomHint]);

  // Enrich the product-derived category strings with admin metadata (branch
  // order/visibility/background) from the categories collection, then keep only
  // the categories visible for THIS branch, in this branch's display order.
  const visibleCategories = useMemo<ProductCategory[]>(() => {
    const metaByKey = new Map<string, ProductCategory>();
    for (const c of richCategories) {
      metaByKey.set(c.id, c);
      metaByKey.set(c.name, c);
    }
    const enriched: ProductCategory[] = categories
      .filter((c) => c !== '')
      .map((catStr) => {
        const meta = metaByKey.get(catStr);
        return {
          id: catStr, // the value used to filter products (p.category)
          name: meta?.name ?? catStr,
          branchSettings: meta?.branchSettings,
        };
      });
    return sortCategories(getVisibleCategories(enriched, posBranchId), posBranchId);
  }, [categories, richCategories, posBranchId]);

  // Ghost-active fallback: if the selected category gets hidden, reset to the
  // best-sellers default (NOT the removed All tab). The best-sellers sentinel is
  // virtual (never in visibleCategories), so it must be preserved explicitly and
  // never treated as a missing category — otherwise the fallback would reset it.
  useEffect(() => {
    if (activeCategory === BEST_SELLERS_KEY) return;
    const safe = resolveActiveCategory(activeCategory, visibleCategories, BEST_SELLERS_KEY);
    if (safe !== activeCategory) setActiveCategory(safe);
  }, [activeCategory, visibleCategories]);

  // If the selected Quick Menu is deleted/deactivated (e.g. after a refresh),
  // fall back to "all" so the grid never points at a vanished virtual category.
  useEffect(() => {
    if (activeQuickMenuId && !activeQuickMenus.some((m) => m.id === activeQuickMenuId)) {
      setActiveQuickMenuId(null);
    }
  }, [activeQuickMenuId, activeQuickMenus]);

  // While online, cache this branch's document prefix so offline receipts use the
  // real prefix (setting/doc-prefix + per-branch posPrefix), not a hardcoded "RCP".
  useEffect(() => {
    if (branchId) void refreshReceiptConfigCache(branchId);
  }, [branchId]);

  const discountLine = discountLineKey ? cart.cart[discountLineKey] ?? null : null;

  const focusSearch = useCallback(() => {
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  // Focus-return consistency (Phase 7C-D4-C-2): every category-overlay close route funnels
  // through here so focus returns to the scan box. Category filtering (setActiveCategory)
  // stays at the call sites and is unchanged.
  const closeCatModal = useCallback(() => {
    setCatModalOpen(false);
    focusSearch();
  }, [focusSearch]);

  // UI-10-B revision: overlay category cells must use the SAME semantic path as the
  // pill bar (`selectCategory` clears `activeQuickMenuId`), then close the overlay.
  // Selecting directly via `setActiveCategory` let a previously-active Quick Menu
  // survive, so the grid stayed filtered by the old Quick Menu after an overlay pick.
  const selectCategoryFromOverlay = useCallback(
    (catId: string) => {
      selectCategory(catId);
      closeCatModal();
    },
    [selectCategory, closeCatModal],
  );

  const onProductClick = useCallback(
    (product: PosProduct) => {
      if (product.uomOptions.length > 1) {
        // Enqueue rather than overwrite the single `uomProduct` slot (Phase 7C-L1 / LOGIC-01):
        // a batch confirm calls this once per selected product, so multiple multi-UOM products
        // must all be remembered — the drain effect below promotes them one at a time. The
        // functional updater avoids any stale-closure read of the queue during the loop.
        setUomQueue((q) => [...q, product]);
      } else {
        cart.addToCart(product, product.uomOptions[0]!);
      }
    },
    [cart],
  );

  // Drain the pending-UOM queue (Phase 7C-L1 / LOGIC-01): whenever no UOM modal is showing and
  // products are still queued, promote the next one (in selection order) into the display slot.
  // Confirm (onSelect) and cancel (onClose / Escape) both clear `uomProduct` to null, so this
  // advances to the next pending product automatically — without dropping any selection and
  // without silently adding a product whose unit was never chosen.
  useEffect(() => {
    if (uomProduct === null && uomQueue.length > 0) {
      setUomProduct(uomQueue[0]!);
      setUomQueue((q) => q.slice(1));
    }
  }, [uomProduct, uomQueue]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      // IME/composition guard (Phase 7C-D4-C-1): a Thai-IME Enter that commits an
      // in-progress composition must not be treated as a barcode/SKU scan. Hardware
      // scanners emit no composition events, so `isComposing`/keyCode 229 are always
      // false for them — this synchronous early-return adds zero latency to scanning
      // (no timers, no delay) and only suppresses the scan during an active composition.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
    setConfirmModalState({ open: true, payload: { type: 'clearCart' } });
  }, [cartLines.length]);

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

  const handleCancelParkedOrderClick = useCallback((bill: SuspendedBill) => {
    setConfirmModalState({ open: true, payload: { type: 'cancelParkedOrder', bill } });
  }, []);

  // Optimistically append the cash entry to the live shift. The DURABLE source is
  // `cashEntries[]` on the shift doc (queued to cache by recordCashTransaction);
  // this only mirrors it into state so the derived drawer updates instantly. On
  // reload, getActiveShift re-reads cashEntries from cache and deriveShiftDrawer
  // recomputes — so this is not the "lost on reload" optimistic-counter trap.
  const handleCashTxRecorded = useCallback((entry: ShiftCashEntry) => {
    setActiveShift((prev) =>
      prev ? { ...prev, cashEntries: [...(prev.cashEntries ?? []), entry] } : prev,
    );
    setShowCashTx(false);
  }, []);

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

  // F12 modal suppression (Phase 7C-D4-C-3): true when any blocking POS modal/overlay is
  // open, so the checkout shortcut won't stack PaymentModal over another dialog. (OpenShift
  // is not listed: F12 already requires `activeShift`, which is null while it shows.)
  const hasBlockingModalOpen = Boolean(
    uomProduct ||
      uomQueue.length > 0 || // pending multi-UOM batch (Phase 7C-L1) — stay blocked between items
      pickerOpen ||
      discountLineKey ||
      qtyNumpadLineKey ||
      discNumpadOpen ||
      showCloseShift ||
      holdNoteOpen ||
      suspendedListOpen ||
      showCashTx ||
      catModalOpen ||
      isSortingModalOpen ||
      confirmModalState.open ||
      checkout.customerModalOpen,
  );

  // Escape behavior (Phase 7C-D4-C-4): close/cancel/dismiss exactly ONE open POS modal per
  // keypress, top-most first. CLOSE-ONLY — it never confirms, saves, submits, applies a qty,
  // clears the cart, removes a bill, or touches any write path; it only flips the page-owned
  // open-state setters (and returns focus to the scan box, per D4-C-2). Returns true when a
  // modal was closed so the caller can preventDefault. Red modals: PaymentModal closes only
  // when NOT processing (mirrors its own onClose guard) and never reaches confirmSale.
  // OpenShift / CloseShift / CashTransaction are intentionally NOT dismissed here — their
  // submit / Z-report state lives inside the component and isn't observable from the page, so a
  // page-level Escape can't prove it wouldn't drop a Z-report or race an in-flight drawer write.
  const closeTopModalOnEscape = useCallback((): boolean => {
    // 1. Destructive confirm — cancel only (never the destructive confirm action)
    if (confirmModalState.open) {
      setConfirmModalState({ open: false });
      return true;
    }
    // 2. Payment — close only while not processing; never confirms payment
    if (paymentOpen) {
      if (checkout.processing) return false;
      setPaymentOpen(false);
      focusSearch();
      return true;
    }
    // 3. Customer picker
    if (checkout.customerModalOpen) {
      checkout.closeCustomerModal();
      focusSearch();
      return true;
    }
    // 4. UOM — cancel (never onSelect)
    if (uomProduct) {
      setUomProduct(null);
      focusSearch();
      return true;
    }
    // 5. Item discount — cancel (never onSave)
    if (discountLineKey) {
      setDiscountLineKey(null);
      focusSearch();
      return true;
    }
    // 6. Qty numpad — cancel (never applies the qty)
    if (qtyNumpadLineKey) {
      setQtyNumpadLineKey(null);
      focusSearch();
      return true;
    }
    // 7. Bill-discount numpad — cancel (never applies the discount; Phase 7C-D4-D)
    if (discNumpadOpen) {
      setDiscNumpadOpen(false);
      focusSearch();
      return true;
    }
    // 8. Hold-bill note — cancel (never confirms the hold)
    if (holdNoteOpen) {
      setHoldNoteOpen(false);
      focusSearch();
      return true;
    }
    // 9. Suspended bills list
    if (suspendedListOpen) {
      setSuspendedListOpen(false);
      focusSearch();
      return true;
    }
    // 10. Category overlay (existing close helper already returns focus)
    if (catModalOpen) {
      closeCatModal();
      return true;
    }
    // 11. Sorting settings
    if (isSortingModalOpen) {
      setIsSortingModalOpen(false);
      focusSearch();
      return true;
    }
    // 12. Product picker
    if (pickerOpen) {
      setPickerOpen(false);
      focusSearch();
      return true;
    }
    return false;
  }, [
    confirmModalState.open,
    paymentOpen,
    checkout,
    uomProduct,
    discountLineKey,
    qtyNumpadLineKey,
    discNumpadOpen,
    holdNoteOpen,
    suspendedListOpen,
    catModalOpen,
    isSortingModalOpen,
    pickerOpen,
    focusSearch,
    closeCatModal,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault();
        // Suppress while a blocking modal is open; otherwise keep the existing open-gate
        // parity with the checkout button (cart non-empty AND an active shift).
        if (hasBlockingModalOpen) return;
        if (cartLines.length > 0 && activeShift) setPaymentOpen(true);
        return;
      }
      // Escape closes/cancels/dismisses exactly one open POS modal (close-only, never confirm).
      // preventDefault only when something actually closed, so a bare Escape stays inert.
      if (e.key === 'Escape') {
        if (closeTopModalOnEscape()) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cartLines.length, activeShift, hasBlockingModalOpen, closeTopModalOnEscape]);

  return (
    <div className="pos-page">
      {updateBanner && (
        <button
          type="button"
          className="pos-sync-banner"
          onClick={handleManualRefresh}
          disabled={refreshing}
        >
          ⚠️ มีการอัปเดตข้อมูลจากผู้จัดการ{' '}
          <span className="pos-sync-banner-cta">[คลิกเพื่อโหลดข้อมูลใหม่]</span>
        </button>
      )}
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
          <button
            type="button"
            className="pos-action-link"
            onClick={() => setIsSortingModalOpen(true)}
          >
            <i className="ti ti-arrows-sort" aria-hidden="true" /> จัดเรียง
          </button>
          <button
            type="button"
            className="pos-action-link"
            onClick={handleManualRefresh}
            disabled={refreshing}
            title="ดึงข้อมูลสินค้า/ราคา/การจัดเรียงล่าสุดจากเซิร์ฟเวอร์"
          >
            <i
              className={`ti ti-refresh${refreshing ? ' pos-spin' : ''}`}
              aria-hidden="true"
            />{' '}
            {refreshing ? 'กำลังอัปเดต...' : 'อัปเดตข้อมูลหน้าจอ'}
          </button>
          <SyncIndicator branchId={branchId} />
          {fromCache && products.length > 0 && (
            <Badge color="gray" icon={() => <i className="ti ti-wifi-off mr-1" aria-hidden="true" />} className="ml-2 whitespace-nowrap">
              ออฟไลน์ (ใช้ข้อมูลในเครื่อง)
            </Badge>
          )}
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

      {/* Phase 7C-L3 Revision 2: permanent System Status & Alert Bar. ALWAYS mounted directly
          below the search header (NEVER inside the search input / pos-search-group row), so the
          product grid below it stays anchored and never shifts — the prior revision's conditional
          mount/unmount was the layout-shift UAT reject. Only the TEXT/tone inside the reserved bar
          changes between the default idle hint and the UOM-match state (both from `posStatusBar`).
          Plain text via existing Tailwind utilities (no new CSS file/class). Display-only: it does
          NOT touch the scan / Enter / add path and carries NO backend/promo/remote-config logic. */}
      <div
        className={`flex items-start gap-1.5 border-b border-[var(--g200)] px-[14px] py-1.5 text-xs font-medium ${
          posStatusBar.tone === 'uom'
            ? 'bg-[var(--g50)] text-[var(--p800)]'
            : 'bg-white text-[var(--g500)]'
        }`}
        role="status"
        aria-live="polite"
        data-status-tone={posStatusBar.tone}
      >
        <span>{posStatusBar.text}</span>
      </div>

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
            {/* Tab order is fixed: (1) ⭐ best-sellers default, (2) Quick Menus in their
                admin `order`, (3) physical categories. The legacy All tab is removed
                (UI-10) — best-sellers is now first/default. */}
            <button
              type="button"
              className={`pos-cat-pill${activeCategory === BEST_SELLERS_KEY && !activeQuickMenuId ? ' on' : ''}`}
              onClick={() => selectCategory(BEST_SELLERS_KEY)}
            >
              ⭐ สินค้าขายดี
            </button>
            {activeQuickMenus.map((qm) => (
              <button
                key={qm.id}
                type="button"
                className={`pos-cat-pill pos-cat-pill--quick${activeQuickMenuId === qm.id ? ' on' : ''}`}
                onClick={() => selectQuickMenu(qm.id)}
              >
                <span className="pos-cat-pill-label">
                  {qm.icon ?? '⚡'} {qm.name}
                </span>
              </button>
            ))}
            {visibleCategories.map((cat) => {
              const setting = cat.branchSettings?.[posBranchId];
              const bgColor = setting?.backgroundColor;
              const bgImage = setting?.imageUrl;
              const hasBg = Boolean(bgImage || bgColor);
              return (
                <button
                  key={cat.id}
                  type="button"
                  className={`pos-cat-pill${activeCategory === cat.id ? ' on' : ''}${hasBg ? ' has-bg' : ''}`}
                  style={
                    bgImage
                      ? { backgroundImage: `url(${bgImage})` }
                      : bgColor
                        ? { background: bgColor }
                        : undefined
                  }
                  onClick={() => selectCategory(cat.id)}
                >
                  {bgImage ? <span className="pos-cat-pill-overlay" aria-hidden="true" /> : null}
                  <span className="pos-cat-pill-label">{cat.name}</span>
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="pos-loading-overlay">กำลังโหลดสินค้า...</div>
          ) : (
            <div className="pos-product-grid">
              {fromCache && products.length === 0 && !error && (
                <div className="col-span-full mb-4 rounded bg-red-50 p-3 text-sm text-red-800 border border-red-200 flex items-center justify-center">
                  <i className="ti ti-alert-circle mr-2" aria-hidden="true" />
                  ไม่มีข้อมูลสินค้าในเครื่อง ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อโหลดครั้งแรก
                </div>
              )}
              {error && (
                <div className="col-span-full mb-4 rounded bg-red-50 p-3 text-sm text-red-800 border border-red-200 flex items-center justify-center">
                  <i className="ti ti-alert-triangle mr-2" aria-hidden="true" />
                  ข้อผิดพลาดของระบบ: {error.message}
                </div>
              )}
              {/* UI-10: best-sellers empty state. Shown only when the ⭐ tab is active,
                  the cashier is NOT searching, and no product is flagged as a best-seller —
                  the grid is never blank and search/scan stay fully available. */}
              {activeCategory === BEST_SELLERS_KEY &&
                !search.trim() &&
                !error &&
                products.length > 0 &&
                filteredProducts.length === 0 && (
                  <div className="col-span-full mb-4 rounded bg-amber-50 p-3 text-sm text-amber-800 border border-amber-200 flex items-center justify-center">
                    <i className="ti ti-star mr-2" aria-hidden="true" />
                    ยังไม่มีสินค้าขายดี — เลือกหมวดหมู่อื่น หรือค้นหา/สแกนสินค้า
                  </div>
                )}
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
              {filteredProducts.length === 0 && products.length > 0 && (
                <div className="p-8 text-center text-gray-500 w-full col-span-full">
                  ไม่พบสินค้าที่ตรงกับการค้นหา
                </div>
              )}
              {products.length === 0 && !fromCache && !error && (
                <div className="p-8 text-center text-gray-500 w-full col-span-full">
                  ยังไม่มีข้อมูลสินค้าในระบบ
                </div>
              )}
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
                
                // Oversell soft warning check
                const product = products.find((p) => p.id === line.productId);
                const neededBase = line.qty * line.unitFactor;
                const isOversold = product && !product.allowNegativeStock && product.stock < neededBase;

                return (
                  <div key={line.lineKey} className={`pos-ci ${isOversold ? 'bg-yellow-50/50 border-yellow-200' : ''}`}>
                    <div className="pos-ci-name">
                      {line.productName}
                      {line.unit !== 'ชิ้น' && (
                        <span className="pos-ci-uom">{line.unit}</span>
                      )}
                      {hasDisc && <span className="pos-ci-disc-tag">มีส่วนลด</span>}
                      {hasTierDisc && !hasDisc && (
                        <span className="pos-ci-tier-tag">ราคาสมาชิก</span>
                      )}
                      {isOversold && (
                        <span className="ml-2 inline-flex items-center rounded bg-yellow-100 px-2 py-0.5 text-[10px] font-medium text-yellow-800 border border-yellow-200 shadow-sm">
                          <i className="ti ti-alert-triangle mr-1" aria-hidden="true" />
                          ขายเกินสต๊อก ({product.stock})
                        </span>
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
                      onPointerDown={(e) => {
                        // Touch/click opens the custom POS numpad (Phase 7C-D4-D Fix 2) instead
                        // of the native mobile keyboard. preventDefault stops the native focus so
                        // the dialog isn't fighting an on-screen keyboard; this is NOT an iOS
                        // focus hack — it suppresses (not forces) focus. Keyboard (Tab) editing of
                        // the field still works, so decimals / 0 remain enterable.
                        e.preventDefault();
                        setDiscNumpadOpen(true);
                      }}
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
          focusSearch();
        }}
        onClose={() => {
          setUomProduct(null);
          focusSearch();
        }}
      />

      <ItemDiscountModal
        line={discountLine}
        onSave={(type: ItemDiscountType, val: number) => {
          if (!discountLineKey) return;
          cart.setLineDiscount(discountLineKey, type, val);
        }}
        onClose={() => {
          setDiscountLineKey(null);
          focusSearch();
        }}
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
          onSuccess={handleCashTxRecorded}
        />
      )}

      {showCloseShift && drawerShift && (
        <CloseShiftModal
          shift={drawerShift}
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
        onRemove={handleCancelParkedOrderClick}
      />

      {catModalOpen && (
        <div
          className="pos-category-overlay"
          role="dialog"
          aria-modal="true"
          onClick={closeCatModal}
        >
          <div className="pos-category-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pos-category-modal-hd">
              <span>เลือกหมวดหมู่</span>
              <button
                type="button"
                className="pos-category-close"
                onClick={closeCatModal}
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
                  className={`pos-category-cell${activeCategory === BEST_SELLERS_KEY && !activeQuickMenuId ? ' active' : ''}`}
                  onClick={() => selectCategoryFromOverlay(BEST_SELLERS_KEY)}
                >
                  ⭐ สินค้าขายดี
                </button>
              )}
              {visibleCategories
                .filter((cat) =>
                  cat.name.toLowerCase().includes(catSearch.trim().toLowerCase()),
                )
                .map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    className={`pos-category-cell${activeCategory === cat.id && !activeQuickMenuId ? ' active' : ''}`}
                    onClick={() => selectCategoryFromOverlay(cat.id)}
                  >
                    {cat.name}
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
        onClose={() => {
          setQtyNumpadLineKey(null);
          focusSearch();
        }}
        onConfirm={(qty) => {
          if (qtyNumpadLineKey && cart.setLineQty(qtyNumpadLineKey, qty)) {
            setQtyNumpadLineKey(null);
            focusSearch();
          }
        }}
      />

      <SortingSettingsModal
        isOpen={isSortingModalOpen}
        onClose={() => setIsSortingModalOpen(false)}
        defaultBranchId={posBranchId}
      />

      {/* Bill-discount numpad (Phase 7C-D4-D Fix 2): tapping the discount field opens this custom
          on-screen numpad instead of the native mobile keyboard. It reuses the touch-only
          NumpadDialog in its opt-in decimal mode (`allowDecimal`/`allowZero`), so it accepts the
          same values as the discount input — 0 and decimals (mirroring `parseFloat(...) || 0`),
          no flooring. It is wired into both `hasBlockingModalOpen` (F12 cannot stack PaymentModal
          over it) and `closeTopModalOnEscape` (Escape closes it), matching the D4-C-3/D4-C-4
          keyboard-modal contracts. Phase 7C-D4-D2: an existing discount is wiped via a footer
          `ล้างส่วนลด` action (`showClearAction`/`onClear`), shown only when a discount is present —
          replacing the D4-D1 in-grid Clear key. */}
      <NumpadDialog
        open={discNumpadOpen}
        title="ส่วนลดท้ายบิล"
        initialValue={cart.billDiscValue}
        allowDecimal
        allowZero
        maxLength={7}
        showClearAction={cart.billDiscValue > 0}
        clearLabel="ล้างส่วนลด"
        onClear={() => {
          cart.setBillDiscValue(0);
          setDiscNumpadOpen(false);
          focusSearch();
        }}
        onClose={() => {
          setDiscNumpadOpen(false);
          focusSearch();
        }}
        onConfirm={(val) => {
          cart.setBillDiscValue(val);
          setDiscNumpadOpen(false);
          focusSearch();
        }}
      />

      <DestructiveConfirmModal
        open={confirmModalState.open}
        title={confirmModalState.payload?.type === 'clearCart' ? 'ยืนยันล้างตะกร้า' : 'ยกเลิกบิลที่พักไว้'}
        description={
          confirmModalState.payload?.type === 'clearCart'
            ? 'คุณแน่ใจหรือไม่ว่าต้องการล้างสินค้าในตะกร้าทั้งหมด?'
            : 'คุณแน่ใจหรือไม่ว่าต้องการยกเลิกและลบบิลที่พักไว้นี้?'
        }
        destructiveLabel="ยืนยัน"
        onConfirm={() => {
          if (confirmModalState.payload?.type === 'clearCart') {
            cart.clearCart();
            showToast('ล้างตะกร้าแล้ว');
            focusSearch();
          } else if (confirmModalState.payload?.type === 'cancelParkedOrder') {
            removeBill(confirmModalState.payload.bill.id);
            showToast('ลบบิลที่พักไว้แล้ว');
            focusSearch();
          }
          setConfirmModalState({ open: false });
        }}
        onCancel={() => setConfirmModalState({ open: false })}
      />

      {toast && (
        <div className="pos-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
