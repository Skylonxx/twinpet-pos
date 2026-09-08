import { describe, expect, it } from 'vitest';
import type { PrivilegedVoidFlowState, PrivilegedVoidLocalFailureReason } from './privilegedVoidFlowMachine';
import { copyForFlowState, pinErrorCopy, rosterFailClosedReason } from './privilegedVoidCopy';

const IDENTITY = {
  localIntentId: 'intent-1',
  actionId: 'VOID_PENDING_SALE' as const,
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2026-09-07',
  targetBranchId: 'LDP-001',
  operatorStaffId: 'staff-1',
  managerStaffId: 'mgr-1',
};

const SAFE_ROW = {
  targetOrderId: 'order-1',
  classification: 'active_open' as const,
  syncStatus: 'PRIVILEGED_INTENT_QUEUED' as const,
  manualReviewStatus: 'NOT_REQUIRED' as const,
  serverVerdict: null,
  updatedAtMs: 1_000,
};

const RECORD_SUMMARY = {
  adjudicationId: 'a'.repeat(32),
  localIntentId: 'intent-1',
  actionId: 'VOID_PENDING_SALE' as const,
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2026-09-07',
  branchId: 'LDP-001',
  approvingManagerStaffId: 'mgr-1',
  syncStatus: 'PRIVILEGED_INTENT_QUEUED' as const,
  manualReviewStatus: 'NOT_REQUIRED' as const,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};

// A completed/legacy-void success phrase must NEVER appear anywhere in this
// module's copy — `projected`/`already_projected` means captured-and-pending
// ONLY, never a completed void (Section 8/15 false-success guard).
const FORBIDDEN_FALSE_SUCCESS_PHRASES = ['ยกเลิกบิลสำเร็จ', 'ยกเลิกสำเร็จ', 'ดำเนินการสำเร็จ'];

const NON_RESULT_STATES: PrivilegedVoidFlowState[] = [
  { status: 'IDLE' },
  { status: 'PRECHECK', identity: IDENTITY },
  { status: 'VOID_REASON_ENTRY', identity: IDENTITY, reason: '', note: '' },
  { status: 'MANAGER_SELECT', identity: IDENTITY, reason: 'r', note: '' },
  { status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null },
  { status: 'PROJECTING', identity: IDENTITY, reason: 'r', note: '' },
];

const RESULT_STATES: PrivilegedVoidFlowState[] = [
  { status: 'CAPTURED_PENDING_ADJUDICATION', identity: IDENTITY, record: RECORD_SUMMARY },
  { status: 'TERMINAL_SERVER_ACCEPTED', identity: IDENTITY, row: SAFE_ROW },
  { status: 'TERMINAL_SERVER_REJECTED', identity: IDENTITY, row: SAFE_ROW },
  { status: 'MANUAL_ATTENTION', identity: IDENTITY, row: SAFE_ROW },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'unavailable' },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'durable_unavailable' },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'integrity_conflict' },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'stale_context' },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'denied_locked' },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'denied_stale' },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'denied_unverifiable' },
  { status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'denied_unknown' },
  { status: 'LOCAL_UNCERTAIN', identity: IDENTITY },
  { status: 'RECOVERED_ACTIVE', identity: IDENTITY, row: SAFE_ROW },
  { status: 'RECOVERED_ACTIVE', identity: IDENTITY, row: null },
];

