import { defineConfig } from 'vitest/config';

// Unit-test config for the Ops-only scripts package. `root` is pinned to this
// directory (mirrors functions/vitest.config.ts) so it works whether invoked
// from here or from the repo root; tests are colocated with the scripts they
// cover rather than under src/.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'lib/**'],
  },
});
