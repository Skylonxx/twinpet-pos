import type {
  CloseIntentErrorCode,
  CloseIntentResult,
  PointerRepairObserver,
  PointerRepairOutcome,
  ShiftCloseIntentBusinessSnapshot,
  ShiftCloseIntentEntry,
  ShiftCloseIntentObservabilityEvent,
  ShiftCloseIntentStatus,
} from './shiftCloseIntentTypes';
import { SHIFT_CLOSE_INTENT_STALE_AGE_MS } from './shiftCloseIntentTypes';

export type {
  PointerRepairObserver,
  PointerRepairOutcome,
  ShiftCloseIntentObservabilityEvent,
} from './shiftCloseIntentTypes';

// ── OBS-B0 compatibility floor marker (reader floor only; does not enable writes) ──

export const SHIFT_CLOSE_INTENT_STORAGE_COMPAT_FLOOR = 1 as const;

// ── Low-level KV store (modeled on saleIntentJournalStore.ts) ──────────────

type ShiftCloseIntentStoreName = 'shiftCloseIntents';
const SHIFT_CLOSE_INTENT_STORES: ShiftCloseIntentStoreName[] = ['shiftCloseIntents'];

/** Object-store key: string shiftId entries, or array keys for pointer metadata. */
type ShiftCloseIntentStoreKey = IDBValidKey;

interface ShiftCloseIntentTxn {
  get<T>(store: ShiftCloseIntentStoreName, key: ShiftCloseIntentStoreKey): Promise<T | undefined>;
  getAll<T>(store: ShiftCloseIntentStoreName): Promise<T[]>;
  put(store: ShiftCloseIntentStoreName, key: ShiftCloseIntentStoreKey, value: unknown): Promise<void>;
}

interface ShiftCloseIntentKvStore {
  transact<T>(
    stores: ShiftCloseIntentStoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (txn: ShiftCloseIntentTxn) => Promise<T>,
  ): Promise<T>;
}

export const SHIFT_CLOSE_INTENT_DB_NAME = 'twinpet-shift-close-intent';
export const SHIFT_CLOSE_INTENT_DB_VERSION = 1;

function openShiftCloseIntentDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(SHIFT_CLOSE_INTENT_DB_NAME, SHIFT_CLOSE_INTENT_DB_VERSION);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        for (const s of SHIFT_CLOSE_INTENT_STORES) {
          if (!dbi.objectStoreNames.contains(s)) dbi.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function createIndexedDbShiftCloseIntentStore(): ShiftCloseIntentKvStore {
  return {
    transact<T>(
      stores: ShiftCloseIntentStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ShiftCloseIntentTxn) => Promise<T>,
    ): Promise<T> {
      return openShiftCloseIntentDb().then(
        (dbi) =>
          new Promise<T>((resolve, reject) => {
            if (!dbi) {
              reject(new Error('IndexedDB unavailable'));
              return;
            }
            let result: T;
            let settled = false;
            const fail = (err: unknown) => {
              if (settled) return;
              settled = true;
              dbi.close();
              reject(err instanceof Error ? err : new Error(String(err)));
            };

            let tx: IDBTransaction;
            try {
              tx = dbi.transaction(stores, mode);
            } catch (err) {
              fail(err);
              return;
            }

            const txn: ShiftCloseIntentTxn = {
              get: (store, key) => reqP(tx.objectStore(store).get(key)),
              getAll: (store) => reqP(tx.objectStore(store).getAll()),
              put: (store, key, value) =>
                reqP(tx.objectStore(store).put(value, key)).then(() => undefined),
            };

            tx.oncomplete = () => {
              if (settled) return;
              settled = true;
              dbi.close();
              resolve(result);
            };
            tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'));

            Promise.resolve()
              .then(() => fn(txn))
              .then((r) => {
                result = r;
              })
              .catch((err) => {
                try {
                  tx.abort();
                } catch {
                  /* already aborting */
                }
                fail(err);
              });
          }),
      );
    },
  };
}

/** Encode IDBValidKey for Map storage while preserving string-before-array getAll order. */
function encodeStoreKey(key: ShiftCloseIntentStoreKey): string {
  if (typeof key === 'string') return `s:${key}`;
  if (Array.isArray(key)) return `a:${JSON.stringify(key)}`;
  throw new Error('unsupported shift-close-intent store key');
}

function decodeDumpKey(encoded: string): string {
  if (encoded.startsWith('s:')) return encoded.slice(2);
  return encoded;
}

