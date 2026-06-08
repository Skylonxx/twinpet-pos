/**
 * E2E: Human-Like Cashier Checkout
 *
 * Simulates a real cashier who is slightly forgetful, makes a typo, changes
 * their mind on quantity, picks a VIP customer, and completes a sale.
 *
 * Dev-mock credentials used (no Firebase required):
 *   User   : wichai / PIN 3456 / branch LDP-001 (staff role)
 *   Product: HSD-567 — Hill's Science Diet 5.67 kg @ ฿2,400
 *             VIP tier price = ฿2,100
 *   Customer: น้ำ แก้วกานต์ (customerType: "vip")
 *
 * Run with:
 *   npx playwright test tests/pos-human-checkout.spec.ts --headed
 */

import { expect, test } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Wait until localStorage has a valid `twinpet_session` entry (login done). */
async function waitForSession(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('twinpet_session');
      if (!raw) return false;
      try {
        const session = JSON.parse(raw);
        return Boolean(session?.user?.id && session?.branchId);
      } catch {
        return false;
      }
    },
    { timeout: 12_000 },
  );
}

/**
 * Log in as `wichai` (staff, branch LDP-001) via PIN keypad.
 * After this helper returns, `localStorage.twinpet_session` is set and the
 * caller can safely navigate to any protected route.
 */
async function loginAsWichai(page: import('@playwright/test').Page) {
  await page.goto('/login');

  // ── Sanity-check: confirm we are in dev-mock mode ────────────────────────
  // The login page renders a dev-hint line ("Dev: somchai/1234 · …") ONLY
  // when isFirebaseConfigured === false (i.e. all VITE_FIREBASE_* vars are
  // blank).  If this assertion fails, the server is running with real Firebase
  // credentials — check that `reuseExistingServer` is false in the config and
  // that `.env.test` is being loaded (Vite started with --mode test).
  await expect(page.locator('text=Dev: somchai')).toBeVisible({ timeout: 8_000 });

  // Wait for the <select> element itself to be visible.
  // Never wait on <option> directly — Playwright treats them as hidden.
  await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 8_000 });

  // ── Select LDP-001 branch ────────────────────────────────────────────────
  await page.selectOption('#branch-sel', 'LDP-001');

  // ── Enter PIN 3-4-5-6 via the on-screen keypad ──────────────────────────
  // handlePinPress reads `pinValue` from its useCallback closure.  Playwright
  // dispatches clicks faster than React re-renders, so without a pause every
  // press sees the same stale `pinValue = ''` and the PIN string never builds
  // up correctly.  350 ms > a typical React render + event-loop tick, so each
  // click lands on a fresh closure with the updated pinValue.
  for (const digit of ['3', '4', '5', '6']) {
    await page.click(`.login-pin-btn:text-is("${digit}")`);
    await page.waitForTimeout(350);
  }
  // No manual submit click needed — the component auto-submits via
  // window.setTimeout(..., 200) when pinValue reaches 4 digits.

  // If the PIN was rejected (wrong credentials or bcrypt timing issue) the
  // error div becomes visible.  Surface it immediately so the failure message
  // names the real cause instead of showing a cryptic localStorage timeout.
  const pinError = page.locator('#pin-error');
  await page.waitForTimeout(600); // let the async loginWithPin call settle
  if (await pinError.isVisible()) {
    const msg = (await pinError.textContent())?.trim() ?? '(unknown)';
    throw new Error(`PIN login failed — UI error: "${msg}"`);
  }

  // Poll localStorage until completeLogin() has written the session.
  // This is the authoritative "login finished" signal (resolves after the
  // 2.2 s success animation + async completeLogin promise).
  await waitForSession(page);
}

// ─── Shared fixture: navigate to /pos and wait for the product grid ─────────

async function goToPOS(page: import('@playwright/test').Page) {
  await page.goto('/pos');
  // The product grid (or loading overlay) signals the POS shell has mounted.
  await page.waitForSelector('.pos-checkout-btn', { timeout: 10_000 });
}

