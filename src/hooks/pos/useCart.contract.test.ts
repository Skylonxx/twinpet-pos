// ─── Phase 7C-L2: Empty-cart bill-discount reset (money-correctness contract) ─────────
// `useCart` is a stateful React hook, and the project's vitest unit config runs in a
// `node` environment with no DOM (and no @testing-library / renderHook). So the hook
// cannot be mounted here. Mirroring the established POSPage `?raw` precedent
// (src/pages/POSPage.keyboard-contract.test.ts), these tests assert the structural
// money-correctness contract at the source level: a bill-level discount must NEVER
// survive an empty cart (a lingering discount would silently apply to the next sale).

import { describe, test, expect, beforeAll } from 'vitest';

let cartSource: string;

beforeAll(async () => {
  cartSource = (await import('./useCart.ts?raw')).default;
});

/** Slice a source between two markers so assertions target a specific construct. */
function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('7C-L2 · Empty-cart bill-level reset (useCart.ts)', () => {
  test('a shared resetBillLevel helper zeroes ALL bill-level fields (value, mode, fee)', () => {
    // Single source of truth for the bill-level cleanup — used by both the empty-cart effect
    // and clearCart, so the two can never drift apart (the Codex revision blocker).
    const fn = region(cartSource, 'const resetBillLevel = useCallback', '}, []);');
    expect(fn).toContain('setBillDiscValue(0);');
    expect(fn).toContain('setBillDiscPercent(false);');
    expect(fn).toContain('setFeeRate(0);');
  });

  test('the central empty-cart effect calls resetBillLevel under an all-fields guard', () => {
    // The reset lives in the cart-state layer (not per UI handler), keyed off the derived line
    // count, so EVERY emptying path (removeLine, qty→0, clear) is covered centrally. The guard
    // fires when ANY bill-level field is non-default and avoids loops on a fresh empty cart.
    const eff = region(
      cartSource,
      'if (cartLines.length === 0',
      '}, [cartLines.length, billDiscValue, billDiscPercent, feeRate, resetBillLevel]);',
    );
    expect(eff).toContain('billDiscValue !== 0');
    expect(eff).toContain('billDiscPercent');
    expect(eff).toContain('feeRate !== 0');
    expect(eff).toContain('resetBillLevel();');
    // No inline single-field reset — the helper owns the cleanup.
    expect(eff).not.toContain('setBillDiscValue(0);');
  });

  test('the reset effect depends on all bill-level fields + the helper (stays current)', () => {
    expect(cartSource).toContain(
      '}, [cartLines.length, billDiscValue, billDiscPercent, feeRate, resetBillLevel]);',
    );
  });

  test('clearCart resets bill-level state via the SAME shared helper (parity by construction)', () => {
    // POSPage routes new-sale, hold, and the clear-cart confirmation through cart.clearCart;
    // it now delegates the bill-level cleanup to resetBillLevel, identical to the empty-cart
    // effect — so feeRate / billDiscPercent / billDiscValue can never leak on either path.
    const fn = region(cartSource, 'const clearCart = useCallback', '}, [resetBillLevel]);');
    expect(fn).toContain('setRawCart({});');
    expect(fn).toContain('resetBillLevel();');
  });

  test('item-removal (removeLine) only deletes the line — the reset is centralised, not inline', () => {
    // removeLine / changeQty(qty<=0) / setLineQty(<=0) delete lines but do NOT reset bill-level
    // state inline; the central empty-cart effect (via resetBillLevel) is the single owner.
    const remove = region(cartSource, 'const removeLine = useCallback', '}, []);');
    expect(remove).toContain('delete next[lineKey];');
    expect(remove).not.toContain('setBillDiscValue');
    expect(remove).not.toContain('setFeeRate');
    expect(remove).not.toContain('resetBillLevel');
  });

  test('restoreCart still seeds discount/mode/fee from the suspended bill (not clobbered)', () => {
    // Restoring a parked bill repopulates lines AND its bill-level state together, so the cart
    // is never empty during restore → the empty-cart reset does not fire on it.
    const fn = region(cartSource, 'const restoreCart = useCallback', '}, []);');
    expect(fn).toContain('cartLinesToRecord(bill.cartItems)');
    expect(fn).toContain('setBillDiscValue(bill.discount);');
    expect(fn).toContain('setBillDiscPercent(bill.discountPercent);');
    expect(fn).toContain('setFeeRate(bill.feeRate);');
  });

  test('bill-level setters remain available (non-empty cart discount/fee behaviour unchanged)', () => {
    // The setters are still owned/exported by the hook and unchanged; the reset acts ONLY on an
    // empty cart, so a discount/fee on a cart that still has items is untouched.
    expect(cartSource).toContain('const [billDiscValue, setBillDiscValue] = useState(0);');
    expect(cartSource).toContain('const [billDiscPercent, setBillDiscPercent] = useState(false);');
    expect(cartSource).toContain('const [feeRate, setFeeRate] = useState(0);');
    expect(cartSource).toContain('setBillDiscValue,');
    expect(cartSource).toContain('setBillDiscPercent,');
    expect(cartSource).toContain('setFeeRate,');
  });

  test('totals math is untouched by L2 (no checkout/total semantics change)', () => {
    // The fix is a state reset only — calcCartTotals is still called with the same args, so
    // non-empty discount/fee totals and pre-sale checkout totals are unchanged.
    expect(cartSource).toContain('calcCartTotals(cartLines, billDiscValue, billDiscPercent, feeRate)');
  });
});
