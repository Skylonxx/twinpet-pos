import {
  REVERSAL_STORES,
  createIndexedDbReversalStore,
  type ReversalLocalStore,
  type ReversalStoreName,
} from '../../../pos/offline/reversalLocalStore';
import type {
  DurableStoreMode,
  DurableStorePort,
  DurableStoreTxn,
} from '../../ports/durableStorePort';

function asReversalStore(name: string): ReversalStoreName {
  if (!(REVERSAL_STORES as readonly string[]).includes(name)) {
    throw new Error(`Unknown browser durable store "${name}"`);
  }
  return name as ReversalStoreName;
}

/**
 * Delegates KV get/getAll/put/delete/transact to the existing IndexedDB reversal
 * store factory. Does not open a database in this module.
 */
export function createBrowserDurableStorePort(
  store: ReversalLocalStore = createIndexedDbReversalStore(),
): DurableStorePort {
  return {
    transact<T>(
      stores: string[],
      mode: DurableStoreMode,
      fn: (txn: DurableStoreTxn) => Promise<T>,
    ): Promise<T> {
      const reversalStores = stores.map(asReversalStore);
      return store.transact(reversalStores, mode, (txn) =>
        fn({
          get: (name, key) => txn.get(asReversalStore(name), key),
          getAll: (name) => txn.getAll(asReversalStore(name)),
          put: (name, key, value) => txn.put(asReversalStore(name), key, value),
          delete: (name, key) => txn.delete(asReversalStore(name), key),
        }),
      );
    },
  };
}
