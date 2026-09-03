/**
 * SEC-001 Packet C-A / F7 — pure state-machine logic for `roleSweepScheduler`.
 *
 * Persisted states, head and job, no exception: DRAINING -> VERIFYING ->
 * CONVERGED -> COMPLETED. `STAGED` is not a persisted state. Each scheduler
 * tick advances one active job by exactly one transition (idempotent if run
 * again before the next write lands). The finalizer requires
 * `head.changeId === job.changeId` and `job.state === 'CONVERGED'`, then
 * atomically sets both `head.state` and `job.state` to `COMPLETED` (head is
 * never deleted) and applies `targetRow` to the live permission matrix.
 */

export type StagingState = 'DRAINING' | 'VERIFYING' | 'CONVERGED' | 'COMPLETED';

export interface RoleSweepJobRecord {
  jobId: string;
  roleId: string;
  changeId: string;
  state: StagingState;
  targetRow: readonly string[];
}

export interface StagedRoleDenyHeadRecord {
  roleId: string;
  changeId: string;
  state: StagingState;
}

export type SweepAdvancement =
  | { action: 'none'; reason: 'already_completed' | 'head_missing' | 'change_id_mismatch' }
  | { action: 'advance'; nextState: 'VERIFYING' | 'CONVERGED' }
  | { action: 'finalize' };

/**
 * Decides the single next transition for one job. Does not mutate anything —
 * `roleSweepScheduler.ts` performs the actual atomic Firestore writes.
 */
export function decideSweepAdvancement(
  job: RoleSweepJobRecord,
  head: StagedRoleDenyHeadRecord | null,
): SweepAdvancement {
  if (job.state === 'COMPLETED') return { action: 'none', reason: 'already_completed' };
  if (!head) return { action: 'none', reason: 'head_missing' };
  if (head.changeId !== job.changeId) return { action: 'none', reason: 'change_id_mismatch' };

  if (job.state === 'DRAINING') return { action: 'advance', nextState: 'VERIFYING' };
  if (job.state === 'VERIFYING') return { action: 'advance', nextState: 'CONVERGED' };
  // job.state === 'CONVERGED'
  return { action: 'finalize' };
}

export function isActiveJobState(state: StagingState): boolean {
  return state === 'DRAINING' || state === 'VERIFYING' || state === 'CONVERGED';
}
