import { db, isFirebaseConfigured } from './firebase';
import { voidDevOrder } from './salesHistory/devMock';

export type VoidOrderInput = {
  orderId: string;
  branchId: string;
  reason: string;
  note?: string;
  voidedBy: string;
  voidedByName: string;
};

/**
 * Legacy canonical online void mutator — retired for R7-6.
 * Production voids must use `requestPendingVoid` (seven-key async intent)
 * and `handleVoidIntent` (server). This function must not mutate canonical
 * `orders` / stock / credit.
 */
export async function voidOrder(input: VoidOrderInput): Promise<void> {
  void input;
  throw new Error(
    'Client canonical void mutation is retired. Settled voids must go through requestPendingVoid → handleVoidIntent.',
  );
}

export async function voidOrderDev(input: VoidOrderInput): Promise<void> {
  voidDevOrder(input.orderId, input.reason, input.voidedBy);
}

export async function voidOrderSafe(input: VoidOrderInput): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    await voidOrderDev(input);
    return;
  }
  await voidOrder(input);
}
