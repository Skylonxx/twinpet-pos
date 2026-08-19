/**
 * Packet AI-2 trusted orchestration — browser evidence.
 *
 * AI-2 still does not claim a sound positive or Firestore confirmation.
 * Absence soundness is SINGLE_TAB_PER_CART_KEY and excludes the AI2-D1-B
 * write-failure path (ENTRY_WRITE_FAILED_AFTER_FENCE_ACQUISITION_AND_CHECKOUT_PROCEEDED).
 * Consecutive sales with no intervening sweep must roll generationSeq (B-13).
 * Cross-tab guarantee remains IDEMPOTENT_CONVERGENCE_PLUS_AT_MOST_ONCE_RELEASE.
 *
 * CR-012: this Playwright/dev-mock spec does NOT prove Firestore queue
 * behavior. Firestore-adjacent evidence requires the separately gated
 * local Emulator/manual UAT tier (B-18/B-19/B-20 are not executed here).
 */
import { expect, test, type Page, type BrowserContext } from '@playwright/test';

const CART_DB = 'twinpet-active-cart-snapshot';
const CART_STORE = 'activeCartSnapshots';
const EVIDENCE_DB = 'twinpet-sale-submission-evidence';
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';

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

async function readEntryRows(page: Page): Promise<Array<{ asyncOrderId?: string }>> {
  return page.evaluate(async ({ dbName, storeName }) => {
    return await new Promise<Array<{ asyncOrderId?: string }>>((resolve) => {
      const req = indexedDB.open(dbName, 1);
      req.onerror = () => resolve([]);
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
          resolve((getAll.result ?? []) as Array<{ asyncOrderId?: string }>);
        };
        getAll.onerror = () => {
          db.close();
          resolve([]);
        };
      };
    });
  }, { dbName: EVIDENCE_DB, storeName: ENTRY_STORE });
}

async function rewindCartToOpenHeld(page: Page): Promise<CartRecord> {
  return page.evaluate(async ({ dbName, storeName }) => {
    return await new Promise<CartRecord>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onerror = () => reject(req.error ?? new Error('open failed'));
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const records = (getAll.result ?? []) as CartRecord[];
          const record = records[0];
          if (!record) {
            db.close();
            reject(new Error('no cart record'));
            return;
          }
          record.resumeAttempts = 0;
          record.resumeFence.held = true;
          const keyReq = store.getAllKeys();
          keyReq.onsuccess = () => {
            const key = keyReq.result[0];
            if (key === undefined) {
              db.close();
              reject(new Error('no cart key'));
              return;
            }
            store.put(record, key);
          };
        };
        tx.oncomplete = () => {
          db.close();
          resolve((getAll.result ?? [])[0] as CartRecord);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('rewind failed'));
        };
      };
    });
  }, { dbName: CART_DB, storeName: CART_STORE });
}

async function waitForSweep(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(800);
}

async function readDeviceId(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('twinpet_device_id') ?? '');
}

