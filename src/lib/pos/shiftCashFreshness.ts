/**
 * Shift-close cash freshness (Return/Refund V1 blocker fix D-RET-FIX-8).
 *
 * Under the drawer single-writer model the terminal folds `cashEntries[]`
 * held in its mounted shift state. A server-side cash mutation — a cash
 * Return posts a `pay_out` entry onto `shifts/{id}.cashEntries` inside the
 * Return transaction — is invisible to an already-mounted POS until it
 * re-reads the shift. Closing from that stale state would freeze a wrong
 * `payOutTotal` / expected cash / variance.
 *
 * Correctness boundary (final gate): an ONLINE close reads the authoritative
 * shift INSIDE the close transaction (`closeShift` in shiftService.ts) and
 * unions its `cashEntries` (by entry id, {@link mergeCashEntries}) with the
 * local ones — local entries may still be queued/unflushed, the server may
 * hold entries this device never saw — so a Return committing between that
 * read and the commit forces a re-read. Offline closes keep the existing
 * cache-only behavior, except that a device holding a cash Return guard for
 * the shift (marker below) must not close offline. `readServerShiftCash` is
 * the display-only read used by the close modal.
 */

import { doc, getDocFromServer } from 'firebase/firestore';
import { collections, db } from '../firebase';
import type { Shift, ShiftCashEntry } from '../types';
import { foldCashEntries } from './shiftLedger';

export const SERVER_SHIFT_CASH_READ_TIMEOUT_MS = 6_000;

export type ServerShiftCashRead =
  | { ok: true; exists: boolean; status: string | undefined; cashEntries: ShiftCashEntry[] }
  | { ok: false };

export type ServerShiftCashReader = (shiftId: string) => Promise<ServerShiftCashRead>;

/** Confirmation-grade (server, never cache) read of a shift's cash entries. Never throws. */
export const readServerShiftCash: ServerShiftCashReader = async (shiftId) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const firestore = db;
    if (!firestore) return { ok: false };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('server_shift_read_timeout')), SERVER_SHIFT_CASH_READ_TIMEOUT_MS);
    });
    const snap = await Promise.race([getDocFromServer(doc(firestore, collections.shifts, shiftId)), timeout]);
    if (!snap.exists()) return { ok: true, exists: false, status: undefined, cashEntries: [] };
    const data = snap.data() as Record<string, unknown>;
    return {
      ok: true,
      exists: true,
      status: typeof data.status === 'string' ? data.status : undefined,
      cashEntries: Array.isArray(data.cashEntries) ? (data.cashEntries as ShiftCashEntry[]) : [],
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
};

function entryKey(e: ShiftCashEntry): string {
  return typeof e?.id === 'string' && e.id.length > 0 ? `id:${e.id}` : `raw:${JSON.stringify(e)}`;
}

