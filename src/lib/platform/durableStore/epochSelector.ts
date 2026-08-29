import {
  createTauriDurableStorePort,
  invokeDurableManifestGet,
  invokeDurableManifestLeaseAcquire,
  invokeDurableManifestLeaseHeartbeat,
  invokeDurableManifestLeaseRelease,
  invokeDurableManifestPutEpoch,
} from '../adapters/tauri/tauriDurableStorePort';
import type { DurableStoreKey, DurableStorePort } from '../ports/durableStorePort';
import { sha256HexOfRows } from './canonicalDigest';
import { encodeDurableKey, sortEncodedKeys } from './kvKeyCodec';
import {
  DURABLE_DOMAINS,
  MAX_KNOWN_EPOCH_SCHEMA,
  newEpochId,
  type DomainInventoryEntry,
  type DurableDomainId,
  type P13ManifestEvidence,
} from './migrationManifest';

export type DomainDumpRow = {
  store: string;
  key: DurableStoreKey;
  value: unknown;
};

export type DomainDump = {
  rows: DomainDumpRow[];
  p13?: P13ManifestEvidence;
};

export type DomainDumper = () => Promise<DomainDumpRow[] | DomainDump>;

export type CutoverResult =
  | { status: 'committed'; epochId: string }
  | { status: 'already-committed'; epochId: string }
  | { status: 'failed'; epochId: string; error: string };

const LEASE_OWNER = 'twinpet-web-boot';
const LEASE_TTL_MS = 30_000;

type ManifestEpochRow = {
  epochId?: string;
  status?: string;
  inventoryJson?: string;
};

type ManifestSnapshot = {
  activeCommitted?: ManifestEpochRow | null;
  epochs?: ManifestEpochRow[];
};

function asDomainDump(raw: DomainDumpRow[] | DomainDump): DomainDump {
  return Array.isArray(raw) ? { rows: raw } : raw;
}

function requireRegisteredDumpers(dumpers: Map<DurableDomainId, DomainDumper>): void {
  const missing = DURABLE_DOMAINS.filter((spec) => !dumpers.has(spec.id)).map((spec) => spec.id);
  if (missing.length > 0) {
    throw new Error(`required domain dumper is not registered: ${missing.join(',')}`);
  }
}

async function dumpPort(port: DurableStorePort, stores: readonly string[]): Promise<DomainDumpRow[]> {
  return port.transact([...stores], 'readonly', async (txn) => {
    const rows: DomainDumpRow[] = [];
    for (const store of stores) {
      const keys = await txn.getAllKeys(store);
      for (const key of keys) {
        rows.push({ store, key, value: await txn.get(store, key) });
      }
    }
    return rows;
  });
}

export async function buildP13ManifestEvidence(input: {
  branchIds: string[];
  rows: DomainDumpRow[];
  identicalDuplicateCount: number;
}): Promise<P13ManifestEvidence> {
  const billRows = sortEncodedKeys(input.rows.map((row) => encodeDurableKey(row.key))).map((encodedKey) => {
    const row = input.rows.find((candidate) => encodeDurableKey(candidate.key) === encodedKey)!;
    return { encodedKey, value: row.value };
  });
  const digestSha256 = await sha256HexOfRows([
    {
      encodedKey: 'p13-branch-inventory',
      value: { branchIds: input.branchIds, branchCount: input.branchIds.length },
    },
    {
      encodedKey: 'p13-bills',
      value: {
        rowCount: input.rows.length,
        identicalDuplicateCount: input.identicalDuplicateCount,
        bills: billRows,
      },
    },
  ]);
  return {
    branchIds: [...input.branchIds],
    rowCount: input.rows.length,
    identicalDuplicateCount: input.identicalDuplicateCount,
    malformedBranchErrors: 0,
    invalidBillErrors: 0,
    divergentDuplicateErrors: 0,
    allCartLinesSchemaValid: true,
    digestSha256,
  };
}

