import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  ADJUDICATE_OFFLINE_PRIVILEGED_ACTION_CALLABLE,
  TRANSPORT_FAILURE_DISPOSITION,
  classifyOfflineAdjudicationResponse,
  localSchedulingHint,
  parseOfflineAdjudicationResponse,
  submitOfflineAdjudication,
  type OfflineAdjudicationResponse,
} from './offlineAdjudicationTransport';
import {
  OFFLINE_ADJUDICATION_ANOMALY_REASONS,
  OFFLINE_ADJUDICATION_MANUAL_ATTENTION_REASONS,
  OFFLINE_ADJUDICATION_PROTOCOL_REASONS,
  OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY,
  OFFLINE_ADJUDICATION_RECORD_STATES,
  OFFLINE_ADJUDICATION_RECOVERABILITY_CLASSES,
  OFFLINE_ADJUDICATION_REJECTION_REASONS,
  OFFLINE_ADJUDICATION_RESPONSE_KINDS,
  OFFLINE_ADJUDICATION_RETRY_REASONS,
} from './privilegedActionTypes';

const repoRoot = resolve(__dirname, '../../../..');
const ADJ_ID = 'a1a2a3a4a5a6a7a8a9aaabacadaeaf00';
const SERVER_MS = 1_763_100_000_000;

const payload = { paa1Base64: 'UEFBMQ==', ssa1Base64: 'U1NBMQ==', oacEnvelopeBytesBase64: 'e30=' };

type ByKind<K extends OfflineAdjudicationResponse['kind']> = Extract<OfflineAdjudicationResponse, { kind: K }>;

const responses: { [K in OfflineAdjudicationResponse['kind']]: ByKind<K> } = {
  PROTOCOL_REJECTED: {
    family: 'PROTOCOL',
    kind: 'PROTOCOL_REJECTED',
    protocolReason: 'attestation_malformed',
    recoverability: 'PERMANENT',
    serverObservedAtMs: SERVER_MS,
  },
  PROTOCOL_RETRYABLE: {
    family: 'PROTOCOL',
    kind: 'PROTOCOL_RETRYABLE',
    retryReason: 'backend_unavailable',
    serverObservedAtMs: SERVER_MS,
  },
  ACCEPTED: {
    family: 'ADJUDICATION',
    kind: 'ACCEPTED',
    adjudicationId: ADJ_ID,
    targetOrderId: 'order-1',
    offlineExecutionId: 'exec-1',
    outcomeKind: 'VOID_APPLIED',
    idempotent: false,
    serverAdjudicatedAtMs: SERVER_MS,
  },
  REJECTED: {
    family: 'ADJUDICATION',
    kind: 'REJECTED',
    adjudicationId: ADJ_ID,
    targetOrderId: 'order-1',
    rejectionReason: 'device_not_active',
    terminal: true,
    idempotent: false,
    serverAdjudicatedAtMs: SERVER_MS,
  },
  MANUAL_ATTENTION_REQUIRED: {
    family: 'ADJUDICATION',
    kind: 'MANUAL_ATTENTION_REQUIRED',
    adjudicationId: ADJ_ID,
    targetOrderId: 'order-1',
    manualAttentionReason: 'canonical_correlation_conflict',
    terminal: true,
    idempotent: false,
    serverAdjudicatedAtMs: SERVER_MS,
  },
  ADJUDICATION_ANOMALY: {
    family: 'ADJUDICATION',
    kind: 'ADJUDICATION_ANOMALY',
    adjudicationId: ADJ_ID,
    targetOrderId: 'order-1',
    anomalyReason: 'adjudication_record_binding_conflict',
    terminalForAutomation: true,
    recordWritten: false,
    serverObservedAtMs: SERVER_MS,
  },
  RETRYABLE: {
    family: 'ADJUDICATION',
    kind: 'RETRYABLE',
    adjudicationId: ADJ_ID,
    retryReason: 'transaction_contention',
    terminal: false,
    serverAdjudicatedAtMs: SERVER_MS,
  },
};

