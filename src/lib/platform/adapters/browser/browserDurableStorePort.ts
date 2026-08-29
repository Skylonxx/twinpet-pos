import {
  REVERSAL_STORES,
  createIndexedDbReversalStore,
  type ReversalLocalStore,
  type ReversalStoreName,
} from '../../../pos/offline/reversalLocalStore';
import {
  SALE_INTENT_JOURNAL_STORES,
  createIndexedDbSaleIntentJournalStore,
  type SaleIntentJournalStore,
  type SaleIntentJournalStoreName,
} from '../../../pos/offline/saleIntentJournalStore';
import { createIndexedDbShiftCloseIntentStore } from '../../../pos/offline/shiftCloseIntentStore';
import { createIndexedDbShiftOpenIntentStore } from '../../../pos/offline/shiftOpenIntentStore';
import type {
  DurableStoreKey,
  DurableStoreMode,
  DurableStorePort,
  DurableStoreTxn,
} from '../../ports/durableStorePort';

type BackendKind = 'reversal' | 'journal' | 'shiftOpen' | 'shiftClose';

type Backend = {
  kind: BackendKind;
  stores: ReadonlySet<string>;
  transact: DurableStorePort['transact'];
};

const REVERSAL_SET = new Set<string>(REVERSAL_STORES);
const JOURNAL_SET = new Set<string>(SALE_INTENT_JOURNAL_STORES);
const SHIFT_OPEN_SET = new Set<string>(['shiftOpenIntents']);
const SHIFT_CLOSE_SET = new Set<string>(['shiftCloseIntents']);

function asReversalStore(name: string): ReversalStoreName {
  if (!(REVERSAL_STORES as readonly string[]).includes(name)) {
    throw new Error(`Unknown browser durable store "${name}"`);
  }
  return name as ReversalStoreName;
}

function asJournalStore(name: string): SaleIntentJournalStoreName {
  if (!(SALE_INTENT_JOURNAL_STORES as readonly string[]).includes(name)) {
    throw new Error(`Unknown browser durable store "${name}"`);
  }
  return name as SaleIntentJournalStoreName;
}

function requireStringKey(store: string, key: DurableStoreKey): string {
  if (typeof key !== 'string') {
    throw new Error(`Store "${store}" does not accept array keys`);
  }
  return key;
}

function wrapReversal(store: ReversalLocalStore): DurableStorePort {
  return {
    transact<T>(stores: string[], mode: DurableStoreMode, fn: (txn: DurableStoreTxn) => Promise<T>) {
      const reversalStores = stores.map(asReversalStore);
      return store.transact(reversalStores, mode, (txn) =>
        fn({
          get: (name, key) => txn.get(asReversalStore(name), requireStringKey(name, key)),
          getAll: (name) => txn.getAll(asReversalStore(name)),
          getAllKeys: (name) => {
            if (!txn.getAllKeys) return Promise.reject(new Error('getAllKeys unavailable'));
            return txn.getAllKeys(asReversalStore(name));
          },
          put: (name, key, value) => txn.put(asReversalStore(name), requireStringKey(name, key), value),
          delete: (name, key) => txn.delete(asReversalStore(name), requireStringKey(name, key)),
        }),
      );
    },
  };
}

function wrapJournal(store: SaleIntentJournalStore): DurableStorePort {
  return {
    transact<T>(stores: string[], mode: DurableStoreMode, fn: (txn: DurableStoreTxn) => Promise<T>) {
      const journalStores = stores.map(asJournalStore);
      return store.transact(journalStores, mode, (txn) =>
        fn({
          get: (name, key) => txn.get(asJournalStore(name), requireStringKey(name, key)),
          getAll: (name) => txn.getAll(asJournalStore(name)),
          getAllKeys: (name) => txn.getAllKeys(asJournalStore(name)),
          put: (name, key, value) => txn.put(asJournalStore(name), requireStringKey(name, key), value),
          delete: (name, key) => txn.delete(asJournalStore(name), requireStringKey(name, key)),
        }),
      );
    },
  };
}

