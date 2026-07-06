import { beforeAll, describe, expect, test } from 'vitest';
import type { AsyncOrder } from '../../types';
import {
  aliasesForAsyncOrderId,
  applyTransitionPatch,
  buildSaleIntentEntry,
  cloneSalePayload,
  eventTypeForStatus,
  formatSaleIntentEventKey,
  isProtectedPruneStatus,
  isResolvedTerminalStatus,
  isTransitionAllowed,
  parseSaleIntentEventKey,
  redactSalePayload,
  sanitizeSaleIntentErrorMessage,
  sanitizeSaleIntentEventDetails,
  selectPrunePlan,
  stripEntryPayload,
  TRANSITION_MATRIX,
} from './saleIntentJournalLogic';
import type { SaleIntentEntry, SaleIntentJournalStatus } from './saleIntentJournalTypes';
import { DEFAULT_PRUNE_MAX_AGE_DAYS, DEFAULT_PRUNE_MAX_ENTRIES } from './saleIntentJournalTypes';

const fixedNow = () => new Date('2026-07-01T12:00:00.000Z');

function makeAsyncOrder(over: Partial<AsyncOrder> = {}): AsyncOrder {
  return {
    id: 'dev-1-42',
    billId: 'B-0042',
    deviceId: 'dev-1',
    branchId: 'branch-1',
    shiftId: 'shift-1',
    staffId: 'staff-1',
    staffName: 'Somchai',
    customerId: null,
    customerSnap: null,
    priceLevelId: 'retail',
    lines: [],
    payments: [],
    subtotal: 100,
    discountAmt: 0,
    billDiscount: 0,
    fee: 0,
    vatRate: 0,
    vatAmt: 0,
    total: 100,
    paidAmt: 100,
    changeAmt: 0,
    creditAmt: 0,
    status: 'completed',
    reconcileStatus: 'pending_reconcile',
    reconciledAt: null,
    note: '',
    printCount: 0,
    clientCreatedAt: Date.parse('2026-07-01T11:00:00.000Z'),
    serverCreatedAt: null,
    updatedAt: null,
    ...over,
  };
}

describe('buildSaleIntentEntry', () => {
  test('constructs entry from AsyncOrder-like payload with alias equality', () => {
    const order = makeAsyncOrder();
    const entry = buildSaleIntentEntry({ order }, fixedNow);
    expect(entry.asyncOrderId).toBe(order.id);
    expect(entry.localQueueId).toBe(order.id);
    expect(entry.idempotencyKey).toBe(order.id);
    expect(entry.status).toBe('queued');
    expect(entry.billId).toBe(order.billId);
    expect(entry.totalAmount).toBe(order.total);
    expect(entry.salePayload).toEqual(order);
    expect(entry.createdAtLocal).toBe(order.clientCreatedAt);
  });

  test('aliasesForAsyncOrderId mirrors asyncOrderId', () => {
    const aliases = aliasesForAsyncOrderId('dev-9-1');
    expect(aliases).toEqual({
      asyncOrderId: 'dev-9-1',
      localQueueId: 'dev-9-1',
      idempotencyKey: 'dev-9-1',
    });
  });
});

describe('payload policy', () => {
  test('full policy retains cloned payload', () => {
    const order = makeAsyncOrder();
    const entry = buildSaleIntentEntry({ order, payloadPolicy: 'full' }, fixedNow);
    expect(entry.salePayload).not.toBe(order);
    expect(entry.salePayload).toEqual(order);
  });

  test('metadata_only policy stores null payload', () => {
    const entry = buildSaleIntentEntry(
      { order: makeAsyncOrder(), payloadPolicy: 'metadata_only' },
      fixedNow,
    );
    expect(entry.salePayload).toBeNull();
  });

  test('cloneSalePayload deep-clones nested lines', () => {
    const order = makeAsyncOrder({
      lines: [
        {
          productId: 'p1',
          productSnap: { name: 'Kibble', sku: 'K1', category: 'food' },
          unit: 'bag',
          unitFactor: 1,
          qty: 1,
          qtyBase: 1,
          unitPrice: 100,
          discountAmt: 0,
          lineTotal: 100,
        },
      ],
    });
    const cloned = cloneSalePayload(order);
    expect(cloned).not.toBe(order);
    expect(cloned.lines).not.toBe(order.lines);
    expect(cloned.lines[0]).toEqual(order.lines[0]);
  });
});

