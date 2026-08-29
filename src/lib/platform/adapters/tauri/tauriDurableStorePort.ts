import type { DurableStoreKey, DurableStoreMode, DurableStorePort, DurableStoreTxn } from '../../ports/durableStorePort';
import { decodeDurableKey, encodeDurableKey } from '../../durableStore/kvKeyCodec';

type TauriCore = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function getInvoke(): TauriCore['invoke'] {
  const g = globalThis as unknown as { window?: { __TAURI__?: { core?: TauriCore } }; __TAURI__?: { core?: TauriCore } };
  const invoke = g.window?.__TAURI__?.core?.invoke ?? g.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('Tauri durable-store bridge is unavailable');
  }
  return invoke;
}

export type TauriDurableStoreOptions = {
  database: string;
  epochId: string;
};

/**
 * JS adapter for the opaque native transaction session. Production `window.__TAURI__`
 * use is confined to this adapter path.
 */
export function createTauriDurableStorePort(options: TauriDurableStoreOptions): DurableStorePort {
  let nested = false;
  return {
    async transact<T>(
      stores: string[],
      mode: DurableStoreMode,
      fn: (txn: DurableStoreTxn) => Promise<T>,
    ): Promise<T> {
      if (nested) {
        throw new Error('nested durable transactions are unsupported');
      }
      nested = true;
      const invoke = getInvoke();
      let sessionId: string | undefined;
      try {
        const began = (await invoke('durable_kv_txn_begin', {
          database: options.database,
          stores,
          mode,
          epochId: options.epochId,
        })) as { sessionId: string };
        sessionId = began.sessionId;
        const txn: DurableStoreTxn = {
          get: async <R>(store: string, key: DurableStoreKey): Promise<R | undefined> => {
            const value = await invoke('durable_kv_txn_get', {
              sessionId,
              store,
              encodedKey: encodeDurableKey(key),
            });
            return (value === null || value === undefined ? undefined : value) as R | undefined;
          },
          getAll: async <R>(store: string): Promise<R[]> => {
            return (await invoke('durable_kv_txn_get_all', { sessionId, store })) as R[];
          },
          getAllKeys: async (store: string): Promise<DurableStoreKey[]> => {
            const encoded = (await invoke('durable_kv_txn_get_all_keys', { sessionId, store })) as string[];
            return encoded.map(decodeDurableKey);
          },
          put: async (store, key, value) => {
            await invoke('durable_kv_txn_put', {
              sessionId,
              store,
              encodedKey: encodeDurableKey(key),
              value,
            });
          },
          delete: async (store, key) => {
            await invoke('durable_kv_txn_delete', {
              sessionId,
              store,
              encodedKey: encodeDurableKey(key),
            });
          },
        };
        const result = await fn(txn);
        await invoke('durable_kv_txn_commit', { sessionId });
        sessionId = undefined;
        return result;
      } catch (err) {
        if (sessionId) {
          try {
            await invoke('durable_kv_txn_abort', { sessionId });
          } catch {
            /* native abort is best-effort after a command failure */
          }
        }
        throw err;
      } finally {
        nested = false;
      }
    },
  };
}

export async function invokeDurableManifestGet(): Promise<unknown> {
  return getInvoke()('durable_manifest_get');
}

export async function invokeDurableManifestPutEpoch(args: {
  epochId: string;
  status: string;
  inventoryJson: string;
  errorCode?: string;
  errorDetail?: string;
}): Promise<void> {
  await getInvoke()('durable_manifest_put_epoch', args);
}

export async function invokeDurableManifestLeaseAcquire(ownerId: string, ttlMs: number): Promise<boolean> {
  return (await getInvoke()('durable_manifest_lease_acquire', { ownerId, ttlMs })) as boolean;
}

export async function invokeDurableManifestLeaseHeartbeat(ownerId: string, ttlMs: number): Promise<void> {
  await getInvoke()('durable_manifest_lease_heartbeat', { ownerId, ttlMs });
}

export async function invokeDurableManifestLeaseRelease(ownerId: string): Promise<void> {
  await getInvoke()('durable_manifest_lease_release', { ownerId });
}

export function isTauriBridgeAvailable(): boolean {
  try {
    getInvoke();
    return true;
  } catch {
    return false;
  }
}
