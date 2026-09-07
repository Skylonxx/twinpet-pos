/**
 * offlineAdjudicationTransport — SEC-001 Packet D / D-1B client transport.
 *
 * Sends the stored attestation bytes to `adjudicateOfflinePrivilegedAction` and
 * classifies the seven response kinds. It is a *classifier*, not a decider:
 *
 * - It never computes a verdict, an expiry, or a rejection reason.
 * - It never consults the local wall clock for anything terminal (WC-1…WC-5).
 *   `pendingExecutionExpiresAtMs` may only bias queue ordering and bounded
 *   backoff; it may not suppress, disable, or permanently deprioritize a row,
 *   and it may not advance, reset, or bypass any attempt counter.
 * - `serverVerdict` is written only from `ACCEPTED`, `REJECTED`, or
 *   `MANUAL_ATTENTION_REQUIRED`. Never from `ADJUDICATION_ANOMALY`, never from
 *   a retryable response, never from a Family-1 response.
 *
 * D-2 owns the journal, the scheduler, the backoff curve, and the attempt
 * ceiling. D-1B owns — and this module ships — the constraints D-2 must obey.
 */

import {
  OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY,
  isOfflineAdjudicationAnomalyReason,
  isOfflineAdjudicationManualAttentionReason,
  isOfflineAdjudicationOutcomeKind,
  isOfflineAdjudicationProtocolReason,
  isOfflineAdjudicationRejectionReason,
  isOfflineAdjudicationRetryReason,
  type OfflineAdjudicationAnomalyReason,
  type OfflineAdjudicationManualAttentionReason,
  type OfflineAdjudicationOutcomeKind,
  type OfflineAdjudicationProtocolReason,
  type OfflineAdjudicationRecoverability,
  type OfflineAdjudicationRejectionReason,
  type OfflineAdjudicationRetryReason,
  type PrivilegedEvidenceSyncStatus,
  type PrivilegedManualReviewStatus,
  type PrivilegedServerVerdict,
} from './privilegedActionTypes';

export const ADJUDICATE_OFFLINE_PRIVILEGED_ACTION_CALLABLE = 'adjudicateOfflinePrivilegedAction' as const;

export type OfflineAdjudicationResponse =
  | {
      family: 'PROTOCOL';
      kind: 'PROTOCOL_REJECTED';
      protocolReason: OfflineAdjudicationProtocolReason;
      recoverability: OfflineAdjudicationRecoverability;
      serverObservedAtMs: number;
    }
  | { family: 'PROTOCOL'; kind: 'PROTOCOL_RETRYABLE'; retryReason: OfflineAdjudicationRetryReason; serverObservedAtMs: number }
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

/**
 * What D-2 persists for a single adjudication attempt. Every field here is
 * carried from the server response; none is computed locally.
 */
export interface OfflineAdjudicationDisposition {
  /** Retry the byte-identical attestation? Decided from the response, never from a reason string. */
  retryable: boolean;
  /** Automation is finished with this row (it may still need a human). */
  terminalForAutomation: boolean;
  syncStatus: PrivilegedEvidenceSyncStatus;
  manualReviewStatus: PrivilegedManualReviewStatus;
  /** Only ACCEPTED / REJECTED / MANUAL_ATTENTION_REQUIRED ever write a verdict. */
  serverVerdict: PrivilegedServerVerdict | null;
  serverRejectionReason: string | null;
  offlineExecutionId: string | null;
  outcomeKind: OfflineAdjudicationOutcomeKind | null;
}

/** A transport-level failure (no response at all) is always safely retryable. */
export const TRANSPORT_FAILURE_DISPOSITION: OfflineAdjudicationDisposition = Object.freeze({
  retryable: true,
  terminalForAutomation: false,
  syncStatus: 'PRIVILEGED_INTENT_QUEUED',
  manualReviewStatus: 'NOT_REQUIRED',
  serverVerdict: null,
  serverRejectionReason: null,
  offlineExecutionId: null,
  outcomeKind: null,
});

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Strict parse of a server response. Anything unrecognised is *not* coerced
 * into a verdict — it is rejected, and the caller treats it as a transport
 * failure, i.e. retryable with no durable claim.
 */
