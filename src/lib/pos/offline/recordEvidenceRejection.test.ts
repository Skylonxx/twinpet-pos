import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordEvidenceRejection, type EvidenceRejectionInput } from './recordEvidenceRejection';
import { listReversalRejections } from './reversalRejectionLog';
import { createInMemoryReversalStore, type ReversalLocalStore } from './reversalLocalStore';

const fixedNow = () => '2026-06-12T09:00:00.000Z';

const receivingInput: EvidenceRejectionInput = {
  sourceType: 'receiving',
  sourceId: 'GRN-2002',
  branchId: 'branch-a',
  evidenceCode: 'missing_lot_id',
  evidenceMessage: 'ไม่สามารถยกเลิกรับเข้าได้: มีรายการสินค้าที่ไม่มีรหัสล็อต',
  staffId: 'mgr-1',
  observedDocumentUpdatedAt: '2026-06-12T08:30:00.000Z',
  now: fixedNow,
};

const transferInput: EvidenceRejectionInput = {
  sourceType: 'transfer',
  sourceId: 'TR-1001',
  branchId: 'branch-origin',
  evidenceCode: 'header_total_qty_mismatch',
  evidenceMessage: 'ไม่สามารถยกเลิกโอนได้: หลักฐานโอนสินค้าไม่ตรงกับยอดรวม',
  staffId: 'mgr-2',
  observedDocumentUpdatedAt: '2026-06-12T08:45:00.000Z',
  now: fixedNow,
};

/** A store whose transact always rejects — to prove the helper swallows async failures. */
function alwaysFailingStore(): ReversalLocalStore {
  return {
    transact() {
      return Promise.reject(new Error('induced storage fault'));
    },
  };
}

// flush microtasks so the fire-and-forget promise (and its .catch) settles
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('H7-E: recordEvidenceRejection — record construction + persistence', () => {
  it('builds and persists a valid receiving rejection record', async () => {
    const store = createInMemoryReversalStore();
    recordEvidenceRejection(store, receivingInput);
    await flush();
    const rows = await listReversalRejections(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: 'receiving',
      sourceId: 'GRN-2002',
      branchId: 'branch-a',
      evidenceCode: 'missing_lot_id',
      evidenceMessage: receivingInput.evidenceMessage,
      staffId: 'mgr-1',
      observedDocumentUpdatedAt: '2026-06-12T08:30:00.000Z',
      createdAt: '2026-06-12T09:00:00.000Z',
    });
  });

  it('builds a valid transfer-shaped record (future reuse; no transfer page wiring here)', async () => {
    const store = createInMemoryReversalStore();
    recordEvidenceRejection(store, transferInput);
    await flush();
    const rows = await listReversalRejections(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: 'transfer', sourceId: 'TR-1001', evidenceCode: 'header_total_qty_mismatch' });
  });

  it('omits evidenceSource from the persisted record', async () => {
    const store = createInMemoryReversalStore();
    recordEvidenceRejection(store, receivingInput);
    await flush();
    const stored = (await listReversalRejections(store))[0];
    expect('evidenceSource' in stored).toBe(false);
  });
});

describe('H7-E: recordEvidenceRejection — best-effort contract', () => {
  it('returns void (not a promise)', () => {
    const store = createInMemoryReversalStore();
    const result = recordEvidenceRejection(store, receivingInput);
    expect(result).toBeUndefined();
  });

  it('catches async storage failures and never throws', async () => {
    expect(() => recordEvidenceRejection(alwaysFailingStore(), receivingInput)).not.toThrow();
    await flush(); // ensure the rejected promise is handled by the internal .catch
  });

  it('catches synchronous build failures and never throws (no row persisted)', async () => {
    const store = createInMemoryReversalStore();
    // Empty required field → buildReversalRejectionRecord throws; the helper must swallow it.
    const bad: EvidenceRejectionInput = { ...receivingInput, branchId: '   ' };
    expect(() => recordEvidenceRejection(store, bad)).not.toThrow();
    await flush();
    expect(await listReversalRejections(store)).toHaveLength(0);
  });

  it('does not leave the async log rejection unhandled', async () => {
    // The fire-and-forget write rejects (alwaysFailingStore). If the helper's internal
    // `.catch(() => {})` were missing, this rejected promise would surface as an unhandled
    // rejection, which vitest treats as a test-run failure. Draining microtasks here gives
    // any unhandled rejection the chance to fire before the test completes.
    recordEvidenceRejection(alwaysFailingStore(), receivingInput);
    await flush();
    await flush();
    expect(true).toBe(true);
  });
});

describe('H7-E: simulated receiving caller path', () => {
  // Mirrors ReceivingEditPage.handleVoid's evidence-error branch — the F1/G1 message is
  // computed first; the helper is dispatched; the original message is still thrown even
  // when logging fails. NOT a real page mount.
  function simulatedReceivingCatch(store: ReversalLocalStore, code: string): never {
    const evidenceMessage = `friendly(${code})`;
    const message = `${evidenceMessage} (รหัส: ${code})`;
    recordEvidenceRejection(store, {
      sourceType: 'receiving',
      sourceId: 'GRN-2002',
      branchId: 'branch-a',
      evidenceCode: code,
      evidenceMessage,
      staffId: 'mgr-1',
      observedDocumentUpdatedAt: '2026-06-12T08:30:00.000Z',
    });
    throw new Error(message);
  }

  it('still throws the original F1/G1 message when logging fails', () => {
    expect(() => simulatedReceivingCatch(alwaysFailingStore(), 'missing_lot_id')).toThrowError(
      'friendly(missing_lot_id) (รหัส: missing_lot_id)',
    );
  });
});

