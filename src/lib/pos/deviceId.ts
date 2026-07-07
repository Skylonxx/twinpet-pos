/**
 * Hybrid Device / Terminal identity for offline-first checkout.
 *
 * Each physical POS terminal owns a **stable, auto-generated short id** (created
 * once, on first launch, and persisted locally) plus a **renameable label** an
 * admin can set later (e.g. "iPad-01"). The id guarantees collision-free receipt
 * numbering across terminals with NO server coordination — the offline bill
 * number is `[PREFIX]-[YYMMDD]-[DEVICE_ID]-[LOCAL_SEQ]`, and the per-device
 * `LOCAL_SEQ` is a durable monotonic counter owned here.
 *
 * Storage: `localStorage` is the synchronous source of truth (available before
 * first paint, used on the hot checkout path). It is MIRRORED to IndexedDB so a
 * PWA cache-clear that wipes localStorage can't lose the identity / reuse a
 * sequence — `initDeviceIdentity()` recovers id + seq + label from IndexedDB at
 * boot (await it before render). A total wipe of BOTH stores is handled by the
 * "Claim Device" recovery flow in the POS Devices settings screen.
 */

const DEVICE_ID_KEY = 'twinpet_device_id';
const DEVICE_LABEL_KEY = 'twinpet_device_label';
const DEVICE_SEQ_KEY = 'twinpet_device_seq';

/** Crockford base32 (no I, L, O, U — unambiguous on printed receipts). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type DeviceIdentity = {
  /** Stable machine id, e.g. "7F3A9KMQ". Never changes once generated. */
  id: string;
  /** Human-friendly name; defaults to `id` until an admin renames it. */
  label: string;
};

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

// ── IndexedDB mirror (standard API, no new dependency) ──────────────────────
const IDB_DB_NAME = 'twinpet-device';
const IDB_STORE = 'kv';
const IDB_KEYS = { id: 'deviceId', seq: 'deviceSeq', label: 'deviceLabel' } as const;

