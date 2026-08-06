import { defineConfig } from 'vitest/config';

// Dedicated config for the P-OBS-1 ops suite (scripts/ops/* + their harness).
// Kept separate from vitest.config.ts (src unit tests), vitest.rules.config.ts
// (Firestore rules spec), and the Playwright tests/ dir so none of those
// runners pick these specs up. Structural precedent: vitest.rules.config.ts.
// Run via: npm run test:ops
export default defineConfig({
  test: {
    environment: 'node',
    include: ['ops-tests/**/*.spec.ts'],
    fileParallelism: false,
    // Each spec spawns a real bash process; on this repo's Windows/Git-Bash
    // dev host that alone can take several seconds, well past vitest's
    // 5000ms default. This is host overhead, not test logic — individual
    // `runE2Script`/`spawnE2Script` calls still pass their own tighter
    // `timeoutMs` for the script's own behavior.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