function wrapShiftOpen(): DurableStorePort {
  const store = createIndexedDbShiftOpenIntentStore();
  return {
    transact<T>(stores: string[], mode: DurableStoreMode, fn: (txn: DurableStoreTxn) => Promise<T>) {
      if (stores.some((name) => name !== 'shiftOpenIntents')) {
        throw new Error(`Unknown browser durable store "${stores.find((n) => n !== 'shiftOpenIntents')}"`);
      }
      return store.transact(['shiftOpenIntents'], mode, (txn) =>
        fn({
          get: (name, key) => txn.get('shiftOpenIntents', requireStringKey(name, key)),
          getAll: () => txn.getAll('shiftOpenIntents'),
          getAllKeys: () => txn.getAllKeys('shiftOpenIntents'),
          put: (name, key, value) => txn.put('shiftOpenIntents', requireStringKey(name, key), value),
          delete: () => Promise.reject(new Error('shift-open store does not expose delete')),
        }),
      );
    },
  };
}

function wrapShiftClose(): DurableStorePort {
  const store = createIndexedDbShiftCloseIntentStore();
  return {
    transact<T>(stores: string[], mode: DurableStoreMode, fn: (txn: DurableStoreTxn) => Promise<T>) {
      if (stores.some((name) => name !== 'shiftCloseIntents')) {
        throw new Error(`Unknown browser durable store "${stores.find((n) => n !== 'shiftCloseIntents')}"`);
      }
      return store.transact(['shiftCloseIntents'], mode, (txn) =>
        fn({
          get: (_name, key) => txn.get('shiftCloseIntents', key),
          getAll: () => txn.getAll('shiftCloseIntents'),
          getAllKeys: () => {
            if (!txn.getAllKeys) return Promise.reject(new Error('getAllKeys unavailable'));
            return txn.getAllKeys('shiftCloseIntents');
          },
          put: (_name, key, value) => txn.put('shiftCloseIntents', key, value),
          delete: () => Promise.reject(new Error('shift-close store does not expose delete')),
        }),
      );
    },
  };
}

function kindForStore(name: string): BackendKind {
  if (REVERSAL_SET.has(name)) return 'reversal';
  if (JOURNAL_SET.has(name)) return 'journal';
  if (SHIFT_OPEN_SET.has(name)) return 'shiftOpen';
  if (SHIFT_CLOSE_SET.has(name)) return 'shiftClose';
  throw new Error(`Unknown browser durable store "${name}"`);
}

/**
 * Delegates KV get/getAll/getAllKeys/put/delete/transact to existing IndexedDB
 * owner factories. Does not open a database in this module. Row29 cart/evidence
 * owners are not imported here.
 */
export function createBrowserDurableStorePort(
  store: ReversalLocalStore = createIndexedDbReversalStore(),
): DurableStorePort {
  const backends: Record<BackendKind, Backend> = {
    reversal: {
      kind: 'reversal',
      stores: REVERSAL_SET,
      transact: wrapReversal(store).transact,
    },
    journal: {
      kind: 'journal',
      stores: JOURNAL_SET,
      transact: wrapJournal(createIndexedDbSaleIntentJournalStore()).transact,
    },
    shiftOpen: {
      kind: 'shiftOpen',
      stores: SHIFT_OPEN_SET,
      transact: wrapShiftOpen().transact,
    },
    shiftClose: {
      kind: 'shiftClose',
      stores: SHIFT_CLOSE_SET,
      transact: wrapShiftClose().transact,
    },
  };

  return {
    transact<T>(
      stores: string[],
      mode: DurableStoreMode,
      fn: (txn: DurableStoreTxn) => Promise<T>,
    ): Promise<T> {
      if (stores.length === 0) {
        return Promise.reject(new Error('durable transact requires at least one store'));
      }
      const kinds = new Set(stores.map(kindForStore));
      if (kinds.size !== 1) {
        return Promise.reject(
          new Error('browser durable transact cannot mix stores from different logical files'),
        );
      }
      const kind = [...kinds][0]!;
      return backends[kind].transact(stores, mode, fn);
    },
  };
}
