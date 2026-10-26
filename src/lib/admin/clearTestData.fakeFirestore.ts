/**
 * Test-only in-memory stand-in for the `firebase/firestore` surface that
 * {@link ./clearTestData} uses (collection / collectionGroup / query / limit /
 * getDocs / writeBatch / serverTimestamp). Shared by the Danger Zone reset
 * safety specs (018) so they can count every read and committed write. 019 adds
 * `doc` and `batch.set` (merge upsert) so the retired Seed Zone can be exercised
 * against the pre-019 implementation too.
 *
 * It mirrors the two Rules facts the reset safety depends on:
 *   - a batch deleting `cashTransactions/rfd_*` is denied ATOMICALLY (017 seal),
 *     after any earlier batches have already committed;
 *   - server-only collections are unreadable to every client (catch-all deny).
 */

type DocData = Record<string, unknown>;

export type FakeOp =
  | { kind: 'read'; target: string }
  | { kind: 'auth' }
  | { kind: 'commit'; deletes: string[]; updates: string[]; sets: string[] };

type DocRef = { kind: 'doc'; path: string; id: string };
type CollectionRef = { kind: 'collection'; path: string };
type GroupRef = { kind: 'group'; id: string };
type QueryRef = (CollectionRef | GroupRef) & { max?: number };

/** Server-only collections a client can never read (firestore.rules catch-all deny). */
export const CLIENT_UNREADABLE = new Set([
  'shiftCloseAuthorityRecords',
  'saleRefunds',
  'saleReturnLedgers',
  'saleReturnAuditEvents',
  'saleReturnAttemptResolutions',
]);

function firestoreError(code: string): Error {
  return Object.assign(new Error(`[fake] ${code}`), { code, name: 'FirebaseError' });
}

export const fakeDb = {
  docs: new Map<string, DocData>(),
  ops: [] as FakeOp[],
  configured: true,
  /** When set, every getDocs rejects with this code (offline / denied preflight). */
  readFailure: null as string | null,

  reset(): void {
    this.docs.clear();
    this.ops = [];
    this.configured = true;
    this.readFailure = null;
  },

  seed(path: string, data: DocData = {}): void {
    this.docs.set(path, { ...data });
  },

  has(path: string): boolean {
    return this.docs.has(path);
  },

  /** Doc paths whose parent collection path is exactly `collectionPath`. */
  idsIn(collectionPath: string): string[] {
    return [...this.docs.keys()]
      .filter((p) => p.slice(0, p.lastIndexOf('/')) === collectionPath)
      .map((p) => p.slice(p.lastIndexOf('/') + 1));
  },

  get reads(): number {
    return this.ops.filter((op) => op.kind === 'read').length;
  },

  get committedWrites(): number {
    return this.ops.reduce(
      (n, op) =>
        op.kind === 'commit' ? n + op.deletes.length + op.updates.length + op.sets.length : n,
      0,
    );
  },
};

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export const fakeFirestoreModule = {
  collection(base: unknown, name: string): CollectionRef {
    const parent = (base as { kind?: string; path?: string })?.kind === 'doc'
      ? `${(base as DocRef).path}/`
      : '';
    return { kind: 'collection', path: `${parent}${name}` };
  },

  doc(_base: unknown, ...segments: string[]): DocRef {
    const path = segments.join('/');
    return { kind: 'doc', path, id: lastSegment(path) };
  },

  collectionGroup(_firestore: unknown, id: string): GroupRef {
    return { kind: 'group', id };
  },

  limit(max: number): { max: number } {
    return { max };
  },

  query(source: QueryRef, constraint?: { max: number }): QueryRef {
    return { ...source, max: constraint?.max };
  },

  serverTimestamp(): { serverTimestamp: true } {
    return { serverTimestamp: true };
  },

  async getDocs(q: QueryRef) {
    const target = q.kind === 'collection' ? q.path : `group:${q.id}`;
    fakeDb.ops.push({ kind: 'read', target });
    if (fakeDb.readFailure) throw firestoreError(fakeDb.readFailure);
    const collectionId = q.kind === 'collection' ? lastSegment(q.path) : q.id;
    if (CLIENT_UNREADABLE.has(collectionId)) throw firestoreError('permission-denied');

    const paths = [...fakeDb.docs.keys()].filter((p) =>
      q.kind === 'collection'
        ? parentOf(p) === q.path
        : lastSegment(parentOf(p)) === q.id,
    );
    const page = q.max === undefined ? paths : paths.slice(0, q.max);
    const docs = page.map((path) => ({
      id: lastSegment(path),
      ref: { kind: 'doc', path, id: lastSegment(path) } as DocRef,
      data: () => ({ ...(fakeDb.docs.get(path) ?? {}) }),
    }));
    return { empty: docs.length === 0, size: docs.length, docs };
  },

  writeBatch() {
    const deletes: string[] = [];
    const updates: Array<{ path: string; data: DocData }> = [];
    const sets: Array<{ path: string; data: DocData }> = [];
    return {
      set(ref: DocRef, data: DocData) {
        sets.push({ path: ref.path, data });
      },
      delete(ref: DocRef) {
        deletes.push(ref.path);
      },
      update(ref: DocRef, data: DocData) {
        updates.push({ path: ref.path, data });
      },
      async commit() {
        // 017 Rules: no client of any role may delete a server `rfd_` refund
        // record; the whole batch is rejected and nothing in it applies.
        if (deletes.some((p) => /^cashTransactions\/rfd_/s.test(p))) {
          throw firestoreError('permission-denied');
        }
        for (const p of deletes) fakeDb.docs.delete(p);
        for (const u of updates) {
          fakeDb.docs.set(u.path, { ...(fakeDb.docs.get(u.path) ?? {}), ...u.data });
        }
        for (const u of sets) {
          fakeDb.docs.set(u.path, { ...(fakeDb.docs.get(u.path) ?? {}), ...u.data });
        }
        fakeDb.ops.push({
          kind: 'commit',
          deletes: [...deletes],
          updates: updates.map((u) => u.path),
          sets: sets.map((u) => u.path),
        });
      },
    };
  },
};

export const fakeFirebaseModule = {
  db: {},
  get isFirebaseConfigured(): boolean {
    return fakeDb.configured;
  },
  collections: new Proxy({} as Record<string, string>, {
    get: (_target, key) => String(key),
  }),
};

export const fakeFirebaseAuthModule = {
  async ensureFirebaseAuth(): Promise<void> {
    fakeDb.ops.push({ kind: 'auth' });
  },
};
