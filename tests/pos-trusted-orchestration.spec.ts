/**
 * Packet AI-1 trusted orchestration — future browser evidence.
 *
 * AUTHORED NOW. DO NOT EXECUTE in the AI-1 pre-review deterministic gate.
 * Playwright remains unauthorized until Stage-1 implementation review PASS
 * for browser evidence only.
 *
 * CR-012: this Playwright/dev-mock spec does NOT prove Firestore queue
 * behavior. Firestore-adjacent evidence requires the separately gated
 * local Emulator/manual UAT tier.
 *
 * Cross-tab guarantee:
 * IDEMPOTENT_CONVERGENCE_PLUS_AT_MOST_ONCE_RELEASE
 * Do NOT assert "second acquire is refused".
 *
 * AI-1 limitations encoded as expected behavior, not defects:
 * - no crash-resume correctness
 * - absence seals are vacuous without an ENTRY_STORE writer
 * - B-2a (no intervening sweep) keeps generationSeq 1 naming sale 1
 */
import { expect, test, type Page, type BrowserContext } from '@playwright/test';

const CART_DB = 'twinpet-active-cart-snapshot';
const CART_STORE = 'activeCartSnapshots';
const EVIDENCE_DB = 'twinpet-sale-submission-evidence';
const POINTER_STORE = 'saleEvidenceGenerationPointers';

const SEL = {
  searchInput: 'input[placeholder*="barcode"]',
  checkoutBtn: '.pos-checkout-btn',
  shiftDialogName: 'เปิดกะ',
  shiftCashLabel: 'เงินทอนเริ่มต้น (Starting Cash)',
  shiftOpenBtnName: 'เปิดกะ',
  shiftReadyBtnName: 'ปิดกะ',
  paymentDialog: '[role="dialog"][aria-label="ชำระเงิน"]',
  payQuickBill1000: 'เพิ่มยอด 1000 บาท',
  payConfirmBtn: '.pay-confirm',
  payAcceptedDialog: '[aria-label="รับรายการขายแล้ว"]',
  payAcceptedOrder: '.pay-success-order',
  payNewSaleBtn: '.pay-success-btn--primary',
} as const;

type CartRecord = {
  schemaVersion: number;
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  resumeFence: { held: boolean; fenceSeq: number; fenceNonce: string };
  resumeAttempts: number;
  marker: string;
};

async function waitForSession(page: Page) {
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('twinpet_session');
      if (!raw) return false;
      try {
        const session = JSON.parse(raw) as { user?: { id?: string }; branchId?: string };
        return Boolean(session?.user?.id && session?.branchId);
      } catch {
        return false;
      }
    },
    { timeout: 12_000 },
  );
}

async function loginAsWichai(page: Page) {
  await page.goto('/login');
  await expect(page.locator('text=Dev: somchai')).toBeVisible({ timeout: 8_000 });
  await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 8_000 });
  await page.selectOption('#branch-sel', 'LDP-001');
  for (const digit of ['3', '4', '5', '6']) {
    await page.getByRole('button', { name: digit, exact: true }).click();
    await page.waitForTimeout(350);
  }
  const pinError = page.locator('#pin-error');
  await page.waitForTimeout(600);
  if (await pinError.isVisible()) {
    const msg = (await pinError.textContent())?.trim() ?? '(unknown)';
    throw new Error(`PIN login failed — UI error: "${msg}"`);
  }
  await waitForSession(page);
}

async function goToPOS(page: Page) {
  await page.goto('/pos');
  await page.waitForSelector('.pos-checkout-btn', { timeout: 10_000 });
}

async function openShiftIfNeeded(page: Page) {
  const shiftDialog = page.getByRole('dialog', { name: SEL.shiftDialogName });
  const shiftReadyChrome = page.getByRole('button', { name: SEL.shiftReadyBtnName, exact: true });

  // OpenShiftModal mounts only after async shift boot (`shiftReady`). Checkout
  // chrome is already on the page, so a single isVisible() snapshot races.
  await expect(shiftDialog.or(shiftReadyChrome)).toBeVisible({ timeout: 10_000 });

  if (!(await shiftDialog.isVisible())) {
    return;
  }

  await page.getByLabel(SEL.shiftCashLabel).fill('1000');
  await page.getByRole('button', { name: SEL.shiftOpenBtnName, exact: true }).click();
  await expect(shiftDialog).toBeHidden({ timeout: 8_000 });
  await expect(shiftReadyChrome).toBeVisible({ timeout: 8_000 });
}

