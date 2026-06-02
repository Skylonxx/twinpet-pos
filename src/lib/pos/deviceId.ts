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
 * Storage: `localStorage` (synchronous, available before first paint).
 * ⚠️ Hardening follow-up (tracked, not in this step): mirror `id` and `seq` into
 * IndexedDB so a PWA cache-clear can't wipe the identity / reuse a sequence.
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
}

export function getDeviceIdentity(): DeviceIdentity {
  return { id: getDeviceId(), label: getDeviceLabel() };
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
  return next;
}

/** Inspect the current sequence without consuming it (diagnostics/UI). */
export function peekLocalSeq(): number {
  if (!hasLocalStorage()) return 0;
  const current = Number.parseInt(localStorage.getItem(DEVICE_SEQ_KEY) ?? '0', 10);
  return Number.isFinite(current) ? current : 0;
}

/**
 * Deterministic, idempotent order id = `${deviceId}-${seq}`. Used as both the
 * Firestore doc id and the reconciler idempotency key: a client retry re-writes
 * the SAME doc instead of creating a duplicate sale.
 */
export function makeAsyncOrderId(deviceId: string, seq: number): string {
  return `${deviceId}-${seq}`;
}
