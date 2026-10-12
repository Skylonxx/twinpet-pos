/**
 * TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002 — D-V7/D-V9 pure
 * machine + copy contract: distinct denial classes, JIT provisioning
 * transitions, closed copy (no raw native codes), unchanged invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOacProvisioningOutcome,
  applyPostProvisionProjectionOutcome,
  applyProjectionOutcome,
  beginOacProvisioning,
  classifyPinDenial,
  oacProvisioningTriggerFor,
  type PrivilegedVoidFlowIdentity,
  type PrivilegedVoidFlowState,
  type PrivilegedVoidLocalFailureReason,
} from './privilegedVoidFlowMachine';
import { copyForFlowState, PRIVILEGED_VOID_QUICK_PIN_REQUIRED_COPY } from './privilegedVoidCopy';
import { isEligibleApproverCandidate } from '../../auth/approverEligibility';

const IDENTITY: PrivilegedVoidFlowIdentity = {
  localIntentId: 'intent-1',
  actionId: 'VOID_SETTLED_SALE',
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2026-10-11',
  targetBranchId: 'LDP-001',
  operatorStaffId: 'staff-1',
  managerStaffId: 'mgr-1',
};
const PROJECTING: PrivilegedVoidFlowState = { status: 'PROJECTING', identity: IDENTITY, reason: 'r', note: 'n' };
const denied = (errorCode: string) => ({ kind: 'not_approved' as const, errorCode });

describe('D-V9 denial classification', () => {
  it('distinguishes staff session / OAC missing / OAC stale / unverifiable / PIN / lockout', () => {
    expect(classifyPinDenial('DENIED_STAFF_SESSION')).toBe('staff_session');
    expect(classifyPinDenial('DENIED_OAC_MISSING')).toBe('oac_missing');
    expect(classifyPinDenial('DENIED_OAC_STALE')).toBe('oac_stale');
    expect(classifyPinDenial('DENIED_UNVERIFIABLE')).toBe('unverifiable');
    expect(classifyPinDenial('DENIED_INVALID_PIN')).toBe('retry_same_intent');
    expect(classifyPinDenial('DENIED_LOCKED')).toBe('locked');
    expect(classifyPinDenial('DENIED_STALE')).toBe('stale');
    expect(classifyPinDenial('SOMETHING_NEW')).toBe('unknown');
    expect(classifyPinDenial(null)).toBe('unknown');
  });

  it.each([
    ['DENIED_STAFF_SESSION', 'denied_staff_session'],
    ['DENIED_OAC_MISSING', 'denied_oac_missing'],
    ['DENIED_OAC_STALE', 'denied_oac_stale'],
    ['DENIED_UNVERIFIABLE', 'denied_unverifiable'],
    ['DENIED_LOCKED', 'denied_locked'],
  ])('%s -> LOCAL_FAILURE/%s (fail closed)', (code, reason) => {
    expect(applyProjectionOutcome(PROJECTING, denied(code))).toEqual({
      status: 'LOCAL_FAILURE',
      identity: IDENTITY,
      reasonCode: reason,
    });
  });

  it('wrong PIN stays the same-intent retry (lockout accounting stays native)', () => {
    expect(applyProjectionOutcome(PROJECTING, denied('DENIED_INVALID_PIN'))).toMatchObject({
      status: 'MANAGER_PIN_ENTRY',
      identity: IDENTITY,
      pinErrorCode: 'DENIED_INVALID_PIN',
    });
  });
});

describe('D-V7 JIT provisioning transitions', () => {
  it('only a missing/stale manager OAC triggers provisioning', () => {
    expect(oacProvisioningTriggerFor(denied('DENIED_OAC_MISSING'))).toBe('oac_missing');
    expect(oacProvisioningTriggerFor(denied('DENIED_OAC_STALE'))).toBe('oac_stale');
    for (const code of ['DENIED_STAFF_SESSION', 'DENIED_INVALID_PIN', 'DENIED_LOCKED', 'DENIED_UNVERIFIABLE', 'DENIED_STALE']) {
      expect(oacProvisioningTriggerFor(denied(code))).toBeNull();
    }
    expect(oacProvisioningTriggerFor({ kind: 'unavailable' })).toBeNull();
    expect(oacProvisioningTriggerFor({ kind: 'duplicate_target' })).toBeNull();
  });

  it('PROJECTING -> PROVISIONING_APPROVAL keeps the same identity/reason/note', () => {
    const next = beginOacProvisioning(PROJECTING, denied('DENIED_OAC_STALE'));
    expect(next).toEqual({ status: 'PROVISIONING_APPROVAL', identity: IDENTITY, reason: 'r', note: 'n', trigger: 'oac_stale' });
    // Not from any other state, not for another outcome.
    expect(beginOacProvisioning(PROJECTING, denied('DENIED_INVALID_PIN'))).toBe(PROJECTING);
    const idle: PrivilegedVoidFlowState = { status: 'IDLE' };
    expect(beginOacProvisioning(idle, denied('DENIED_OAC_MISSING'))).toBe(idle);
  });

  it('provisioned -> PROJECTING (same request) for exactly one retry', () => {
    const prov = beginOacProvisioning(PROJECTING, denied('DENIED_OAC_MISSING'));
    expect(applyOacProvisioningOutcome(prov, { kind: 'provisioned' })).toEqual(PROJECTING);
  });

  it.each([
    [{ kind: 'offline' } as const, 'oac_missing', 'denied_oac_missing'],
    [{ kind: 'offline' } as const, 'oac_stale', 'denied_oac_stale'],
    [{ kind: 'pin_rejected' } as const, 'oac_missing', 'provisioning_pin_rejected'],
    [{ kind: 'not_eligible' } as const, 'oac_missing', 'provisioning_not_eligible'],
    [{ kind: 'device_not_ready' } as const, 'oac_missing', 'provisioning_device_not_ready'],
    [{ kind: 'failed' } as const, 'oac_stale', 'provisioning_failed'],
    [{ kind: 'uncertain' } as const, 'oac_stale', 'provisioning_uncertain'],
  ])('%o (trigger %s) -> terminal %s', (outcome, trigger, reason) => {
    const prov = beginOacProvisioning(PROJECTING, denied(trigger === 'oac_stale' ? 'DENIED_OAC_STALE' : 'DENIED_OAC_MISSING'));
    expect(applyOacProvisioningOutcome(prov, outcome)).toEqual({ status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: reason });
  });

  it('provisioning outcomes are ignored outside PROVISIONING_APPROVAL', () => {
    expect(applyOacProvisioningOutcome(PROJECTING, { kind: 'provisioned' })).toBe(PROJECTING);
  });
});

describe('D-V9 copy — distinct, closed, never raw codes', () => {
  const fail = (reasonCode: PrivilegedVoidLocalFailureReason) =>
    copyForFlowState({ status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode })!;

  it('staff session vs OAC missing vs OAC stale vs unverifiable are all different', () => {
    const bodies = ['denied_staff_session', 'denied_oac_missing', 'denied_oac_stale', 'denied_unverifiable', 'denied_stale'].map(
      (r) => fail(r as PrivilegedVoidLocalFailureReason).body,
    );
    expect(new Set(bodies).size).toBe(bodies.length);
    expect(fail('denied_staff_session').body).toMatch(/Quick PIN/);
    expect(fail('denied_oac_missing').body).toMatch(/ยังไม่ได้เปิดใช้สิทธิ์อนุมัติบนเครื่องนี้/);
    expect(fail('denied_oac_stale').body).toMatch(/หมดอายุ/);
  });

  it('every failure reason has fixed copy with no raw native/server code', () => {
    const reasons: PrivilegedVoidLocalFailureReason[] = [
      'unavailable', 'durable_unavailable', 'integrity_conflict', 'stale_context',
      'denied_locked', 'denied_stale', 'denied_unverifiable', 'denied_unknown',
      'denied_staff_session', 'denied_oac_missing', 'denied_oac_stale',
      'provisioning_pin_rejected', 'provisioning_not_eligible', 'provisioning_device_not_ready',
      'provisioning_failed', 'provisioning_uncertain', 'provisioning_verifier_inconsistent',
    ];
    for (const r of reasons) {
      const c = fail(r);
      expect(c.title.length).toBeGreaterThan(0);
      expect(`${c.title} ${c.body}`).not.toMatch(/DENIED_|OAC_|_MISSING|_STALE|STAFF_SESSION|[a-z]+_[a-z]+/);
    }
    expect(PRIVILEGED_VOID_QUICK_PIN_REQUIRED_COPY).not.toMatch(/[A-Z]{3,}_/);
  });

  it('uncertain provisioning never claims the bill was voided', () => {
    expect(fail('provisioning_uncertain').body).toMatch(/ยังไม่ถูกยกเลิก/);
    for (const r of ['provisioning_uncertain', 'provisioning_failed', 'denied_oac_missing'] as const) {
      expect(fail(r).body).not.toMatch(/ยกเลิกบิลสำเร็จ/);
    }
  });

  it('PROVISIONING_APPROVAL is an interactive (spinner) step, not a result panel', () => {
    expect(
      copyForFlowState({ status: 'PROVISIONING_APPROVAL', identity: IDENTITY, reason: 'r', note: '', trigger: 'oac_missing' }),
    ).toBeNull();
  });
});

describe('D-V11 post-provision re-attestation', () => {
  it('an immediate DENIED_INVALID_PIN is a terminal inconsistency, never a return to PIN entry', () => {
    expect(applyPostProvisionProjectionOutcome(PROJECTING, denied('DENIED_INVALID_PIN'))).toEqual({
      status: 'LOCAL_FAILURE',
      identity: IDENTITY,
      reasonCode: 'provisioning_verifier_inconsistent',
    });
  });

  it('every other outcome maps exactly like an ordinary projection (locked stays locked)', () => {
    const outcomes = [
      denied('DENIED_LOCKED'),
      denied('DENIED_OAC_STALE'),
      denied('DENIED_UNVERIFIABLE'),
      denied('DENIED_STAFF_SESSION'),
      { kind: 'projected' as const, record: { adjudicationId: 'a'.repeat(32) } as never },
      { kind: 'uncertain' as const },
      { kind: 'unavailable' as const },
    ];
    for (const outcome of outcomes) {
      expect(applyPostProvisionProjectionOutcome(PROJECTING, outcome)).toEqual(applyProjectionOutcome(PROJECTING, outcome));
    }
    expect(applyPostProvisionProjectionOutcome(PROJECTING, denied('DENIED_LOCKED'))).toMatchObject({ reasonCode: 'denied_locked' });
  });

  it('is a no-op outside PROJECTING', () => {
    const idle: PrivilegedVoidFlowState = { status: 'IDLE' };
    expect(applyPostProvisionProjectionOutcome(idle, denied('DENIED_INVALID_PIN'))).toBe(idle);
  });

  it('the ordinary (existing-OAC) wrong PIN is unchanged: same-intent retry', () => {
    expect(applyProjectionOutcome(PROJECTING, denied('DENIED_INVALID_PIN'))).toMatchObject({ status: 'MANAGER_PIN_ENTRY' });
  });

  it('copy is fixed, distinct, terminal (no retry / PIN invitation) and never a raw code', () => {
    const c = copyForFlowState({ status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'provisioning_verifier_inconsistent' })!;
    expect(c.tone).toBe('error');
    expect(c.body).toBe('ไม่สามารถยืนยันสิทธิ์ผู้อนุมัติบนเครื่องได้ กรุณาหยุดการยกเลิกบิลและติดต่อผู้ดูแลระบบ');
    expect(`${c.title} ${c.body}`).not.toMatch(/DENIED_|INVALID_PIN|PIN|ลองใหม่|เริ่มคำขอยกเลิกใหม่/);
    const pinRejected = copyForFlowState({ status: 'LOCAL_FAILURE', identity: IDENTITY, reasonCode: 'provisioning_pin_rejected' })!;
    expect(c.title).not.toBe(pinRejected.title);
  });
});

describe('authorization invariants (unchanged)', () => {
  it('the requester is never an eligible approver (self-approval prohibited); a different manager is', () => {
    const ctx = { branchId: 'LDP-001', requesterStaffId: 'admin-1' };
    expect(isEligibleApproverCandidate({ userId: 'admin-1', role: 'admin', isActive: true, branchIds: ['ALL'] }, ctx)).toBe(false);
    expect(isEligibleApproverCandidate({ userId: 'mgr-1', role: 'manager', isActive: true, branchIds: ['LDP-001'] }, ctx)).toBe(true);
    expect(isEligibleApproverCandidate({ userId: 'staff-2', role: 'staff', isActive: true, branchIds: ['LDP-001'] }, ctx)).toBe(false);
  });
});
