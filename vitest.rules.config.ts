import { defineConfig } from 'vitest/config';

// Dedicated config for the Firestore rules validation spec. Kept separate from
// vitest.config.ts (src unit tests) and the Playwright tests/ dir so neither
// runner picks up the rules spec. Run under the Firestore emulator via:
//   firebase emulators:exec --only firestore --project demo-twinpet \
//     "npx vitest run --config vitest.rules.config.ts"
export default defineConfig({
  test: {
    environment: 'node',
    include: ['rules-tests/**/*.spec.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
