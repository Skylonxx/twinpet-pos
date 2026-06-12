import { describe, it, expect } from 'vitest';
import {
  buildReversalRejectionRecord,
  createReversalRejectionRecordId,
  serializeReversalRejectionRecord,
  ReversalRejectionRecordError,
  type ReversalRejectionRecord,
  type ReversalRejectionRecordInput,
} from './reversalRejectionRecord';

// A representative transfer rejection input (mirrors what a future TransferHistoryPage /
// AdminTransferPage catch site would have on hand at the moment of the fail-closed throw).
const transferInput: ReversalRejectionRecordInput = {
  sourceType: 'transfer',
  sourceId: 'TR-1001',
  branchId: 'branch-origin',
  evidenceCode: 'header_total_qty_mismatch',
  evidenceMessage: 'ไม่สามารถยกเลิกโอนได้: หลักฐานโอนสินค้าไม่ตรงกับยอดรวม',
  evidenceSource: 'header_snapshot',
  staffId: 'user-7',
  observedDocumentUpdatedAt: '2026-06-12T08:30:00.000Z',
  createdAt: '2026-06-12T09:00:00.000Z',
};

// A representative receiving rejection input (ReceivingEditPage catch site).
const receivingInput: ReversalRejectionRecordInput = {
  sourceType: 'receiving',
  sourceId: 'GRN-2002',
  branchId: 'branch-a',
  evidenceCode: 'missing_lot_id',
  evidenceMessage: 'ไม่สามารถยกเลิกรับเข้าได้: มีรายการสินค้าที่ไม่มีรหัสล็อต',
  createdAt: '2026-06-12T09:05:00.000Z',
};

describe('H7-A: buildReversalRejectionRecord — construction', () => {
  it('builds a transfer rejection record with every supplied field', () => {
    const record = buildReversalRejectionRecord(transferInput);
    expect(record.sourceType).toBe('transfer');
    expect(record.sourceId).toBe('TR-1001');
    expect(record.branchId).toBe('branch-origin');
    expect(record.evidenceCode).toBe('header_total_qty_mismatch');
    expect(record.evidenceMessage).toBe(transferInput.evidenceMessage);
    expect(record.evidenceSource).toBe('header_snapshot');
    expect(record.staffId).toBe('user-7');
    expect(record.observedDocumentUpdatedAt).toBe('2026-06-12T08:30:00.000Z');
    expect(record.createdAt).toBe('2026-06-12T09:00:00.000Z');
    expect(record.recordId).toMatch(/^rej_[0-9a-f]{16}$/);
  });

  it('builds a receiving rejection record (minimal optional fields)', () => {
    const record = buildReversalRejectionRecord(receivingInput);
    expect(record.sourceType).toBe('receiving');
    expect(record.sourceId).toBe('GRN-2002');
    expect(record.branchId).toBe('branch-a');
    expect(record.evidenceCode).toBe('missing_lot_id');
    expect(record.evidenceMessage).toBe(receivingInput.evidenceMessage);
    expect(record.createdAt).toBe('2026-06-12T09:05:00.000Z');
    expect(record.recordId).toMatch(/^rej_[0-9a-f]{16}$/);
  });

  it('requires the core identity fields present (non-empty)', () => {
    const record = buildReversalRejectionRecord(transferInput);
    for (const key of ['recordId', 'sourceType', 'sourceId', 'branchId', 'evidenceCode', 'evidenceMessage', 'createdAt'] as const) {
      expect(record[key]).toBeTruthy();
    }
  });
});

