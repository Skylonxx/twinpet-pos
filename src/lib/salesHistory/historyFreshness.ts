/**
 * Sales History record freshness: revision, chronology, row verdict, action matrix.
 * Display currentness only — never receipt authority.
 */

export type RevisionRead =
  | { kind: 'ABSENT' }
  | { kind: 'VALID'; value: number }
  | { kind: 'MALFORMED' };

export type SeqParse = { kind: 'VALID'; value: number } | { kind: 'INVALID_SEQ' };

export type RowVerdict = 'CURRENT' | 'PROVISIONAL' | 'STALE' | 'UNPROVEN' | 'ERROR';
export type SurfaceVerdict = 'CURRENT' | 'NOT_CURRENT';

export type AuxiliaryObservation = 'ABSENT' | 'CACHE_OBSERVED' | 'SERVER_OBSERVED' | 'ERROR';

export type RowReason =
  | 'OVERLAY_ONLY'
  | 'REVISION_BELOW_HIGH_WATER'
  | 'QUERY_CACHE_RESOLVED'
  | 'QUERY_PENDING_WRITES'
  | 'DOC_CACHE_RESOLVED'
  | 'DOC_PENDING_WRITES'
  | 'REVISION_ABSENT_UNDER_POLICY'
  | 'CHRONOLOGY_INVALID'
  | 'VOID_INTENT_UNRECONCILED'
  | 'REVISION_MALFORMED'
  | 'SOURCE_VOID_ANOMALY'
  | 'ROW_LOCAL_RECONCILIATION_ANOMALY';

export type ActionKind =
  | 'LIST_VISIBILITY'
  | 'DETAIL_VIEW'
  | 'AUTHORITATIVE_RECEIPT'
  | 'PROVISIONAL_RECEIPT'
  | 'VOID_SETTLED_SALE'
  | 'VOID_PENDING_SALE'
  | 'SETTLEMENT_CURRENTNESS_CLAIM';

export const ACTION_KINDS: readonly ActionKind[] = [
  'LIST_VISIBILITY',
  'DETAIL_VIEW',
  'AUTHORITATIVE_RECEIPT',
  'PROVISIONAL_RECEIPT',
  'VOID_SETTLED_SALE',
  'VOID_PENDING_SALE',
  'SETTLEMENT_CURRENTNESS_CLAIM',
] as const;

export type ActionDecision = 'ALLOW' | 'REFUSE' | 'ALLOW_ATTEMPT' | 'ALLOW_WITH_MARKER' | 'n/a';

export const PROHIBITED_COMPLETENESS_VOCABULARY = [
  'complete',
  'all sales',
  'branch history complete',
  'ครบถ้วน',
] as const;

export type SnapshotMeta = { fromCache: boolean; hasPendingWrites: boolean };

export function readRevision(doc: unknown): RevisionRead {
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return { kind: 'ABSENT' };
  const rec = doc as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, 'historyRev')) return { kind: 'ABSENT' };
  const v = rec.historyRev;
  if (typeof v !== 'number') return { kind: 'MALFORMED' };
  if (!Number.isFinite(v)) return { kind: 'MALFORMED' };
  if (!Number.isInteger(v)) return { kind: 'MALFORMED' };
  if (v < 1) return { kind: 'MALFORMED' };
  if (v > Number.MAX_SAFE_INTEGER) return { kind: 'MALFORMED' };
  return { kind: 'VALID', value: v };
}

/** G-D5 OPTION_B: absent → legacy baseline 0. Malformed → null (fail-closed). */
export function effectiveRevision(read: RevisionRead): number | null {
  if (read.kind === 'ABSENT') return 0;
  if (read.kind === 'VALID') return read.value;
  return null;
}

export function canMintSuccessor(current: number): boolean {
  return Number.isInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER;
}

export function historyRevKey(read: RevisionRead): string {
  if (read.kind === 'ABSENT') return 'ABSENT';
  if (read.kind === 'MALFORMED') return 'MALFORMED';
  return String(read.value);
}

export function normalizeDeviceId(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim();
}

