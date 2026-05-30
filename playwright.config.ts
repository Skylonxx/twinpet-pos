import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for TwinPet POS E2E tests.
 *
 * Isolation strategy
 * ──────────────────
 * • Port 5174 is used exclusively for tests.  The normal dev server runs on
 *   5173, so there is zero risk of Playwright accidentally reusing a server
 *   that loaded `.env.local` (real Firebase credentials).
 *
 * • `reuseExistingServer: false` ensures a fresh Vite process is always
 *   started for tests, even in local development.  This is the critical guard
 *   that prevents the "port already in use → reuse live server → real Firebase"
 *   footgun.
 *
 * • `--mode test` tells Vite to load `.env.test`, which has higher priority
 *   than `.env.local` for mode-specific files (Vite priority order:
 *   .env.[mode].local > .env.[mode] > .env.local > .env).
 *   `.env.test` sets all VITE_FIREBASE_* vars to empty strings, making
 *   `isFirebaseConfigured = false` and forcing 100 % dev-mock data.
 */
export default defineConfig({
  // Where the spec files live. Resolved relative to this config file.
  testDir: './tests',
  // Explicit glob so the UI/CLI always knows what counts as a test file.
  // (This is also Playwright's default, stated here to remove any ambiguity.)
  testMatch: '**/*.spec.ts',
  fullyParallel: false, // POS tests share browser state; run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: 'http://localhost:5174',   // dedicated test port
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // Always start a fresh server with --mode test on port 5174.
    // Never reuse an existing server — it might be the dev server on 5173
    // that loaded real Firebase credentials from .env.local.
    command: 'npm run dev -- --mode test --port 5174',
    url: 'http://localhost:5174',
    reuseExistingServer: false,   // ← the critical fix
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