async function completeDevMockSale(page: Page): Promise<{ billId: string }> {
  const searchInput = page.locator(SEL.searchInput);
  await searchInput.click();
  await searchInput.fill('HSD-567');
  await searchInput.press('Enter');
  const checkoutBtn = page.locator(SEL.checkoutBtn);
  await expect(checkoutBtn).toBeEnabled({ timeout: 8_000 });
  await page.keyboard.press('F12');
  const paymentDialog = page.locator(SEL.paymentDialog);
  await expect(paymentDialog).toBeVisible({ timeout: 5_000 });
  const quickBill1000 = page.getByRole('button', { name: SEL.payQuickBill1000 });
  await quickBill1000.click();
  await quickBill1000.click();
  await quickBill1000.click();
  await page.click(SEL.payConfirmBtn);
  const accepted = page.locator(SEL.payAcceptedDialog);
  await expect(accepted).toBeVisible({ timeout: 10_000 });
  const orderText = (await page.locator(SEL.payAcceptedOrder).textContent()) ?? '';
  const billId = orderText.replace(/^เลขที่:\s*/, '').trim();
  expect(billId.length).toBeGreaterThan(0);
  return { billId };
}

async function readCartRecords(page: Page): Promise<CartRecord[]> {
  return page.evaluate(async ({ dbName, storeName }) => {
    return await new Promise<CartRecord[]>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onerror = () => reject(req.error ?? new Error('open failed'));
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          db.close();
          resolve((getAll.result ?? []) as CartRecord[]);
        };
        getAll.onerror = () => {
          db.close();
          reject(getAll.error ?? new Error('getAll failed'));
        };
      };
    });
  }, { dbName: CART_DB, storeName: CART_STORE });
}

async function readPointerCount(page: Page): Promise<number> {
  return page.evaluate(async ({ dbName, storeName }) => {
    return await new Promise<number>((resolve) => {
      const req = indexedDB.open(dbName, 1);
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.close();
          resolve(0);
          return;
        }
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const countReq = store.count();
        countReq.onsuccess = () => {
          db.close();
          resolve(countReq.result);
        };
        countReq.onerror = () => {
          db.close();
          resolve(0);
        };
      };
    });
  }, { dbName: EVIDENCE_DB, storeName: POINTER_STORE });
}

async function readDeviceId(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('twinpet_device_id') ?? '');
}

