import { afterEach, describe, expect, it } from 'vitest';
import { createIndexedDbReversalStore, REVERSAL_STORES } from './reversalLocalStore';
import { DURABLE_DOMAINS } from '../../platform/durableStore/migrationManifest';
import type { OfflineAttestationEnvelope } from '../../auth/privilegedAction/offlineAttestation';
import { ingestAttestedPrivilegedAction, listPrivilegedEvidence } from './privilegedEvidenceStore';

/**
 * D-2 migration coverage focused on the privileged-evidence store's own
 * behaviour once a v3 -> v4 upgrade has landed. The upgrade mechanics
 * themselves (additive `onupgradeneeded`, blocked/hung-open containment) are
 * covered exhaustively in `reversalLocalStore.migration.test.ts`; this file
 * proves the D-2 store functions operate correctly against a freshly
 * migrated database and that PK-3's pre-existing rows are untouched.
 */

interface FakeDbState {
  version: number;
  stores: Map<string, Map<string, unknown>>;
}

function installFakeIndexedDb(state: FakeDbState): void {
  const makeRequest = <T>(run: (req: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null }) => void) => {
    const req: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      result: undefined,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => run(req));
    return req;
  };
  const makeStore = (name: string) => {
    const map = state.stores.get(name)!;
    return {
      get: (key: string) => makeRequest<unknown>((req) => {
        req.result = map.get(key);
        req.onsuccess?.();
      }),
      getAll: () => makeRequest<unknown[]>((req) => {
        req.result = [...map.values()];
        req.onsuccess?.();
      }),
      getAllKeys: () => makeRequest<string[]>((req) => {
        req.result = [...map.keys()];
        req.onsuccess?.();
      }),
      put: (value: unknown, key: string) => makeRequest<string>((req) => {
        map.set(key, value);
        req.result = key;
        req.onsuccess?.();
      }),
      delete: (key: string) => makeRequest<undefined>((req) => {
        map.delete(key);
        req.onsuccess?.();
      }),
    };
  };
  const makeTransaction = (_stores: string[], _mode: string) => {
    const tx: { oncomplete: (() => void) | null; onabort: (() => void) | null; error: unknown; objectStore: (n: string) => unknown; abort: () => void } = {
      oncomplete: null,
      onabort: null,
      error: null,
      objectStore: (n: string) => makeStore(n),
      abort: () => {
        aborted = true;
        tx.onabort?.();
      },
    };
    let aborted = false;
    setTimeout(() => {
      if (!aborted) tx.oncomplete?.();
    }, 0);
    return tx;
  };
  const makeDb = () => ({
    objectStoreNames: { contains: (n: string) => state.stores.has(n) },
    createObjectStore: (n: string) => {
      state.stores.set(n, new Map());
    },
    transaction: (stores: string[], mode: string) => makeTransaction(stores, mode),
    close: () => {},
  });
  const fakeIndexedDb = {
    open: (_name: string, version: number) => {
      const req: {
        result?: ReturnType<typeof makeDb>;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.result = makeDb();
        if (version > state.version) {
          req.onupgradeneeded?.();
          state.version = version;
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDb;
}

function seedV3(): FakeDbState {
  return {
    version: 3,
    stores: new Map<string, Map<string, unknown>>([
      ['intents', new Map([['i1', { id: 'i1', status: 'queued' }]])],
      ['stock', new Map()],
      ['ledger', new Map()],
      ['markers', new Map()],
      ['rejections', new Map()],
      ['voidIntents', new Map([['ord-1', { orderId: 'ord-1' }]])],
    ]),
  };
}

afterEach(() => {
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

function envelope(): OfflineAttestationEnvelope {
  return {
    attestationIdHex: 'a'.repeat(32),
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    verifiedBranchId: 'LDP-001',
    evidenceSeed: {
      oacId: 'oac-1',
      oacSchemaVersion: 1,
      revocationEpochAtIssue: 0,
      managerAuthVersionAtIssue: 0,
      managerCredentialVersionAtIssue: 0,
      nonce: 'nonce-1',
      attemptCount: 1,
      approvalResult: 'APPROVED_LOCAL',
      approvalProofDigest: 'proof-1',
    },
    trustedApprovalLowerMs: 1_000,
    trustedApprovalUpperMs: 2_000,
    pendingExecutionExpiresAtMs: 100_000,
    localIntentId: 'intent-1',
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    approvingManagerStaffId: 'mgr-1',
  };
}

describe('privilegedEvidenceStore against a freshly v3 -> v4 migrated database', () => {
  it('ingest creates the privilegedEvidence store on demand and never touches PK-3 rows', async () => {
    const state = seedV3();
    installFakeIndexedDb(state);
    const store = createIndexedDbReversalStore();

    const outcome = await ingestAttestedPrivilegedAction(
      store,
      envelope(),
      { ingestStaffId: 'staff-1', ingestDeviceId: 'device-1' },
      1_000,
    );
    expect(outcome.kind).toBe('created');
    expect(state.version).toBe(4);
    expect(state.stores.has('privilegedEvidence')).toBe(true);
    // PK-3 rows are untouched.
    expect(state.stores.get('intents')!.get('i1')).toEqual({ id: 'i1', status: 'queued' });
    expect(state.stores.get('voidIntents')!.get('ord-1')).toEqual({ orderId: 'ord-1' });

    const rows = await listPrivilegedEvidence(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adjudicationId).toBe(envelope().attestationIdHex);
  });

  it('no destructive reset: every REVERSAL_STORES name is present after migration, none dropped', async () => {
    const state = seedV3();
    installFakeIndexedDb(state);
    const store = createIndexedDbReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), { ingestStaffId: 's1', ingestDeviceId: 'd1' }, 1_000);
    for (const name of REVERSAL_STORES) {
      expect(state.stores.has(name)).toBe(true);
    }
  });
});

describe('migrationManifest — reversal domain reflects the v4 / 7-store shape', () => {
  it('lists privilegedEvidence as the 7th store at sourceIdbVersion 4', () => {
    const reversal = DURABLE_DOMAINS.find((d) => d.id === 'reversal')!;
    expect(reversal.stores).toEqual([...REVERSAL_STORES]);
    expect(reversal.sourceIdbVersion).toBe(4);
  });
});
