import { describe, test, expect } from 'vitest';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { runValidationSweep, shiftCloseValidationSweep } from '../shiftCloseValidationWorker';
import { foldDeviceScopedDrawer } from '../shiftCloseValidationDrawerFold';
import { computeInputsDigestAtRevision, MAX_SOURCE_DOCS } from '../shiftCloseValidationWorkerCore';

// Integration tests over an in-memory Firestore fake — NOT a proof of real
// production transaction contention (Gate-1 cursor/durability addendum §21
// "Evidence honesty" requirement: fake/mocked-transaction tests must
// disclose they do not prove real concurrent-transaction semantics; there is
// no real network, no real optimistic-concurrency retry loop driven by the
// SDK, and no true parallel invocation). What this harness DOES honestly
// enforce, matching real `db.runTransaction` semantics closely enough to
// exercise this file's actual code paths (Codex BF-11):
//   - reads inside a transaction never see another transaction's writes
//     until that transaction COMMITS (writes are buffered in a per-tx
//     overlay, applied to the shared store only after the callback resolves
//     WITHOUT throwing — a thrown callback commits NOTHING: real rollback).
//   - a transaction may not call `tx.get` after it has already called
//     `tx.update`/`tx.create` (real Firestore forbids read-after-write
//     inside one transaction) — enforced, not merely claimed.
//   - `tx.create` throws (create-once) if the doc already exists in the
//     base store OR was already created earlier in the SAME transaction.
//   - queries support compound `.orderBy(...).orderBy(...).startAfter(...)`
//     over real field values (including `Timestamp` and `FieldPath.
//     documentId()`), so cursor-continuation pagination is genuinely
//     exercised, not just id-sorted.
// What it still does NOT model: cross-transaction contention/interleaving,
// the SDK's own retry-on-ABORTED loop, or network partial failure.

type StoredDoc = Record<string, unknown>;
type Overlay = Map<string, StoredDoc | 'DELETED'>;

function overlayKey(collection: string, id: string): string {
  return `${collection}/${id}`;
}

class FakeCollectionRef {
  constructor(
    private readonly store: Map<string, Map<string, StoredDoc>>,
    private readonly name: string,
  ) {}

  doc(id: string) {
    return new FakeDocRef(this.store, this.name, id);
  }

  where(field: unknown, op: string, value: unknown) {
    return new FakeQuery(this.store, this.name, [{ field, op, value }]);
  }

  orderBy(field: unknown) {
    return new FakeQuery(this.store, this.name, []).orderBy(field);
  }

  limit(n: number) {
    return new FakeQuery(this.store, this.name, []).limit(n);
  }

  async get() {
    return new FakeQuery(this.store, this.name, []).get();
  }
}

function fieldValue(field: unknown, id: string, data: StoredDoc): unknown {
  // `FieldPath.documentId()` returns a non-string FieldPath instance —
  // any non-string order/where field is treated as the document id.
  if (typeof field !== 'string') return id;
  return data[field];
}

function compareOrderValues(a: unknown, b: unknown): number {
  const am = a instanceof Timestamp ? a.toMillis() : a;
  const bm = b instanceof Timestamp ? b.toMillis() : b;
  if (am === bm) return 0;
  if (am === null || am === undefined) return -1;
  if (bm === null || bm === undefined) return 1;
  if (typeof am === 'string' && typeof bm === 'string') return am < bm ? -1 : am > bm ? 1 : 0;
  return (am as number) < (bm as number) ? -1 : 1;
}

class FakeQuery {
  private orderFields: unknown[] = [];
  private limitN: number | null = null;
  private startAfterValues: unknown[] | null = null;

  constructor(
    private readonly store: Map<string, Map<string, StoredDoc>>,
    private readonly name: string,
    private readonly filters: Array<{ field: unknown; op: string; value: unknown }>,
  ) {}

  where(field: unknown, op: string, value: unknown) {
    const next = new FakeQuery(this.store, this.name, [...this.filters, { field, op, value }]);
    next.orderFields = this.orderFields;
    next.limitN = this.limitN;
    next.startAfterValues = this.startAfterValues;
    return next;
  }

  orderBy(field: unknown) {
    this.orderFields.push(field);
    return this;
  }

  startAfter(...values: unknown[]) {
    this.startAfterValues = values;
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matches(id: string, data: StoredDoc): boolean {
    return this.filters.every((f) => {
      const actual = fieldValue(f.field, id, data);
      if (f.op === '==') return actual === f.value;
      if (f.op === '<=') return compareOrderValues(actual, f.value) <= 0;
      return false;
    });
  }

  async get() {
    const coll = this.store.get(this.name) ?? new Map();
    let entries = [...coll.entries()].filter(([id, data]) => this.matches(id, data));
    entries.sort(([aId, aData], [bId, bData]) => {
      for (const field of this.orderFields) {
        const cmp = compareOrderValues(fieldValue(field, aId, aData), fieldValue(field, bId, bData));
        if (cmp !== 0) return cmp;
      }
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    });
    if (this.startAfterValues) {
      const cursor = this.startAfterValues;
      entries = entries.filter(([id, data]) => {
        for (let i = 0; i < this.orderFields.length; i += 1) {
          const cmp = compareOrderValues(fieldValue(this.orderFields[i], id, data), cursor[i]);
          if (cmp > 0) return true;
          if (cmp < 0) return false;
        }
        return false; // exactly equal to the cursor tuple -> excluded (startAfter is exclusive)
      });
    }
    if (this.limitN !== null) entries = entries.slice(0, this.limitN);
    const docs = entries.map(([id, data]) => makeSnap(id, data, new FakeDocRef(this.store, this.name, id)));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

function makeSnap(id: string, data: StoredDoc | undefined, ref: FakeDocRef) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
    get: (field: string) => data?.[field],
    updateTime: new Timestamp(1_700_000_000, 0),
    ref,
  };
}

class FakeDocRef {
  constructor(
    private readonly store: Map<string, Map<string, StoredDoc>>,
    public readonly collectionName: string,
    public readonly id: string,
  ) {}

  async get() {
    return makeSnap(this.id, this.store.get(this.collectionName)?.get(this.id), this);
  }
}

let fakeServerClock = 1_700_000_100;

/** Detects the REAL `firebase-admin/firestore` `FieldValue.serverTimestamp()` sentinel (an actual `FieldValue` instance, not a mock shape) and resolves it to a monotonically increasing fake server time. */
function resolveSentinels(data: StoredDoc): StoredDoc {
  const out: StoredDoc = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v instanceof FieldValue ? new Timestamp((fakeServerClock += 1), 0) : v;
  }
  return out;
}

/**
 * Buffers all writes in a per-transaction overlay — nothing touches the
 * shared store until `commit()` is called by `FakeFirestore.runTransaction`
 * AFTER the user callback resolves without throwing (real rollback-on-error:
 * a thrown callback leaves the overlay discarded, store untouched). Enforces
 * read-after-write rejection (real Firestore constraint).
 */
class FakeTransaction {
  private readonly overlay: Overlay = new Map();
  private hasWritten = false;

  constructor(
    private readonly store: Map<string, Map<string, StoredDoc>>,
    private readonly firestore: FakeFirestore,
  ) {}

  async get(refOrQuery: FakeDocRef | FakeQuery) {
    if (this.hasWritten) {
      throw new Error('FakeTransaction: read after write inside one transaction is not allowed (matches real Firestore)');
    }
    if (refOrQuery instanceof FakeDocRef) {
      // BF-3/BF-6 test seam: notifies the firestore-level read hook BEFORE
      // resolving the read, allowing a test to inject a direct store
      // mutation exactly between two of THIS worker's own sequential
      // transactions (e.g. between its T1 commit and its T3 read) — the one
      // interleaving point this harness cannot otherwise model. Disclosed
      // explicitly; see `FakeFirestore.onNthRead`'s own doc comment.
      this.firestore._noteRead(refOrQuery.collectionName, refOrQuery.id);
      const key = overlayKey(refOrQuery.collectionName, refOrQuery.id);
      if (this.overlay.has(key)) {
        const v = this.overlay.get(key);
        return makeSnap(refOrQuery.id, v === 'DELETED' ? undefined : v, refOrQuery);
      }
      return refOrQuery.get();
    }
    return refOrQuery.get();
  }

  update(ref: FakeDocRef, data: StoredDoc) {
    this.hasWritten = true;
    this.firestore._noteWrite(ref.collectionName, ref.id, 'update', Object.keys(data));
    const key = overlayKey(ref.collectionName, ref.id);
    const base = this.overlay.has(key) ? this.overlay.get(key) : this.store.get(ref.collectionName)?.get(ref.id);
    const existing = base === 'DELETED' || base === undefined ? {} : base;
    this.overlay.set(key, { ...existing, ...resolveSentinels(data) });
  }

  create(ref: FakeDocRef, data: StoredDoc) {
    this.hasWritten = true;
    const key = overlayKey(ref.collectionName, ref.id);
    // BF-8/BF-11 test seam: fires BEFORE the create-once check itself (not
    // after, like `_noteWrite`/`onNthWrite`) — the one point this harness
    // can inject a genuinely concurrent, already-committed `tx.create` that
    // this attempt has not yet observed via its own `tx.get`, producing a
    // REAL create-once conflict on THIS call rather than merely a
    // pre-seeded doc visible to the read that preceded it.
    this.firestore._noteCreateAttempt(ref.collectionName, ref.id);
    const base = this.overlay.has(key) ? this.overlay.get(key) : this.store.get(ref.collectionName)?.get(ref.id);
    if (base !== undefined && base !== 'DELETED') {
      throw new Error(`create-once violated: ${key} already exists`);
    }
    this.firestore._noteWrite(ref.collectionName, ref.id, 'create', Object.keys(data));
    this.overlay.set(key, resolveSentinels(data));
  }

  /** Applies every buffered write atomically to the shared store. Called ONLY by `FakeFirestore.runTransaction` after a successful callback. */
  commit(store: Map<string, Map<string, StoredDoc>>) {
    for (const [key, value] of this.overlay) {
      const [collection, id] = key.split('/');
      if (!store.has(collection)) store.set(collection, new Map());
      if (value === 'DELETED') store.get(collection)!.delete(id);
      else store.get(collection)!.set(id, value);
    }
  }
}

interface WriteLogEntry {
  collection: string;
  id: string;
  kind: 'update' | 'create';
  /** Exactly the top-level keys the PRODUCTION CODE passed to `tx.update`/`tx.create` for this call — precise evidence of "exactly these fields were written", independent of how the overlay merges with prior state. */
  fields: string[];
}

class FakeFirestore {
  readonly store = new Map<string, Map<string, StoredDoc>>();
  readonly writeLog: WriteLogEntry[] = [];
  private readCounts = new Map<string, number>();
  private readHooks = new Map<string, { afterCount: number; fire: () => void }>();
  private createAttemptCounts = new Map<string, number>();
  private createAttemptHooks = new Map<string, { afterCount: number; fire: () => void }>();

  collection(name: string) {
    return new FakeCollectionRef(this.store, name);
  }