describe('H7-A: required-field validation (fail-closed)', () => {
  it("rejects a sourceType that is not 'transfer' or 'receiving'", () => {
    const bad = { ...transferInput, sourceType: 'pos' as unknown as 'transfer' };
    expect(() => buildReversalRejectionRecord(bad)).toThrow(ReversalRejectionRecordError);
    expect(() => buildReversalRejectionRecord(bad)).toThrow(/sourceType/);
  });

  it('rejects missing / empty / whitespace required fields', () => {
    const required = ['sourceId', 'branchId', 'evidenceCode', 'evidenceMessage', 'createdAt'] as const;
    for (const field of required) {
      const blank = { ...transferInput, [field]: '   ' };
      expect(() => buildReversalRejectionRecord(blank)).toThrow(ReversalRejectionRecordError);
      try {
        buildReversalRejectionRecord(blank);
      } catch (err) {
        expect(err).toBeInstanceOf(ReversalRejectionRecordError);
        expect((err as ReversalRejectionRecordError).field).toBe(field);
      }
    }
  });

  it('rejects a non-object input', () => {
    expect(() => buildReversalRejectionRecord(null as unknown as ReversalRejectionRecordInput)).toThrow(
      ReversalRejectionRecordError,
    );
  });

  it('trims surrounding whitespace on required fields', () => {
    const record = buildReversalRejectionRecord({ ...transferInput, sourceId: '  TR-1001  ' });
    expect(record.sourceId).toBe('TR-1001');
  });
});

describe('H7-A: optional fields omitted safely when absent', () => {
  it('omits evidenceSource / staffId / observedDocumentUpdatedAt when not provided', () => {
    const record = buildReversalRejectionRecord(receivingInput);
    expect('evidenceSource' in record).toBe(false);
    expect('staffId' in record).toBe(false);
    expect('observedDocumentUpdatedAt' in record).toBe(false);
  });

  it('omits optional fields that are null / undefined / whitespace (never stores empty placeholders)', () => {
    const record = buildReversalRejectionRecord({
      ...transferInput,
      evidenceSource: null,
      staffId: undefined,
      observedDocumentUpdatedAt: '   ',
    });
    expect('evidenceSource' in record).toBe(false);
    expect('staffId' in record).toBe(false);
    expect('observedDocumentUpdatedAt' in record).toBe(false);
  });
});

describe('H7-A: no over-collected payload fields', () => {
  it('contains ONLY the whitelisted forensic keys — no raw evidence / item / qty / reason data', () => {
    // Even if a caller passes extra keys, they must not leak into the record.
    const noisy = {
      ...transferInput,
      rawEvidence: { effects: [{ productId: 'p1', qtyBase: 5 }] },
      items: [{ productId: 'p1', qtyBase: 5, lotId: 'L1' }],
      reason: 'a free-text reason that could carry PII',
      note: 'operator note',
      actorRole: 'manager',
      device: 'POS-terminal-3',
    } as unknown as ReversalRejectionRecordInput;
    const record = buildReversalRejectionRecord(noisy);
    const allowed = new Set([
      'recordId',
      'sourceType',
      'sourceId',
      'branchId',
      'evidenceCode',
      'evidenceMessage',
      'evidenceSource',
      'staffId',
      'observedDocumentUpdatedAt',
      'createdAt',
    ]);
    for (const key of Object.keys(record)) {
      expect(allowed.has(key)).toBe(true);
    }
    expect('rawEvidence' in record).toBe(false);
    expect('items' in record).toBe(false);
    expect('reason' in record).toBe(false);
    expect('note' in record).toBe(false);
    expect('actorRole' in record).toBe(false);
    expect('device' in record).toBe(false);
  });
});

describe('H7-A: safe unknown / runtime evidenceCode handling', () => {
  it('accepts an unknown/future code string without coupling to any union', () => {
    const record = buildReversalRejectionRecord({
      ...transferInput,
      evidenceCode: 'header_some_future_code_v2',
    });
    expect(record.evidenceCode).toBe('header_some_future_code_v2');
  });
});