/** Union of cash entries by id, first occurrence wins, order preserved. */
export function mergeCashEntries(...lists: ReadonlyArray<readonly ShiftCashEntry[] | null | undefined>): ShiftCashEntry[] {
  const seen = new Set<string>();
  const out: ShiftCashEntry[] = [];
  for (const list of lists) {
    for (const e of list ?? []) {
      if (e == null || typeof e !== 'object') continue;
      const k = entryKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

/** The shift with its cash movements re-folded from the merged entries. */
export function withMergedCashEntries(shift: Shift, ...others: ReadonlyArray<readonly ShiftCashEntry[] | null | undefined>): Shift {
  const cashEntries = mergeCashEntries(shift.cashEntries ?? [], ...others);
  return { ...shift, cashEntries, ...foldCashEntries(cashEntries) };
}

export function isNavigatorOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// ── "possible server cash mutation not yet observed" marker ──
//
// Final-gate fix §3. One localStorage key PER cash Return attempt:
//   twinpet.shift.serverCashPending.v2:<shiftId>:<attemptId>
// A key per attempt (never a shared read-modify-write record) means two tabs,
// or a clear racing another attempt's send, can never drop each other's guard.
//
// Lifecycle (driven by SaleReturnModal / saleReturnService):
//   in_flight          written BEFORE a cash Return is sent; if it cannot be
//                      written the Return is NOT sent.
//   committed_unsynced the attempt is known committed; kept until a server
//                      read of the shift succeeds (the cache then holds the
//                      pay-out).
//   (removed)          definitive not-committed outcome of THAT attempt, or
//                      the server-read sync after its commit, or a committed
//                      online close of the shift (whose transaction folded
//                      every committed Return; a later one cannot commit onto
//                      a closed shift).
// While ANY key for the shift exists — or the store cannot be read at all
// (recovery gate C1) — an OFFLINE close on this device fails closed. Online
// closes never depend on it: their transaction reads the authoritative shift.
// The value carries no secret (no PIN/token/OAC).

export const SERVER_CASH_PENDING_KEY_PREFIX = 'twinpet.shift.serverCashPending.v2:';

export type CashAttemptMarkerState = 'in_flight' | 'committed_unsynced';

/**
 * The guard store, or `null` when it is unavailable: no `window`, a throwing
 * `window.localStorage` getter (policy / SecurityError), a null handle, or a
 * handle without the Storage methods. Callers treat `null` as UNVERIFIABLE —
 * never as "no guard".
 */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage as Storage | null | undefined;
    if (
      s == null ||
      typeof s.getItem !== 'function' ||
      typeof s.setItem !== 'function' ||
      typeof s.removeItem !== 'function' ||
      typeof s.key !== 'function'
    ) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function attemptKey(shiftId: string, attemptId: string): string {
  return `${SERVER_CASH_PENDING_KEY_PREFIX}${shiftId}:${attemptId}`;
}

/** Durably mark one cash Return attempt for a shift. `false` = not persisted (caller must NOT send). */
export function markCashReturnAttemptPending(
  shiftId: string,
  attemptId: string,
  state: CashAttemptMarkerState = 'in_flight',
): boolean {
  if (!shiftId || !attemptId) return false;
  const s = storage();
  if (!s) return false;
  const key = attemptKey(shiftId, attemptId);
  const value = JSON.stringify({ schemaVersion: 2, shiftId, attemptId, state, recordedAtMs: Date.now() });
  try {
    s.setItem(key, value);
    return s.getItem(key) === value;
  } catch {
    return false;
  }
}

/** Remove ONE attempt's guard (other attempts for the shift keep theirs). */
export function clearCashReturnAttemptPending(shiftId: string, attemptId: string): void {
  try {
    storage()?.removeItem(attemptKey(shiftId, attemptId));
  } catch {
    /* best-effort: a stale guard only forces an online close */
  }
}

function shiftKeys(s: Storage, shiftId: string): string[] {
  const prefix = `${SERVER_CASH_PENDING_KEY_PREFIX}${shiftId}:`;
  const keys: string[] = [];
  const length = s.length;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
    throw new Error('guard store length unreadable');
  }
  for (let i = 0; i < length; i += 1) {
    const k = s.key(i);
    if (k != null && k.startsWith(prefix)) keys.push(k);
  }
  return keys;
}

/** Remove every guard of a shift — only after a COMMITTED online close of it. */
export function clearShiftServerCashPending(shiftId: string): void {
  try {
    const s = storage();
    if (!s) return;
    for (const k of shiftKeys(s, shiftId)) s.removeItem(k);
  } catch {
    /* best-effort */
  }
}

/**
 * `none`         the store was READ and holds no guard for the shift.
 * `pending`      at least one guard (value irrelevant — a corrupt value still guards).
 * `unverifiable` the store could not be read (see {@link storage}) or threw
 *                while enumerated: a guard persisted earlier may exist, so an
 *                offline close must fail CLOSED (recovery gate C1). Only a
 *                readable store ever yields `none`.
 */
export type ShiftServerCashPendingState = 'none' | 'pending' | 'unverifiable';

export function readShiftServerCashPending(shiftId: string): ShiftServerCashPendingState {
  try {
    const s = storage();
    if (!s) return 'unverifiable';
    return shiftKeys(s, shiftId).length > 0 ? 'pending' : 'none';
  } catch {
    return 'unverifiable';
  }
}

/** `true` unless the store was read and holds no guard for the shift. */
export function hasShiftServerCashPending(shiftId: string): boolean {
  return readShiftServerCashPending(shiftId) !== 'none';
}
