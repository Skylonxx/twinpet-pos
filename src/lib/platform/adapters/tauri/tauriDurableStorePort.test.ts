import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NATIVE_INVOKE_TIMEOUT_MS, createTauriDurableStorePort } from './tauriDurableStorePort';
import { encodeDurableKey } from '../../durableStore/kvKeyCodec';

function installBridge(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): void {
  (globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
    core: { invoke },
  };
}

describe('tauriDurableStorePort', () => {
  afterEach(() => {
    delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
  });

  test('encodes keys, commits on success, and aborts on callback throw', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 'sess-1' };
      if (cmd === 'durable_kv_txn_get_all_keys') return [encodeDurableKey('a')];
      if (cmd === 'durable_kv_txn_get') return { n: 1 };
      return undefined;
    });
    installBridge(invoke);
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
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    await expect(
      port.transact(['kv'], 'readwrite', async (txn) => {
        await port.transact(['kv'], 'readonly', async () => undefined);
        return txn;
      }),
    ).rejects.toThrow(/nested/);
  });
});

describe('tauriDurableStorePort P01 — latch recovery + session fencing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
    vi.useRealTimers();
  });

  test('begin invoke never settles -> local 2s timeout -> transact fails closed', async () => {
    const invoke = vi.fn(() => new Promise<unknown>(() => {}));
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });

    const p = port.transact(['kv'], 'readwrite', async () => 'never');
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(NATIVE_INVOKE_TIMEOUT_MS);
    await assertion;
  });

  test('latch is cleared after timeout and a later top-level transact may start', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return new Promise<unknown>(() => {});
      return Promise.resolve(undefined);
    });
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });

    const first = port.transact(['kv'], 'readwrite', async () => 'never');
    const firstAssertion = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(NATIVE_INVOKE_TIMEOUT_MS);
    await firstAssertion;

    // A later top-level transact must not throw "nested durable transactions are unsupported".
    const invoke2 = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 'sess-fresh' };
      return undefined;
    });
    installBridge(invoke2);
    const port2 = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    await expect(port2.transact(['kv'], 'readwrite', async () => 'ok')).resolves.toBe('ok');
  });

  test('late settlement from a prior timed-out invocation is stale-discarded and produces no unhandled rejection', async () => {
    let releaseBegin: ((v: unknown) => void) | null = null;
    let releaseGet: ((v: unknown) => void) | null = null;
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') {
        return new Promise((resolve) => {
          releaseBegin = resolve;
        });
      }
      if (cmd === 'durable_kv_txn_get') {
        return new Promise((_, reject) => {
          releaseGet = () => reject(new Error('late native failure'));
        });
      }
      return Promise.resolve(undefined);
    });
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });

    const p = port.transact(['kv'], 'readwrite', async () => 'never');
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(NATIVE_INVOKE_TIMEOUT_MS);
    await assertion;

    // The begin invoke settles LATE, after the transact already failed closed.
    expect(releaseBegin).not.toBeNull();
    releaseBegin!({ sessionId: 'stale-session' });
    await Promise.resolve();
    await Promise.resolve();
    // No unhandled rejection should have been thrown by the runtime by this point.

    void releaseGet; // never invoked in this test — begin itself never resolved in time
  });

  test('stale prior operation cannot poison or return data into a newer transaction on the same port', async () => {
    const getResolvers: Array<(v: unknown) => void> = [];
    let sessionCounter = 0;
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return Promise.resolve({ sessionId: `sess-${sessionCounter++}` });
      if (cmd === 'durable_kv_txn_get') {
        return new Promise((resolve) => {
          getResolvers.push(resolve);
        });
      }
      if (cmd === 'durable_kv_txn_commit') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });

    const first = port.transact(['kv'], 'readwrite', async (txn) => txn.get('kv', 'a'));
    const firstAssertion = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(NATIVE_INVOKE_TIMEOUT_MS);
    await firstAssertion;
    expect(getResolvers).toHaveLength(1);

    const second = port.transact(['kv'], 'readwrite', async (txn) => txn.get('kv', 'b'));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(getResolvers).toHaveLength(2);

    // Late-settle the FIRST (already-failed) get with stale data.
    getResolvers[0]!({ stale: true });
    await Promise.resolve();

    // Settle the SECOND transact's own get with fresh data.
    getResolvers[1]!({ fresh: true });
    const result = await second;
    expect(result).toEqual({ fresh: true });
  });

  test('current transaction successful path still commits normally under the bounded invoke', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 'sess-ok' };
      if (cmd === 'durable_kv_txn_get') return { value: 42 };
      return undefined;
    });
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    const result = await port.transact(['kv'], 'readwrite', async (txn) => txn.get('kv', 'a'));
    expect(result).toEqual({ value: 42 });
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      'durable_kv_txn_begin',
      'durable_kv_txn_get',
      'durable_kv_txn_commit',
    ]);
  });

  test('get/put/delete/commit timeout cannot poison the adapter forever — each failure is scoped to its own transact', async () => {
    const ops = ['durable_kv_txn_get', 'durable_kv_txn_put', 'durable_kv_txn_delete', 'durable_kv_txn_commit'];
    for (const hungOp of ops) {
      const invoke = vi.fn((cmd: string) => {
        if (cmd === 'durable_kv_txn_begin') return Promise.resolve({ sessionId: `sess-${hungOp}` });
        if (cmd === hungOp) return new Promise<unknown>(() => {});
        return Promise.resolve(undefined);
      });
      installBridge(invoke);
      const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });

      const p = port.transact(['kv'], 'readwrite', async (txn) => {
        await txn.put('kv', 'a', 1);
        await txn.get('kv', 'a');
        await txn.delete('kv', 'a');
        return 'ok';
      });
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(NATIVE_INVOKE_TIMEOUT_MS);
      await assertion;

      // The SAME port must accept a fresh top-level transact immediately after.
      const invokeOk = vi.fn(async (cmd: string) => {
        if (cmd === 'durable_kv_txn_begin') return { sessionId: 'sess-fresh' };
        return undefined;
      });
      installBridge(invokeOk);
      await expect(port.transact(['kv'], 'readwrite', async () => 'recovered')).resolves.toBe('recovered');
    }
  });

  test('unknown/expired native session fails closed (native rejects the command)', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 'expired-session' };
      if (cmd === 'durable_kv_txn_get') throw new Error('unknown session');
      return undefined;
    });
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    await expect(
      port.transact(['kv'], 'readwrite', async (txn) => txn.get('kv', 'a')),
    ).rejects.toThrow('unknown session');
  });

  test('native watchdog semantics are not reimplemented in JS (no 5s timer is armed by the adapter)', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 'sess-1' };
      return undefined;
    });
    installBridge(invoke);
    const port = createTauriDurableStorePort({ database: 'twinpet-device', epochId: 'e1' });
    const pending = vi.getTimerCount();
    void pending;
    await port.transact(['kv'], 'readwrite', async () => 'ok');
    // Only per-invoke 2s timers may ever be armed; none should remain after a clean commit.
    expect(vi.getTimerCount()).toBe(0);
  });
});
