import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSafeId } from './safeId';

const NATIVE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('createSafeId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('uses crypto.randomUUID when available', () => {
    const randomUUID = vi.fn(() => NATIVE_UUID);
    vi.stubGlobal('crypto', { randomUUID });

    expect(createSafeId()).toBe(NATIVE_UUID);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  test('falls back when crypto.randomUUID is missing', () => {
    vi.stubGlobal('crypto', {});

    const id = createSafeId('suspended-bill');

    expect(id).toMatch(/^suspended-bill-/);
    expect(id.length).toBeGreaterThan('suspended-bill-'.length);
  });

  test('falls back when crypto.randomUUID throws', () => {
    const randomUUID = vi.fn(() => {
      throw new Error('secure context required');
    });
    vi.stubGlobal('crypto', { randomUUID });

    const id = createSafeId('cart');

    expect(id).toMatch(/^cart-/);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  test('fallback ids are non-empty and unique within a batch', () => {
    vi.stubGlobal('crypto', undefined);

    const ids = Array.from({ length: 20 }, () => createSafeId('test'));
    const unique = new Set(ids);

    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(unique.size).toBe(ids.length);
  });
});
