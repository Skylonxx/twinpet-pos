/** Platform-neutral KV durable-store contract. No SQL / native types. */

export type DurableStoreMode = 'readonly' | 'readwrite';

export type DurableStoreKey = string | string[];

export interface DurableStoreTxn {
  get<T>(store: string, key: DurableStoreKey): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  getAllKeys(store: string): Promise<DurableStoreKey[]>;
  put(store: string, key: DurableStoreKey, value: unknown): Promise<void>;
  delete(store: string, key: DurableStoreKey): Promise<void>;
}

export interface DurableStorePort {
  transact<T>(
    stores: string[],
    mode: DurableStoreMode,
    fn: (txn: DurableStoreTxn) => Promise<T>,
  ): Promise<T>;
}