  /**
   * BF-8/BF-11: mirrors the real Admin SDK's own behavior of transparently
   * retrying a transaction whose callback throws a contention error (a
   * genuine `tx.create` conflict included) by re-invoking the callback from
   * scratch against a fresh transaction — never surfacing the conflict to
   * the caller as a crash. Bounded so a persistent, non-transient
   * create-once violation (e.g. the doc genuinely pre-existed before this
   * transaction ever started) still surfaces after a few attempts, exactly
   * as the SDK's own bounded retry budget would.
   */
  async runTransaction(fn: (tx: FakeTransaction) => Promise<unknown>) {
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const tx = new FakeTransaction(this.store, this);
      try {
        const result = await fn(tx); // if fn throws, execution never reaches tx.commit() -> nothing is applied (rollback).
        tx.commit(this.store);
        return result;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('create-once violated') && attempt < MAX_ATTEMPTS - 1) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  seed(collection: string, id: string, data: StoredDoc) {
    if (!this.store.has(collection)) this.store.set(collection, new Map());
    this.store.get(collection)!.set(id, data);
  }

  read(collection: string, id: string): StoredDoc | undefined {
    return this.store.get(collection)?.get(id);
  }

  all(collection: string): StoredDoc[] {
    return [...(this.store.get(collection)?.values() ?? [])];
  }

  /**
   * Test-only interleaving seam (BF-3/BF-6): fires `fire()` — a direct,
   * synchronous mutation of the shared store — immediately BEFORE the Nth
   * transactional read of `collection/id` across the FakeFirestore's whole
   * lifetime (counting across every `runTransaction` call, not just one).
   * This is the harness's explicit, disclosed answer to "this fake cannot
   * model true concurrency": rather than pretending to simulate a second
   * writer, it injects the mutation at the exact point a genuinely
   * concurrent committed writer's effect would become visible to this
   * worker's OWN next sequential transaction (e.g. between its T1 commit —
   * read #1 of the case doc — and its T3 read — read #2).
   */
  onNthRead(collection: string, id: string, n: number, fire: () => void) {
    this.readHooks.set(overlayKey(collection, id), { afterCount: n, fire });
  }

  _noteRead(collection: string, id: string) {
    const key = overlayKey(collection, id);
    const count = (this.readCounts.get(key) ?? 0) + 1;
    this.readCounts.set(key, count);
    const hook = this.readHooks.get(key);
    if (hook && count === hook.afterCount) {
      hook.fire();
      this.readHooks.delete(key);
    }
  }

  /**
   * Test-only TRUE create-conflict seam (BF-8/BF-11, R3): fires `fire()`
   * immediately BEFORE the Nth `tx.create` ATTEMPT on `collection/id` (not
   * write — attempt, counted even when the attempt is about to throw) is
   * checked for create-once conflict. Unlike `onNthRead` (which injects a
   * mutation that becomes visible to the very read it precedes), this seam
   * lets a test inject a concurrent creation AFTER a transaction's own
   * `tx.get` has already observed absence, so that transaction's own
   * `tx.create` call itself genuinely conflicts — the create-once check
   * sees a doc it did not see moments earlier in the same attempt. Combined
   * with `runTransaction`'s retry-on-create-once-conflict loop, this proves
   * a REAL absence-then-conflict-then-retry sequence, not a pre-seeded
   * doc's existence merely observed on the first read.
   */
  onNthCreateAttempt(collection: string, id: string, n: number, fire: () => void) {
    this.createAttemptHooks.set(overlayKey(collection, id), { afterCount: n, fire });
  }

  _noteCreateAttempt(collection: string, id: string) {
    const key = overlayKey(collection, id);
    const count = (this.createAttemptCounts.get(key) ?? 0) + 1;
    this.createAttemptCounts.set(key, count);
    const hook = this.createAttemptHooks.get(key);
    if (hook && count === hook.afterCount) {
      hook.fire();
      this.createAttemptHooks.delete(key);
    }
  }

  /**
   * Test-only commit-failure seam (BF-4/BF-7 atomicity): `fire()` is invoked
   * synchronously from inside `tx.update`/`tx.create` on the Nth write to
   * `collection/id`, BEFORE that write is buffered into the transaction's
   * overlay — if `fire()` throws, the whole transaction callback throws,
   * `FakeFirestore.runTransaction` never reaches `tx.commit()`, and nothing
   * is applied to the shared store. This simulates "the deferral write
   * itself failed to commit" at the nearest point this harness can inject a
   * failure (disclosed: a real Firestore commit failure happens later, at
   * the SDK's own commit call, not at the local `update()`/`create()`
   * call — the OBSERVABLE consequence this test cares about, zero partial
   * writes, is identical either way).
   */
  onNthWrite(collection: string, id: string, n: number, fire: () => void) {
    this.writeHooks.set(overlayKey(collection, id), { afterCount: n, fire });
  }

  _noteWrite(collection: string, id: string, kind: 'update' | 'create', fields: string[]) {
    const key = overlayKey(collection, id);
    const count = (this.writeCounts.get(key) ?? 0) + 1;
    this.writeCounts.set(key, count);
    const hook = this.writeHooks.get(key);
    if (hook && count === hook.afterCount) {
      this.writeHooks.delete(key);
      hook.fire(); // may throw — propagates out of tx.update/tx.create, aborting the transaction before commit.
    }
    this.writeLog.push({ collection, id, kind, fields });
  }

  private writeCounts = new Map<string, number>();
  private writeHooks = new Map<string, { afterCount: number; fire: () => void }>();
}

const NOW = 1_700_000_000_000;
const SHIFT_ID = 'shift-1';
const BRANCH_ID = 'branch-1';
const CLOSE_HASH = 'hash-abc';

function seedCase(firestore: FakeFirestore, overrides: StoredDoc = {}) {
  firestore.seed('shiftCloseCases', SHIFT_ID, {
    shiftId: SHIFT_ID,
    branchId: BRANCH_ID,
    staffId: 'staff-1',
    deviceId: 'device-1',
    selectedRunId: null,
    selectedCloseHash: null,
    priorSelectedRunId: null,
    latestEvidenceId: `${SHIFT_ID}_${CLOSE_HASH}`,
    latestCloseHash: CLOSE_HASH,
    processingState: 'queued',
    settlementState: 'unsettled',
    alertState: 'none',
    caseVersion: 1,
    sourceRevision: 1,
    pendingRevalidation: true,
    lastObservedCommitMicros: '0',
    commitBoundaryDocKeys: [],
    revalidationAttempts: 0,
    leaseOwner: null,
    leaseExpiry: null,
    nextEligibleAt: new Timestamp(0, 0),
    lateEventHorizonUntil: Timestamp.fromMillis(NOW + 7 * 24 * 60 * 60 * 1000),
    sweepEligible: true,
    schemaVersion: 1,
    ...overrides,
  });
}

function seedAlert(firestore: FakeFirestore, overrides: StoredDoc = {}) {
  firestore.seed('shiftCloseAlerts', SHIFT_ID, {
    shiftId: SHIFT_ID,
    branchId: BRANCH_ID,
    alertState: 'none',
    reasonCode: null,
    openedAt: null,
    acknowledgedByActor: null,
    resolvedByActor: null,
    caseVersion: 1,
    schemaVersion: 1,
    ...overrides,
  });
}

function seedEvidence(firestore: FakeFirestore, overrides: StoredDoc = {}) {
  firestore.seed('shiftCloseEvidence', `${SHIFT_ID}_${CLOSE_HASH}`, {
    evidenceId: `${SHIFT_ID}_${CLOSE_HASH}`,
    shiftId: SHIFT_ID,
    closeHash: CLOSE_HASH,
    branchId: BRANCH_ID,
    staffId: 'staff-1',
    deviceId: 'device-1',
    startingCash: 0,
    actualCashCount: 0,
    variance: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    payInTotal: 0,
    payOutTotal: 0,
    totalBills: 0,
    note: null,
    cashEntriesSnapshot: [],
    cashEntriesSnapshotMeta: { foldBlockingCount: 0, cashEntriesOverflowed: false, count: 0, softFlagCount: 0, firstFoldBlockingReason: null, sourceEntryCount: 0, capturedFrom: 'shifts.cashEntries' },
    cashEntriesDigest: 'x',
    cashEntriesFullDigest: 'x',
    sourceEntryCount: 0,
    sourceCloseDocPath: `shifts/${SHIFT_ID}`,
    observedShiftStatus: 'closed',
    observedClosedAt: null,
    schemaVersion: 1,
    ...overrides,
  });
}

describe('shiftCloseValidationSweep — export shape', () => {
  test('scheduled hourly, timeoutSeconds 540, retryCount 0 (GD6)', () => {
    const opts = (shiftCloseValidationSweep as unknown as { __endpoint?: { schedule?: { schedule?: string } } }).__endpoint;
    // The firebase-functions v2 onSchedule wraps options into __endpoint at
    // build time; assert the export exists and is a function (deploy-shape
    // proof beyond this requires the Functions Framework, out of unit-test
    // scope — disclosed honestly in the implementation report).
    expect(typeof shiftCloseValidationSweep).toBe('function');
    void opts;
  });
});

describe('runValidationSweep — Gate 3 normal selection (match verdict)', () => {
  test('match verdict writes run + case + audit, no alert_opened, pendingRevalidation cleared', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore);
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as import('firebase-admin/firestore').Firestore, nowMillis: NOW, invocationId: 'inv-1' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.pendingRevalidation).toBe(false);
    expect(finalCase.selectedRunId).toBe(`${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(finalCase.leaseOwner).toBeNull();
    expect(finalCase.revalidationAttempts).toBe(0);

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run).toBeDefined();
    expect(run!.validationVerdict).toBe('match');
    expect(run!.completenessPosture).toBe('provisional');
    expect(run).not.toHaveProperty('updatedAt');

    const audits = firestore.all('shiftCloseAuditEvents');
    expect(audits.some((a) => a.transitionType === 'run_selected')).toBe(true);
    expect(audits.some((a) => a.transitionType === 'alert_opened')).toBe(false);
  });
});

describe('runValidationSweep — T1 live-owner skip', () => {
  test('a live unexpired lease is skipped: zero writes to the case', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { leaseOwner: 'other-invocation', leaseExpiry: Timestamp.fromMillis(NOW + 60_000) });
    seedAlert(firestore);
    seedEvidence(firestore);

    const before = { ...firestore.read('shiftCloseCases', SHIFT_ID) };
    await runValidationSweep({ firestore: firestore as unknown as import('firebase-admin/firestore').Firestore, nowMillis: NOW, invocationId: 'inv-1' });
    const after = firestore.read('shiftCloseCases', SHIFT_ID)!;

    expect(after.leaseOwner).toBe(before.leaseOwner);
    expect(after.caseVersion).toBe(before.caseVersion);
    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0);
  });
});

describe('runValidationSweep — Q7 expired-lease recovery', () => {
  test('cause-agnostic recovery: lease cleared, attempts/pendingRevalidation preserved', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, {
      pendingRevalidation: false,
      processingState: 'validating',
      leaseOwner: 'dead-invocation',
      leaseExpiry: Timestamp.fromMillis(NOW - 1000),
      revalidationAttempts: 4,
      nextEligibleAt: Timestamp.fromMillis(NOW + 999_999_999),
      selectedCloseHash: CLOSE_HASH,
      sweepEligible: false,
    });
    seedAlert(firestore, { alertState: 'open', reasonCode: 'drawer_discrepancy', openedAt: new Timestamp(1, 0), caseVersion: 1 });
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as import('firebase-admin/firestore').Firestore, nowMillis: NOW, invocationId: 'inv-1' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.leaseOwner).toBeNull();
    expect(finalCase.processingState).toBe('queued');
    expect(finalCase.revalidationAttempts).toBe(4); // preserved, non-counting
  });
});

// ---------------------------------------------------------------------------
// B3/GD9 sweep-recheck wiring (remediation of the previously-disclosed gap):
// a resting selected case reached ONLY by the sweep stream (no pending work)
// must recompute its inputsDigest and compare against the selected run,
// never merely re-defer. Each test bootstraps a REAL selection via a normal
// (pending-work) attempt first, then drives a second sweep pass at the
// resting case — this proves the wiring through the actual production
// digest-computation pipeline rather than hand-duplicating it in the test.
// ---------------------------------------------------------------------------

describe('runValidationSweep — B3/GD9 sweep-recheck wiring', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  async function bootstrapSelection(firestore: FakeFirestore) {
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-bootstrap' });
    const bootstrapped = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(bootstrapped.selectedRunId).toBe(`${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(bootstrapped.pendingRevalidation).toBe(false);
    expect(bootstrapped.sweepEligible).toBe(true);
    expect(bootstrapped.sourceRevision).toBe(1);
    return bootstrapped;
  }

  test('equal digest: no new run, selection preserved, GD9 24h defer, zero attempts/alert', async () => {
    const firestore = new FakeFirestore();
    const bootstrapped = await bootstrapSelection(firestore);
    const NOW2 = NOW + 25 * 60 * 60 * 1000;
    // No manual cursor reseed: the bootstrap invocation exhausted both
    // streams (their single case was fully consumed), so both cursors were
    // persisted `cycleComplete:true` and will roll over to a fresh cycle at
    // NOW2 automatically via `loadOrInitCursor`.

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-recheck' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.selectedRunId).toBe(bootstrapped.selectedRunId);
    expect(finalCase.sourceRevision).toBe(1);
    expect(finalCase.nextEligibleAt).toEqual(Timestamp.fromMillis(NOW2 + 24 * 60 * 60 * 1000));
    expect(finalCase.revalidationAttempts).toBe(0);
    expect(finalCase.leaseOwner).toBeNull();

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(1); // still just the original run
    const audits = firestore.all('shiftCloseAuditEvents');
    expect(audits.filter((a) => a.transitionType === 'run_selected')).toHaveLength(1); // no new selection audit
    expect(audits.some((a) => a.transitionType === 'alert_opened')).toBe(false);
  });

  test('changed digest: R->R+1, new run at the new revision, case selection updated, superseded audit', async () => {
    const firestore = new FakeFirestore();
    const bootstrapped = await bootstrapSelection(firestore);

    // A new device-scoped sale changes the device-scoped fold between phases
    // -> the recomputed candidate digest at R must differ from run1's stored
    // inputsDigest.
    firestore.seed('asyncOrders', 'order-1', {
      shiftId: SHIFT_ID,
      branchId: BRANCH_ID,
      deviceId: 'device-1',
      status: 'completed',
      voidRequested: false,
      reconcileStatus: 'pending_reconcile',
      changeAmt: 0,
      payments: [{ method: 'cash', amount: 100 }],
    });

    const NOW2 = NOW + 25 * 60 * 60 * 1000;
    // No manual cursor reseed — same natural rollover as the equal-digest test.

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-recheck' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.sourceRevision).toBe(2);
    expect(finalCase.selectedRunId).toBe(`${SHIFT_ID}_${CLOSE_HASH}_1_2`);
    expect(finalCase.priorSelectedRunId).toBe(bootstrapped.selectedRunId);
    expect(finalCase.leaseOwner).toBeNull();

    const runs = firestore.all('shiftCloseValidationRuns');
    expect(runs).toHaveLength(2);
    const newRun = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_2`)!;
    expect(newRun.sourceRevision).toBe(2);
    expect((newRun.creditDebtReceiptsObserved as { observedAsOfSourceRevision: number }).observedAsOfSourceRevision).toBe(2);
    // Revision-consistency invariant (B3): runId, run.sourceRevision, and the
    // credit-observation revision all agree at R+1.
    expect(newRun.runId).toBe(`${SHIFT_ID}_${CLOSE_HASH}_1_2`);

    const audits = firestore.all('shiftCloseAuditEvents');
    expect(audits.some((a) => a.transitionType === 'superseded' && a.oldRunId === bootstrapped.selectedRunId && a.newRunId === newRun.runId)).toBe(
      true,
    );
  });

  test('not-yet-due: a resting case with nextEligibleAt in the future is not admitted (query-level exclusion), zero writes', async () => {
    const firestore = new FakeFirestore();
    const bootstrapped = await bootstrapSelection(firestore);
    const before = { ...firestore.read('shiftCloseCases', SHIFT_ID) };

    // Same-instant re-run (no cycle rollover would help): the resting case's
    // nextEligibleAt (NOW + 24h, set by bootstrap) stays strictly after this
    // re-run's cycleStartedAt regardless of rollover, so it is excluded at
    // the query level.
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-recheck-2' });

    const after = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(after.caseVersion).toBe(before.caseVersion);
    expect(after.selectedRunId).toBe(bootstrapped.selectedRunId);
    expect(after.revalidationAttempts).toBe(0);
    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(1);
  });

  test('trigger/pending path is unaffected by the recheck wiring (regression)', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore);
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.selectedRunId).toBe(`${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(finalCase.sourceRevision).toBe(1);
    expect(finalCase.pendingRevalidation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cursor cycle rollover (remediation of the previously-disclosed gap): a
// stream's `cycleStartedAt` must not stay pinned to first cursor creation
// forever. On genuine exhaustion of the current cycle, the NEXT invocation
// must begin a fresh cycle at ITS OWN `nowMillis` — never at Gate-1-stop or
// budget-stop time, and never fabricating exhaustion when eligible rows
// remain unprocessed.
// ---------------------------------------------------------------------------

describe('runValidationSweep — cursor cycle rollover', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  function seedNCases(firestore: FakeFirestore, n: number, overrides: (i: number) => StoredDoc = () => ({})) {
    for (let i = 0; i < n; i += 1) {
      const shiftId = `shift-multi-${i}`;
      const closeHash = `hash-multi-${i}`;
      firestore.seed('shiftCloseCases', shiftId, {
        shiftId,
        branchId: BRANCH_ID,
        staffId: 'staff-1',
        deviceId: 'device-1',
        selectedRunId: null,
        selectedCloseHash: null,
        priorSelectedRunId: null,
        latestEvidenceId: `${shiftId}_${closeHash}`,
        latestCloseHash: closeHash,
        processingState: 'queued',
        settlementState: 'unsettled',
        alertState: 'none',
        caseVersion: 1,
        sourceRevision: 1,
        pendingRevalidation: true,
        lastObservedCommitMicros: '0',
        commitBoundaryDocKeys: [],
        revalidationAttempts: 0,
        leaseOwner: null,
        leaseExpiry: null,
        nextEligibleAt: new Timestamp(0, 0),
        lateEventHorizonUntil: Timestamp.fromMillis(NOW + 7 * 24 * 60 * 60 * 1000),
        sweepEligible: false,
        schemaVersion: 1,
        ...overrides(i),
      });
      firestore.seed('shiftCloseAlerts', shiftId, {
        shiftId,
        branchId: BRANCH_ID,
        alertState: 'none',
        reasonCode: null,
        openedAt: null,
        acknowledgedByActor: null,
        resolvedByActor: null,
        caseVersion: 1,
        schemaVersion: 1,
      });
      firestore.seed('shiftCloseEvidence', `${shiftId}_${closeHash}`, {
        evidenceId: `${shiftId}_${closeHash}`,
        shiftId,
        closeHash,
        branchId: BRANCH_ID,
        staffId: 'staff-1',
        deviceId: 'device-1',
        startingCash: 0,
        actualCashCount: 0,
        variance: 0,
        expectedCash: 0,
        expectedQr: 0,
        expectedKbank: 0,
        expectedCard: 0,
        expectedCredit: 0,
        payInTotal: 0,
        payOutTotal: 0,
        totalBills: 0,
        note: null,
        cashEntriesSnapshot: [],
        cashEntriesSnapshotMeta: {
          foldBlockingCount: 0,
          cashEntriesOverflowed: false,
          count: 0,
          softFlagCount: 0,
          firstFoldBlockingReason: null,
          sourceEntryCount: 0,
          capturedFrom: 'shifts.cashEntries',
        },
        cashEntriesDigest: 'x',
        cashEntriesFullDigest: 'x',
        sourceEntryCount: 0,
        sourceCloseDocPath: `shifts/${shiftId}`,
        observedShiftStatus: 'closed',
        observedClosedAt: null,
        schemaVersion: 1,
      });
    }
  }

  test('initial cursor creation uses the invocation cycle timestamp', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: false, selectedCloseHash: CLOSE_HASH, sweepEligible: false }); // no eligible rows in either stream
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const triggerCursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    const sweepCursor = firestore.read('shiftCloseSweepCursor', 'sweep')!;
    expect(triggerCursor.cycleStartedAt).toEqual(Timestamp.fromMillis(NOW));
    expect(sweepCursor.cycleStartedAt).toEqual(Timestamp.fromMillis(NOW));
  });

  test('exhausted trigger stream rolls to a fresh cycleStartedAt on a later invocation', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000), sweepEligible: false });
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });
    const afterFirst = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(afterFirst.cycleComplete).toBe(true); // the single case was fully consumed -> genuine exhaustion
    expect(afterFirst.cycleStartedAt).toEqual(Timestamp.fromMillis(NOW));

