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
 * Correctness boundary: immediately before an ONLINE close the authoritative
 * shift is read from the server and its `cashEntries` are unioned (by entry
 * id) with the local ones — local entries may still be queued/unflushed, the
 * server may hold entries this device never saw. If that read fails while
 * online the close fails closed (retryable). Offline closes keep the existing
 * cache-only behavior, except that a device which KNOWS a server cash
 * mutation for the shift is not yet in its cache (marker below) must not
 * close offline.
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

// ── "server cash mutation not yet observed" marker (per shift, per device) ──

const PENDING_KEY_PREFIX = 'twinpet.shift.serverCashPending.v1:';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function markShiftServerCashPending(shiftId: string): void {
  try {
    storage()?.setItem(PENDING_KEY_PREFIX + shiftId, String(Date.now()));
  } catch {
    /* best-effort: an online close still re-reads the server regardless */
  }
}

export function clearShiftServerCashPending(shiftId: string): void {
  try {
    storage()?.removeItem(PENDING_KEY_PREFIX + shiftId);
  } catch {
    /* best-effort */
  }
}

export function hasShiftServerCashPending(shiftId: string): boolean {
  try {
    return storage()?.getItem(PENDING_KEY_PREFIX + shiftId) != null;
  } catch {
    return false;
  }
}
