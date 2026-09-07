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
 * P01 (SEC-001 Packet D / D-2, GD-D2-002 Option A): the JS-side timeout/
 * fencing bound applied to every native invoke inside one top-level
 * `transact`. Mirrors the value of `PRIVILEGED_EVIDENCE_DURABLE_OP_TIMEOUT_MS`
 * by design (not imported — this platform adapter is shared by every durable
 * domain and must not depend on a POS-feature constant module).
 */
export const NATIVE_INVOKE_TIMEOUT_MS = 2_000;

type InvokeRace = { kind: 'value'; value: unknown } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/**
 * Races one native invoke against a 2s timer. On timeout the underlying
 * invoke promise is DETACHED — never awaited again, its eventual settlement
 * or rejection absorbed via a no-op `.then` — so a late-completing invoke can
 * never mutate JS state or resolve into a caller that has already moved on.
 * This bounds the invoke; it does not claim to cancel it (D2).
 */
async function boundedRawInvoke(invoke: TauriCore['invoke'], cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const invokePromise = invoke(cmd, args);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const settleP: Promise<InvokeRace> = invokePromise.then(
    (value): InvokeRace => ({ kind: 'value', value }),
    (error): InvokeRace => ({ kind: 'error', error }),
  );
  const timeoutP = new Promise<InvokeRace>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), NATIVE_INVOKE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([settleP, timeoutP]);
    if (outcome.kind === 'timeout') {
      void invokePromise.then(
        () => undefined,
        () => undefined,
      );
      throw new Error(`durable native invoke "${cmd}" timed out`);
    }
    if (outcome.kind === 'error') throw outcome.error;
    return outcome.value;
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

/**
 * JS adapter for the opaque native transaction session. Production `window.__TAURI__`
 * use is confined to this adapter path.
 *
 * P01 recovery contract (exact, per Tech Lead authority): a JS-side
 * monotonically increasing `currentSessionId` is incremented once per
 * top-level `transact` call. Every native invoke inside that call is raced
 * against the 2s bound above. On timeout OR error the session is invalidated
 * (no later invoke belonging to it — including one still racing when the
 * invalidation happens — is ever trusted again), and the process-local
 * `nested` latch is unconditionally cleared in `finally`, so a hung/failed
 * invoke can poison at most the ONE transaction it occurred in, never the
 * adapter for the process lifetime. The native 5s idle watchdog and
 * `durable_kv` itself are unchanged — no Rust edit, no new native command, no
 * new capability.
 */
export function createTauriDurableStorePort(options: TauriDurableStoreOptions): DurableStorePort {
  let nested = false;
  let currentSessionId = 0;

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
      const mySessionId = ++currentSessionId;
      const invoke = getInvoke();

      // Session-fenced: fails closed the instant this transact's session has
      // been invalidated by an earlier timeout/error within the SAME
      // transact call, or superseded by a later top-level transact.
      const boundedInvoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (mySessionId !== currentSessionId) {
          throw new Error('durable transaction session is stale');
        }
        try {
          const value = await boundedRawInvoke(invoke, cmd, args);
          if (mySessionId !== currentSessionId) {
            throw new Error('durable transaction session is stale');
          }
          return value;
        } catch (err) {
          if (mySessionId === currentSessionId) currentSessionId += 1;
          throw err instanceof Error ? err : new Error(String(err));
        }
      };

      let sessionId: string | undefined;
      try {
        const began = (await boundedInvoke('durable_kv_txn_begin', {
          database: options.database,
          stores,
          mode,
          epochId: options.epochId,
        })) as { sessionId: string };
        sessionId = began.sessionId;
        const txn: DurableStoreTxn = {
          get: async <R>(store: string, key: DurableStoreKey): Promise<R | undefined> => {
            const value = await boundedInvoke('durable_kv_txn_get', {
              sessionId,
              store,
              encodedKey: encodeDurableKey(key),
            });
            return (value === null || value === undefined ? undefined : value) as R | undefined;
          },
          getAll: async <R>(store: string): Promise<R[]> => {
            return (await boundedInvoke('durable_kv_txn_get_all', { sessionId, store })) as R[];
          },
          getAllKeys: async (store: string): Promise<DurableStoreKey[]> => {
            const encoded = (await boundedInvoke('durable_kv_txn_get_all_keys', { sessionId, store })) as string[];
            return encoded.map(decodeDurableKey);
          },
          put: async (store, key, value) => {
            await boundedInvoke('durable_kv_txn_put', {
              sessionId,
              store,
              encodedKey: encodeDurableKey(key),
              value,
            });
          },
          delete: async (store, key) => {
            await boundedInvoke('durable_kv_txn_delete', {
              sessionId,
              store,
              encodedKey: encodeDurableKey(key),
            });
          },
        };
        const result = await fn(txn);
        await boundedInvoke('durable_kv_txn_commit', { sessionId });
        sessionId = undefined;
        return result;
      } catch (err) {
        if (sessionId) {
          try {
            // Best-effort native abort. Uses the RAW bounded invoke (not
            // `boundedInvoke`) deliberately: this session may already be
            // stale, but the abort must still be attempted so the native
            // side can release it promptly rather than waiting out the 5s
            // idle watchdog.
            await boundedRawInvoke(invoke, 'durable_kv_txn_abort', { sessionId });
          } catch {
            /* native abort is best-effort after a command failure */
          }
        }
        throw err;
      } finally {
        // Unconditional: a timeout, a thrown error, or a clean commit all
        // clear the latch. This is the P01 fix — the landed code only
        // cleared it inside `finally` too, but every native invoke was an
        // unbounded bare `await`, so a non-settling invoke meant `finally`
        // itself never ran. Every invoke is now bounded above, so `finally`
        // always runs within NATIVE_INVOKE_TIMEOUT_MS of the last invoke.
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