async function writeCandidate(
  epochId: string,
  database: string,
  stores: readonly string[],
  rows: DomainDumpRow[],
): Promise<void> {
  const port = createTauriDurableStorePort({ database, epochId });
  await port.transact([...stores], 'readwrite', async (txn) => {
    for (const row of rows) {
      await txn.put(row.store, row.key, row.value);
    }
  });
}

async function verifyDomain(
  epochId: string,
  spec: (typeof DURABLE_DOMAINS)[number],
  source: DomainDump,
): Promise<DomainInventoryEntry> {
  const port = createTauriDurableStorePort({ database: spec.database, epochId });
  const copied = await dumpPort(port, spec.stores);
  const sourceDigestRows = sortEncodedKeys(source.rows.map((r) => encodeDurableKey(r.key))).map((encodedKey) => {
    const row = source.rows.find((r) => encodeDurableKey(r.key) === encodedKey)!;
    return { encodedKey, value: row.value };
  });
  const copiedDigestRows = sortEncodedKeys(copied.map((r) => encodeDurableKey(r.key))).map((encodedKey) => {
    const row = copied.find((r) => encodeDurableKey(r.key) === encodedKey)!;
    return { encodedKey, value: row.value };
  });
  const sourceDigest = await sha256HexOfRows(sourceDigestRows);
  const copiedDigest = await sha256HexOfRows(copiedDigestRows);
  if (sourceDigest !== copiedDigest || source.rows.length !== copied.length) {
    throw new Error(`M2 digest mismatch for ${spec.database}`);
  }
  if (spec.id === 'suspendedBills') {
    if (!source.p13) {
      throw new Error('required P-13 branch inventory evidence is missing');
    }
    for (const row of source.rows) {
      const branchId = Array.isArray(row.key) ? row.key[0] : undefined;
      if (typeof branchId !== 'string' || !source.p13.branchIds.includes(branchId)) {
        throw new Error('P-13 branch set mismatch');
      }
    }
    const copiedEvidence = await buildP13ManifestEvidence({
      branchIds: source.p13.branchIds,
      rows: copied,
      identicalDuplicateCount: source.p13.identicalDuplicateCount,
    });
    if (copiedEvidence.digestSha256 !== source.p13.digestSha256) {
      throw new Error('P-13 inventory digest mismatch');
    }
    if (copiedEvidence.branchIds.join('\u0000') !== source.p13.branchIds.join('\u0000')) {
      throw new Error('P-13 branch set mismatch');
    }
  }
  return {
    id: spec.id,
    database: spec.database,
    stores: [...spec.stores],
    rowCount: copied.length,
    digestSha256: copiedDigest,
    sourceIdbVersion: spec.sourceIdbVersion,
  };
}

function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

function findEpoch(snapshot: ManifestSnapshot, epochId: string): ManifestEpochRow | undefined {
  return snapshot.epochs?.find((row) => row.epochId === epochId);
}

function isCommittedRow(row: ManifestEpochRow | null | undefined, epochId: string): boolean {
  return Boolean(row && row.epochId === epochId && row.status === 'COMMITTED');
}

async function recoverAfterCutoverError(input: {
  epochId: string;
  err: unknown;
}): Promise<CutoverResult> {
  const message = input.err instanceof Error ? input.err.message : String(input.err);
  let observed: ManifestSnapshot;
  try {
    observed = (await invokeDurableManifestGet()) as ManifestSnapshot;
  } catch (readErr) {
    const readMessage = readErr instanceof Error ? readErr.message : String(readErr);
    throw new Error(
      `durable manifest read failed after cutover error; refusing to demote or select legacy authority (${readMessage}); original: ${message}`,
    );
  }
  if (
    isCommittedRow(observed.activeCommitted, input.epochId) ||
    isCommittedRow(findEpoch(observed, input.epochId), input.epochId)
  ) {
    return { status: 'committed', epochId: input.epochId };
  }
  const row = findEpoch(observed, input.epochId);
  if (row && row.status && row.status !== 'COMMITTED') {
    await invokeDurableManifestPutEpoch({
      epochId: input.epochId,
      status: 'FAILED',
      inventoryJson: JSON.stringify({ schemaVersion: MAX_KNOWN_EPOCH_SCHEMA }),
      errorCode: errorCodeOf(input.err) ?? 'm2_failed',
      errorDetail: message,
    });
    return { status: 'failed', epochId: input.epochId, error: message };
  }
  if (!row) {
    return { status: 'failed', epochId: input.epochId, error: message };
  }
  throw new Error(
    `ambiguous durable epoch state after cutover error; refusing to demote or select legacy authority: ${message}`,
  );
}