function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(IDB_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Fire-and-forget write to the IndexedDB mirror. */
async function idbSet(key: string, value: string | number): Promise<void> {
  const dbi = await idbOpen();
  if (!dbi) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = dbi.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  dbi.close();
}

async function idbGet(key: string): Promise<string | number | undefined> {
  const dbi = await idbOpen();
  if (!dbi) return undefined;
  const result = await new Promise<string | number | undefined>((resolve) => {
    try {
      const tx = dbi.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as string | number | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  dbi.close();
  return result;
}

/** 40 random bits → 8 unambiguous base32 chars. Falls back to Math.random only if needed. */
function generateShortId(): string {
  const bytes = new Uint8Array(5);
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/**
 * Returns this terminal's stable device id, generating + persisting one on first
 * call. Idempotent: every subsequent call returns the same id for this browser.
 */
export function getDeviceId(): string {
  if (!hasLocalStorage()) return generateShortId(); // ephemeral (SSR/tests)
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateShortId();
    localStorage.setItem(DEVICE_ID_KEY, id);
    void idbSet(IDB_KEYS.id, id);
  }
  return id;
}

/** Human label for this terminal; defaults to the device id until renamed. */
export function getDeviceLabel(): string {
  if (!hasLocalStorage()) return getDeviceId();
  return localStorage.getItem(DEVICE_LABEL_KEY)?.trim() || getDeviceId();
}

/** Admin override — rename the terminal (e.g. "iPad-01"). Identity id is unchanged. */
export function setDeviceLabel(label: string): void {
  if (!hasLocalStorage()) return;
  const clean = label.trim();
  if (clean) localStorage.setItem(DEVICE_LABEL_KEY, clean);
  else localStorage.removeItem(DEVICE_LABEL_KEY);
  void idbSet(IDB_KEYS.label, clean);
}

export function getDeviceIdentity(): DeviceIdentity {
  return { id: getDeviceId(), label: getDeviceLabel() };
}

/** The admin-assigned label, or null if this device still uses its default id. */
export function getDeviceLabelRaw(): string | null {
  if (!hasLocalStorage()) return null;
  const v = localStorage.getItem(DEVICE_LABEL_KEY)?.trim();
  return v ? v : null;
}

/**
 * Receipt device segment: a sanitized admin label (e.g. "iPad-01" → "IPAD01")
 * when assigned, else the raw device id. Uppercased, unambiguous, hyphen-free so
 * it slots into `PREFIX-YYMMDD-SEGMENT-SEQ`. The underlying order id always uses
 * the raw device id for guaranteed uniqueness; admins should keep labels unique
 * per branch so the human receipt number stays unique too.
 */
export function getReceiptDeviceSegment(): string {
  const label = getDeviceLabelRaw();
  if (label) {
    const slug = label.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (slug) return slug;
  }
  return getDeviceId();
}

/**
 * Atomically (single-threaded JS) consume the next per-device sequence number.
 * Monotonic and never reset, so a bill number can never repeat on this device —
 * the keystone of collision-free offline numbering. Returns 1 on first use.
 */
export function nextLocalSeq(): number {
  if (!hasLocalStorage()) return Date.now(); // ephemeral fallback (still unique-ish)
  const current = Number.parseInt(localStorage.getItem(DEVICE_SEQ_KEY) ?? '0', 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  localStorage.setItem(DEVICE_SEQ_KEY, String(next));
  void idbSet(IDB_KEYS.seq, next);
  return next;
}

/** Inspect the current sequence without consuming it (diagnostics/UI). */
export function peekLocalSeq(): number {
  if (!hasLocalStorage()) return 0;
  const current = Number.parseInt(localStorage.getItem(DEVICE_SEQ_KEY) ?? '0', 10);
  return Number.isFinite(current) ? current : 0;
}

// ── Atomic cross-tab sequence allocator (Packet 3B-2, UNWIRED) ──────────────
//
// `nextLocalSeq()` above is a synchronous localStorage read→parse→+1→write: two
// same-origin tabs can both read seq N and both write N+1, minting a DUPLICATE
// per-device sequence — and therefore a duplicate receipt number AND a colliding
// asyncOrder id / reconciler idempotency key (one of the two sales is then lost or
// misattributed server-side). `allocateLocalSeq()` closes that race by performing
// the read+increment+write inside ONE IndexedDB `readwrite` transaction on the
// `deviceSeq` key: the IndexedDB spec serializes overlapping readwrite
// transactions across every connection to a database, so two tabs can never
// observe the same base value. localStorage is kept only as a write-through mirror
// (updated AFTER the IDB commit) so `peekLocalSeq()`, the Claim-Device flow, and
// the legacy fallback keep a synchronously-readable value.
//
// This primitive is UNWIRED in 3B-2 — production checkout still calls
// `nextLocalSeq()`. Caller-side preallocation is Packet 3B-3.

/** Bound a hung/blocked IndexedDB open so a degraded store can never stall checkout. */
const IDB_ALLOCATE_TIMEOUT_MS = 2000;

/**
 * Coerce a stored sequence (from IDB or localStorage) into a safe, non-negative
 * integer base. Missing / non-numeric / NaN / negative / non-finite → 0.
 */
function sanitizeSeqBase(value: unknown): number {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') n = Number.parseInt(value, 10);
  else return 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Allocate the next sequence inside a SINGLE IDB readwrite transaction, seeded by
 * `max(idbSeq, localStorageSeq, 0)` so historical mirror drift in either direction
 * is absorbed (this max() is also the migration rule). Resolves the allocated
 * number, or `null` on any bounded failure (no IndexedDB / open error / blocked /
 * never-settling open guarded by a timeout / transaction error or abort) so the
 * caller can fall back. Never throws, never hangs.
 */
function idbAllocateSeq(lsBase: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (v: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // Fail open if the open/transaction never settles (blocked, hung upgrade, …).
    const timer = setTimeout(() => finish(null), IDB_ALLOCATE_TIMEOUT_MS);

    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB_DB_NAME, 1);
    } catch {
      finish(null);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore(IDB_STORE);
      } catch {
        // store may already exist under a concurrent upgrade — ignore
      }
    };
    req.onblocked = () => finish(null);
    req.onerror = () => finish(null);
    req.onsuccess = () => {
      const dbi = req.result;
      let allocated: number | null = null;
      try {
        const tx = dbi.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const getReq = store.get(IDB_KEYS.seq);
        getReq.onsuccess = () => {
          const next = Math.max(sanitizeSeqBase(getReq.result), lsBase, 0) + 1;
          allocated = next;
          store.put(next, IDB_KEYS.seq); // commit inside the same readwrite txn
        };
        // A getReq.onerror surfaces as tx.onerror/onabort below → bounded fallback.
        tx.oncomplete = () => {
          try {
            dbi.close();
          } catch {
            /* noop */
          }
          finish(allocated);
        };
        tx.onerror = () => {
          try {
            dbi.close();
          } catch {
            /* noop */
          }
          finish(null);
        };
        tx.onabort = () => {
          try {
            dbi.close();
          } catch {
            /* noop */
          }
          finish(null);
        };
      } catch {
        try {
          dbi.close();
        } catch {
          /* noop */
        }
        finish(null);
      }
    };
  });
}

/**
 * Atomic, cross-tab-safe next per-device sequence. Uses a single IndexedDB
 * `readwrite` transaction as the correctness primitive; on any bounded IDB failure
 * it fails open to the legacy synchronous `nextLocalSeq()` so a sale is never
 * blocked (accepting today's degraded-mode duplicate risk rather than blocking the
 * customer). The localStorage mirror is updated ONLY after a successful IDB commit,
 * never before. UNWIRED in 3B-2 — checkout still uses `nextLocalSeq()`.
 */
export async function allocateLocalSeq(): Promise<number> {
  const lsBase = hasLocalStorage()
    ? sanitizeSeqBase(localStorage.getItem(DEVICE_SEQ_KEY))
    : 0;

  const allocated = await idbAllocateSeq(lsBase);
  if (allocated != null) {
    // Write-through mirror — AFTER the IDB commit, never before.
    if (hasLocalStorage()) localStorage.setItem(DEVICE_SEQ_KEY, String(allocated));
    return allocated;
  }

  // Bounded fail-open: legacy synchronous allocator. Never throws.
  return nextLocalSeq();
}

/**
 * Deterministic, idempotent order id = `${deviceId}-${seq}`. Used as both the
 * Firestore doc id and the reconciler idempotency key: a client retry re-writes
 * the SAME doc instead of creating a duplicate sale.
 */
export function makeAsyncOrderId(deviceId: string, seq: number): string {
  return `${deviceId}-${seq}`;
}

/**
 * Overwrite this terminal's identity + sequence — used by the "Claim Device"
 * recovery flow to adopt an orphaned device id after a total cache wipe. `seq`
 * should be set ABOVE the device's last known receipt so numbers never collide.
 * Mirrors to both localStorage and IndexedDB.
 */
export function setDeviceIdentity(id: string, seq: number): void {
  const safeSeq = Math.max(0, Math.floor(seq));
  if (hasLocalStorage()) {
    localStorage.setItem(DEVICE_ID_KEY, id);
    localStorage.setItem(DEVICE_SEQ_KEY, String(safeSeq));
  }
  void idbSet(IDB_KEYS.id, id);
  void idbSet(IDB_KEYS.seq, safeSeq);
}

/**
 * Boot recovery — call (and await) once at app start, before any getDeviceId() /
 * nextLocalSeq(). If localStorage is intact, refresh the IndexedDB mirror from it.
 * If localStorage was wiped but IndexedDB still holds the identity, restore id +
 * seq + label to localStorage so the device keeps its number space. If BOTH are
 * empty it's a genuinely new device (or one needing a manual Claim).
 */
export async function initDeviceIdentity(): Promise<void> {
  if (!hasLocalStorage()) return;

  const lsId = localStorage.getItem(DEVICE_ID_KEY);
  if (lsId) {
    void idbSet(IDB_KEYS.id, lsId);
    void idbSet(IDB_KEYS.seq, peekLocalSeq());
    const label = getDeviceLabelRaw();
    if (label) void idbSet(IDB_KEYS.label, label);
    return;
  }

  // localStorage wiped — recover from the IndexedDB mirror if present.
  const idbId = await idbGet(IDB_KEYS.id);
  if (typeof idbId === 'string' && idbId) {
    localStorage.setItem(DEVICE_ID_KEY, idbId);
    const idbSeq = await idbGet(IDB_KEYS.seq);
    if (typeof idbSeq === 'number') {
      localStorage.setItem(DEVICE_SEQ_KEY, String(Math.max(0, Math.floor(idbSeq))));
    }
    const idbLabel = await idbGet(IDB_KEYS.label);
    if (typeof idbLabel === 'string' && idbLabel) {
      localStorage.setItem(DEVICE_LABEL_KEY, idbLabel);
    }
  }
}
