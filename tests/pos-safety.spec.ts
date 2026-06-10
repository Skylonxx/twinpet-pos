import { expect, test } from '@playwright/test';

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

async function loginAsWichai(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await expect(page.locator('text=Dev: somchai')).toBeVisible({ timeout: 8_000 });
  await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 8_000 });
  await page.selectOption('#branch-sel', 'LDP-001');

  for (const digit of ['3', '4', '5', '6']) {
    await page.getByRole('button', { name: digit, exact: true }).click();
    await page.waitForTimeout(350);
  }

  await page.waitForTimeout(600);
  await waitForSession(page);
}

async function goToPOS(page: import('@playwright/test').Page) {
  await page.goto('/pos');
  // Handle shift open
  const shiftDialog = page.locator('[role="dialog"][aria-label="เปิดกะ"]');
  try {
    await shiftDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.fill('#shift-start-cash', '1000');
    await page.waitForTimeout(400);
    await page.click('.shift-modal-btn--primary');
    await expect(shiftDialog).not.toBeVisible({ timeout: 8_000 });
  } catch (e) {
    // maybe already open
  }
}

test.describe('POS Safety Polish - Track B', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsWichai(page);
    await goToPOS(page);
  });

  test('Clear Cart requires confirmation', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="barcode"]');
    await searchInput.click();
    await searchInput.type('HSD-567', { delay: 50 });
    await searchInput.press('Enter');

    // Wait for cart item
    await expect(page.locator('.pos-ci-qty-val').first()).toHaveText('1', { timeout: 5000 });

    // Click Clear Cart
    await page.click('button:has-text("ล้างตะกร้า")');

    // Assert cart still has item (no instant execution)
    await expect(page.locator('.pos-ci-qty-val').first()).toHaveText('1');

    // Assert Modal opens
    const modal = page.locator('.dc-modal');
    await expect(modal).toBeVisible();

    // Cancel modal
    await page.click('.dc-modal-footer button:has-text("ย้อนกลับ")');
    await expect(modal).not.toBeVisible();
    await expect(page.locator('.pos-ci-qty-val').first()).toHaveText('1'); // Still there

    // Re-open and Confirm
    await page.click('button:has-text("ล้างตะกร้า")');
    await expect(modal).toBeVisible();
    await page.click('.dc-modal-footer button:has-text("ยืนยัน")');

    // Modal closes and cart is empty
    await expect(modal).not.toBeVisible();
    await expect(page.locator('.pos-ci-qty-val')).toHaveCount(0);
  });

  test('Cancel Parked Order requires confirmation', async ({ page }) => {
    // Add item
    const searchInput = page.locator('input[placeholder*="barcode"]');
    await searchInput.click();
    await searchInput.type('HSD-567', { delay: 50 });
    await searchInput.press('Enter');
    await expect(page.locator('.pos-ci-qty-val').first()).toHaveText('1', { timeout: 5000 });

    // Hold bill
    await page.click('button:has-text("พักบิล")');
    const holdModal = page.locator('.pos-sb-dialog--note');
    await expect(holdModal).toBeVisible();
    await page.click('.pos-sb-btn--primary:has-text("ยืนยันพักบิล")');
    await expect(holdModal).not.toBeVisible();

    // Open parked orders
    await page.click('button:has-text("บิลที่พักไว้")');
    const listModal = page.locator('.pos-sb-dialog--list');
    await expect(listModal).toBeVisible();

    // Item should be there
    const item = page.locator('.pos-sb-item').first();
    await expect(item).toBeVisible();

    // Click remove
    await item.locator('button:has-text("ยกเลิก")').click();

    // Assert modal opens
    const confirmModal = page.locator('.dc-modal');
    await expect(confirmModal).toBeVisible();

    // Cancel modal
    await page.click('.dc-modal-footer button:has-text("ย้อนกลับ")');
    await expect(confirmModal).not.toBeVisible();
    await expect(item).toBeVisible();

    // Re-open and confirm
    await item.locator('button:has-text("ยกเลิก")').click();
    await expect(confirmModal).toBeVisible();
    await page.click('.dc-modal-footer button:has-text("ยืนยัน")');

    // Modal closes and list is empty
    await expect(confirmModal).not.toBeVisible();
    await expect(page.locator('.pos-sb-empty')).toBeVisible(); // Empty state text
  });
});
