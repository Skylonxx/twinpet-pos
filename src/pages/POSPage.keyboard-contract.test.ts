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

  test('GAP (locked): scan input has NO IME/composition guard today', () => {
    // Documented in D3-B as the sharpest real risk (Thai-IME Enter can fire a premature
    // scan). This asserts the CURRENT absence so adding a guard under D4-C is intentional.
    const h = region(posSource, 'const handleSearchKeyDown', 'const clearPosCart');
    expect(h).not.toContain('isComposing');
    expect(h).not.toContain('compositionstart');
    expect(h).not.toContain('compositionend');
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

  test('CURRENT GAP (locked): the NumpadDialog (qty) path provides NO focus-return contract', () => {
    // Documented in D3-B — not desired UX. Locked so a future fix under D4-C is deliberate.
    const numpad = region(posSource, '<NumpadDialog', '<SortingSettingsModal');
    expect(numpad).not.toContain('focusSearch');
  });

  test('GAP (locked): no focus-return after the UOM modal closes', () => {
    const uom = region(posSource, '<UomModal', '<ItemDiscountModal');
    expect(uom).not.toContain('focusSearch');
  });

  test('GAP (locked): no focus-return after the Item Discount modal closes', () => {
    const disc = region(posSource, '<ItemDiscountModal', '<ProductPickerDialog');
    expect(disc).not.toContain('focusSearch');
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
