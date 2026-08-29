import { createTauriDurableStorePort } from '../adapters/tauri/tauriDurableStorePort';
import type { DurableStoreKey, DurableStorePort, DurableStoreTxn } from '../ports/durableStorePort';
import { DURABLE_DOMAINS, type DurableDomainId } from './migrationManifest';
import { runFirstEpochCutover, type DomainDumper, type DomainDumpRow } from './epochSelector';
import { isTauriBridgeAvailable } from '../adapters/tauri/tauriDurableStorePort';

function nativeMethod<K extends keyof DurableStoreTxn>(txn: DurableStoreTxn, name: K): DurableStoreTxn[K] {
  return txn[name];
}

export function nativeTxnGet<T>(txn: DurableStoreTxn, store: string, key: DurableStoreKey): Promise<T | undefined> {
  return nativeMethod(txn, 'get')(store, key) as Promise<T | undefined>;
}

export function nativeTxnGetAll<T>(txn: DurableStoreTxn, store: string): Promise<T[]> {
  return nativeMethod(txn, 'getAll')(store) as Promise<T[]>;
}

export function nativeTxnGetAllKeys(txn: DurableStoreTxn, store: string): Promise<DurableStoreKey[]> {
  return nativeMethod(txn, 'getAllKeys')(store);
}

export function nativeTxnPut(
  txn: DurableStoreTxn,
  store: string,
  key: DurableStoreKey,
  value: unknown,
): Promise<void> {
  return nativeMethod(txn, 'put')(store, key, value);
}

export function nativeTxnDelete(txn: DurableStoreTxn, store: string, key: DurableStoreKey): Promise<void> {
  return nativeMethod(txn, 'delete')(store, key);
}

export type { DomainDumper, DomainDumpRow };

let nativeCommitted = false;
let committedEpochId: string | null = null;
let bootError: string | null = null;
let bootFatal = false;
let freezeLegacySuspendedBills = false;
const dumpers = new Map<DurableDomainId, DomainDumper>();
const portCache = new Map<string, DurableStorePort>();

export function registerDomainDumper(id: DurableDomainId, dump: DomainDumper): void {
  dumpers.set(id, dump);
}

export function isNativeCommittedDurableStore(): boolean {
  return nativeCommitted;
}

export function getCommittedEpochId(): string | null {
  return committedEpochId;
}

export function getDurableBootError(): string | null {
  return bootError;
}

export function isDurableStartupBlocked(): boolean {
  return bootFatal;
}

export function isLegacySuspendedBillsFrozen(): boolean {
  return freezeLegacySuspendedBills;
}

export function getCommittedDurableStore(database: string): DurableStorePort | null {
  if (bootFatal || !nativeCommitted || !committedEpochId) return null;
  const cached = portCache.get(database);
  if (cached) return cached;
  const spec = DURABLE_DOMAINS.find((d) => d.database === database);
  if (!spec) return null;
  const port = createTauriDurableStorePort({ database, epochId: committedEpochId });
  portCache.set(database, port);
  return port;
}

export async function bootNativeDurableStore(): Promise<void> {
  if (!isTauriBridgeAvailable()) return;
  try {
    const result = await runFirstEpochCutover({ dumpers });
    if (result.status === 'committed') {
      nativeCommitted = true;
      committedEpochId = result.epochId;
      freezeLegacySuspendedBills = true;
      bootError = null;
      bootFatal = false;
      return;
    }
    if (result.status === 'already-committed') {
      nativeCommitted = true;
      committedEpochId = result.epochId;
      freezeLegacySuspendedBills = true;
      bootError = null;
      bootFatal = false;
      return;
    }
    bootError = result.error;
  } catch (err) {
    bootError = err instanceof Error ? err.message : String(err);
    bootFatal = true;
    nativeCommitted = false;
    committedEpochId = null;
    freezeLegacySuspendedBills = false;
  }
}

export function __resetBootDurableStoreForTests(): void {
  nativeCommitted = false;
  committedEpochId = null;
  bootError = null;
  bootFatal = false;
  freezeLegacySuspendedBills = false;
  dumpers.clear();
  portCache.clear();
}

export function __setNativeCommittedForTests(epochId: string): void {
  nativeCommitted = true;
  committedEpochId = epochId;
  freezeLegacySuspendedBills = true;
  bootError = null;
  bootFatal = false;
}

export function __setDurableStartupBlockedForTests(message: string): void {
  bootFatal = true;
  bootError = message;
  nativeCommitted = false;
  committedEpochId = null;
  freezeLegacySuspendedBills = false;
}