// ─── Source-level assertions for the ReceivingEditPage catch site ─────────────
// (Page components carry a heavy Firebase/router/auth/modal harness — H6-D2 precedent
// proves guarantees by source inspection rather than mounting.)
describe('H7-E: ReceivingEditPage.tsx evidence-error branch (source-level)', () => {
  let source: string;
  beforeEach(async () => {
    source = (await import('../../../pages/ReceivingEditPage.tsx?raw')).default;
  });
  afterEach(() => {
    source = '';
  });

  it('constructs one memoized rejection-log store', () => {
    expect(source).toMatch(/useMemo\(\(\)\s*=>\s*createIndexedDbReversalStore\(\)\s*,\s*\[\]\)/);
  });

  it('calls recordEvidenceRejection inside the receiving evidence-error branch', () => {
    expect(source).toContain('recordEvidenceRejection(');
    expect(source).toContain("sourceType: 'receiving'");
  });

  it('does not await the log call', () => {
    expect(source).not.toMatch(/await\s+recordEvidenceRejection\(/);
  });

  it('still throws new Error(message) in the evidence-error branch', () => {
    expect(source).toMatch(/throw new Error\(message\)/);
  });

  it('non-evidence errors are re-thrown without calling the helper (throw err remains)', () => {
    expect(source).toMatch(/\n\s*throw err;/);
  });
});

describe('H7-F: simulated transfer caller path', () => {
  // Mirrors TransferHistoryPage/AdminTransferPage handleCancel's evidence-error branch —
  // the message is computed first, the toast is SET, then the helper is dispatched. Unlike
  // receiving, the transfer path surfaces via setToast and does NOT re-throw. NOT a mount.
  function simulatedTransferCatch(store: ReversalLocalStore, code: string): string {
    const evidenceMessage = `friendly(${code})`;
    const message = `${evidenceMessage} (รหัส: ${code})`;
    let toast = '';
    const setToast = (m: string) => {
      toast = m;
    };
    setToast(message);
    recordEvidenceRejection(store, {
      sourceType: 'transfer',
      sourceId: 'TR-1001',
      branchId: 'branch-origin',
      evidenceCode: code,
      evidenceMessage,
      staffId: 'mgr-2',
      observedDocumentUpdatedAt: '2026-06-12T08:45:00.000Z',
    });
    return toast;
  }

  it('still sets the original toast message when logging fails', () => {
    expect(simulatedTransferCatch(alwaysFailingStore(), 'header_total_qty_mismatch')).toBe(
      'friendly(header_total_qty_mismatch) (รหัส: header_total_qty_mismatch)',
    );
  });

  it('does not throw out of the transfer catch path when logging fails', () => {
    expect(() =>
      simulatedTransferCatch(alwaysFailingStore(), 'header_total_qty_mismatch'),
    ).not.toThrow();
  });
});

// ─── Source-level assertions for the two transfer catch sites (H7-F) ───────────
// (Page components carry a heavy Firebase/router/auth/modal harness — proven by source
// inspection rather than mounting, per the H6-D2 / H7-E precedent. Each page is loaded
// via a static `?raw` import so Vite can resolve it.)
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function describeTransferCatchSiteSource(
  label: string,
  loadSource: () => Promise<{ default: string }>,
) {
  describe(`H7-F: ${label} evidence-error branch (source-level)`, () => {
    let source: string;
    beforeEach(async () => {
      source = (await loadSource()).default;
    });
    afterEach(() => {
      source = '';
    });

    it('constructs one memoized rejection-log store', () => {
      expect(source).toMatch(/useMemo\(\(\)\s*=>\s*createIndexedDbReversalStore\(\)\s*,\s*\[\]\)/);
    });

    it('calls recordEvidenceRejection exactly once, in the transfer evidence-error branch', () => {
      // Exactly one call site (the import line has no `(`) ⇒ the non-evidence else branch
      // does NOT log.
      expect(countOccurrences(source, 'recordEvidenceRejection(')).toBe(1);
      expect(source).toContain("sourceType: 'transfer'");
    });

    it('uses the transfer origin branch (cancelTarget.fromBranchId) as the record branch', () => {
      expect(source).toContain('branchId: cancelTarget.fromBranchId');
    });

    it('does not await the log call', () => {
      expect(source).not.toMatch(/await\s+recordEvidenceRejection\(/);
    });

    it('still sets the existing operator toast in the evidence branch', () => {
      expect(source).toContain('setToast(message)');
    });
  });
}

describeTransferCatchSiteSource(
  'TransferHistoryPage.tsx',
  () => import('../../../pages/inventory/TransferHistoryPage.tsx?raw'),
);
describeTransferCatchSiteSource(
  'AdminTransferPage.tsx',
  () => import('../../../pages/admin/AdminTransferPage.tsx?raw'),
);