export function parseLocalSeq(v: unknown): SeqParse {
  if (typeof v !== 'string') return { kind: 'INVALID_SEQ' };
  if (!/^[1-9]\d*$/.test(v)) return { kind: 'INVALID_SEQ' };
  if (v.length > String(Number.MAX_SAFE_INTEGER).length) return { kind: 'INVALID_SEQ' };
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) {
    return { kind: 'INVALID_SEQ' };
  }
  return { kind: 'VALID', value: n };
}

export function queryServerBacked(meta: SnapshotMeta): boolean {
  return meta.fromCache === false && meta.hasPendingWrites === false;
}

export function docServerBacked(queryMeta: SnapshotMeta, docMeta: SnapshotMeta): boolean {
  return queryServerBacked(queryMeta) && docMeta.hasPendingWrites === false && docMeta.fromCache === false;
}

export type ChronologyInput = {
  id: string;
  deviceId?: unknown;
  localSeq?: unknown;
  clientCreatedAt?: unknown;
};

export function localSeqFromAsyncOrderId(asyncOrderId: unknown): unknown {
  if (typeof asyncOrderId !== 'string' || !asyncOrderId.includes('-')) return undefined;
  return asyncOrderId.slice(asyncOrderId.lastIndexOf('-') + 1);
}

/** Canonical writers store sale time in `createdAt`. Never coerce invalid to epoch 0. */
export function saleTimeFromCreatedAt(createdAt: unknown): number | undefined {
  if (typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  if (createdAt && typeof createdAt === 'object') {
    const rec = createdAt as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof rec.toMillis === 'function') {
      const n = rec.toMillis();
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (typeof rec.toDate === 'function') {
      const n = rec.toDate().getTime();
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (typeof rec.seconds === 'number' && Number.isFinite(rec.seconds)) {
      const nano = typeof rec.nanoseconds === 'number' && Number.isFinite(rec.nanoseconds) ? rec.nanoseconds : 0;
      const n = rec.seconds * 1000 + Math.floor(nano / 1e6);
      if (n > 0) return n;
    }
  }
  return undefined;
}

export function chronologyInputFromOrder(order: {
  id: string;
  deviceId?: unknown;
  asyncOrderId?: unknown;
  createdAt?: unknown;
}): ChronologyInput {
  return {
    id: order.id,
    deviceId: order.deviceId,
    localSeq: localSeqFromAsyncOrderId(order.asyncOrderId),
    clientCreatedAt: saleTimeFromCreatedAt(order.createdAt),
  };
}

export type ChronologyParse =
  | { kind: 'VALID'; id: string; deviceId: string; seq: number; at: number }
  | { kind: 'INVALID'; id: string };

export function parseChronology(row: ChronologyInput): ChronologyParse {
  const id = typeof row.id === 'string' ? row.id : '';
  const deviceId = normalizeDeviceId(row.deviceId);
  const seq = parseLocalSeq(row.localSeq);
  const at = row.clientCreatedAt;
  if (!id || !deviceId || seq.kind !== 'VALID' || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    return { kind: 'INVALID', id };
  }
  return { kind: 'VALID', id, deviceId, seq: seq.value, at };
}

function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function compareChronology(a: ChronologyParse, b: ChronologyParse): number {
  if (a.kind === 'VALID' && b.kind === 'INVALID') return -1;
  if (a.kind === 'INVALID' && b.kind === 'VALID') return 1;
  if (a.kind === 'INVALID' && b.kind === 'INVALID') return codeUnitCompare(a.id, b.id);
  if (a.kind !== 'VALID' || b.kind !== 'VALID') return codeUnitCompare(a.id, b.id);
  if (a.at !== b.at) return a.at - b.at;
  const device = codeUnitCompare(a.deviceId, b.deviceId);
  if (device !== 0) return device;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return codeUnitCompare(a.id, b.id);
}

/**
 * Sales History presentation order: newest-first among valid rows, invalid last.
 * Tie-breaks remain the accepted device / local-seq / document-id code-unit order.
 * This does not invert the compareChronology total-order relation.
 */
function compareChronologyPresentation(a: ChronologyParse, b: ChronologyParse): number {
  if (a.kind === 'VALID' && b.kind === 'INVALID') return -1;
  if (a.kind === 'INVALID' && b.kind === 'VALID') return 1;
  if (a.kind === 'INVALID' && b.kind === 'INVALID') return codeUnitCompare(a.id, b.id);
  if (a.kind !== 'VALID' || b.kind !== 'VALID') return codeUnitCompare(a.id, b.id);
  if (a.at !== b.at) return b.at - a.at;
  const device = codeUnitCompare(a.deviceId, b.deviceId);
  if (device !== 0) return device;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return codeUnitCompare(a.id, b.id);
}

export function dedupeByDocId<T extends { id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export function sortChronologyStable<T extends ChronologyInput>(rows: readonly T[]): T[] {
  const unique = dedupeByDocId(rows.map((r) => ({ ...r, id: r.id })));
  return unique
    .map((row, index) => ({ row, index, chrono: parseChronology(row) }))
    .sort((a, b) => {
      const c = compareChronologyPresentation(a.chrono, b.chrono);
      if (c !== 0) return c;
      return a.index - b.index;
    })
    .map((x) => x.row);
}

export type HighWaterMap = Map<string, number>;

export function foldHighWater(map: HighWaterMap, orderId: string, rev: number): HighWaterMap {
  const next = new Map(map);
  const prev = next.get(orderId);
  if (prev == null || rev > prev) next.set(orderId, rev);
  return next;
}

export type RowVerdictInput = {
  canonicalPresent: boolean;
  overlayOnly: boolean;
  queryMeta: SnapshotMeta;
  docMeta: SnapshotMeta;
  revision: RevisionRead;
  highWater: number | undefined;
  chronologyValid: boolean;
  unreconciledVoidIntent: boolean;
  voidAnomaly?: string | null;
  voidRevisionFault?: string | null;
  localReconciliationAnomaly?: boolean;
};

export type RowVerdictResult = { verdict: RowVerdict; reason: RowReason | null };

export function rowVerdict(input: RowVerdictInput): RowVerdictResult {
  if (input.voidAnomaly != null && input.voidAnomaly !== '') {
    return { verdict: 'ERROR', reason: 'SOURCE_VOID_ANOMALY' };
  }
  if (input.voidRevisionFault != null && input.voidRevisionFault !== '') {
    return { verdict: 'ERROR', reason: 'REVISION_MALFORMED' };
  }
  if (input.localReconciliationAnomaly) {
    return { verdict: 'ERROR', reason: 'ROW_LOCAL_RECONCILIATION_ANOMALY' };
  }
  if (input.revision.kind === 'MALFORMED') {
    return { verdict: 'ERROR', reason: 'REVISION_MALFORMED' };
  }
  if (input.overlayOnly || !input.canonicalPresent) {
    return { verdict: 'PROVISIONAL', reason: 'OVERLAY_ONLY' };
  }
  if (input.unreconciledVoidIntent) {
    return { verdict: 'UNPROVEN', reason: 'VOID_INTENT_UNRECONCILED' };
  }
  if (!input.chronologyValid) {
    return { verdict: 'UNPROVEN', reason: 'CHRONOLOGY_INVALID' };
  }
  if (input.queryMeta.fromCache) {
    return { verdict: 'UNPROVEN', reason: 'QUERY_CACHE_RESOLVED' };
  }
  if (input.queryMeta.hasPendingWrites) {
    return { verdict: 'UNPROVEN', reason: 'QUERY_PENDING_WRITES' };
  }
  if (input.docMeta.fromCache) {
    return { verdict: 'UNPROVEN', reason: 'DOC_CACHE_RESOLVED' };
  }
  if (input.docMeta.hasPendingWrites) {
    return { verdict: 'UNPROVEN', reason: 'DOC_PENDING_WRITES' };
  }
  const eff = effectiveRevision(input.revision);
  if (eff == null) {
    return { verdict: 'ERROR', reason: 'REVISION_MALFORMED' };
  }
  if (input.highWater != null && eff < input.highWater) {
    return { verdict: 'STALE', reason: 'REVISION_BELOW_HIGH_WATER' };
  }
  return { verdict: 'CURRENT', reason: null };
}

export function surfaceVerdict(rows: readonly { verdict: RowVerdict }[]): SurfaceVerdict {
  return rows.every((r) => r.verdict === 'CURRENT') && rows.length > 0 ? 'CURRENT' : 'NOT_CURRENT';
}

export function decideAction(
  action: ActionKind,
  verdict: RowVerdict,
  reason: RowReason | null,
): ActionDecision {
  switch (action) {
    case 'LIST_VISIBILITY':
    case 'DETAIL_VIEW':
      return 'ALLOW';
    case 'AUTHORITATIVE_RECEIPT':
      if (verdict === 'ERROR' || verdict === 'PROVISIONAL') return 'REFUSE';
      if (reason === 'VOID_INTENT_UNRECONCILED') return 'REFUSE';
      return 'ALLOW_ATTEMPT';
    case 'PROVISIONAL_RECEIPT':
      if (verdict === 'CURRENT') return 'n/a';
      if (verdict === 'ERROR') return 'REFUSE';
      return 'ALLOW_WITH_MARKER';
    case 'VOID_SETTLED_SALE':
      if (verdict === 'PROVISIONAL') return 'n/a';
      if (verdict === 'ERROR') return 'REFUSE';
      if (reason === 'VOID_INTENT_UNRECONCILED') return 'REFUSE';
      if (verdict === 'CURRENT') return 'ALLOW';
      return 'ALLOW_WITH_MARKER';
    case 'VOID_PENDING_SALE':
      if (verdict === 'PROVISIONAL') return 'ALLOW';
      if (verdict === 'ERROR') return 'REFUSE';
      return 'n/a';
    case 'SETTLEMENT_CURRENTNESS_CLAIM':
      return verdict === 'CURRENT' ? 'ALLOW' : 'REFUSE';
  }
}

export function settledVoidEligible(verdict: RowVerdict | undefined, reason: RowReason | null | undefined): boolean {
  const decision = decideAction('VOID_SETTLED_SALE', verdict ?? 'UNPROVEN', reason ?? null);
  return decision === 'ALLOW' || decision === 'ALLOW_WITH_MARKER';
}

export function actionMatrix(): Record<ActionKind, Record<RowVerdict, ActionDecision>> {
  const verdicts: RowVerdict[] = ['CURRENT', 'PROVISIONAL', 'STALE', 'UNPROVEN', 'ERROR'];
  const out = {} as Record<ActionKind, Record<RowVerdict, ActionDecision>>;
  for (const action of ACTION_KINDS) {
    out[action] = {} as Record<RowVerdict, ActionDecision>;
    for (const v of verdicts) {
      out[action][v] = decideAction(action, v, v === 'UNPROVEN' ? 'QUERY_CACHE_RESOLVED' : null);
    }
  }
  return out;
}

export function updatedAtKey(value: unknown): string {
  if (value && typeof value === 'object') {
    const rec = value as { seconds?: unknown; nanoseconds?: unknown };
    if (typeof rec.seconds === 'number' && typeof rec.nanoseconds === 'number') {
      return `${rec.seconds}.${rec.nanoseconds}`;
    }
  }
  return 'UNRESOLVED';
}

export function canonicalDataSignature(
  docs: readonly {
    id: string;
    status: unknown;
    updatedAt?: unknown;
    total?: unknown;
    historyRev?: unknown;
  }[],
): string {
  const parts = [...docs]
    .map((d) => {
      const rev = readRevision(d);
      return `${d.id.length}:${d.id}|${String(d.status)}|${updatedAtKey(d.updatedAt)}|${String(d.total)}|${historyRevKey(rev)}`;
    })
    .sort(codeUnitCompare);
  return parts.join('\n');
}

export function auxiliaryObservation(meta: SnapshotMeta | null, error: boolean): AuxiliaryObservation {
  if (error) return 'ERROR';
  if (meta == null) return 'ABSENT';
  if (queryServerBacked(meta)) return 'SERVER_OBSERVED';
  return 'CACHE_OBSERVED';
}

export type OverlayDecoration = {
  pendingSync?: boolean;
  voidPendingSync?: boolean;
  voidAnomaly?: string | null;
  voidRevisionFault?: string | null;
  localReconciliationAnomaly?: boolean;
};

export const OVERLAY_DECORATION_KEYS = [
  'pendingSync',
  'voidPendingSync',
  'voidAnomaly',
  'voidRevisionFault',
  'localReconciliationAnomaly',
] as const;