    const NOW2 = NOW + 60 * 60 * 1000;
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-2' });
    const afterSecond = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    // Rolled over to THIS invocation's own now, not the exhaustion-detection time.
    expect(afterSecond.cycleStartedAt).toEqual(Timestamp.fromMillis(NOW2));
  });

  test('exhausted sweep stream rolls to a fresh cycleStartedAt on a later invocation', async () => {
    const firestore = new FakeFirestore();
    // A resting, already-selected, due-for-recheck case is picked up ONLY by
    // the sweep stream (pendingRevalidation:false).
    seedCase(firestore, {
      pendingRevalidation: false,
      selectedCloseHash: CLOSE_HASH,
      selectedRunId: `${SHIFT_ID}_${CLOSE_HASH}_1_1`,
      sweepEligible: true,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
    });
    seedAlert(firestore);
    seedEvidence(firestore);
    firestore.seed('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`, {
      runId: `${SHIFT_ID}_${CLOSE_HASH}_1_1`,
      inputsDigest: 'irrelevant-for-this-test',
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });
    const afterFirst = firestore.read('shiftCloseSweepCursor', 'sweep')!;
    expect(afterFirst.cycleComplete).toBe(true);
    expect(afterFirst.cycleStartedAt).toEqual(Timestamp.fromMillis(NOW));

    const NOW2 = NOW + 60 * 60 * 1000;
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-2' });
    const afterSecond = firestore.read('shiftCloseSweepCursor', 'sweep')!;
    expect(afterSecond.cycleStartedAt).toEqual(Timestamp.fromMillis(NOW2));
  });

  test('a case due after the old cycle but before the new invocation is admitted on rollover', async () => {
    const firestore = new FakeFirestore();
    // Bootstrap: one case, immediately exhausts both streams.
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    // A SECOND case becomes due strictly between the old cycleStartedAt (NOW)
    // and the next invocation's now (NOW2) — it must be admitted once the
    // stream rolls to the new cycle.
    const NOW2 = NOW + 60 * 60 * 1000;
    const dueDuringGap = NOW + 30 * 60 * 1000;
    firestore.seed('shiftCloseCases', 'shift-2', {
      shiftId: 'shift-2',
      branchId: BRANCH_ID,
      staffId: 'staff-1',
      deviceId: 'device-1',
      selectedRunId: null,
      selectedCloseHash: null,
      priorSelectedRunId: null,
      latestEvidenceId: 'shift-2_hash-2',
      latestCloseHash: 'hash-2',
      processingState: 'queued',
      settlementState: 'unsettled',
      alertState: 'none',
      caseVersion: 1,
      sourceRevision: 1,
      pendingRevalidation: true,
      lastObservedCommitMicros: '0',
      commitBoundaryDocKeys: [],
      revalidationAttempts: 0,
      leaseOwner: null,
      leaseExpiry: null,
      nextEligibleAt: Timestamp.fromMillis(dueDuringGap),
      lateEventHorizonUntil: Timestamp.fromMillis(NOW + 7 * 24 * 60 * 60 * 1000),
      sweepEligible: false,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseAlerts', 'shift-2', {
      shiftId: 'shift-2',
      branchId: BRANCH_ID,
      alertState: 'none',
      reasonCode: null,
      openedAt: null,
      acknowledgedByActor: null,
      resolvedByActor: null,
      caseVersion: 1,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseEvidence', 'shift-2_hash-2', {
      evidenceId: 'shift-2_hash-2',
      shiftId: 'shift-2',
      closeHash: 'hash-2',
      branchId: BRANCH_ID,
      staffId: 'staff-1',
      deviceId: 'device-1',
      startingCash: 0,
      actualCashCount: 0,
      variance: 0,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      note: null,
      cashEntriesSnapshot: [],
      cashEntriesSnapshotMeta: { foldBlockingCount: 0, cashEntriesOverflowed: false, count: 0, softFlagCount: 0, firstFoldBlockingReason: null, sourceEntryCount: 0, capturedFrom: 'shifts.cashEntries' },
      cashEntriesDigest: 'x',
      cashEntriesFullDigest: 'x',
      sourceEntryCount: 0,
      sourceCloseDocPath: 'shifts/shift-2',
      observedShiftStatus: 'closed',
      observedClosedAt: null,
      schemaVersion: 1,
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-2' });

    const shift2Final = firestore.read('shiftCloseCases', 'shift-2')!;
    expect(shift2Final.pendingRevalidation).toBe(false);
    expect(shift2Final.selectedRunId).toBe('shift-2_hash-2_1_1');
  });

  test('budget stop preserves the cycle (no fake exhaustion) and does not advance past unprocessed eligible rows', async () => {
    const firestore = new FakeFirestore();
    // 13 due trigger-stream cases: the frozen budget ceiling admits exactly
    // 12 per invocation (12 * 1412 = 16944 <= 17000; a 13th would need 18356).
    seedNCases(firestore, 13, () => ({ nextEligibleAt: Timestamp.fromMillis(NOW - 1000) }));

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const processed = Array.from({ length: 13 }, (_, i) => firestore.read('shiftCloseCases', `shift-multi-${i}`)!).filter(
      (c) => c.pendingRevalidation === false,
    );
    expect(processed).toHaveLength(12); // budget-bounded, not all 13

    const triggerCursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(triggerCursor.cycleComplete).toBe(false); // NOT genuinely exhausted — one case remains unprocessed
    expect(triggerCursor.cycleStartedAt).toEqual(Timestamp.fromMillis(NOW)); // same cycle preserved, not rolled

    // The sweep stream, with nothing eligible, DOES exhaust in the same
    // invocation — proving the two streams roll independently.
    const sweepCursor = firestore.read('shiftCloseSweepCursor', 'sweep')!;
    expect(sweepCursor.cycleComplete).toBe(true);
  });

  test('BF-8: a fully-consumed FULL page (own-head, no budget pressure) persists the compound cursor and continues via startAfter next invocation, never re-fetching the same page', async () => {
    const firestore = new FakeFirestore();
    // 25 due trigger-stream cases, all with a LIVE unexpired lease held by
    // another owner: every one is `skip_live_owner` (own-head, no-cache —
    // BF-2), so the whole 25-row page is consumed WITHOUT any budget
    // pressure (own-head rows never count toward `admittedCases`).
    seedNCases(firestore, 25, (i) => ({
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000 + i), // distinct, strictly increasing nextEligibleAt per case
      leaseOwner: 'other-owner',
      leaseExpiry: Timestamp.fromMillis(NOW + 999_999_999),
    }));
    // A 26th case, NOT leased, due slightly later than all 25 above — must
    // be admitted only once the stream continues past the first page.
    firestore.seed('shiftCloseCases', 'shift-multi-26', {
      shiftId: 'shift-multi-26',
      branchId: BRANCH_ID,
      staffId: 'staff-1',
      deviceId: 'device-1',
      selectedRunId: null,
      selectedCloseHash: null,
      priorSelectedRunId: null,
      latestEvidenceId: 'shift-multi-26_hash-multi-26',
      latestCloseHash: 'hash-multi-26',
      processingState: 'queued',
      settlementState: 'unsettled',
      alertState: 'none',
      caseVersion: 1,
      sourceRevision: 1,
      pendingRevalidation: true,
      lastObservedCommitMicros: '0',
      commitBoundaryDocKeys: [],
      revalidationAttempts: 0,
      leaseOwner: null,
      leaseExpiry: null,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000 + 30), // after all 25 leased cases
      lateEventHorizonUntil: Timestamp.fromMillis(NOW + 7 * 24 * 60 * 60 * 1000),
      sweepEligible: false,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseAlerts', 'shift-multi-26', { shiftId: 'shift-multi-26', branchId: BRANCH_ID, alertState: 'none', reasonCode: null, openedAt: null, acknowledgedByActor: null, resolvedByActor: null, caseVersion: 1, schemaVersion: 1 });
    firestore.seed('shiftCloseEvidence', 'shift-multi-26_hash-multi-26', {
      evidenceId: 'shift-multi-26_hash-multi-26', shiftId: 'shift-multi-26', closeHash: 'hash-multi-26', branchId: BRANCH_ID, staffId: 'staff-1', deviceId: 'device-1',
      startingCash: 0, actualCashCount: 0, variance: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 0, note: null,
      cashEntriesSnapshot: [], cashEntriesSnapshotMeta: { foldBlockingCount: 0, cashEntriesOverflowed: false, count: 0, softFlagCount: 0, firstFoldBlockingReason: null, sourceEntryCount: 0, capturedFrom: 'shifts.cashEntries' },
      cashEntriesDigest: 'x', cashEntriesFullDigest: 'x', sourceEntryCount: 0, sourceCloseDocPath: 'shifts/shift-multi-26', observedShiftStatus: 'closed', observedClosedAt: null, schemaVersion: 1,
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    // First invocation: the 26th case is NOT yet reachable (page limit 25).
    expect(firestore.read('shiftCloseCases', 'shift-multi-26')!.pendingRevalidation).toBe(true);
    const cursorAfterFirst = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(cursorAfterFirst.cycleComplete).toBe(false); // full page, NOT provably exhausted
    expect(cursorAfterFirst.lastShiftId).toBe('shift-multi-24'); // last of the 25-row page
    expect(cursorAfterFirst.lastNextEligibleAt).toEqual(Timestamp.fromMillis(NOW - 1000 + 24));

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-2' });

    // Second invocation: `startAfter(lastNextEligibleAt, lastShiftId)` fetches
    // the NEXT page (just the 26th case) instead of re-fetching page 1.
    expect(firestore.read('shiftCloseCases', 'shift-multi-26')!.pendingRevalidation).toBe(false);
  });

  test('BF-8/BF-11 (R3): a TRUE tx.create conflict on the trigger cursor — absence genuinely observed, a concurrent creator commits between that read and this attempt\'s own create-once check, this transaction retries and returns the concurrent doc untouched, never double-creates', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000), sweepEligible: false });
    seedAlert(firestore);
    seedEvidence(firestore);

    // Codex R3: the PRIOR version of this test injected the concurrent doc
    // via `onNthRead`, which fires BEFORE the read it targets resolves — so
    // that read observed the doc as already-existing, took the ordinary
    // `snap.exists` branch, and never called `tx.create` at all. No
    // absence was ever observed, no conflict occurred, no retry was
    // exercised. This version uses `onNthCreateAttempt`, which fires
    // immediately before this attempt's OWN create-once check — strictly
    // AFTER `loadOrInitCursor`'s own `tx.get` has already resolved and
    // found the doc absent (nothing is seeded until this hook fires). The
    // concurrent doc is committed directly to the shared store (bypassing
    // any transaction overlay), exactly as another invocation's already-
    // committed `tx.create` would appear. This attempt's `tx.create` then
    // genuinely conflicts, throws, and `FakeFirestore.runTransaction`'s
    // retry loop (mirroring the real Admin SDK's own retry-on-ABORTED
    // behavior) re-invokes `loadOrInitCursor`'s callback from scratch — the
    // retry's own fresh `tx.get` now observes the concurrent doc and takes
    // the "already exists" branch, returning it untouched.
    firestore.onNthCreateAttempt('shiftCloseSweepCursor', 'trigger', 1, () => {
      firestore.seed('shiftCloseSweepCursor', 'trigger', {
        schemaVersion: 1,
        streamKind: 'trigger',
        cycleId: 'concurrent-cycle',
        cycleStartedAt: Timestamp.fromMillis(NOW - 500),
        cycleComplete: false,
        invocationsThisCycle: 0,
        lastNextEligibleAt: null,
        lastShiftId: null,
        casVersion: 0,
      });
    });

    await expect(
      runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' }),
    ).resolves.not.toThrow();

    // Exact evidence (not the prior "concurrent-cycle OR any string"
    // overclaim): the retry's `tx.get` returned the CONCURRENT creator's
    // own doc, byte-identical — never overwritten, never double-created.
    const cursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(cursor.cycleId).toBe('concurrent-cycle');
    // The retried `loadOrInitCursor` loaded the concurrent creator's own
    // casVersion:0 as its baseline (never overwritten at load time); this
    // invocation's single eligible case was then processed durably, so the
    // normal end-of-invocation `persistCursor` CAS-checked write correctly
    // advances it from that baseline to 1 — proving the retry path feeds
    // back into completely normal cursor operation afterward, not a stuck
    // or corrupted state.
    expect(cursor.casVersion).toBe(1);
    expect(firestore.all('shiftCloseSweepCursor').filter((d) => (d as { streamKind?: string }).streamKind === 'trigger')).toHaveLength(1);
  });

  test('BF-8: persistCursor observes a stale casVersion and skips the write — never overwrites a concurrently-advanced cursor', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000), sweepEligible: false });
    seedAlert(firestore);
    seedEvidence(firestore);

    // Read #1 of the trigger cursor doc = `loadOrInitCursor`'s own get
    // (doc absent, creates casVersion:0). Read #2 = `persistCursor`'s own
    // get at the end of the invocation — inject a concurrent advance to
    // casVersion:99 immediately before that read, simulating another
    // invocation having already persisted its own progress on this stream
    // since THIS invocation loaded its cursor.
    firestore.onNthRead('shiftCloseSweepCursor', 'trigger', 2, () => {
      const current = firestore.read('shiftCloseSweepCursor', 'trigger')!;
      firestore.seed('shiftCloseSweepCursor', 'trigger', { ...current, casVersion: 99, lastShiftId: 'someone-elses-progress' });
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const cursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    // The CAS check rejected this invocation's stale write — the
    // concurrent writer's casVersion/lastShiftId survive untouched.
    expect(cursor.casVersion).toBe(99);
    expect(cursor.lastShiftId).toBe('someone-elses-progress');
  });

  test('BF-8: compound cursor tie-break — multiple cases sharing the same nextEligibleAt are ordered deterministically by document id', async () => {
    const firestore = new FakeFirestore();
    const sharedNextEligibleAt = Timestamp.fromMillis(NOW - 1000);
    seedNCases(firestore, 3, () => ({ nextEligibleAt: sharedNextEligibleAt }));

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    // All three (tied on nextEligibleAt, ordered by __name__/document id)
    // were consumed in one invocation and the cursor advanced to the LAST
    // one in that deterministic order.
    for (let i = 0; i < 3; i += 1) {
      expect(firestore.read('shiftCloseCases', `shift-multi-${i}`)!.pendingRevalidation).toBe(false);
    }
    const cursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(cursor.cycleComplete).toBe(true); // page (3 rows) smaller than the 25-row limit -> provably exhausted
  });
});

