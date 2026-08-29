import { describe, expect, test, vi } from 'vitest';
import { createTauriDurableStorePort } from '../adapters/tauri/tauriDurableStorePort';

describe('nativeTxnProtocol', () => {
  function mockInvoke(handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
    const invoke = vi.fn(handler);
    (globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
      core: { invoke },
    };
    return invoke;
  }

  test('commit is invoked only after callback success', async () => {
    const invoke = mockInvoke(async (cmd) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 's1' };
      return undefined;
    });
    const port = createTauriDurableStorePort({ database: 'twinpet-offline-reversal', epochId: 'e1' });
    await port.transact(['intents', 'stock', 'ledger', 'markers'], 'readwrite', async (txn) => {
      await txn.put('intents', 'i1', { id: 'i1' });
      await txn.put('markers', 'm1', { id: 'm1' });
    });
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds[0]).toBe('durable_kv_txn_begin');
    expect(cmds.at(-1)).toBe('durable_kv_txn_commit');
    expect(cmds).not.toContain('durable_kv_txn_abort');
  });

  test('callback throw rolls back and does not commit', async () => {
    const invoke = mockInvoke(async (cmd) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 's2' };
      return undefined;
    });
    const port = createTauriDurableStorePort({ database: 'twinpet-sale-intent-journal', epochId: 'e1' });
    await expect(
      port.transact(['saleIntents', 'saleIntentEvents'], 'readwrite', async (txn) => {
        await txn.put('saleIntents', 'o1', { id: 'o1' });
        throw new Error('duplicate');
      }),
    ).rejects.toThrow('duplicate');
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('durable_kv_txn_abort');
    expect(cmds).not.toContain('durable_kv_txn_commit');
  });

  test('native command failure aborts the session', async () => {
    const invoke = mockInvoke(async (cmd) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 's3' };
      if (cmd === 'durable_kv_txn_put') throw new Error('busy');
      return undefined;
    });
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    await expect(
      port.transact(['kv'], 'readwrite', async (txn) => {
        await txn.put('kv', 'deviceSeq', 1);
      }),
    ).rejects.toThrow('busy');
    expect(invoke.mock.calls.map((c) => c[0])).toContain('durable_kv_txn_abort');
  });

  test('unknown session id is surfaced', async () => {
    mockInvoke(async (cmd) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 's4' };
      if (cmd === 'durable_kv_txn_get') throw new Error('unknown durable session');
      return undefined;
    });
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    await expect(
      port.transact(['kv'], 'readonly', async (txn) => txn.get('kv', 'deviceId')),
    ).rejects.toThrow(/unknown durable session/);
  });

  test('readonly session refuses put and rolls back', async () => {
    const invoke = mockInvoke(async (cmd) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 's5' };
      if (cmd === 'durable_kv_txn_put') throw new Error('readonly session cannot mutate');
      return undefined;
    });
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    await expect(
      port.transact(['kv'], 'readonly', async (txn) => {
        await txn.put('kv', 'deviceSeq', 1);
      }),
    ).rejects.toThrow(/readonly session cannot mutate/);
    expect(invoke.mock.calls.map((c) => c[0])).toContain('durable_kv_txn_abort');
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('durable_kv_txn_commit');
  });
});