describe('transition matrix', () => {
  test('legal queued → flushed_to_cache', () => {
    expect(isTransitionAllowed('queued', 'flushed_to_cache')).toBe(true);
  });

  test('illegal settled_observed → queued', () => {
    expect(isTransitionAllowed('settled_observed', 'queued')).toBe(false);
  });

  test('matrix covers all statuses', () => {
    const statuses = Object.keys(TRANSITION_MATRIX);
    expect(statuses).toHaveLength(9);
  });

  test('applyTransitionPatch sets status-specific timestamps', () => {
    const base = buildSaleIntentEntry({ order: makeAsyncOrder() }, fixedNow);
    const rejected = applyTransitionPatch(
      base,
      'rejected_by_rules',
      { lastErrorMessage: 'permission denied' },
      fixedNow,
    );
    expect(rejected.rejectedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(rejected.lastErrorMessage).toBe('permission denied');

    const ack = applyTransitionPatch(base, 'server_acknowledged', undefined, fixedNow);
    expect(ack.serverAcknowledgedAt).toBe('2026-07-01T12:00:00.000Z');

    const settled = applyTransitionPatch(base, 'settled_observed', undefined, fixedNow);
    expect(settled.settledObservedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(settled.salePayload).toBeNull();
  });

  test('illegal transition planning is blocked at orchestration layer; patch only when allowed', () => {
    const base = buildSaleIntentEntry({ order: makeAsyncOrder() }, fixedNow);
    expect(isTransitionAllowed(base.status, 'superseded')).toBe(false);
  });

  test('full matrix sweep matches TRANSITION_MATRIX', () => {
    const statuses = Object.keys(TRANSITION_MATRIX) as SaleIntentJournalStatus[];
    for (const from of statuses) {
      for (const to of statuses) {
        const expected = to !== 'queued' && TRANSITION_MATRIX[from].includes(to);
        expect(isTransitionAllowed(from, to)).toBe(expected);
      }
    }
  });
});

describe('sanitizeSaleIntentEventDetails', () => {
  test('collapses multiline strings and caps length', () => {
    const out = sanitizeSaleIntentEventDetails({
      msg: 'line1\nline2',
      long: 'x'.repeat(400),
    });
    expect(out?.msg).toBe('line1 line2');
    expect(typeof out?.long).toBe('string');
    expect((out?.long as string).length).toBeLessThanOrEqual(300);
  });

  test('sanitizes Error-like values without stack retention', () => {
    const err = new Error('boom\nat foo.ts');
    err.stack = 'stack must not persist';
    const out = sanitizeSaleIntentEventDetails({ err });
    expect(out?.err).toBe('boom at foo.ts');
    expect(out?.err).not.toContain('stack must not persist');
  });

  test('replaces nested objects and arrays with safe placeholder', () => {
    const out = sanitizeSaleIntentEventDetails({
      nested: { customerSnap: { name: 'secret', phone: '081' } },
      lines: [{ productId: 'p1', qty: 1 }],
      salePayload: makeAsyncOrder(),
    });
    expect(out?.nested).toBe('[non-primitive]');
    expect(out?.lines).toBe('[non-primitive]');
    expect(out?.salePayload).toBe('[non-primitive]');
  });

  test('keeps flat primitive values only', () => {
    const out = sanitizeSaleIntentEventDetails({
      count: 2,
      ok: true,
      empty: null,
      ratio: 1.5,
    });
    expect(out).toEqual({ count: 2, ok: true, empty: null, ratio: 1.5 });
  });

  test('returns undefined for empty input', () => {
    expect(sanitizeSaleIntentEventDetails(undefined)).toBeUndefined();
    expect(sanitizeSaleIntentEventDetails({})).toBeUndefined();
  });
});

describe('redacted payload policy', () => {
  test('redacted policy removes customer PII and sensitive fields', () => {
    const order = makeAsyncOrder({
      staffName: 'Somchai',
      customerId: 'cust-1',
      customerSnap: { name: 'Jane Doe', phone: '0812345678', taxId: 'TAX-99' },
      note: 'VIP customer note',
      payments: [{ method: 'cash', amount: 100, ref: 'REF-SECRET' }],
    });
    const entry = buildSaleIntentEntry({ order, payloadPolicy: 'redacted' }, fixedNow);
    expect(entry.salePayload).not.toBeNull();
    expect(entry.salePayload!.staffName).toBe('[redacted]');
    expect(entry.salePayload!.customerSnap).toEqual({
      name: '[redacted]',
      phone: '[redacted]',
      taxId: null,
    });
    expect(entry.salePayload!.note).toBe('[redacted]');
    expect(entry.salePayload!.payments[0].ref).toBe('[redacted]');
    expect(entry.salePayload!.customerId).toBe('cust-1');
    expect(entry.salePayload!.total).toBe(order.total);
  });

  test('redactSalePayload does not equal full clone', () => {
    const order = makeAsyncOrder({
      customerSnap: { name: 'Jane', phone: '081', taxId: null },
    });
    const redacted = redactSalePayload(order);
    expect(redacted.customerSnap?.name).toBe('[redacted]');
    expect(redacted).not.toEqual(order);
  });
});

describe('sanitizeSaleIntentErrorMessage', () => {
  test('collapses whitespace and caps length', () => {
    const long = 'x'.repeat(400);
    const out = sanitizeSaleIntentErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
  });

  test('handles Error objects without stack retention', () => {
    const err = new Error('firestore\nrules failed');
    expect(sanitizeSaleIntentErrorMessage(err)).toBe('firestore rules failed');
  });

  test('unknown input becomes generic message', () => {
    expect(sanitizeSaleIntentErrorMessage({})).toBe('unknown error');
  });
});

describe('event key formatting', () => {
  test('format and parse round-trip', () => {
    const key = formatSaleIntentEventKey('dev-1-7', 3);
    expect(key).toBe('dev-1-7#000003');
    expect(parseSaleIntentEventKey(key)).toEqual({ asyncOrderId: 'dev-1-7', eventSeq: 3 });
  });

  test('eventTypeForStatus maps queued to enqueued', () => {
    expect(eventTypeForStatus('manual_review')).toBe('manual_review');
    expect(eventTypeForStatus('queued')).toBe('enqueued');
  });
});

describe('selectPrunePlan', () => {
  const makeEntry = (id: string, status: SaleIntentEntry['status'], createdAtLocal: number, withPayload = true): SaleIntentEntry => ({
    ...buildSaleIntentEntry({ order: makeAsyncOrder({ id, clientCreatedAt: createdAtLocal }) }, fixedNow),
    status,
    salePayload: withPayload ? makeAsyncOrder({ id }) : null,
    createdAtLocal,
  });

  test('phase A strips payload on resolved terminal with payload', () => {
    const recent = Date.parse('2026-06-30T00:00:00.000Z');
    const entries = [makeEntry('a', 'settled_observed', recent)];
    const plan = selectPrunePlan(entries, { now: fixedNow });
    expect(plan.stripIds).toEqual(['a']);
    expect(plan.deleteIds).toEqual([]);
  });

  test('phase B deletes resolved terminal older than 14 days', () => {
    const old = Date.parse('2026-06-01T00:00:00.000Z');
    const entries = [
      makeEntry('old', 'settled_observed', old, false),
      makeEntry('new', 'settled_observed', Date.parse('2026-06-30T00:00:00.000Z'), false),
    ];
    const plan = selectPrunePlan(entries, { now: fixedNow, maxAgeDays: DEFAULT_PRUNE_MAX_AGE_DAYS });
    expect(plan.deleteIds).toContain('old');
    expect(plan.deleteIds).not.toContain('new');
  });

  test('protected statuses are never selected for cap overflow pruning', () => {
    const nowMs = Date.parse('2026-07-01T12:00:00.000Z');
    const entries: SaleIntentEntry[] = [];
    for (let i = 0; i < 480; i++) {
      entries.push(makeEntry(`risk-${i}`, 'queued', nowMs - i));
    }
    for (let i = 0; i < 30; i++) {
      entries.push(
        makeEntry(`resolved-${i}`, 'settled_observed', nowMs - 20 * 24 * 60 * 60 * 1000 - i, false),
      );
    }
    const plan = selectPrunePlan(entries, {
      now: fixedNow,
      maxEntries: DEFAULT_PRUNE_MAX_ENTRIES,
    });
    for (const id of plan.deleteIds) {
      const entry = entries.find((e) => e.asyncOrderId === id)!;
      expect(isResolvedTerminalStatus(entry.status)).toBe(true);
      expect(isProtectedPruneStatus(entry.status)).toBe(false);
    }
    expect(plan.deleteIds.length).toBeGreaterThan(0);
  });

  test('unresolved risk states are retained (not in deleteIds)', () => {
    const entries = [
      makeEntry('q', 'queued', Date.parse('2025-01-01T00:00:00.000Z')),
      makeEntry('ack', 'server_acknowledged', Date.parse('2025-01-01T00:00:00.000Z')),
    ];
    const plan = selectPrunePlan(entries, { now: fixedNow });
    expect(plan.deleteIds).toEqual([]);
  });
});

describe('stripEntryPayload', () => {
  test('nulls payload and stamps stripped time', () => {
    const entry = buildSaleIntentEntry({ order: makeAsyncOrder() }, fixedNow);
    const stripped = stripEntryPayload(entry, fixedNow);
    expect(stripped.salePayload).toBeNull();
    expect(stripped.payloadStrippedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(stripped.updatedAtLocal).toBe(stripped.payloadStrippedAt);
  });
});

describe('static source guards (logic)', () => {
  let logicSource = '';
  let typesSource = '';

  beforeAll(async () => {
    logicSource = (await import('./saleIntentJournalLogic.ts?raw')).default;
    typesSource = (await import('./saleIntentJournalTypes.ts?raw')).default;
  });

  test('loads raw sources', () => {
    expect(logicSource.length).toBeGreaterThan(0);
    expect(typesSource.length).toBeGreaterThan(0);
  });

  test('no Firebase / React / checkout imports', () => {
    expect(logicSource).not.toMatch(/from ['"]firebase/);
    expect(logicSource).not.toMatch(/from ['"]react/);
    expect(logicSource).not.toMatch(/asyncCheckout|POSPage|PaymentModal/);
    expect(typesSource).not.toMatch(/from ['"]firebase/);
  });

  test('no localStorage/sessionStorage', () => {
    expect(logicSource).not.toMatch(/localStorage|sessionStorage/);
  });

  test('Date.now only via injected default in selectPrunePlan fallback', () => {
    const directNow = [...logicSource.matchAll(/\bDate\.now\s*\(/g)];
    expect(directNow.length).toBe(0);
  });
});
