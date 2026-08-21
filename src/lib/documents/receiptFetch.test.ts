import { Timestamp } from 'firebase/firestore';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { formatThaiDate } from './formatters';
import type { ReceiptEnvelope } from './receiptFetch';

const callable = vi.fn();
const getFunctions = vi.fn(() => ({ __fns: true }));
const httpsCallable = vi.fn(() => callable);
const connectFunctionsEmulator = vi.fn();

vi.mock('firebase/functions', () => ({
  getFunctions: () => getFunctions(),
  httpsCallable: () => httpsCallable(),
  connectFunctionsEmulator: () => connectFunctionsEmulator(),
}));

vi.mock('../firebase', () => ({
  app: { name: 'app' },
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
}));

const SERIALIZED_SECONDS = 1755691234;
const SERIALIZED_NANOS = 567000000;
const SERIALIZED_MS = 1755691234567;

function expectedThaiDateTime(ms: number): string {
  const d = new Date(ms);
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear() + 543;
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year}  ${h}:${m}`;
}

function serializedCreatedAt(): { _seconds: number; _nanoseconds: number } {
  return { _seconds: SERIALIZED_SECONDS, _nanoseconds: SERIALIZED_NANOS };
}

function baseEnvelope(orderOverrides: Record<string, unknown> = {}): ReceiptEnvelope {
  return {
    authority: 'AUTHORITATIVE',
    reason: 'all_conjuncts',
    items: [{ id: 'i1', productSnap: { name: 'Food' } }],
    payments: [{ id: 'p1', method: 'cash', amount: 100 }],
    order: {
      id: 'o1',
      branchId: 'LDP-001',
      createdAt: serializedCreatedAt(),
      updatedAt: serializedCreatedAt(),
      voidedAt: null,
      extraKey: 'keep-me',
      ...orderOverrides,
    },
  };
}

async function loadFetch() {
  const { fetchOrderReceipt } = await import('./receiptFetch');
  return fetchOrderReceipt;
}

describe('receiptFetch', () => {
  beforeEach(() => {
    callable.mockReset();
    vi.resetModules();
  });

  test('H06 callable failure never silently returns a locally composed unmarked envelope', async () => {
    callable.mockRejectedValue(new Error('unavailable'));
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.envelope).toBeNull();
      expect(result.reason).toBe('callable_failed');
    }
  });

  test('T1 callable {_seconds,_nanoseconds} createdAt is normalized to Timestamp', async () => {
    callable.mockResolvedValue({ data: baseEnvelope() });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.envelope?.order) {
      throw new Error('expected successful envelope');
    }
    const createdAt = result.envelope.order.createdAt as { toDate?: unknown };
    expect(typeof createdAt.toDate).toBe('function');
    expect((createdAt as { toDate: () => Date }).toDate().getTime()).toBe(SERIALIZED_MS);
  });

  test('T2 formatThaiDate on normalized {_seconds,_nanoseconds} createdAt', async () => {
    callable.mockResolvedValue({ data: baseEnvelope() });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.envelope?.order) {
      throw new Error('expected successful envelope');
    }
    const createdAt = result.envelope.order.createdAt as Parameters<typeof formatThaiDate>[0];
    const formatted = formatThaiDate(createdAt, true);
    expect(formatted).toBe(expectedThaiDateTime(SERIALIZED_MS));
    expect(formatted).not.toMatch(/01\/01\/2513/);
  });

  test('T3 real Timestamp createdAt is passed through by identity', async () => {
    const ts = new Timestamp(SERIALIZED_SECONDS, SERIALIZED_NANOS);
    callable.mockResolvedValue({ data: baseEnvelope({ createdAt: ts }) });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.envelope?.order) {
      throw new Error('expected successful envelope');
    }
    expect(result.envelope.order.createdAt).toBe(ts);
    expect((result.envelope.order.createdAt as Timestamp).toDate().getTime()).toBe(SERIALIZED_MS);
  });

  test('T3-date Date createdAt is converted via Timestamp.fromDate', async () => {
    const date = new Date(SERIALIZED_MS);
    callable.mockResolvedValue({ data: baseEnvelope({ createdAt: date }) });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.envelope?.order) {
      throw new Error('expected successful envelope');
    }
    const createdAt = result.envelope.order.createdAt as Timestamp;
    expect(createdAt).toBeInstanceOf(Timestamp);
    expect(createdAt.toDate().getTime()).toBe(SERIALIZED_MS);
  });

  test('T4 {seconds,nanoseconds} createdAt is normalized to Timestamp', async () => {
    callable.mockResolvedValue({
      data: baseEnvelope({
        createdAt: { seconds: SERIALIZED_SECONDS, nanoseconds: SERIALIZED_NANOS },
      }),
    });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.envelope?.order) {
      throw new Error('expected successful envelope');
    }
    const createdAt = result.envelope.order.createdAt as Timestamp;
    expect(typeof createdAt.toDate).toBe('function');
    expect(createdAt.toDate().getTime()).toBe(SERIALIZED_MS);
  });

  test.each([
    ['ISO string', '2026-08-20T11:59:00Z'],
    ['epoch number', SERIALIZED_MS],
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
    ['NaN _seconds', { _seconds: Number.NaN, _nanoseconds: 0 }],
    ['Infinity _seconds', { _seconds: Number.POSITIVE_INFINITY, _nanoseconds: 0 }],
    ['out-of-range seconds', { _seconds: 253402300800, _nanoseconds: 0 }],
    ['out-of-range nanoseconds', { _seconds: SERIALIZED_SECONDS, _nanoseconds: 1_000_000_000 }],
  ])('T5 malformed createdAt (%s) fails closed', async (_label, createdAt) => {
    callable.mockResolvedValue({ data: baseEnvelope({ createdAt }) });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    await expect(Promise.resolve(result)).resolves.toEqual({
      ok: false,
      reason: 'malformed_receipt_payload',
      envelope: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.envelope).toBeNull();
      expect(result.reason).toBe('malformed_receipt_payload');
    }
  });

  test('T5 null order is not converted into malformed_receipt_payload', async () => {
    callable.mockResolvedValue({
      data: {
        authority: 'UNPROVEN',
        reason: 'envelope_incomplete',
        items: [],
        payments: [],
        order: null,
      },
    });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('null order must remain a successful fetch');
    }
    expect(result.envelope.order).toBeNull();
    expect(result.envelope.authority).toBe('UNPROVEN');
  });

  test('T6 pass-through invariants and voidedAt null', async () => {
    const items = [{ id: 'i1', productSnap: { name: 'Food' } }];
    const payments = [
      {
        id: 'p1',
        method: 'cash',
        amount: 100,
        createdAt: { _seconds: 9, _nanoseconds: 8 },
      },
    ];
    const envelope: ReceiptEnvelope = {
      authority: 'AUTHORITATIVE',
      reason: 'all_conjuncts',
      items,
      payments,
      order: {
        id: 'o1',
        branchId: 'LDP-001',
        staffName: 'Dao',
        extraKey: 'keep-me',
        createdAt: serializedCreatedAt(),
        updatedAt: serializedCreatedAt(),
        voidedAt: null,
      },
    };
    callable.mockResolvedValue({ data: envelope });
    const fetchOrderReceipt = await loadFetch();
    const result = await fetchOrderReceipt('o1');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected successful envelope');
    }
    expect(result.envelope.authority).toBe('AUTHORITATIVE');
    expect(result.envelope.reason).toBe('all_conjuncts');
    expect(result.envelope.items).toBe(items);
    expect(result.envelope.payments).toBe(payments);
    expect(result.envelope.payments[0]?.createdAt).toEqual({ _seconds: 9, _nanoseconds: 8 });
    expect(result.envelope.order).not.toBeNull();
    expect(result.envelope.order?.extraKey).toBe('keep-me');
    expect(result.envelope.order?.staffName).toBe('Dao');
    expect(result.envelope.order?.id).toBe('o1');
    expect(result.envelope.order?.branchId).toBe('LDP-001');
    expect(result.envelope.order?.voidedAt).toBeNull();
  });
});
