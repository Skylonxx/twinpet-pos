import { doc, serverTimestamp, setDoc, type DocumentReference } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';

/**
 * POS sync-signal — the "ring the bell" channel between Admin and the
 * decoupled, pull-based POS terminals.
 *
 * Model: one tiny document per branch at
 *   `pos_configs/branches/{branchId}/sync_state`
 * holding a single field `lastForceUpdate: serverTimestamp`. The admin stamps
 * it after editing the catalog; each POS terminal keeps ONE cheap onSnapshot on
 * it and pulls a fresh inventory snapshot when the stamp advances. This is the
 * single sanctioned live listener in the otherwise static Repository design.
 */
export function syncStateDocRef(branchId: string): DocumentReference {
  // pos_configs (col) / branches (doc) / {branchId} (col) / sync_state (doc)
  return doc(db!, 'pos_configs', 'branches', branchId, 'sync_state');
}

/**
 * Admin broadcast: stamp a fresh server time so every POS terminal on `branchId`
 * knows to pull the latest catalog/price/rank data. No-op when Firebase is
 * unconfigured (dev mode has no terminals to notify).
 */
export async function broadcastInventoryUpdate(branchId: string): Promise<void> {
  const id = branchId.trim();
  if (!id) throw new Error('ต้องระบุสาขา');
  if (!isFirebaseConfigured || !db) return;
  await setDoc(syncStateDocRef(id), { lastForceUpdate: serverTimestamp() }, { merge: true });
}
