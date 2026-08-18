import { beforeEach, describe, expect, test, vi } from 'vitest';

const callable = vi.fn();
const getFunctions = vi.fn(() => ({ __fns: true }));
const httpsCallable = vi.fn(() => callable);
const connectFunctionsEmulator = vi.fn();

vi.mock('firebase/functions', () => ({
  getFunctions: () => getFunctions(),
  httpsCallable: () => httpsCallable(),
  connectFunctionsEmulator: () => connectFunctionsEmulator(),
}));

vi.mock('../firebase', () => ({
  app: { name: 'app' },
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
}));

describe('H06 receiptFetch callable failure', () => {
  beforeEach(() => {
    callable.mockReset();
    vi.resetModules();
  });

  test('H06 callable failure never silently returns a locally composed unmarked envelope', async () => {
    callable.mockRejectedValue(new Error('unavailable'));
    const { fetchOrderReceipt } = await import('./receiptFetch');
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.envelope).toBeNull();
      expect(result.reason).toBe('callable_failed');
    }
  });
});