export function parseOfflineAdjudicationResponse(raw: unknown): OfflineAdjudicationResponse | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (r.family === 'PROTOCOL') {
    if (r.kind === 'PROTOCOL_REJECTED') {
      if (!isOfflineAdjudicationProtocolReason(r.protocolReason)) return null;
      if (!isFiniteNumber(r.serverObservedAtMs)) return null;
      // The recoverability class must agree with the frozen classifier both
      // sides share; a disagreeing response is refused, never reinterpreted.
      const recoverability = OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY[r.protocolReason];
      if (r.recoverability !== recoverability) return null;
      return {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_REJECTED',
        protocolReason: r.protocolReason,
        recoverability,
        serverObservedAtMs: r.serverObservedAtMs,
      };
    }
    if (r.kind === 'PROTOCOL_RETRYABLE') {
      if (!isOfflineAdjudicationRetryReason(r.retryReason) || !isFiniteNumber(r.serverObservedAtMs)) return null;
      return {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_RETRYABLE',
        retryReason: r.retryReason,
        serverObservedAtMs: r.serverObservedAtMs,
      };
    }
    return null;
  }

  if (r.family !== 'ADJUDICATION') return null;

  if (r.kind === 'RETRYABLE') {
    if (!isNonEmptyString(r.adjudicationId) || !isOfflineAdjudicationRetryReason(r.retryReason)) return null;
    if (r.terminal !== false || !isFiniteNumber(r.serverAdjudicatedAtMs)) return null;
    return {
      family: 'ADJUDICATION',
      kind: 'RETRYABLE',
      adjudicationId: r.adjudicationId,
      retryReason: r.retryReason,
      terminal: false,
      serverAdjudicatedAtMs: r.serverAdjudicatedAtMs,
    };
  }

  if (!isNonEmptyString(r.adjudicationId) || !isNonEmptyString(r.targetOrderId)) return null;

  if (r.kind === 'ACCEPTED') {
    if (!isNonEmptyString(r.offlineExecutionId) || !isOfflineAdjudicationOutcomeKind(r.outcomeKind)) return null;
    if (typeof r.idempotent !== 'boolean' || !isFiniteNumber(r.serverAdjudicatedAtMs)) return null;
    return {
      family: 'ADJUDICATION',
      kind: 'ACCEPTED',
      adjudicationId: r.adjudicationId,
      targetOrderId: r.targetOrderId,
      offlineExecutionId: r.offlineExecutionId,
      outcomeKind: r.outcomeKind,
      idempotent: r.idempotent,
      serverAdjudicatedAtMs: r.serverAdjudicatedAtMs,
    };
  }
  if (r.kind === 'REJECTED') {
    if (!isOfflineAdjudicationRejectionReason(r.rejectionReason)) return null;
    if (r.terminal !== true || typeof r.idempotent !== 'boolean' || !isFiniteNumber(r.serverAdjudicatedAtMs)) return null;
    return {
      family: 'ADJUDICATION',
      kind: 'REJECTED',
      adjudicationId: r.adjudicationId,
      targetOrderId: r.targetOrderId,
      rejectionReason: r.rejectionReason,
      terminal: true,
      idempotent: r.idempotent,
      serverAdjudicatedAtMs: r.serverAdjudicatedAtMs,
    };
  }
  if (r.kind === 'MANUAL_ATTENTION_REQUIRED') {
    if (!isOfflineAdjudicationManualAttentionReason(r.manualAttentionReason)) return null;
    if (r.terminal !== true || typeof r.idempotent !== 'boolean' || !isFiniteNumber(r.serverAdjudicatedAtMs)) return null;
    return {
      family: 'ADJUDICATION',
      kind: 'MANUAL_ATTENTION_REQUIRED',
      adjudicationId: r.adjudicationId,
      targetOrderId: r.targetOrderId,
      manualAttentionReason: r.manualAttentionReason,
      terminal: true,
      idempotent: r.idempotent,
      serverAdjudicatedAtMs: r.serverAdjudicatedAtMs,
    };
  }
  if (r.kind === 'ADJUDICATION_ANOMALY') {
    if (!isOfflineAdjudicationAnomalyReason(r.anomalyReason)) return null;
    if (r.terminalForAutomation !== true || r.recordWritten !== false) return null;
    if (!isFiniteNumber(r.serverObservedAtMs)) return null;
    return {
      family: 'ADJUDICATION',
      kind: 'ADJUDICATION_ANOMALY',
      adjudicationId: r.adjudicationId,
      targetOrderId: r.targetOrderId,
      anomalyReason: r.anomalyReason,
      terminalForAutomation: true,
      recordWritten: false,
      serverObservedAtMs: r.serverObservedAtMs,
    };
  }
  return null;
}

/**
 * Total classifier over the seven response kinds. Takes no clock and no local
 * state, so a disposition can never be a function of the device's wall clock.
 */
