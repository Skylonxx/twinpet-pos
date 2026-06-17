// ─── Phase 7C-D4-A: POS Keyboard / Focus Contract Tests (test-only) ──────────────
// Locks the CURRENT keyboard & focus contracts documented in the 7C-D3-B audit
// (docs/reports/phase-7c-d3-b-pos-keyboard-focus-audit.md) BEFORE any behavior change.
//
// Strategy: source-level `?raw` assertions, mirroring the H7-G precedent in
// src/lib/pos/offline/manualReviewOps.test.ts. The vitest unit config runs in a
// `node` environment with no DOM and only includes `src/**/*.test.ts`, and POSPage
// carries a heavy Firebase/router/auth/cart/offline harness — so mounting is neither
// supported nor safe. These tests prove structural/safety INTENT (presence,
// region-scoped absence, gate parity) rather than runtime behavior, and they make
// the known GAPS (no IME guard; no focus-return after UOM/ItemDiscount close)
// explicit so a future fix under D4-C is a deliberate, reviewed change — not an
// accidental drift. NO runtime source is modified by this slice.

import { describe, test, expect, beforeAll } from 'vitest';

let posSource: string;
let paymentSource: string;
let numpadSource: string;
// UI-10-B: sources for the Best Seller data pipeline (schema → form → drawer → mapper).
let productTypesSource: string;
let productCrudTypesSource: string;
let productDrawerSource: string;
let posTypesSource: string;
let posMapperSource: string;
// UI-10-C: sources for the sorting-modal best-seller data path (interface → store → modal).
let categoryServiceSource: string;
let sortingStoreSource: string;
let sortingModalSource: string;

beforeAll(async () => {
  posSource = (await import('./POSPage.tsx?raw')).default;
  paymentSource = (await import('../components/PaymentModal.tsx?raw')).default;
  numpadSource = (await import('../components/pos/NumpadDialog.tsx?raw')).default;
  productTypesSource = (await import('../lib/types.ts?raw')).default;
  productCrudTypesSource = (await import('../lib/productCrud/types.ts?raw')).default;
  productDrawerSource = (await import('../components/products/ProductDrawer.tsx?raw')).default;
  posTypesSource = (await import('../lib/pos/types.ts?raw')).default;
  posMapperSource = (await import('../lib/pos/posProductMapper.ts?raw')).default;
  categoryServiceSource = (await import('../lib/pos/categoryService.ts?raw')).default;
  sortingStoreSource = (await import('../lib/admin/sortingStore.ts?raw')).default;
  sortingModalSource = (await import('../components/pos/SortingSettingsModal.tsx?raw')).default;
});

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Slice a source to the region between two markers so structural assertions target a
 * specific construct and stay immune to harmless changes elsewhere in the file.
 */
function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// ─── A. Scan match / miss contract ───────────────────────────────────────────────
describe('7C-D4-A · Scan match / miss contract (POSPage.tsx)', () => {
  test('findByScanCode trims input and returns undefined for empty codes', () => {
    const fn = region(posSource, 'function findByScanCode', '\n}');
    expect(fn).toContain('const trimmed = code.trim();');
    expect(fn).toMatch(/if \(!trimmed\) return undefined;/);
  });

  test('top-level SKU/barcode is matched BEFORE any UOM-specific barcode (priority order)', () => {
    const fn = region(posSource, 'function findByScanCode', '\n}');
    const topLevelIdx = fn.indexOf('p.sku === trimmed');
    const uomIdx = fn.indexOf('p.uomOptions.find(');
    expect(topLevelIdx).toBeGreaterThan(-1);
    expect(uomIdx).toBeGreaterThan(-1);
    expect(topLevelIdx).toBeLessThan(uomIdx);
  });

  test('the scan handler acts ONLY on Enter and short-circuits empty input', () => {
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toMatch(/if \(e\.key !== 'Enter'\) return;/);
    expect(h).toMatch(/const trimmed = search\.trim\(\);/);
    expect(h).toMatch(/if \(!trimmed\) return;/);
    expect(h).toContain('e.preventDefault();');
    expect(h).toContain('findByScanCode(products, trimmed)');
  });

  test('on MATCH the scan handler clears the search box and returns focus to it', () => {
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    // UOM-specific barcode adds the unit directly; otherwise onProductClick (UomModal when multi-UOM).
    expect(h).toContain('cart.addToCart(match.product, match.option);');
    expect(h).toContain('onProductClick(match.product);');
    expect(h).toContain("setSearch('')");
    expect(h).toContain('focusSearch();');
  });

  test('on MISS the scan handler only toasts — it does NOT clear the search text', () => {
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    // The else branch must be toast-only: no setSearch('') / focus reset on a miss,
    // so the cashier can correct a mistyped code.
    expect(h).toMatch(/else \{\s*showToast\('ไม่พบสินค้านี้'\);\s*\}/);
  });

  test('IME/composition guard is present and runs BEFORE the scan lookup (D4-C-1 fix)', () => {
    // D4-C-1 intentional behavior fix: the prior D4-A "no IME guard" GAP is now closed.
    // A Thai-IME Enter that commits composition must NOT trigger findByScanCode/addToCart.
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    // Guard exists and checks composition state (isComposing and/or legacy keyCode 229).
    expect(h).toMatch(/isComposing/);
    expect(h).toMatch(/keyCode === 229/);
    // The guard short-circuits with `return` before the scan lookup runs.
    expect(h).toMatch(/if \(e\.nativeEvent\.isComposing \|\| e\.nativeEvent\.keyCode === 229\) return;/);
    const guardIdx = h.indexOf('isComposing');
    const scanIdx = h.indexOf('findByScanCode(products, trimmed)');
    const trimIdx = h.indexOf('const trimmed = search.trim();');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(scanIdx).toBeGreaterThan(-1);
    // Guard precedes both the trim and the scan lookup, so composition Enter never scans.
    expect(guardIdx).toBeLessThan(trimIdx);
    expect(guardIdx).toBeLessThan(scanIdx);
  });

  test('IME guard introduces NO debounce / timer / delayed scan (scanner speed preserved)', () => {
    // The fix must be a synchronous early-return only — no artificial latency on scanning.
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).not.toContain('setTimeout');
    expect(h).not.toContain('setInterval');
    expect(h).not.toContain('requestAnimationFrame');
    expect(h).not.toContain('debounce');
    // Non-composing Enter still reaches the scan lookup unchanged.
    expect(h).toContain('findByScanCode(products, trimmed)');
  });
});