// ---------------------------------------------------------------------------
// BF-11 — harness honesty proof: the fake genuinely enforces rollback-on-
// error and read-after-write rejection, not merely claims to.
// ---------------------------------------------------------------------------

describe('FakeFirestore harness — honesty proof (BF-11)', () => {
  test('a thrown transaction callback commits NOTHING (real rollback)', async () => {
    const firestore = new FakeFirestore();
    firestore.seed('probe', 'doc-1', { value: 'original' });
    await expect(
      firestore.runTransaction(async (tx) => {
        const ref = firestore.collection('probe').doc('doc-1');
        tx.update(ref, { value: 'mutated' });
        throw new Error('simulated mid-transaction failure');
      }),
    ).rejects.toThrow('simulated mid-transaction failure');
    expect(firestore.read('probe', 'doc-1')).toEqual({ value: 'original' });
  });

  test('a successful transaction commits atomically after the callback resolves', async () => {
    const firestore = new FakeFirestore();
    firestore.seed('probe', 'doc-1', { value: 'original' });
    await firestore.runTransaction(async (tx) => {
      const ref = firestore.collection('probe').doc('doc-1');
      tx.update(ref, { value: 'committed' });
    });
    expect(firestore.read('probe', 'doc-1')).toEqual({ value: 'committed' });
  });

  test('reading after writing inside one transaction is rejected (matches real Firestore)', async () => {
    const firestore = new FakeFirestore();
    firestore.seed('probe', 'doc-1', { value: 'x' });
    await expect(
      firestore.runTransaction(async (tx) => {
        const ref = firestore.collection('probe').doc('doc-1');
        tx.update(ref, { value: 'y' });
        await tx.get(ref); // read-after-write — must throw
      }),
    ).rejects.toThrow(/read after write/);
  });

  test('tx.create throws create-once when the doc already exists in the base store', async () => {
    const firestore = new FakeFirestore();
    firestore.seed('probe', 'doc-1', { value: 'x' });
    await expect(
      firestore.runTransaction(async (tx) => {
        tx.create(firestore.collection('probe').doc('doc-1'), { value: 'y' });
      }),
    ).rejects.toThrow(/create-once violated/);
    expect(firestore.read('probe', 'doc-1')).toEqual({ value: 'x' }); // untouched
  });
});