export function createInMemoryShiftCloseIntentStore(): ShiftCloseIntentKvStore & {
  dump(): Record<ShiftCloseIntentStoreName, Record<string, unknown>>;
} {
  const data: Record<ShiftCloseIntentStoreName, Map<string, unknown>> = {
    shiftCloseIntents: new Map(),
  };

  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

  return {
    async transact<T>(
      stores: ShiftCloseIntentStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ShiftCloseIntentTxn) => Promise<T>,
    ): Promise<T> {
      const working = new Map<ShiftCloseIntentStoreName, Map<string, unknown>>();
      for (const s of stores) {
        const copy = new Map<string, unknown>();
        for (const [k, v] of data[s]) copy.set(k, clone(v));
        working.set(s, copy);
      }
      const ensure = (store: ShiftCloseIntentStoreName): Map<string, unknown> => {
        const m = working.get(store);
        if (!m) throw new Error(`store "${store}" not in transaction scope`);
        return m;
      };

      const txn: ShiftCloseIntentTxn = {
        async get<R>(store: ShiftCloseIntentStoreName, key: ShiftCloseIntentStoreKey): Promise<R | undefined> {
          return clone(ensure(store).get(encodeStoreKey(key))) as R | undefined;
        },
        async getAll<R>(store: ShiftCloseIntentStoreName): Promise<R[]> {
          // IndexedDB orders string keys before array keys; mirror that for parity.
          const entries: unknown[] = [];
          const pointers: unknown[] = [];
          for (const [k, v] of ensure(store)) {
            if (k.startsWith('s:')) entries.push(clone(v));
            else pointers.push(clone(v));
          }
          return [...entries, ...pointers] as R[];
        },
        async put(store, key, value) {
          if (mode !== 'readwrite') throw new Error('put in readonly transaction');
          ensure(store).set(encodeStoreKey(key), clone(value));
        },
      };

      const result = await fn(txn);
      if (mode === 'readwrite') {
        for (const s of stores) data[s] = working.get(s)!;
      }
      return result;
    },

    dump() {
      const out = {} as Record<ShiftCloseIntentStoreName, Record<string, unknown>>;
      for (const s of SHIFT_CLOSE_INTENT_STORES) {
        out[s] = {};
        for (const [k, v] of data[s]) out[s][decodeDumpKey(k)] = v;
      }
      return out;
    },
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Explicit caller-owned business field list (OBS-B1B: exactly 17).
 * Deliberately NOT `Object.keys(a)`, because callers may pass a
 * `ShiftCloseIntentEntry` (business fields plus generated/status/timestamp
 * fields) as `a`; comparing by the full object's own keys would spuriously
 * fail on those extra fields. Generated metadata (`closedAtLocal`,
 * `closeCorrelationId`) is excluded from business equality.
 */
const BUSINESS_SNAPSHOT_FIELDS: (keyof ShiftCloseIntentBusinessSnapshot)[] = [
  'shiftId',
  'branchId',
  'staffId',
  'staffName',
  'startingCash',
  'expectedCash',
  'expectedQr',
  'expectedKbank',
  'expectedCard',
  'expectedCredit',
  'payInTotal',
  'payOutTotal',
  'totalBills',
  'actualCashCount',
  'variance',
  'note',
  'deviceId',
];

const SNAPSHOT_STRING_FIELDS = ['shiftId', 'branchId', 'staffId', 'staffName', 'note'] as const;
const SNAPSHOT_NUMBER_FIELDS = [
  'startingCash',
  'expectedCash',
  'expectedQr',
  'expectedKbank',
  'expectedCard',
  'expectedCredit',
  'payInTotal',
  'payOutTotal',
  'totalBills',
  'actualCashCount',
  'variance',
] as const;

/** Lowercase RFC-4122 version-4 UUID (variant 8/9/a/b). */
const LOWERCASE_UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidLowercaseUuidV4(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_UUID_V4_RE.test(value);
}

function uuidV4FromSecureRandomBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push(bytes[i]!.toString(16).padStart(2, '0'));
  }
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-` +
    `${hex[4]}${hex[5]}-` +
    `${hex[6]}${hex[7]}-` +
    `${hex[8]}${hex[9]}-` +
    `${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  );
}

/**
 * OBS-B1B UUID contract: randomUUID → getRandomValues → null.
 * Never uses Math.random; never throws solely because crypto is unavailable.
 */
export function generateShiftCloseCorrelationId(): string | null {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoObj?.randomUUID === 'function') {
    const id = cryptoObj.randomUUID();
    return typeof id === 'string' ? id.toLowerCase() : null;
  }
  if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return uuidV4FromSecureRandomBytes(bytes);
  }
  return null;
}

/**
 * Field-wise equality over the 17 caller-owned business fields only
 * (never status/timestamps/generated metadata).
 */
export function snapshotsEqual(
  a: ShiftCloseIntentBusinessSnapshot,
  b: ShiftCloseIntentBusinessSnapshot,
): boolean {
  return BUSINESS_SNAPSHOT_FIELDS.every((k) => a[k] === b[k]);
}

