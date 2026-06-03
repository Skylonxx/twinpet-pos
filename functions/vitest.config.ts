import { defineConfig } from 'vitest/config';

// Unit-test config for the Cloud Functions package. Scoped to PURE logic
// (e.g. voidReversal planners) that has no firebase-admin / emulator dependency,
// so it runs fast in CI without the Firestore emulator. `root` is pinned to this
// directory so it works whether invoked from here or from the repo root.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
