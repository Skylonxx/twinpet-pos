/**
 * Scheduling/gating connectivity signal only.
 * Not reconciliation proof. Not authorization proof.
 *
 * Must preserve access to the real browser Navigator (including Web Locks)
 * rather than a synthetic `{ onLine }` object.
 */

export type ConnectivityEventType = 'online' | 'offline';

export type ConnectivityListener = () => void;

export interface ConnectivityPort {
  isOnline(): boolean;
  subscribe(type: ConnectivityEventType, listener: ConnectivityListener): () => void;
  addEventListener(type: ConnectivityEventType, listener: ConnectivityListener): void;
  removeEventListener(type: ConnectivityEventType, listener: ConnectivityListener): void;
  getNavigator(): Navigator | undefined;
}