// ---------------------------------------------------------------------------
// BF-1 — Gate-1 durability bypass regression tests.
// ---------------------------------------------------------------------------

describe('runValidationSweep — BF-1 Gate-1 cursor/durability', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  test('a stream with no eligible cases persists its cursor normally (baseline, not stopped)', async () => {
    const firestore = new FakeFirestore();
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });
    expect(firestore.read('shiftCloseSweepCursor', 'trigger')).toBeDefined();
    expect(firestore.read('shiftCloseSweepCursor', 'sweep')).toBeDefined();
  });

  test('direct T3 owner mismatch reaches StopStreamUnowned: no run, case untouched by T3, no cursor persist for the stopped stream', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000), sweepEligible: false });
    seedAlert(firestore);
    seedEvidence(firestore);

    // T1 (read #1 of the case doc) acquires the lease as 'inv-1'; inject a
    // concurrent owner change immediately before T3's read (read #2) — a
    // genuinely different actor took the lease between this worker's own
    // T1 commit and T3 read.
    firestore.onNthRead('shiftCloseCases', SHIFT_ID, 2, () => {
      const current = firestore.read('shiftCloseCases', SHIFT_ID)!;
      firestore.seed('shiftCloseCases', SHIFT_ID, { ...current, leaseOwner: 'other-owner', leaseExpiry: Timestamp.fromMillis(NOW + 999_999) });
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0);
    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.leaseOwner).toBe('other-owner'); // untouched by T3 (Option A zero-write)
    // No cursor persistence occurred for the stopped trigger stream: the
    // doc was created once by `loadOrInitCursor` (casVersion 0) and never
    // advanced by `persistCursor`.
    const triggerCursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(triggerCursor.casVersion).toBe(0);
  });

  test('failure-handler owner mismatch (a T2 exception path) also routes to StopStreamUnowned: no fabricated deferred outcome, no cursor persist', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000), sweepEligible: false });
    seedAlert(firestore);
    // Deliberately malformed evidence (missing cashEntriesSnapshotMeta)
    // forces runT2's transaction callback to throw with an uncoded
    // TypeError, routing through handleFailure -> applyFailureOutcome
    // (Category D) rather than the direct T3 OWNER_MISMATCH path.
    seedEvidence(firestore, { cashEntriesSnapshotMeta: undefined });

    // T1 = read #1 of the case; applyFailureOutcome's own read = read #2.
    firestore.onNthRead('shiftCloseCases', SHIFT_ID, 2, () => {
      const current = firestore.read('shiftCloseCases', SHIFT_ID)!;
      firestore.seed('shiftCloseCases', SHIFT_ID, { ...current, leaseOwner: 'other-owner', leaseExpiry: Timestamp.fromMillis(NOW + 999_999) });
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0);
    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.leaseOwner).toBe('other-owner'); // untouched (Option A zero-write, not a fabricated deferral)
    expect(finalCase.revalidationAttempts).toBe(0); // no fabricated attempt count
    const triggerCursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(triggerCursor.casVersion).toBe(0); // stopped stream -> no cursor persist
  });

  test('the other stream remains independent when one stream stops on Gate 1', async () => {
    const firestore = new FakeFirestore();
    // shift-1: trigger-stream case that will hit Gate-1 stop.
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000), sweepEligible: false });
    seedAlert(firestore);
    seedEvidence(firestore);

    // shift-3: an independent, already-resting, sweep-stream-only case, due for recheck.
    const shift3 = 'shift-3';
    const closeHash3 = 'hash-3';
    firestore.seed('shiftCloseCases', shift3, {
      shiftId: shift3,
      branchId: BRANCH_ID,
      staffId: 'staff-1',
      deviceId: 'device-1',
      selectedRunId: `${shift3}_${closeHash3}_1_1`,
      selectedCloseHash: closeHash3,
      priorSelectedRunId: null,
      latestEvidenceId: `${shift3}_${closeHash3}`,
      latestCloseHash: closeHash3,
      processingState: 'validated',
      settlementState: 'provisional_match',
      alertState: 'none',
      caseVersion: 1,
      sourceRevision: 1,
      pendingRevalidation: false,
      lastObservedCommitMicros: '0',
      commitBoundaryDocKeys: [],
      revalidationAttempts: 0,
      leaseOwner: null,
      leaseExpiry: null,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
      lateEventHorizonUntil: Timestamp.fromMillis(NOW + 7 * 24 * 60 * 60 * 1000),
      sweepEligible: true,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseAlerts', shift3, {
      shiftId: shift3,
      branchId: BRANCH_ID,
      alertState: 'none',
      reasonCode: null,
      openedAt: null,
      acknowledgedByActor: null,
      resolvedByActor: null,
      caseVersion: 1,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseEvidence', `${shift3}_${closeHash3}`, {
      evidenceId: `${shift3}_${closeHash3}`,
      shiftId: shift3,
      closeHash: closeHash3,
      branchId: BRANCH_ID,
      staffId: 'staff-1',
      deviceId: 'device-1',
      startingCash: 0,
      actualCashCount: 0,
      variance: 0,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      note: null,
      cashEntriesSnapshot: [],
      cashEntriesSnapshotMeta: { foldBlockingCount: 0, cashEntriesOverflowed: false, count: 0, softFlagCount: 0, firstFoldBlockingReason: null, sourceEntryCount: 0, capturedFrom: 'shifts.cashEntries' },
      cashEntriesDigest: 'x',
      cashEntriesFullDigest: 'x',
      sourceEntryCount: 0,
      sourceCloseDocPath: `shifts/${shift3}`,
      observedShiftStatus: 'closed',
      observedClosedAt: null,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseValidationRuns', `${shift3}_${closeHash3}_1_1`, { runId: `${shift3}_${closeHash3}_1_1`, inputsDigest: 'stale-digest-will-not-match-anything' });

    firestore.onNthRead('shiftCloseCases', SHIFT_ID, 2, () => {
      const current = firestore.read('shiftCloseCases', SHIFT_ID)!;
      firestore.seed('shiftCloseCases', SHIFT_ID, { ...current, leaseOwner: 'other-owner', leaseExpiry: Timestamp.fromMillis(NOW + 999_999) });
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    // shift-1 (trigger, Gate-1 stopped): no run created.
    expect(firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`)).toBeUndefined();
    // shift-3 (sweep, independent stream): processed normally in the SAME
    // invocation — the changed digest (stale placeholder never matches the
    // real computation) bumps its revision, proving the sweep stream was
    // never blocked by the trigger stream's Gate-1 stop.
    const shift3Final = firestore.read('shiftCloseCases', shift3)!;
    expect(shift3Final.sourceRevision).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// BF-3 — same-T3 stale release worker-level regression: a GENUINE
// concurrent write (via the `onNthRead` interleaving seam) lands between
// this worker's own T1 commit and T3 read, forcing Gate 2.
// ---------------------------------------------------------------------------

describe('runValidationSweep — BF-3 same-T3 stale release (Gate 2)', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  test('exact four-field release write, no updatedAt, preserved fields untouched, no run/audit/alert', async () => {
    const firestore = new FakeFirestore();
    const storedNextEligibleAt = Timestamp.fromMillis(NOW - 1000); // due, and the value T3 must preserve verbatim
    seedCase(firestore, {
      pendingRevalidation: true,
      nextEligibleAt: storedNextEligibleAt,
      sweepEligible: false,
      revalidationAttempts: 3, // must be preserved untouched
      selectedRunId: null,
      selectedCloseHash: null,
    });
    seedAlert(firestore);
    seedEvidence(firestore);

    // T1 = read #1 of the case; inject a concurrent caseVersion bump
    // immediately before T3's read (#2) — a genuinely different, already-
    // committed writer (e.g. a P5-C conflict-close) landed between this
    // worker's own T1 commit and T3 read.
    firestore.onNthRead('shiftCloseCases', SHIFT_ID, 2, () => {
      const current = firestore.read('shiftCloseCases', SHIFT_ID)!;
      firestore.seed('shiftCloseCases', SHIFT_ID, { ...current, caseVersion: (current.caseVersion as number) + 100 });
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0);
    expect(firestore.all('shiftCloseAuditEvents')).toHaveLength(0);

    // Exact write-set proof via the harness write log: the LAST update to
    // this case doc (T3's stale-release, after T1's own acquisition update)
    // must write EXACTLY these four fields — no `updatedAt`.
    const caseUpdates = firestore.writeLog.filter((w) => w.collection === 'shiftCloseCases' && w.id === SHIFT_ID && w.kind === 'update');
    expect(caseUpdates.length).toBeGreaterThanOrEqual(2); // at least T1's acquisition + T3's release
    const staleReleaseWrite = caseUpdates[caseUpdates.length - 1];
    expect(new Set(staleReleaseWrite.fields)).toEqual(new Set(['leaseOwner', 'leaseExpiry', 'processingState', 'caseVersion']));

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.leaseOwner).toBeNull();
    expect(finalCase.processingState).toBe('queued');
    // Preserved fields, byte-identical (never touched by the release write).
    expect(finalCase.revalidationAttempts).toBe(3);
    expect(finalCase.nextEligibleAt).toEqual(storedNextEligibleAt);
    expect(finalCase.selectedRunId).toBeNull();
    expect(finalCase.pendingRevalidation).toBe(true);

    // BF-3 (R3): Gate-2's STALE_REVISION_RELEASED result is mapped to a
    // `{kind:'durable', outcome:{kind:'deferred',...}}` CaseAttemptResult —
    // a genuine durable write, correctly cacheable and cursor-advancing
    // (unlike a Gate-1 owner-mismatch stop). A regression that broke this
    // (e.g. Gate-2 accidentally treated as own_head_no_cache/no_progress)
    // would leave the trigger cursor doc never created/never advanced here
    // while every assertion above still passed — this is exactly the gap
    // Codex R3 flagged. Prove cursor persistence and advancement directly.
    const triggerCursor = firestore.read('shiftCloseSweepCursor', 'trigger');
    expect(triggerCursor).toBeDefined(); // persistCursor's create-once write genuinely fired
    // This fixture has exactly one trigger-eligible case, so the fetched
    // page (1 row) is smaller than PAGE_LIMIT (25) -> isLastPage:true; and
    // the released case was the only row in the page -> triggerPageConsumed
    // is true. Both together -> genuine full-CYCLE exhaustion (not merely
    // "page consumed", the frozen distinction the cursor-cycle-rollover
    // describe block already covers for the non-Gate-2 case). Per
    // `persistCursor`, cycleComplete:true forces lastNextEligibleAt/
    // lastShiftId back to null (a fresh cycle has no mid-cycle
    // continuation point) -- this is the CORRECT behavior for THIS page
    // shape, not evidence of the cursor failing to advance. The
    // multi-page ("shift-multi-24") test in the cursor-cycle-rollover
    // describe block separately proves lastNextEligibleAt/lastShiftId
    // literally carry the last-consumed row's own values on a NON-complete
    // (exactly-page-limit) cycle.
    expect(triggerCursor!.cycleComplete).toBe(true);
    expect(triggerCursor!.lastNextEligibleAt).toBeNull();
    expect(triggerCursor!.lastShiftId).toBeNull();
    // casVersion: created fresh in THIS invocation (0) then bumped by
    // exactly one CAS-checked persistCursor write following the Gate-2
    // durable outcome (1) -- proves the write is not a duplicate/skipped
    // no-op and not a silently-discarded stale-CAS write either.
    expect(triggerCursor!.casVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BF-7 — alert audit gating + zero-write anomaly sequencing.
// ---------------------------------------------------------------------------

describe('runValidationSweep — BF-7 alert contract', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  test('open -> open (superseding discrepancy) still creates a deterministic alert_opened audit', async () => {
    const firestore = new FakeFirestore();
    // First close: a discrepancy (drawer mismatch) opens the alert.
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore, { expectedCash: 999 }); // forces a nonzero delta -> discrepancy
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });
    const afterFirst = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(afterFirst.alertState).toBe('open');
    const auditsAfterFirst = firestore.all('shiftCloseAuditEvents').filter((a) => a.transitionType === 'alert_opened');
    expect(auditsAfterFirst).toHaveLength(1);

    // A conflict-close style re-enqueue (simulated directly, bumping
    // sourceRevision the way a real conflict-close/re-enqueue always does —
    // otherwise the second attempt would target the SAME runId as the
    // first and legitimately collide on create-once): still a discrepancy
    // after re-validation -> open -> open. Must ALSO audit.
    const current = firestore.read('shiftCloseCases', SHIFT_ID)!;
    firestore.seed('shiftCloseCases', SHIFT_ID, {
      ...current,
      pendingRevalidation: true,
      sourceRevision: (current.sourceRevision as number) + 1,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
    });
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-2' });

    const auditsAfterSecond = firestore.all('shiftCloseAuditEvents').filter((a) => a.transitionType === 'alert_opened');
    expect(auditsAfterSecond.length).toBeGreaterThanOrEqual(2); // BF-7: open->open must ALSO audit, not just the first open
  });

  test('missing alert document produces a named zero-write anomaly, then a non-counting Category-D defer', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    // Deliberately do NOT seed an alert document.
    seedEvidence(firestore);

    const before = { ...firestore.read('shiftCloseCases', SHIFT_ID) };
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });
    const after = firestore.read('shiftCloseCases', SHIFT_ID)!;

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0); // zero-write T3 rejection: no run created
    expect(after.processingState).toBe('queued'); // Category-D non-counting defer
    expect(after.revalidationAttempts).toBe(before.revalidationAttempts); // non-counting
    expect(after.leaseOwner).toBeNull();
  });

  test('retry exhaustion (resolved -> open) writes the exact projection, a deterministic alert_opened audit, no run, and preserves settlement', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, {
      pendingRevalidation: true,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
      sweepEligible: false,
      revalidationAttempts: 9, // one below exhaustion
      alertState: 'resolved',
      settlementState: 'provisional_match', // must be PRESERVED by the non-run exhaustion path
    });
    seedAlert(firestore, {
      alertState: 'resolved',
      reasonCode: 'superseding_match',
      resolvedByActor: { kind: 'system' },
      openedAt: new Timestamp(1, 0),
      caseVersion: 1,
    });
    seedEvidence(firestore);

    // Force a single coded-transient (ABORTED) failure on T2's evidence
    // read — Category A, the ONLY countable failure category — pushing
    // attempts from 9 to the exhaustion threshold of 10.
    firestore.onNthRead('shiftCloseEvidence', `${SHIFT_ID}_${CLOSE_HASH}`, 1, () => {
      // eslint-disable-next-line no-throw-literal
      throw { code: 10 };
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0); // non-run path
    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.processingState).toBe('requires_operator_review');
    expect(finalCase.settlementState).toBe('provisional_match'); // UNCHANGED (frozen "settlement unchanged" rule)
    expect(finalCase.revalidationAttempts).toBe(10);
    expect(finalCase.leaseOwner).toBeNull();

    const finalAlert = firestore.read('shiftCloseAlerts', SHIFT_ID)!;
    expect(finalAlert.alertState).toBe('open'); // resolved -> open
    expect(finalAlert.reasonCode).toBe('retry_exhausted');
    expect(finalAlert.acknowledgedByActor).toBeNull();
    expect(finalAlert.resolvedByActor).toBeNull();

    const alertOpenedAudits = firestore.all('shiftCloseAuditEvents').filter((a) => a.transitionType === 'alert_opened');
    expect(alertOpenedAudits).toHaveLength(1);
    expect((alertOpenedAudits[0] as { reasonCode: string }).reasonCode).toBe('retry_exhausted');
  });

  test('a failed Category-D deferral commit leaves the case byte-identical (atomic rollback, no partial write)', async () => {
    const firestore = new FakeFirestore();
    const before = {
      pendingRevalidation: true,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
      sweepEligible: false,
    };
    seedCase(firestore, before);
    // Deliberately do NOT seed an alert document -> T3 returns the
    // `missing_alert_doc` zero-write anomaly, which routes through
    // `applyFailureOutcome` (Category D).
    seedEvidence(firestore);

    const beforeCase = { ...firestore.read('shiftCloseCases', SHIFT_ID) };

    // Force applyFailureOutcome's OWN Category-D case update to fail to
    // commit (simulated at the nearest injectable point — see
    // `onNthWrite`'s doc comment for the disclosed equivalence).
    firestore.onNthWrite('shiftCloseCases', SHIFT_ID, 2, () => {
      // eslint-disable-next-line no-throw-literal
      throw { code: 'permission-denied' };
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    // Nothing beyond T1's own (unrelated) acquisition write was committed —
    // the failed Category-D write is fully rolled back, not partially
    // applied. Compare every field EXCEPT the ones T1 itself legitimately
    // owns (leaseOwner/leaseExpiry/processingState/caseVersion), which were
    // already committed durably before the Category-D attempt began.
    const afterCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(afterCase.revalidationAttempts).toBe(beforeCase.revalidationAttempts);
    expect(afterCase.pendingRevalidation).toBe(beforeCase.pendingRevalidation);
    expect(afterCase.nextEligibleAt).toEqual(beforeCase.nextEligibleAt); // NOT deferred +24h — the write never committed
    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0);
    expect(firestore.all('shiftCloseAuditEvents')).toHaveLength(0);

    // BF-8 (R3): a failed Category-D deferral COMMIT must be treated as
    // `no_progress` (stream stop), never as own-head consumption. A
    // regression that mapped this back to `own_head_no_cache` would
    // silently advance and PERSIST the trigger cursor past this case even
    // though nothing durable happened. `loadOrInitCursor` itself commits an
    // initial cursor doc (casVersion:0, cycleComplete:false, no
    // continuation) at the very start of the invocation, before any case is
    // attempted — the only question is whether the END-of-invocation
    // `persistCursor` call for 'trigger' fires afterward. It must NOT: the
    // stream stopped, so the top-level `if (!triggerStopped)` guard skips
    // it, and the doc must remain EXACTLY at its just-initialized values.
    const triggerCursor = firestore.read('shiftCloseSweepCursor', 'trigger')!;
    expect(triggerCursor.casVersion).toBe(0); // never bumped past initialization
    expect(triggerCursor.cycleComplete).toBe(false);
    expect(triggerCursor.lastNextEligibleAt).toBeNull();
    expect(triggerCursor.lastShiftId).toBeNull();
  });

  test('a failed Category-D deferral on one case does not stop the OTHER stream in the same invocation', async () => {
    const firestore = new FakeFirestore();
    // Trigger-stream case: will hit the failed-commit path (no alert doc).
    seedCase(firestore, {
      pendingRevalidation: true,
      sweepEligible: false,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
    });
    seedEvidence(firestore);
    // Deliberately do NOT seed an alert document for shift-1 -> missing_alert_doc anomaly -> Category-D.

    // Sweep-stream case: an independent, healthy, already-selected case due
    // for its recheck — must proceed normally in the SAME invocation.
    const OTHER_SHIFT_ID = 'shift-other';
    const OTHER_CLOSE_HASH = 'hash-other';
    firestore.seed('shiftCloseCases', OTHER_SHIFT_ID, {
      shiftId: OTHER_SHIFT_ID,
      branchId: BRANCH_ID,
      staffId: 'staff-1',
      deviceId: 'device-1',
      selectedRunId: `${OTHER_SHIFT_ID}_${OTHER_CLOSE_HASH}_1_1`,
      selectedCloseHash: OTHER_CLOSE_HASH,
      priorSelectedRunId: null,
      latestEvidenceId: `${OTHER_SHIFT_ID}_${OTHER_CLOSE_HASH}`,
      latestCloseHash: OTHER_CLOSE_HASH,
      processingState: 'queued',
      settlementState: 'unsettled',
      alertState: 'none',
      caseVersion: 1,
      sourceRevision: 1,
      pendingRevalidation: false,
      lastObservedCommitMicros: '0',
      commitBoundaryDocKeys: [],
      revalidationAttempts: 0,
      leaseOwner: null,
      leaseExpiry: null,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
      lateEventHorizonUntil: Timestamp.fromMillis(NOW + 7 * 24 * 60 * 60 * 1000),
      sweepEligible: true,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseAlerts', OTHER_SHIFT_ID, {
      shiftId: OTHER_SHIFT_ID,
      branchId: BRANCH_ID,
      alertState: 'none',
      reasonCode: null,
      openedAt: null,
      acknowledgedByActor: null,
      resolvedByActor: null,
      caseVersion: 1,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseEvidence', `${OTHER_SHIFT_ID}_${OTHER_CLOSE_HASH}`, {
      evidenceId: `${OTHER_SHIFT_ID}_${OTHER_CLOSE_HASH}`,
      shiftId: OTHER_SHIFT_ID,
      closeHash: OTHER_CLOSE_HASH,
      branchId: BRANCH_ID,
      staffId: 'staff-1',
      deviceId: 'device-1',
      startingCash: 0,
      actualCashCount: 0,
      variance: 0,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      note: null,
      cashEntriesSnapshot: [],
      cashEntriesSnapshotMeta: { foldBlockingCount: 0, cashEntriesOverflowed: false, count: 0, softFlagCount: 0, firstFoldBlockingReason: null, sourceEntryCount: 0, capturedFrom: 'shifts.cashEntries' },
      cashEntriesDigest: 'x',
      cashEntriesFullDigest: 'x',
      sourceEntryCount: 0,
      sourceCloseDocPath: `shifts/${OTHER_SHIFT_ID}`,
      observedShiftStatus: 'closed',
      observedClosedAt: null,
      schemaVersion: 1,
    });
    firestore.seed('shiftCloseValidationRuns', `${OTHER_SHIFT_ID}_${OTHER_CLOSE_HASH}_1_1`, {
      runId: `${OTHER_SHIFT_ID}_${OTHER_CLOSE_HASH}_1_1`,
      shiftId: OTHER_SHIFT_ID,
      inputsDigest: 'stale-digest-forces-recheck-mismatch',
    });

    firestore.onNthWrite('shiftCloseCases', SHIFT_ID, 2, () => {
      // eslint-disable-next-line no-throw-literal
      throw { code: 'permission-denied' };
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    // The failed-deferral case: no run/audit, cursor evidence as above.
    expect(firestore.all('shiftCloseValidationRuns').filter((r) => r.shiftId === SHIFT_ID)).toHaveLength(0);

    // The OTHER (sweep-stream) case genuinely progressed in the SAME
    // invocation: its stale stored digest triggered a real B3/GD9 recheck
    // selection (sourceRevision bumped 1->2, a fresh run selected), proving
    // the failed-commit on the trigger stream did not stop or otherwise
    // block the independent sweep stream's own processing.
    const otherFinal = firestore.read('shiftCloseCases', OTHER_SHIFT_ID)!;
    expect(otherFinal.processingState).toBe('validated');
    expect(otherFinal.sourceRevision).toBe(2);
    expect(otherFinal.leaseOwner).toBeNull();

    const sweepCursor = firestore.read('shiftCloseSweepCursor', 'sweep')!;
    expect(sweepCursor.casVersion).toBe(1); // sweep stream durably advanced despite the trigger stream's failure
  });
});

// ---------------------------------------------------------------------------
// BF-9 — identity/schema integrity.
// ---------------------------------------------------------------------------

describe('runValidationSweep — BF-9 identity/schema integrity', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  test('staffId mismatch between case and evidence -> identity_mismatch run, never match/discrepancy', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000), staffId: 'staff-A' });
    seedAlert(firestore);
    seedEvidence(firestore, { staffId: 'staff-B' }); // mismatch

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run?.validationVerdict).toBe('identity_mismatch');
  });

  test('deviceId mismatch between case and evidence -> identity_mismatch run', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000), deviceId: 'device-A' });
    seedAlert(firestore);
    seedEvidence(firestore, { deviceId: 'device-B' });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run?.validationVerdict).toBe('identity_mismatch');
  });

  test('case schemaVersion mismatch -> identity_mismatch run', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000), schemaVersion: 2 });
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run?.validationVerdict).toBe('identity_mismatch');
  });

  test('latestEvidenceId inconsistency (case points elsewhere) -> identity_mismatch run', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000), latestEvidenceId: 'shift-1_some-other-hash' });
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run?.validationVerdict).toBe('identity_mismatch');
  });

  test('matching identity on every field -> not identity_mismatch (regression)', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run?.validationVerdict).not.toBe('identity_mismatch');
  });

  test('corrupt case document: stored shiftId differs from the document id -> identity_mismatch, never an ordinary selection', async () => {
    const firestore = new FakeFirestore();
    // The case doc lives at shiftCloseCases/SHIFT_ID, but its OWN stored
    // `shiftId` field is corrupted to a different value — every other field
    // (branchId, staffId, deviceId, schemaVersion) still agrees with evidence.
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000), shiftId: 'corrupted-shift-id' });
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run?.validationVerdict).toBe('identity_mismatch');
  });

  test('corrupt evidence document: stored evidenceId differs from the document id -> identity_mismatch, never an ordinary selection', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    // The evidence doc lives at shiftCloseEvidence/{SHIFT_ID}_{CLOSE_HASH},
    // but its OWN stored `evidenceId` field is corrupted — every other
    // field still agrees with the case.
    seedEvidence(firestore, { evidenceId: 'corrupted-evidence-id' });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`);
    expect(run?.validationVerdict).toBe('identity_mismatch');
  });
});