test.describe('AI-1 trusted orchestration browser evidence', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsWichai(page);
    await goToPOS(page);
    await openShiftIfNeeded(page);
  });

  test('B-1 / NV-5 first sale binds durable asyncOrderId and billId to the completed sale', async ({ page }) => {
    const sale = await completeDevMockSale(page);
    const records = await readCartRecords(page);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.generationSeq).toBe(1);
    expect(record.marker).toBe('S2');
    expect(record.resumeAttempts).toBe(0);
    expect(record.billId).toBe(sale.billId);
    const deviceId = await readDeviceId(page);
    expect(record.deviceId).toBe(deviceId);
    // NV-5: expected asyncOrderId sequence comes from the actual sale billId
    // trailing run (formatOfflineReceiptNumber), never from record.asyncOrderId.
    const sequenceFromActualSale = sequenceFromActualSaleBillId(sale.billId);
    const expectedAsyncOrderId = `${deviceId}-${sequenceFromActualSale}`;
    expect(record.asyncOrderId).toBe(expectedAsyncOrderId);
    expect(record.asyncOrderId.length).toBeGreaterThan(deviceId.length + 1);
  });

  test('B-2a two sequential sales with NO trusted sweep between keep generationSeq 1 naming sale 1', async ({ page }) => {
    const sale1 = await completeDevMockSale(page);
    await page.click(SEL.payNewSaleBtn);
    await expect(page.locator('.pos-cart-empty')).toBeVisible({ timeout: 5_000 });
    const sale2 = await completeDevMockSale(page);
    expect(sale2.billId).not.toBe(sale1.billId);
    const records = await readCartRecords(page);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.generationSeq).toBe(1);
    expect(record.billId).toBe(sale1.billId);
    expect(record.billId).not.toBe(sale2.billId);
  });

  test('B-2b two sales with a trusted online/resume sweep between roll generation 1 → 2', async ({ page }) => {
    const sale1 = await completeDevMockSale(page);
    const before = (await readCartRecords(page))[0]!;
    expect(before.generationSeq).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(500);
    const afterSweep = (await readCartRecords(page))[0]!;
    expect(afterSweep.resumeAttempts).toBe(1);
    expect(afterSweep.generationId).toBe(before.generationId);
    expect(afterSweep.storeEpochId).toBe(before.storeEpochId);
    await page.click(SEL.payNewSaleBtn);
    await expect(page.locator('.pos-cart-empty')).toBeVisible({ timeout: 5_000 });
    const sale2 = await completeDevMockSale(page);
    expect(sale2.billId).not.toBe(sale1.billId);
    const afterSecond = (await readCartRecords(page))[0]!;
    expect(afterSecond.generationSeq).toBe(2);
    expect(afterSecond.generationId).not.toBe(before.generationId);
    expect(afterSecond.storeEpochId).toBe(before.storeEpochId);
    expect(afterSecond.billId).toBe(sale2.billId);
    expect(afterSecond.asyncOrderId).not.toBe(before.asyncOrderId);
  });

  test('B-3 StrictMode duplicate boot does not claim owner_unavailable in console', async ({ page }) => {
    const claimFailures: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('owner_unavailable') || text.includes('trusted resume sweep failed')) {
        claimFailures.push(text);
      }
    });
    await page.reload();
    await goToPOS(page);
    await openShiftIfNeeded(page);
    expect(claimFailures).toEqual([]);
  });

  test('B-4 reload preserves the durable record', async ({ page }) => {
    const sale1 = await completeDevMockSale(page);
    const before = (await readCartRecords(page))[0]!;
    await page.reload();
    await goToPOS(page);
    await openShiftIfNeeded(page);
    const afterReload = (await readCartRecords(page))[0]!;
    expect(afterReload.generationId).toBe(before.generationId);
    expect(afterReload.storeEpochId).toBe(before.storeEpochId);
    expect(afterReload.billId).toBe(sale1.billId);
  });

  test('B-5 cross-tab is idempotent convergence plus at-most-once release, not mutual exclusion', async ({ page, context }: { page: Page; context: BrowserContext }) => {
    await completeDevMockSale(page);
    const page2 = await context.newPage();
    await goToPOS(page2);
    await openShiftIfNeeded(page2);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page2.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(800);
    const records = await readCartRecords(page);
    expect(records).toHaveLength(1);
    expect(records[0]?.resumeAttempts).toBe(1);
    expect(records[0]?.resumeFence.held).toBe(false);
    const pointers = await readPointerCount(page);
    expect(pointers).toBe(1);
    await page2.close();
  });

  test('B-14 reconnect online event re-runs the trusted sweep without double-registration', async ({ page }) => {
    await completeDevMockSale(page);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(400);
    const first = (await readCartRecords(page))[0]!;
    expect(first.resumeAttempts).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(400);
    const second = (await readCartRecords(page))[0]!;
    expect(second.resumeAttempts).toBe(1);
    expect(second.resumeFence.fenceSeq).toBe(first.resumeFence.fenceSeq);
    expect(await readPointerCount(page)).toBe(1);
  });
});

/**
 * Trailing numeric run of production `formatOfflineReceiptNumber`:
 * `[PREFIX]-[YYMMDD]-[SEGMENT]-[zero-padded seq]`.
 * Source is the scraped completed-sale billId, never record.asyncOrderId.
 */
function sequenceFromActualSaleBillId(billId: string): number {
  const hyphen = billId.lastIndexOf('-');
  expect(hyphen).toBeGreaterThan(-1);
  const runSegment = billId.slice(hyphen + 1);
  expect(/^\d+$/.test(runSegment)).toBe(true);
  const seq = Number.parseInt(runSegment, 10);
  expect(Number.isInteger(seq)).toBe(true);
  expect(seq).toBeGreaterThan(0);
  return seq;
}