export async function runFirstEpochCutover(input: {
  dumpers: Map<DurableDomainId, DomainDumper>;
}): Promise<CutoverResult> {
  const existing = (await invokeDurableManifestGet()) as ManifestSnapshot;
  const already = existing.activeCommitted?.epochId;
  if (already && existing.activeCommitted?.status === 'COMMITTED') {
    return { status: 'already-committed', epochId: already };
  }

  const epochId = newEpochId();
  const acquired = await invokeDurableManifestLeaseAcquire(LEASE_OWNER, LEASE_TTL_MS);
  if (!acquired) {
    return { status: 'failed', epochId, error: 'migration lease not acquired' };
  }
  try {
    requireRegisteredDumpers(input.dumpers);
    await invokeDurableManifestPutEpoch({
      epochId,
      status: 'COPYING',
      inventoryJson: JSON.stringify({ schemaVersion: MAX_KNOWN_EPOCH_SCHEMA, domains: [] }),
    });
    await invokeDurableManifestLeaseHeartbeat(LEASE_OWNER, LEASE_TTL_MS);

    const sourceByDomain = new Map<DurableDomainId, DomainDump>();
    for (const spec of DURABLE_DOMAINS) {
      const dump = input.dumpers.get(spec.id);
      if (!dump) {
        throw new Error(`required domain dumper is not registered: ${spec.id}`);
      }
      const materialized = asDomainDump(await dump());
      if (spec.id === 'suspendedBills' && !materialized.p13) {
        throw new Error('required P-13 branch inventory evidence is missing');
      }
      sourceByDomain.set(spec.id, materialized);
    }

    for (const spec of DURABLE_DOMAINS) {
      await writeCandidate(epochId, spec.database, spec.stores, sourceByDomain.get(spec.id)?.rows ?? []);
    }

    await invokeDurableManifestPutEpoch({
      epochId,
      status: 'VERIFYING',
      inventoryJson: JSON.stringify({ schemaVersion: MAX_KNOWN_EPOCH_SCHEMA }),
    });

    const inventory: DomainInventoryEntry[] = [];
    for (const spec of DURABLE_DOMAINS) {
      inventory.push(await verifyDomain(epochId, spec, sourceByDomain.get(spec.id) ?? { rows: [] }));
    }

    if (inventory.length !== 8 || inventory.some((entry) => !entry.digestSha256)) {
      throw new Error('ALL_EIGHT_DOMAIN_FILES_M2_PASS is NO');
    }

    const p13 = sourceByDomain.get('suspendedBills')?.p13;
    if (!p13) {
      throw new Error('required P-13 branch inventory evidence is missing');
    }

    await invokeDurableManifestPutEpoch({
      epochId,
      status: 'COMMITTED',
      inventoryJson: JSON.stringify({
        schemaVersion: MAX_KNOWN_EPOCH_SCHEMA,
        domains: inventory,
        p13,
      }),
    });
    return { status: 'committed', epochId };
  } catch (err) {
    return recoverAfterCutoverError({ epochId, err });
  } finally {
    try {
      await invokeDurableManifestLeaseRelease(LEASE_OWNER);
    } catch {
      /* lease release is best-effort */
    }
  }
}
