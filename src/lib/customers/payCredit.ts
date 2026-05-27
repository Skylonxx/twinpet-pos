import { doc, getDoc, type Firestore } from 'firebase/firestore';
import { collections } from '../firebase';
import type { CreditAccount } from '../types';
import { receiveCreditPayment } from './creditService';
import { getDevCreditAccount } from './devMock';
import type { PayCreditInput } from './types';

export async function payCreditSafe(
  firestore: Firestore | undefined,
  input: PayCreditInput,
  isDev: boolean,
): Promise<CreditAccount> {
  await receiveCreditPayment(
    {
      customerId: input.customerId,
      branchId: input.branchId,
      amount: input.amount,
      paymentMethod: input.method,
      notes: input.note,
      createdBy: input.createdBy,
    },
    isDev ? undefined : firestore,
  );

  if (isDev || !firestore) {
    const account = getDevCreditAccount(input.customerId);
    if (!account) {
      throw new Error('ไม่พบบัญชีเชื่อของลูกค้า');
    }
    return account;
  }

  const credRef = doc(firestore, collections.creditAccounts, input.customerId);
  const credSnap = await getDoc(credRef);
  if (!credSnap.exists()) {
    throw new Error('ไม่พบบัญชีเชื่อของลูกค้า');
  }
  return credSnap.data() as CreditAccount;
}
