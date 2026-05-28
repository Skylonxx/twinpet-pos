import {
  doc,
  getDoc,
  serverTimestamp,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase/firestore';
import { collections } from '../firebase';
import { mergeSystemSettings } from '../settings/systemTypes';
import type { Settings } from '../types';

export type ReceiptNumberConfig = {
  prefix: string;
  padding: number;
};

const DEV_COUNTER_STORAGE = 'twinpet-receipt-counters';

/** Format: `[PREFIX]-[YYMMDD]-[RunningNumber]` e.g. `RCP-260527-0001` */
export function formatReceiptNumber(
  prefix: string,
  date: Date,
  seq: number,
  padding = 4,
): string {
  const safePrefix = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'RCP';
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const run = String(seq).padStart(Math.max(1, padding), '0');
  return `${safePrefix}-${yy}${mm}${dd}-${run}`;
}

export function buildReceiptCounterKey(prefix: string, date: Date): string {
  const safePrefix = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'RCP';
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${safePrefix}_${yy}${mm}${dd}`;
}

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

/** Load receipt prefix/padding from system settings, with optional branch override. */
export async function resolveReceiptNumberConfig(
  firestore: Firestore,
  branchId: string,
): Promise<ReceiptNumberConfig> {
  let prefix = 'RCP';
  let padding = 4;

  try {
    const systemSnap = await getDoc(doc(firestore, collections.settings, 'system'));
    const system = mergeSystemSettings(
      systemSnap.exists() ? (systemSnap.data() as Partial<ReturnType<typeof mergeSystemSettings>>) : undefined,
    );
    prefix = system.docPrefixes.salesReceipt?.trim() || prefix;
    padding = system.docNumberPadding > 0 ? system.docNumberPadding : padding;
  } catch {
    // Fall through to defaults / branch override
  }

  try {
    const branchSnap = await getDoc(doc(firestore, collections.settings, branchId));
    if (branchSnap.exists()) {
      const branchPrefix = (branchSnap.data() as Settings).posPrefix?.trim();
      if (branchPrefix) prefix = branchPrefix;
    }
  } catch {
    // Keep system prefix
  }

  return { prefix, padding };
}

/** Resolve config from dev localStorage (no Firestore). */
export function resolveDevReceiptNumberConfig(): ReceiptNumberConfig {
  const system = readDevSystemSettings();
  return {
    prefix: system.docPrefixes.salesReceipt?.trim() || 'RCP',
    padding: system.docNumberPadding > 0 ? system.docNumberPadding : 4,
  };
}

export type ReceiptCounterAllocation = {
  counterRef: DocumentReference;
  counterKey: string;
  nextSeq: number;
  billId: string;
  prefix: string;
};

function buildReceiptCounterRef(
  firestore: Firestore,
  counterKey: string,
): DocumentReference {
  return doc(firestore, collections.settings, 'system', 'docCounters', counterKey);
}

/** Read the next receipt number inside a transaction — does not write. */
export async function readReceiptCounterInTransaction(
  tx: Transaction,
  firestore: Firestore,
  config: ReceiptNumberConfig,
  now = new Date(),
): Promise<ReceiptCounterAllocation> {
  const counterKey = buildReceiptCounterKey(config.prefix, now);
  const counterRef = buildReceiptCounterRef(firestore, counterKey);
  const counterSnap = await tx.get(counterRef);
  const prevSeq = counterSnap.exists() ? Number(counterSnap.data().seq ?? 0) : 0;
  const nextSeq = prevSeq + 1;
  const prefix = config.prefix.trim().toUpperCase();

  return {
    counterRef,
    counterKey,
    nextSeq,
    billId: formatReceiptNumber(config.prefix, now, nextSeq, config.padding),
    prefix,
  };
}

/** Persist a receipt counter allocation — call only after all transaction reads. */
export function commitReceiptCounterInTransaction(
  tx: Transaction,
  allocation: ReceiptCounterAllocation,
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

/** Atomically allocate the next receipt number inside an existing Firestore transaction. */
export async function allocateReceiptNumberInTransaction(
  tx: Transaction,
  firestore: Firestore,
  config: ReceiptNumberConfig,
  now = new Date(),
): Promise<string> {
  const allocation = await readReceiptCounterInTransaction(tx, firestore, config, now);
  commitReceiptCounterInTransaction(tx, allocation);
  return allocation.billId;
}

/** Dev-mode counter (localStorage) when Firestore is unavailable. */
export function allocateDevReceiptNumber(config?: ReceiptNumberConfig): string {
  const resolved = config ?? resolveDevReceiptNumberConfig();
  const now = new Date();
  const counterKey = buildReceiptCounterKey(resolved.prefix, now);
  const map = readDevCounterMap();
  const nextSeq = (map[counterKey] ?? 0) + 1;
  map[counterKey] = nextSeq;
  writeDevCounterMap(map);
  return formatReceiptNumber(resolved.prefix, now, nextSeq, resolved.padding);
}

/** @deprecated Use formatReceiptNumber + allocateReceiptNumberInTransaction */
export function generatePosBillId(prefix = 'POS'): string {
  return allocateDevReceiptNumber({ prefix, padding: 4 });
}

/** @deprecated Use resolveReceiptNumberConfig */
export async function resolvePosBillPrefix(
  firestore: NonNullable<typeof import('../firebase').db>,
  branchId: string,
): Promise<string> {
  const config = await resolveReceiptNumberConfig(firestore, branchId);
  return config.prefix;
}