describe('offlineAdjudicationTransport', () => {
  test('the callable name and the seven response kinds are complete and closed', () => {
    expect(ADJUDICATE_OFFLINE_PRIVILEGED_ACTION_CALLABLE).toBe('adjudicateOfflinePrivilegedAction');
    expect(Object.keys(responses).sort()).toEqual([...OFFLINE_ADJUDICATION_RESPONSE_KINDS].sort());
    expect(OFFLINE_ADJUDICATION_RESPONSE_KINDS).toHaveLength(7);
  });

  test('every kind round-trips through the strict parser', () => {
    for (const [kind, response] of Object.entries(responses)) {
      expect(parseOfflineAdjudicationResponse(JSON.parse(JSON.stringify(response))), kind).toEqual(response);
    }
  });

  test('every kind classifies totally, and only three ever write a verdict', () => {
    const verdictWriters = new Set<string>();
    for (const [kind, response] of Object.entries(responses)) {
      const d = classifyOfflineAdjudicationResponse(response);
      expect(typeof d.retryable, kind).toBe('boolean');
      expect(OFFLINE_ADJUDICATION_RECOVERABILITY_CLASSES.length, kind).toBe(3);
      if (d.serverVerdict != null) verdictWriters.add(kind);
    }
    // AN-4 and the frozen rule: no verdict from anomaly, retryable, or Family 1.
    expect([...verdictWriters].sort()).toEqual(['ACCEPTED', 'REJECTED']);
    expect(classifyOfflineAdjudicationResponse(responses.ADJUDICATION_ANOMALY).serverVerdict).toBeNull();
    expect(classifyOfflineAdjudicationResponse(responses.RETRYABLE).serverVerdict).toBeNull();
    expect(classifyOfflineAdjudicationResponse(responses.PROTOCOL_REJECTED).serverVerdict).toBeNull();
    expect(classifyOfflineAdjudicationResponse(responses.PROTOCOL_RETRYABLE).serverVerdict).toBeNull();
    expect(classifyOfflineAdjudicationResponse(responses.MANUAL_ATTENTION_REQUIRED).serverVerdict).toBeNull();
  });

  test('recoverability, not the reason string, decides Family-1 retryability', () => {
    for (const protocolReason of OFFLINE_ADJUDICATION_PROTOCOL_REASONS) {
      const recoverability = OFFLINE_ADJUDICATION_PROTOCOL_REASON_RECOVERABILITY[protocolReason];
      const response: OfflineAdjudicationResponse = {
        family: 'PROTOCOL',
        kind: 'PROTOCOL_REJECTED',
        protocolReason,
        recoverability,
        serverObservedAtMs: SERVER_MS,
      };
      const d = classifyOfflineAdjudicationResponse(response);
      expect(d.retryable, protocolReason).toBe(recoverability !== 'PERMANENT');
      expect(d.serverVerdict, protocolReason).toBeNull();
      if (recoverability === 'PERMANENT') {
        expect(d.syncStatus, protocolReason).toBe('MANUAL_ATTENTION');
        expect(d.manualReviewStatus, protocolReason).toBe('REQUIRED');
      } else {
        expect(d.syncStatus, protocolReason).toBe('PRIVILEGED_INTENT_QUEUED');
      }
    }
  });

  test('all three retry reasons are retryable and claim nothing', () => {
    for (const retryReason of OFFLINE_ADJUDICATION_RETRY_REASONS) {
      for (const response of [
        { ...responses.RETRYABLE, retryReason },
        { ...responses.PROTOCOL_RETRYABLE, retryReason },
      ] as OfflineAdjudicationResponse[]) {
        const d = classifyOfflineAdjudicationResponse(response);
        expect(d).toEqual({
          retryable: true,
          terminalForAutomation: false,
          syncStatus: 'PRIVILEGED_INTENT_QUEUED',
          manualReviewStatus: 'NOT_REQUIRED',
          serverVerdict: null,
          serverRejectionReason: null,
          offlineExecutionId: null,
          outcomeKind: null,
        });
      }
    }
  });

  test('all 32 rejection reasons and all 3 manual-attention reasons classify terminally', () => {
    for (const rejectionReason of OFFLINE_ADJUDICATION_REJECTION_REASONS) {
      const d = classifyOfflineAdjudicationResponse({ ...responses.REJECTED, rejectionReason });
      expect(d.retryable, rejectionReason).toBe(false);
      expect(d.serverVerdict, rejectionReason).toBe('REJECTED');
      expect(d.serverRejectionReason, rejectionReason).toBe(rejectionReason);
    }
    for (const manualAttentionReason of OFFLINE_ADJUDICATION_MANUAL_ATTENTION_REASONS) {
      const d = classifyOfflineAdjudicationResponse({ ...responses.MANUAL_ATTENTION_REQUIRED, manualAttentionReason });
      expect(d.retryable, manualAttentionReason).toBe(false);
      expect(d.syncStatus, manualAttentionReason).toBe('MANUAL_ATTENTION');
    }
    for (const anomalyReason of OFFLINE_ADJUDICATION_ANOMALY_REASONS) {
      const d = classifyOfflineAdjudicationResponse({ ...responses.ADJUDICATION_ANOMALY, anomalyReason });
      expect(d.retryable, anomalyReason).toBe(false);
      expect(d.serverVerdict, anomalyReason).toBeNull();
    }
    expect(OFFLINE_ADJUDICATION_RECORD_STATES).toHaveLength(4);
  });

  test('an unrecognised, tampered, or mistyped response is never coerced into a verdict', () => {
    expect(parseOfflineAdjudicationResponse(null)).toBeNull();
    expect(parseOfflineAdjudicationResponse('nope')).toBeNull();
    expect(parseOfflineAdjudicationResponse({ family: 'ADJUDICATION', kind: 'SOMETHING_NEW' })).toBeNull();
    expect(parseOfflineAdjudicationResponse({ ...responses.REJECTED, rejectionReason: 'made_up' })).toBeNull();
    expect(parseOfflineAdjudicationResponse({ ...responses.REJECTED, terminal: false })).toBeNull();
    expect(parseOfflineAdjudicationResponse({ ...responses.ACCEPTED, outcomeKind: 'MADE_UP' })).toBeNull();
    expect(parseOfflineAdjudicationResponse({ ...responses.ADJUDICATION_ANOMALY, recordWritten: true })).toBeNull();
    // A recoverability class that disagrees with the frozen classifier is refused.
    expect(
      parseOfflineAdjudicationResponse({ ...responses.PROTOCOL_REJECTED, recoverability: 'STATE_DEPENDENT' }),
    ).toBeNull();
  });

  test('a thrown callable or an unparseable response is a retryable transport failure', async () => {
    const thrown = await submitOfflineAdjudication(async () => {
      throw new Error('offline');
    }, payload);
    expect(thrown).toEqual({ response: null, disposition: TRANSPORT_FAILURE_DISPOSITION });
    expect(TRANSPORT_FAILURE_DISPOSITION.serverVerdict).toBeNull();
    expect(TRANSPORT_FAILURE_DISPOSITION.retryable).toBe(true);

    const garbage = await submitOfflineAdjudication(async () => ({ family: 'NOPE' }), payload);
    expect(garbage).toEqual({ response: null, disposition: TRANSPORT_FAILURE_DISPOSITION });
  });

  test('a successful attempt sends the byte-identical payload and returns the classified response', async () => {
    const seen: (typeof payload)[] = [];
    const callable = vi.fn(async (p: typeof payload) => {
      seen.push(p);
      return responses.ACCEPTED as unknown;
    });
    const result = await submitOfflineAdjudication(callable, payload);
    expect(callable).toHaveBeenCalledWith(payload);
    expect(result.response).toEqual(responses.ACCEPTED);
    expect(result.disposition.serverVerdict).toBe('ACCEPTED');
    expect(result.disposition.offlineExecutionId).toBe('exec-1');

    // Retrying sends exactly the same bytes; nothing is re-minted.
    await submitOfflineAdjudication(callable, payload);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
  });

  test('AC-10/AC-17 — the local wall clock may deprioritize but never render a row ineligible', () => {
    const expiry = SERVER_MS;
    for (const localNowMs of [0, expiry - 1, expiry, expiry + 1, expiry + 10 * 365 * 86_400_000]) {
      const hint = localSchedulingHint(expiry, localNowMs);
      expect(hint.eligibleForNextAttempt, String(localNowMs)).toBe(true);
    }
    expect(localSchedulingHint(expiry, expiry + 1).deprioritize).toBe(true);
    expect(localSchedulingHint(expiry, expiry - 1).deprioritize).toBe(false);
    expect(localSchedulingHint(Number.NaN, Date.now()).deprioritize).toBe(false);
  });

  test('WC-3/WC-4/WC-5 — the module contains no clock-derived terminal decision', () => {
    const src = readFileSync(
      resolve(repoRoot, 'src/lib/auth/privilegedAction/offlineAdjudicationTransport.ts'),
      'utf8',
    );
    // The only clock-shaped input is the scheduling hint's explicit parameter.
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).not.toMatch(/performance\.now/);
    // No expiry reason is ever produced client-side.
    for (const reason of [
      'pending_execution_expired_72h',
      'pending_execution_expired_day_boundary',
      'attested_expiry_exceeds_authority',
    ]) {
      expect(src, reason).not.toContain(`'${reason}'`);
    }
    // The classifier takes exactly one argument — a response — so no disposition
    // can be a function of local state.
    expect(src).toMatch(/export function classifyOfflineAdjudicationResponse\(\s*response: OfflineAdjudicationResponse,\s*\)/);
  });
});