/**
 * Purely computed "needs attention" display state — never stored as a
 * transition. A still-pending close-intent older than the threshold reads as
 * stale on any read, without a background sweep or a written status change.
 */
export function isStaleClosePending(
  entry: Pick<ShiftCloseIntentEntry, 'status' | 'closedAtLocal'>,
  nowMs: number,
): boolean {
  if (entry.status !== 'local_closed_pending') return false;
  return nowMs - entry.closedAtLocal >= SHIFT_CLOSE_INTENT_STALE_AGE_MS;
}

// ── OBS-B0 classification / pointer / bounded-reader substrate ───────────

export type LatestCloseIntentPointer = {
  kind: 'latestCloseIntentByDevice';
  version: 1;
  deviceId: string;
  shiftId: string;
  closedAtLocal: number;
};

export type ListCloseIntentsCorruptionReason =
  | 'unknown_record'
  | 'malformed_pointer'
  | 'malformed_entry';

export type ExistingStorageFailure = {
  ok: false;
  code: CloseIntentErrorCode;
  message?: string;
};

export type ListCloseIntentsResult =
  | { ok: true; value: ShiftCloseIntentEntry[] }
  | {
      ok: false;
      code: 'unreadable_record';
      reason: ListCloseIntentsCorruptionReason;
      unknownRecordCount: number;
    }
  | ExistingStorageFailure;

export type BoundedCloseIntentUnreadableReason =
  | 'pointer_invalid'
  | 'pointer_version_unsupported'
  | 'pointer_target_missing'
  | 'pointer_device_mismatch'
  | 'pointer_target_invalid'
  | 'pointer_timestamp_invalid'
  | 'storage_unavailable'
  | 'device_identity_unavailable';

export type LatestCloseIntentForDeviceResult =
  | { status: 'ok'; entry: ShiftCloseIntentEntry }
  | { status: 'none' }
  | { status: 'unreadable'; reason: BoundedCloseIntentUnreadableReason };