// ─── B. F12 ↔ checkout-disabled parity ─────────────────────────────────────────────
describe('7C-D4-A · F12 / checkout-disabled gate parity (POSPage.tsx)', () => {
  test('exactly one global keydown listener exists and is cleaned up on unmount', () => {
    expect(countOccurrences(posSource, "window.addEventListener('keydown'")).toBe(1);
    expect(posSource).toContain("window.removeEventListener('keydown', onKey)");
  });

  test('F12 calls preventDefault and opens payment ONLY when cart>0 AND a shift is active', () => {
    const eff = region(posSource, 'const onKey = (e: KeyboardEvent)', "window.removeEventListener('keydown'");
    expect(eff).toContain("e.key === 'F12'");
    expect(eff).toContain('e.preventDefault();');
    expect(eff).toContain('if (cartLines.length > 0 && activeShift) setPaymentOpen(true);');
  });

  test('the checkout button disabled gate is the logical complement of the F12 open gate', () => {
    // F12 opens when: cartLines.length > 0 && activeShift
    // Button disabled when: cartLines.length === 0 || !activeShift  (De Morgan complement)
    expect(posSource).toContain('disabled={cartLines.length === 0 || !activeShift}');
    // Both gates are driven by the SAME two predicates — no third condition diverges them.
    const eff = region(posSource, 'const onKey = (e: KeyboardEvent)', "window.removeEventListener('keydown'");
    expect(eff).toContain('cartLines.length > 0');
    expect(eff).toContain('activeShift');
  });

  test('F12 is suppressed while any blocking POS modal is open (D4-C-3 fix)', () => {
    // D4-C-3 intentional fix: F12 must not stack PaymentModal over an already-open dialog.
    // A blocking-modal predicate gates the shortcut before payment opens. Checkout-disabled
    // parity (cart>0 && activeShift) is unchanged.
    const pred = region(posSource, 'const hasBlockingModalOpen = Boolean(', ');');
    // Predicate enumerates the current blocking modal/overlay states.
    for (const state of [
      'uomProduct',
      'pickerOpen',
      'discountLineKey',
      'qtyNumpadLineKey',
      'discNumpadOpen',
      'showCloseShift',
      'holdNoteOpen',
      'suspendedListOpen',
      'showCashTx',
      'catModalOpen',
      'isSortingModalOpen',
      'confirmModalState.open',
      'checkout.customerModalOpen',
    ]) {
      expect(pred).toContain(state);
    }
    // The F12 handler consults the predicate and returns BEFORE opening payment.
    const eff = region(posSource, 'const onKey = (e: KeyboardEvent)', "window.removeEventListener('keydown'");
    expect(eff).toContain('if (hasBlockingModalOpen) return;');
    const suppressIdx = eff.indexOf('if (hasBlockingModalOpen) return;');
    const openIdx = eff.indexOf('setPaymentOpen(true)');
    expect(suppressIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(-1);
    expect(suppressIdx).toBeLessThan(openIdx);
    // preventDefault still fires unconditionally (devtools never opens on the terminal).
    expect(eff.indexOf('e.preventDefault();')).toBeLessThan(suppressIdx);
    // The effect closure stays current by depending on the predicate.
    const effDeps = region(posSource, "window.removeEventListener('keydown', onKey);", ']);');
    expect(effDeps).toContain('hasBlockingModalOpen');
  });

  test('F12 suppression added no new/duplicate listener and no F12 code in PaymentModal', () => {
    // Still exactly one global keydown listener (re-asserted alongside the suppression change).
    expect(countOccurrences(posSource, "window.addEventListener('keydown'")).toBe(1);
    // F12 handling stays in the page; it was not moved into the payment modal.
    expect(paymentSource).not.toContain('F12');
  });
});

// ─── C. Focus-return expectations ──────────────────────────────────────────────────
describe('7C-D4-A · Focus-return contract (POSPage.tsx)', () => {
  test('focusSearch refocuses the search input via requestAnimationFrame', () => {
    const f = region(posSource, 'const focusSearch = useCallback', '[]);');
    expect(f).toContain('window.requestAnimationFrame(() => searchInputRef.current?.focus());');
  });

  test('search input is the mount-focus owner (autoFocus + ref + scan handler wired)', () => {
    const input = region(posSource, 'id="pos-search"', 'onKeyDown={handleSearchKeyDown}');
    expect(input).toContain('ref={searchInputRef}');
    expect(input).toContain('autoFocus');
    expect(posSource).toContain('onKeyDown={handleSearchKeyDown}');
  });

  test('focus returns after new-sale, customer close/select, and payment close', () => {
    const newSale = region(posSource, 'const handleNewSale', 'const handleClearCartClick');
    expect(newSale).toContain('focusSearch();');

    expect(posSource).toMatch(/closeCustomerModal\(\);[\s\S]{0,40}focusSearch\(\)/);
    expect(posSource).toMatch(/selectCustomer\(cust\);[\s\S]{0,40}focusSearch\(\)/);
    // Payment close restores focus, but only once processing has settled.
    expect(posSource).toMatch(/if \(checkout\.processing\) return;[\s\S]{0,80}focusSearch\(\)/);
  });

  test('focus returns after HOLD (handleHoldConfirm)', () => {
    // Cashier muscle-memory path: parking a bill clears the cart and returns focus to scan.
    const hold = region(posSource, 'const handleHoldConfirm', 'const handleRestoreBill');
    expect(hold).toContain('addBill(bill);');
    expect(hold).toContain('clearPosCart();');
    expect(hold).toContain('focusSearch();');
  });

  test('focus returns after RESTORE (handleRestoreBill)', () => {
    const restore = region(posSource, 'const handleRestoreBill', 'const handleCancelParkedOrderClick');
    expect(restore).toContain('cart.restoreCart(bill);');
    expect(restore).toContain('focusSearch();');
  });

  test('focus returns after BOTH clear-cart AND cancel-parked confirmations', () => {
    // The DestructiveConfirmModal onConfirm handles two branches; each restores focus.
    const confirm = region(posSource, '<DestructiveConfirmModal', 'onCancel=');
    expect(confirm).toMatch(/cart\.clearCart\(\);[\s\S]{0,80}focusSearch\(\)/);
    expect(confirm).toMatch(/removeBill\(confirmModalState\.payload\.bill\.id\);[\s\S]{0,80}focusSearch\(\)/);
    // Both branches return focus → exactly two focusSearch() calls in this region.
    expect(countOccurrences(confirm, 'focusSearch();')).toBe(2);
  });

  test('focus returns after the NumpadDialog (qty) confirm AND close (D4-C-2 fix)', () => {
    // D4-C-2 intentional fix: the prior D4-A "no focus-return" GAP for the qty numpad is
    // now closed. Both the confirm (after a successful qty apply) and the close path
    // restore focus to the scan box. NumpadDialog itself stays touch-only (not modified).
    const numpad = region(posSource, '<NumpadDialog', '<SortingSettingsModal');
    expect(numpad).toContain('focusSearch();');
    // confirm restores focus only after the line-qty mutation succeeds and the dialog clears
    expect(numpad).toMatch(/setQtyNumpadLineKey\(null\);[\s\S]{0,40}focusSearch\(\)/);
  });

  test('focus returns after the UOM modal select AND close (D4-C-2 fix)', () => {
    // D4-C-2 intentional fix: both onSelect (add the unit) and onClose (cancel) return focus.
    const uom = region(posSource, '<UomModal', '<ItemDiscountModal');
    expect(countOccurrences(uom, 'focusSearch();')).toBe(2);
  });

  test('focus returns after the Item Discount modal close/save (D4-C-2 fix)', () => {
    // D4-C-2 intentional fix: the modal funnels both save and cancel through onClose, so a
    // single focusSearch() in onClose covers both routes. Discount math is untouched.
    const disc = region(posSource, '<ItemDiscountModal', '<ProductPickerDialog');
    expect(disc).toContain('focusSearch();');
    expect(disc).toMatch(/setDiscountLineKey\(null\);[\s\S]{0,40}focusSearch\(\)/);
  });

  test('focus returns after the category overlay closes (D4-C-2 fix)', () => {
    // D4-C-2 intentional fix: all category-overlay close routes (backdrop, close button,
    // "all" reset, category select) go through closeCatModal, which clears the modal and
    // returns focus. Category filtering (setActiveCategory) is unchanged.
    const helper = region(posSource, 'const closeCatModal', '}, [focusSearch]);');
    expect(helper).toContain('setCatModalOpen(false);');
    expect(helper).toContain('focusSearch();');
    const overlay = region(posSource, 'className="pos-category-overlay"', 'SortingSettingsModal');
    expect(overlay).toContain('closeCatModal');
    // The category cells still drive the filter; closing no longer leaves a bare
    // setCatModalOpen(false) un-refocused inside the overlay.
    expect(overlay).not.toContain('setCatModalOpen(false)');
  });
});

// ─── C2. Aggressive Scanner Focus hotfix (7C-UI-02-HOTFIX-FOCUS) ────────────────────────
// Physical UAT: clicking a STANDARD product card (no UOM modal), a category tab, or a top-bar
// action (Refresh / Sort / Select) left focus trapped on the clicked element, breaking the
// scanner-first flow. These tests pin that each of those paths now returns focus to the scan
// box via the shared rAF-deferred `focusSearch()` helper — and that the multi-UOM card path is
// deliberately NOT refocused (UomModal owns focus until it closes).
describe('7C-UI-02-HOTFIX-FOCUS · Aggressive Scanner Focus (POSPage.tsx)', () => {
  test('focusSearch is declared early (before the early handlers) and stays rAF-deferred', () => {
    const f = region(posSource, 'const focusSearch = useCallback', '[]);');
    expect(f).toContain('window.requestAnimationFrame(() => searchInputRef.current?.focus());');
    // Declared before the handlers that depend on it (no TDZ on their dep arrays).
    expect(posSource.indexOf('const focusSearch = useCallback')).toBeLessThan(
      posSource.indexOf('const selectCategory = useCallback'),
    );
    expect(posSource.indexOf('const focusSearch = useCallback')).toBeLessThan(
      posSource.indexOf('const handleManualRefresh = useCallback'),
    );
  });

  test('a STANDARD (single-UOM) card add returns focus; the multi-UOM path does NOT', () => {
    const fn = region(posSource, 'const onProductClick = useCallback', '[cart, focusSearch],');
    // The single-UOM add is followed by a (guarded) focus restore...
    expect(fn).toMatch(/cart\.addToCart\(product, product\.uomOptions\[0\]!\);[\s\S]{0,800}focusSearch\(\)/);
    // ...gated by skipFocus so a picker batch that opens UomModal can suppress it...
    expect(fn).toContain('if (!opts?.skipFocus) focusSearch();');
    // ...and there is exactly ONE focusSearch() — the multi-UOM enqueue branch is excluded.
    expect(countOccurrences(fn, 'focusSearch();')).toBe(1);
    // The multi-UOM enqueue is NOT immediately followed by a focus restore.
    expect(fn).not.toMatch(/setUomQueue\(\(q\) => \[\.\.\.q, product\]\);[\s\S]{0,40}focusSearch/);
  });

  test('category-tab selection returns focus (selectCategory + selectQuickMenu)', () => {
    const cat = region(posSource, 'const selectCategory = useCallback', '}, [focusSearch]);');
    expect(cat).toContain('setActiveCategory(catId);');
    expect(cat).toContain('focusSearch();');
    const quick = region(posSource, 'const selectQuickMenu = useCallback', '}, [focusSearch]);');
    expect(quick).toContain('setActiveQuickMenuId(id);');
    expect(quick).toContain('focusSearch();');
  });

  test('the Refresh action (handleManualRefresh — Refresh button) returns focus', () => {
    const fn = region(posSource, 'const handleManualRefresh = useCallback', '[lastForceUpdate, refreshInventory, focusSearch]');
    expect(fn).toContain('void refreshInventory();');
    expect(fn).toContain('focusSearch();');
  });

  test('the Select picker refocuses on close ONLY when no multi-UOM modal is pending', () => {
    const pick = region(posSource, '<ProductPickerDialog', '<CustomerPickerModal');
    // Close still refocuses, but GUARDED by the pending-UOM flag (not an unconditional call) —
    // so a plain cancel/standard confirm refocuses while a multi-UOM confirm does not.
    expect(pick).toContain('if (!pickerWillOpenUomRef.current) focusSearch();');
    // The flag is reset on every close so the next open starts clean.
    expect(pick).toContain('pickerWillOpenUomRef.current = false;');
    // The OLD unconditional refocus is gone.
    expect(pick).not.toMatch(/setPickerOpen\(false\);\s*focusSearch\(\);/);
  });

  test('the Select picker confirm + multi-UOM selection does NOT refocus behind UomModal (Codex blocker)', () => {
    const pick = region(posSource, '<ProductPickerDialog', '<CustomerPickerModal');
    // onConfirm decides up-front whether the confirmed batch will open UomModal...
    expect(pick).toContain('const willOpenUom = resolved.some((p) => p.uomOptions.length > 1);');
    // ...threads skipFocus into every add so a single-UOM item in the SAME batch won't refocus
    // the scan box behind the modal...
    expect(pick).toContain('onProductClick(product, { skipFocus: willOpenUom });');
    // ...and records the decision so onClose skips the scan-box refocus.
    expect(pick).toContain('pickerWillOpenUomRef.current = willOpenUom;');
  });

  test('the Sort modal (SortingSettingsModal) returns focus on close', () => {
    const sort = region(posSource, '<SortingSettingsModal', 'defaultBranchId={posBranchId}');
    expect(sort).toMatch(/setIsSortingModalOpen\(false\);[\s\S]{0,80}focusSearch\(\)/);
  });
});

// ─── C3. Comprehensive Focus Recovery Edge hotfix (7C-UI-02-HOTFIX-FOCUS-EDGE) ──────────
// Physical UAT found more POS controls that steal focus and never return it to the scanner:
// the cart-line qty +/-, remove-line, the bill-level fee chips + discount ฿/% toggles, and the
// Cash In/Out, Close-Shift, and Clear-Cart (confirm cancel) modal close/resolve paths. These
// tests pin that each returns focus to the scan box — the non-modal cart controls through the
// shared rAF-deferred `runAndRefocus(...)` wrapper, the modals on close/resolution — while NOT
// stealing focus from a modal that should own it (UOM/Payment unchanged).
describe('7C-UI-02-HOTFIX-FOCUS-EDGE · Comprehensive focus recovery (POSPage.tsx)', () => {
  test('runAndRefocus runs the mutation THEN refocuses the scan box (shared rAF helper)', () => {
    const fn = region(posSource, 'const runAndRefocus = useCallback', '[focusSearch],');
    expect(fn).toContain('action();');
    expect(fn).toContain('focusSearch();');
    // Order matters: mutate first, refocus after.
    expect(fn.indexOf('action();')).toBeLessThan(fn.indexOf('focusSearch();'));
  });

  test('targets 5 & 6 — cart-line qty + and qty - return focus (runAndRefocus)', () => {
    expect(posSource).toContain('runAndRefocus(() => cart.changeQty(line.lineKey, 1))');
    expect(posSource).toContain('runAndRefocus(() => cart.changeQty(line.lineKey, -1))');
  });

  test('target 4 — remove line item returns focus (survives the line unmount via rAF)', () => {
    expect(posSource).toContain('runAndRefocus(() => cart.removeLine(line.lineKey))');
  });

  test('target 7 — fee chips return focus (runAndRefocus)', () => {
    expect(posSource).toContain('runAndRefocus(() => cart.setFeeRate(rate))');
  });

  test('targets 8 & 9 — bill-discount ฿ (baht) and % (percent) toggles return focus', () => {
    expect(posSource).toContain('runAndRefocus(() => cart.setBillDiscPercent(false))');
    expect(posSource).toContain('runAndRefocus(() => cart.setBillDiscPercent(true))');
  });

  test('target 1 — Cash In/Out (CashTransactionModal) returns focus on close AND on success', () => {
    const modal = region(posSource, '<CashTransactionModal', 'onSuccess={handleCashTxRecorded}');
    expect(modal).toMatch(/setShowCashTx\(false\);[\s\S]{0,120}focusSearch\(\)/);
    const success = region(posSource, 'const handleCashTxRecorded = useCallback', '[focusSearch]);');
    expect(success).toContain('setShowCashTx(false);');
    expect(success).toContain('focusSearch();');
  });

  test('target 2 — Close Shift (CloseShiftModal) returns focus on close (success via handleNewSale)', () => {
    const modal = region(posSource, '<CloseShiftModal', 'onSuccess=');
    expect(modal).toMatch(/setShowCloseShift\(false\);[\s\S]{0,120}focusSearch\(\)/);
    // handleNewSale (the success path) already refocuses — unchanged contract.
    const newSale = region(posSource, 'const handleNewSale', 'const handleClearCartClick');
    expect(newSale).toContain('focusSearch();');
  });

  test('target 3 — Clear Cart / cancel-parked confirm returns focus on BOTH confirm and cancel', () => {
    const modal = region(posSource, '<DestructiveConfirmModal', '</div>');
    // Confirm branches (existing) refocus...
    expect(modal).toMatch(/cart\.clearCart\(\);[\s\S]{0,80}focusSearch\(\)/);
    // ...and the cancel path now refocuses too (the confirm came from a cart/topbar button).
    expect(modal).toMatch(/onCancel=\{\(\) => \{[\s\S]{0,400}focusSearch\(\)/);
  });

  test('modal-owned focus is NOT stolen — UOM still owns focus until select/close (unchanged)', () => {
    // Regression guard: the edge hotfix must not refocus behind a modal that owns focus.
    const uom = region(posSource, '<UomModal', '<ItemDiscountModal');
    expect(countOccurrences(uom, 'focusSearch();')).toBe(2);
    // The ProductPicker multi-UOM sequencing fix (42ff3ed) is intact.
    const pick = region(posSource, '<ProductPickerDialog', '<CustomerPickerModal');
    expect(pick).toContain('if (!pickerWillOpenUomRef.current) focusSearch();');
  });
});

// ─── C4. UI-03 polish: glowing Refresh button + cancel-path focus recovery ──────────────
// Physical UAT: (A) the standalone yellow Manager-Update banner mounted above the topbar and
// shifted the whole layout — it is removed; the pending-update urgency now toggles a class on
// the always-present Refresh button (zero layout shift). (B) Hold-Bill and Suspended-Bills
// cancel/close left focus trapped — both now refocus the scan box on close. (Border polish in
// POSPage.css is visual-only and validated by AGY, not asserted here.)
describe('7C-UI-03-POLISH · Update glow + cancel-path focus (POSPage.tsx)', () => {
  test('A — the standalone layout-shifting Manager-Update banner is GONE', () => {
    // No banner element/class remains in the render tree (it lived above <header>).
    expect(posSource).not.toContain('className="pos-sync-banner"');
    expect(posSource).not.toContain('pos-sync-banner-cta');
    // No conditional `{updateBanner && (` block mounts/unmounts an element (which caused the shift).
    expect(posSource).not.toContain('{updateBanner && (');
  });

  test('A — pending update toggles a CLASS on the existing Refresh button (no element insertion)', () => {
    // The urgency rides the existing toolbar button via a conditional modifier class only.
    expect(posSource).toContain("pos-action-link${updateBanner ? ' pos-action-link--update' : ''}");
    // The state is still owned by updateBanner (detection/refresh behavior unchanged).
    expect(posSource).toContain('const [updateBanner, setUpdateBanner] = useState(false);');
  });

  test('A — refreshing resolves the button back to normal (clears the pending flag)', () => {
    const fn = region(posSource, 'const handleManualRefresh = useCallback', '[lastForceUpdate, refreshInventory, focusSearch]');
    // Acknowledging the signal drops updateBanner → the glow class is removed.
    expect(fn).toContain('setUpdateBanner(false);');
    expect(fn).toContain('void refreshInventory();');
  });

  test('B — Hold-Bill modal cancel/close returns focus to the scan box', () => {
    const modal = region(posSource, '<HoldBillNoteModal', 'onConfirm={handleHoldConfirm}');
    expect(modal).toMatch(/setHoldNoteOpen\(false\);[\s\S]{0,200}focusSearch\(\)/);
  });

  test('B — Suspended-Bills modal cancel/close returns focus to the scan box', () => {
    const modal = region(posSource, '<SuspendedBillsListModal', 'onRestore=');
    expect(modal).toMatch(/setSuspendedListOpen\(false\);[\s\S]{0,200}focusSearch\(\)/);
  });
});

// ─── C5. UI-04 category sync + macro layout ─────────────────────────────────────────────
// Physical UAT (corrected): (A) the left product/grid area and the right cart panel had a jagged
// top edge and an awkward exposed gutter — fixed in POSPage.css (cart top aligns with the category
// bar; a single consistent gutter). (B) the catalog-wide update bell already glows for any admin
// broadcast, but the category TABS were derived from product categories only, so a newly-added
// category never rendered after a refresh — now sourced from the categories collection too.
// (C) the category bar scrolls horizontally (POSPage.css). A and C are CSS-only and validated by
// AGY; the testable parts (the B render-merge + catalog-wide refresh) are pinned here.
describe('7C-UI-04-SYNC-AND-MACRO-LAYOUT · Category sync + macro layout (POSPage.tsx)', () => {
  test('B — category tabs are sourced from the categories collection too (new categories render)', () => {
    const memo = region(posSource, 'const visibleCategories = useMemo', '}, [categories, richCategories, posBranchId]);');
    // Product-derived strings AND collection-only categories both feed the tab list...
    expect(memo).toContain('for (const catStr of categories)');
    expect(memo).toContain('for (const c of richCategories)');
    expect(memo).toContain('enriched.push({ id: c.id, name: c.name, branchSettings: c.branchSettings });');
    // ...deduped, and still gated by branch visibility + order.
    expect(memo).toContain('getVisibleCategories(enriched, posBranchId)');
    expect(memo).toContain('sortCategories(');
  });

  test('B — the update bell is catalog-wide: glow + refresh fire for category OR product changes', () => {
    // The POS reacts to the generic sync timestamp (not a product-only field), so a category
    // broadcast defers a banner / auto-refreshes exactly like a product one.
    const eff = region(posSource, 'if (!syncInitialized) return;', '}, [syncInitialized, lastForceUpdate, cartLines.length, refreshInventory]);');
    expect(eff).toContain('lastForceUpdate');
    expect(eff).toContain('setUpdateBanner(true);');
    // Acknowledging the update pulls a fresh snapshot — which includes the updated categories.
    const refresh = region(posSource, 'const handleManualRefresh = useCallback', '[lastForceUpdate, refreshInventory, focusSearch]');
    expect(refresh).toContain('void refreshInventory();');
  });

  test('C — the category bar still renders every visible category (horizontal-scroll container)', () => {
    const bar = region(posSource, 'className="pos-cat-bar"', '{loading ?');
    expect(bar).toContain('visibleCategories.map');
  });
});

// ─── E. Escape close/cancel/dismiss contract (D4-C-4 fix) ───────────────────────────
describe('7C-D4-C-4 · Escape close/cancel/dismiss contract (POSPage.tsx)', () => {
  /** Body of the central Escape helper (between its `useCallback(` and the dep array `}, [`). */
  function escapeBody(): string {
    return region(posSource, 'const closeTopModalOnEscape = useCallback', '}, [');
  }

  test('Escape is wired into the SINGLE existing global keydown listener (no new listener)', () => {
    // D4-C-4 must not add a second window listener — it extends the same `onKey` effect that
    // already owns F12, so the single-listener + cleanup invariant is preserved.
    expect(countOccurrences(posSource, "window.addEventListener('keydown'")).toBe(1);
    expect(posSource).toContain("window.removeEventListener('keydown', onKey)");
    const eff = region(posSource, 'const onKey = (e: KeyboardEvent)', "window.removeEventListener('keydown'");
    // Escape branch delegates to the close-only helper and only preventDefaults when it closed
    // something (a bare Escape outside any modal must stay inert).
    expect(eff).toContain("e.key === 'Escape'");
    expect(eff).toContain('if (closeTopModalOnEscape()) e.preventDefault();');
    // The effect closure stays current by depending on the helper.
    const effDeps = region(posSource, "window.removeEventListener('keydown', onKey);", ']);');
    expect(effDeps).toContain('closeTopModalOnEscape');
  });

  test('F12 behavior is unchanged by the Escape wiring (open-gate + suppression intact)', () => {
    // Escape was appended AFTER the F12 branch; the F12 open-gate and D4-C-3 suppression survive.
    const eff = region(posSource, 'const onKey = (e: KeyboardEvent)', "window.removeEventListener('keydown'");
    expect(eff).toContain("e.key === 'F12'");
    expect(eff).toContain('if (hasBlockingModalOpen) return;');
    expect(eff).toContain('if (cartLines.length > 0 && activeShift) setPaymentOpen(true);');
    // F12's preventDefault still precedes the suppression gate (devtools stays suppressed).
    const pdIdx = eff.indexOf('e.preventDefault();');
    const suppressIdx = eff.indexOf('if (hasBlockingModalOpen) return;');
    expect(pdIdx).toBeGreaterThan(-1);
    expect(pdIdx).toBeLessThan(suppressIdx);
  });

  test('Escape closes/cancels each page-owned modal via its existing close setter/helper', () => {
    const body = escapeBody();
    // Each handled modal flips ONLY its page-owned open-state (cancel/close), never a confirm.
    for (const closer of [
      'setConfirmModalState({ open: false });', // DestructiveConfirm — cancel branch only
      'setPaymentOpen(false);', // Payment — guarded close (see processing test below)
      'checkout.closeCustomerModal();', // Customer picker
      'setUomProduct(null);', // UOM — cancel
      'setDiscountLineKey(null);', // Item discount — cancel
      'setQtyNumpadLineKey(null);', // Qty numpad — cancel
      'setDiscNumpadOpen(false);', // Bill-discount numpad — cancel (D4-D)
      'setHoldNoteOpen(false);', // Hold-bill note — cancel
      'setSuspendedListOpen(false);', // Suspended list
      'closeCatModal();', // Category overlay
      'setIsSortingModalOpen(false);', // Sorting settings
      'setPickerOpen(false);', // Product picker
    ]) {
      expect(body).toContain(closer);
    }
  });

  test('Red shift/cash modals are intentionally NOT dismissed by the central Escape', () => {
    // Their submit / Z-report state is internal to the component and not observable from the
    // page, so the page-level Escape deliberately leaves them to their own close affordances.
    const body = escapeBody();
    expect(body).not.toContain('setShowCloseShift(false)');
    expect(body).not.toContain('setShowCashTx(false)');
    // OpenShiftModal has no page-level close setter at all (shift must be opened or page left).
    expect(body).not.toContain('OpenShift');
  });

  test('Escape closes the top-most modal first — deterministic single-close priority', () => {
    const body = escapeBody();
    const order = [
      'setConfirmModalState({ open: false });',
      'setPaymentOpen(false);',
      'checkout.closeCustomerModal();',
      'setUomProduct(null);',
      'setDiscountLineKey(null);',
      'setQtyNumpadLineKey(null);',
      'setDiscNumpadOpen(false);',
      'setHoldNoteOpen(false);',
      'setSuspendedListOpen(false);',
      'closeCatModal();',
      'setIsSortingModalOpen(false);',
      'setPickerOpen(false);',
    ];
    const indices = order.map((s) => body.indexOf(s));
    for (const i of indices) expect(i).toBeGreaterThan(-1);
    // Strictly increasing source order == a fixed priority chain; each branch returns so only
    // one modal closes per keypress (one `return true;` per handled modal, +1 final fall-through).
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
    expect(countOccurrences(body, 'return true;')).toBe(order.length);
    expect(body).toContain('return false;');
  });

  test('Escape on PaymentModal is processing-guarded and never confirms payment', () => {
    const body = escapeBody();
    // The processing guard mirrors PaymentModal.onClose and bails BEFORE the close runs.
    const guardIdx = body.indexOf('if (checkout.processing) return false;');
    const closeIdx = body.indexOf('setPaymentOpen(false);');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(closeIdx);
    // Escape never reaches the Red payment-confirm path.
    expect(body).not.toContain('confirmSale');
    expect(body).not.toContain('onConfirm');
    expect(body).not.toContain('handleConfirm');
  });

  test('Escape handler contains NO write-path / confirm / cart-mutation calls (RED-path safe)', () => {
    const body = escapeBody();
    for (const forbidden of [
      'confirmSale',
      'submitAsyncOrder',
      'buildAsyncOrder',
      'setDoc',
      'clearCart',
      'cart.clear',
      'cart.addToCart',
      'addToCart',
      'setLineQty',
      'setLineDiscount',
      'restoreCart',
      'addBill',
      'removeBill',
      'onConfirm',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test('Escape handling lives in the page, NOT inside the PaymentModal / NumpadDialog components', () => {
    // No Escape (or any key handler) was added to the Red/touch-only modal components.
    expect(paymentSource).not.toContain('Escape');
    expect(paymentSource).not.toContain('onKeyDown');
    expect(numpadSource).not.toContain('Escape');
    expect(numpadSource).not.toContain('onKeyDown');
  });
});

// ─── F. Bill-discount numpad keyboard-contract integration (D4-D revision) ───────────
describe('7C-D4-D · Bill-discount numpad integration (POSPage.tsx / NumpadDialog.tsx)', () => {
  /** Region of the bill-discount NumpadDialog element (title → its closing `/>`). */
  function discNumpadRegion(): string {
    return region(posSource, 'title="ส่วนลดท้ายบิล"', '/>');
  }

  test('discNumpadOpen is included in the F12 blocking predicate (no PaymentModal stacking)', () => {
    // D4-D Blocker 1: the discount numpad is a blocking modal, so F12 must be suppressed while it
    // is open. The predicate enumerates it; the F12 handler already returns on hasBlockingModalOpen.
    const pred = region(posSource, 'const hasBlockingModalOpen = Boolean(', ');');
    expect(pred).toContain('discNumpadOpen');
  });

  test('Escape closes the discount numpad (close-only) and returns true', () => {
    // D4-D Blocker 1: closeTopModalOnEscape gains a discount-numpad branch that only flips the
    // open-state (cancel) and returns true so exactly one modal still closes per keypress.
    const body = region(posSource, 'const closeTopModalOnEscape = useCallback', '}, [');
    expect(body).toMatch(/if \(discNumpadOpen\) \{\s*setDiscNumpadOpen\(false\);[\s\S]{0,40}return true;/);
    // Closing the discount numpad is not a write/confirm path.
    expect(body).not.toContain('setBillDiscValue');
  });

  test('the discount NumpadDialog opts into decimal/zero entry and writes via the bill setter', () => {
    // D4-D Blocker 2: the bill-discount numpad must accept the same values as the discount input
    // (0 and decimals). It opts into the new NumpadDialog modes and confirms via setBillDiscValue.
    const disc = discNumpadRegion();
    expect(disc).toContain('allowDecimal');
    expect(disc).toContain('allowZero');
    expect(disc).toContain('initialValue={cart.billDiscValue}');
    expect(disc).toContain('cart.setBillDiscValue(');
    expect(disc).toContain('setDiscNumpadOpen(false)');
  });

  test('the QTY NumpadDialog keeps the default integer contract (no decimal/zero opt-in)', () => {
    // Regression guard: only the bill-discount instance opts in; the qty numpad is untouched.
    const qty = region(posSource, '<NumpadDialog', '<SortingSettingsModal');
    expect(qty).toContain('setLineQty');
    expect(qty).not.toContain('allowDecimal');
    expect(qty).not.toContain('allowZero');
  });

  test('NumpadDialog decimal/zero support is OPT-IN and backwards-compatible (qty unchanged)', () => {
    // The new props default OFF, so every existing caller keeps the integer-≥1 contract.
    expect(numpadSource).toContain('allowDecimal = false');
    expect(numpadSource).toContain('allowZero = false');
    // Quantity contract preserved by default: integer parse, ≤0 rejected, initialValue floored.
    expect(numpadSource).toContain('parseInt(input, 10)');
    expect(numpadSource).toContain('กรุณาระบุจำนวนที่มากกว่า 0');
    expect(numpadSource).toContain('Math.floor(initialValue)');
    // Decimal/zero mode: no flooring of the seed, parseFloat confirm (0 + decimals, no truncation),
    // and a decimal-point key layout — all gated behind the opt-in flags.
    expect(numpadSource).toContain('allowDecimal ? Math.max(0, initialValue)');
    expect(numpadSource).toContain('parseFloat(input)');
    expect(numpadSource).toContain('NUMPAD_KEYS_DECIMAL');
    // Still touch-only — no hardware-key / IME / Escape path introduced by the new modes.
    expect(numpadSource).not.toContain('onKeyDown');
    expect(numpadSource).not.toContain('isComposing');
  });
});

// ─── G. Bill-discount numpad Clear ACTION, not in-grid key (D4-D2 UAT follow-up) ──────
describe('7C-D4-D2 · Bill-discount numpad Clear action (POSPage.tsx / NumpadDialog.tsx)', () => {
  /** Region of the bill-discount NumpadDialog element (title → its closing `/>`). */
  function discNumpadRegion(): string {
    return region(posSource, 'title="ส่วนลดท้ายบิล"', '/>');
  }

  test('the D4-D1 in-grid Clear key / 13-key Clear layout is fully removed (no 5th grid row)', () => {
    // UAT rejected the in-grid Clear because it auto-flowed to a 5th row and read as a layout bug.
    // The 13-key layout constant and its opt-in prop are gone; only the clean 3×4 layouts remain.
    expect(numpadSource).not.toContain('NUMPAD_KEYS_DECIMAL_CLEAR');
    expect(numpadSource).not.toContain('allowClear');
    expect(numpadSource).not.toContain("'.', '0', '⌫', 'C'");
    // The bill-discount caller no longer opts into the removed in-grid Clear.
    expect(discNumpadRegion()).not.toContain('allowClear');
  });

  test('the bill-discount numpad exposes a separate ล้างส่วนลด action, shown only when present', () => {
    const disc = discNumpadRegion();
    // A discount-only Clear ACTION (not an in-grid key), with the agreed unambiguous label.
    expect(disc).toContain('clearLabel="ล้างส่วนลด"');
    expect(disc).toContain('onClear={');
    // Visible only when a bill discount actually exists (non-zero) — hidden otherwise.
    expect(disc).toContain('showClearAction={cart.billDiscValue > 0}');
  });

  test('the ล้างส่วนลด action sets the bill discount to 0 via the existing setter and closes', () => {
    const disc = discNumpadRegion();
    // Reuses the existing bill-discount setter (no new cart write path) and follows the dialog
    // action pattern: set 0 → close → return focus to scan.
    expect(disc).toMatch(
      /onClear=\{\(\) => \{\s*cart\.setBillDiscValue\(0\);\s*setDiscNumpadOpen\(false\);\s*focusSearch\(\);/,
    );
  });

  test('the Clear action is opt-in for the bill-discount path only (QTY numpad excluded)', () => {
    const qty = region(posSource, '<NumpadDialog', '<SortingSettingsModal');
    expect(qty).toContain('setLineQty');
    // The quantity numpad receives none of the discount-only flags (clear action OR decimal/zero).
    expect(qty).not.toContain('showClearAction');
    expect(qty).not.toContain('clearLabel');
    expect(qty).not.toContain('onClear');
    expect(qty).not.toContain('allowDecimal');
    expect(qty).not.toContain('allowZero');
  });

  test('NumpadDialog renders the Clear action below the keypad, gated + defaulted OFF', () => {
    // Opt-in + backwards-compatible: default off, so no existing caller (incl. quantity) changes.
    expect(numpadSource).toContain('showClearAction = false');
    expect(numpadSource).toContain('clearLabel');
    expect(numpadSource).toContain('onClear');
    // The action is a footer button gated behind all three props — never an extra grid key.
    expect(numpadSource).toMatch(
      /showClearAction && onClear && clearLabel[\s\S]{0,80}className="npd-clear"/,
    );
    // It is rendered AFTER the keypad grid and BEFORE confirm (separate footer action).
    const gridIdx = numpadSource.indexOf('className="npd-grid"');
    const clearIdx = numpadSource.indexOf('className="npd-clear"');
    const confirmIdx = numpadSource.indexOf('className="npd-confirm"');
    expect(gridIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(gridIdx);
    expect(confirmIdx).toBeGreaterThan(clearIdx);
  });

  test('decimal + zero support remain intact after the in-grid Clear removal', () => {
    const disc = discNumpadRegion();
    expect(disc).toContain('allowDecimal');
    expect(disc).toContain('allowZero');
    // Free-numeric seed/confirm path unchanged — 0 and decimals stay enterable, no flooring.
    expect(numpadSource).toContain('NUMPAD_KEYS_DECIMAL');
    expect(numpadSource).toContain('allowDecimal ? Math.max(0, initialValue)');
    expect(numpadSource).toContain('parseFloat(input) || 0');
  });

  test('quantity numpad integer contract is untouched by the Clear-action refactor', () => {
    expect(numpadSource).toContain('parseInt(input, 10)');
    expect(numpadSource).toContain('กรุณาระบุจำนวนที่มากกว่า 0');
    expect(numpadSource).toContain('Math.floor(initialValue)');
  });

  test('NumpadDialog stays touch-only (no hardware-key / IME / Escape path) post-refactor', () => {
    expect(numpadSource).not.toContain('onKeyDown');
    expect(numpadSource).not.toContain('isComposing');
    expect(numpadSource).not.toContain('Escape');
  });

  test('F12 + Escape contracts still include the discount numpad (D4-C/D4-D unchanged)', () => {
    const pred = region(posSource, 'const hasBlockingModalOpen = Boolean(', ');');
    expect(pred).toContain('discNumpadOpen');
    const body = region(posSource, 'const closeTopModalOnEscape = useCallback', '}, [');
    expect(body).toContain('setDiscNumpadOpen(false);');
  });

  test('UOM barcode scan routing is unchanged by D4-D2 (SKU before UOM barcode)', () => {
    const fn = region(posSource, 'function findByScanCode', '\n}');
    const topLevelIdx = fn.indexOf('p.sku === trimmed');
    const uomIdx = fn.indexOf('p.uomOptions.find(');
    expect(topLevelIdx).toBeGreaterThan(-1);
    expect(uomIdx).toBeGreaterThan(-1);
    expect(topLevelIdx).toBeLessThan(uomIdx);
  });
});

// ─── D. Native keyboard payment-confirm = strict RED path ──────────────────────────
describe('7C-D4-A · Payment confirm is a guarded RED path (PaymentModal.tsx / NumpadDialog.tsx)', () => {
  test('confirm is a native button (keyboard-activatable on focus) — never silent', () => {
    // The confirm control is a real <button type="button"> (so a focused Enter/Space DOES
    // activate it) gated by disabled, with the action behind onClick → handleConfirm.
    expect(paymentSource).toMatch(
      /<button\s+type="button"\s+className="pay-confirm"\s+disabled=\{!canConfirm \|\| busy\}\s+onClick=\{\(\) => void handleConfirm\(\)\}/,
    );
  });

  test('handleConfirm fails closed against double-submit (canConfirm/confirming/processing)', () => {
    expect(paymentSource).toContain('if (!canConfirm || confirming || processing) return;');
  });

  test('PaymentModal adds NO explicit modal-level key handler into handleConfirm', () => {
    // Payment confirm is keyboard-activatable via native <button> semantics when focused
    // (Tab + Enter/Space), which is exactly why it remains a Red payment-confirm surface.
    // This asserts only that no EXTRA modal-level keydown/composition path is wired into
    // handleConfirm — it does NOT claim the control is unreachable by keyboard.
    expect(paymentSource).not.toContain('onKeyDown');
    expect(paymentSource).not.toContain('isComposing');
  });

  test('NumpadDialog is touch-only: confirm via onClick, no hardware-key / Enter path', () => {
    expect(numpadSource).toContain('onClick={handleConfirm}');
    expect(numpadSource).not.toContain('onKeyDown');
    expect(numpadSource).not.toContain('isComposing');
  });
});

// ─── H. Product Picker multi-UOM selection queue (Phase 7C-L1 / LOGIC-01) ─────────────
describe('7C-L1 · Product Picker multi-UOM selection queue (POSPage.tsx)', () => {
  test('a pending-UOM queue exists, separate from the single display slot', () => {
    // LOGIC-01 root cause: `uomProduct` is one slot, so a batch of multi-UOM products overwrote
    // it (only the last survived). The queue holds the rest; the display slot stays a single
    // product (its existing F12/Escape contract is unchanged).
    expect(posSource).toContain('const [uomQueue, setUomQueue] = useState<PosProduct[]>([]);');
    expect(posSource).toContain('const [uomProduct, setUomProduct] = useState<PosProduct | null>(null);');
  });

  test('onProductClick ENQUEUES multi-UOM products instead of overwriting uomProduct', () => {
    const fn = region(posSource, 'const onProductClick = useCallback', '[cart, focusSearch],');
    expect(fn).toContain('product.uomOptions.length > 1');
    // The fix: append to the queue (functional updater → no stale read during the batch loop).
    expect(fn).toContain('setUomQueue((q) => [...q, product]);');
    // The overwrite is gone — onProductClick no longer writes the single slot directly.
    expect(fn).not.toContain('setUomProduct(product)');
    // Single-UOM behavior is unchanged: still an immediate direct add.
    expect(fn).toContain('cart.addToCart(product, product.uomOptions[0]!);');
  });

  test('the drain effect promotes the next queued product only when idle, in selection order', () => {
    const eff = region(
      posSource,
      'if (uomProduct === null && uomQueue.length > 0)',
      '}, [uomProduct, uomQueue]);',
    );
    // Promote the head (FIFO order) and remove it from the queue. Runs only when no modal shows,
    // so confirm/cancel (which null the slot) deterministically advance to the next product.
    expect(eff).toContain('setUomProduct(uomQueue[0]!);');
    expect(eff).toContain('setUomQueue((q) => q.slice(1));');
  });

  test('the picker confirm routes EVERY selected product through onProductClick (no overwrite)', () => {
    const pick = region(posSource, '<ProductPickerDialog', 'onClose=');
    // Resolves the selection then routes every resolved product through onProductClick (with the
    // batch-wide skipFocus decision). No direct slot overwrite.
    expect(pick).toContain('for (const product of resolved)');
    expect(pick).toContain('onProductClick(product, { skipFocus: willOpenUom });');
  });

  test('the pending batch keeps F12 suppressed across items (uomQueue in the blocking predicate)', () => {
    // F12 must not stack PaymentModal mid-batch, including the brief slot-null moment between
    // queued items. Both the display slot and the queue gate the shortcut.
    const pred = region(posSource, 'const hasBlockingModalOpen = Boolean(', ');');
    expect(pred).toContain('uomProduct');
    expect(pred).toContain('uomQueue.length > 0');
  });

  test('UOM confirm adds the CURRENT product then nulls the slot so the queue advances', () => {
    const uom = region(posSource, '<UomModal', '<ItemDiscountModal');
    expect(uom).toMatch(
      /if \(uomProduct\) cart\.addToCart\(uomProduct, opt\);[\s\S]{0,40}setUomProduct\(null\);/,
    );
  });

  test('UOM cancel/close NEVER adds to cart (no silent add of an unchosen unit)', () => {
    // Cancel semantics (Phase 7C-L1): closing the current UOM modal skips ONLY that product and
    // advances to the next pending one — it must never add a product whose unit was not chosen.
    const uom = region(posSource, '<UomModal', '<ItemDiscountModal');
    const close = region(uom, 'onClose={', '}}');
    expect(close).toContain('setUomProduct(null);');
    expect(close).not.toContain('addToCart');
  });

  test('Escape still cancels the UOM modal via setUomProduct(null), no cart write (D4-C-4 intact)', () => {
    const body = region(posSource, 'const closeTopModalOnEscape = useCallback', '}, [');
    expect(body).toMatch(/if \(uomProduct\) \{\s*setUomProduct\(null\);[\s\S]{0,40}return true;/);
    const uomBranch = region(body, '// 4. UOM', '// 5. Item discount');
    expect(uomBranch).not.toContain('addToCart');
    expect(uomBranch).not.toContain('cart.');
  });

  test('scan-to-UOM direct-add path (D4-D Fix 1) is unchanged by the queue', () => {
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toContain('cart.addToCart(match.product, match.option);');
    expect(h).toContain('onProductClick(match.product);');
  });
});

// ─── I. UOM barcode matched-unit display hint (Phase 7C-L3) ───────────────────────────
describe('7C-L3 · UOM barcode matched-unit display hint (POSPage.tsx)', () => {
  /** Body of the derived hint memo (its `useMemo(` → dep array). */
  function hintMemo(): string {
    return region(posSource, 'const scanUomHint = useMemo', '[search, products]);');
  }

  test('a derived scanUomHint surfaces the matched product + unit ONLY for a UOM-barcode match', () => {
    const fn = hintMemo();
    // Derived from the SAME findByScanCode the scan handler uses (no separate matcher).
    expect(fn).toContain('findByScanCode(products, trimmed)');
    // Surfaces only when a UOM-specific option matched (match.option set); SKU / product-level
    // (option === null), text searches, and misses all yield null → those displays unchanged.
    expect(fn).toContain('match?.option');
    expect(fn).toContain('match.option.unit');
    expect(fn).toContain('match.product.name');
    expect(fn).toContain('return null;');
  });

  test('the hint memo is pure/read-only — it never adds to cart or mutates scan/search state', () => {
    const fn = hintMemo();
    expect(fn).not.toContain('addToCart');
    expect(fn).not.toContain('setSearch');
    expect(fn).not.toContain('setUom');
  });

  test('the matched-UOM hint surfaces the product name + unit label as plain text (no new CSS)', () => {
    // L3 Revision 2: the matched-UOM text now lives in the permanent status-bar projection
    // (`posStatusBar`) rather than a conditional element, but it still surfaces the same derived
    // product name + unit with the app-wide Thai unit terminology, rendered as an accessible status.
    const proj = region(posSource, 'const posStatusBar = useMemo', '[scanUomHint]);');
    expect(proj).toContain('scanUomHint.productName');
    expect(proj).toContain('scanUomHint.unit');
    expect(proj).toContain('หน่วย');
    const bar = region(posSource, 'py-1.5 text-xs font-medium ${', '</span>');
    expect(bar).toContain('role="status"');
  });

  test('the Enter direct-UOM add path (D4-D Fix 1) is unchanged by the display hint', () => {
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toContain('const match = findByScanCode(products, trimmed);');
    expect(h).toContain('cart.addToCart(match.product, match.option);');
    expect(h).toContain('onProductClick(match.product);');
  });

  test('product-level / SKU matches and scan MISS behaviour are unchanged by L3', () => {
    // findByScanCode priority is intact (SKU before UOM barcode → product-level still option null).
    const fn = region(posSource, 'function findByScanCode', '\n}');
    expect(fn.indexOf('p.sku === trimmed')).toBeLessThan(fn.indexOf('p.uomOptions.find('));
    // Miss is still toast-only (no setSearch('') / focus reset on a miss).
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toMatch(/else \{\s*showToast\('ไม่พบสินค้านี้'\);\s*\}/);
  });

  test('the hint is derived state only — no new cart/checkout/write path introduced by L3', () => {
    const fn = hintMemo();
    expect(fn).not.toContain('confirmSale');
    expect(fn).not.toContain('setBillDiscValue');
    expect(fn).not.toContain('setRawCart');
  });
});

// ─── I-Rev2. Permanent System Status & Alert Bar (Phase 7C-L3 Revision 2) ─────────────
// Physical UAT rejected Revision 1: relocating the hint below the search bar fixed input
// crowding, but the hint still mounted/unmounted conditionally, so the product grid below
// shifted every time a UOM barcode matched. Revision 2 makes the space a PERMANENTLY mounted
// `System Status & Alert Bar`: always present (no layout shift), showing a default idle hint
// and overriding it with the UOM-match text. `posStatusBar` is a pure projection of the
// existing `scanUomHint` — no new matcher, no backend/promo/remote-config logic this slice.
describe('7C-L3 Revision 2 · Permanent System Status & Alert Bar (POSPage.tsx)', () => {
  /** The search-input row (search bar container): its open → the header close. */
  function searchRow(): string {
    return region(posSource, 'className="pos-search-group"', '</header>');
  }
  /** The status-bar projection memo: its `useMemo(` → dep array. CRLF/LF agnostic markers. */
  function projection(): string {
    return region(posSource, 'const posStatusBar = useMemo', '[scanUomHint]);');
  }
  /** The rendered status-bar element. Anchored on the template-literal className `${` (unique to
      the bar element — the comment phrase also appears in the memo comment) → its text span close.
      Newline-free markers, so CRLF/LF agnostic. Captures className + a11y attrs + the text span. */
  function statusBar(): string {
    return region(posSource, 'py-1.5 text-xs font-medium ${', '</span>');
  }
  /** Everything between the search header and the product/cart content row. */
  function belowHeader(): string {
    return region(posSource, '</header>', 'className="pos-content-row"');
  }

  test('the status bar is ALWAYS mounted — not wrapped in any conditional render', () => {
    // Layout-shift fix: the bar must render unconditionally so the content row below never moves.
    const below = belowHeader();
    expect(below).toContain('role="status"');
    expect(below).toContain('data-status-tone={posStatusBar.tone}');
    // No `{scanUomHint && (` / `&& (` conditional mount wrapper around the bar (text changes only).
    expect(below).not.toContain('{scanUomHint &&');
    expect(below).not.toContain('&& (');
    // The bar renders the single projected text node — one source of truth for both states.
    expect(below).toContain('{posStatusBar.text}');
  });

  test('the default state shows the idle scan/search hint (no dead space)', () => {
    // When no UOM barcode matches, the bar is the default tone with the 💡 idle hint — the
    // reserved space is never blank.
    const proj = projection();
    expect(proj).toContain("tone: 'default' as const");
    expect(proj).toContain('💡 สแกนบาร์โค้ด หรือพิมพ์ชื่อสินค้า, รหัส (SKU) เพื่อค้นหา');
    // The default is the fall-through return (the UOM branch is checked first, then default).
    const uomIdx = proj.indexOf("tone: 'uom'");
    const defaultIdx = proj.indexOf("tone: 'default'");
    expect(uomIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(uomIdx);
  });

  test('the UOM-match state overrides the default with the matched product + unit + Enter cue', () => {
    const proj = projection();
    // Gated on the existing derived hint — a pure projection, NOT a second matcher.
    expect(proj).toContain('if (scanUomHint)');
    expect(proj).toContain("tone: 'uom' as const");
    expect(proj).toContain('พบสินค้า');
    expect(proj).toContain('${scanUomHint.productName}');
    expect(proj).toContain('หน่วย');
    expect(proj).toContain('${scanUomHint.unit}');
    expect(proj).toContain('กด Enter เพื่อเพิ่ม');
  });

  test('the status bar lives BELOW the search/header area and BEFORE the product content row', () => {
    const headerEnd = posSource.indexOf('</header>');
    const barIdx = posSource.indexOf('data-status-tone={posStatusBar.tone}');
    const contentIdx = posSource.indexOf('className="pos-content-row"');
    expect(headerEnd).toBeGreaterThan(-1);
    expect(barIdx).toBeGreaterThan(headerEnd);
    expect(contentIdx).toBeGreaterThan(barIdx);
  });

  test('the status bar does NOT live inside the pos-search-group / search input row', () => {
    const row = searchRow();
    expect(row).not.toContain('posStatusBar');
    expect(row).not.toContain('data-status-tone');
    // The search input element itself is untouched (still autoFocus + ref + scan handler wired).
    expect(row).toContain('id="pos-search"');
    expect(row).toContain('ref={searchInputRef}');
    expect(row).toContain('onKeyDown={handleSearchKeyDown}');
  });

  test('the status bar can wrap long names — no width-compressing utilities', () => {
    const bar = statusBar();
    expect(bar).not.toContain('whitespace-nowrap');
    expect(bar).not.toContain('truncate');
    expect(bar).not.toContain('w-[');
    expect(bar).not.toContain('max-w-');
    // Announced politely as an accessible status region.
    expect(bar).toContain('role="status"');
    expect(bar).toContain('aria-live="polite"');
  });

  test('the status bar introduced NO new CSS file/import and NO new pos- CSS class', () => {
    expect(countOccurrences(posSource, "import './POSPage.css';")).toBe(1);
    expect(countOccurrences(posSource, ".css'")).toBe(1);
    expect(statusBar()).not.toContain('className="pos-');
  });

  test('the status bar carries NO backend / promo / Firebase / remote-config logic this slice', () => {
    // Future-ready model only: the two authorized states are pure local text — no data hooks.
    const surfaces = projection() + statusBar();
    for (const forbidden of [
      'firebase',
      'firestore',
      'getDoc',
      'getDocs',
      'onSnapshot',
      'remoteConfig',
      'httpsCallable',
      'fetch(',
      'useEffect',
    ]) {
      expect(surfaces).not.toContain(forbidden);
    }
  });

  test('posStatusBar is a pure projection of scanUomHint — no second matcher, derived-only', () => {
    const proj = projection();
    // Derives from the already-computed hint, never re-runs the scan lookup.
    expect(proj).not.toContain('findByScanCode');
    expect(proj).not.toContain('addToCart');
    expect(proj).not.toContain('setSearch');
    // The memo depends ONLY on the derived hint.
    expect(proj).toContain('scanUomHint');
  });

  test('scanUomHint stays a pure/read-only derivation after the status-bar refactor', () => {
    const fn = region(posSource, 'const scanUomHint = useMemo', '[search, products]);');
    expect(fn).toContain('findByScanCode(products, trimmed)');
    expect(fn).toContain('match?.option');
    expect(fn).not.toContain('addToCart');
    expect(fn).not.toContain('setSearch');
    expect(fn).not.toContain('setUom');
  });

  test('the Enter direct-UOM add path is UNCHANGED by the status bar', () => {
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toContain('const match = findByScanCode(products, trimmed);');
    expect(h).toContain('cart.addToCart(match.product, match.option);');
    expect(h).toContain('onProductClick(match.product);');
    expect(h).toContain("setSearch('')");
    expect(h).toContain('focusSearch();');
  });

  test('product-level / SKU priority and scan MISS behaviour are UNCHANGED by the revision', () => {
    const fn = region(posSource, 'function findByScanCode', '\n}');
    expect(fn.indexOf('p.sku === trimmed')).toBeLessThan(fn.indexOf('p.uomOptions.find('));
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    // Miss stays toast-only (no setSearch('') / focus reset), so a mistyped code is correctable.
    expect(h).toMatch(/else \{\s*showToast\('ไม่พบสินค้านี้'\);\s*\}/);
  });

  test('the status bar introduces NO checkout/payment/cart-mutation/write path', () => {
    const surfaces = projection() + statusBar();
    for (const forbidden of [
      'addToCart',
      'setSearch',
      'confirmSale',
      'setBillDiscValue',
      'setRawCart',
      'setPaymentOpen',
      'onClick',
    ]) {
      expect(surfaces).not.toContain(forbidden);
    }
  });
});

// ─── J. Best Seller system + All-tab removal (Phase 7C-UI-10-B / Option A) ─────────────
// Restores the ⭐ สินค้าขายดี tab as the first/default POS tab and removes the legacy
// "ทั้งหมด" (All) tab. Membership is the new global `Product.isBestSeller` flag, projected
// into `PosProduct` by the mapper; the POS ⭐ tab filters on it while keeping the existing
// per-branch `sorting['best-sellers']` order for sorting only (membership ≠ ordering).
describe('7C-UI-10-B · Best Seller system + All-tab removal (POSPage.tsx)', () => {
  /** The POS category pill bar (tabs): its open → the loading/grid switch. */
  function catBar(): string {
    return region(posSource, 'className="pos-cat-bar"', '{loading ?');
  }
  /** The product-filter memo: its `useMemo(` → its dep array. */
  function filterMemo(): string {
    return region(posSource, 'const filteredProducts = useMemo', '}, [');
  }

  test('the "ทั้งหมด" (All) tab is fully removed from POS — pill bar AND category overlay', () => {
    // The legacy All label is gone from the runtime category tabs and the overlay grid
    // (the only remaining "ทั้งหมด" in the page is the unrelated clear-cart confirmation copy).
    expect(catBar()).not.toContain('ทั้งหมด');
    const overlay = region(posSource, 'className="pos-category-grid"', '</button>');
    expect(overlay).not.toContain('ทั้งหมด');
    // The legacy All sentinel handlers (`selectCategory('')` / `setActiveCategory('')`) are
    // gone everywhere, so All cannot reappear via either entry point.
    expect(posSource).not.toContain("selectCategory('')");
    expect(posSource).not.toContain("setActiveCategory('')");
  });

  test('the ⭐ สินค้าขายดี tab exists and is the FIRST tab in the pill bar', () => {
    const bar = catBar();
    expect(bar).toContain('⭐ สินค้าขายดี');
    expect(bar).toContain('selectCategory(BEST_SELLERS_KEY)');
    // First: the best-sellers pill precedes both the quick-menu list and the category list.
    const bestIdx = bar.indexOf('⭐ สินค้าขายดี');
    const quickIdx = bar.indexOf('activeQuickMenus.map');
    const catIdx = bar.indexOf('visibleCategories.map');
    expect(bestIdx).toBeGreaterThan(-1);
    expect(quickIdx).toBeGreaterThan(bestIdx);
    expect(catIdx).toBeGreaterThan(bestIdx);
  });

  test('the ⭐ สินค้าขายดี tab is the DEFAULT active tab on load', () => {
    // activeCategory initializes to the best-sellers sentinel (not the removed '' / All).
    expect(posSource).toContain('const [activeCategory, setActiveCategory] = useState<string>(BEST_SELLERS_KEY);');
    // The pill highlights when the sentinel is active and no quick menu is selected.
    expect(catBar()).toContain("activeCategory === BEST_SELLERS_KEY && !activeQuickMenuId ? ' on' : ''");
  });

  test('the category overlay offers ⭐ สินค้าขายดี (not All) and routes through the shared helper', () => {
    const overlay = region(posSource, 'className="pos-category-grid"', '</button>');
    expect(overlay).toContain('⭐ สินค้าขายดี');
    // Revision: overlay selection goes through selectCategoryFromOverlay (which clears the
    // Quick Menu via selectCategory) — NOT a bare setActiveCategory that left the Quick Menu live.
    expect(overlay).toContain('selectCategoryFromOverlay(BEST_SELLERS_KEY)');
    expect(overlay).not.toContain('setActiveCategory(BEST_SELLERS_KEY)');
  });

  test('the best-seller grid filters on the mapped PosProduct.isBestSeller === true', () => {
    const fn = filterMemo();
    expect(fn).toContain('activeCategory === BEST_SELLERS_KEY');
    expect(fn).toContain('p.isBestSeller === true');
  });

  test('best-seller results still order via the existing sorting["best-sellers"] (ordering only)', () => {
    const fn = filterMemo();
    // sortKey collapses to BEST_SELLERS_KEY for the ⭐ tab; the self-healing reader is reused.
    expect(fn).toContain('BEST_SELLERS_KEY');
    expect(fn).toContain('sortProductsByCustomOrder(filtered, sorting[sortKey])');
    // Membership is NOT derived from the ordering array (Option B rejected).
    expect(fn).not.toContain("sorting['best-sellers'].");
    expect(fn).not.toContain('sorting[BEST_SELLERS_KEY].includes');
  });

  test('UI-10-C: search is a STRICT LOCAL filter inside the ⭐ tab (intersection, no escape)', () => {
    const fn = filterMemo();
    // UAT reversed the old global-search escape: typing now narrows the best-seller set only.
    // Membership AND search must both hold; a matching non-best-seller can never surface here.
    expect(fn).toContain('p.isBestSeller === true && matchesSearch(p)');
    // The old escape (`q ? matchesSearch(p) : ...`) is gone — search never transcends the tab.
    expect(fn).not.toContain('q ? matchesSearch(p) : p.isBestSeller === true');
  });

  test('the no-best-sellers empty state text is present (grid never blank, can still search/scan)', () => {
    expect(posSource).toContain('ยังไม่มีสินค้าขายดี — เลือกหมวดหมู่อื่น หรือค้นหา/สแกนสินค้า');
  });

  test('the best-sellers virtual tab is preserved by the ghost-reset (never treated as missing)', () => {
    const eff = region(posSource, '// Ghost-active fallback', '}, [activeCategory, visibleCategories]);');
    // The sentinel short-circuits the reset, and the fallback default is best-sellers (NOT '').
    expect(eff).toContain('if (activeCategory === BEST_SELLERS_KEY) return;');
    expect(eff).toContain('resolveActiveCategory(activeCategory, visibleCategories, BEST_SELLERS_KEY)');
    expect(eff).not.toContain(", '');");
  });

  // ── Scanner / search / L1 / L3 regression guards (must stay byte-identical in intent) ──
  test('hardware scan + UOM direct-add + SKU priority + scan-miss are UNCHANGED by UI-10', () => {
    const fn = region(posSource, 'function findByScanCode', '\n}');
    expect(fn.indexOf('p.sku === trimmed')).toBeLessThan(fn.indexOf('p.uomOptions.find('));
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toContain('const match = findByScanCode(products, trimmed);');
    expect(h).toContain('cart.addToCart(match.product, match.option);');
    expect(h).toContain('onProductClick(match.product);');
    // Scan miss stays toast-only.
    expect(h).toMatch(/else \{\s*showToast\('ไม่พบสินค้านี้'\);\s*\}/);
  });

  test('L3 permanent status bar block remains present/unchanged', () => {
    expect(posSource).toContain('data-status-tone={posStatusBar.tone}');
    expect(posSource).toContain('{posStatusBar.text}');
  });

  test('L1 multi-UOM queue enqueue logic is untouched by UI-10', () => {
    const fn = region(posSource, 'const onProductClick = useCallback', '[cart, focusSearch],');
    expect(fn).toContain('setUomQueue((q) => [...q, product]);');
    expect(fn).toContain('cart.addToCart(product, product.uomOptions[0]!);');
  });
});

// ─── K. Best Seller data pipeline: schema → form → drawer → POS mapper (UI-10-B) ───────
describe('7C-UI-10-B · Best Seller data pipeline (Option A)', () => {
  test('the central Product type gains an optional isBestSeller flag (legacy-safe)', () => {
    expect(productTypesSource).toContain('isBestSeller?: boolean;');
    // It is a sibling of the other product attributes, NOT inside the per-branch settings type.
    const settings = region(productTypesSource, 'interface ProductBranchSetting', '}');
    expect(settings).not.toContain('isBestSeller');
  });

  test('PosProduct gains an optional isBestSeller flag for POS filtering', () => {
    const t = region(posTypesSource, 'export type PosProduct = {', '};');
    expect(t).toContain('isBestSeller?: boolean;');
  });

  test('the POS mapper projects raw product.isBestSeller, normalizing legacy/absent to false', () => {
    const fn = region(posMapperSource, 'export function toPosProduct', '\n}');
    expect(fn).toContain('isBestSeller: product.isBestSeller ?? false');
  });

  test('ProductFormData includes isBestSeller; emptyForm defaults it false', () => {
    expect(productCrudTypesSource).toContain('isBestSeller: boolean;');
    const empty = region(productCrudTypesSource, 'export function emptyForm', '\n}');
    expect(empty).toContain('isBestSeller: false,');
  });

  test('productToForm hydrates from product.isBestSeller ?? false (edit reflects stored value)', () => {
    const fn = region(productCrudTypesSource, 'export function productToForm', '\n}');
    expect(fn).toContain('isBestSeller: product.isBestSeller ?? false,');
  });

  test('formToProduct persists isBestSeller on the save payload', () => {
    const fn = region(productCrudTypesSource, 'export function formToProduct', '\n}');
    expect(fn).toContain('isBestSeller: form.isBestSeller,');
  });

  test('ProductDrawer renders the ⭐ สินค้าขายดี toggle + help text, bound to form.isBestSeller', () => {
    expect(productDrawerSource).toContain('⭐ สินค้าขายดี');
    expect(productDrawerSource).toContain('ติ๊กเพื่อให้สินค้านี้แสดงในแท็บ ⭐ สินค้าขายดี ของหน้า POS');
    expect(productDrawerSource).toContain('checked={form.isBestSeller}');
    expect(productDrawerSource).toContain("set('isBestSeller', v)");
  });

  test('Product CRUD never writes/mutates the per-branch best-seller SORTING docs', () => {
    // Membership-only boundary: the form/drawer must not call into the sharded ordering
    // store (write APIs / its doc path). Asserting the mutation surface specifically — the
    // word "best-sellers" may legitimately appear in copy/comments.
    const surfaces = productCrudTypesSource + productDrawerSource;
    for (const forbidden of [
      'saveProductSortOrder',
      'productSortingDocRef',
      'productSortingCollectionRef',
      'sorting/categories',
    ]) {
      expect(surfaces).not.toContain(forbidden);
    }
  });
});

// ─── L. Overlay category-selection parity (Phase 7C-UI-10-B Revision) ──────────────────
// Codex NEEDS REVISION: overlay category buttons called `setActiveCategory(...)` directly +
// `closeCatModal()`, bypassing `selectCategory(...)` which clears `activeQuickMenuId`. So a
// previously-active Quick Menu survived an overlay category pick and the grid stayed filtered
// by the old Quick Menu. Fix: both the pill bar AND the overlay must clear the Quick Menu.
describe('7C-UI-10-B Revision · Overlay category selection clears the Quick Menu (POSPage.tsx)', () => {
  test('selectCategory (the shared path) clears activeQuickMenuId then sets the category', () => {
    const fn = region(posSource, 'const selectCategory = useCallback', '}, [focusSearch]);');
    expect(fn).toContain('setActiveQuickMenuId(null);');
    expect(fn).toContain('setActiveCategory(catId);');
  });

  test('an overlay wrapper routes overlay picks through selectCategory AND closes the overlay', () => {
    // Single source of truth: the wrapper delegates to selectCategory (clears Quick Menu) and
    // then closes the modal — no duplicated state logic in the buttons.
    const fn = region(posSource, 'const selectCategoryFromOverlay = useCallback', '[selectCategory, closeCatModal]');
    expect(fn).toContain('selectCategory(catId);');
    expect(fn).toContain('closeCatModal();');
  });

  test('BOTH overlay cells (Best Seller + physical category) go through the shared wrapper', () => {
    const overlay = region(posSource, 'className="pos-category-grid"', '<NumpadDialog');
    // Best-seller cell and category-map cell both call the wrapper...
    expect(overlay).toContain('selectCategoryFromOverlay(BEST_SELLERS_KEY)');
    expect(overlay).toContain('selectCategoryFromOverlay(cat.id)');
    // ...and neither flips activeCategory directly anymore (the bug path is gone).
    expect(overlay).not.toContain('setActiveCategory(');
  });

  test('overlay category selection cannot leave a Quick Menu active (no bare setActiveCategory + close)', () => {
    // The exact bug shape — a direct setActiveCategory paired with closeCatModal in a button — is gone.
    const overlay = region(posSource, 'className="pos-category-grid"', '<NumpadDialog');
    expect(overlay).not.toMatch(/setActiveCategory\([^)]*\);\s*closeCatModal\(\);/);
  });

  test('pill-bar category + best-seller selection still use selectCategory (unchanged)', () => {
    const bar = region(posSource, 'className="pos-cat-bar"', '{loading ?');
    expect(bar).toContain('selectCategory(BEST_SELLERS_KEY)');
    expect(bar).toContain('selectCategory(cat.id)');
  });

  test('Quick Menu still takes precedence WHEN intentionally selected (behavior unchanged)', () => {
    // selectQuickMenu still sets the Quick Menu id; the filter still short-circuits to the
    // Quick Menu branch first. Only category SELECTION now reliably clears it.
    const sel = region(posSource, 'const selectQuickMenu = useCallback', '}, []);');
    expect(sel).toContain('setActiveQuickMenuId(id);');
    const fn = region(posSource, 'const filteredProducts = useMemo', '}, [');
    const quickIdx = fn.indexOf('if (activeQuickMenuId)');
    const bestIdx = fn.indexOf('activeCategory === BEST_SELLERS_KEY');
    expect(quickIdx).toBeGreaterThan(-1);
    // Quick Menu branch is evaluated before the best-seller/category branch (precedence intact).
    expect(quickIdx).toBeLessThan(bestIdx);
  });

  test('no regression: scanner / UOM-add / scan-miss / L3 status bar intact after the revision', () => {
    const fn = region(posSource, 'function findByScanCode', '\n}');
    expect(fn.indexOf('p.sku === trimmed')).toBeLessThan(fn.indexOf('p.uomOptions.find('));
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toContain('cart.addToCart(match.product, match.option);');
    expect(h).toMatch(/else \{\s*showToast\('ไม่พบสินค้านี้'\);\s*\}/);
    expect(posSource).toContain('data-status-tone={posStatusBar.tone}');
  });
});

// ─── M. UAT polish: strict local search + sorting-modal membership scope (Phase 7C-UI-10-C) ──
// Physical UAT: (1) the POS grid search escaped the active tab (global search devalued category
// navigation / lost context); (2) the sorting modal's best-sellers group leaked the WHOLE
// inventory because `SortableProduct` lacked `isBestSeller`. Fix: POS search becomes a strict
// intersection inside the active context, and the membership flag is threaded down the sorting
// data path (interface → store projection → modal scope) so the modal ranks flagged products only.
describe('7C-UI-10-C · POS local search is a strict intersection filter (POSPage.tsx)', () => {
  /** The product-filter memo: its `useMemo(` → its dep array. */
  function filterMemo(): string {
    return region(posSource, 'const filteredProducts = useMemo', '}, [');
  }

  test('Best Seller tab search intersects membership AND search (no escape to non-best-sellers)', () => {
    const fn = filterMemo();
    expect(fn).toContain('activeCategory === BEST_SELLERS_KEY');
    // Both conditions must hold — a matching non-best-seller can never surface in the ⭐ grid.
    expect(fn).toContain('p.isBestSeller === true && matchesSearch(p)');
  });

  test('the old global-search escape is GONE from the Best Seller branch', () => {
    const fn = filterMemo();
    expect(fn).not.toContain('q ? matchesSearch(p) : p.isBestSeller === true');
    // Search no longer acts as a global inventory escape for grid display in the ⭐ tab.
    expect(fn).not.toContain('q ? matchesSearch(p)');
  });

  test('physical category tab search intersects category membership AND search', () => {
    const fn = filterMemo();
    expect(fn).toContain('const matchCat = !activeCategory || p.category === activeCategory;');
    // Intersection — a matching product from ANOTHER category cannot leak into this grid.
    expect(fn).toContain('return matchCat && matchesSearch(p);');
  });

  test('Quick Menu search stays LOCAL to the Quick Menu set (intersection, unchanged)', () => {
    const fn = filterMemo();
    // The Quick Menu branch filters within its hand-picked ids AND the search — never escapes.
    expect(fn).toContain('idSet.has(p.id) && matchesSearch(p)');
    // Quick Menu precedence is intact (its branch is evaluated before category/best-seller).
    const quickIdx = fn.indexOf('if (activeQuickMenuId)');
    const bestIdx = fn.indexOf('activeCategory === BEST_SELLERS_KEY');
    expect(quickIdx).toBeGreaterThan(-1);
    expect(quickIdx).toBeLessThan(bestIdx);
  });

  test('scanner / direct-add stays INDEPENDENT of the visible grid filter (unchanged by UI-10-C)', () => {
    // findByScanCode keeps SKU-before-UOM priority and is not coupled to the grid memo.
    const fn = region(posSource, 'function findByScanCode', '\n}');
    expect(fn.indexOf('p.sku === trimmed')).toBeLessThan(fn.indexOf('p.uomOptions.find('));
    // Enter direct-UOM add + product-click routing unchanged.
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).toContain('const match = findByScanCode(products, trimmed);');
    expect(h).toContain('cart.addToCart(match.product, match.option);');
    expect(h).toContain('onProductClick(match.product);');
    // Scan miss stays toast-only (a mistyped code is correctable).
    expect(h).toMatch(/else \{\s*showToast\('ไม่พบสินค้านี้'\);\s*\}/);
  });

  test('hidden-product exact-code reveal is preserved (not collapsed by the local-search change)', () => {
    // The branch-hidden escape hatch (type an EXACT SKU/name/barcode to summon a hidden product)
    // is a separate, intentional behavior and is untouched by the tab-local search change.
    const fn = filterMemo();
    expect(fn).toContain('return isExactCodeMatch(p);');
  });
});

describe('7C-UI-10-C · Sorting modal best-seller membership scope (data path)', () => {
  test('SortableProduct carries the isBestSeller membership flag', () => {
    const iface = region(categoryServiceSource, 'export interface SortableProduct', '}');
    expect(iface).toContain('isBestSeller?: boolean;');
  });

  test('sortingStore projects Product.isBestSeller ?? false in BOTH the live and dev mappers', () => {
    // Two projections (devSortableProducts + the live useSortableProducts onSnapshot map).
    expect(countOccurrences(sortingStoreSource, 'isBestSeller: p.isBestSeller ?? false,')).toBe(2);
  });

  test('the modal scopes the best-sellers group to isBestSeller === true (no full-inventory leak)', () => {
    const scoped = region(sortingModalSource, 'const scoped =', 'void getProductSortOrder');
    expect(scoped).toContain('selectedKey === BEST_SELLERS_KEY');
    // Membership scope — the leak (`? products`) is replaced by a flagged filter.
    expect(scoped).toContain('products.filter((p) => p.isBestSeller === true)');
  });

  test('physical category sorting scope is UNCHANGED (still matchesCategoryFilter)', () => {
    const scoped = region(sortingModalSource, 'const scoped =', 'void getProductSortOrder');
    expect(scoped).toContain('matchesCategoryFilter(p.category, selectedKey, categories)');
  });

  test('membership is NOT derived from the ordering array (sorting["best-sellers"] stays ordering-only)', () => {
    const scoped = region(sortingModalSource, 'const scoped =', 'void getProductSortOrder');
    expect(scoped).not.toContain("sorting['best-sellers']");
    expect(scoped).not.toContain('sorting[BEST_SELLERS_KEY]');
    // The ordering is still applied by the sharded sort reader (write API unchanged).
    expect(sortingModalSource).toContain('sortProductsByCustomOrder(scoped, order)');
    expect(sortingModalSource).toContain('saveProductSortOrder(branchId, key, ids, expectedRev)');
  });
});

// ─── N. UI-12-FLOWBITE-TOAST · POSPage non-subscribing toast contract (POSPage.tsx) ───────
// Codex blocker 1: the old `toContain('useToast')` was a false green — it matched the
// substring inside `useToastDispatcher`, not a proof that POSPage avoids a subscribing
// `useToast()`. These assertions prove POSPage uses the STABLE dispatcher and never reads
// the toast array or wires a state setter/listener into the store (the flicker root cause).
describe('7C-UI-12-FLOWBITE-TOAST · POSPage uses a non-subscribing toast dispatcher (POSPage.tsx)', () => {
  test('POSPage imports + uses the stable useToastDispatcher from the toast store', () => {
    expect(posSource).toContain('useToastDispatcher');
    expect(posSource).toMatch(/import\s*\{[^}]*\buseToastDispatcher\b[^}]*\}\s*from\s*['"][^'"]*use-toast['"]/);
    // The dispatcher is actually invoked (the hook call), not merely imported.
    expect(posSource).toMatch(/useToastDispatcher\s*\(\s*\)/);
  });

  test('POSPage does NOT call the subscribing useToast() hook', () => {
    // `useToastDispatcher(` must NOT trip this; `\s*\(` only matches a bare `useToast(` call.
    expect(posSource).not.toMatch(/\buseToast\s*\(/);
  });

  test('POSPage does NOT read the toast array or wire a store listener (no re-render churn)', () => {
    expect(posSource).not.toContain('toasts');           // no `const { toasts }` / `toasts.map`
    expect(posSource).not.toContain('const { toast, toasts');
    expect(posSource).not.toContain('setToasts');         // no state setter pushed into the store
    expect(posSource).not.toContain('addToastListener');
  });

  test('POSPage no longer renders local pos-toast', () => {
    expect(posSource).not.toContain('className="pos-toast"');
  });

  test('POSPage no longer holds local toast state', () => {
    expect(posSource).not.toContain('const [toast, setToast] = useState<string | null>(null)');
    expect(posSource).not.toMatch(/\bsetToast\s*\(/);
  });

  test('POSPage still provides a stable toast dispatcher to cart + checkout', () => {
    const checkoutBlock = region(posSource, 'const checkout = useCheckout', '});');
    expect(checkoutBlock).toContain('showToast');
    expect(posSource).toContain('const cart = useCart({ products, customer, showToast });');
    // showToast wraps the stable dispatcher (globalToast), not a local setState.
    const showToastDef = region(posSource, 'const showToast = useCallback', '[globalToast]);');
    expect(showToastDef).toContain('globalToast');
  });
});
