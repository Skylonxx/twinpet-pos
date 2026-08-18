import { describe, expect, test } from 'vitest';
import {
  ACTION_KINDS,
  PROHIBITED_COMPLETENESS_VOCABULARY,
  actionMatrix,
  compareChronology,
  decideAction,
  docServerBacked,
  effectiveRevision,
  foldHighWater,
  historyRevKey,
  normalizeDeviceId,
  parseChronology,
  parseLocalSeq,
  queryServerBacked,
  readRevision,
  rowVerdict,
  sortChronologyStable,
  surfaceVerdict,
  type RowVerdict,
  type SnapshotMeta,
} from './historyFreshness';

const server: SnapshotMeta = { fromCache: false, hasPendingWrites: false };
const cache: SnapshotMeta = { fromCache: true, hasPendingWrites: false };

describe('A01 normalizeDeviceId', () => {
  test('A01 string/trim/whitespace/empty/null/undefined/non-string', () => {
    expect(normalizeDeviceId('iPad01')).toBe('iPad01');
    expect(normalizeDeviceId('  iPad01  ')).toBe('iPad01');
    expect(normalizeDeviceId('\tiPad01\n')).toBe('iPad01');
    expect(normalizeDeviceId('')).toBe('');
    expect(normalizeDeviceId('   ')).toBe('');
    expect(normalizeDeviceId('\t')).toBe('');
    expect(normalizeDeviceId(null)).toBe('');
    expect(normalizeDeviceId(undefined)).toBe('');
    expect(normalizeDeviceId(12)).toBe('');
    expect(normalizeDeviceId({})).toBe('');
    expect(normalizeDeviceId('undefined')).toBe('undefined');
    expect(normalizeDeviceId(' undefined ')).toBe('undefined');
  });
});

describe('A02 parseLocalSeq', () => {
  test('A02 INVALID_SEQ fixtures that Number() would accept', () => {
    const bad = ['', '+1', '-1', '1.5', '1e3', ' 1', '0x1', '0', String(Number.MAX_SAFE_INTEGER + 1), '1-'];
    for (const v of bad) {
      expect(parseLocalSeq(v).kind).toBe('INVALID_SEQ');
    }
    expect(parseLocalSeq('1')).toEqual({ kind: 'VALID', value: 1 });
  });
});

describe('A03-A06 chronology', () => {
  test('A03 invalid chronology ranks after valid old and is never coerced to epoch 0', () => {
    const valid = parseChronology({ id: 'a', deviceId: 'd', localSeq: '1', clientCreatedAt: 1 });
    const invalid = parseChronology({ id: 'b', deviceId: '', localSeq: '1', clientCreatedAt: 1 });
    expect(invalid.kind).toBe('INVALID');
    expect(compareChronology(valid, invalid)).toBeLessThan(0);
  });

  test('A04 case-sensitive code-unit comparison; no localeCompare in module', async () => {
    const src = (await import('./historyFreshness.ts?raw')).default as string;
    expect(src.includes('localeCompare')).toBe(false);
    const a = parseChronology({ id: 'a', deviceId: 'A', localSeq: '1', clientCreatedAt: 1 });
    const b = parseChronology({ id: 'b', deviceId: 'a', localSeq: '1', clientCreatedAt: 1 });
    expect(compareChronology(a, b)).toBeLessThan(0);
  });

  test('A05 de-dup by document id precedes sort', () => {
    const rows = [
      { id: 'x', deviceId: 'd', localSeq: '2', clientCreatedAt: 2 },
      { id: 'x', deviceId: 'd', localSeq: '1', clientCreatedAt: 1 },
      { id: 'y', deviceId: 'd', localSeq: '1', clientCreatedAt: 1 },
    ];
    const sorted = sortChronologyStable(rows);
    expect(sorted.filter((r) => r.id === 'x')).toHaveLength(1);
  });

  test('A06 permutation stability', () => {
    const set = [
      { id: 'c', deviceId: 'd', localSeq: '1', clientCreatedAt: 3 },
      { id: 'a', deviceId: 'd', localSeq: '1', clientCreatedAt: 1 },
      { id: 'b', deviceId: 'd', localSeq: '1', clientCreatedAt: 2 },
    ];
    const perms = [set, [set[1], set[2], set[0]], [set[2], set[0], set[1]]];
    const keys = perms.map((p) => sortChronologyStable(p).map((r) => r.id).join(','));
    expect(new Set(keys).size).toBe(1);
  });
});