test.describe('AI-2 trusted orchestration browser evidence', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsWichai(page);
    await goToPOS(page);
    await openShiftIfNeeded(page);
  });

  test('B-1 / NV-5 first sale binds durable asyncOrderId and billId and terminalizes inline at S5', async ({ page }) => {
    const sale = await completeDevMockSale(page);
    const records = await readCartRecords(page);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.generationSeq).toBe(1);
    expect(record.marker).toBe('S2');
    expect(record.resumeAttempts).toBe(1);
    expect(record.resumeFence.held).toBe(false);
    expect(record.resumeFence.fenceSeq).toBeGreaterThan(0);
    expect(record.billId).toBe(sale.billId);
    const deviceId = await readDeviceId(page);
    expect(record.deviceId).toBe(deviceId);
    const sequenceFromActualSale = sequenceFromActualSaleBillId(sale.billId);
    const expectedAsyncOrderId = `${deviceId}-${sequenceFromActualSale}`;
    expect(record.asyncOrderId).toBe(expectedAsyncOrderId);
    expect(record.asyncOrderId.length).toBeGreaterThan(deviceId.length + 1);
  });

  test('B-13 two sequential sales with NO trusted sweep between roll generationSeq 1 → 2', async ({ page }) => {
    const sale1 = await completeDevMockSale(page);
    await page.click(SEL.payNewSaleBtn);
    await expect(page.locator('.pos-cart-empty')).toBeVisible({ timeout: 5_000 });
    const sale2 = await completeDevMockSale(page);
    expect(sale2.billId).not.toBe(sale1.billId);
    const records = await readCartRecords(page);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.generationSeq).toBe(2);
    expect(record.billId).toBe(sale2.billId);
    expect(record.billId).not.toBe(sale1.billId);
    expect(record.asyncOrderId).not.toContain(sale1.billId);
  });

  test('B-2b sweep is the actor that terminalizes reconstructed OPEN_HELD case-5 state', async ({ page }) => {
    const sale1 = await completeDevMockSale(page);
    const before = (await readCartRecords(page))[0]!;
    expect(before.generationSeq).toBe(1);
    expect(before.resumeAttempts).toBe(1);
    await rewindCartToOpenHeld(page);
    const case5 = (await readCartRecords(page))[0]!;
    expect(case5.resumeAttempts).toBe(0);
    expect(case5.resumeFence.held).toBe(true);
    const fenceSeq = case5.resumeFence.fenceSeq;
    const generationId = case5.generationId;
    await waitForSweep(page);
    const afterSweep = (await readCartRecords(page))[0]!;
    expect(afterSweep.resumeAttempts).toBe(1);
    expect(afterSweep.resumeFence.held).toBe(false);
    expect(afterSweep.resumeFence.fenceSeq).toBe(fenceSeq);
    expect(afterSweep.generationId).toBe(generationId);
    expect((await readEntryRows(page)).length).toBeGreaterThan(0);
    await page.click(SEL.payNewSaleBtn);
    await expect(page.locator('.pos-cart-empty')).toBeVisible({ timeout: 5_000 });
    const sale2 = await completeDevMockSale(page);
    expect(sale2.billId).not.toBe(sale1.billId);
    const afterSecond = (await readCartRecords(page))[0]!;
    expect(afterSecond.generationSeq).toBe(2);
    expect(afterSecond.generationId).not.toBe(generationId);
    expect(afterSecond.billId).toBe(sale2.billId);
    expect(afterSecond.asyncOrderId).not.toBe(case5.asyncOrderId);
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
    await rewindCartToOpenHeld(page);
    const case5 = (await readCartRecords(page))[0]!;
    const fenceSeq = case5.resumeFence.fenceSeq;
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
    expect(records[0]?.resumeFence.fenceSeq).toBe(fenceSeq);
    await page2.close();
  });

  test('B-9 exactly one ENTRY row is keyed by the sale asyncOrderId and POS UI hides island identifiers', async ({ page }) => {
    const sale = await completeDevMockSale(page);
    const record = (await readCartRecords(page))[0]!;
    const entries = await readEntryRows(page);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.asyncOrderId).toBe(record.asyncOrderId);
    expect(await readPointerCount(page)).toBe(0);
    expect(record.billId).toBe(sale.billId);
    await expect(page.locator('text=generationId')).toHaveCount(0);
    await expect(page.locator('text=submission_evidence')).toHaveCount(0);
    await expect(page.locator('text=absence_seal')).toHaveCount(0);
  });

  test('B-10 reconstructed case-5 state is presence-released by boot/reload sweep', async ({ page }) => {
    await completeDevMockSale(page);
    await rewindCartToOpenHeld(page);
    const case5 = (await readCartRecords(page))[0]!;
    expect(case5.resumeAttempts).toBe(0);
    expect(case5.resumeFence.held).toBe(true);
    await page.reload();
    await goToPOS(page);
    await openShiftIfNeeded(page);
    await page.waitForTimeout(800);
    const after = (await readCartRecords(page))[0]!;
    expect(after.resumeAttempts).toBe(1);
    expect(after.resumeFence.held).toBe(false);
    expect(after.generationId).toBe(case5.generationId);
  });

  test('B-11 after B-10 a new sale rolls the generation', async ({ page }) => {
    await completeDevMockSale(page);
    await rewindCartToOpenHeld(page);
    await page.reload();
    await goToPOS(page);
    await openShiftIfNeeded(page);
    await page.waitForTimeout(800);
    const afterSweep = (await readCartRecords(page))[0]!;
    expect(afterSweep.resumeAttempts).toBe(1);
    await expect(page.locator('.pos-cart-empty')).toBeVisible({ timeout: 5_000 });
    const sale2 = await completeDevMockSale(page);
    const afterSecond = (await readCartRecords(page))[0]!;
    expect(afterSecond.generationSeq).toBe(2);
    expect(afterSecond.generationId).not.toBe(afterSweep.generationId);
    expect(afterSecond.billId).toBe(sale2.billId);
  });

  test('B-12 exactly one durable ENTRY for the first sale; sweep does not mint a second', async ({ page }) => {
    await completeDevMockSale(page);
    const first = await readEntryRows(page);
    expect(first).toHaveLength(1);
    await waitForSweep(page);
    const second = await readEntryRows(page);
    expect(second).toHaveLength(1);
    expect(second[0]?.asyncOrderId).toBe(first[0]?.asyncOrderId);
    expect(await readPointerCount(page)).toBe(0);
  });

  test('B-14 reconnect online event presence-releases case-5 once then stays idempotent', async ({ page }) => {
    await completeDevMockSale(page);
    await rewindCartToOpenHeld(page);
    const case5 = (await readCartRecords(page))[0]!;
    expect(case5.resumeAttempts).toBe(0);
    expect(case5.resumeFence.held).toBe(true);
    const fenceSeq = case5.resumeFence.fenceSeq;
    const generationId = case5.generationId;
    await waitForSweep(page);
    const first = (await readCartRecords(page))[0]!;
    expect(first.resumeAttempts).toBe(1);
    expect(first.resumeFence.held).toBe(false);
    expect(first.resumeFence.fenceSeq).toBe(fenceSeq);
    expect(first.generationId).toBe(generationId);
    expect((await readEntryRows(page)).length).toBeGreaterThan(0);
    await waitForSweep(page);
    const second = (await readCartRecords(page))[0]!;
    expect(second.resumeAttempts).toBe(1);
    expect(second.resumeFence.held).toBe(false);
    expect(second.resumeFence.fenceSeq).toBe(fenceSeq);
    expect(second.generationId).toBe(generationId);
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
