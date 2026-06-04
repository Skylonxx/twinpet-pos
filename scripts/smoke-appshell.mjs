/**
 * Headless smoke test for the Batch 2a Flowbite Sidebar migration.
 * Drives the already-running dev server on :5173, logs in (branch LDP-001 + PIN
 * 1234 — works for both the seeded emulator admin and dev-mock somchai), then
 * visits the main layout routes asserting NO White-Screen-of-Death (React tree
 * unmount) and NO runtime console/page errors.
 *
 * Run: node scripts/smoke-appshell.mjs   (needs a Vite dev server on :5173)
 */
import { chromium } from '@playwright/test';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173';
const errors = [];
let failed = false;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function rootState() {
  return page.evaluate(() => ({
    children: document.getElementById('root')?.childElementCount ?? 0,
    textLen: document.body.innerText.trim().length,
  }));
}

try {
  // ── Login page ──────────────────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#branch-sel', { state: 'visible', timeout: 20_000 });
  const login = await rootState();
  console.log(`/login → root children=${login.children}, textLen=${login.textLen}`);

  // Pick LDP-001 if present, else the first real option.
  const values = await page.$$eval('#branch-sel option', (os) =>
    os.map((o) => o.value).filter(Boolean),
  );
  const branch = values.includes('LDP-001') ? 'LDP-001' : values[0];
  if (branch) await page.selectOption('#branch-sel', branch);
  console.log(`selected branch: ${branch}`);

  // Enter PIN 1-2-3-4 on the keypad (350ms between presses for React closures).
  for (const d of ['1', '2', '3', '4']) {
    await page.click(`.login-pin-btn:text-is("${d}")`);
    await page.waitForTimeout(350);
  }

  // Wait for the session to be written (login succeeded).
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem('twinpet_session');
      if (!raw) return false;
      try {
        const s = JSON.parse(raw);
        return Boolean(s?.user?.id && s?.branchId);
      } catch {
        return false;
      }
    },
    { timeout: 25_000 },
  );
  console.log('✓ session established (login OK)');

  // ── Main layout routes — the AppShell / Flowbite Sidebar mounts here ──────
  const routes = ['/dashboard', '/products', '/stock-report', '/settings', '/admin'];
  for (const path of routes) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const st = await rootState();
    const wsod = st.children === 0 || st.textLen < 5;
    console.log(`${path} → root children=${st.children}, textLen=${st.textLen}${wsod ? '  ❌ WSOD' : '  ✓'}`);
    if (wsod) failed = true;
  }

  // Confirm the sidebar actually rendered on a layout route.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const sidebar = await page.locator('[aria-label="แถบนำทาง"]').count();
  console.log(`sidebar [aria-label="แถบนำทาง"] count=${sidebar}`);
  if (sidebar === 0) failed = true;
} catch (err) {
  console.log(`✗ smoke flow threw: ${err instanceof Error ? err.message : err}`);
  failed = true;
} finally {
  await browser.close();
}

console.log('\n=== runtime errors captured ===');
if (errors.length === 0) console.log('(none)');
else errors.forEach((e) => console.log(' • ' + e));

process.exit(failed || errors.length > 0 ? 1 : 0);
