import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  type Firestore,
  type Transaction,
} from 'firebase/firestore';
import { collections } from '../firebase';
import {
  buildReceiptCounterKey,
  formatReceiptNumber,
  type ReceiptNumberConfig,
} from '../pos/billId';
import { mergeSystemSettings } from '../settings/systemTypes';

export type ReceivingNumberConfig = ReceiptNumberConfig;

const DEV_COUNTER_STORAGE = 'twinpet-receiving-counters';

function readDevSystemSettings(): ReturnType<typeof mergeSystemSettings> {
  try {
    const raw = localStorage.getItem('twinpet-system-settings');
    if (!raw) return mergeSystemSettings(undefined);
    return mergeSystemSettings(JSON.parse(raw) as Partial<ReturnType<typeof mergeSystemSettings>>);
  } catch {
    return mergeSystemSettings(undefined);
  }
}

function readDevCounterMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DEV_COUNTER_STORAGE);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeDevCounterMap(map: Record<string, number>): void {
  localStorage.setItem(DEV_COUNTER_STORAGE, JSON.stringify(map));
}

/** Load receiving prefix/padding from system settings (`docPrefixes.receiving`). */
export async function resolveReceivingNumberConfig(
  firestore: Firestore,
): Promise<ReceivingNumberConfig> {
  let prefix = 'RCV';
  let padding = 4;

  try {
    const snap = await getDoc(doc(firestore, collections.settings, 'system'));
    const system = mergeSystemSettings(
      snap.exists() ? (snap.data() as Partial<ReturnType<typeof mergeSystemSettings>>) : undefined,
    );
    prefix = system.docPrefixes.receiving?.trim() || prefix;
    padding = system.docNumberPadding > 0 ? system.docNumberPadding : padding;
  } catch {
    // keep defaults
  }

  return { prefix, padding };
}

export function resolveDevReceivingNumberConfig(): ReceivingNumberConfig {
  const system = readDevSystemSettings();
  return {
    prefix: system.docPrefixes.receiving?.trim() || 'RCV',
    padding: system.docNumberPadding > 0 ? system.docNumberPadding : 4,
  };
}

function buildReceivingCounterRef(firestore: Firestore, counterKey: string) {
  return doc(firestore, collections.settings, 'system', 'docCounters', counterKey);
}

export type ReceivingCounterAllocation = {
  counterRef: ReturnType<typeof buildReceivingCounterRef>;
  counterKey: string;
  nextSeq: number;
  receivingId: string;
  prefix: string;
};

export async function readReceivingCounterInTransaction(
  tx: Transaction,
  firestore: Firestore,
  config: ReceivingNumberConfig,
  now = new Date(),
): Promise<ReceivingCounterAllocation> {
  const counterKey = buildReceiptCounterKey(config.prefix, now);
  const counterRef = buildReceivingCounterRef(firestore, counterKey);
  const counterSnap = await tx.get(counterRef);
  const prevSeq = counterSnap.exists() ? Number(counterSnap.data().seq ?? 0) : 0;
  const nextSeq = prevSeq + 1;
  const prefix = config.prefix.trim().toUpperCase();

  return {
    counterRef,
    counterKey,
    nextSeq,
    receivingId: formatReceiptNumber(config.prefix, now, nextSeq, config.padding),
    prefix,
  };
}

export function commitReceivingCounterInTransaction(
  tx: Transaction,
  allocation: ReceivingCounterAllocation,
): void {
  tx.set(
    allocation.counterRef,
    {
      seq: allocation.nextSeq,
      prefix: allocation.prefix,
      dateKey: allocation.counterKey.split('_').slice(1).join('_'),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function allocateReceivingNumber(
  firestore: Firestore,
  config?: ReceivingNumberConfig,
  now = new Date(),
): Promise<string> {
  const resolved = config ?? (await resolveReceivingNumberConfig(firestore));
  return runTransaction(firestore, async (tx) => {
    const allocation = await readReceivingCounterInTransaction(tx, firestore, resolved, now);
    commitReceivingCounterInTransaction(tx, allocation);
    return allocation.receivingId;
  });
}

export function allocateDevReceivingNumber(config?: ReceivingNumberConfig): string {
  const resolved = config ?? resolveDevReceivingNumberConfig();
  const now = new Date();
  const counterKey = buildReceiptCounterKey(resolved.prefix, now);
  const map = readDevCounterMap();
  const nextSeq = (map[counterKey] ?? 0) + 1;
  map[counterKey] = nextSeq;
  writeDevCounterMap(map);
  return formatReceiptNumber(resolved.prefix, now, nextSeq, resolved.padding);
}
