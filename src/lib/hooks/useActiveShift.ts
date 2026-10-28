import { useEffect, useState } from 'react';
import { ActiveShiftUnavailableError, getActiveShift } from '../pos/shiftService';
import type { Shift } from '../types';

/** Packet 023 — cashier copy while the active-shift lookup for the current branch/staff has not completed. */
export const ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE = 'กำลังตรวจสอบสถานะกะ กรุณารอสักครู่แล้วลองอีกครั้ง';

/** A settled lookup, tagged with the `(branchId, staffId)` it was made for. */
type Settled = { key: string; shift: Shift | null; unavailable: boolean };

const identityKey = (branchId: string, staffId: string) => JSON.stringify([branchId, staffId]);

/**
 * Packet 023 (pending-lookup race): the returned state is ALWAYS about the
 * CURRENT `(branchId, staffId)`. It is derived at render time from the settled
 * result's own identity key, so for the very render in which the identity
 * changes — before any effect runs — the previous identity's shift is not
 * exposed: `loading` is `true`, `activeShift` is `null`, `unavailable` is
 * `false` until a lookup for THIS identity settles. A late response (resolve or
 * reject) from a superseded lookup is dropped by the effect's per-run
 * `cancelled` flag (so A→B→A cannot be overwritten by the first A either).
 */
export function useActiveShift(branchId: string | null, staffId: string | null) {
  const [settled, setSettled] = useState<Settled | null>(null);
  const key = branchId && staffId ? identityKey(branchId, staffId) : null;

  useEffect(() => {
    if (!branchId || !staffId) return;

    const lookupKey = identityKey(branchId, staffId);
    let cancelled = false;

    void getActiveShift(branchId, staffId).then(
      (shift) => {
        if (!cancelled) setSettled({ key: lookupKey, shift, unavailable: false });
      },
      (err: unknown) => {
        if (!(err instanceof ActiveShiftUnavailableError)) throw err;
        // Packet 023: which shift is active could not be told (local close
        // journal unreadable) — NOT "no shift": shift-dependent work must not proceed.
        if (!cancelled) setSettled({ key: lookupKey, shift: null, unavailable: true });
      },
    );

    return () => {
      cancelled = true;
      // A→B→A (or A→none→A): a result settled for the first A must not read as "current" for the second A —
      // the next lookup starts pending. (Unmount: a no-op on an unmounted component.)
      setSettled(null);
    };
  }, [branchId, staffId]);

  if (key === null) return { activeShift: null, loading: false, unavailable: false };
  // A result for a different identity (or none yet) means the lookup for this one is still pending.
  if (settled === null || settled.key !== key) return { activeShift: null, loading: true, unavailable: false };
  return { activeShift: settled.shift, loading: false, unavailable: settled.unavailable };
}
