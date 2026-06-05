/**
 * Batch 4c — create a real branch transfer, then screenshot TransferDetailModal
 * + TransferEditModal (tr-item-table) with live data. Needs npm run dev on :5173.
 * Run: node scripts/shot-4c-modals.mjs   →  .shots-4c/05,06
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

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 20_000 });
  const values = await page.$$eval('#branch-sel option', (os) => os.map((o) => o.value).filter(Boolean));
  const branch = values.includes('LDP-001') ? 'LDP-001' : values[0];
  if (branch) await page.selectOption('#branch-sel', branch);
  for (const d of ['1', '2', '3', '4']) { await page.click(`.login-pin-btn:text-is("${d}")`); await page.waitForTimeout(350); }
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('twinpet_session'); if (!raw) return false;
    try { const s = JSON.parse(raw); return Boolean(s?.user?.id && s?.branchId); } catch { return false; }
  }, { timeout: 25_000 });
  console.log('✓ login OK');

  await page.goto(`${BASE}/inventory/transfer`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /โอนย้ายใหม่|สร้าง/ }).first().click();
  await page.waitForTimeout(800);

  // pick destination branch (first non-empty option of the page <select>)
  const sel = page.locator('select').first();
  const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  console.log(`destination options: ${JSON.stringify(opts)}`);
  if (opts.length === 0) { console.log('✗ no destination branch available — cannot create transfer'); throw new Error('no dest branch'); }
  await sel.selectOption(opts[0]);
  await page.waitForTimeout(300);

  // add a product
  await page.getByRole('button', { name: /เลือกสินค้า/ }).first().click();
  await page.waitForSelector('.pps-overlay', { timeout: 8000 });
  await page.waitForTimeout(700);
  await page.locator('.pps-overlay table tbody tr .cb').first().check().catch(() => {});
  await page.locator('.pps-overlay .confirm-btn').click();
  await page.waitForTimeout(700);

  // qty = 1
  await page.locator('.inv-adj-qty-input').first().fill('1');
  await page.waitForTimeout(300);

  // confirm transfer
  await page.getByRole('button', { name: /ยืนยันการโอนย้าย/ }).click();
  await page.waitForSelector('.inv-tr-confirm-submit', { timeout: 6000 });
  await page.locator('.inv-tr-confirm-submit').click();
  await page.waitForTimeout(2500);
  console.log('✓ transfer submitted');

  // history → open detail
  await page.goto(`${BASE}/inventory/transfer/history`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const rows = await page.locator('.sh-table-scroll table tbody tr').count();
  console.log(`history rows=${rows}`);
  await page.locator('.sh-table-scroll table tbody tr').first().click();
  await page.waitForSelector('.tr-modal-overlay', { timeout: 6000 });
  await page.waitForTimeout(800);
  await shot('05-transfer-detail');

  // edit modal
  await page.getByRole('button', { name: /^แก้ไข/ }).first().click();
  await page.waitForTimeout(1000);
  await shot('06-transfer-edit');
} catch (err) {
  console.log(`✗ flow threw: ${err instanceof Error ? err.message : err}`);
} finally {
  console.log('\n=== runtime errors captured ===');
  if (errors.length === 0) console.log('(none)');
  else errors.forEach((e) => console.log(' • ' + e));
  await browser.close();
}
