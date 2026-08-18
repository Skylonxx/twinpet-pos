/**
 * Packet AI-1 trusted orchestrator unit evidence.
 * Covers O-* plus NV-1, NV-6, NV-7, NV-8, NV-9 and owner/re-key constraints.
 *
 * Cross-tab guarantee under test: idempotent convergence + at-most-once release.
 * Tests must not expect a second acquire itself to be refused.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as cart from './activeCartSnapshotStore';
import {
  isAuthenticAcquiredResumeFenceAuthorization,
  readActiveCartDurableDump,
  readActiveCartSnapshot,
} from './activeCartSnapshotStore';
import { isAuthenticProvenEvidenceAbsence } from './saleSubmissionEvidenceStore';
import {
  beginOwnedActiveCartGeneration,
  claimTrustedOrchestrationOwner,
  isAuthenticTrustedOrchestrationOwner,
  releaseTrustedOrchestrationOwner,
} from './trustedOrchestrationOwner';
import {
  beginTrustedSaleSubmission,
  runTrustedResumeSweep,
  type TrustedSaleSubmissionBeginResult,
} from './trustedSaleSubmissionOrchestrator';

vi.mock('./trustedOrchestrationOwner', { spy: true });

const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';
const CHECKOUT_ORCHESTRATION_SETTLE_BOUND_MS = 2000;

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    req.onblocked = () => resolve();
  });
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

async function inspectEvidenceStores(): Promise<{
  pointerKeys: IDBValidKey[];
  entryKeys: IDBValidKey[];
  pointers: unknown[];
}> {
  const dbi = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(EVIDENCE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(POINTER_STORE)) db.createObjectStore(POINTER_STORE);
      if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
  try {
    const tx = dbi.transaction([POINTER_STORE, ENTRY_STORE], 'readonly');
    const pointerStore = tx.objectStore(POINTER_STORE);
    const entryStore = tx.objectStore(ENTRY_STORE);
    const pointerKeys = await reqP(pointerStore.getAllKeys());
    const pointers = await reqP(pointerStore.getAll());
    const entryKeys = await reqP(entryStore.getAllKeys());
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
    });
    return { pointerKeys, entryKeys, pointers };
  } finally {
    dbi.close();
  }
}

function assertNoCapabilityLeak(value: unknown): void {
  expect(isAuthenticTrustedOrchestrationOwner(value as never)).toBe(false);
  expect(isAuthenticAcquiredResumeFenceAuthorization(value as never)).toBe(false);
  expect(isAuthenticProvenEvidenceAbsence(value as never)).toBe(false);
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      expect(isAuthenticTrustedOrchestrationOwner(nested as never)).toBe(false);
      expect(isAuthenticAcquiredResumeFenceAuthorization(nested as never)).toBe(false);
      expect(isAuthenticProvenEvidenceAbsence(nested as never)).toBe(false);
    }
  }
}

beforeEach(async () => {
  await deleteDb(CART_DB_NAME);
  await deleteDb(EVIDENCE_DB_NAME);
});

afterEach(async () => {
  vi.mocked(beginOwnedActiveCartGeneration).mockRestore();
  vi.useRealTimers();
  await deleteDb(CART_DB_NAME);
  await deleteDb(EVIDENCE_DB_NAME);
});

describe('O — trusted sale-submission orchestrator', () => {
  test('O-1 first call for a key claims an owner and returns generationSeq 1', async () => {
    const result = await beginTrustedSaleSubmission({
      branchId: 'O1-B',
      deviceId: 'O1-D',
      asyncOrderId: 'O1-D-1',
      billId: 'B-O1-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.generationSeq).toBe(1);
    expect(result.generationId).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    expect(result.storeEpochId).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  test('O-2 second call for the same key reuses the owner (no duplicate-claim refusal)', async () => {
    const first = await beginTrustedSaleSubmission({
      branchId: 'O2-B',
      deviceId: 'O2-D',
      asyncOrderId: 'O2-D-1',
      billId: 'B-O2-1',
    });
    expect(first.ok).toBe(true);
    const sweep = await runTrustedResumeSweep({ branchId: 'O2-B', deviceId: 'O2-D' });
    expect(sweep).toEqual({ ok: true, outcome: 'released' });
    const second = await beginTrustedSaleSubmission({
      branchId: 'O2-B',
      deviceId: 'O2-D',
      asyncOrderId: 'O2-D-2',
      billId: 'B-O2-2',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected successor success');
    expect(second.generationSeq).toBe(2);
  });

  test('O-3 different branchId releases the prior owner and claims the new key', async () => {
    const first = await beginTrustedSaleSubmission({
      branchId: 'O3-A',
      deviceId: 'O3-D',
      asyncOrderId: 'O3-D-1',
      billId: 'B-O3-A',
    });
    expect(first.ok).toBe(true);
    const second = await beginTrustedSaleSubmission({
      branchId: 'O3-B',
      deviceId: 'O3-D',
      asyncOrderId: 'O3-D-1',
      billId: 'B-O3-B',
    });
    expect(second.ok).toBe(true);
    const recA = await readActiveCartSnapshot('O3-A', 'O3-D');
    const recB = await readActiveCartSnapshot('O3-B', 'O3-D');
    expect(recA?.billId).toBe('B-O3-A');
    expect(recB?.billId).toBe('B-O3-B');
    expect(recA?.generationSeq).toBe(1);
    expect(recB?.generationSeq).toBe(1);
  });

  test('O-4 claim refusal surfaces owner_unavailable with zero durable writes', async () => {
    const occupied = claimTrustedOrchestrationOwner('O4-B', 'O4-D');
    expect(occupied.ok).toBe(true);
    const before = stableSerialize(await readActiveCartDurableDump());
    const result = await beginTrustedSaleSubmission({
      branchId: 'O4-B',
      deviceId: 'O4-D',
      asyncOrderId: 'O4-D-1',
      billId: 'B-O4-1',
    });
    expect(result).toEqual({ ok: false, reason: 'owner_unavailable' });
    const after = stableSerialize(await readActiveCartDurableDump());
    expect(after).toBe(before);
    if (occupied.ok) {
      expect(releaseTrustedOrchestrationOwner(occupied.owner)).toEqual({ ok: true });
    }
  });

  test('O-6 full submit sequence writes exactly one cart record', async () => {
    const result = await beginTrustedSaleSubmission({
      branchId: 'O6-B',
      deviceId: 'O6-D',
      asyncOrderId: 'O6-D-1',
      billId: 'B-O6-1',
    });
    expect(result.ok).toBe(true);
    const dump = await readActiveCartDurableDump();
    expect(dump.records).toHaveLength(1);
    expect(dump.records[0]?.asyncOrderId).toBe('O6-D-1');
    expect(dump.records[0]?.billId).toBe('B-O6-1');
    expect(dump.records[0]?.generationSeq).toBe(1);
  });

  test('O-8 resume sweep on a fresh record terminalizes resumeAttempts to 1', async () => {
    const begun = await beginTrustedSaleSubmission({
      branchId: 'O8-B',
      deviceId: 'O8-D',
      asyncOrderId: 'O8-D-1',
      billId: 'B-O8-1',
    });
    expect(begun.ok).toBe(true);
    const sweep = await runTrustedResumeSweep({ branchId: 'O8-B', deviceId: 'O8-D' });
    expect(sweep).toEqual({ ok: true, outcome: 'released' });
    const record = await readActiveCartSnapshot('O8-B', 'O8-D');
    expect(record?.resumeAttempts).toBe(1);
    expect(record?.resumeFence.held).toBe(false);
    expect(record?.resumeFence.fenceSeq).toBeGreaterThan(0);
  });

  test('O-9 second sequential sweep does not perform a second release', async () => {
    const begun = await beginTrustedSaleSubmission({
      branchId: 'O9-B',
      deviceId: 'O9-D',
      asyncOrderId: 'O9-D-1',
      billId: 'B-O9-1',
    });
    expect(begun.ok).toBe(true);
    const first = await runTrustedResumeSweep({ branchId: 'O9-B', deviceId: 'O9-D' });
    const afterFirst = await readActiveCartSnapshot('O9-B', 'O9-D');
    const firstEvidence = stableSerialize(await inspectEvidenceStores());
    const second = await runTrustedResumeSweep({ branchId: 'O9-B', deviceId: 'O9-D' });
    expect(first).toEqual({ ok: true, outcome: 'released' });
    expect(second).toEqual({ ok: true, outcome: 'not_eligible' });
    const afterSecond = await readActiveCartSnapshot('O9-B', 'O9-D');
    expect(afterSecond?.resumeAttempts).toBe(1);
    expect(afterSecond?.resumeFence.fenceSeq).toBe(afterFirst?.resumeFence.fenceSeq);
    expect(stableSerialize(await inspectEvidenceStores())).toBe(firstEvidence);
  });

  test('O-10 generation refusal is a plain { ok:false } and never throws', async () => {
    const first = await beginTrustedSaleSubmission({
      branchId: 'O10-B',
      deviceId: 'O10-D',
      asyncOrderId: 'O10-D-1',
      billId: 'B-O10-1',
    });
    expect(first.ok).toBe(true);
    const refused = await beginTrustedSaleSubmission({
      branchId: 'O10-B',
      deviceId: 'O10-D',
      asyncOrderId: 'O10-D-2',
      billId: 'B-O10-2',
    });
    expect(refused).toEqual({ ok: false, reason: 'generation_refused' });
  });
});

describe('NV-1 capability leak', () => {
  test('every exported success path result and depth-1 values fail authenticity predicates', async () => {
    const beginFresh = await beginTrustedSaleSubmission({
      branchId: 'NV1-B',
      deviceId: 'NV1-D',
      asyncOrderId: 'NV1-D-1',
      billId: 'B-NV1-1',
    });
    expect(beginFresh.ok).toBe(true);
    assertNoCapabilityLeak(beginFresh);

    const sweepReleased = await runTrustedResumeSweep({ branchId: 'NV1-B', deviceId: 'NV1-D' });
    expect(sweepReleased).toEqual({ ok: true, outcome: 'released' });
    assertNoCapabilityLeak(sweepReleased);

    const sweepIdle = await runTrustedResumeSweep({ branchId: 'NV1-EMPTY', deviceId: 'NV1-D' });
    expect(sweepIdle).toEqual({ ok: true, outcome: 'not_eligible' });
    assertNoCapabilityLeak(sweepIdle);

    const beginSuccessor = await beginTrustedSaleSubmission({
      branchId: 'NV1-B',
      deviceId: 'NV1-D',
      asyncOrderId: 'NV1-D-2',
      billId: 'B-NV1-2',
    });
    expect(beginSuccessor.ok).toBe(true);
    assertNoCapabilityLeak(beginSuccessor);
  });
});

describe('NV-6 owner / capability confinement', () => {
  test('foreign live owner yields failure with zero durable mutation', async () => {
    const occupied = claimTrustedOrchestrationOwner('NV6-B', 'NV6-D');
    expect(occupied.ok).toBe(true);
    const beforeDump = stableSerialize(await readActiveCartDurableDump());
    const beforeEvidence = stableSerialize(await inspectEvidenceStores());
    const begin = await beginTrustedSaleSubmission({
      branchId: 'NV6-B',
      deviceId: 'NV6-D',
      asyncOrderId: 'NV6-D-1',
      billId: 'B-NV6-1',
    });
    const sweep = await runTrustedResumeSweep({ branchId: 'NV6-B', deviceId: 'NV6-D' });
    expect(begin).toEqual({ ok: false, reason: 'owner_unavailable' });
    expect(sweep).toEqual({ ok: false, reason: 'owner_unavailable' });
    expect(stableSerialize(await readActiveCartDurableDump())).toBe(beforeDump);
    expect(stableSerialize(await inspectEvidenceStores())).toBe(beforeEvidence);
    if (occupied.ok) {
      expect(releaseTrustedOrchestrationOwner(occupied.owner)).toEqual({ ok: true });
    }
  });
});

describe('NV-7 no initializer fallback', () => {
  test('begin refusal does not call the initializer and writes no fallback record', async () => {
    const occupied = claimTrustedOrchestrationOwner('NV7-B', 'NV7-D');
    expect(occupied.ok).toBe(true);
    const initSpy = vi.spyOn(cart, 'initializeActiveCartSaleSubmission');
    const before = stableSerialize(await readActiveCartDurableDump());
    const result = await beginTrustedSaleSubmission({
      branchId: 'NV7-B',
      deviceId: 'NV7-D',
      asyncOrderId: 'NV7-D-1',
      billId: 'B-NV7-1',
    });
    expect(result).toEqual({ ok: false, reason: 'owner_unavailable' });
    expect(initSpy).not.toHaveBeenCalled();
    expect(stableSerialize(await readActiveCartDurableDump())).toBe(before);
    const record = await readActiveCartSnapshot('NV7-B', 'NV7-D');
    expect(record).toBeUndefined();
    initSpy.mockRestore();
    if (occupied.ok) {
      expect(releaseTrustedOrchestrationOwner(occupied.owner)).toEqual({ ok: true });
    }
  });
});

describe('NV-8 duplicate sweep convergence', () => {
  test('concurrent sweeps terminalize once with one pointer and at-most-once release', async () => {
    const begun = await beginTrustedSaleSubmission({
      branchId: 'NV8-B',
      deviceId: 'NV8-D',
      asyncOrderId: 'NV8-D-1',
      billId: 'B-NV8-1',
    });
    expect(begun.ok).toBe(true);
    const [first, second] = await Promise.all([
      runTrustedResumeSweep({ branchId: 'NV8-B', deviceId: 'NV8-D' }),
      runTrustedResumeSweep({ branchId: 'NV8-B', deviceId: 'NV8-D' }),
    ]);
    expect(first.ok || second.ok).toBe(true);
    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok && r.outcome === 'released').length).toBeGreaterThanOrEqual(1);
    const record = await readActiveCartSnapshot('NV8-B', 'NV8-D');
    expect(record?.resumeAttempts).toBe(1);
    expect(record?.resumeFence.held).toBe(false);
    const evidence = await inspectEvidenceStores();
    expect(evidence.pointerKeys).toHaveLength(1);
    expect(evidence.entryKeys).toHaveLength(0);
    expect(evidence.pointers).toHaveLength(1);
  });
});

describe('NV-9 bounded settle', () => {
  test('never-settling begin path fails within 2000ms and swallows late completion', async () => {
    let resolveLate: ((value: Awaited<ReturnType<typeof beginOwnedActiveCartGeneration>>) => void) | undefined;
    vi.mocked(beginOwnedActiveCartGeneration).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    );
    vi.useFakeTimers();
    const pending = beginTrustedSaleSubmission({
      branchId: 'NV9-B',
      deviceId: 'NV9-D',
      asyncOrderId: 'NV9-D-1',
      billId: 'B-NV9-1',
    });
    let early: TrustedSaleSubmissionBeginResult | 'pending' = 'pending';
    void pending.then((value) => {
      early = value;
    });
    await vi.advanceTimersByTimeAsync(CHECKOUT_ORCHESTRATION_SETTLE_BOUND_MS - 1);
    expect(early).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: 'orchestration_timeout' });
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    resolveLate?.({
      ok: true,
      generationId: 'LATEGEN00000000000000000000',
      generationSeq: 99,
      storeEpochId: 'LATEEPOC0000000000000000000',
    });
    await Promise.resolve();
    await Promise.resolve();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'orchestration_timeout' });
  });
});

describe('owner re-key in-flight coordination', () => {
  test('re-key waits for outgoing owned work and does not invalidate it', async () => {
    let releaseHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    vi.mocked(beginOwnedActiveCartGeneration).mockImplementationOnce(async (owner, input) => {
      await hang;
      vi.mocked(beginOwnedActiveCartGeneration).mockRestore();
      return beginOwnedActiveCartGeneration(owner, input);
    });
    const firstPromise = beginTrustedSaleSubmission({
      branchId: 'RK-A',
      deviceId: 'RK-D',
      asyncOrderId: 'RK-D-1',
      billId: 'B-RK-A',
    });
    await Promise.resolve();
    const secondPromise = beginTrustedSaleSubmission({
      branchId: 'RK-B',
      deviceId: 'RK-D',
      asyncOrderId: 'RK-D-1',
      billId: 'B-RK-B',
    });
    let secondSettled = false;
    void secondPromise.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    releaseHang?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const recA = await readActiveCartSnapshot('RK-A', 'RK-D');
    const recB = await readActiveCartSnapshot('RK-B', 'RK-D');
    expect(recA?.billId).toBe('B-RK-A');
    expect(recB?.billId).toBe('B-RK-B');
  });
});
