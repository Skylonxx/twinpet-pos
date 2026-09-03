import { describe, expect, test } from 'vitest';
import { LIVE_MANAGER_APPROVAL_ACTIONS, PROTECTED_ACTIONS } from '../managerApprovalTypes';
import {
  ACTION_REQUIREMENTS,
  OAC_SCHEMA_VERSION,
  OAC_VERIFIER_PARAM_MINIMUMS,
  PRIVILEGED_ACTION_ERROR_LABELS,
  PRIVILEGED_ACTION_IDS,
  PRIVILEGED_ACTION_OPERATOR_STATE_LABELS,
  PRIVILEGED_ACTION_OPERATOR_STATES,
  PRIVILEGED_VOID_AUDIENCE,
  getActionRequirement,
  isClosedAllowedActions,
  isPrivilegedActionId,
  privilegedActionSecurityContractManifest,
  validateOacEnvelopeV1,
  validatePrivilegedActionEvidenceV1,
} from './privilegedActionTypes';

const validOac = {
  oacId: 'oac-1',
  schemaVersion: 1,
  managerStaffId: 'm1',
  managerRole: 'manager' as const,
  branchId: 'B1',
  deviceId: 'dev-1',
  allowedActions: ['VOID_PENDING_SALE'] as const,
  authVersionAtIssue: 1,
  credentialVersionAtIssue: 2,
  revocationEpoch: 0,
  issuedAtServerMs: 1_000,
  freshnessExpiresAtServerMs: 86_400_000,
  verifierAlgo: 'argon2id' as const,
  verifierParams: { ...OAC_VERIFIER_PARAM_MINIMUMS },
  verifierSalt: 'salt',
  verifier: 'digest',
  pepperCommitment: 'pep',
  signature: 'sig',
  signingKeyId: 'k1',
};

const validEvidence = {
  evidenceId: 'ev-1',
  schemaVersion: 1,
  privilegedActionRequestId: 'cmd-1',
  actionId: 'VOID_PENDING_SALE' as const,
  targetOrderId: 'O1',
  branchId: 'B1',
  initiatingStaffId: 's1',
  approvingManagerId: 'm1',
  deviceId: 'dev-1',
  localSeq: 1,
  localObservedAtMs: 2_000,
  anchorServerMs: 1_500,
  anchorSeq: 3,
  estimatedApprovalMs: 1_800,
  managerAuthVersionAtIssue: 1,
  managerCredentialVersionAtIssue: 2,
  oacId: 'oac-1',
  oacSchemaVersion: 1,
  revocationEpochAtIssue: 0,
  nonce: 'nonce',
  attemptCount: 0,
  approvalResult: 'APPROVED_LOCAL' as const,
  approvalProofDigest: 'digest',
  localIntentId: 'intent-1',
  resultingVoidIntentId: null,
  syncStatus: 'PRIVILEGED_INTENT_QUEUED' as const,
  serverVerdict: null,
  serverRejectionReason: null,
  manualReviewStatus: 'NOT_REQUIRED' as const,
};

describe('client privileged-action contract', () => {
  test('manager-approval protected actions include the closed void ids', () => {
    expect([...LIVE_MANAGER_APPROVAL_ACTIONS]).toEqual([
      'shift_close_alert_acknowledge',
      'shift_close_alert_resolve',
    ]);
    expect([...PROTECTED_ACTIONS]).toEqual([
      'shift_close_alert_acknowledge',
      'shift_close_alert_resolve',
      'VOID_PENDING_SALE',
      'VOID_SETTLED_SALE',
    ]);
    expect([...PRIVILEGED_ACTION_IDS]).toEqual(['VOID_PENDING_SALE', 'VOID_SETTLED_SALE']);
    expect(isPrivilegedActionId('EXCHANGE')).toBe(false);
    expect(getActionRequirement('unknown')).toBeNull();
    expect(ACTION_REQUIREMENTS.VOID_PENDING_SALE.audience).toBe(PRIVILEGED_VOID_AUDIENCE);
    expect(isClosedAllowedActions(['VOID_SETTLED_SALE'])).toBe(true);
    expect(Object.isFrozen(ACTION_REQUIREMENTS.VOID_SETTLED_SALE.approverRoles)).toBe(true);
    expect(privilegedActionSecurityContractManifest().requirements.VOID_PENDING_SALE.audience).toBe(
      PRIVILEGED_VOID_AUDIENCE,
    );
  });

  test('OAC and evidence validators freeze required authority fields', () => {
    expect(validateOacEnvelopeV1(validOac).ok).toBe(true);
    expect(validateOacEnvelopeV1({ ...validOac, branchId: 'ALL' }).ok).toBe(false);
    expect(validatePrivilegedActionEvidenceV1(validEvidence).ok).toBe(true);
    expect(validatePrivilegedActionEvidenceV1({ ...validEvidence, schemaVersion: 2 }).ok).toBe(false);
    expect(OAC_SCHEMA_VERSION).toBe(1);
  });

  test('Thai labels cover errors and the ten operator states', () => {
    expect(PRIVILEGED_ACTION_ERROR_LABELS.TOO_MANY_ATTEMPTS).toBe('ถูกล็อกชั่วคราว กรุณาติดต่อผู้ดูแล');
    expect(PRIVILEGED_ACTION_OPERATOR_STATES).toHaveLength(10);
    expect(PRIVILEGED_ACTION_OPERATOR_STATE_LABELS.PENDING_PRIVILEGED_INTENT).toBe('รอการอนุมัติจากระบบ');
  });
});
