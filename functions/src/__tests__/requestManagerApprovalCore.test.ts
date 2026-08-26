import { describe, test, expect } from 'vitest';
import {
  APPROVAL_AUDIENCE,
  APPROVAL_SCHEMA_VERSION,
  APPROVAL_SECURITY_MODEL,
  APPROVAL_TTL_MS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
  PROTECTED_ACTIONS,
  approvalDocHasPinAdjacentField,
  buildApprovalDocument,
  checkApprovalBinding,
  deriveApprovalId,
  deriveAttemptScopeKey,
  expectedActionFor,
  isLockoutActive,
  isProtectedAction,
  nextFailureAttemptState,
  resetAttemptState,
  selectMintOutcome,
  shouldApplyAttemptReset,
  shouldUseRealPinCompare,
  validateManagerApprovalRequest,
  type ApprovalBindingExpected,
  type ApprovalRecordView,
} from '../requestManagerApprovalCore';

const expected: ApprovalBindingExpected = {
  audience: APPROVAL_AUDIENCE,
  protectedAction: 'shift_close_alert_acknowledge',
  targetEntityId: 'S1',
  branchId: 'B1',
  commandId: 'cmd-1',
  staffId: 'm1',
  authVersion: 0,
};

const bound: ApprovalRecordView = {
  audience: APPROVAL_AUDIENCE,
  protectedAction: 'shift_close_alert_acknowledge',
  targetEntityId: 'S1',
  branchId: 'B1',
  commandId: 'cmd-1',
  requesterStaffId: 'm1',
  approverStaffId: 'm1',
  executorStaffId: 'm1',
  securityModel: APPROVAL_SECURITY_MODEL,
  authVersionAtIssue: 0,
  credentialVersionAtIssue: 1,
  consumedAt: null,
  expiresAtMillis: 2_000,
};