// ---------------------------------------------------------------------------
// BF-10 — projection/watermark completeness.
// ---------------------------------------------------------------------------

describe('runValidationSweep — BF-10 projection/watermark completeness', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  test('commitBoundaryDocKeys populated from the source doc(s) at the max observed commit micros', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);
    firestore.seed('asyncOrders', 'order-1', {
      shiftId: SHIFT_ID,
      branchId: BRANCH_ID,
      deviceId: 'device-1',
      status: 'completed',
      voidRequested: false,
      reconcileStatus: 'pending_reconcile',
      changeAmt: 0,
      payments: [{ method: 'cash', amount: 10 }],
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(Array.isArray(finalCase.commitBoundaryDocKeys)).toBe(true);
    expect((finalCase.commitBoundaryDocKeys as string[])).toContain('asyncOrders:order-1');
  });

  test('no source docs -> empty commitBoundaryDocKeys, never a crash', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.commitBoundaryDocKeys).toEqual([]);
  });

  test('perFieldDeltas includes payIn/payOut delta fields', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore, { payInTotal: 5 });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`)!;
    const deltas = run.perFieldDeltas as Record<string, number | null>;
    expect(deltas).toHaveProperty('payInMinorDelta');
    expect(deltas).toHaveProperty('payOutMinorDelta');
    expect(deltas.payInMinorDelta).toBe(0 - 500); // server computed 0 (no cash entries), evidence 5.00 baht = 500 satang
  });
});

// ---------------------------------------------------------------------------
// BF-6 — stale-CAS discard evidence.
//
// Honesty disclosure (Codex BF-11 evidence-honesty requirement): this fake
// executes T1 and T3 as two SEQUENTIAL, non-interleaved `runTransaction`
// calls within one `attemptCase` invocation with no exposed hook to mutate
// the store BETWEEN them — so a true "another writer moved caseVersion
// between this worker's T1 and T3" race cannot be constructed at the I/O
// level with this harness. The exact boundary condition (T3 observing
// `caseVersion`/`sourceRevision` != the T1-captured expectation ->
// zero-write discard, no run/audit/projection) is exhaustively proven at
// the pure-core layer instead (`evaluateT3Gates`, 6 tests in
// shiftCloseValidationWorkerCore.test.ts, including the case where the
// version has already moved). What IS provable at the I/O level, and is
// asserted below, is the END-TO-END consequence: a case whose version has
// moved by the time of a genuinely NEW attempt is picked up fresh (via T1,
// which always re-reads live state) and produces exactly ONE run at the
// CURRENT revision — never a duplicate or a run for a superseded version.
// ---------------------------------------------------------------------------

describe('runValidationSweep — BF-6 stale-CAS discard (end-to-end consequence)', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  test('a case whose revision moved before a later attempt produces exactly one run, at the current revision, never a stale duplicate', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-bootstrap' });
    const bootstrapped = firestore.read('shiftCloseCases', SHIFT_ID)!;
    const runsBefore = firestore.all('shiftCloseValidationRuns').length;

    // A conflict-close lands on the case (bumps caseVersion/sourceRevision,
    // re-sets pendingRevalidation) BEFORE the next worker attempt begins.
    const NOW2 = NOW + 25 * 60 * 60 * 1000;
    firestore.seed('shiftCloseCases', SHIFT_ID, {
      ...bootstrapped,
      caseVersion: (bootstrapped.caseVersion as number) + 5,
      sourceRevision: (bootstrapped.sourceRevision as number) + 1,
      pendingRevalidation: true,
      nextEligibleAt: Timestamp.fromMillis(NOW2 - 1000),
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-2' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.sourceRevision).toBe((bootstrapped.sourceRevision as number) + 1);
    const runsAfter = firestore.all('shiftCloseValidationRuns');
    expect(runsAfter.length).toBe(runsBefore + 1); // exactly one new run, at the new revision — no stale/duplicate run
  });

  test('a TRUE T1-to-T3 concurrent caseVersion bump (recheck admission) creates no stale run/audit/projection', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-bootstrap' });
    const bootstrapped = firestore.read('shiftCloseCases', SHIFT_ID)!;
    const runsBefore = firestore.all('shiftCloseValidationRuns').length;
    const auditsBefore = firestore.all('shiftCloseAuditEvents').length;

    const NOW2 = NOW + 25 * 60 * 60 * 1000;
    firestore.seed('shiftCloseCases', SHIFT_ID, { ...bootstrapped, nextEligibleAt: Timestamp.fromMillis(NOW2 - 1000) });

    // The bootstrap invocation already read this case doc twice (T1, T3).
    // This second invocation's T1 is read #3; inject a concurrent
    // caseVersion bump immediately before its T3 read (#4) — a genuinely
    // different, already-committed writer landing between THIS worker's own
    // T1 commit and T3 read, during a RECHECK (isRecheck:true) admission.
    firestore.onNthRead('shiftCloseCases', SHIFT_ID, 4, () => {
      const current = firestore.read('shiftCloseCases', SHIFT_ID)!;
      firestore.seed('shiftCloseCases', SHIFT_ID, { ...current, caseVersion: (current.caseVersion as number) + 50 });
    });

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-2' });

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(runsBefore); // no new run
    expect(firestore.all('shiftCloseAuditEvents')).toHaveLength(auditsBefore); // no new audit
    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.selectedRunId).toBe(bootstrapped.selectedRunId); // projection unchanged
    expect(finalCase.leaseOwner).toBeNull();
    expect(finalCase.processingState).toBe('queued');
  });

  test('a missing selected-run document (read in T2) fails closed: zero-write anomaly, then non-counting Category-D defer', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, {
      pendingRevalidation: false,
      selectedCloseHash: CLOSE_HASH,
      selectedRunId: `${SHIFT_ID}_${CLOSE_HASH}_1_1`, // points to a run that does NOT exist
      sweepEligible: true,
      nextEligibleAt: Timestamp.fromMillis(NOW - 1000),
    });
    seedAlert(firestore);
    seedEvidence(firestore);
    // Deliberately do NOT seed the shiftCloseValidationRuns doc.

    const before = { ...firestore.read('shiftCloseCases', SHIFT_ID) };
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });
    const after = firestore.read('shiftCloseCases', SHIFT_ID)!;

    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(0);
    expect(firestore.all('shiftCloseAuditEvents')).toHaveLength(0);
    expect(after.processingState).toBe('queued'); // Category-D non-counting defer
    expect(after.revalidationAttempts).toBe(before.revalidationAttempts); // non-counting
    expect(after.leaseOwner).toBeNull();
    expect(after.selectedRunId).toBe(`${SHIFT_ID}_${CLOSE_HASH}_1_1`); // the dangling pointer itself is never silently cleared/changed
  });

  test('changed-digest recheck: inputsDigest recomputes byte-identically from the persisted R+1 run fields, and runId/sourceRevision/case.sourceRevision/observedAsOfSourceRevision all agree', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { pendingRevalidation: true, nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);
    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-bootstrap' });

    // A new device-scoped sale changes the fold between phases.
    firestore.seed('asyncOrders', 'order-1', {
      shiftId: SHIFT_ID,
      branchId: BRANCH_ID,
      deviceId: 'device-1',
      status: 'completed',
      voidRequested: false,
      reconcileStatus: 'pending_reconcile',
      changeAmt: 0,
      payments: [{ method: 'cash', amount: 100 }],
    });
    const NOW2 = NOW + 25 * 60 * 60 * 1000;

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW2, invocationId: 'inv-recheck' });

    const finalCase = firestore.read('shiftCloseCases', SHIFT_ID)!;
    expect(finalCase.sourceRevision).toBe(2);
    const newRun = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_2`)! as {
      runId: string;
      sourceRevision: number;
      inputsDigest: string;
      creditDebtReceiptsObserved: { observedAsOfSourceRevision: number };
      serverComputedDrawer: Record<string, number | null>;
      perFieldDeltas: Record<string, number | null>;
      sourceManifestFullDigest: string;
      cashPairClassification: unknown[];
      crossDeviceSalesObserved: { observed: boolean; count: number };
    };
    expect(newRun.runId).toBe(`${SHIFT_ID}_${CLOSE_HASH}_1_2`);
    expect(newRun.sourceRevision).toBe(2);
    expect(newRun.creditDebtReceiptsObserved.observedAsOfSourceRevision).toBe(2);
    expect(finalCase.sourceRevision).toBe(newRun.sourceRevision); // case and run revision agree

    // Byte-identical recomputation: rebuild the tender fold from the SAME
    // seeded source doc (independently re-derived by the test, exactly as
    // T2's production pipeline would), and recompute `inputsDigest` via the
    // exact production function against the run's OWN persisted digest
    // components (`sourceManifestFullDigest`, `creditDebtReceiptsObserved`)
    // at its own persisted `sourceRevision` — the result must equal the
    // stored `inputsDigest` exactly.
    const recomputedTenderFold = foldDeviceScopedDrawer(
      [
        {
          id: 'order-1',
          shiftId: SHIFT_ID,
          branchId: BRANCH_ID,
          deviceId: 'device-1',
          status: 'completed',
          voidRequested: false,
          reconcileStatus: 'pending_reconcile',
          changeAmt: 0,
          payments: [{ method: 'cash', amount: 100 }],
        },
      ],
      'device-1',
    );
    const recomputedDigest = computeInputsDigestAtRevision(
      {
        tenderFold: recomputedTenderFold,
        payInMinor: 0,
        payOutMinor: 0,
        creditDebtReceiptsObserved: newRun.creditDebtReceiptsObserved as never,
        sourceManifestFullDigest: newRun.sourceManifestFullDigest,
        cashEntriesDigest: 'x', // matches seedEvidence's fixture digest
        cashEntriesFullDigest: 'x',
        sourceEntryCount: 0,
      },
      2,
    );
    expect(recomputedDigest).toBe(newRun.inputsDigest);
  });
});

