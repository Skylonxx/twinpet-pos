export const MANIFEST_DATABASE = 'twinpet-migration-manifest';
export const MAX_KNOWN_EPOCH_SCHEMA = 1;

export type EpochStatus = 'COPYING' | 'VERIFYING' | 'COMMITTED' | 'ABORTED' | 'FAILED';

export type DurableDomainId =
  | 'reversal'
  | 'journal'
  | 'shiftOpen'
  | 'shiftClose'
  | 'cart'
  | 'evidence'
  | 'device'
  | 'suspendedBills';

export type DurableDomainSpec = {
  id: DurableDomainId;
  database: string;
  stores: readonly string[];
  sourceIdbVersion: number | null;
};

export const DURABLE_DOMAINS: readonly DurableDomainSpec[] = [
  {
    id: 'reversal',
    database: 'twinpet-offline-reversal',
    stores: ['intents', 'stock', 'ledger', 'markers', 'rejections', 'voidIntents'],
    sourceIdbVersion: 3,
  },
  {
    id: 'journal',
    database: 'twinpet-sale-intent-journal',
    stores: ['saleIntents', 'saleIntentEvents', 'saleIntentMeta'],
    sourceIdbVersion: 1,
  },
  {
    id: 'shiftOpen',
    database: 'twinpet-shift-open-intent',
    stores: ['shiftOpenIntents'],
    sourceIdbVersion: 1,
  },
  {
    id: 'shiftClose',
    database: 'twinpet-shift-close-intent',
    stores: ['shiftCloseIntents'],
    sourceIdbVersion: 1,
  },
  {
    id: 'cart',
    database: 'twinpet-active-cart-snapshot',
    stores: ['activeCartSnapshots'],
    sourceIdbVersion: 1,
  },
  {
    id: 'evidence',
    database: 'twinpet-sale-submission-evidence',
    stores: ['saleEvidenceGenerationPointers', 'saleSubmissionEvidence'],
    sourceIdbVersion: 1,
  },
  {
    id: 'device',
    database: 'twinpet-device',
    stores: ['kv'],
    sourceIdbVersion: 1,
  },
  {
    id: 'suspendedBills',
    database: 'twinpet-suspended-bills',
    stores: ['bills'],
    sourceIdbVersion: null,
  },
];

export function newEpochId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `epoch-${Date.now()}-${hex}`;
}

export type DomainInventoryEntry = {
  id: DurableDomainId;
  database: string;
  stores: string[];
  rowCount: number;
  digestSha256: string;
  sourceIdbVersion: number | null;
};

export type P13ManifestEvidence = {
  branchIds: string[];
  rowCount: number;
  identicalDuplicateCount: number;
  malformedBranchErrors: number;
  invalidBillErrors: number;
  divergentDuplicateErrors: number;
  allCartLinesSchemaValid: boolean;
  digestSha256: string;
};

export type MigrationManifestSnapshot = {
  epochId: string;
  status: EpochStatus;
  schemaVersion: number;
  domains: DomainInventoryEntry[];
  p13?: P13ManifestEvidence;
};
