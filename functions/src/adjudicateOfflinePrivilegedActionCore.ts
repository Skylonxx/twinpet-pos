/**
 * adjudicateOfflinePrivilegedActionCore — SEC-001 Packet D / D-1B.
 *
 * Adjudicates a `PAA1` offline privileged-action attestation. The frame is
 * *signed evidence*, never current authority: a record-absent submission is
 * revalidated against live state in full, and only the server may terminalize.
 *
 * Ordering is Stage P → Stage R → Stage F, and that order is load-bearing:
 *
 *   P  bytes-only parse and candidate identity, after the minimum relay gate.
 *      The three PERMANENT protocol reasons are decided here and nowhere else.
 *   R  durable replay anchor, read BEFORE any mutable device-registry state, so
 *      a terminal verdict stays replay-stable across key rotation and
 *      re-enrollment (TR-1). Stage R never writes.
 *   F  fresh-attestation authentication and Class-B adjudication — reached only
 *      when Stage R found no record, and the only stage that reads
 *      `privilegedDeviceRegistrations`, verifies a signature, or creates a record.
 *
 * The current authenticated caller is a transport relay (Model B): it adds zero
 * authority, cannot alter the bound action/target/actor/manager/device, and the
 * order remains attributed to the original initiating staff.
 */

import { createHash, verify as ed25519Verify } from 'node:crypto';
import { type DocumentData, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';
import { isUsableForLogin, readUserCredential } from './credentialStore';
import {
  StagedRoleDenyHeadMalformedError,
  decideLiveRolePermission,
  firestoreStagedRoleDenyHeadReader,
  liveRoleHoldsPosVoid,
  readRolePermissionsDoc,
  type RolePermissionsDocSnapshot,
  type RolePermissionsReader,
  type StagedRoleDenyHead,
  type StagedRoleDenyHeadReader,
} from './privilegedActionAuthority';
import {
  PRIVILEGED_OFFLINE_ADJUDICATIONS_COLLECTION,
  PRIVILEGED_REQUESTER_PERMISSION,
  PRIVILEGED_VOID_AUDIENCE,
  OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY,
  isOfflineAdjudicationManualAttentionReason,
  isOfflineAdjudicationOutcomeKind,
  isOfflineAdjudicationRecordState,
  isOfflineAdjudicationRejectionReason,
  isPrivilegedActionId,
  validateOacEnvelopeV1,
  type OfflineAdjudicationAnomalyReason,
  type OfflineAdjudicationManualAttentionReason,
  type OfflineAdjudicationOutcomeKind,
  type OfflineAdjudicationProtocolReason,
  type OfflineAdjudicationRecoverability,
  type OfflineAdjudicationRejectionReason,
  type OfflineAdjudicationRetryReason,
  type OfflineAuthorizationCapabilityV1,
} from './privilegedActionRegistry';
import { readRevocationEpoch } from './privilegedRevocationState';
import { approverBranchEligible, requesterBranchEligible } from './requestManagerApprovalCore';
import { loadAllVerifiableSigningKeys, publicKeyFromRaw, type VerifiableSigningKey } from './signingKeyLoader';
import { verifyOacEnvelopeSignature } from './oacSigner';
import { decodeSsa1, isCanonicalIdentifier, ssa1SignaturePreimage } from './staffSessionAssertionFrame';
import {
  PENDING_EXECUTION_72H_MS,
  decideCanonicalVoidCorrelation,
  deriveOfflineVoidExecutionId,
  isAlreadyCanonicallyVoided,
  timestampToMs,
  utcPlus7Date,
  utcPlus7DayEndMs,
  voidActionMatchesReconcileStatus,
} from './submitPrivilegedVoidCore';
import {
  decodePaa1,
  paa1ActionKindToActionId,
  paa1AdjudicationId,
  paa1AttestationDigest,
  paa1ManagerRoleKindToRole,
  paa1SecurityDeviceIdHex,
  paa1SignaturePreimage,
  type PrivilegedActionAttestationFrameV1,
} from './privilegedActionAttestationFrame';
import { handleVoidIntent, type HandleVoidIntentOptions, type VoidIntentTxnOutcome } from './voidIntent';

export const COLLECTIONS = {
  users: 'users',
  asyncOrders: 'asyncOrders',
  deviceRegistrations: 'privilegedDeviceRegistrations',
  adjudications: PRIVILEGED_OFFLINE_ADJUDICATIONS_COLLECTION,
} as const;

export const OFFLINE_ADJUDICATION_RECORD_SCHEMA_VERSION = 1 as const;

// --- Request / response contract -------------------------------------------

export type AdjudicateOfflinePrivilegedActionRequest = {
  paa1Base64?: unknown;
  ssa1Base64?: unknown;
  oacEnvelopeBytesBase64?: unknown;
};

export type OfflineAdjudicationResponse =
  // ── FAMILY 1 — pre-authentication / protocol. No trusted identity is claimed.
  | {
      family: 'PROTOCOL';
      kind: 'PROTOCOL_REJECTED';
      protocolReason: OfflineAdjudicationProtocolReason;
      recoverability: OfflineAdjudicationRecoverability;
      serverObservedAtMs: number;
    }
  | {
      family: 'PROTOCOL';
      kind: 'PROTOCOL_RETRYABLE';
      retryReason: OfflineAdjudicationRetryReason;
      serverObservedAtMs: number;
    }
  // ── FAMILY 2 — post-authentication. `adjudicationId` is trusted.
  | {
      family: 'ADJUDICATION';
      kind: 'ACCEPTED';
      adjudicationId: string;
      targetOrderId: string;
      offlineExecutionId: string;
      outcomeKind: OfflineAdjudicationOutcomeKind;
      idempotent: boolean;
      serverAdjudicatedAtMs: number;
    }
  | {
      family: 'ADJUDICATION';
      kind: 'REJECTED';
      adjudicationId: string;
      targetOrderId: string;
      rejectionReason: OfflineAdjudicationRejectionReason;
      terminal: true;
      idempotent: boolean;
      serverAdjudicatedAtMs: number;
    }
  | {
      family: 'ADJUDICATION';
      kind: 'MANUAL_ATTENTION_REQUIRED';
      adjudicationId: string;
      targetOrderId: string;
      manualAttentionReason: OfflineAdjudicationManualAttentionReason;
      terminal: true;
      idempotent: boolean;
      serverAdjudicatedAtMs: number;
    }
  | {
      family: 'ADJUDICATION';
      kind: 'ADJUDICATION_ANOMALY';
      adjudicationId: string;
      targetOrderId: string;
      anomalyReason: OfflineAdjudicationAnomalyReason;
      terminalForAutomation: true;
      recordWritten: false;
      serverObservedAtMs: number;
    }
  | {
      family: 'ADJUDICATION';
      kind: 'RETRYABLE';
      adjudicationId: string;
      retryReason: OfflineAdjudicationRetryReason;
      terminal: false;
      serverAdjudicatedAtMs: number;
    };

export type CanonicalVoidExecutor = (
  database: Firestore,
  orderRef: DocumentReference,
  options?: HandleVoidIntentOptions,
) => Promise<VoidIntentTxnOutcome>;

export interface AdjudicateOfflinePrivilegedActionDeps {
  nowMillis?: number;
  executeCanonicalVoid?: CanonicalVoidExecutor;
  readRolePermissions?: RolePermissionsReader;
  /** F7 (SEC-001 Packet C-A): staged-deny fail-closed check. */
  readStagedDenyHead?: StagedRoleDenyHeadReader;
  loadVerifiableSigningKeys?: (database: Firestore, nowMs: number) => Promise<VerifiableSigningKey[]>;
}

// --- Durable record --------------------------------------------------------

/**
 * IR-007 — the persisted record is a closed, state-discriminated union. Each
 * variant fixes exactly which fields are non-null, so a replay can only ever
 * source a value the state guarantees is present — never a repaired default.
 */
interface OfflineAdjudicationRecordCommon {
  schemaVersion: 1;
  adjudicationId: string;
  attestationDigest: string;
  paa1SchemaVersion: 1;
  actionId: string;
  targetOrderId: string;
  branchId: string;
  initiatingStaffId: string;
  approvingManagerStaffId: string;
  oacId: string;
  ssa1Id: string;
  securityDeviceIdHex: string;
  deviceKeyVersion: number;
  audience: string;
  trustedApprovalLowerMs: number;
  trustedApprovalUpperMs: number;
  serverPendingExpiryMs: number;
  firstSeenAtMillis: number;
  firstRelayCallerStaffId: string;
}

export interface TerminallyRejectedOfflineAdjudicationRecord extends OfflineAdjudicationRecordCommon {
  state: 'TERMINALLY_REJECTED';
  offlineExecutionId: null;
  verdict: 'REJECTED';
  rejectionReason: OfflineAdjudicationRejectionReason;
  manualAttentionReason: null;
  outcomeKind: null;
  consumedAtMillis: null;
  terminalizedAtMillis: number;
  completedAtMillis: null;
  completingRelayCallerStaffId: null;
}

export interface ConsumedPendingExecutionOfflineAdjudicationRecord extends OfflineAdjudicationRecordCommon {
  state: 'CONSUMED_PENDING_EXECUTION';
  offlineExecutionId: string;
  verdict: null;
  rejectionReason: null;
  manualAttentionReason: null;
  outcomeKind: null;
  consumedAtMillis: number;
  terminalizedAtMillis: null;
  completedAtMillis: null;
  completingRelayCallerStaffId: null;
}

export interface CompletedOfflineAdjudicationRecord extends OfflineAdjudicationRecordCommon {
  state: 'COMPLETED';
  offlineExecutionId: string;
  verdict: 'ACCEPTED';
  rejectionReason: null;
  manualAttentionReason: null;
  outcomeKind: OfflineAdjudicationOutcomeKind;
  consumedAtMillis: number;
  terminalizedAtMillis: null;
  completedAtMillis: number;
  completingRelayCallerStaffId: string;
}

export interface ManualAttentionRequiredOfflineAdjudicationRecord extends OfflineAdjudicationRecordCommon {
  state: 'MANUAL_ATTENTION_REQUIRED';
  offlineExecutionId: string;
  verdict: 'MANUAL_ATTENTION_REQUIRED';
  rejectionReason: null;
  manualAttentionReason: OfflineAdjudicationManualAttentionReason;
  outcomeKind: null;
  consumedAtMillis: number;
  terminalizedAtMillis: null;
  completedAtMillis: number;
  completingRelayCallerStaffId: string;
}

export type OfflineAdjudicationRecordView =
  | TerminallyRejectedOfflineAdjudicationRecord
  | ConsumedPendingExecutionOfflineAdjudicationRecord
  | CompletedOfflineAdjudicationRecord
  | ManualAttentionRequiredOfflineAdjudicationRecord;

/** IR-007 — the subset of states a durable-replay response builder may accept. */
export type OfflineAdjudicationTerminalRecord = Exclude<
  OfflineAdjudicationRecordView,
  ConsumedPendingExecutionOfflineAdjudicationRecord
>;

/** IR-002 — the exact closed key set. Any missing or extra key is unreadable. */
const OFFLINE_ADJUDICATION_RECORD_KEYS = [
  'schemaVersion',
  'state',
  'adjudicationId',
  'attestationDigest',
  'paa1SchemaVersion',
  'actionId',
  'targetOrderId',
  'branchId',
  'initiatingStaffId',
  'approvingManagerStaffId',
  'oacId',
  'ssa1Id',
  'securityDeviceIdHex',
  'deviceKeyVersion',
  'audience',
  'trustedApprovalLowerMs',
  'trustedApprovalUpperMs',
  'serverPendingExpiryMs',
  'offlineExecutionId',
  'verdict',
  'rejectionReason',
  'manualAttentionReason',
  'outcomeKind',
  'firstSeenAtMillis',
  'consumedAtMillis',
  'terminalizedAtMillis',
  'completedAtMillis',
  'firstRelayCallerStaffId',
  'completingRelayCallerStaffId',
] as const;
const OFFLINE_ADJUDICATION_RECORD_KEY_SET: ReadonlySet<string> = new Set(OFFLINE_ADJUDICATION_RECORD_KEYS);

const LOWERCASE_32_HEX_RE = /^[0-9a-f]{32}$/;
const LOWERCASE_40_HEX_RE = /^[0-9a-f]{40}$/;
const LOWERCASE_64_HEX_RE = /^[0-9a-f]{64}$/;
const ALL_ZERO_32_HEX = '0'.repeat(32);

function isLowercase32Hex(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_32_HEX_RE.test(value);
}

function isNonZeroLowercase32Hex(value: unknown): value is string {
  return isLowercase32Hex(value) && value !== ALL_ZERO_32_HEX;
}

function isLowercase40Hex(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_40_HEX_RE.test(value);
}

function isLowercase64Hex(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_64_HEX_RE.test(value);
}

function isPositiveU32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 0xffffffff;
}

function isPositiveSafeTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && isCanonicalIdentifier(value);
}

/**
 * IR-002 — strict, state-discriminated parser over the exact closed 29-key
 * schema. Beyond primitive shape, every cross-field invariant below is exact:
 * the required/forbidden fields for a state, closed-enum membership for every
 * reason/outcome field, and exact grammar/width/range for every immutable
 * binding value. Any violation returns `null` (→ `adjudication_record_unreadable`,
 * no write, no fallback reason, no fallback outcome kind, no invented execution
 * id, no invented timestamp) rather than being interpreted or repaired.
 */
export function parseOfflineAdjudicationRecord(data: unknown): OfflineAdjudicationRecordView | null {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;

  const keys = Object.keys(raw);
  if (keys.length !== OFFLINE_ADJUDICATION_RECORD_KEYS.length) return null;
  for (const key of keys) {
    if (!OFFLINE_ADJUDICATION_RECORD_KEY_SET.has(key)) return null;
  }

  if (raw.schemaVersion !== OFFLINE_ADJUDICATION_RECORD_SCHEMA_VERSION) return null;
  if (!isOfflineAdjudicationRecordState(raw.state)) return null;
  if (raw.paa1SchemaVersion !== 1) return null;
  if (!isNonZeroLowercase32Hex(raw.adjudicationId)) return null;
  if (!isLowercase64Hex(raw.attestationDigest)) return null;
  if (!isPrivilegedActionId(raw.actionId)) return null;
  if (!isCanonicalId(raw.targetOrderId)) return null;
  if (!isCanonicalId(raw.branchId) || raw.branchId === 'ALL') return null;
  if (!isCanonicalId(raw.initiatingStaffId)) return null;
  if (!isCanonicalId(raw.approvingManagerStaffId) || raw.approvingManagerStaffId === raw.initiatingStaffId) {
    return null;
  }
  if (!isCanonicalId(raw.oacId)) return null;
  if (!isCanonicalId(raw.ssa1Id)) return null;
  if (!isLowercase32Hex(raw.securityDeviceIdHex)) return null;
  if (!isPositiveU32(raw.deviceKeyVersion)) return null;
  if (raw.audience !== PRIVILEGED_VOID_AUDIENCE) return null;
  if (!isPositiveSafeTimestamp(raw.trustedApprovalLowerMs)) return null;
  if (!isPositiveSafeTimestamp(raw.trustedApprovalUpperMs) || raw.trustedApprovalUpperMs < raw.trustedApprovalLowerMs) {
    return null;
  }
  if (
    !isPositiveSafeTimestamp(raw.serverPendingExpiryMs) ||
    raw.serverPendingExpiryMs <= raw.trustedApprovalLowerMs
  ) {
    return null;
  }
  if (!(raw.offlineExecutionId === null || isLowercase40Hex(raw.offlineExecutionId))) return null;
  if (
    !(
      raw.verdict === null ||
      raw.verdict === 'ACCEPTED' ||
      raw.verdict === 'REJECTED' ||
      raw.verdict === 'MANUAL_ATTENTION_REQUIRED'
    )
  ) {
    return null;
  }
  // Closed-enum membership — not merely "a non-empty string" — for every reason.
  if (!(raw.rejectionReason === null || isOfflineAdjudicationRejectionReason(raw.rejectionReason))) return null;
  if (
    !(raw.manualAttentionReason === null || isOfflineAdjudicationManualAttentionReason(raw.manualAttentionReason))
  ) {
    return null;
  }
  if (!(raw.outcomeKind === null || isOfflineAdjudicationOutcomeKind(raw.outcomeKind))) return null;
  if (!isPositiveSafeTimestamp(raw.firstSeenAtMillis)) return null;
  if (!(raw.consumedAtMillis === null || isPositiveSafeTimestamp(raw.consumedAtMillis))) return null;
  if (!(raw.terminalizedAtMillis === null || isPositiveSafeTimestamp(raw.terminalizedAtMillis))) return null;
  if (!(raw.completedAtMillis === null || isPositiveSafeTimestamp(raw.completedAtMillis))) return null;
  if (!isCanonicalId(raw.firstRelayCallerStaffId)) return null;
  if (!(raw.completingRelayCallerStaffId === null || isCanonicalId(raw.completingRelayCallerStaffId))) return null;

  const common = {
    schemaVersion: 1 as const,
    adjudicationId: raw.adjudicationId,
    attestationDigest: raw.attestationDigest,
    paa1SchemaVersion: 1 as const,
    actionId: raw.actionId,
    targetOrderId: raw.targetOrderId,
    branchId: raw.branchId,
    initiatingStaffId: raw.initiatingStaffId,
    approvingManagerStaffId: raw.approvingManagerStaffId,
    oacId: raw.oacId,
    ssa1Id: raw.ssa1Id,
    securityDeviceIdHex: raw.securityDeviceIdHex,
    deviceKeyVersion: raw.deviceKeyVersion,
    audience: raw.audience,
    trustedApprovalLowerMs: raw.trustedApprovalLowerMs,
    trustedApprovalUpperMs: raw.trustedApprovalUpperMs,
    serverPendingExpiryMs: raw.serverPendingExpiryMs,
    firstSeenAtMillis: raw.firstSeenAtMillis,
    firstRelayCallerStaffId: raw.firstRelayCallerStaffId,
  };

  const state = raw.state;
  const offlineExecutionId = raw.offlineExecutionId as string | null;
  const verdict = raw.verdict as 'ACCEPTED' | 'REJECTED' | 'MANUAL_ATTENTION_REQUIRED' | null;
  const rejectionReason = raw.rejectionReason as OfflineAdjudicationRejectionReason | null;
  const manualAttentionReason = raw.manualAttentionReason as OfflineAdjudicationManualAttentionReason | null;
  const outcomeKind = raw.outcomeKind as OfflineAdjudicationOutcomeKind | null;
  const consumedAtMillis = raw.consumedAtMillis as number | null;
  const terminalizedAtMillis = raw.terminalizedAtMillis as number | null;
  const completedAtMillis = raw.completedAtMillis as number | null;
  const completingRelayCallerStaffId = raw.completingRelayCallerStaffId as string | null;

  // Exact state-required and state-forbidden fields, including the lifecycle
  // audit trail. No transition, and no record, is ever accepted with a shape
  // another state would produce.
  if (state === 'TERMINALLY_REJECTED') {
    if (
      verdict !== 'REJECTED' ||
      rejectionReason === null ||
      manualAttentionReason !== null ||
      outcomeKind !== null ||
      offlineExecutionId !== null ||
      consumedAtMillis !== null ||
      terminalizedAtMillis === null ||
      completedAtMillis !== null ||
      completingRelayCallerStaffId !== null ||
      terminalizedAtMillis !== common.firstSeenAtMillis
    ) {
      return null;
    }
    return {
      ...common,
      state,
      offlineExecutionId: null,
      verdict: 'REJECTED',
      rejectionReason,
      manualAttentionReason: null,
      outcomeKind: null,
      consumedAtMillis: null,
      terminalizedAtMillis,
      completedAtMillis: null,
      completingRelayCallerStaffId: null,
    };
  }

  if (state === 'CONSUMED_PENDING_EXECUTION') {
    if (
      verdict !== null ||
      rejectionReason !== null ||
      manualAttentionReason !== null ||
      outcomeKind !== null ||
      offlineExecutionId === null ||
      consumedAtMillis === null ||
      terminalizedAtMillis !== null ||
      completedAtMillis !== null ||
      completingRelayCallerStaffId !== null ||
      consumedAtMillis !== common.firstSeenAtMillis
    ) {
      return null;
    }
    return {
      ...common,
      state,
      offlineExecutionId,
      verdict: null,
      rejectionReason: null,
      manualAttentionReason: null,
      outcomeKind: null,
      consumedAtMillis,
      terminalizedAtMillis: null,
      completedAtMillis: null,
      completingRelayCallerStaffId: null,
    };
  }

  if (state === 'COMPLETED') {
    if (
      verdict !== 'ACCEPTED' ||
      rejectionReason !== null ||
      manualAttentionReason !== null ||
      outcomeKind === null ||
      offlineExecutionId === null ||
      consumedAtMillis === null ||
      terminalizedAtMillis !== null ||
      completedAtMillis === null ||
      completingRelayCallerStaffId === null ||
      consumedAtMillis !== common.firstSeenAtMillis ||
      completedAtMillis < consumedAtMillis
    ) {
      return null;
    }
    return {
      ...common,
      state,
      offlineExecutionId,
      verdict: 'ACCEPTED',
      rejectionReason: null,
      manualAttentionReason: null,
      outcomeKind,
      consumedAtMillis,
      terminalizedAtMillis: null,
      completedAtMillis,
      completingRelayCallerStaffId,
    };
  }

  // MANUAL_ATTENTION_REQUIRED — the only remaining record state.
  if (
    verdict !== 'MANUAL_ATTENTION_REQUIRED' ||
    rejectionReason !== null ||
    manualAttentionReason === null ||
    outcomeKind !== null ||
    offlineExecutionId === null ||
    consumedAtMillis === null ||
    terminalizedAtMillis !== null ||
    completedAtMillis === null ||
    completingRelayCallerStaffId === null ||
    consumedAtMillis !== common.firstSeenAtMillis ||
    completedAtMillis < consumedAtMillis
  ) {
    return null;
  }
  return {
    ...common,
    state,
    offlineExecutionId,
    verdict: 'MANUAL_ATTENTION_REQUIRED',
    rejectionReason: null,
    manualAttentionReason,
    outcomeKind: null,
    consumedAtMillis,
    terminalizedAtMillis: null,
    completedAtMillis,
    completingRelayCallerStaffId,
  };
}

