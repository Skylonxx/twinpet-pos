import { describe, expect, it } from 'vitest';
import { decideSweepAdvancement, isActiveJobState, type RoleSweepJobRecord, type StagedRoleDenyHeadRecord } from '../roleSweepSchedulerCore';

const baseJob: RoleSweepJobRecord = {
  jobId: 'job-1',
  roleId: 'staff',
  changeId: 'change-1',
  state: 'DRAINING',
  targetRow: ['pos_sale'],
};
const matchingHead: StagedRoleDenyHeadRecord = { roleId: 'staff', changeId: 'change-1', state: 'DRAINING' };

describe('decideSweepAdvancement', () => {
  it('advances DRAINING to VERIFYING', () => {
    expect(decideSweepAdvancement(baseJob, matchingHead)).toEqual({ action: 'advance', nextState: 'VERIFYING' });
  });

  it('advances VERIFYING to CONVERGED', () => {
    expect(decideSweepAdvancement({ ...baseJob, state: 'VERIFYING' }, matchingHead)).toEqual({
      action: 'advance',
      nextState: 'CONVERGED',
    });
  });

  it('finalizes a CONVERGED job with a matching head changeId', () => {
    expect(decideSweepAdvancement({ ...baseJob, state: 'CONVERGED' }, matchingHead)).toEqual({ action: 'finalize' });
  });

  it('does nothing for an already-COMPLETED job', () => {
    expect(decideSweepAdvancement({ ...baseJob, state: 'COMPLETED' }, matchingHead)).toEqual({
      action: 'none',
      reason: 'already_completed',
    });
  });

  it('does nothing when the head is missing', () => {
    expect(decideSweepAdvancement(baseJob, null)).toEqual({ action: 'none', reason: 'head_missing' });
  });

  it('does nothing when the head changeId does not match the job', () => {
    expect(decideSweepAdvancement(baseJob, { ...matchingHead, changeId: 'different' })).toEqual({
      action: 'none',
      reason: 'change_id_mismatch',
    });
  });
});

describe('isActiveJobState', () => {
  it('classifies DRAINING/VERIFYING/CONVERGED as active and COMPLETED as not', () => {
    expect(isActiveJobState('DRAINING')).toBe(true);
    expect(isActiveJobState('VERIFYING')).toBe(true);
    expect(isActiveJobState('CONVERGED')).toBe(true);
    expect(isActiveJobState('COMPLETED')).toBe(false);
  });
});
