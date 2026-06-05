/**
 * Batch 4f visual verification — Admin back-office migrated tables.
 * Needs a running dev server (npm run dev:emulator) on :5173.
 * Run: node scripts/shot-4f.mjs   →  PNGs in .shots-4f/
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const OUT = '.shots-4f';
mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log(`  📸 ${n}.png`); };
const safe = async (label, fn) => { try { await fn(); } catch (e) { console.log(`  ⚠ ${label}: ${e instanceof Error ? e.message : e}`); } };

async function go(path, waitMs = 1500) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(waitMs);
}

try {
  // ── login ──
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#branch-sel option[value]:not([value=""])').length > 0,
    { timeout: 20_000 },
  );
  const vals = await page.$$eval('#branch-sel option', (os) => os.map((o) => o.value).filter(Boolean));
  await page.selectOption('#branch-sel', vals.includes('LDP-001') ? 'LDP-001' : vals[0]);
  for (const d of ['1', '2', '3', '4']) { await page.click(`.login-pin-btn:text-is("${d}")`); await page.waitForTimeout(320); }
  await page.waitForFunction(() => {
    try { const s = JSON.parse(localStorage.getItem('twinpet_session')); return !!(s?.user?.id && s?.branchId); } catch { return false; }
  }, { timeout: 25_000 });
  console.log('✓ login OK');

  // ── Admin Dashboard (/admin) — charts + grid + 3 dash-mini ──
  await safe('admin-dashboard', async () => {
    await go('/admin', 1900);
    const mini = await page.locator('.dash-tc-body table tbody tr').count();
    const canvases = await page.locator('canvas').count();
    console.log(`/admin miniRows=${mini} charts=${canvases}`);
    await shot('01-admin-dashboard');
  });

  // ── Admin Products (/admin/products) — pc-table w/ checkboxes + sortable ──
  await safe('admin-products', async () => {
    await go('/admin/products', 1800);
    const rows = await page.locator('table tbody tr').count();
    const checks = await page.locator('table tbody input[type="checkbox"]').count();
    console.log(`/admin/products rows=${rows} rowCheckboxes=${checks}`);
    await shot('02-admin-products');
    // exercise a sortable header + a row-select checkbox (controlled inputs)
    await safe('admin-products-sort', async () => {
      await page.locator('table thead .pc-sort-th').nth(4).click();
      await page.waitForTimeout(500);
    });
    await safe('admin-products-check', async () => {
      const cb = page.locator('table tbody input[type="checkbox"]').first();
      if (await cb.count()) { await cb.check(); await page.waitForTimeout(300); }
      await shot('03-admin-products-checked');
    });
  });

  // ── Admin Suppliers (/admin/suppliers) — bare table (asup) ──
  await safe('admin-suppliers', async () => {
    await go('/admin/suppliers', 1500);
    const rows = await page.locator('.asup-table-scroll table tbody tr').count();
    console.log(`/admin/suppliers rows=${rows}`);
    await shot('04-admin-suppliers');
  });

  // ── Branch Management (/admin/branches) — admin-branches-table ──
  await safe('admin-branches', async () => {
    await go('/admin/branches', 1500);
    const rows = await page.locator('.admin-branches-table-wrap table tbody tr').count();
    console.log(`/admin/branches rows=${rows}`);
    await shot('05-admin-branches');
  });

  // ── Admin Receiving (/admin/receiving) — sh-table (all branches) ──
  await safe('admin-receiving', async () => {
    await go('/admin/receiving', 1600);
    const rows = await page.locator('.sh-table-scroll table tbody tr').count();
    console.log(`/admin/receiving rows=${rows}`);
    await shot('06-admin-receiving');
  });

  // ── Admin Transfers (/admin/transfers) — sh-table ──
  await safe('admin-transfers', async () => {
    await go('/admin/transfers', 1600);
    const rows = await page.locator('.sh-table-scroll table tbody tr').count();
    console.log(`/admin/transfers rows=${rows}`);
    await shot('07-admin-transfers');
  });

  // ── Admin Transfer Create (/admin/transfers/new) — inv-adj-table qty input ──
  await safe('admin-transfer-create', async () => {
    await go('/admin/transfers/new', 1500);
    await shot('08-admin-transfer-create');
  });

  // ── POS SupplierPage (/suppliers) — bare table (sup) ──
  await safe('pos-suppliers', async () => {
    await go('/suppliers', 1500);
    const rows = await page.locator('.sup-table-scroll table tbody tr').count();
    console.log(`/suppliers rows=${rows}`);
    await shot('09-pos-suppliers');
  });
} catch (err) {
  console.log(`✗ flow threw: ${err instanceof Error ? err.message : err}`);
} finally {
  console.log('\n=== runtime errors captured ===');
  if (errors.length === 0) console.log('(none)');
  else errors.forEach((e) => console.log(' • ' + e));
  await browser.close();
}