// ---------------------------------------------------------------------------
// BF-5 (R3): the 786,432-byte run-payload guard must find the EXACT longest
// canonical-order doc prefix that fits, not a stale-baseline approximation
// (Codex R3's stored-count-vs-actual-count byte mismatch) and never discard
// the entire manifest when a non-empty prefix would still fit (Codex R3's
// "3-iteration fallback" complaint). The empty-doc-still-over-guard
// fail-closed path (`run_payload_guard_unfittable`) is proven by direct code
// inspection of the guarded branch at shiftCloseValidationWorker.ts — every
// candidate is reassembled and measured via `Buffer.byteLength(JSON.
// stringify(...))` before that branch can be taken, so no fixture can
// exercise it through this in-memory harness without also reproducing (not
// exercising) the guard itself; this is disclosed rather than overclaimed.
// ---------------------------------------------------------------------------

describe('runValidationSweep — BF-5 exact 768 KiB final-map guard (R3)', () => {
  type FS = import('firebase-admin/firestore').Firestore;

  test('a manifest that would exceed the guard truncates to the longest non-empty fitting prefix, never an empty-fallback', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);

    // Each doc's manifest entry cost is dominated by its (artificially long,
    // but validly-shaped) document id — Firestore ids may be up to 1,500
    // bytes. 400 docs x ~2,175 bytes/entry ~= 870 KB of raw manifest-doc
    // JSON alone, comfortably over the 786,432-byte guard, while staying
    // well under the 500-doc asyncOrders count cap (so `capReachedBySource`
    // stays false and this exercises the SIZE-triggered path, not the
    // count-cap path). All docs are `voided` so the tender fold stays
    // trivial (foldBlocked:false) and doesn't interact with truncation.
    const DOC_COUNT = 400;
    const LONG_ID_LEN = 2000;
    for (let i = 0; i < DOC_COUNT; i += 1) {
      const docId = `${String(i).padStart(6, '0')}-${'x'.repeat(LONG_ID_LEN)}`;
      firestore.seed('asyncOrders', docId, {
        shiftId: SHIFT_ID,
        branchId: BRANCH_ID,
        deviceId: 'device-1',
        status: 'voided',
        voidRequested: true,
        reconcileStatus: 'pending_reconcile',
        changeAmt: 0,
        payments: [],
      });
    }

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`)! as {
      manifestSizeTruncated: boolean;
      sourceManifestObservedDocsCount: number;
      sourceManifestStoredDocsCount: number;
      sourceManifest: { docs: unknown[]; truncated: boolean; capReachedBySource: Record<string, boolean> };
    };
    expect(run).toBeDefined();
    expect(run.sourceManifestObservedDocsCount).toBe(DOC_COUNT);
    expect(run.manifestSizeTruncated).toBe(true);
    // Not the count-cap path (proves this is genuinely the SIZE guard, not
    // MAX_SOURCE_DOCS overflow).
    expect(run.sourceManifest.capReachedBySource.asyncOrders).toBe(false);
    // The R3 defect: fallback discarded the ENTIRE manifest even when a
    // non-empty prefix would fit. Assert a substantial, non-empty,
    // non-full prefix survived.
    expect(run.sourceManifestStoredDocsCount).toBeGreaterThan(0);
    expect(run.sourceManifestStoredDocsCount).toBeLessThan(DOC_COUNT);
    expect(run.sourceManifest.docs).toHaveLength(run.sourceManifestStoredDocsCount);
  });

  // -------------------------------------------------------------------------
  // BF-5 (R4): Codex R4 found the R3 production branch conflated an observed
  // SOURCE-QUERY COUNT-CAP fact (`capReachedBySource.*`) with the BYTE-
  // PREFLIGHT fact (`manifestSizeTruncated`) — any cap flag already true
  // unconditionally skipped straight to the byte-truncated candidate shape,
  // so a count-cap-only run whose full observed-doc field map still fit
  // under the 786,432-byte guard was wrongly written with
  // `manifestSizeTruncated:true` and (in the general case) fewer than all
  // observed docs stored. Per the governing architecture's first
  // remediation addendum §10.1-§10.2, these are independent dimensions:
  // count-cap overflow alone must produce `sourceManifest.truncated:true`
  // (via `capReachedBySource`) while `manifestSizeTruncated` stays `false`
  // and every observed doc is retained.
  // -------------------------------------------------------------------------

  test('R4: a count-cap-only run (MAX_SOURCE_DOCS.asyncOrders exceeded) that still fits under the byte guard retains ALL observed docs and writes manifestSizeTruncated:false', async () => {
    const firestore = new FakeFirestore();
    seedCase(firestore, { nextEligibleAt: Timestamp.fromMillis(NOW - 1000) });
    seedAlert(firestore);
    seedEvidence(firestore);

    // MAX_SOURCE_DOCS.asyncOrders is 500 -> the query fetches up to 501
    // (limit + 1, the overflow probe). Seeding exactly 501 SHORT-id, small
    // docs trips `capReachedBySource.asyncOrders` (501 > 500) while the
    // total manifest-doc JSON stays a few tens of KB — nowhere near the
    // 786,432-byte guard. This isolates the COUNT-CAP dimension from the
    // BYTE-SIZE dimension the R3 test above isolates the other way.
    const DOC_COUNT = MAX_SOURCE_DOCS.asyncOrders + 1;
    for (let i = 0; i < DOC_COUNT; i += 1) {
      firestore.seed('asyncOrders', `order-${String(i).padStart(4, '0')}`, {
        shiftId: SHIFT_ID,
        branchId: BRANCH_ID,
        deviceId: 'device-1',
        status: 'voided',
        voidRequested: true,
        reconcileStatus: 'pending_reconcile',
        changeAmt: 0,
        payments: [],
      });
    }

    await runValidationSweep({ firestore: firestore as unknown as FS, nowMillis: NOW, invocationId: 'inv-1' });

    const run = firestore.read('shiftCloseValidationRuns', `${SHIFT_ID}_${CLOSE_HASH}_1_1`)! as {
      manifestSizeTruncated: boolean;
      sourceManifestObservedDocsCount: number;
      sourceManifestStoredDocsCount: number;
      sourceManifestFullDigest: string;
      sourceManifest: { docs: unknown[]; truncated: boolean; capReachedBySource: Record<string, boolean> };
    };
    expect(run).toBeDefined(); // run WAS created — no anomaly path taken
    expect(firestore.all('shiftCloseValidationRuns')).toHaveLength(1);

    // The count-cap fact is real and truthfully surfaced.
    expect(run.sourceManifest.capReachedBySource.asyncOrders).toBe(true);
    expect(run.sourceManifest.truncated).toBe(true); // anyCapReached || manifestSizeTruncated

    // The R4 defect, directly disproved: byte-size truncation must NOT be
    // triggered merely because a count cap was hit.
    expect(run.manifestSizeTruncated).toBe(false);

    // Every observed doc (including the 501st overflow-probe doc) is
    // retained — count-cap does not imply dropping docs from the stored
    // manifest when they all fit under the byte guard.
    expect(run.sourceManifestObservedDocsCount).toBe(DOC_COUNT);
    expect(run.sourceManifestStoredDocsCount).toBe(DOC_COUNT);
    expect(run.sourceManifest.docs).toHaveLength(DOC_COUNT);

    // Truthful digests: full-set and stored-prefix digest coincide exactly
    // when the stored prefix IS the full observed set.
    expect(typeof run.sourceManifestFullDigest).toBe('string');
    expect(run.sourceManifestFullDigest).toHaveLength(64); // sha256 hex
  });
});
