// ─── Hold Bill / Suspended Bills contract ───────────────────────────────────────────
// Locks the hold-bill, recall, optional-note, customer-persist/restore, and backward-
// compatibility contracts. The project's vitest unit config runs in a `node` environment
// with no DOM, so React hooks and portals cannot be mounted. Following the established
// precedent (useCart.contract.test.ts / POSPage.keyboard-contract.test.ts), these tests
// combine source-level structural assertions (`?raw`) with direct execution of the PURE
// exported helpers from suspendedBills.ts.

import { describe, test, expect, beforeAll } from 'vitest';
import { cartLinesToRecord } from './suspendedBills';
import type { CartLine } from './types';

let suspendedBillsSource: string;
let posPageSource: string;
let holdBillModalSource: string;
let useCheckoutSource: string;

beforeAll(async () => {
  suspendedBillsSource = (await import('./suspendedBills.ts?raw')).default;
  posPageSource = (await import('../../pages/POSPage.tsx?raw')).default;
  holdBillModalSource = (
    await import('../../components/pos/SuspendedBillModals.tsx?raw')
  ).default;
  useCheckoutSource = (await import('../../hooks/pos/useCheckout.ts?raw')).default;
});

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function mkLine(
  unit: string,
  qty: number,
  unitFactor: number,
  productId = 'P1',
): CartLine {
  return {
    lineKey: `${productId}::${unit}`,
    productId,
    productName: 'สินค้าทดสอบ',
    category: 'cat',
    sku: 'SKU1',
    barcode: null,
    unit,
    unitFactor,
    unitPrice: 10,
    originalPrice: 10,
    qty,
    discount: { type: 'none', val: 0 },
  };
}

// ─── Goal 1: Hold Bill button wiring ──────────────────────────────────────────────────
describe('Hold Bill · button wiring (POSPage.tsx)', () => {
  test('handleHoldClick opens the hold-note modal when cart has items', () => {
    const fn = region(
      posPageSource,
      'const handleHoldClick',
      '[cartLines.length, showToast]',
    );
    expect(fn).toContain('setHoldNoteOpen(true)');
  });

  test('handleHoldClick shows toast and returns early when cart is empty', () => {
    const fn = region(
      posPageSource,
      'const handleHoldClick',
      '[cartLines.length, showToast]',
    );
    expect(fn).toContain('cartLines.length === 0');
    expect(fn).toContain('showToast');
    expect(fn).toContain('return;');
  });

  test('HoldBillNoteModal is wired with onConfirm={handleHoldConfirm}', () => {
    expect(posPageSource).toContain('onConfirm={handleHoldConfirm}');
  });

  test('handleHoldConfirm calls addBill, clearPosCart, and closes the modal', () => {
    const fn = region(
      posPageSource,
      'const handleHoldConfirm',
      '[addBill,',
    );
    expect(fn).toContain('addBill(bill)');
    expect(fn).toContain('clearPosCart()');
    expect(fn).toContain('setHoldNoteOpen(false)');
  });
});

// ─── Goal 2: Customer persist on hold ─────────────────────────────────────────────────
describe('Hold Bill · customer persist (POSPage.tsx)', () => {
  test('handleHoldConfirm snapshots the customer object into the suspended bill', () => {
    const fn = region(
      posPageSource,
      'const handleHoldConfirm',
      '[addBill,',
    );
    expect(fn).toContain('customer: customer ? { ...customer } : null');
  });

  test('handleHoldConfirm includes customerId for backward compat', () => {
    const fn = region(
      posPageSource,
      'const handleHoldConfirm',
      '[addBill,',
    );
    expect(fn).toContain("customerId: customer?.id ?? null");
  });

  test('null customer produces a valid bill (customer: null, customerId: null)', () => {
    const fn = region(
      posPageSource,
      'const handleHoldConfirm',
      '[addBill,',
    );
    expect(fn).toContain('customer ? { ...customer } : null');
    expect(fn).toContain("customer?.id ?? null");
  });
});

// ─── Goal 2: Customer restore on recall ───────────────────────────────────────────────
describe('Restore Bill · customer restore (POSPage.tsx)', () => {
  test('handleRestoreBill sets the customer from the bill snapshot', () => {
    const fn = region(
      posPageSource,
      'const handleRestoreBill',
      '[cartLines.length,',
    );
    expect(fn).toContain('checkout.setCustomer(bill.customer)');
  });

  test('handleRestoreBill restores cart lines via cart.restoreCart', () => {
    const fn = region(
      posPageSource,
      'const handleRestoreBill',
      '[cartLines.length,',
    );
    expect(fn).toContain('cart.restoreCart(bill)');
  });

  test('handleRestoreBill removes the bill and closes the list modal', () => {
    const fn = region(
      posPageSource,
      'const handleRestoreBill',
      '[cartLines.length,',
    );
    expect(fn).toContain('removeBill(bill.id)');
    expect(fn).toContain('setSuspendedListOpen(false)');
  });

  test('SuspendedBillsListModal is wired with onRestore={handleRestoreBill}', () => {
    expect(posPageSource).toContain('onRestore={handleRestoreBill}');
  });
});