describe('copyForFlowState', () => {
  it('returns null for every interactive (non-result) step', () => {
    for (const state of NON_RESULT_STATES) {
      expect(copyForFlowState(state)).toBeNull();
    }
  });

  it('returns non-empty title/body/tone for every result state', () => {
    for (const state of RESULT_STATES) {
      const copy = copyForFlowState(state);
      expect(copy, state.status).not.toBeNull();
      expect(copy!.title.length).toBeGreaterThan(0);
      expect(copy!.body.length).toBeGreaterThan(0);
      expect(['pending', 'info', 'warning', 'error']).toContain(copy!.tone);
    }
  });

  it('CAPTURED_PENDING_ADJUDICATION never claims the void is complete', () => {
    const copy = copyForFlowState({ status: 'CAPTURED_PENDING_ADJUDICATION', identity: IDENTITY, record: RECORD_SUMMARY })!;
    expect(copy.title + copy.body).not.toMatch(/ยกเลิก.*สำเร็จ/);
    expect(copy.title + copy.body).toContain('รอ');
  });

  it('false-success guard: no result copy anywhere ever claims a completed void', () => {
    for (const state of RESULT_STATES) {
      const copy = copyForFlowState(state)!;
      for (const phrase of FORBIDDEN_FALSE_SUCCESS_PHRASES) {
        expect(copy.title, `${state.status} title`).not.toContain(phrase);
        expect(copy.body, `${state.status} body`).not.toContain(phrase);
      }
    }
  });

  it('produces distinct copy for each LOCAL_FAILURE reason code', () => {
    const reasons: PrivilegedVoidLocalFailureReason[] = [
      'unavailable',
      'durable_unavailable',
      'integrity_conflict',
      'stale_context',
      'denied_locked',
      'denied_stale',
      'denied_unverifiable',
      'denied_unknown',
    ];
    const titles = reasons.map((reasonCode) => copyForFlowState({ status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode })!.title);
    expect(new Set(titles).size).toBe(reasons.length);
  });

  it('RC-E1-004: none of the structural-denial copy renders a raw D-1B error code or the word "PIN" as a retry invitation', () => {
    const denialReasons: PrivilegedVoidLocalFailureReason[] = ['denied_locked', 'denied_stale', 'denied_unverifiable', 'denied_unknown'];
    for (const reasonCode of denialReasons) {
      const copy = copyForFlowState({ status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode })!;
      expect(copy.title + copy.body).not.toMatch(/DENIED_|APPROVAL_UNAVAILABLE|TOO_MANY_ATTEMPTS|MANAGER_NOT_AUTHORIZED|SERVER_REJECTED|LEGACY_PIN4|OAC_PROVISION/);
    }
  });
});

describe('pinErrorCopy', () => {
  it('never renders the raw errorCode verbatim', () => {
    expect(pinErrorCopy('SOME_INTERNAL_D1B_CODE')).not.toContain('SOME_INTERNAL_D1B_CODE');
    expect(pinErrorCopy(null)).not.toContain('null');
  });

  it('is stable regardless of the errorCode value (no internal-reason branching)', () => {
    expect(pinErrorCopy('a')).toBe(pinErrorCopy('b'));
    expect(pinErrorCopy(null)).toBe(pinErrorCopy('anything'));
  });
});

describe('rosterFailClosedReason', () => {
  it('fails closed on disabled/error unconditionally', () => {
    expect(rosterFailClosedReason({ status: 'disabled', fromCache: false, candidates: [] })).not.toBeNull();
    expect(rosterFailClosedReason({ status: 'error', fromCache: false, candidates: [] })).not.toBeNull();
  });

  it('pending is not a failure (still loading)', () => {
    expect(rosterFailClosedReason({ status: 'pending', fromCache: false, candidates: [] })).toBeNull();
  });

  it('ready with candidates is not a failure', () => {
    expect(
      rosterFailClosedReason({ status: 'ready', fromCache: false, candidates: [{ userId: 'u1' } as never] }),
    ).toBeNull();
  });

  it('ready + empty + fromCache=false is a CONFIRMED-empty failure, distinct copy from the cache-derived case', () => {
    const confirmedEmpty = rosterFailClosedReason({ status: 'ready', fromCache: false, candidates: [] });
    const cacheEmpty = rosterFailClosedReason({ status: 'ready', fromCache: true, candidates: [] });
    expect(confirmedEmpty).not.toBeNull();
    expect(cacheEmpty).not.toBeNull();
    expect(confirmedEmpty).not.toBe(cacheEmpty);
  });
});
