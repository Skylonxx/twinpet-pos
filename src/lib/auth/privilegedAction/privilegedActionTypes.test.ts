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
import * as clientOfflineAdjudication from './privilegedActionTypes';
import * as serverOfflineAdjudication from '../../../../functions/src/privilegedActionRegistry';

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

// ── SEC-001 Packet D / D-1B offline-adjudication vocabularies ──────────────

describe('AC-9 — D-1B offline adjudication enum parity and cardinality', () => {
  const VOCABULARIES = [
    ['OFFLINE_ADJUDICATION_PROTOCOL_REASONS', 8],
    ['OFFLINE_ADJUDICATION_REJECTION_REASONS', 32],
    ['OFFLINE_ADJUDICATION_MANUAL_ATTENTION_REASONS', 3],
    ['OFFLINE_ADJUDICATION_ANOMALY_REASONS', 2],
    ['OFFLINE_ADJUDICATION_RETRY_REASONS', 3],
    ['OFFLINE_ADJUDICATION_RECOVERABILITY_CLASSES', 3],
    ['OFFLINE_ADJUDICATION_RECORD_STATES', 4],
    ['OFFLINE_ADJUDICATION_RESPONSE_KINDS', 7],
  ] as const;

  test('cardinality is exactly 8 / 32 / 3 / 2 / 3 / 3 / 4, plus 7 response kinds', () => {
    for (const [name, expected] of VOCABULARIES) {
      const client = (clientOfflineAdjudication as unknown as Record<string, readonly string[]>)[name];
      expect(client, name).toHaveLength(expected);
      expect(new Set(client).size, name).toBe(expected);
    }
    expect(clientOfflineAdjudication.OFFLINE_ADJUDICATION_VOCABULARY_CARDINALITY).toEqual({
      protocolReasons: 8,
      rejectionReasons: 32,
      manualAttentionReasons: 3,
      anomalyReasons: 2,
      retryReasons: 3,
      recoverabilityClasses: 3,
      recordStates: 4,
      responseKinds: 7,
    });
    // 48 closed machine reason strings across the five reason enums.
    const reasonStrings =
      clientOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASONS.length +
      clientOfflineAdjudication.OFFLINE_ADJUDICATION_REJECTION_REASONS.length +
      clientOfflineAdjudication.OFFLINE_ADJUDICATION_MANUAL_ATTENTION_REASONS.length +
      clientOfflineAdjudication.OFFLINE_ADJUDICATION_ANOMALY_REASONS.length +
      clientOfflineAdjudication.OFFLINE_ADJUDICATION_RETRY_REASONS.length;
    expect(reasonStrings).toBe(48);
  });

  test('exact set equality with functions/src/privilegedActionRegistry.ts', () => {
    for (const [name] of VOCABULARIES) {
      const client = (clientOfflineAdjudication as unknown as Record<string, readonly string[]>)[name];
      const server = (serverOfflineAdjudication as unknown as Record<string, readonly string[]>)[name];
      expect(server, name).toBeDefined();
      // Order is part of the contract, not just membership.
      expect([...client], name).toEqual([...server]);
    }
    expect(clientOfflineAdjudication.PRIVILEGED_OFFLINE_ADJUDICATIONS_COLLECTION).toBe(
      serverOfflineAdjudication.PRIVILEGED_OFFLINE_ADJUDICATIONS_COLLECTION,
    );
    expect(clientOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY).toEqual(
      serverOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY,
    );
    expect(clientOfflineAdjudication.OFFLINE_ADJUDICATION_VOCABULARY_CARDINALITY).toEqual(
      serverOfflineAdjudication.OFFLINE_ADJUDICATION_VOCABULARY_CARDINALITY,
    );
  });

  test('the anomaly family is disjoint from every other reason family', () => {
    const others = new Set<string>([
      ...clientOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASONS,
      ...clientOfflineAdjudication.OFFLINE_ADJUDICATION_REJECTION_REASONS,
      ...clientOfflineAdjudication.OFFLINE_ADJUDICATION_MANUAL_ATTENTION_REASONS,
      ...clientOfflineAdjudication.OFFLINE_ADJUDICATION_RETRY_REASONS,
    ]);
    for (const reason of clientOfflineAdjudication.OFFLINE_ADJUDICATION_ANOMALY_REASONS) {
      expect(others.has(reason), reason).toBe(false);
    }
  });

  test('the three PERMANENT reasons are exactly the bytes-only prefix (PERM-1)', () => {
    const permanent = clientOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASONS.filter(
      (r) => clientOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY[r] === 'PERMANENT',
    );
    expect(permanent).toEqual([...clientOfflineAdjudication.OFFLINE_ADJUDICATION_PERMANENT_BYTE_REASONS]);
    expect(permanent).toEqual(['request_shape_invalid', 'attestation_base64_invalid', 'attestation_malformed']);
    // Every protocol reason carries exactly one lattice value.
    for (const reason of clientOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASONS) {
      expect(
        clientOfflineAdjudication.OFFLINE_ADJUDICATION_RECOVERABILITY_CLASSES,
        reason,
      ).toContain(clientOfflineAdjudication.OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY[reason]);
    }
  });

  test('the record state machine has exactly four legal transitions and no terminal exit', () => {
    const { OFFLINE_ADJUDICATION_LEGAL_TRANSITIONS, isLegalOfflineAdjudicationTransition } =
      clientOfflineAdjudication;
    expect(OFFLINE_ADJUDICATION_LEGAL_TRANSITIONS).toHaveLength(4);
    expect(isLegalOfflineAdjudicationTransition(null, 'TERMINALLY_REJECTED')).toBe(true);
    expect(isLegalOfflineAdjudicationTransition(null, 'CONSUMED_PENDING_EXECUTION')).toBe(true);
    expect(isLegalOfflineAdjudicationTransition('CONSUMED_PENDING_EXECUTION', 'COMPLETED')).toBe(true);
    expect(isLegalOfflineAdjudicationTransition('CONSUMED_PENDING_EXECUTION', 'MANUAL_ATTENTION_REQUIRED')).toBe(
      true,
    );
    // Exhaustive: no transition leaves any terminal state, and ∅ cannot reach one.
    for (const from of clientOfflineAdjudication.OFFLINE_ADJUDICATION_RECORD_STATES) {
      for (const to of clientOfflineAdjudication.OFFLINE_ADJUDICATION_RECORD_STATES) {
        const legal = from === 'CONSUMED_PENDING_EXECUTION' && (to === 'COMPLETED' || to === 'MANUAL_ATTENTION_REQUIRED');
        expect(isLegalOfflineAdjudicationTransition(from, to), `${from}->${to}`).toBe(legal);
      }
      if (from !== 'TERMINALLY_REJECTED' && from !== 'CONSUMED_PENDING_EXECUTION') {
        expect(isLegalOfflineAdjudicationTransition(null, from), `∅->${from}`).toBe(false);
      }
    }
  });

  test('the type guards are closed on both sides of the contract', () => {
    expect(clientOfflineAdjudication.isOfflineAdjudicationProtocolReason('attestation_malformed')).toBe(true);
    expect(clientOfflineAdjudication.isOfflineAdjudicationProtocolReason('made_up')).toBe(false);
    expect(clientOfflineAdjudication.isOfflineAdjudicationRejectionReason('device_not_active')).toBe(true);
    expect(clientOfflineAdjudication.isOfflineAdjudicationRejectionReason('adjudication_record_unreadable')).toBe(
      false,
    );
    expect(clientOfflineAdjudication.isOfflineAdjudicationAnomalyReason('adjudication_record_unreadable')).toBe(true);
    expect(clientOfflineAdjudication.isOfflineAdjudicationManualAttentionReason('canonical_correlation_missing')).toBe(
      true,
    );
    expect(clientOfflineAdjudication.isOfflineAdjudicationRetryReason('internal_error')).toBe(true);
    expect(clientOfflineAdjudication.isOfflineAdjudicationRecordState('COMPLETED')).toBe(true);
    expect(clientOfflineAdjudication.isOfflineAdjudicationRecordState('CONSUMED')).toBe(false);
    expect(clientOfflineAdjudication.isOfflineAdjudicationOutcomeKind('VOID_TOMBSTONED')).toBe(true);
    expect(clientOfflineAdjudication.isOfflineAdjudicationOutcomeKind('VOIDED')).toBe(false);
  });
});
