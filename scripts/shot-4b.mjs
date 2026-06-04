/**
 * Batch 4b visual verification — screenshots the migrated Products & Pricing UI.
 * Needs a running dev server (npm run dev) on :5173.
 * Run: node scripts/shot-4b.mjs
 * Output PNGs → .shots-4b/
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const OUT = '.shots-4b';
mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log(`  📸 ${name}.png`); };
const safe = async (label, fn) => { try { await fn(); } catch (e) { console.log(`  ⚠ ${label}: ${e instanceof Error ? e.message : e}`); } };

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

  // ── 4b-1: /products list table ──
  await page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table tbody tr', { timeout: 15_000 });
  await page.waitForTimeout(800);
  const rowCount = await page.locator('table tbody tr').count();
  console.log(`/products list rows=${rowCount}`);
  await shot('01-products-list');

  // ── ProductPickerDialog (เลือกสินค้า) ──
  await safe('product-picker', async () => {
    await page.getByRole('button', { name: /เลือกสินค้า/ }).click();
    await page.waitForSelector('.pps-overlay', { timeout: 8000 });
    await page.waitForTimeout(900);
    const r = await page.locator('.pps-overlay table tbody tr').count();
    console.log(`  product-picker rows=${r}`);
    await shot('02-product-picker');
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.pps-overlay .cancel-btn').click().catch(() => {});
    await page.waitForTimeout(400);
  });

  // ── ProductDrawer (open first row) → Tier Price dialog ──
  await safe('product-drawer', async () => {
    await page.locator('table tbody tr').first().click();
    await page.waitForSelector('.pc-dialog', { timeout: 8000 });
    await page.waitForTimeout(800);
    await shot('03-product-drawer');

    // Tier price grid (ราคาตามกลุ่มลูกค้า)
    await safe('tier-price-grid', async () => {
      await page.getByText(/ราคาตามกลุ่มลูกค้า/).first().click();
      await page.waitForSelector('.tpmd-dialog', { timeout: 8000 });
      await page.waitForTimeout(800);
      const r = await page.locator('.tpmd-dialog table tbody tr').count();
      console.log(`  tier-price rows=${r}`);
      await shot('04-tier-price-grid');
      await page.locator('.tpmd-dialog .tpmd-close').click().catch(() => {});
      await page.waitForTimeout(300);
    });

    // History tab (pc-hist-table)
    await safe('drawer-history', async () => {
      await page.locator('.pc-dtab', { hasText: /ประวัติ|สต็อก/ }).last().click();
      await page.waitForTimeout(600);
      await shot('05-drawer-history');
    });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  });

  // ── PriceLevelManager via /settings ──
  await safe('settings-pricelevels', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    // Try to reach the price-level section (stg-code is a PriceLevelManager cell helper).
    const found = await page.locator('.stg-code').first().count();
    if (!found) {
      // click a nav item that mentions ราคา/ระดับ if tabbed
      await page.getByText(/ระดับราคา|ราคา/).first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.locator('.stg-code').first().waitFor({ timeout: 6000 }).catch(() => {});
    await shot('06-settings-pricelevels');
  });

  // ── TierManagementModal via /customers (จัดการกลุ่ม) ──
  await safe('tier-mgmt-modal', async () => {
    await page.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /จัดการกลุ่ม|กลุ่มลูกค้า/ }).first().click();
    await page.waitForTimeout(800);
    await shot('07-tier-mgmt-modal');
  });
} catch (err) {
  console.log(`✗ flow threw: ${err instanceof Error ? err.message : err}`);
} finally {
  console.log('\n=== runtime errors captured ===');
  if (errors.length === 0) console.log('(none)');
  else errors.forEach((e) => console.log(' • ' + e));
  await browser.close();
}
