import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Firebase surface so importing the wrapper has no side effects and the
// callable invocation is observable (node env — no real Functions client). This
// proves the client RESOLVES via the Cloud Function and never writes stock itself.
const callableMock = vi.fn();
vi.mock('../firebase', () => ({ app: { __app: true }, USE_EMULATOR: false }));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({ __fns: true }),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: () => callableMock,
}));

import { resolveTransferDiscrepancy } from './resolveTransferDiscrepancy';

beforeEach(() => callableMock.mockReset());

describe('resolveTransferDiscrepancy (client → Cloud Function wrapper)', () => {
  it('invokes the resolveTransferDiscrepancy callable and returns the adjustmentId', async () => {
    callableMock.mockResolvedValueOnce({ data: { success: true, adjustmentId: 'ADJ-123' } });
    const id = await resolveTransferDiscrepancy({
      transferId: 'TR-1',
      discrepancyId: 'DISC-1',
      branchId: 'BR-ORIGIN',
      staffId: 's1',
      staffName: 'Origin Staff',
      adjustDate: '2026-06-09',
    });
    expect(id).toBe('ADJ-123');
    // Only the server-relevant fields are forwarded (authority comes from the
    // verified token server-side, never the client-supplied branchId).
    expect(callableMock).toHaveBeenCalledWith({
      transferId: 'TR-1',
      discrepancyId: 'DISC-1',
      adjustDate: '2026-06-09',
      reason: undefined,
      staffName: 'Origin Staff',
    });
  });

  it('propagates a permission-denied from the server (e.g. destination caller)', async () => {
    callableMock.mockRejectedValueOnce(
      Object.assign(new Error('เฉพาะสาขาต้นทาง'), { code: 'functions/permission-denied' }),
    );
    await expect(
      resolveTransferDiscrepancy({
        transferId: 'TR-1',
        discrepancyId: 'DISC-1',
        branchId: 'BR-DEST',
        staffId: 's2',
        staffName: 'Dest Staff',
        adjustDate: '2026-06-09',
      }),
    ).rejects.toThrow('เฉพาะสาขาต้นทาง');
  });
});