describe('H7-A: deterministic id generation', () => {
  it('produces a stable id for identical inputs', () => {
    expect(buildReversalRejectionRecord(transferInput).recordId).toBe(
      buildReversalRejectionRecord(transferInput).recordId,
    );
  });

  it('createReversalRejectionRecordId matches the id embedded by the builder', () => {
    expect(createReversalRejectionRecordId(transferInput)).toBe(
      buildReversalRejectionRecord(transferInput).recordId,
    );
  });

  it('changes the id when any meaningful field differs', () => {
    const baseId = buildReversalRejectionRecord(transferInput).recordId;
    expect(buildReversalRejectionRecord({ ...transferInput, evidenceCode: 'header_balance_mismatch' }).recordId).not.toBe(
      baseId,
    );
    expect(buildReversalRejectionRecord({ ...transferInput, sourceId: 'TR-9999' }).recordId).not.toBe(baseId);
    expect(buildReversalRejectionRecord({ ...transferInput, createdAt: '2026-06-12T10:00:00.000Z' }).recordId).not.toBe(
      baseId,
    );
  });

  it('is independent of input property order (id derives from normalized content)', () => {
    const reordered: ReversalRejectionRecordInput = {
      createdAt: transferInput.createdAt,
      observedDocumentUpdatedAt: transferInput.observedDocumentUpdatedAt,
      staffId: transferInput.staffId,
      evidenceSource: transferInput.evidenceSource,
      evidenceMessage: transferInput.evidenceMessage,
      evidenceCode: transferInput.evidenceCode,
      branchId: transferInput.branchId,
      sourceId: transferInput.sourceId,
      sourceType: transferInput.sourceType,
    };
    expect(createReversalRejectionRecordId(reordered)).toBe(createReversalRejectionRecordId(transferInput));
  });
});

describe('H7-A: stable serialization', () => {
  it('serializes deterministically (byte-identical for identical records)', () => {
    const a = serializeReversalRejectionRecord(buildReversalRejectionRecord(transferInput));
    const b = serializeReversalRejectionRecord(buildReversalRejectionRecord(transferInput));
    expect(a).toBe(b);
  });

  it('emits keys in canonical order and round-trips via JSON.parse', () => {
    const record = buildReversalRejectionRecord(transferInput);
    const serialized = serializeReversalRejectionRecord(record);
    const expectedOrder = [
      'recordId',
      'sourceType',
      'sourceId',
      'branchId',
      'evidenceCode',
      'evidenceMessage',
      'evidenceSource',
      'staffId',
      'observedDocumentUpdatedAt',
      'createdAt',
    ];
    expect(Object.keys(JSON.parse(serialized) as Record<string, unknown>)).toEqual(expectedOrder);
    expect(JSON.parse(serialized)).toMatchObject({
      sourceType: 'transfer',
      sourceId: 'TR-1001',
      evidenceCode: 'header_total_qty_mismatch',
    });
  });

  it('omits absent optional keys from the serialized form', () => {
    const serialized = serializeReversalRejectionRecord(buildReversalRejectionRecord(receivingInput));
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect('evidenceSource' in parsed).toBe(false);
    expect('staffId' in parsed).toBe(false);
    expect('observedDocumentUpdatedAt' in parsed).toBe(false);
  });
});

describe('H7-A: sourceType separation between transfer and receiving', () => {
  it('keeps transfer and receiving records distinct even with otherwise-identical identity', () => {
    const shared = {
      sourceId: 'DOC-1',
      branchId: 'branch-x',
      evidenceCode: 'missing_items',
      evidenceMessage: 'msg',
      createdAt: '2026-06-12T09:00:00.000Z',
    };
    const transfer = buildReversalRejectionRecord({ ...shared, sourceType: 'transfer' });
    const receiving = buildReversalRejectionRecord({ ...shared, sourceType: 'receiving' });
    expect(transfer.sourceType).toBe('transfer');
    expect(receiving.sourceType).toBe('receiving');
    expect(transfer.recordId).not.toBe(receiving.recordId);
  });
});

describe('H7-A: shape is persistence-ready but NOT persisted now (pure/latent)', () => {
  it('is plain serializable data with no methods or runtime handles', () => {
    const record: ReversalRejectionRecord = buildReversalRejectionRecord(transferInput);
    // Round-trips losslessly through JSON — proves no functions/symbols/store handles leak in.
    const roundTripped = JSON.parse(JSON.stringify(record)) as ReversalRejectionRecord;
    expect(roundTripped).toEqual(record);
    for (const value of Object.values(record)) {
      expect(typeof value).toBe('string');
    }
  });
});