/**
 * The immutable identity+binding fields. A record whose digest matches the
 * submitted bytes must agree on every one of them, or the record does not
 * authenticate this frame at all.
 */
export const OFFLINE_ADJUDICATION_IMMUTABLE_BINDING_FIELDS = [
  'attestationDigest',
  'paa1SchemaVersion',
  'actionId',
  'targetOrderId',
  'branchId',
  'initiatingStaffId',
  'approvingManagerStaffId',
  'oacId',
  'ssa1Id',
  'securityDeviceIdHex',
  'deviceKeyVersion',
  'audience',
  'trustedApprovalLowerMs',
  'trustedApprovalUpperMs',
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export interface OfflineAdjudicationBinding {
  adjudicationId: string;
  attestationDigest: string;
  paa1SchemaVersion: 1;
  actionId: string;
  targetOrderId: string;
  branchId: string;
  initiatingStaffId: string;
  approvingManagerStaffId: string;
  oacId: string;
  ssa1Id: string;
  securityDeviceIdHex: string;
  deviceKeyVersion: number;
  audience: string;
  trustedApprovalLowerMs: number;
  trustedApprovalUpperMs: number;
}

export function buildOfflineAdjudicationBinding(
  paa1: PrivilegedActionAttestationFrameV1,
  attestationDigest: string,
): OfflineAdjudicationBinding {
  return {
    adjudicationId: paa1AdjudicationId(paa1),
    attestationDigest,
    paa1SchemaVersion: 1,
    actionId: paa1ActionKindToActionId(paa1.actionKind) ?? '',
    targetOrderId: paa1.targetOrderId,
    branchId: paa1.branchId,
    initiatingStaffId: paa1.initiatingStaffId,
    approvingManagerStaffId: paa1.approvingManagerStaffId,
    oacId: paa1.oacId,
    ssa1Id: paa1.ssa1Id,
    securityDeviceIdHex: paa1SecurityDeviceIdHex(paa1),
    deviceKeyVersion: paa1.deviceKeyVersion,
    audience: PRIVILEGED_VOID_AUDIENCE,
    trustedApprovalLowerMs: paa1.trustedApprovalLowerMs,
    trustedApprovalUpperMs: paa1.trustedApprovalUpperMs,
  };
}

/** R2 — exact digest plus every immutable binding field. */
export function recordMatchesBinding(
  record: OfflineAdjudicationRecordView,
  binding: OfflineAdjudicationBinding,
): boolean {
  const left = record as unknown as Record<string, unknown>;
  const right = binding as unknown as Record<string, unknown>;
  return OFFLINE_ADJUDICATION_IMMUTABLE_BINDING_FIELDS.every((field) => left[field] === right[field]);
}

// --- Stage P helpers -------------------------------------------------------

/**
 * Strict base64: a permissive decode would let a mutated string map onto the
 * same bytes, so the decoded value must re-encode to exactly the input.
 */
export function strictBase64Decode(value: string): Buffer | null {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  if (decoded.toString('base64') !== value) return null;
  return decoded;
}

export type ValidatedAdjudicationRequest = {
  paa1Base64: string;
  ssa1Base64: string;
  oacEnvelopeBytesBase64: string;
};

export function validateAdjudicationRequestShape(
  req: AdjudicateOfflinePrivilegedActionRequest,
): ValidatedAdjudicationRequest | null {
  const { paa1Base64, ssa1Base64, oacEnvelopeBytesBase64 } = req ?? {};
  if (typeof paa1Base64 !== 'string' || paa1Base64.length === 0) return null;
  if (typeof ssa1Base64 !== 'string' || ssa1Base64.length === 0) return null;
  if (typeof oacEnvelopeBytesBase64 !== 'string' || oacEnvelopeBytesBase64.length === 0) return null;
  return { paa1Base64, ssa1Base64, oacEnvelopeBytesBase64 };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- Live-state helpers ----------------------------------------------------

function liveRole(user: DocumentData): string | null {
  return typeof user.role === 'string' ? user.role : null;
}

function liveBranchIds(user: DocumentData): string[] {
  return Array.isArray(user.branchIds) ? user.branchIds.filter((v): v is string => typeof v === 'string') : [];
}

/** Absent/non-finite `authVersion` reads as 0 — the same default the fence uses. */
function liveAuthVersion(user: DocumentData): number {
  return typeof user.authVersion === 'number' && Number.isFinite(user.authVersion) ? user.authVersion : 0;
}

function hasLiveBranchAccess(branchIds: string[], branchId: string): boolean {
  return branchIds.includes('ALL') || branchIds.includes(branchId);
}

/** Staff/manager: exact physical branch. Admin: exact branch or live `ALL`. */
export function relayBranchEligible(role: string | null, branchIds: string[], branchId: string): boolean {
  if (role === 'admin') return hasLiveBranchAccess(branchIds, branchId);
  if (role === 'manager' || role === 'staff') return requesterBranchEligible(branchIds, branchId);
  return false;
}

/**
 * A staged-deny head as observed inside the first-consume transaction.
 * `malformed` carries the C-A-RC-003-R1 semantic fail-closed case — a present
 * head that does not parse — as a *value*, so it can deny without being
 * conflated with an infrastructure read failure, which is never a denial and
 * must escape the transaction callback instead (LZ-3).
 */
type LinearizedStagedDeny = { malformed: true } | { malformed: false; head: StagedRoleDenyHead | null };

/**
 * The live `pos_void` decision for a role, evaluated against snapshots already
 * enrolled in the transaction's read set. Reuses `decideLiveRolePermission`
 * verbatim — the matrix semantics are never restated here.
 */
function linearizedRoleHoldsPosVoid(
  role: string | null,
  snapshot: RolePermissionsDocSnapshot,
  staged: LinearizedStagedDeny,
): boolean {
  if (staged.malformed) return false;
  return decideLiveRolePermission(role, PRIVILEGED_REQUESTER_PERMISSION, snapshot, staged.head).allowed;
}

function tokenHasPermission(auth: AuthLike, perm: string): boolean {
  const raw = auth?.token?.permissions;
  if (!Array.isArray(raw)) return false;
  return raw.some((p) => p === perm);
}

export interface DeviceRegistrationView {
  status: 'ACTIVE' | 'REVOKED';
  deviceKeyVersion: number;
  branchId: string;
  validatedDevProofPublicKeyBase64: string;
}

export function parseDeviceRegistration(data: unknown): DeviceRegistrationView | null {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (raw.status !== 'ACTIVE' && raw.status !== 'REVOKED') return null;
  if (!isFiniteInt(raw.deviceKeyVersion) || raw.deviceKeyVersion <= 0) return null;
  if (!isNonEmptyString(raw.branchId)) return null;
  if (!isNonEmptyString(raw.validatedDevProofPublicKeyBase64)) return null;
  return {
    status: raw.status,
    deviceKeyVersion: raw.deviceKeyVersion,
    branchId: raw.branchId,
    validatedDevProofPublicKeyBase64: raw.validatedDevProofPublicKeyBase64,
  };
}

/**
 * Server recomputation of the frozen pending-execution lifetime (§6.3). The
 * attested value is a ceiling check only; the earlier of the two governs.
 */
export function computeServerPendingExpiry(
  trustedApprovalLowerMs: number,
  serverTargetDayUtc7: string,
): number | null {
  const dayEnd = utcPlus7DayEndMs(serverTargetDayUtc7);
  if (dayEnd == null) return null;
  return Math.min(trustedApprovalLowerMs + PENDING_EXECUTION_72H_MS, dayEnd);
}

// --- The callable core -----------------------------------------------------

class RetryableError extends Error {
  constructor(public readonly retryReason: OfflineAdjudicationRetryReason) {
    super(retryReason);
  }
}

export async function performAdjudicateOfflinePrivilegedAction(
  database: Firestore,
  req: AdjudicateOfflinePrivilegedActionRequest,
  auth: AuthLike,
  deps: AdjudicateOfflinePrivilegedActionDeps = {},
): Promise<OfflineAdjudicationResponse> {
  const nowMillis = deps.nowMillis ?? Date.now();
  const executeCanonicalVoid = deps.executeCanonicalVoid ?? handleVoidIntent;
  const loadSigningKeys = deps.loadVerifiableSigningKeys ?? loadAllVerifiableSigningKeys;

  const protocolRejected = (
    protocolReason: OfflineAdjudicationProtocolReason,
  ): OfflineAdjudicationResponse => ({
    family: 'PROTOCOL',
    kind: 'PROTOCOL_REJECTED',
    protocolReason,
    recoverability: OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY[protocolReason],
    serverObservedAtMs: nowMillis,
  });
  const protocolRetryable = (
    retryReason: OfflineAdjudicationRetryReason,
  ): OfflineAdjudicationResponse => ({
    family: 'PROTOCOL',
    kind: 'PROTOCOL_RETRYABLE',
    retryReason,
    serverObservedAtMs: nowMillis,
  });

  // ══ Stage P0 — minimum relay gate. Model B: transport only, zero authority. ══
  let callerStaffId: string;
  let callerRole: string | null;
  let callerBranchIds: string[];
  try {
    if (!auth) return protocolRejected('relay_caller_not_authorized');
    const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
    if (!freshness.ok) return protocolRejected('relay_caller_not_authorized');
    callerStaffId = freshness.staffId;

    // Token claims are an early gate only, never the authority (BF-1).
    if (!tokenHasPermission(auth, PRIVILEGED_REQUESTER_PERMISSION)) {
      return protocolRejected('relay_caller_not_authorized');
    }
    const callerSnap = await database.collection(COLLECTIONS.users).doc(callerStaffId).get();
    if (!callerSnap.exists) return protocolRejected('relay_caller_not_authorized');
    const caller = (callerSnap.data() ?? {}) as DocumentData;
    if (caller.isActive !== true || caller.deletedAt != null) {
      return protocolRejected('relay_caller_not_authorized');
    }
    callerRole = liveRole(caller);
    if (callerRole !== 'admin' && callerRole !== 'manager' && callerRole !== 'staff') {
      return protocolRejected('relay_caller_not_authorized');
    }
    const callerHasVoid = await liveRoleHoldsPosVoid(
      database,
      callerRole,
      deps.readRolePermissions,
      deps.readStagedDenyHead,
    );
    if (!callerHasVoid) return protocolRejected('relay_caller_not_authorized');
    callerBranchIds = liveBranchIds(caller);
  } catch {
    return protocolRetryable('backend_unavailable');
  }

  // ══ Stage P1–P4 — bytes only. No Firestore access from here to Stage R. ══
  const validated = validateAdjudicationRequestShape(req ?? {});
  if (validated == null) return protocolRejected('request_shape_invalid');

  const paa1Bytes = strictBase64Decode(validated.paa1Base64);
  if (paa1Bytes == null) return protocolRejected('attestation_base64_invalid');

  const decoded = decodePaa1(paa1Bytes);
  if (!decoded.ok) return protocolRejected('attestation_malformed');
  const paa1 = decoded.value;

  const candidateAdjudicationId = paa1AdjudicationId(paa1);
  const candidateAttestationDigest = paa1AttestationDigest(paa1Bytes);
  const binding = buildOfflineAdjudicationBinding(paa1, candidateAttestationDigest);
  if (binding.actionId === '') return protocolRejected('attestation_malformed');

  const adjudicationRef = database.collection(COLLECTIONS.adjudications).doc(candidateAdjudicationId);
  const orderRef = database.collection(COLLECTIONS.asyncOrders).doc(paa1.targetOrderId);

  const rejected = (
    rejectionReason: OfflineAdjudicationRejectionReason,
    idempotent: boolean,
    sourcedAtMs: number = nowMillis,
  ): OfflineAdjudicationResponse => ({
    family: 'ADJUDICATION',
    kind: 'REJECTED',
    adjudicationId: candidateAdjudicationId,
    targetOrderId: paa1.targetOrderId,
    rejectionReason,
    terminal: true,
    idempotent,
    serverAdjudicatedAtMs: sourcedAtMs,
  });
  const manualAttention = (
    manualAttentionReason: OfflineAdjudicationManualAttentionReason,
    idempotent: boolean,
    sourcedAtMs: number = nowMillis,
  ): OfflineAdjudicationResponse => ({
    family: 'ADJUDICATION',
    kind: 'MANUAL_ATTENTION_REQUIRED',
    adjudicationId: candidateAdjudicationId,
    targetOrderId: paa1.targetOrderId,
    manualAttentionReason,
    terminal: true,
    idempotent,
    serverAdjudicatedAtMs: sourcedAtMs,
  });
  const anomaly = (anomalyReason: OfflineAdjudicationAnomalyReason): OfflineAdjudicationResponse => ({
    family: 'ADJUDICATION',
    kind: 'ADJUDICATION_ANOMALY',
    adjudicationId: candidateAdjudicationId,
    targetOrderId: paa1.targetOrderId,
    anomalyReason,
    terminalForAutomation: true,
    recordWritten: false,
    serverObservedAtMs: nowMillis,
  });
  const retryable = (retryReason: OfflineAdjudicationRetryReason): OfflineAdjudicationResponse => ({
    family: 'ADJUDICATION',
    kind: 'RETRYABLE',
    adjudicationId: candidateAdjudicationId,
    retryReason,
    terminal: false,
    serverAdjudicatedAtMs: nowMillis,
  });
  const accepted = (
    offlineExecutionId: string,
    outcomeKind: OfflineAdjudicationOutcomeKind,
    idempotent: boolean,
    sourcedAtMs: number = nowMillis,
  ): OfflineAdjudicationResponse => ({
    family: 'ADJUDICATION',
    kind: 'ACCEPTED',
    adjudicationId: candidateAdjudicationId,
    targetOrderId: paa1.targetOrderId,
    offlineExecutionId,
    outcomeKind,
    idempotent,
    serverAdjudicatedAtMs: sourcedAtMs,
  });

  // IR-007 — durable-field replay stability. Builds a verbatim response from an
  // already-terminal record, sourcing `serverAdjudicatedAtMs` from the record's
  // own persisted terminal timestamp rather than this invocation's clock.
  const responseForTerminalRecord = (record: OfflineAdjudicationTerminalRecord): OfflineAdjudicationResponse => {
    if (record.state === 'TERMINALLY_REJECTED') {
      return rejected(record.rejectionReason, true, record.terminalizedAtMillis);
    }
    if (record.state === 'COMPLETED') {
      return accepted(record.offlineExecutionId, record.outcomeKind, true, record.completedAtMillis);
    }
    // MANUAL_ATTENTION_REQUIRED — the only remaining terminal state a
    // resumed/adopted record can be in.
    return manualAttention(record.manualAttentionReason, true, record.completedAtMillis);
  };

  type PhaseCTerminalizeResult =
    | { kind: 'ANOMALY'; anomalyReason: OfflineAdjudicationAnomalyReason }
    | { kind: 'ADOPTED'; record: OfflineAdjudicationTerminalRecord }
    | { kind: 'APPLIED' };

  // ── Phase C — authoritative execution, resumed from CONSUMED_PENDING_EXECUTION.
  //    Never re-adjudicates: the authorization already happened at the Stage-F
  //    pass that produced the record. Finishing is a server obligation.
  //
  // IR-003 — the terminal write is transactionally guarded: re-read the
  // durable record, strict-parse it, verify the exact immutable binding, and
  // permit only `CONSUMED_PENDING_EXECUTION -> patch.state`. A missing or
  // malformed record is the unreadable anomaly (no write); a binding conflict
  // is the binding-conflict anomaly (no write); an already-terminal record is
  // adopted verbatim (no overwrite) — never a fourth outcome.
  const terminalizePhaseC = async (patch: Record<string, unknown>): Promise<PhaseCTerminalizeResult> => {
    let result: PhaseCTerminalizeResult = { kind: 'ANOMALY', anomalyReason: 'adjudication_record_unreadable' };
    try {
      await database.runTransaction(async (tx) => {
        const snap = await tx.get(adjudicationRef);
        if (!snap.exists) {
          result = { kind: 'ANOMALY', anomalyReason: 'adjudication_record_unreadable' };
          return;
        }
        const record = parseOfflineAdjudicationRecord(snap.data());
        if (record == null) {
          result = { kind: 'ANOMALY', anomalyReason: 'adjudication_record_unreadable' };
          return;
        }
        if (record.adjudicationId !== candidateAdjudicationId || !recordMatchesBinding(record, binding)) {
          result = { kind: 'ANOMALY', anomalyReason: 'adjudication_record_binding_conflict' };
          return;
        }
        if (record.state !== 'CONSUMED_PENDING_EXECUTION') {
          result = { kind: 'ADOPTED', record };
          return;
        }
        tx.set(adjudicationRef, { ...patch, completingRelayCallerStaffId: callerStaffId }, { merge: true });
        result = { kind: 'APPLIED' };
      });
    } catch {
      throw new RetryableError('transaction_contention');
    }
    return result;
  };

  const finishPhaseC = async (
    record: ConsumedPendingExecutionOfflineAdjudicationRecord,
    idempotent: boolean,
  ): Promise<OfflineAdjudicationResponse> => {
    const executionId = record.offlineExecutionId;

    const applyManualAttention = async (
      reason: OfflineAdjudicationManualAttentionReason,
    ): Promise<OfflineAdjudicationResponse> => {
      const result = await terminalizePhaseC({
        state: 'MANUAL_ATTENTION_REQUIRED',
        verdict: 'MANUAL_ATTENTION_REQUIRED',
        manualAttentionReason: reason,
        completedAtMillis: nowMillis,
      });
      if (result.kind === 'ANOMALY') return anomaly(result.anomalyReason);
      if (result.kind === 'ADOPTED') return responseForTerminalRecord(result.record);
      return manualAttention(reason, idempotent, nowMillis);
    };
    const applyCompleted = async (
      outcomeKind: OfflineAdjudicationOutcomeKind,
      idempotentFlag: boolean,
    ): Promise<OfflineAdjudicationResponse> => {
      const result = await terminalizePhaseC({
        state: 'COMPLETED',
        verdict: 'ACCEPTED',
        outcomeKind,
        completedAtMillis: nowMillis,
      });
      if (result.kind === 'ANOMALY') return anomaly(result.anomalyReason);
      if (result.kind === 'ADOPTED') return responseForTerminalRecord(result.record);
      return accepted(executionId, outcomeKind, idempotentFlag, nowMillis);
    };

    const beforeSnap = await orderRef.get();
    const beforeOrder = beforeSnap.exists ? ((beforeSnap.data() ?? {}) as DocumentData) : null;
    const decision = decideCanonicalVoidCorrelation(beforeOrder, executionId);
    if (decision === 'MATCHING') {
      // This exact execution already won (e.g. a prior crash landed the
      // canonical effect but not the terminal write). The transactional
      // terminalizer itself discovers and adopts any already-terminal result.
      return applyCompleted('NOOP', true);
    }
    if (decision === 'MISSING') return applyManualAttention('canonical_correlation_missing');
    if (decision === 'DIFFERENT') return applyManualAttention('canonical_correlation_conflict');

    // IR-004 / GD-D1B-005 — the PAA1-bound initiating staff identity and OAC id
    // are server-authoritative inputs to the SAME canonical transaction that
    // performs the void effect, never a later, separate attribution write.
    const outcome = await executeCanonicalVoid(database, orderRef, {
      privilegedVoidExecutionId: executionId,
      oacId: record.oacId,
      authoritativeActorStaffId: record.initiatingStaffId,
    });

    const afterSnap = await orderRef.get();
    const afterOrder = afterSnap.exists ? ((afterSnap.data() ?? {}) as DocumentData) : null;
    const afterDecision = decideCanonicalVoidCorrelation(afterOrder, executionId);

    if (outcome.kind === 'VOID_APPLIED' || outcome.kind === 'VOID_TOMBSTONED') {
      // Generic `voided`/`voidReconciled` is never proof this execution won.
      if (afterDecision !== 'MATCHING') return applyManualAttention('canonical_execution_unresolved');
      return applyCompleted(outcome.kind, idempotent);
    }
    if (outcome.kind === 'NOOP' && outcome.reason === 'already_reconciled') {
      if (afterDecision === 'MATCHING') return applyCompleted('NOOP', idempotent);
      if (afterDecision === 'MISSING') return applyManualAttention('canonical_correlation_missing');
      if (afterDecision === 'DIFFERENT') return applyManualAttention('canonical_correlation_conflict');
    }
    return applyManualAttention('canonical_execution_unresolved');
  };

  // ── Stage R dispatch, shared with the in-transaction racer-adopt branches.
  const dispatchExistingRecord = async (
    data: unknown,
    idempotent: boolean,
  ): Promise<OfflineAdjudicationResponse> => {
    // R1 — strict parse first: an unreadable record has no trustworthy digest.
    const record = parseOfflineAdjudicationRecord(data);
    if (record == null) return anomaly('adjudication_record_unreadable');
    // R2 — a record that binds to different bytes never yields its verdict.
    if (record.adjudicationId !== candidateAdjudicationId) {
      return anomaly('adjudication_record_binding_conflict');
    }
    if (!recordMatchesBinding(record, binding)) {
      return anomaly('adjudication_record_binding_conflict');
    }
    // R3 — the relay must be branch-eligible for the record's own immutable
    // branch before any of its content is disclosed or resumed. Zero extra reads.
    if (!relayBranchEligible(callerRole, callerBranchIds, record.branchId)) {
      return protocolRejected('relay_branch_not_permitted');
    }
    // R4 — exact state dispatch.
    if (
      record.state === 'TERMINALLY_REJECTED' ||
      record.state === 'COMPLETED' ||
      record.state === 'MANUAL_ATTENTION_REQUIRED'
    ) {
      return responseForTerminalRecord(record);
    }
    return finishPhaseC(record, idempotent);
  };

  // ══ Stage R — durable replay anchor, BEFORE any mutable device-registry read. ══
  let existingSnap: { exists: boolean; data: () => unknown };
  try {
    existingSnap = await adjudicationRef.get();
  } catch {
    // PE-NORM-01: no existing record has been authenticated and no fresh
    // authentication has run, so this cannot claim the ADJUDICATION family.
    return protocolRetryable('backend_unavailable');
  }
  if (existingSnap.exists) {
    try {
      return await dispatchExistingRecord(existingSnap.data(), true);
    } catch (err) {
      if (err instanceof RetryableError) return retryable(err.retryReason);
      return retryable('internal_error');
    }
  }

  // ══ Stage F — fresh attestation. Record-absent only. ══
  try {
    // F1 — current device registration.
    let deviceSnap: { exists: boolean; data: () => unknown };
    try {
      deviceSnap = await database
        .collection(COLLECTIONS.deviceRegistrations)
        .doc(binding.securityDeviceIdHex)
        .get();
    } catch {
      return protocolRetryable('backend_unavailable');
    }
    if (!deviceSnap.exists) return protocolRejected('device_registration_unavailable');
    const registration = parseDeviceRegistration(deviceSnap.data());
    if (registration == null) return protocolRejected('device_registration_unavailable');

    // F2 — key material at exactly the attested device key version.
    if (registration.deviceKeyVersion !== paa1.deviceKeyVersion) {
      return protocolRejected('device_key_material_unavailable');
    }
    let devicePublicKey;
    try {
      const rawPub = Buffer.from(registration.validatedDevProofPublicKeyBase64, 'base64');
      if (rawPub.length !== 32) return protocolRejected('device_key_material_unavailable');
      devicePublicKey = publicKeyFromRaw(rawPub.toString('base64url'));
    } catch {
      return protocolRejected('device_key_material_unavailable');
    }

    // F3 — PAA1 signature over `TWINPET_PAA1_V1: ‖ signed_prefix`.
    let signatureValid = false;
    try {
      signatureValid = ed25519Verify(null, paa1SignaturePreimage(paa1), devicePublicKey, paa1.signature);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) return protocolRejected('attestation_signature_invalid');

    // F4 — the relay must be branch-eligible for the now-trusted branch.
    if (!relayBranchEligible(callerRole, callerBranchIds, paa1.branchId)) {
      return protocolRejected('relay_branch_not_permitted');
    }

    // ── Authenticated Class-B adjudication. Every failure below writes exactly
    //    one TERMINALLY_REJECTED record before returning.
    //
    // The record always carries the server's own recomputed lifetime; until F15
    // recomputes it from the order, the attested ceiling is the best available
    // value and is never treated as authority for any decision.
    let serverPendingExpiryMs = paa1.pendingExecutionExpiresAtMs;

    const terminalize = async (
      rejectionReason: OfflineAdjudicationRejectionReason,
    ): Promise<OfflineAdjudicationResponse> => {
      let adopted: unknown | undefined;
      try {
        await database.runTransaction(async (tx) => {
          const snap = await tx.get(adjudicationRef);
          if (snap.exists) {
            adopted = snap.data();
            return;
          }
          tx.create(adjudicationRef, {
            ...binding,
            schemaVersion: OFFLINE_ADJUDICATION_RECORD_SCHEMA_VERSION,
            state: 'TERMINALLY_REJECTED',
            serverPendingExpiryMs,
            offlineExecutionId: null,
            verdict: 'REJECTED',
            rejectionReason,
            manualAttentionReason: null,
            outcomeKind: null,
            firstSeenAtMillis: nowMillis,
            consumedAtMillis: null,
            terminalizedAtMillis: nowMillis,
            completedAtMillis: null,
            firstRelayCallerStaffId: callerStaffId,
            completingRelayCallerStaffId: null,
          });
        });
      } catch {
        return retryable('transaction_contention');
      }
      if (adopted !== undefined) return await dispatchExistingRecord(adopted, true);
      return rejected(rejectionReason, false);
    };

    // F5/F6 — authenticated device authorisation, from the F1 snapshot.
    if (registration.status !== 'ACTIVE') return await terminalize('device_not_active');
    if (registration.branchId !== paa1.branchId) return await terminalize('device_branch_mismatch');

    // F7 — frame residue: the attested approval window must be coherent with
    // server time. An approval cannot lie in the server's future.
    if (paa1.trustedApprovalLowerMs > nowMillis || paa1.trustedApprovalUpperMs < paa1.trustedApprovalLowerMs) {
      return await terminalize('trusted_time_bounds_invalid');
    }

    // F8 — SSA1: exact bytes, re-verified by signature and bound by digest.
    const ssa1Bytes = Buffer.from(validated.ssa1Base64, 'base64');
    if (sha256Hex(ssa1Bytes) !== paa1.ssa1Digest.toString('hex')) {
      return await terminalize('ssa1_digest_mismatch');
    }
    const ssa1Decoded = decodeSsa1(ssa1Bytes);
    if (!ssa1Decoded.ok) return await terminalize('ssa1_binding_mismatch');
    const ssa1 = ssa1Decoded.value;

    let verifiableKeys: VerifiableSigningKey[];
    try {
      verifiableKeys = await loadSigningKeys(database, nowMillis);
    } catch {
      throw new RetryableError('backend_unavailable');
    }
    const ssa1Key = verifiableKeys.find((k) => k.signingKeyId === ssa1.signingKeyId);
    if (!ssa1Key) return await terminalize('ssa1_signature_invalid');
    let ssa1Valid = false;
    try {
      ssa1Valid = ed25519Verify(null, ssa1SignaturePreimage(ssa1), ssa1Key.publicKey, ssa1.signature);
    } catch {
      ssa1Valid = false;
    }
    if (!ssa1Valid) return await terminalize('ssa1_signature_invalid');
    if (
      ssa1.staffId !== paa1.initiatingStaffId ||
      ssa1.branchId !== paa1.branchId ||
      ssa1.securityDeviceId.toString('hex') !== binding.securityDeviceIdHex ||
      ssa1.ssa1Id !== paa1.ssa1Id ||
      ssa1.authVersionAtIssue !== paa1.ssa1AuthVersionAtIssue ||
      ssa1.expiresAtServerMs !== paa1.ssa1ExpiresAtServerMs
    ) {
      return await terminalize('ssa1_binding_mismatch');
    }
    if (paa1.trustedApprovalUpperMs > ssa1.expiresAtServerMs) return await terminalize('ssa1_expired');

    // F9 — OAC envelope: exact bytes, bound by digest, verified by signature.
    const oacBytes = Buffer.from(validated.oacEnvelopeBytesBase64, 'base64');
    if (sha256Hex(oacBytes) !== paa1.oacDigest.toString('hex')) return await terminalize('oac_digest_mismatch');
    let oac: OfflineAuthorizationCapabilityV1;
    try {
      const parsed = validateOacEnvelopeV1(JSON.parse(oacBytes.toString('utf8')));
      if (!parsed.ok) return await terminalize('oac_signature_invalid');
      oac = parsed.value;
    } catch {
      return await terminalize('oac_signature_invalid');
    }
    const oacKey = verifiableKeys.find((k) => k.signingKeyId === oac.signingKeyId);
    if (!oacKey) return await terminalize('oac_signing_key_not_verifiable');
    if (!verifyOacEnvelopeSignature(oac, oacKey.publicKey)) return await terminalize('oac_signature_invalid');
    // Defence in depth: a matching sha256 already implies these agree, so a
    // disagreement means the supplied envelope is not the attested capability.
    if (
      oac.oacId !== paa1.oacId ||
      oac.branchId !== paa1.branchId ||
      oac.deviceId.toLowerCase() !== binding.securityDeviceIdHex ||
      oac.managerStaffId !== paa1.approvingManagerStaffId ||
      oac.managerRole !== paa1ManagerRoleKindToRole(paa1.managerRoleKind) ||
      oac.revocationEpoch !== paa1.revocationEpochAtIssue ||
      oac.authVersionAtIssue !== paa1.managerAuthVersionAtIssue ||
      oac.credentialVersionAtIssue !== paa1.managerCredentialVersionAtIssue ||
      oac.schemaVersion !== paa1.oacSchemaVersion
    ) {
      return await terminalize('oac_digest_mismatch');
    }
    // The capability must have been fresh at the trusted approval time — not at
    // adjudication time, which may legitimately be much later.
    if (
      paa1.trustedApprovalLowerMs < oac.issuedAtServerMs ||
      paa1.trustedApprovalUpperMs > oac.freshnessExpiresAtServerMs
    ) {
      return await terminalize('oac_freshness_expired');
    }
    if (!oac.allowedActions.includes(binding.actionId as (typeof oac.allowedActions)[number])) {
      return await terminalize('action_not_allowed_by_oac');
    }

    // F10 — live revalidation of the ORIGINAL initiating staff (never the relay).
    const initiatorSnap = await database.collection(COLLECTIONS.users).doc(paa1.initiatingStaffId).get();
    if (!initiatorSnap.exists) return await terminalize('initiator_not_found');
    const initiator = (initiatorSnap.data() ?? {}) as DocumentData;
    if (initiator.isActive !== true || initiator.deletedAt != null) return await terminalize('initiator_inactive');
    const initiatorRole = liveRole(initiator);
    if (initiatorRole !== 'admin' && initiatorRole !== 'manager' && initiatorRole !== 'staff') {
      return await terminalize('initiator_inactive');
    }
    const initiatorAuthVersion = liveAuthVersion(initiator);
    if (initiatorAuthVersion !== paa1.ssa1AuthVersionAtIssue) {
      return await terminalize('initiator_auth_version_changed');
    }
    const initiatorHasVoid = await liveRoleHoldsPosVoid(
      database,
      initiatorRole,
      deps.readRolePermissions,
      deps.readStagedDenyHead,
    );
    if (!initiatorHasVoid) return await terminalize('initiator_permission_revoked');
    if (!relayBranchEligible(initiatorRole, liveBranchIds(initiator), paa1.branchId)) {
      return await terminalize('initiator_branch_mismatch');
    }

    // F11 — live revalidation of the ORIGINAL approving manager.
    const managerSnap = await database.collection(COLLECTIONS.users).doc(paa1.approvingManagerStaffId).get();
    if (!managerSnap.exists) return await terminalize('manager_not_found');
    const manager = (managerSnap.data() ?? {}) as DocumentData;
    const managerRole = liveRole(manager);
    if (
      manager.isActive !== true ||
      manager.deletedAt != null ||
      (managerRole !== 'manager' && managerRole !== 'admin')
    ) {
      return await terminalize('manager_inactive_or_not_privileged');
    }
    const managerAuthVersion = liveAuthVersion(manager);
    if (managerAuthVersion !== paa1.managerAuthVersionAtIssue) {
      return await terminalize('manager_auth_version_changed');
    }
    const credential = await readUserCredential(database, paa1.approvingManagerStaffId);
    if (
      !isUsableForLogin(credential) ||
      credential.credentialState !== 'rotated_authoritative' ||
      credential.credentialVersion !== paa1.managerCredentialVersionAtIssue
    ) {
      return await terminalize('manager_credential_version_changed');
    }
    const managerHasVoid = await liveRoleHoldsPosVoid(
      database,
      managerRole,
      deps.readRolePermissions,
      deps.readStagedDenyHead,
    );
    if (!managerHasVoid) return await terminalize('manager_permission_revoked');
    if (!approverBranchEligible(managerRole, liveBranchIds(manager), paa1.branchId)) {
      return await terminalize('manager_branch_mismatch');
    }

    // F12 — no self-approval. Enforced natively AND here; the server never
    // relies on the native check.
    if (paa1.initiatingStaffId === paa1.approvingManagerStaffId) {
      return await terminalize('self_approval_not_permitted');
    }

    // F13 — strict revocation-epoch equality.
    const revocationEpoch = await readRevocationEpoch(database);
    if (revocationEpoch !== paa1.revocationEpochAtIssue) return await terminalize('revocation_epoch_changed');

    // F14 — target order.
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return await terminalize('target_order_not_found');
    const order = (orderSnap.data() ?? {}) as DocumentData;
    if (order.branchId !== paa1.branchId) return await terminalize('target_branch_mismatch');
    if (!voidActionMatchesReconcileStatus(binding.actionId as never, order.reconcileStatus)) {
      return await terminalize('target_state_mismatch');
    }
    if (isAlreadyCanonicallyVoided(order)) return await terminalize('target_already_voided');

    // F15 — frozen pending lifetime, recomputed from the server's own facts.
    const createdMs = timestampToMs(order.serverCreatedAt);
    if (createdMs == null) return await terminalize('target_state_mismatch');
    const serverTargetDay = utcPlus7Date(createdMs);
    const recomputed = computeServerPendingExpiry(paa1.trustedApprovalLowerMs, serverTargetDay);
    if (recomputed == null) return await terminalize('target_state_mismatch');
    serverPendingExpiryMs = recomputed;
    const serverDayEndMs = utcPlus7DayEndMs(serverTargetDay) as number;

    if (paa1.targetOrderUtc7Date !== serverTargetDay) {
      return await terminalize('pending_execution_expired_day_boundary');
    }
    if (paa1.pendingExecutionExpiresAtMs > serverPendingExpiryMs) {
      return await terminalize('attested_expiry_exceeds_authority');
    }
    if (nowMillis >= serverPendingExpiryMs) {
      // Exclusive end: expiry itself is already expired (IR-005 / GD-D1B-006).
      // Name the branch that actually bound. Under the D8 cross-midnight bar the
      // day boundary is always the earlier of the two in practice; the 72h term
      // is implemented exactly as frozen so no future gate mistakes it for dead
      // code (Architecture 001 §6.1).
      if (serverDayEndMs <= paa1.trustedApprovalLowerMs + PENDING_EXECUTION_72H_MS) {
        return await terminalize('pending_execution_expired_day_boundary');
      }
      return await terminalize('pending_execution_expired_72h');
    }

    // ── Consume: exactly one durable record, created transactionally. ──
    const offlineExecutionId = deriveOfflineVoidExecutionId({
      adjudicationId: candidateAdjudicationId,
      actionId: binding.actionId,
      targetOrderId: paa1.targetOrderId,
      branchId: paa1.branchId,
      initiatingStaffId: paa1.initiatingStaffId,
      approvingManagerStaffId: paa1.approvingManagerStaffId,
      oacId: paa1.oacId,
      audience: PRIVILEGED_VOID_AUDIENCE,
    });

    const initiatorRef = database.collection(COLLECTIONS.users).doc(paa1.initiatingStaffId);
    const managerRef = database.collection(COLLECTIONS.users).doc(paa1.approvingManagerStaffId);
    const deviceRef = database
      .collection(COLLECTIONS.deviceRegistrations)
      .doc(binding.securityDeviceIdHex);

    let adopted: unknown | undefined;
    let terminalizedInTransaction: OfflineAdjudicationRejectionReason | null = null;
    try {
      await database.runTransaction(async (tx) => {
        adopted = undefined;
        terminalizedInTransaction = null;
        const snap = await tx.get(adjudicationRef);
        const freshOrderSnap = await tx.get(orderRef);
        if (snap.exists) {
          adopted = snap.data();
          return;
        }

        // ── OPTION_A_LINEARIZE ──────────────────────────────────────────────
        // LZ-1 — every MUTABLE authority sentinel is re-read here, inside the
        // transaction that performs the irreversible consume, so the consume is
        // conditioned on authority that is current at that exact boundary and
        // not merely at preflight. Firestore enrols each read document in the
        // transaction's read set: a mutation landing after a read but before
        // the commit aborts the commit and re-runs this callback against fresh
        // snapshots, so no authority change can slip through the window.
        //
        // These reads are reached ONLY on the record-absent path: the existing
        // record adopted above returns before any of them, because an already
        // decided adjudication must replay its stored verdict verbatim and is
        // never re-authorized (IR-007 / TR-1). Linearization is first-consume only.
        //
        // The relay caller is deliberately NOT re-read. Under Model B it is
        // transport with zero authority over the bound action (see the header),
        // the void is attributed to the initiator, and the durable rejection
        // vocabulary has no relay reason. Its preflight gate is unchanged.
        const freshInitiatorSnap = await tx.get(initiatorRef);
        const freshManagerSnap = await tx.get(managerRef);
        const freshCredential = await readUserCredential(database, paa1.approvingManagerStaffId, tx);
        const freshDeviceSnap = await tx.get(deviceRef);
        const freshRevocationEpoch = await readRevocationEpoch(database, tx);
        // Read once; evaluated below against BOTH the initiator and the manager
        // role, so the two decisions can never see two different snapshots.
        const freshRolePermissions = await readRolePermissionsDoc(database, tx);

        const freshInitiator = freshInitiatorSnap.exists
          ? ((freshInitiatorSnap.data() ?? {}) as DocumentData)
          : null;
        const freshManager = freshManagerSnap.exists ? ((freshManagerSnap.data() ?? {}) as DocumentData) : null;
        const freshInitiatorRole = freshInitiator == null ? null : liveRole(freshInitiator);
        const freshManagerRole = freshManager == null ? null : liveRole(freshManager);

        const stagedDenyInTransaction = firestoreStagedRoleDenyHeadReader(database, tx);
        const readStagedDeny = async (role: string | null): Promise<LinearizedStagedDeny> => {
          // No role, no document to key a read by. Such a frame already fails
          // earlier in the precedence chain below (initiator_inactive /
          // manager_inactive_or_not_privileged), exactly as it does at F10/F11,
          // so skipping the read changes no outcome.
          if (role == null || role === '') return { malformed: false, head: null };
          try {
            return { malformed: false, head: await stagedDenyInTransaction(role) };
          } catch (err) {
            // LZ-3 — the one distinction that must not be collapsed. A present
            // but unparseable head is evidence of an active staging round that
            // cannot be verified, and still fails closed (C-A-RC-003-R1). A
            // Firestore/transaction read error is no evidence at all: it must
            // escape so the SDK can retry and, on exhaustion, the outer handler
            // returns RETRYABLE/transaction_contention. Swallowing it here
            // would durably terminalize a transient failure as a revocation.
            if (err instanceof StagedRoleDenyHeadMalformedError) return { malformed: true };
            throw err;
          }
        };
        const freshInitiatorStagedDeny = await readStagedDeny(freshInitiatorRole);
        // Staged-deny heads are keyed by ROLE, not by user: when both parties
        // hold the same role the two sentinels are the same document, and it is
        // read once.
        const freshManagerStagedDeny =
          freshManagerRole != null && freshManagerRole === freshInitiatorRole
            ? freshInitiatorStagedDeny
            : await readStagedDeny(freshManagerRole);

        const freshRegistration = parseDeviceRegistration(
          freshDeviceSnap.exists ? freshDeviceSnap.data() : null,
        );

        // LZ-2 — evaluation follows the F5→F14 preflight precedence exactly, so
        // the reason reported for a given condition is the same whether the
        // mutation landed just before or just after the preflight read.
        if (freshRegistration == null || freshRegistration.status !== 'ACTIVE') {
          // Absent or unparseable is treated as not-active: by this point the
          // frame is authenticated, so the pre-authentication PROTOCOL reasons
          // are no longer in scope and the durable vocabulary is closed.
          terminalizedInTransaction = 'device_not_active';
        } else if (freshRegistration.branchId !== paa1.branchId) {
          terminalizedInTransaction = 'device_branch_mismatch';
        } else if (freshInitiator == null) {
          terminalizedInTransaction = 'initiator_not_found';
        } else if (
          freshInitiator.isActive !== true ||
          freshInitiator.deletedAt != null ||
          (freshInitiatorRole !== 'admin' && freshInitiatorRole !== 'manager' && freshInitiatorRole !== 'staff')
        ) {
          terminalizedInTransaction = 'initiator_inactive';
        } else if (liveAuthVersion(freshInitiator) !== paa1.ssa1AuthVersionAtIssue) {
          terminalizedInTransaction = 'initiator_auth_version_changed';
        } else if (
          !linearizedRoleHoldsPosVoid(freshInitiatorRole, freshRolePermissions, freshInitiatorStagedDeny)
        ) {
          terminalizedInTransaction = 'initiator_permission_revoked';
        } else if (!relayBranchEligible(freshInitiatorRole, liveBranchIds(freshInitiator), paa1.branchId)) {
          terminalizedInTransaction = 'initiator_branch_mismatch';
        } else if (freshManager == null) {
          terminalizedInTransaction = 'manager_not_found';
        } else if (
          freshManager.isActive !== true ||
          freshManager.deletedAt != null ||
          (freshManagerRole !== 'manager' && freshManagerRole !== 'admin')
        ) {
          terminalizedInTransaction = 'manager_inactive_or_not_privileged';
        } else if (liveAuthVersion(freshManager) !== paa1.managerAuthVersionAtIssue) {
          terminalizedInTransaction = 'manager_auth_version_changed';
        } else if (
          !isUsableForLogin(freshCredential) ||
          freshCredential.credentialState !== 'rotated_authoritative' ||
          freshCredential.credentialVersion !== paa1.managerCredentialVersionAtIssue
        ) {
          terminalizedInTransaction = 'manager_credential_version_changed';
        } else if (
          !linearizedRoleHoldsPosVoid(freshManagerRole, freshRolePermissions, freshManagerStagedDeny)
        ) {
          terminalizedInTransaction = 'manager_permission_revoked';
        } else if (!approverBranchEligible(freshManagerRole, liveBranchIds(freshManager), paa1.branchId)) {
          terminalizedInTransaction = 'manager_branch_mismatch';
        } else if (freshRevocationEpoch !== paa1.revocationEpochAtIssue) {
          terminalizedInTransaction = 'revocation_epoch_changed';
        } else if (!freshOrderSnap.exists) {
          terminalizedInTransaction = 'target_order_not_found';
        } else if (isAlreadyCanonicallyVoided((freshOrderSnap.data() ?? {}) as DocumentData)) {
          terminalizedInTransaction = 'target_already_voided';
        }
        // `deviceKeyVersion` is deliberately NOT re-compared. It is an
        // authentication input, discharged at F2/F3 against the snapshot whose
        // key actually verified the frame; re-enrolment bumps it while the
        // device stays ACTIVE, and re-enrolment is not revocation. `status` is
        // the fact that withdraws authority, and it is checked above.

        const base = {
          ...binding,
          schemaVersion: OFFLINE_ADJUDICATION_RECORD_SCHEMA_VERSION,
          serverPendingExpiryMs,
          manualAttentionReason: null,
          outcomeKind: null,
          firstSeenAtMillis: nowMillis,
          terminalizedAtMillis: null,
          completedAtMillis: null,
          firstRelayCallerStaffId: callerStaffId,
          completingRelayCallerStaffId: null,
        };
        if (terminalizedInTransaction != null) {
          tx.create(adjudicationRef, {
            ...base,
            state: 'TERMINALLY_REJECTED',
            offlineExecutionId: null,
            verdict: 'REJECTED',
            rejectionReason: terminalizedInTransaction,
            consumedAtMillis: null,
            terminalizedAtMillis: nowMillis,
          });
          return;
        }
        tx.create(adjudicationRef, {
          ...base,
          state: 'CONSUMED_PENDING_EXECUTION',
          offlineExecutionId,
          verdict: null,
          rejectionReason: null,
          consumedAtMillis: nowMillis,
        });
      });
    } catch {
      return retryable('transaction_contention');
    }
    if (adopted !== undefined) return await dispatchExistingRecord(adopted, true);
    if (terminalizedInTransaction != null) return rejected(terminalizedInTransaction, false);

    return await finishPhaseC(
      {
        schemaVersion: 1,
        state: 'CONSUMED_PENDING_EXECUTION',
        ...binding,
        serverPendingExpiryMs,
        offlineExecutionId,
        verdict: null,
        rejectionReason: null,
        manualAttentionReason: null,
        outcomeKind: null,
        firstSeenAtMillis: nowMillis,
        consumedAtMillis: nowMillis,
        terminalizedAtMillis: null,
        completedAtMillis: null,
        firstRelayCallerStaffId: callerStaffId,
        completingRelayCallerStaffId: null,
      },
      false,
    );
  } catch (err) {
    if (err instanceof RetryableError) return retryable(err.retryReason);
    return retryable('internal_error');
  }
}
