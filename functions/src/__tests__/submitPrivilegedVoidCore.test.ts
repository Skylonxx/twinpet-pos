import { describe, expect, test } from 'vitest';
import {
  approvalIsSelfApproved,
  buildPrivilegedExecutionBinding,
  buildVoidConsumeBinding,
  consumeBindingRejectedReason,
  decideCanonicalVoidCorrelation,
  derivePrivilegedNonceKey,
  derivePrivilegedVoidExecutionId,
  executionRecordMatchesBinding,
  isAlreadyCanonicallyVoided,
  isSameUtc7Day,
  parsePrivilegedExecutionRecord,
  resumeExecutionRejectedReason,
  timestampToMs,
  utcPlus7Date,
  validateSubmitPrivilegedVoidRequest,
  voidActionMatchesReconcileStatus,
} from '../submitPrivilegedVoidCore';
import { checkApprovalBinding } from '../requestManagerApprovalCore';

const NOW = 1_711_000_000_000;

describe('validateSubmitPrivilegedVoidRequest', () => {
  const base = {
    commandId: 'cmd-1',
    protectedAction: 'VOID_PENDING_SALE',
    targetEntityId: 'O1',
    branchId: 'B1',
  };

  test('accepts a well-formed void request', () => {
    expect(validateSubmitPrivilegedVoidRequest(base)).toEqual({
      ok: true,
      value: { ...base, voidReason: null },
    });
  });

  test('rejects branch ALL, unknown action, and shift-close action', () => {
    expect(validateSubmitPrivilegedVoidRequest({ ...base, branchId: 'ALL' })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
    expect(validateSubmitPrivilegedVoidRequest({ ...base, protectedAction: 'RETURN' })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
    expect(
      validateSubmitPrivilegedVoidRequest({ ...base, protectedAction: 'shift_close_alert_acknowledge' }),
    ).toEqual({ ok: false, code: 'invalid_target' });
  });

  test('ignores managerApproved as a structural field', () => {
    const res = validateSubmitPrivilegedVoidRequest({ ...base, managerApproved: true });
    expect(res.ok).toBe(true);
  });
});

describe('same-day UTC+7 and action matching', () => {
  test('isSameUtc7Day matches the rules offset', () => {
    expect(isSameUtc7Day(NOW, NOW)).toBe(true);
    expect(isSameUtc7Day(NOW - 86_400_000, NOW)).toBe(false);
    expect(utcPlus7Date(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('timestampToMs reads number, Date, and toMillis()', () => {
    expect(timestampToMs(NOW)).toBe(NOW);
    expect(timestampToMs(new Date(NOW))).toBe(NOW);
    expect(timestampToMs({ toMillis: () => NOW })).toBe(NOW);
    expect(timestampToMs(null)).toBeNull();
  });

  test('VOID_PENDING_SALE matches pending_reconcile only', () => {
    expect(voidActionMatchesReconcileStatus('VOID_PENDING_SALE', 'pending_reconcile')).toBe(true);
    expect(voidActionMatchesReconcileStatus('VOID_PENDING_SALE', 'settled')).toBe(false);
    expect(voidActionMatchesReconcileStatus('VOID_SETTLED_SALE', 'settled')).toBe(true);
    expect(voidActionMatchesReconcileStatus('VOID_SETTLED_SALE', 'pending_reconcile')).toBe(false);
  });

  test('already voided detects status and voidReconciled', () => {
    expect(isAlreadyCanonicallyVoided({ status: 'voided' })).toBe(true);
    expect(isAlreadyCanonicallyVoided({ voidReconciled: true })).toBe(true);
    expect(isAlreadyCanonicallyVoided({ status: 'completed' })).toBe(false);
  });
});

describe('nonce key and consume binding', () => {
  test('derivePrivilegedNonceKey is stable sha256-slice-40', () => {
    expect(derivePrivilegedNonceKey('B1', 'appr-1')).toBe(derivePrivilegedNonceKey('B1', 'appr-1'));
    expect(derivePrivilegedNonceKey('B1', 'appr-1')).not.toBe(derivePrivilegedNonceKey('B1', 'appr-2'));
    expect(derivePrivilegedNonceKey('B1', 'appr-1')).toMatch(/^[0-9a-f]{40}$/);
  });

  test('self-approval shape and wrong audience fail closed', () => {
    const expected = buildVoidConsumeBinding({
      protectedAction: 'VOID_PENDING_SALE',
      targetEntityId: 'O1',
      branchId: 'B1',
      commandId: 'cmd-1',
      staffId: 's1',
      authVersion: 0,
    });
    const record = {
      audience: 'privilegedVoid',
      protectedAction: 'VOID_PENDING_SALE',
      targetEntityId: 'O1',
      branchId: 'B1',
      commandId: 'cmd-1',
      requesterStaffId: 's1',
      approverStaffId: 'm1',
      executorStaffId: 's1',
      securityModel: 'delegated' as const,
      authVersionAtIssue: 0,
      credentialVersionAtIssue: 1,
      consumedAt: null,
      expiresAtMillis: NOW + 60_000,
      approverAuthVersionAtIssue: 0,
    };
    expect(checkApprovalBinding(record, expected)).toBe(true);
    expect(approvalIsSelfApproved(record)).toBe(false);
    expect(approvalIsSelfApproved({ ...record, approverStaffId: 's1' })).toBe(true);
    expect(consumeBindingRejectedReason({ ...record, audience: 'resolveShiftCloseAlert' }, expected, NOW)).toBe(
      'invalid_target',
    );
    expect(consumeBindingRejectedReason({ ...record, protectedAction: 'VOID_SETTLED_SALE' }, expected, NOW)).toBe(
      'invalid_target',
    );
    expect(consumeBindingRejectedReason({ ...record, targetEntityId: 'O2' }, expected, NOW)).toBe('invalid_target');
    expect(consumeBindingRejectedReason({ ...record, branchId: 'B2' }, expected, NOW)).toBe('invalid_target');
    expect(consumeBindingRejectedReason({ ...record, expiresAtMillis: NOW }, expected, NOW)).toBe('expired_approval');
    expect(consumeBindingRejectedReason(null, expected, NOW)).toBe('invalid_target');
  });
});

describe('privileged execution record — exact-bound resume', () => {
  const nonceKey = derivePrivilegedNonceKey('B1', 'appr-1');
  const pending = {
    schemaVersion: 1 as const,
    status: 'CONSUMED_PENDING_EXECUTION' as const,
    nonceKey,
    approvalId: 'appr-1',
    commandId: 'cmd-1',
    protectedAction: 'VOID_PENDING_SALE',
    targetEntityId: 'O1',
    branchId: 'B1',
    requesterStaffId: 's1',
    approvingManagerId: 'm1',
    audience: 'privilegedVoid',
    consumedAtMillis: NOW,
    completedAtMillis: null,
    outcomeKind: null,
  };
  const expected = buildPrivilegedExecutionBinding({
    nonceKey,
    approvalId: 'appr-1',
    commandId: 'cmd-1',
    protectedAction: 'VOID_PENDING_SALE',
    targetEntityId: 'O1',
    branchId: 'B1',
    requesterStaffId: 's1',
    approvingManagerId: 'm1',
    audience: 'privilegedVoid',
  });

  test('parse accepts pending and completed records and rejects malformed', () => {
    expect(parsePrivilegedExecutionRecord(pending)).toEqual(pending);
    expect(
      parsePrivilegedExecutionRecord({ ...pending, status: 'COMPLETED', completedAtMillis: NOW, outcomeKind: 'NOOP' }),
    ).toMatchObject({ status: 'COMPLETED', outcomeKind: 'NOOP' });
    expect(parsePrivilegedExecutionRecord({ ...pending, status: 'OPEN' })).toBeNull();
    expect(parsePrivilegedExecutionRecord({ ...pending, requesterStaffId: '' })).toBeNull();
    expect(parsePrivilegedExecutionRecord(null)).toBeNull();
  });

  test('resume matches exact binding and ignores approval TTL', () => {
    expect(executionRecordMatchesBinding(pending, expected)).toBe(true);
    expect(resumeExecutionRejectedReason(pending, expected)).toBeNull();
    expect(resumeExecutionRejectedReason(pending, { ...expected, requesterStaffId: 's2' })).toBe('invalid_target');
    expect(resumeExecutionRejectedReason(pending, { ...expected, protectedAction: 'VOID_SETTLED_SALE' })).toBe(
      'invalid_target',
    );
    expect(resumeExecutionRejectedReason(pending, { ...expected, targetEntityId: 'O2' })).toBe('invalid_target');
    expect(resumeExecutionRejectedReason(pending, { ...expected, branchId: 'B2' })).toBe('invalid_target');
    expect(resumeExecutionRejectedReason(pending, { ...expected, approvalId: 'other' })).toBe('invalid_target');
    expect(resumeExecutionRejectedReason(null, expected)).toBe('invalid_target');
  });

  test('generic voided flags are not exact completion; only matching correlation is', () => {
    const executionId = derivePrivilegedVoidExecutionId(expected);
    expect(derivePrivilegedVoidExecutionId(expected)).toBe(executionId);
    expect(derivePrivilegedVoidExecutionId({ ...expected, commandId: 'other' })).not.toBe(executionId);
    expect(derivePrivilegedVoidExecutionId(expected)).toMatch(/^[0-9a-f]{40}$/);
    expect(decideCanonicalVoidCorrelation({ status: 'completed' }, executionId)).toBe('NOT_VOIDED');
    expect(decideCanonicalVoidCorrelation({ status: 'voided' }, executionId)).toBe('MISSING');
    expect(decideCanonicalVoidCorrelation({ voidReconciled: true }, executionId)).toBe('MISSING');
    expect(
      decideCanonicalVoidCorrelation({ status: 'voided', privilegedVoidExecutionId: executionId }, executionId),
    ).toBe('MATCHING');
    expect(
      decideCanonicalVoidCorrelation({ status: 'voided', privilegedVoidExecutionId: 'other-execution' }, executionId),
    ).toBe('DIFFERENT');
  });
});