export function latestByDevicePointerKey(deviceId: string): IDBValidKey {
  return ['__twinpet_meta__', 'latestCloseIntentByDevice', deviceId];
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function isValidLocalTimestamp(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Structural discriminator only — never sufficient to treat as valid metadata. */
export function isPointerShaped(v: unknown): boolean {
  return isPlainRecord(v) && v.kind === 'latestCloseIntentByDevice';
}

function isValidV1Pointer(v: unknown): v is LatestCloseIntentPointer {
  if (!isPointerShaped(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.version === 1 &&
    typeof r.deviceId === 'string' &&
    r.deviceId.length > 0 &&
    typeof r.shiftId === 'string' &&
    r.shiftId.length > 0 &&
    isValidLocalTimestamp(r.closedAtLocal)
  );
}

function isCloseIntentEntry(v: unknown): v is ShiftCloseIntentEntry {
  if (!isPlainRecord(v)) return false;
  if ('kind' in v) return false;

  for (const field of SNAPSHOT_STRING_FIELDS) {
    if (typeof v[field] !== 'string') return false;
  }
  if ((v.shiftId as string).length === 0) return false;

  for (const field of SNAPSHOT_NUMBER_FIELDS) {
    if (!isFiniteNumber(v[field])) return false;
  }

  if (!(typeof v.deviceId === 'string' || v.deviceId === null)) return false;
  if (!isValidLocalTimestamp(v.closedAtLocal)) return false;

  // Historical physical absence of closeCorrelationId is valid (read-normalizes to null).
  // Present null is valid. Present non-null must be a lowercase v4 UUID — never coerced.
  if ('closeCorrelationId' in v) {
    const corr = v.closeCorrelationId;
    if (!(corr === null || isValidLowercaseUuidV4(corr))) return false;
  }

  if (
    v.status !== 'local_closed_pending' &&
    v.status !== 'synced' &&
    v.status !== 'rejected_manual_attention'
  ) {
    return false;
  }
  if (!isValidLocalTimestamp(v.createdAtLocal)) return false;
  if (!isValidLocalTimestamp(v.updatedAtLocal)) return false;
  if (!(typeof v.lastErrorMessage === 'string' || v.lastErrorMessage === null)) return false;

  return true;
}

/**
 * Read-view normalization only: historical physical absence of
 * `closeCorrelationId` becomes `null`. Never write this back.
 */
function normalizeCloseIntentEntry(entry: Record<string, unknown>): ShiftCloseIntentEntry {
  const closeCorrelationId =
    'closeCorrelationId' in entry
      ? (entry.closeCorrelationId as string | null)
      : null;
  return { ...(entry as unknown as ShiftCloseIntentEntry), closeCorrelationId };
}

function classifyListRecords(records: unknown[]): ListCloseIntentsResult {
  const entries: ShiftCloseIntentEntry[] = [];
  let unknownRecordCount = 0;
  let reason: ListCloseIntentsCorruptionReason | null = null;

  const markCorrupt = (next: ListCloseIntentsCorruptionReason) => {
    unknownRecordCount += 1;
    if (!reason) reason = next;
  };

  for (const raw of records) {
    if (isPointerShaped(raw)) {
      if (isValidV1Pointer(raw)) continue;
      markCorrupt('malformed_pointer');
      continue;
    }
    if (isPlainRecord(raw) && !('kind' in raw)) {
      if (isCloseIntentEntry(raw)) {
        entries.push(normalizeCloseIntentEntry(raw));
        continue;
      }
      markCorrupt('malformed_entry');
      continue;
    }
    markCorrupt('unknown_record');
  }

  if (reason) {
    return {
      ok: false,
      code: 'unreadable_record',
      reason,
      unknownRecordCount,
    };
  }
  return { ok: true, value: entries };
}

function usableDeviceId(deviceId: unknown): deviceId is string {
  return typeof deviceId === 'string' && deviceId.length > 0;
}

async function readLatestCloseIntentForDeviceInTxn(
  txn: ShiftCloseIntentTxn,
  deviceId: string,
): Promise<LatestCloseIntentForDeviceResult> {
  const pointerRaw = await txn.get<unknown>(
    'shiftCloseIntents',
    latestByDevicePointerKey(deviceId),
  );

  if (pointerRaw === undefined) return { status: 'none' };

  if (!isPointerShaped(pointerRaw) || !isPlainRecord(pointerRaw)) {
    return { status: 'unreadable', reason: 'pointer_invalid' };
  }

  const version = pointerRaw.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    return { status: 'unreadable', reason: 'pointer_invalid' };
  }
  if (version !== 1) {
    return { status: 'unreadable', reason: 'pointer_version_unsupported' };
  }

  if (!isValidV1Pointer(pointerRaw)) {
    return { status: 'unreadable', reason: 'pointer_invalid' };
  }

  if (pointerRaw.deviceId !== deviceId) {
    return { status: 'unreadable', reason: 'pointer_device_mismatch' };
  }

  const targetRaw = await txn.get<unknown>('shiftCloseIntents', pointerRaw.shiftId);
  if (targetRaw === undefined) {
    return { status: 'unreadable', reason: 'pointer_target_missing' };
  }
  if (!isCloseIntentEntry(targetRaw)) {
    return { status: 'unreadable', reason: 'pointer_target_invalid' };
  }

  const target = normalizeCloseIntentEntry(targetRaw as unknown as Record<string, unknown>);

  if (pointerRaw.shiftId !== target.shiftId || pointerRaw.deviceId !== target.deviceId) {
    return { status: 'unreadable', reason: 'pointer_device_mismatch' };
  }
  if (pointerRaw.closedAtLocal !== target.closedAtLocal) {
    return { status: 'unreadable', reason: 'pointer_timestamp_invalid' };
  }

  return { status: 'ok', entry: target };
}

/**
 * OBS-B0 bounded reader substrate — max two record reads, no enumeration,
 * no write/read-repair, and not wired into production callers in this stage.
 */
export async function getLatestCloseIntentForDevice(
  deviceId: string,
  deps?: ShiftCloseIntentJournalDeps,
): Promise<LatestCloseIntentForDeviceResult> {
  if (!usableDeviceId(deviceId)) {
    return { status: 'unreadable', reason: 'device_identity_unavailable' };
  }

  const store = deps?.store ?? createIndexedDbShiftCloseIntentStore();
  try {
    return await store.transact(['shiftCloseIntents'], 'readonly', (txn) =>
      readLatestCloseIntentForDeviceInTxn(txn, deviceId),
    );
  } catch {
    return { status: 'unreadable', reason: 'storage_unavailable' };
  }
}

// ── OBS-B2 notifier registry (local + gated BroadcastChannel) ────────────

const SHIFT_CLOSE_INTENT_NOTIFIER_SYMBOL = Symbol.for('twinpet.shiftCloseIntentNotifier.v1');
const SHIFT_CLOSE_INTENT_BROADCAST_CHANNEL_NAME = 'twinpet-shift-close-intent';

type ShiftCloseIntentNotifierSubscriber = (
  event: ShiftCloseIntentObservabilityEvent,
) => void;

type ShiftCloseIntentNotifierRegistry = {
  subscribers: Set<ShiftCloseIntentNotifierSubscriber>;
  channel: BroadcastChannel | null;
  channelStatus: 'unset' | 'ready' | 'unsupported' | 'failed';
};

function getNotifierRegistry(): ShiftCloseIntentNotifierRegistry {
  const g = globalThis as typeof globalThis & {
    [SHIFT_CLOSE_INTENT_NOTIFIER_SYMBOL]?: ShiftCloseIntentNotifierRegistry;
  };
  let registry = g[SHIFT_CLOSE_INTENT_NOTIFIER_SYMBOL];
  if (!registry) {
    registry = {
      subscribers: new Set(),
      channel: null,
      channelStatus: 'unset',
    };
    g[SHIFT_CLOSE_INTENT_NOTIFIER_SYMBOL] = registry;
  }
  return registry;
}

function ensureBroadcastChannel(
  registry: ShiftCloseIntentNotifierRegistry,
): BroadcastChannel | null {
  if (registry.channelStatus === 'ready') return registry.channel;
  if (registry.channelStatus === 'unsupported' || registry.channelStatus === 'failed') {
    return null;
  }
  if (typeof BroadcastChannel !== 'function') {
    registry.channelStatus = 'unsupported';
    registry.channel = null;
    return null;
  }
  try {
    const channel = new BroadcastChannel(SHIFT_CLOSE_INTENT_BROADCAST_CHANNEL_NAME);
    channel.onmessage = (ev: MessageEvent) => {
      try {
        const data = ev.data;
        if (!isPlainRecord(data)) return;
        if (data.version !== 1) return;
        if (data.type !== 'shiftCloseIntentPointerChanged') return;
        if (typeof data.shiftId !== 'string' || data.shiftId.length === 0) return;
        if (!(typeof data.deviceId === 'string' || data.deviceId === null)) return;
        // Receive path: never repost, never mutate storage. Cross-context receive
        // is for other documents; same-document delivery is local-dispatch only.
      } catch {
        /* contained */
      }
    };
    channel.onmessageerror = () => {
      try {
        channel.close();
      } catch {
        /* contained */
      }
      registry.channel = null;
      registry.channelStatus = 'failed';
    };
    registry.channel = channel;
    registry.channelStatus = 'ready';
    return channel;
  } catch {
    registry.channel = null;
    registry.channelStatus = 'failed';
    return null;
  }
}

function dispatchLocalNotifier(event: ShiftCloseIntentObservabilityEvent): void {
  const registry = getNotifierRegistry();
  const ordered = [...registry.subscribers];
  for (const subscriber of ordered) {
    if (!registry.subscribers.has(subscriber)) continue;
    try {
      subscriber(event);
    } catch {
      /* per-subscriber isolation — never alters business result */
    }
  }
}

function postPointerBroadcast(entry: ShiftCloseIntentEntry): void {
  const registry = getNotifierRegistry();
  const channel = ensureBroadcastChannel(registry);
  if (!channel) return;
  try {
    channel.postMessage({
      version: 1,
      type: 'shiftCloseIntentPointerChanged',
      deviceId: entry.deviceId,
      shiftId: entry.shiftId,
      closedAtLocal: entry.closedAtLocal,
    });
  } catch {
    try {
      channel.close();
    } catch {
      /* contained */
    }
    registry.channel = null;
    registry.channelStatus = 'failed';
  }
}

/**
 * Subscribe to local OBS-B2 observability events.
 * Returns an unsubscribe function (suppresses not-yet-invoked callbacks).
 */
export function subscribeShiftCloseIntentNotifier(
  subscriber: ShiftCloseIntentNotifierSubscriber,
): () => void {
  const registry = getNotifierRegistry();
  registry.subscribers.add(subscriber);
  ensureBroadcastChannel(registry);
  return () => {
    registry.subscribers.delete(subscriber);
  };
}

/** Test-only reset — never called from production. */
export function resetShiftCloseIntentNotifierForTests(): void {
  const g = globalThis as typeof globalThis & {
    [SHIFT_CLOSE_INTENT_NOTIFIER_SYMBOL]?: ShiftCloseIntentNotifierRegistry;
  };
  const registry = g[SHIFT_CLOSE_INTENT_NOTIFIER_SYMBOL];
  if (!registry) return;
  if (registry.channel) {
    try {
      registry.channel.close();
    } catch {
      /* contained */
    }
  }
  registry.subscribers.clear();
  registry.channel = null;
  registry.channelStatus = 'unset';
  delete g[SHIFT_CLOSE_INTENT_NOTIFIER_SYMBOL];
}

function invokePointerObserver(
  observe: PointerRepairObserver | undefined,
  outcome: PointerRepairOutcome,
): void {
  if (!observe) return;
  try {
    observe(outcome);
  } catch {
    /* isolated; never rethrown */
  }
}

function emitObservabilityAfterPointerRepair(
  entry: ShiftCloseIntentEntry,
  outcome: PointerRepairOutcome,
  observe: PointerRepairObserver | undefined,
): void {
  invokePointerObserver(observe, outcome);
  dispatchLocalNotifier({ entry, pointerRepair: outcome });
  if (outcome.status === 'ok' && outcome.changed === true) {
    postPointerBroadcast(entry);
  }
}

// ── OBS-B2 pointer write / repair (post-commit, contained) ───────────────

function buildPointerForEntry(entry: ShiftCloseIntentEntry): LatestCloseIntentPointer {
  return {
    kind: 'latestCloseIntentByDevice',
    version: 1,
    deviceId: entry.deviceId as string,
    shiftId: entry.shiftId,
    closedAtLocal: entry.closedAtLocal,
  };
}

/** Comparator: higher closedAtLocal wins; on tie, lexicographically greater shiftId wins. */
function pointerCandidateOutranks(
  candidate: Pick<LatestCloseIntentPointer, 'closedAtLocal' | 'shiftId'>,
  existing: Pick<LatestCloseIntentPointer, 'closedAtLocal' | 'shiftId'>,
): boolean {
  if (candidate.closedAtLocal !== existing.closedAtLocal) {
    return candidate.closedAtLocal > existing.closedAtLocal;
  }
  return candidate.shiftId > existing.shiftId;
}

function pointersEqual(
  a: LatestCloseIntentPointer,
  b: LatestCloseIntentPointer,
): boolean {
  return (
    a.kind === b.kind &&
    a.version === b.version &&
    a.deviceId === b.deviceId &&
    a.shiftId === b.shiftId &&
    a.closedAtLocal === b.closedAtLocal
  );
}

/**
 * Separate contained pointer transaction after mandatory journal commit.
 * Never throws; never mutates the frozen business result.
 */
async function repairLatestCloseIntentPointer(
  store: ShiftCloseIntentKvStore,
  entry: ShiftCloseIntentEntry,
): Promise<PointerRepairOutcome> {
  if (!usableDeviceId(entry.deviceId)) {
    return { status: 'skipped', reason: 'device_id_unusable' };
  }

  const desired = buildPointerForEntry(entry);
  const pointerKey = latestByDevicePointerKey(entry.deviceId);

  try {
    return await store.transact(['shiftCloseIntents'], 'readwrite', async (txn) => {
      let existingRaw: unknown;
      try {
        existingRaw = await txn.get<unknown>('shiftCloseIntents', pointerKey);
      } catch {
        return { status: 'degraded', reason: 'pointer_read_failed' } satisfies PointerRepairOutcome;
      }

      if (existingRaw !== undefined) {
        if (!isPointerShaped(existingRaw) || !isPlainRecord(existingRaw)) {
          // Unusable routing metadata — overwrite with the committed entry's pointer.
        } else {
          const version = existingRaw.version;
          if (typeof version !== 'number' || !Number.isSafeInteger(version) || version !== 1) {
            // Unsupported/invalid — repair by overwrite.
          } else if (!isValidV1Pointer(existingRaw)) {
            // Malformed v1 — repair by overwrite.
          } else if (existingRaw.deviceId !== entry.deviceId) {
            // Device-scoped key with mismatched payload — fail closed, do not write.
            return { status: 'degraded', reason: 'pointer_invalid' } satisfies PointerRepairOutcome;
          } else if (pointersEqual(existingRaw, desired)) {
            return { status: 'ok', changed: false } satisfies PointerRepairOutcome;
          } else if (!pointerCandidateOutranks(desired, existingRaw)) {
            // An older close must never outrank a newer pointer target.
            return { status: 'ok', changed: false } satisfies PointerRepairOutcome;
          }
        }
      }

      try {
        await txn.put('shiftCloseIntents', pointerKey, desired);
      } catch {
        return { status: 'degraded', reason: 'pointer_write_failed' } satisfies PointerRepairOutcome;
      }
      return { status: 'ok', changed: true } satisfies PointerRepairOutcome;
    });
  } catch {
    return { status: 'degraded', reason: 'pointer_write_failed' };
  }
}

async function afterSuccessfulJournalCommit(
  store: ShiftCloseIntentKvStore,
  entry: ShiftCloseIntentEntry,
  observePointerRepair: PointerRepairObserver | undefined,
): Promise<void> {
  let outcome: PointerRepairOutcome;
  try {
    outcome = await repairLatestCloseIntentPointer(store, entry);
  } catch {
    outcome = { status: 'degraded', reason: 'pointer_write_failed' };
  }
  try {
    emitObservabilityAfterPointerRepair(entry, outcome, observePointerRepair);
  } catch {
    /* observability side-effect failure must not alter business result */
  }
}

// ── Public journal API ──────────────────────────────────────────────────

export type ShiftCloseIntentJournal = {
  upsertCloseIntent: (
    snapshot: ShiftCloseIntentBusinessSnapshot,
    observePointerRepair?: PointerRepairObserver,
  ) => Promise<CloseIntentResult<ShiftCloseIntentEntry>>;
  getCloseIntent: (shiftId: string) => Promise<CloseIntentResult<ShiftCloseIntentEntry | undefined>>;
  listCloseIntents: () => Promise<ListCloseIntentsResult>;
  markSynced: (
    shiftId: string,
    observePointerRepair?: PointerRepairObserver,
  ) => Promise<CloseIntentResult<ShiftCloseIntentEntry>>;
  markRejectedManualAttention: (
    shiftId: string,
    reason: string,
    observePointerRepair?: PointerRepairObserver,
  ) => Promise<CloseIntentResult<ShiftCloseIntentEntry>>;
};

export type ShiftCloseIntentJournalDeps = {
  store?: ShiftCloseIntentKvStore;
  now?: () => number;
  /** Injectable for deterministic tests; production uses {@link generateShiftCloseCorrelationId}. */
  generateCloseCorrelationId?: () => string | null;
};

function defaultNow(): number {
  return Date.now();
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError';
}

function unavailable<T>(): CloseIntentResult<T> {
  return { ok: false, code: 'unavailable', message: 'IndexedDB unavailable' };
}
function quota<T>(): CloseIntentResult<T> {
  return { ok: false, code: 'quota', message: 'QuotaExceededError' };
}
function txFailed<T>(message: string): CloseIntentResult<T> {
  return { ok: false, code: 'tx_failed', message };
}
function conflict<T>(message: string): CloseIntentResult<T> {
  return { ok: false, code: 'conflict', message };
}
function notFound<T>(): CloseIntentResult<T> {
  return { ok: false, code: 'not_found' };
}

async function runStore<T>(
  store: ShiftCloseIntentKvStore | undefined,
  fn: (store: ShiftCloseIntentKvStore) => Promise<CloseIntentResult<T>>,
): Promise<CloseIntentResult<T>> {
  if (!store) return unavailable<T>();
  try {
    return await fn(store);
  } catch (err) {
    if (isQuotaError(err)) return quota<T>();
    if (err instanceof Error && err.message === 'IndexedDB unavailable') return unavailable<T>();
    return txFailed<T>(err instanceof Error ? err.message : String(err));
  }
}

async function runListStore(
  store: ShiftCloseIntentKvStore | undefined,
  fn: (store: ShiftCloseIntentKvStore) => Promise<ListCloseIntentsResult>,
): Promise<ListCloseIntentsResult> {
  if (!store) return unavailable<ShiftCloseIntentEntry[]>();
  try {
    return await fn(store);
  } catch (err) {
    if (isQuotaError(err)) return quota<ShiftCloseIntentEntry[]>();
    if (err instanceof Error && err.message === 'IndexedDB unavailable') {
      return unavailable<ShiftCloseIntentEntry[]>();
    }
    return txFailed<ShiftCloseIntentEntry[]>(err instanceof Error ? err.message : String(err));
  }
}

function buildJournalApi(
  store: ShiftCloseIntentKvStore,
  now: () => number,
  generateCloseCorrelationId: () => string | null,
): ShiftCloseIntentJournal {
  const markStatus = (
    shiftId: string,
    status: ShiftCloseIntentStatus,
    lastErrorMessage: string | null,
    observePointerRepair?: PointerRepairObserver,
  ): Promise<CloseIntentResult<ShiftCloseIntentEntry>> =>
    runStore(store, async (s) => {
      const businessResult = await s.transact(['shiftCloseIntents'], 'readwrite', async (txn) => {
        const existingRaw = await txn.get<Record<string, unknown>>('shiftCloseIntents', shiftId);
        if (!existingRaw) return notFound<ShiftCloseIntentEntry>();
        // Fail closed on malformed-present correlation (and any other invalid entry).
        // Historical physical absence of closeCorrelationId remains valid and is not backfilled.
        if (!isCloseIntentEntry(existingRaw)) {
          return conflict<ShiftCloseIntentEntry>(
            `Stored close-intent for shift "${shiftId}" is unreadable — status not updated.`,
          );
        }
        const nowMs = now();
        // Preserve physical generated metadata as stored — do not mint, backfill,
        // clear, or write a read-normalized null solely because the key was absent.
        const next = {
          ...existingRaw,
          status,
          lastErrorMessage,
          updatedAtLocal: nowMs,
        };
        await txn.put('shiftCloseIntents', shiftId, next);
        return {
          ok: true as const,
          value: normalizeCloseIntentEntry(next),
        };
      });
      // Pointer repair / notifier only AFTER mandatory journal commit.
      if (businessResult.ok) {
        await afterSuccessfulJournalCommit(s, businessResult.value, observePointerRepair);
      }
      return businessResult;
    });

  return {
    upsertCloseIntent: (snapshot, observePointerRepair) =>
      runStore(store, async (s) => {
        const businessResult = await s.transact(['shiftCloseIntents'], 'readwrite', async (txn) => {
          const existingRaw = await txn.get<Record<string, unknown>>(
            'shiftCloseIntents',
            snapshot.shiftId,
          );
          if (existingRaw && isCloseIntentEntry(existingRaw)) {
            const existing = normalizeCloseIntentEntry(existingRaw);
            if (snapshotsEqual(existing, snapshot)) {
              // Idempotent equal-retry: reuse persisted generated metadata; no put.
              return { ok: true as const, value: existing };
            }
            return conflict<ShiftCloseIntentEntry>(
              `A different close-intent already exists locally for shift "${snapshot.shiftId}" — not overwritten.`,
            );
          }
          if (existingRaw) {
            // Unreadable/malformed existing record — do not overwrite.
            return conflict<ShiftCloseIntentEntry>(
              `A different close-intent already exists locally for shift "${snapshot.shiftId}" — not overwritten.`,
            );
          }
          // Generate metadata only on the successful initial-create branch,
          // inside this existing IndexedDB readwrite transaction.
          const nowMs = now();
          const closedAtLocal = nowMs;
          const closeCorrelationId = generateCloseCorrelationId();
          const entry: ShiftCloseIntentEntry = {
            ...snapshot,
            closedAtLocal,
            closeCorrelationId,
            status: 'local_closed_pending',
            createdAtLocal: nowMs,
            updatedAtLocal: nowMs,
            lastErrorMessage: null,
          };
          await txn.put('shiftCloseIntents', snapshot.shiftId, entry);
          return { ok: true as const, value: entry };
        });
        // Pointer repair / notifier only AFTER mandatory journal commit.
        // Conflict / failure paths never repair or notify.
        if (businessResult.ok) {
          await afterSuccessfulJournalCommit(s, businessResult.value, observePointerRepair);
        }
        return businessResult;
      }),

    getCloseIntent: (shiftId) =>
      runStore(store, async (s) => {
        const value = await s.transact(['shiftCloseIntents'], 'readonly', async (txn) =>
          txn.get<unknown>('shiftCloseIntents', shiftId),
        );
        if (value === undefined) return { ok: true, value: undefined };
        if (isCloseIntentEntry(value)) {
          return {
            ok: true,
            value: normalizeCloseIntentEntry(value as unknown as Record<string, unknown>),
          };
        }
        // Malformed-present correlation (and other invalid shapes) fail closed —
        // never unsafe-cast raw storage into a successful runtime entry.
        return conflict<ShiftCloseIntentEntry | undefined>(
          `Stored close-intent for shift "${shiftId}" is unreadable.`,
        );
      }),

    listCloseIntents: () =>
      runListStore(store, async (s) => {
        const raw = await s.transact(['shiftCloseIntents'], 'readonly', async (txn) =>
          txn.getAll<unknown>('shiftCloseIntents'),
        );
        return classifyListRecords(raw);
      }),

    markSynced: (shiftId, observePointerRepair) =>
      markStatus(shiftId, 'synced', null, observePointerRepair),

    markRejectedManualAttention: (shiftId, reason, observePointerRepair) =>
      markStatus(shiftId, 'rejected_manual_attention', reason, observePointerRepair),
  };
}

export function createShiftCloseIntentJournal(
  deps?: ShiftCloseIntentJournalDeps,
): ShiftCloseIntentJournal {
  const store = deps?.store ?? createIndexedDbShiftCloseIntentStore();
  const now = deps?.now ?? defaultNow;
  const generateCloseCorrelationId =
    deps?.generateCloseCorrelationId ?? generateShiftCloseCorrelationId;
  return buildJournalApi(store, now, generateCloseCorrelationId);
}

export function createInMemoryShiftCloseIntentJournal(
  deps?: ShiftCloseIntentJournalDeps,
): ShiftCloseIntentJournal & { dump: () => Record<string, Record<string, unknown>> } {
  const memory =
    (deps?.store as ReturnType<typeof createInMemoryShiftCloseIntentStore> | undefined) ??
    createInMemoryShiftCloseIntentStore();
  const now = deps?.now ?? defaultNow;
  const generateCloseCorrelationId =
    deps?.generateCloseCorrelationId ?? generateShiftCloseCorrelationId;
  const api = buildJournalApi(memory, now, generateCloseCorrelationId);
  return {
    ...api,
    dump: () => memory.dump(),
  };
}