describe('deterministic ids', () => {
  test('deriveApprovalId is sha256-slice-40 of the frozen preimage and stable', () => {
    expect(deriveApprovalId('cmd-1')).toBe(deriveApprovalId('cmd-1'));
    expect(deriveApprovalId('cmd-1')).not.toBe(deriveApprovalId('cmd-2'));
    expect(deriveApprovalId('cmd-1')).toMatch(/^[0-9a-f]{40}$/);
  });

  test('deriveAttemptScopeKey is sha256-slice-40 of branch|staff and stable', () => {
    expect(deriveAttemptScopeKey('B1', 'm1')).toBe(deriveAttemptScopeKey('B1', 'm1'));
    expect(deriveAttemptScopeKey('B1', 'm1')).not.toBe(deriveAttemptScopeKey('B1', 'm2'));
    expect(deriveAttemptScopeKey('B1', 'm1')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('protectedAction enum', () => {
  test('freezes exactly the two Packet 2A actions', () => {
    expect([...PROTECTED_ACTIONS]).toEqual([
      'shift_close_alert_acknowledge',
      'shift_close_alert_resolve',
    ]);
    expect(isProtectedAction('shift_close_alert_acknowledge')).toBe(true);
    expect(isProtectedAction('shift_close_alert_resolve')).toBe(true);
    expect(isProtectedAction('closeShift')).toBe(false);
    expect(expectedActionFor('acknowledge')).toBe('shift_close_alert_acknowledge');
    expect(expectedActionFor('resolve')).toBe('shift_close_alert_resolve');
  });
});

describe('validateManagerApprovalRequest', () => {
  const base = {
    commandId: 'cmd-1',
    protectedAction: 'shift_close_alert_acknowledge',
    targetEntityId: 'S1',
    branchId: 'B1',
    pin: '1234',
  };

  test('accepts a well-formed request', () => {
    const res = validateManagerApprovalRequest(base);
    expect(res).toEqual({ ok: true, value: base });
  });

  test('refuses branchId ALL', () => {
    expect(validateManagerApprovalRequest({ ...base, branchId: 'ALL' })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
  });

  test.each([
    ['missing commandId', { commandId: '' }],
    ['missing target', { targetEntityId: '  ' }],
    ['missing branch', { branchId: '' }],
    ['unknown action', { protectedAction: 'other' }],
  ] as const)('%s', (_label, patch) => {
    expect(validateManagerApprovalRequest({ ...base, ...patch })).toEqual({
      ok: false,
      code: 'invalid_target',
    });
  });
});

describe('lockout math', () => {
  test('TTL and lockout constants are frozen', () => {
    expect(APPROVAL_TTL_MS).toBe(120_000);
    expect(LOCKOUT_THRESHOLD).toBe(5);
    expect(LOCKOUT_WINDOW_MS).toBe(900_000);
  });

  test('isLockoutActive is strictly future-lockedUntil', () => {
    expect(isLockoutActive(1_001, 1_000)).toBe(true);
    expect(isLockoutActive(1_000, 1_000)).toBe(false);
    expect(isLockoutActive(null, 1_000)).toBe(false);
  });

  test('the fifth failure in-window sets lockout; a later window starts at 1', () => {
    const t0 = 1_000_000;
    let current = nextFailureAttemptState(null, t0);
    for (let i = 1; i < 4; i++) {
      current = nextFailureAttemptState(
        {
          consecutiveFailures: current.consecutiveFailures,
          firstFailureAtMillis: current.firstFailureAtMillis,
          lockedUntilMillis: current.lockedUntilMillis,
        },
        t0 + i,
      );
    }
    expect(current.consecutiveFailures).toBe(4);
    expect(current.lockedUntilMillis).toBeNull();
    const fifth = nextFailureAttemptState(
      {
        consecutiveFailures: current.consecutiveFailures,
        firstFailureAtMillis: current.firstFailureAtMillis,
        lockedUntilMillis: current.lockedUntilMillis,
      },
      t0 + 4,
    );
    expect(fifth.consecutiveFailures).toBe(5);
    expect(fifth.lockedUntilMillis).toBe(t0 + 4 + LOCKOUT_WINDOW_MS);

    const afterWindow = nextFailureAttemptState(
      {
        consecutiveFailures: 5,
        firstFailureAtMillis: t0,
        lockedUntilMillis: fifth.lockedUntilMillis,
      },
      t0 + LOCKOUT_WINDOW_MS + 1,
    );
    expect(afterWindow.consecutiveFailures).toBe(1);
    expect(afterWindow.lockedUntilMillis).toBeNull();
  });

  test('resetAttemptState clears the counter', () => {
    expect(resetAttemptState()).toEqual({
      consecutiveFailures: 0,
      firstFailureAtMillis: null,
      lastFailureAtMillis: null,
      lockedUntilMillis: null,
    });
  });

  test('shouldApplyAttemptReset skips when a newer failure or lock committed', () => {
    const observed0 = { consecutiveFailures: 0, firstFailureAtMillis: null, lockedUntilMillis: null };
    expect(shouldApplyAttemptReset(null, null)).toBe(true);
    expect(shouldApplyAttemptReset(observed0, observed0)).toBe(true);
    expect(
      shouldApplyAttemptReset(observed0, {
        consecutiveFailures: 1,
        firstFailureAtMillis: 1,
        lockedUntilMillis: null,
      }),
    ).toBe(false);
    expect(
      shouldApplyAttemptReset(
        { consecutiveFailures: 4, firstFailureAtMillis: 1, lockedUntilMillis: null },
        { consecutiveFailures: 5, firstFailureAtMillis: 1, lockedUntilMillis: 1_000 + LOCKOUT_WINDOW_MS },
      ),
    ).toBe(false);
    expect(
      shouldApplyAttemptReset(observed0, {
        consecutiveFailures: 0,
        firstFailureAtMillis: null,
        lockedUntilMillis: 9_000,
      }),
    ).toBe(false);
  });
});

describe('shouldUseRealPinCompare', () => {
  const ok = {
    credentialExists: true,
    usableForLogin: true,
    disabled: false,
    credentialState: 'rotated_authoritative',
    pin: '1234',
  };

  test('real only when canonical usable rotated PIN is well formed', () => {
    expect(shouldUseRealPinCompare(ok)).toBe(true);
  });

  test.each([
    ['missing credential', { credentialExists: false }],
    ['unusable', { usableForLogin: false }],
    ['disabled', { disabled: true }],
    ['pre-rotation', { credentialState: 'backfilled_not_trusted' }],
    ['malformed PIN', { pin: '12' }],
  ] as const)('%s uses dummy', (_label, patch) => {
    expect(shouldUseRealPinCompare({ ...ok, ...patch })).toBe(false);
  });
});

describe('buildApprovalDocument', () => {
  test('emits the frozen field set with same-principal staff ids and no PIN-adjacent keys', () => {
    const doc = buildApprovalDocument({
      commandId: 'cmd-1',
      protectedAction: 'shift_close_alert_acknowledge',
      targetEntityId: 'S1',
      branchId: 'B1',
      staffId: 'm1',
      approverRole: 'manager',
      authVersionAtIssue: 0,
      credentialVersionAtIssue: 1,
    });
    expect(doc).toEqual({
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      audience: APPROVAL_AUDIENCE,
      protectedAction: 'shift_close_alert_acknowledge',
      targetEntityId: 'S1',
      branchId: 'B1',
      commandId: 'cmd-1',
      requesterStaffId: 'm1',
      approverStaffId: 'm1',
      executorStaffId: 'm1',
      approverRole: 'manager',
      securityModel: APPROVAL_SECURITY_MODEL,
      authVersionAtIssue: 0,
      credentialVersionAtIssue: 1,
      consumedAt: null,
      consumedByStaffId: null,
      consumingAudience: null,
      consumedCaseVersion: null,
    });
    expect(approvalDocHasPinAdjacentField(doc as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('checkApprovalBinding', () => {
  test('positive: identical same-principal reauth binding', () => {
    expect(checkApprovalBinding(bound, expected)).toBe(true);
  });

  test.each([
    ['audience', { audience: 'other' }],
    ['protectedAction', { protectedAction: 'shift_close_alert_resolve' }],
    ['targetEntityId', { targetEntityId: 'S2' }],
    ['branchId', { branchId: 'B2' }],
    ['commandId', { commandId: 'cmd-x' }],
    ['requesterStaffId', { requesterStaffId: 'm9' }],
    ['approverStaffId', { approverStaffId: 'm9' }],
    ['executorStaffId', { executorStaffId: 'm9' }],
    ['securityModel', { securityModel: 'delegated' }],
    ['authVersionAtIssue', { authVersionAtIssue: 7 }],
  ] as const)('negative: %s', (_label, patch) => {
    expect(checkApprovalBinding({ ...bound, ...patch }, expected)).toBe(false);
  });
});

describe('selectMintOutcome — after compare only', () => {
  test('wrong PIN is always invalid_credentials regardless of record state', () => {
    expect(selectMintOutcome(false, null, expected, 1_000)).toBe('invalid_credentials');
    expect(selectMintOutcome(false, bound, expected, 1_000)).toBe('invalid_credentials');
    expect(selectMintOutcome(false, { ...bound, consumedAt: 1 }, expected, 1_000)).toBe('invalid_credentials');
    expect(selectMintOutcome(false, { ...bound, expiresAtMillis: 1 }, expected, 1_000)).toBe('invalid_credentials');
    expect(selectMintOutcome(false, { ...bound, branchId: 'B2' }, expected, 1_000)).toBe('invalid_credentials');
  });

  test('correct PIN selects the record-state outcome', () => {
    expect(selectMintOutcome(true, null, expected, 1_000)).toBe('new_mint');
    expect(selectMintOutcome(true, bound, expected, 1_000)).toBe('idempotent');
    expect(selectMintOutcome(true, { ...bound, consumedAt: 1 }, expected, 1_000)).toBe('replayed_approval');
    expect(selectMintOutcome(true, { ...bound, expiresAtMillis: 1_000 }, expected, 1_000)).toBe('expired_approval');
    expect(selectMintOutcome(true, { ...bound, branchId: 'B2' }, expected, 1_000)).toBe('invalid_target');
  });
});