// ─── Selectors (kept as constants so a class rename is a 1-line fix) ────────

const SEL = {
  searchInput: 'input[placeholder*="barcode"]',
  checkoutBtn: '.pos-checkout-btn',
  toast: '.pos-toast',
  shiftDialog: '[role="dialog"][aria-label="เปิดกะ"]',
  shiftCashInput: '#shift-start-cash',
  shiftOpenBtn: '.shift-modal-btn--primary',
  cartQtyIncrease: '[aria-label="เพิ่มจำนวน"]',
  cartQtyDecrease: '[aria-label="ลดจำนวน"]',
  cartQtyValue: '.pos-ci-qty-val',
  cartTotalRow: '.pos-cf-row:has(.pos-cf-lbl:text("รวม")) .pos-cf-val',
  customerPickBtn: '.pos-cust-pick',
  customerPickerDialog: '[role="dialog"][aria-labelledby="cps-title"]',
  customerSearchInput: '.cps-search input',
  customerRow: '.cps-row',
  paymentDialog: '[role="dialog"][aria-label="ชำระเงิน"]',
  payQuickBill1000: '.pay-quick-bills button:text("+1000")',
  payConfirmBtn: '.pay-confirm',
  payAcceptedDialog: '[aria-label="รับรายการขายแล้ว"]',
  payAcceptedChange: '.pay-success-change',
  payNewSaleBtn: '.pay-success-btn--primary',
} as const;

// ─── THE TEST ────────────────────────────────────────────────────────────────

