/**
 * Packet 023 — production server I/O of the deferred server-authoritative close
 * replay (`ReconcileShiftCloseIntentDeps.deferredReplay`, see
 * `replayDeferredAuthoritativeClose`): the server-only shift read, the bounded
 * flush of this device's queued writes, and the live session's staff claim.
 *
 * No credential is stored, minted or borrowed: the replay is sent only when
 * the CURRENT session is the shift owner's; any other session means "not now".
 * Every member delegates lazily (nothing is touched until a deferred entry is
 * actually replayed).
 */
import type { DeferredCloseReplayIo } from './offline/shiftCloseReconciler';
import { readAuthoritativeShift, waitForQueuedWritesFlushed } from './shiftService';

/** The `staffId` claim of the CURRENT Firebase session (the identity the callable sees). Never throws. */
async function readSessionStaffId(): Promise<string | null> {
  try {
    const [{ getIdTokenResult }, { auth }] = await Promise.all([import('firebase/auth'), import('../firebase')]);
    const user = auth?.currentUser;
    if (!user) return null;
    const staffId = (await getIdTokenResult(user)).claims?.staffId;
    return typeof staffId === 'string' && staffId.length > 0 ? staffId : null;
  } catch {
    return null;
  }
}

export const deferredCloseReplayIo: DeferredCloseReplayIo = {
  readServerShift: (shiftId) => readAuthoritativeShift(shiftId),
  waitForQueuedWrites: () => waitForQueuedWritesFlushed(),
  sessionStaffId: readSessionStaffId,
};
