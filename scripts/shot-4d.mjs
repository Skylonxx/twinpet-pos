/**
 * Batch 4d visual verification — Receiving & Reports migrated tables.
 * Needs a running dev server (npm run dev) on :5173.
 * Run: node scripts/shot-4d.mjs   →  PNGs in .shots-4d/
 *
 * Targets: ReceivingForm (rcv-table, heavy inputs), ReceivingHistoryPage
 * (sh-table + sh-item-table drawer), DashboardPage (3 dash-mini + charts),
 * ProfitReportPage (sortable bill/group table).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const OUT = '.shots-4d';
mkdirSync(OUT, { recursive: true });
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); console.log(`  📸 ${n}.png`); };
const safe = async (label, fn) => { try { await fn(); } catch (e) { console.log(`  ⚠ ${label}: ${e instanceof Error ? e.message : e}`); } };

// add a product to the currently-open ProductPickerDialog (.pps-overlay)
async function pickFirstProduct() {
  await page.waitForSelector('.pps-overlay', { timeout: 8000 });
  await page.waitForTimeout(700);
  await page.locator('.pps-overlay table tbody tr .cb').first().check().catch(async () => {
    await page.locator('.pps-overlay table tbody tr').first().click();
  });
  await page.waitForTimeout(300);
  await page.locator('.pps-overlay .confirm-btn').click().catch(() => {});
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

  // ── DashboardPage (/dashboard): 3 dash-mini tables + charts ──
  await safe('dashboard', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const miniRows = await page.locator('.dash-tc-body table tbody tr').count();
    const canvases = await page.locator('.dash-content canvas').count();
    const kpis = await page.locator('.dash-kpi-card').count();
    console.log(`/dashboard miniTableRows=${miniRows} charts=${canvases} kpiCards=${kpis}`);
    await shot('01-dashboard');
  });

  // ── ProfitReportPage (/profit-report): sortable table ──
  await safe('profit-report', async () => {
    await page.goto(`${BASE}/profit-report`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    const rows = await page.locator('.pr-table-scroll table tbody tr').count();
    const heads = await page.locator('.pr-table-scroll table thead th').count();
    console.log(`/profit-report rows=${rows} headCells=${heads}`);
    await shot('02-profit-report-bill');
    // toggle a sortable header + switch grouping to exercise TableHeadCell onClick
    await safe('profit-sort', async () => {
      await page.locator('.pr-table-scroll table thead th').nth(5).click();
      await page.waitForTimeout(500);
      await shot('03-profit-report-sorted');
    });
    await safe('profit-group', async () => {
      await page.selectOption('select.pr-sel >> nth=0', 'product').catch(() => {});
      await page.waitForTimeout(700);
      await shot('04-profit-report-grouped');
    });
  });

  // ── ReceivingHistoryPage (/receiving/history): sh-table + drawer sh-item-table ──
  await safe('receiving-history', async () => {
    await page.goto(`${BASE}/receiving/history`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const rows = await page.locator('.sh-table-scroll table tbody tr').count();
    console.log(`/receiving/history rows=${rows}`);
    await shot('05-receiving-history');
    // open first record → drawer with the item table
    await safe('receiving-drawer', async () => {
      await page.locator('.sh-table-scroll table tbody tr').first().click();
      await page.waitForSelector('.sh-drawer.open', { timeout: 6000 });
      await page.waitForTimeout(900);
      const itemRows = await page.locator('.sh-drawer table tbody tr').count();
      console.log(`  drawer itemRows=${itemRows}`);
      await shot('06-receiving-history-drawer');
    });
  });

  // ── ReceivingForm (/receiving): rcv-table with heavy controlled inputs ──
  await safe('receiving-form', async () => {
    await page.goto(`${BASE}/receiving`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);
    await shot('07-receiving-form-empty');
    // add a product → row appears with qty/cost/discount inputs
    await safe('receiving-add', async () => {
      await page.getByRole('button', { name: /เพิ่มสินค้า|เลือกสินค้า/ }).first().click();
      await pickFirstProduct();
      const rows = await page.locator('.rcv-table-scroll table tbody tr').count();
      const inputs = await page.locator('.rcv-table-scroll table tbody input.rcv-ii').count();
      console.log(`receiving-form rows=${rows} boundInputs=${inputs}`);
      // type into the qty input to prove the controlled binding survived the migration
      await safe('receiving-qty-bind', async () => {
        const qty = page.locator('.rcv-table-scroll table tbody input.rcv-w56').first();
        await qty.fill('5');
        await page.waitForTimeout(300);
      });
      await shot('08-receiving-form-row');
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