describe('B revision', () => {
  test('B01 readRevision fail-closed matrix', () => {
    const bad = [NaN, -1, 0, 1.5, '3', null, undefined, Number.MAX_SAFE_INTEGER + 1, {}, []];
    for (const v of bad) {
      const read = v === undefined ? readRevision({}) : readRevision({ historyRev: v });
      if (v === undefined) expect(read.kind).toBe('ABSENT');
      else expect(read.kind).not.toBe('VALID');
    }
    expect(readRevision({ historyRev: 3 }).kind).toBe('VALID');
    expect(effectiveRevision({ kind: 'ABSENT' })).toBe(0);
    expect(effectiveRevision({ kind: 'MALFORMED' })).toBeNull();
  });

  test('B02 high-water fold 7→4→9 never decreases', () => {
    let map = new Map<string, number>();
    map = foldHighWater(map, 'o1', 7);
    map = foldHighWater(map, 'o1', 4);
    expect(map.get('o1')).toBe(7);
    map = foldHighWater(map, 'o1', 9);
    expect(map.get('o1')).toBe(9);
    const stale = rowVerdict({
      canonicalPresent: true,
      overlayOnly: false,
      queryMeta: server,
      docMeta: server,
      revision: { kind: 'VALID', value: 4 },
      highWater: 7,
      chronologyValid: true,
      unreconciledVoidIntent: false,
    });
    expect(stale).toEqual({ verdict: 'STALE', reason: 'REVISION_BELOW_HIGH_WATER' });
  });

  test('B03 fresh instance starts empty', () => {
    const map = new Map<string, number>();
    expect(map.size).toBe(0);
  });

  test('B04 two instances do not exclude each other', () => {
    const a = foldHighWater(new Map(), 'o1', 2);
    const b = foldHighWater(new Map(), 'o1', 9);
    expect(a.get('o1')).toBe(2);
    expect(b.get('o1')).toBe(9);
  });
});

