/** Platform-neutral KV durable-store contract. No SQL / native types. */

export type DurableStoreMode = 'readonly' | 'readwrite';

export interface DurableStoreTxn {
  get<T>(store: string, key: string): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  put(store: string, key: string, value: unknown): Promise<void>;
  delete(store: string, key: string): Promise<void>;
}

export interface DurableStorePort {
  transact<T>(
    stores: string[],
    mode: DurableStoreMode,
    fn: (txn: DurableStoreTxn) => Promise<T>,
  ): Promise<T>;
}