// ─── Goal 2: useCheckout exposes setCustomer for restore ──────────────────────────────
describe('Restore Bill · useCheckout.setCustomer (useCheckout.ts)', () => {
  test('setCustomer is a useState setter returned in the hook', () => {
    expect(useCheckoutSource).toContain(
      'const [customer, setCustomer] = useState<PosCustomer | null>(null)',
    );
    expect(useCheckoutSource).toContain('setCustomer,');
  });
});

// ─── Goal 3: Optional note (empty submission allowed) ─────────────────────────────────
describe('Hold Bill · optional note (SuspendedBillModals.tsx)', () => {
  test('handleConfirm falls back to "—" when note is empty', () => {
    expect(holdBillModalSource).toContain("onConfirm(note.trim() || '—')");
  });

  test('confirm button has no disabled condition (always clickable)', () => {
    const btn = region(
      holdBillModalSource,
      "className=\"pos-sb-btn pos-sb-btn--primary\"",
      '</button>',
    );
    expect(btn).not.toContain('disabled');
  });

  test('Enter key in input triggers confirm (no extra click required)', () => {
    expect(holdBillModalSource).toContain("if (e.key === 'Enter')");
    expect(holdBillModalSource).toContain('handleConfirm()');
  });
});

// ─── Goal 2 + backward compat: SuspendedBill type and parseBill ───────────────────────
describe('Suspended Bill · backward compatibility (suspendedBills.ts)', () => {
  test('SuspendedBill type has customer field typed as PosCustomerPick | null', () => {
    expect(suspendedBillsSource).toContain('customer: PosCustomerPick | null');
  });

  test('parseBill defaults customer to null when field is missing (old bills)', () => {
    expect(suspendedBillsSource).toContain(
      'customer: (o.customer as PosCustomerPick | null) ?? null',
    );
  });

  test('parseBill defaults customerId to null when field is missing', () => {
    expect(suspendedBillsSource).toContain(
      "customerId: typeof o.customerId === 'string' ? o.customerId : null",
    );
  });

  test('parseBill defaults discount-related fields safely', () => {
    expect(suspendedBillsSource).toContain('discountPercent: Boolean(o.discountPercent)');
    expect(suspendedBillsSource).toContain(
      "feeRate: typeof o.feeRate === 'number' ? o.feeRate : 0",
    );
  });
});

// ─── Executable: cartLinesToRecord roundtrip ──────────────────────────────────────────
describe('Suspended Bill · cartLinesToRecord (executable)', () => {
  test('converts a line array into a keyed record preserving all fields', () => {
    const lines = [mkLine('ชิ้น', 3, 1)];
    const record = cartLinesToRecord(lines);
    expect(Object.keys(record)).toEqual(['P1::ชิ้น']);
    expect(record['P1::ชิ้น']!.qty).toBe(3);
    expect(record['P1::ชิ้น']!.productName).toBe('สินค้าทดสอบ');
  });

  test('multiple lines are keyed independently by lineKey', () => {
    const lines = [mkLine('ชิ้น', 2, 1), mkLine('ลัง', 1, 12)];
    const record = cartLinesToRecord(lines);
    expect(Object.keys(record)).toHaveLength(2);
    expect(record['P1::ชิ้น']!.qty).toBe(2);
    expect(record['P1::ลัง']!.qty).toBe(1);
    expect(record['P1::ลัง']!.unitFactor).toBe(12);
  });

  test('deep-copies each line (input mutation does not leak)', () => {
    const lines = [mkLine('ชิ้น', 1, 1)];
    const record = cartLinesToRecord(lines);
    lines[0]!.qty = 999;
    expect(record['P1::ชิ้น']!.qty).toBe(1);
  });

  test('empty input returns an empty record', () => {
    expect(cartLinesToRecord([])).toEqual({});
  });

  test('lines from different products coexist in the record', () => {
    const lines = [mkLine('ชิ้น', 1, 1, 'A'), mkLine('ชิ้น', 2, 1, 'B')];
    const record = cartLinesToRecord(lines);
    expect(Object.keys(record)).toEqual(['A::ชิ้น', 'B::ชิ้น']);
  });
});

// ─── Restore path: useCart.restoreCart seeds all bill-level state ──────────────────────
describe('Restore Bill · useCart.restoreCart seeds bill-level state (useCart.ts)', () => {
  let useCartSource: string;

  beforeAll(async () => {
    useCartSource = (await import('../../hooks/pos/useCart.ts?raw')).default;
  });

  test('restoreCart sets cart lines from bill.cartItems via cartLinesToRecord', () => {
    const fn = region(useCartSource, 'const restoreCart = useCallback', '}, []);');
    expect(fn).toContain('cartLinesToRecord(bill.cartItems)');
    expect(fn).toContain('setRawCart(restored)');
  });

  test('restoreCart seeds discount, discountPercent, and feeRate from the bill', () => {
    const fn = region(useCartSource, 'const restoreCart = useCallback', '}, []);');
    expect(fn).toContain('setBillDiscValue(bill.discount)');
    expect(fn).toContain('setBillDiscPercent(bill.discountPercent)');
    expect(fn).toContain('setFeeRate(bill.feeRate)');
  });

  test('restoreCart updates cartRef synchronously (same-tick correctness)', () => {
    const fn = region(useCartSource, 'const restoreCart = useCallback', '}, []);');
    expect(fn).toContain('cartRef.current = restored');
  });
});
