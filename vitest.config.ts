import { defineConfig } from 'vitest/config';

// Unit-test config (kept separate from vite.config.ts so the dev/build and
// Playwright e2e setup stay untouched). Vitest auto-prefers this file.
export default defineConfig({
  test: {
    environment: 'node',
    // Co-located *.test.ts unit specs only — Playwright specs live in /tests.
    include: ['src/**/*.test.ts'],
  },
});
