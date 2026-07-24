import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors retryReconcile.test.ts's Firebase-surface mock — no real network call.
const callableMock = vi.fn();
vi.mock('../../firebase', () => ({ app: { __app: true }, USE_EMULATOR: false }));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({ __fns: true }),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: () => callableMock,
}));

import {
  callResolveShiftCloseAlert,
  type ResolveShiftCloseAlertAdapterRequest,
  type ResolveShiftCloseAlertTransport,
} from './resolveShiftCloseAlertAdapter';

beforeEach(() => callableMock.mockReset());

const baseReq: ResolveShiftCloseAlertAdapterRequest = {
  commandId: 'cmd-1',
  shiftId: 'SHIFT-001',
  branchId: 'BR-001',
  expectedCaseVersion: 2,
  requestedOutcome: 'acknowledge',
  reasonCode: 'drawer_discrepancy',
};

function injected(response: unknown): ResolveShiftCloseAlertTransport {
  return vi.fn().mockResolvedValue(response);
}

function injectedRejecting(error: unknown): ResolveShiftCloseAlertTransport {
  return vi.fn().mockRejectedValue(error);
}

describe('callResolveShiftCloseAlert — success responses', () => {
  it('accepts ok:true, confirmed, no rejectCode', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', newAlertState: 'acknowledged' }),
    );
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.response.status).toBe('confirmed');
      expect(result.response.newAlertState).toBe('acknowledged');
    }
  });

  it('accepts ok:true, duplicate_confirmed, no rejectCode', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'duplicate_confirmed' }),
    );
    expect(result.kind).toBe('response');
    if (result.kind === 'response') expect(result.response.status).toBe('duplicate_confirmed');
  });

  it('an absent optional success field does not convert valid success into failure', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed' }),
    );
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.response.newAlertState).toBeUndefined();
      expect(result.response.auditEventId).toBeUndefined();
    }
  });
});

describe('callResolveShiftCloseAlert — rejected responses', () => {
  // Frozen matrix: `stale_case_version` is valid ONLY paired with
  // `conflict_requires_manual_review` (see the conflict-responses describe
  // block below) — it is deliberately excluded from this "rejected" list.
  const rejectCodes = [
    'unauthorized',
    'invalid_pin',
    'invalid_payload',
    'case_not_found',
    'alert_not_open',
    'invalid_outcome_transition',
    'server_error',
  ] as const;

  for (const code of rejectCodes) {
    it(`accepts ok:false, rejected, rejectCode ${code}`, async () => {
      const result = await callResolveShiftCloseAlert(
        baseReq,
        injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'rejected', rejectCode: code }),
      );
      expect(result.kind).toBe('response');
      if (result.kind === 'response') {
        expect(result.response.status).toBe('rejected');
        expect(result.response.rejectCode).toBe(code);
      }
    });
  }

  it('rejected without a rejectCode is malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'rejected' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('rejected + stale_case_version is malformed (frozen matrix restricts stale_case_version to conflict only)', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'rejected', rejectCode: 'stale_case_version' }),
    );
    expect(result.kind).toBe('malformed_response');
  });
});

describe('callResolveShiftCloseAlert — conflict responses', () => {
  it('accepts conflict_requires_manual_review with stale_case_version', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'conflict_requires_manual_review', rejectCode: 'stale_case_version' }),
    );
    expect(result.kind).toBe('response');
    if (result.kind === 'response') expect(result.response.status).toBe('conflict_requires_manual_review');
  });

  it('accepts conflict_requires_manual_review with invalid_payload', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'conflict_requires_manual_review', rejectCode: 'invalid_payload' }),
    );
    expect(result.kind).toBe('response');
  });

  it('rejects conflict_requires_manual_review with an unsupported rejectCode as malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'conflict_requires_manual_review', rejectCode: 'server_error' }),
    );
    expect(result.kind).toBe('malformed_response');
  });
});

