import { describe, it, expect, vi } from 'vitest';
import { callRequestManagerApproval, type RequestManagerApprovalTransport } from './requestManagerApproval';
import {
  MANAGER_APPROVAL_ERROR_LABELS,
  type ManagerApprovalErrorCode,
  type RequestManagerApprovalClientRequest,
} from './managerApprovalTypes';

const baseReq: RequestManagerApprovalClientRequest = {
  commandId: 'cmd-1',
  protectedAction: 'shift_close_alert_acknowledge',
  targetEntityId: 'S1',
  branchId: 'B1',
  pin: '1234',
};

const SERVER_CODES: ManagerApprovalErrorCode[] = [
  'invalid_credentials',
  'not_authorized',
  'branch_mismatch',
  'invalid_target',
  'locked',
  'expired_approval',
  'replayed_approval',
  'self_approval_not_permitted',
  'approver_not_eligible',
];

function injected(response: unknown): RequestManagerApprovalTransport {
  return vi.fn().mockResolvedValue(response);
}

describe('callRequestManagerApproval', () => {
  it('forwards the request to the injected transport unchanged', async () => {
    const transport = injected({ ok: true, approvalId: 'appr-1', expiresAtMillis: 1_800 });
    await callRequestManagerApproval(baseReq, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(baseReq);
  });

  it('maps a well-formed success response', async () => {
    const result = await callRequestManagerApproval(
      baseReq,
      injected({ ok: true, approvalId: 'appr-1', expiresAtMillis: 1_800 }),
    );
    expect(result).toEqual({ kind: 'ok', approvalId: 'appr-1', expiresAtMillis: 1_800 });
  });

  it.each(SERVER_CODES)('maps server error %s to the frozen Thai label code', async (code) => {
    const result = await callRequestManagerApproval(baseReq, injected({ ok: false, code }));
    expect(result).toEqual({ kind: 'error', code });
    expect(MANAGER_APPROVAL_ERROR_LABELS[code]).toBeTruthy();
  });

  it('rejected transport becomes verifier_unavailable and never throws', async () => {
    const transport: RequestManagerApprovalTransport = vi.fn().mockRejectedValue(new Error('down'));
    await expect(callRequestManagerApproval(baseReq, transport)).resolves.toEqual({
      kind: 'error',
      code: 'verifier_unavailable',
    });
  });

  it('malformed success/error shapes become verifier_unavailable', async () => {
    await expect(callRequestManagerApproval(baseReq, injected(null))).resolves.toEqual({
      kind: 'error',
      code: 'verifier_unavailable',
    });
    await expect(callRequestManagerApproval(baseReq, injected({ ok: true }))).resolves.toEqual({
      kind: 'error',
      code: 'verifier_unavailable',
    });
    await expect(callRequestManagerApproval(baseReq, injected({ ok: false, code: 'nope' }))).resolves.toEqual({
      kind: 'error',
      code: 'verifier_unavailable',
    });
    await expect(callRequestManagerApproval(baseReq, injected({ ok: false, code: 'offline' }))).resolves.toEqual({
      kind: 'error',
      code: 'verifier_unavailable',
    });
  });

  it('forwards optional Model 2 fields unchanged', async () => {
    const transport = injected({ ok: true, approvalId: 'appr-2', expiresAtMillis: 2_000 });
    const delegated: RequestManagerApprovalClientRequest = {
      ...baseReq,
      securityModel: 'delegated',
      approverStaffId: 'm9',
    };
    await callRequestManagerApproval(delegated, transport);
    expect(transport).toHaveBeenCalledWith(delegated);
  });

  it('maps no_eligible_approver from a well-formed server-shaped error', async () => {
    const result = await callRequestManagerApproval(
      baseReq,
      injected({ ok: false, code: 'no_eligible_approver' }),
    );
    expect(result).toEqual({ kind: 'error', code: 'no_eligible_approver' });
    expect(MANAGER_APPROVAL_ERROR_LABELS.no_eligible_approver).toBeTruthy();
  });

  it('never copies the PIN into diagnostic fields of the returned result', async () => {
    const results = [
      await callRequestManagerApproval(baseReq, injected({ ok: true, approvalId: 'appr-1', expiresAtMillis: 1 })),
      await callRequestManagerApproval(baseReq, injected({ ok: false, code: 'invalid_credentials' })),
      await callRequestManagerApproval(baseReq, injected({ ok: false, code: 'invalid_credentials', pin: '1234' })),
      await callRequestManagerApproval(baseReq, vi.fn().mockRejectedValue(new Error('PIN 1234 leaked'))),
    ];
    for (const result of results) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('1234');
      expect(serialized).not.toMatch(/"pin"/);
    }
  });
});