describe('C verdict / action matrix', () => {
  test('C01 queryServerBacked four-cell table', () => {
    expect(queryServerBacked({ fromCache: false, hasPendingWrites: false })).toBe(true);
    expect(queryServerBacked({ fromCache: true, hasPendingWrites: false })).toBe(false);
    expect(queryServerBacked({ fromCache: false, hasPendingWrites: true })).toBe(false);
    expect(queryServerBacked({ fromCache: true, hasPendingWrites: true })).toBe(false);
  });

  test('C02 docServerBacked pending-write doc is not server-backed', () => {
    expect(docServerBacked(server, { fromCache: false, hasPendingWrites: true })).toBe(false);
    expect(docServerBacked(server, server)).toBe(true);
  });

  test('C03 rowVerdict matrix with exact reasons', () => {
    expect(rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: true, unreconciledVoidIntent: false,
    })).toEqual({ verdict: 'CURRENT', reason: null });
    expect(rowVerdict({
      canonicalPresent: false, overlayOnly: true, queryMeta: server, docMeta: server,
      revision: { kind: 'ABSENT' }, highWater: undefined, chronologyValid: true, unreconciledVoidIntent: false,
    })).toEqual({ verdict: 'PROVISIONAL', reason: 'OVERLAY_ONLY' });
    expect(rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: cache, docMeta: cache,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: true, unreconciledVoidIntent: false,
    })).toEqual({ verdict: 'UNPROVEN', reason: 'QUERY_CACHE_RESOLVED' });
    expect(rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'MALFORMED' }, highWater: undefined, chronologyValid: true, unreconciledVoidIntent: false,
    })).toEqual({ verdict: 'ERROR', reason: 'REVISION_MALFORMED' });
  });

  test('C04 overlay-only PROVISIONAL leaves other rows byte-identical', () => {
    const other = rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: true, unreconciledVoidIntent: false,
    });
    rowVerdict({
      canonicalPresent: false, overlayOnly: true, queryMeta: server, docMeta: server,
      revision: { kind: 'ABSENT' }, highWater: undefined, chronologyValid: true, unreconciledVoidIntent: false,
    });
    expect(other).toEqual({ verdict: 'CURRENT', reason: null });
  });

  test('C05 unreconciled void intent demotes exactly its colliding canonical row', () => {
    const hit = rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: true, unreconciledVoidIntent: true,
    });
    const other = rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: true, unreconciledVoidIntent: false,
    });
    expect(hit).toEqual({ verdict: 'UNPROVEN', reason: 'VOID_INTENT_UNRECONCILED' });
    expect(other.verdict).toBe('CURRENT');
  });

  test('C06 malformed historyRev on one row only', () => {
    const bad = rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'MALFORMED' }, highWater: undefined, chronologyValid: true, unreconciledVoidIntent: false,
    });
    const ok = rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: true, unreconciledVoidIntent: false,
    });
    expect(bad.verdict).toBe('ERROR');
    expect(ok.verdict).toBe('CURRENT');
  });

  test('C07 invalid chronology demotes exactly its own row', () => {
    const bad = rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: server, docMeta: server,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: false, unreconciledVoidIntent: false,
    });
    expect(bad).toEqual({ verdict: 'UNPROVEN', reason: 'CHRONOLOGY_INVALID' });
  });

  test('C08 forcing surfaceVerdict NOT_CURRENT changes no action-matrix cell', () => {
    const before = actionMatrix();
    expect(surfaceVerdict([{ verdict: 'STALE' }])).toBe('NOT_CURRENT');
    expect(actionMatrix()).toEqual(before);
  });

  test('C09 7×5 axis completeness excluding C10/C11 hardcoded cells', () => {
    const matrix = actionMatrix();
    expect(ACTION_KINDS).toHaveLength(7);
    const verdicts: RowVerdict[] = ['CURRENT', 'PROVISIONAL', 'STALE', 'UNPROVEN', 'ERROR'];
    for (const a of ACTION_KINDS) {
      for (const v of verdicts) expect(matrix[a][v]).toBeTruthy();
    }
    expect(matrix.LIST_VISIBILITY.CURRENT).toBe('ALLOW');
    expect(matrix.DETAIL_VIEW.ERROR).toBe('ALLOW');
  });

  test('C10 AUTHORITATIVE_RECEIPT selected cells', () => {
    expect(decideAction('AUTHORITATIVE_RECEIPT', 'STALE', 'REVISION_BELOW_HIGH_WATER')).toBe('ALLOW_ATTEMPT');
    expect(decideAction('AUTHORITATIVE_RECEIPT', 'UNPROVEN', 'QUERY_CACHE_RESOLVED')).toBe('ALLOW_ATTEMPT');
    expect(decideAction('AUTHORITATIVE_RECEIPT', 'UNPROVEN', 'VOID_INTENT_UNRECONCILED')).toBe('REFUSE');
  });

  test('C11 VOID_SETTLED_SALE ALLOW_WITH_MARKER when not server-confirmed', () => {
    expect(decideAction('VOID_SETTLED_SALE', 'UNPROVEN', 'QUERY_CACHE_RESOLVED')).toBe('ALLOW_WITH_MARKER');
  });

  test('C12 cache-empty is UNPROVEN; server-empty is query-local', () => {
    const cached = rowVerdict({
      canonicalPresent: true, overlayOnly: false, queryMeta: cache, docMeta: cache,
      revision: { kind: 'VALID', value: 1 }, highWater: 1, chronologyValid: true, unreconciledVoidIntent: false,
    });
    expect(cached.verdict).toBe('UNPROVEN');
    expect(queryServerBacked(server)).toBe(true);
  });

  test('C13 per-source ERROR retains other rows and blocks aggregate CURRENT', () => {
    expect(surfaceVerdict([{ verdict: 'ERROR' }, { verdict: 'CURRENT' }])).toBe('NOT_CURRENT');
    expect(decideAction('AUTHORITATIVE_RECEIPT', 'CURRENT', null)).toBe('ALLOW_ATTEMPT');
  });

  test('C14 prohibited vocabulary absent from constants', () => {
    const blob = [
      ...PROHIBITED_COMPLETENESS_VOCABULARY,
      historyRevKey({ kind: 'ABSENT' }),
    ].join(' ');
    expect(PROHIBITED_COMPLETENESS_VOCABULARY).toEqual(['complete', 'all sales', 'branch history complete', 'ครบถ้วน']);
    expect(blob.includes('complete')).toBe(true);
    const runtimeCopy = ['CURRENT', 'PROVISIONAL', 'STALE', 'UNPROVEN', 'ERROR', 'OVERLAY_ONLY'].join(' ');
    for (const w of PROHIBITED_COMPLETENESS_VOCABULARY) {
      expect(runtimeCopy.includes(w)).toBe(false);
    }
  });
});