export function classifyOfflineAdjudicationResponse(
  response: OfflineAdjudicationResponse,
): OfflineAdjudicationDisposition {
  switch (response.kind) {
    case 'ACCEPTED':
      return {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'SERVER_ACCEPTED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: 'ACCEPTED',
        serverRejectionReason: null,
        offlineExecutionId: response.offlineExecutionId,
        outcomeKind: response.outcomeKind,
      };
    case 'REJECTED':
      return {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'SERVER_REJECTED',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: 'REJECTED',
        serverRejectionReason: response.rejectionReason,
        offlineExecutionId: null,
        outcomeKind: null,
      };
    case 'MANUAL_ATTENTION_REQUIRED':
      return {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'MANUAL_ATTENTION',
        manualReviewStatus: 'REQUIRED',
        // MANUAL_ATTENTION_REQUIRED is an adjudication outcome, but it is not
        // an ACCEPTED/REJECTED verdict; the frozen verdict enum has no member
        // for it, so nothing is claimed.
        serverVerdict: null,
        serverRejectionReason: response.manualAttentionReason,
        offlineExecutionId: null,
        outcomeKind: null,
      };
    case 'ADJUDICATION_ANOMALY':
      // AN-4: no server verdict. The server reached no adjudication at all.
      return {
        retryable: false,
        terminalForAutomation: true,
        syncStatus: 'MANUAL_ATTENTION',
        manualReviewStatus: 'REQUIRED',
        serverVerdict: null,
        serverRejectionReason: response.anomalyReason,
        offlineExecutionId: null,
        outcomeKind: null,
      };
    case 'RETRYABLE':
    case 'PROTOCOL_RETRYABLE':
      return {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: null,
        serverRejectionReason: null,
        offlineExecutionId: null,
        outcomeKind: null,
      };
    case 'PROTOCOL_REJECTED': {
      // `recoverability`, not local judgment, decides retryability.
      if (response.recoverability === 'PERMANENT') {
        return {
          retryable: false,
          terminalForAutomation: true,
          syncStatus: 'MANUAL_ATTENTION',
          manualReviewStatus: 'REQUIRED',
          serverVerdict: null,
          serverRejectionReason: response.protocolReason,
          offlineExecutionId: null,
          outcomeKind: null,
        };
      }
      return {
        retryable: true,
        terminalForAutomation: false,
        syncStatus: 'PRIVILEGED_INTENT_QUEUED',
        manualReviewStatus: 'NOT_REQUIRED',
        serverVerdict: null,
        serverRejectionReason: null,
        offlineExecutionId: null,
        outcomeKind: null,
      };
    }
  }
}

export interface OfflineAdjudicationAttemptResult {
  response: OfflineAdjudicationResponse | null;
  disposition: OfflineAdjudicationDisposition;
}

export type AdjudicationCallable = (payload: {
  paa1Base64: string;
  ssa1Base64: string;
  oacEnvelopeBytesBase64: string;
}) => Promise<unknown>;

/**
 * One adjudication attempt. A thrown callable, an absent response, or an
 * unrecognised shape all resolve to the retryable transport disposition — the
 * client never invents a verdict it did not receive.
 */
export async function submitOfflineAdjudication(
  callable: AdjudicationCallable,
  payload: { paa1Base64: string; ssa1Base64: string; oacEnvelopeBytesBase64: string },
): Promise<OfflineAdjudicationAttemptResult> {
  let raw: unknown;
  try {
    raw = await callable(payload);
  } catch {
    return { response: null, disposition: TRANSPORT_FAILURE_DISPOSITION };
  }
  const response = parseOfflineAdjudicationResponse(raw);
  if (response == null) return { response: null, disposition: TRANSPORT_FAILURE_DISPOSITION };
  return { response, disposition: classifyOfflineAdjudicationResponse(response) };
}

/**
 * WC-1/WC-2 — the only role the local wall clock is permitted to play.
 *
 * A locally-perceived-expired row may be ordered behind fresher rows and given
 * the policy's longest backoff, and nothing more. It is never rendered
 * ineligible, and its eligibility is not a function of the clock.
 *
 * D-2 owns `S_max`, the ceiling value, and the backoff curve. D-1B owns only
 * the guarantee that none of them may be derived from the clock.
 */
export function localSchedulingHint(
  pendingExecutionExpiresAtMs: number,
  localNowMs: number,
): { deprioritize: boolean; eligibleForNextAttempt: true } {
  return {
    deprioritize: isFiniteNumber(pendingExecutionExpiresAtMs) && localNowMs > pendingExecutionExpiresAtMs,
    // Structurally constant: no clock value can make a non-terminal row
    // ineligible for the next authoritative server attempt.
    eligibleForNextAttempt: true,
  };
}
