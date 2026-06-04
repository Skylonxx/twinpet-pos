/**
 * Re-seed UAT mock data (PROD-001..010 + customers/suppliers/price-levels/stocks)
 * by driving the in-app "นำเข้าข้อมูลตัวอย่าง" button on /admin/branches headlessly.
 * Reuses the app's own seedMockData() so the schema (prices, productStocks, lots)
 * is exactly correct. Requires a running dev server in EMULATOR mode.
 *
 * Run: SMOKE_BASE=http://localhost:5173 node scripts/seed-mock-via-ui.mjs
 */
import { chromium } from '@playwright/test';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('dialog', (d) => d.accept()); // auto-confirm the window.confirm()
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// ── Login (branch + PIN 1234) ───────────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 20_000 });
for (const d of ['1', '2', '3', '4']) {
  await page.click(`.login-pin-btn:text-is("${d}")`);
  await page.waitForTimeout(350);
}
await page.waitForFunction(() => !!localStorage.getItem('twinpet_session'), { timeout: 25_000 });
console.log('✓ logged in');

// ── Go to Branch Management SeedZone and click the seed button ───────────────
await page.goto(`${BASE}/admin/branches`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.admin-seed-btn', { state: 'visible', timeout: 20_000 });
await page.click('.admin-seed-btn');

// ── Wait for the status banner (success or error) ────────────────────────────
await page.waitForSelector('.admin-seed-status', { timeout: 60_000 });
// Give the batched writes a moment to fully settle.
await page.waitForFunction(
  () => {
    const el = document.querySelector('.admin-seed-status');
    return el && el.textContent && el.textContent.trim().length > 0;
  },
  { timeout: 60_000 },
);
const status = await page.locator('.admin-seed-status').innerText();
const isError = await page.locator('.admin-seed-status-error').count();
console.log(`seed status: ${status}`);

await browser.close();
console.log('pageerrors:', errors.length ? errors : '(none)');
process.exit(isError > 0 || errors.length > 0 ? 1 : 0);
