import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Firebase surface so importing the wrapper has no side effects and the
// callable invocation is observable (node env — no real Functions client).
const callableMock = vi.fn();
vi.mock('../firebase', () => ({ app: { __app: true }, USE_EMULATOR: false }));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({ __fns: true }),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: () => callableMock,
}));

import { callRetryReconcile } from './retryReconcile';
import { mapRetryError } from './exceptionRows';

beforeEach(() => callableMock.mockReset());

describe('callRetryReconcile (callable wrapper)', () => {
  it('invokes the retryReconcile callable with { orderId }', async () => {
    callableMock.mockResolvedValueOnce({ data: { success: true } });
    await callRetryReconcile('o1');
    expect(callableMock).toHaveBeenCalledWith({ orderId: 'o1' });
  });

  it('propagates the callable error to the caller', async () => {
    callableMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'functions/permission-denied' }));
    await expect(callRetryReconcile('o1')).rejects.toThrow('nope');
  });
});

describe('mapRetryError (HttpsError code → admin message)', () => {
  it('maps each known code to a distinct message', () => {
    expect(mapRetryError('permission-denied')).toContain('admin');
    expect(mapRetryError('failed-precondition')).toBeTruthy();
    expect(mapRetryError('resource-exhausted')).toContain('สูงสุด');
    expect(mapRetryError('not-found')).toBeTruthy();
    expect(mapRetryError('unauthenticated')).toBeTruthy();
  });
  it('falls back for unknown/undefined codes', () => {
    expect(mapRetryError(undefined)).toBeTruthy();
    expect(mapRetryError('weird')).toBeTruthy();
  });
});