test.describe('Human-Like Cashier Checkout', () => {
  // One login per suite; each `test` gets a fresh page context via beforeEach.
  test.beforeEach(async ({ page }) => {
    await loginAsWichai(page);
    await goToPOS(page);
  });

  test('complete sale — forgetful cashier makes a typo then recovers', async ({ page }) => {

    // ── Scene 1: The Forgetful Cashier ──────────────────────────────────────
    // The new cashier sits down and immediately reaches for the checkout button
    // before even opening the register. It should be disabled.
    const checkoutBtn = page.locator(SEL.checkoutBtn);
    await expect(checkoutBtn).toBeDisabled();
    // Good — the button is correctly disabled (no active shift + empty cart).

    // ── Scene 2: Opening the Register ───────────────────────────────────────
    // The shift-open modal appears automatically because there is no active
    // shift. The cashier counts their starting cash: ฿1,000.
    const shiftDialog = page.locator(SEL.shiftDialog);
    await expect(shiftDialog).toBeVisible();

    await page.fill(SEL.shiftCashInput, '1000');

    // Small pause — just like a cashier double-checking the amount.
    await page.waitForTimeout(400);

    await page.click(SEL.shiftOpenBtn);

    // Wait for the modal to close — shift is now open.
    await expect(shiftDialog).not.toBeVisible({ timeout: 8_000 });

    // Checkout button is still disabled (cart is empty), but for the right
    // reason now (empty cart, not missing shift).
    await expect(checkoutBtn).toBeDisabled();

    // ── Scene 3: The Typo ────────────────────────────────────────────────────
    // The customer reads a barcode from the bag. The cashier misreads it.
    const searchInput = page.locator(SEL.searchInput);
    await searchInput.click();
    await searchInput.type('9arch box', { delay: 60 }); // slow, like real typing

    await searchInput.press('Enter');

    // The system should show "ไม่พบสินค้านี้" (Not Found) toast.
    const toast = page.locator(SEL.toast);
    await expect(toast).toContainText('ไม่พบสินค้านี้', { timeout: 5_000 });
    // Phew — the cashier notices their mistake.

    // ── Scene 4: The Correction ──────────────────────────────────────────────
    // Clear the search and enter the correct SKU.
    await searchInput.clear();
    await searchInput.type('HSD-567', { delay: 50 }); // Hill's Science Diet
    await searchInput.press('Enter');

    // The item should appear in the cart.
    await expect(page.locator(SEL.cartQtyValue).first()).toHaveText('1', {
      timeout: 5_000,
    });
    // Checkout button should now be enabled (cart has an item AND shift is open).
    await expect(checkoutBtn).toBeEnabled();

    // ── Scene 5: The Indecisive Customer ────────────────────────────────────
    // "Actually, can we get two of those?" — cashier increases qty.
    await page.click(SEL.cartQtyIncrease);
    await expect(page.locator(SEL.cartQtyValue).first()).toHaveText('2', {
      timeout: 3_000,
    });
    // "Wait, no — just one." — cashier decreases back.
    await page.click(SEL.cartQtyDecrease);
    await expect(page.locator(SEL.cartQtyValue).first()).toHaveText('1', {
      timeout: 3_000,
    });

    // ── Scene 6: The VIP Card ────────────────────────────────────────────────
    // The customer pulls out their VIP card. The cashier selects them in the
    // system so the tier discount kicks in.

    // Record the pre-discount total.
    const totalLocator = page.locator(SEL.cartTotalRow);
    const totalBefore = await totalLocator.textContent();
    // For HSD-567: base price = ฿2,400 → should read "฿2,400.00"

    // Open the customer picker.
    await page.click(SEL.customerPickBtn);
    const pickerDialog = page.locator(SEL.customerPickerDialog);
    await expect(pickerDialog).toBeVisible({ timeout: 5_000 });

    // Search for the VIP customer (น้ำ แก้วกานต์, customerType: "vip").
    await page.fill(SEL.customerSearchInput, 'น้ำ');
    await page.waitForTimeout(300); // let the filter debounce

    // Click the first matching row.
    await page.locator(SEL.customerRow).first().click();
    await expect(pickerDialog).not.toBeVisible({ timeout: 5_000 });

    // The cart should reprice: VIP tier for HSD-567 = ฿2,100
    const totalAfter = await totalLocator.textContent();
    expect(totalAfter).not.toBe(totalBefore); // total changed
    expect(totalAfter).toContain('2,100');     // VIP tier price applied

    // ── Scene 7: The Checkout ────────────────────────────────────────────────
    // Cashier presses F12 (keyboard shortcut).
    await page.keyboard.press('F12');
    const paymentDialog = page.locator(SEL.paymentDialog);
    await expect(paymentDialog).toBeVisible({ timeout: 5_000 });

    // ── Scene 8: The Payment ─────────────────────────────────────────────────
    // Total = ฿2,100. Customer hands over ฿3,000 (three ×1,000 notes).
    // Cashier clicks the "+1000" quick-bill button three times.
    const quickBill1000 = page.locator(SEL.payQuickBill1000);
    await quickBill1000.click();
    await quickBill1000.click();
    await quickBill1000.click();
    // Entered: ฿3,000

    // Verify the change amount displayed in the payment summary.
    // Change = 3000 - 2100 = 900
    const paySummary = page.locator('.pay-summary');
    await expect(paySummary).toContainText('900', { timeout: 3_000 });

    // Confirm the payment.
    await page.click(SEL.payConfirmBtn);

    // ── Scene 9: Accepted ─────────────────────────────────────────────────────
    // The sale is saved locally. The accepted screen appears with the change amount.
    const acceptedDialog = page.locator(SEL.payAcceptedDialog);
    await expect(acceptedDialog).toBeVisible({ timeout: 10_000 });

    const changeText = page.locator(SEL.payAcceptedChange);
    await expect(changeText).toContainText('900');

    // Cashier clicks "บิลใหม่" to reset for the next customer.
    await page.click(SEL.payNewSaleBtn);

    // POS returns to the empty cart state.
    await expect(page.locator('.pos-cart-empty')).toBeVisible({ timeout: 5_000 });
    await expect(checkoutBtn).toBeDisabled(); // cart is empty again
  });
});
