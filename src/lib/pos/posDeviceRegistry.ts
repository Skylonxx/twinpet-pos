import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import type { PosDeviceType } from '../types';
import {
  fastForwardLocalSeqTo,
  getDeviceId,
  peekLocalSeq,
  setDeviceIdentity,
  setDeviceLabel,
} from './deviceId';

/**
 * Registry sync for the hybrid Device ID. The device's identity + admin label
 * live in `localStorage` (instant, offline-safe), but we mirror them to the
 * `posDevices` collection (doc id = the device id) so a branch keeps a durable
 * record of its terminals and a device can reclaim its label after a cache wipe.
 */

const POS_DEVICES = 'posDevices';

function detectDeviceType(): PosDeviceType {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}

export type ThisDeviceRegistration = {
  id: string;
  /** Stored label/name, or '' when registered without a custom name. */
  name: string;
  branchId: string;
  registered: boolean;
};

/** Read THIS device's registration from Firestore, or null if Firebase is off/unavailable. */
export async function getThisDeviceRegistration(): Promise<ThisDeviceRegistration | null> {
  const id = getDeviceId();
  if (!isFirebaseConfigured || !db) return null;
  try {
    const snap = await getDoc(doc(db, POS_DEVICES, id));
    if (!snap.exists()) return { id, name: '', branchId: '', registered: false };
    const data = snap.data();
    return {
      id,
      name: typeof data.name === 'string' ? data.name : '',
      branchId: typeof data.branchId === 'string' ? data.branchId : '',
      registered: true,
    };
  } catch {
    return null;
  }
}

/**
 * Register / re-label THIS terminal in `posDevices` (merge-write; `createdAt` set
 * only on first registration). Keeps the branch's device list current and lets a
 * wiped device reclaim its label on reconnect.
 */
export async function registerThisDevice(
  branchId: string,
  label: string,
  userId: string | null = null,
): Promise<void> {
  if (!isFirebaseConfigured || !db || !branchId) return;
  const id = getDeviceId();
  const ref = doc(db, POS_DEVICES, id);
  const existing = await getDoc(ref).catch(() => null);

  const payload: Record<string, unknown> = {
    id,
    branchId,
    name: label.trim() || id,
    type: detectDeviceType(),
    token: id,
    isOnline: true,
    lastSeenAt: serverTimestamp(),
    currentUserId: userId,
  };
  if (!existing || !existing.exists()) payload.createdAt = serverTimestamp();

  await setDoc(ref, payload, { merge: true });
}

export type BranchDevice = { id: string; name: string };

/** All registered devices for a branch (for the Claim picker). */
export async function loadBranchDevices(branchId: string): Promise<BranchDevice[]> {
  if (!isFirebaseConfigured || !db || !branchId) return [];
  try {
    const snap = await getDocs(query(collection(db, POS_DEVICES), where('branchId', '==', branchId)));
    return snap.docs.map((d) => {
      const name = d.data().name;
      return { id: d.id, name: typeof name === 'string' && name ? name : d.id };
    });
  } catch {
    return [];
  }
}

/**
 * O(1) receipt high-watermark: the `lastSeq` the reconciler stamps on the device
 * doc on every settled sale. Replaces scanning `asyncOrders`, so Claim stays
 * instant even with hundreds of thousands of historical orders. Legacy devices
 * (no `lastSeq`) fall back to 0.
 */
export async function getDeviceLastSeq(deviceId: string): Promise<number> {
  if (!isFirebaseConfigured || !db) return 0;
  try {
    const snap = await getDoc(doc(db, POS_DEVICES, deviceId));
    const v = snap.exists() ? snap.data().lastSeq : undefined;
    return typeof v === 'number' && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Claim an orphaned device identity after a total cache wipe. Adopts the chosen
 * device id locally (and in the IndexedDB mirror), resumes its receipt sequence
 * at `lastSeq + 1` (read directly from the device doc — O(1)), restores the
 * label, and re-registers to mark the terminal alive under that id. The caller
 * should reload the app afterward so every component re-reads the new identity.
 */
export async function claimDevice(
  branchId: string,
  deviceId: string,
  label: string,
  userId: string | null = null,
): Promise<void> {
  const lastSeq = await getDeviceLastSeq(deviceId);
  // setDeviceIdentity stores the seq as-is; nextLocalSeq() returns stored + 1,
  // so the next receipt is lastSeq + 1 — strictly above prior synced bills.
  setDeviceIdentity(deviceId, lastSeq);
  setDeviceLabel(label);
  await registerThisDevice(branchId, label, userId);
}

/** Injectable composition seam for {@link reconcileLocalSeqWithServer} tests. */
export type SeqReconcileDeps = {
  getDeviceId?: typeof getDeviceId;
  getDeviceLastSeq?: typeof getDeviceLastSeq;
  peekLocalSeq?: typeof peekLocalSeq;
  fastForwardLocalSeqTo?: typeof fastForwardLocalSeqTo;
};

/**
 * Boot-time, read-only reconciliation (Packet 3B-4 — mitigates W-04 stale local
 * sequence recovery after a localStorage wipe / stale IndexedDB mirror). Reads
 * this device's server watermark (`posDevices/{deviceId}.lastSeq`, the same O(1)
 * seam `claimDevice` uses) and — ONLY when it is strictly higher than the local
 * sequence — fast-forwards the local base upward via `fastForwardLocalSeqTo()`.
 * Never writes `posDevices`. Fail-open on every path: Firebase off, offline,
 * missing doc, missing/zero `lastSeq`, or a read rejection all resolve to a
 * silent no-op — a reconciliation failure must never surface to the cashier.
 */
export async function reconcileLocalSeqWithServer(deps?: SeqReconcileDeps): Promise<void> {
  const getId = deps?.getDeviceId ?? getDeviceId;
  const getLastSeq = deps?.getDeviceLastSeq ?? getDeviceLastSeq;
  const peekLocal = deps?.peekLocalSeq ?? peekLocalSeq;
  const fastForward = deps?.fastForwardLocalSeqTo ?? fastForwardLocalSeqTo;

  try {
    if (!isFirebaseConfigured || !db) return;
    const id = getId();
    const serverLastSeq = await getLastSeq(id);
    if (serverLastSeq > peekLocal()) {
      await fastForward(serverLastSeq);
    }
  } catch {
    // Fail-open — never let a reconciliation failure surface to the cashier.
  }
}