describe('callResolveShiftCloseAlert — malformed responses', () => {
  it('null is malformed', async () => {
    expect((await callResolveShiftCloseAlert(baseReq, injected(null))).kind).toBe('malformed_response');
  });

  it('an array is malformed', async () => {
    expect((await callResolveShiftCloseAlert(baseReq, injected([1, 2, 3]))).kind).toBe('malformed_response');
  });

  it('a non-object primitive is malformed', async () => {
    expect((await callResolveShiftCloseAlert(baseReq, injected('confirmed'))).kind).toBe('malformed_response');
  });

  it('a mismatched echoed commandId is malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'wrong-id', shiftId: 'SHIFT-001', status: 'confirmed' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('a mismatched echoed shiftId is malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'WRONG-SHIFT', status: 'confirmed' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('an invalid status enum value is malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'not-a-real-status' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('an invalid optional newAlertState enum value is malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', newAlertState: 'bogus' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('an invalid optional newSettlementState enum value is malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', newSettlementState: 'bogus' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('a non-string optional auditEventId/confirmedAtServer is malformed', async () => {
    const r1 = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', auditEventId: 123 }),
    );
    expect(r1.kind).toBe('malformed_response');
    const r2 = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', confirmedAtServer: 123 }),
    );
    expect(r2.kind).toBe('malformed_response');
  });

  it('ok:true with an invalid rejectCode present is malformed', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', rejectCode: 'server_error' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('ok:false with status confirmed is malformed (ok/status must agree)', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed' }),
    );
    expect(result.kind).toBe('malformed_response');
  });

  it('a Thai server message never changes classification either way', async () => {
    const success = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', message: 'สำเร็จ' }),
    );
    expect(success.kind).toBe('response');

    const malformed = await callResolveShiftCloseAlert(
      baseReq,
      injected({ ok: false, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed', message: 'ข้อความปลอม' }),
    );
    expect(malformed.kind).toBe('malformed_response');
  });
});

describe('callResolveShiftCloseAlert — transport failures', () => {
  it('never throws on a rejected transport promise', async () => {
    await expect(callResolveShiftCloseAlert(baseReq, injectedRejecting(new Error('network down')))).resolves.toBeDefined();
  });

  it('captures a Firebase error code when present', async () => {
    const result = await callResolveShiftCloseAlert(
      baseReq,
      injectedRejecting(Object.assign(new Error('unavailable'), { code: 'functions/unavailable' })),
    );
    expect(result.kind).toBe('transport_failure');
    if (result.kind === 'transport_failure') expect(result.code).toBe('functions/unavailable');
  });

  it('omits code when the thrown value carries none, and preserves cause for diagnostics only', async () => {
    const cause = new Error('plain failure');
    const result = await callResolveShiftCloseAlert(baseReq, injectedRejecting(cause));
    expect(result.kind).toBe('transport_failure');
    if (result.kind === 'transport_failure') {
      expect(result.code).toBeUndefined();
      expect(result.cause).toBe(cause);
    }
  });
});

describe('callResolveShiftCloseAlert — default transport wiring', () => {
  it('uses the injected transport when provided (no real network call attempted)', async () => {
    const transport = injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed' });
    await callResolveShiftCloseAlert(baseReq, transport);
    expect(transport).toHaveBeenCalledWith(baseReq);
    expect(callableMock).not.toHaveBeenCalled();
  });

  it('never forwards a `reasonNote: null` request property to the transport (RC-1 — the deployed contract accepts only an absent or string reasonNote)', async () => {
    const transport = injected({ ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed' });
    await callResolveShiftCloseAlert(baseReq, transport);
    const forwarded = (transport as ReturnType<typeof vi.fn>).mock.calls[0][0] as ResolveShiftCloseAlertAdapterRequest;
    expect(forwarded.reasonNote).not.toBeNull();
    expect('reasonNote' in forwarded).toBe(false);
  });

  it('falls back to the default Firebase callable transport when none injected', async () => {
    callableMock.mockResolvedValueOnce({ data: { ok: true, commandId: 'cmd-1', shiftId: 'SHIFT-001', status: 'confirmed' } });
    const result = await callResolveShiftCloseAlert(baseReq);
    expect(callableMock).toHaveBeenCalledWith(baseReq);
    expect(result.kind).toBe('response');
  });
});
