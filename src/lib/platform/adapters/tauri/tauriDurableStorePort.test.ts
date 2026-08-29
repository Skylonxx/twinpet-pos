import { describe, expect, test, vi } from 'vitest';
import { createTauriDurableStorePort } from './tauriDurableStorePort';
import { encodeDurableKey } from '../../durableStore/kvKeyCodec';

describe('tauriDurableStorePort', () => {
  test('encodes keys, commits on success, and aborts on callback throw', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 'sess-1' };
      if (cmd === 'durable_kv_txn_get_all_keys') return [encodeDurableKey('a')];
      if (cmd === 'durable_kv_txn_get') return { n: 1 };
      return undefined;
    });
    (globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
      core: { invoke },
    };
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    const result = await port.transact(['kv'], 'readwrite', async (txn) => {
      await txn.put('kv', 'a', { n: 1 });
      expect(await txn.get('kv', 'a')).toEqual({ n: 1 });
      expect(await txn.getAllKeys('kv')).toEqual(['a']);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      'durable_kv_txn_begin',
      'durable_kv_txn_put',
      'durable_kv_txn_get',
      'durable_kv_txn_get_all_keys',
      'durable_kv_txn_commit',
    ]);

    await expect(
      port.transact(['kv'], 'readwrite', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(invoke.mock.calls.map((c) => c[0]).filter((c) => c === 'durable_kv_txn_abort')).toEqual([
      'durable_kv_txn_abort',
    ]);
  });

  test('rejects nested transactions', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 'sess-2' };
      return undefined;
    });
    (globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
      core: { invoke },
    };
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    await expect(
      port.transact(['kv'], 'readwrite', async (txn) => {
        await port.transact(['kv'], 'readonly', async () => undefined);
        return txn;
      }),
    ).rejects.toThrow(/nested/);
  });
});
