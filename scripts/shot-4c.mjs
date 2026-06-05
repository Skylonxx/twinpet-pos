/**
 * Batch 4c visual verification — Inventory & Transfers migrated tables.
 * Needs a running dev server (npm run dev) on :5173.
 * Run: node scripts/shot-4c.mjs   →  PNGs in .shots-4c/
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const OUT = '.shots-4c';
mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log(`  📸 ${n}.png`); };
const safe = async (label, fn) => { try { await fn(); } catch (e) { console.log(`  ⚠ ${label}: ${e instanceof Error ? e.message : e}`); } };

// add a product to the currently-open ProductPickerDialog (checks first row, confirms)
async function pickFirstProduct() {
  await page.waitForSelector('.pps-overlay', { timeout: 8000 });
  await page.waitForTimeout(700);
  await page.locator('.pps-overlay table tbody tr .cb').first().check().catch(async () => {
    await page.locator('.pps-overlay table tbody tr').first().click();
  });
  await page.waitForTimeout(300);
  await page.locator('.pps-overlay .confirm-btn').click();
  await page.waitForTimeout(700);
}

try {
  // ── login ──
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 20_000 });
  const values = await page.$$eval('#branch-sel option', (os) => os.map((o) => o.value).filter(Boolean));
  const branch = values.includes('LDP-001') ? 'LDP-001' : values[0];
  if (branch) await page.selectOption('#branch-sel', branch);
  for (const d of ['1', '2', '3', '4']) { await page.click(`.login-pin-btn:text-is("${d}")`); await page.waitForTimeout(350); }
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('twinpet_session');
    if (!raw) return false;
    try { const s = JSON.parse(raw); return Boolean(s?.user?.id && s?.branchId); } catch { return false; }
  }, { timeout: 25_000 });
  console.log('✓ login OK');

  // ── InventoryPage list (/inventory) ──
  await safe('inventory-list', async () => {
    await page.goto(`${BASE}/inventory`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const rows = await page.locator('.inv-table-wrap table tbody tr').count();
    console.log(`/inventory rows=${rows}`);
    await shot('01-inventory-list');
  });

  // ── InventoryAdjustmentPage (/inventory/adjust?mode=out) + pick a product ──
  await safe('inv-adjust', async () => {
    await page.goto(`${BASE}/inventory/adjust?mode=out`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /เลือกสินค้า/ }).first().click();
    await pickFirstProduct();
    const rows = await page.locator('.inv-adj-table-wrap table tbody tr').count();
    console.log(`inv-adjust table rows=${rows}`);
    await shot('02-inventory-adjust');
  });

  // ── BranchTransferPage (/inventory/transfer → create new) + pick a product ──
  await safe('branch-transfer', async () => {
    await page.goto(`${BASE}/inventory/transfer`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    // try to enter the "create transfer" view
    await page.getByRole('button', { name: /สร้าง|โอนย้าย|เพิ่ม/ }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    const pickBtn = page.getByRole('button', { name: /เลือกสินค้า/ });
    if (await pickBtn.count()) {
      await pickBtn.first().click();
      await pickFirstProduct();
    }
    const rows = await page.locator('.inv-adj-table-wrap table tbody tr').count();
    console.log(`branch-transfer table rows=${rows}`);
    await shot('03-branch-transfer');
  });

  // ── TransferHistoryPage list + TransferDetailModal (/inventory/transfer/history) ──
  await safe('transfer-history', async () => {
    await page.goto(`${BASE}/inventory/transfer/history`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const rows = await page.locator('.sh-table-scroll table tbody tr').count();
    console.log(`transfer-history rows=${rows}`);
    await shot('04-transfer-history');

    // open first transfer → detail modal
    await safe('transfer-detail', async () => {
      await page.locator('.sh-table-scroll table tbody tr').first().click();
      await page.waitForSelector('.tr-modal-overlay', { timeout: 6000 });
      await page.waitForTimeout(800);
      await shot('05-transfer-detail');

      // try Edit → TransferEditModal
      await safe('transfer-edit', async () => {
        await page.getByRole('button', { name: /แก้ไข/ }).first().click();
        await page.waitForTimeout(800);
        await shot('06-transfer-edit');
      });
    });
  });
} catch (err) {
  console.log(`✗ flow threw: ${err instanceof Error ? err.message : err}`);
} finally {
  console.log('\n=== runtime errors captured ===');
  if (errors.length === 0) console.log('(none)');
  else errors.forEach((e) => console.log(' • ' + e));
  await browser.close();
}
