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

beforeAll(async () => {
  posSource = (await import('./POSPage.tsx?raw')).default;
  paymentSource = (await import('../components/PaymentModal.tsx?raw')).default;
  numpadSource = (await import('../components/pos/NumpadDialog.tsx?raw')).default;
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
    const overlay = region(posSource, 'className="pos-category-overlay"', 'pos-toast');
    expect(overlay).toContain('closeCatModal');
    // The category cells still drive the filter; closing no longer leaves a bare
    // setCatModalOpen(false) un-refocused inside the overlay.
    expect(overlay).not.toContain('setCatModalOpen(false)');
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

// ─── G. Bill-discount numpad Clear affordance (D4-D1 UAT follow-up) ──────────────────
describe('7C-D4-D1 · Bill-discount numpad Clear affordance (POSPage.tsx / NumpadDialog.tsx)', () => {
  /** Region of the bill-discount NumpadDialog element (title → its closing `/>`). */
  function discNumpadRegion(): string {
    return region(posSource, 'title="ส่วนลดท้ายบิล"', '/>');
  }

  test('the bill-discount NumpadDialog opts into the Clear affordance (alongside decimal/zero)', () => {
    const disc = discNumpadRegion();
    expect(disc).toContain('allowClear');
    // Clear sits next to decimal/zero entry — it does not replace them.
    expect(disc).toContain('allowDecimal');
    expect(disc).toContain('allowZero');
  });

  test('Clear is opt-in: the QTY NumpadDialog receives none of the discount-only flags', () => {
    const qty = region(posSource, '<NumpadDialog', '<SortingSettingsModal');
    expect(qty).toContain('setLineQty');
    expect(qty).not.toContain('allowClear');
    expect(qty).not.toContain('allowDecimal');
    expect(qty).not.toContain('allowZero');
  });

  test('NumpadDialog gates the Clear key behind allowClear and defaults it OFF', () => {
    // Opt-in + backwards-compatible: default off, so no existing caller (incl. quantity) changes.
    expect(numpadSource).toContain('allowClear = false');
    expect(numpadSource).toContain('NUMPAD_KEYS_DECIMAL_CLEAR');
    // Decimal mode picks the Clear layout only when allowClear is set.
    expect(numpadSource).toMatch(/allowClear[\s\S]{0,30}NUMPAD_KEYS_DECIMAL_CLEAR/);
  });

  test('Clear empties the display and a free-numeric confirm resolves a cleared discount to 0', () => {
    // Pressing Clear (C) empties the input (existing handler); the free-numeric confirm then yields
    // 0, so confirming a cleared discount writes 0 through the existing bill setter.
    expect(numpadSource).toMatch(/if \(key === 'C'\) \{\s*setInput\(''\);/);
    expect(numpadSource).toContain('parseFloat(input) || 0');
    expect(discNumpadRegion()).toContain('cart.setBillDiscValue(');
  });

  test('decimal + zero support remain intact alongside Clear', () => {
    // The Clear layout is the decimal pad PLUS a trailing 'C' (so '.' and Clear coexist), and the
    // free-numeric seed/confirm path is unchanged — 0 and decimals stay enterable, no flooring.
    expect(numpadSource).toContain("'.', '0', '⌫', 'C'");
    expect(numpadSource).toContain('allowDecimal ? Math.max(0, initialValue)');
    expect(numpadSource).toContain('parseFloat(input)');
  });

  test('quantity numpad integer contract is untouched by the Clear follow-up', () => {
    expect(numpadSource).toContain('parseInt(input, 10)');
    expect(numpadSource).toContain('กรุณาระบุจำนวนที่มากกว่า 0');
    expect(numpadSource).toContain('Math.floor(initialValue)');
  });

  test('F12 + Escape contracts still include the discount numpad (D4-C/D4-D unchanged)', () => {
    const pred = region(posSource, 'const hasBlockingModalOpen = Boolean(', ');');
    expect(pred).toContain('discNumpadOpen');
    const body = region(posSource, 'const closeTopModalOnEscape = useCallback', '}, [');
    expect(body).toContain('setDiscNumpadOpen(false);');
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
