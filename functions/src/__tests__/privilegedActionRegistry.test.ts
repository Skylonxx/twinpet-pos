import { describe, expect, test } from 'vitest';
import {
  ACTION_REQUIREMENTS,
  OAC_SCHEMA_VERSION,
  OAC_VERIFIER_PARAM_MINIMUMS,
  PRIVILEGED_ACTION_ERROR_LABELS,
  PRIVILEGED_ACTION_IDS,
  PRIVILEGED_ACTION_OPERATOR_STATES,
  PRIVILEGED_VOID_AUDIENCE,
  getActionRequirement,
  isClosedAllowedActions,
  isPrivilegedActionId,
  privilegedActionSecurityContractManifest,
  validateOacEnvelopeV1,
  validatePrivilegedActionEvidenceV1,
} from '../privilegedActionRegistry';

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

describe('ACTION_REQUIREMENTS allowlist', () => {
  test('registers only current void actions with privilegedVoid and pos_void', () => {
    expect([...PRIVILEGED_ACTION_IDS]).toEqual(['VOID_PENDING_SALE', 'VOID_SETTLED_SALE']);
    expect(isPrivilegedActionId('RETURN')).toBe(false);
    expect(getActionRequirement('RETURN')).toBeNull();
    expect(getActionRequirement('VOID_PENDING_SALE')).toEqual({
      audience: PRIVILEGED_VOID_AUDIENCE,
      requesterPermission: 'pos_void',
      approverPermission: 'pos_void',
      approverRoles: ['manager', 'admin'],
      exactBranchRequired: true,
    });
    expect(ACTION_REQUIREMENTS.VOID_SETTLED_SALE.audience).toBe(PRIVILEGED_VOID_AUDIENCE);
  });

  test('nested approverRoles cannot be mutated', () => {
    expect(Object.isFrozen(ACTION_REQUIREMENTS)).toBe(true);
    expect(Object.isFrozen(ACTION_REQUIREMENTS.VOID_PENDING_SALE)).toBe(true);
    expect(Object.isFrozen(ACTION_REQUIREMENTS.VOID_PENDING_SALE.approverRoles)).toBe(true);
    expect(() => {
      (ACTION_REQUIREMENTS.VOID_PENDING_SALE.approverRoles as unknown as string[]).push('staff');
    }).toThrow();
    expect([...ACTION_REQUIREMENTS.VOID_PENDING_SALE.approverRoles]).toEqual(['manager', 'admin']);
  });

  test('security contract manifest enumerates ids, audience, and permissions', () => {
    expect(privilegedActionSecurityContractManifest()).toEqual({
      actionIds: ['VOID_PENDING_SALE', 'VOID_SETTLED_SALE'],
      requirements: {
        VOID_PENDING_SALE: {
          audience: PRIVILEGED_VOID_AUDIENCE,
          requesterPermission: 'pos_void',
          approverPermission: 'pos_void',
          approverRoles: ['manager', 'admin'],
          exactBranchRequired: true,
        },
        VOID_SETTLED_SALE: {
          audience: PRIVILEGED_VOID_AUDIENCE,
          requesterPermission: 'pos_void',
          approverPermission: 'pos_void',
          approverRoles: ['manager', 'admin'],
          exactBranchRequired: true,
        },
      },
    });
  });

  test('allowedActions is a closed non-empty unique set', () => {
    expect(isClosedAllowedActions(['VOID_PENDING_SALE', 'VOID_SETTLED_SALE'])).toBe(true);
    expect(isClosedAllowedActions([])).toBe(false);
    expect(isClosedAllowedActions(['VOID_PENDING_SALE', 'VOID_PENDING_SALE'])).toBe(false);
    expect(isClosedAllowedActions(['VOID_PENDING_SALE', 'REFUND'])).toBe(false);
  });
});

describe('OAC envelope contract', () => {
  test('accepts a fully populated v1 envelope', () => {
    const result = validateOacEnvelopeV1(validOac);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.schemaVersion).toBe(OAC_SCHEMA_VERSION);
  });

  test('rejects branch ALL, unknown actions, missing authority fields, and weak params', () => {
    expect(validateOacEnvelopeV1({ ...validOac, branchId: 'ALL' }).ok).toBe(false);
    expect(validateOacEnvelopeV1({ ...validOac, allowedActions: [] }).ok).toBe(false);
    expect(validateOacEnvelopeV1({ ...validOac, allowedActions: ['REFUND'] }).ok).toBe(false);
    expect(validateOacEnvelopeV1({ ...validOac, managerStaffId: '' }).ok).toBe(false);
    expect(validateOacEnvelopeV1({ ...validOac, verifierParams: { ...OAC_VERIFIER_PARAM_MINIMUMS, m: 1 } }).ok).toBe(
      false,
    );
    const { signature: _omit, ...unsigned } = validOac;
    expect(validateOacEnvelopeV1(unsigned).ok).toBe(false);
  });
});

describe('PrivilegedActionEvidenceV1 contract', () => {
  test('accepts a fully populated v1 record including null server fields', () => {
    expect(validatePrivilegedActionEvidenceV1(validEvidence).ok).toBe(true);
  });

  test('rejects branch ALL, unknown action, and missing required keys', () => {
    expect(validatePrivilegedActionEvidenceV1({ ...validEvidence, branchId: 'ALL' }).ok).toBe(false);
    expect(validatePrivilegedActionEvidenceV1({ ...validEvidence, actionId: 'REFUND' }).ok).toBe(false);
    const { nonce: _omit, ...missing } = validEvidence;
    expect(validatePrivilegedActionEvidenceV1(missing).ok).toBe(false);
  });
});

describe('error and operator vocabulary', () => {
  test('Thai labels exist for every frozen error and operator state', () => {
    expect(PRIVILEGED_ACTION_ERROR_LABELS.DENIED_INVALID_PIN).toBe('PIN ไม่ถูกต้อง');
    expect(PRIVILEGED_ACTION_ERROR_LABELS.APPROVAL_UNAVAILABLE).toContain('ออฟไลน์');
    expect(PRIVILEGED_ACTION_OPERATOR_STATES).toHaveLength(10);
  });
});
