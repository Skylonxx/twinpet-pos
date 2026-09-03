/**
 * roleSweepScheduler — SEC-001 Packet C-A / F7 scheduled sweep.
 *
 * Each tick advances every active `privilegedRoleSweepJobs` job by exactly
 * one state transition, in lockstep with its `privilegedStagedRoleDeny` head
 * (both persisted states always match: DRAINING -> VERIFYING -> CONVERGED ->
 * COMPLETED). The CONVERGED -> COMPLETED finalize step also applies the
 * job's `targetRow` to the live `settings/_rolePermissions` matrix, and
 * requires `head.changeId === job.changeId` (already checked by
 * `decideSweepAdvancement`).
 */

import { onSchedule, type ScheduledEvent } from 'firebase-functions/v2/scheduler';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { STAGED_ROLE_DENY_COLLECTION } from './privilegedActionAuthority';
import { ROLE_SWEEP_JOBS_COLLECTION } from './setRolePermissions';
import { decideSweepAdvancement, type RoleSweepJobRecord, type StagedRoleDenyHeadRecord, type StagingState } from './roleSweepSchedulerCore';

const ROLE_PERMISSIONS_DOC_PATH = ['settings', '_rolePermissions'] as const;
const ACTIVE_STATES: readonly StagingState[] = ['DRAINING', 'VERIFYING', 'CONVERGED'];

function jobFromData(data: unknown): RoleSweepJobRecord | null {
  if (data == null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (
    typeof raw.jobId !== 'string' ||
    typeof raw.roleId !== 'string' ||
    typeof raw.changeId !== 'string' ||
    typeof raw.state !== 'string' ||
    !Array.isArray(raw.targetRow)
  ) {
    return null;
  }
  return {
    jobId: raw.jobId,
    roleId: raw.roleId,
    changeId: raw.changeId,
    state: raw.state as StagingState,
    targetRow: raw.targetRow.filter((p): p is string => typeof p === 'string'),
  };
}

function headFromData(data: unknown): StagedRoleDenyHeadRecord | null {
  if (data == null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (typeof raw.roleId !== 'string' || typeof raw.changeId !== 'string' || typeof raw.state !== 'string') return null;
  return { roleId: raw.roleId, changeId: raw.changeId, state: raw.state as StagingState };
}

export interface RunRoleSweepResult {
  jobsExamined: number;
  advanced: number;
  finalized: number;
  skipped: number;
}

export async function runRoleSweepTick(database: Firestore, nowMs: number = Date.now()): Promise<RunRoleSweepResult> {
  const jobsSnap = await database.collection(ROLE_SWEEP_JOBS_COLLECTION).where('state', 'in', ACTIVE_STATES).get();
  const result: RunRoleSweepResult = { jobsExamined: jobsSnap.docs.length, advanced: 0, finalized: 0, skipped: 0 };

  for (const jobDoc of jobsSnap.docs) {
    const job = jobFromData(jobDoc.data());
    if (!job) {
      result.skipped += 1;
      continue;
    }
    const jobRef = database.collection(ROLE_SWEEP_JOBS_COLLECTION).doc(job.jobId);
    const headRef = database.collection(STAGED_ROLE_DENY_COLLECTION).doc(job.roleId);
    const headSnap = await headRef.get();
    const head = headSnap.exists ? headFromData(headSnap.data()) : null;

    const advancement = decideSweepAdvancement(job, head);
    if (advancement.action === 'none') {
      result.skipped += 1;
      continue;
    }

    if (advancement.action === 'advance') {
      await database.runTransaction(async (tx) => {
        const freshJobSnap = await tx.get(jobRef);
        const freshHeadSnap = await tx.get(headRef);
        const freshJob = jobFromData(freshJobSnap.exists ? freshJobSnap.data() : undefined);
        const freshHead = freshHeadSnap.exists ? headFromData(freshHeadSnap.data()) : null;
        if (!freshJob || !freshHead) return;
        const freshDecision = decideSweepAdvancement(freshJob, freshHead);
        if (freshDecision.action !== 'advance') return;
        tx.update(jobRef, { state: freshDecision.nextState, updatedAt: FieldValue.serverTimestamp() });
        tx.update(headRef, { state: freshDecision.nextState, updatedAt: FieldValue.serverTimestamp() });
      });
      result.advanced += 1;
      continue;
    }

    // finalize: CONVERGED -> COMPLETED, plus applying targetRow to the matrix.
    await database.runTransaction(async (tx) => {
      const freshJobSnap = await tx.get(jobRef);
      const freshHeadSnap = await tx.get(headRef);
      const freshJob = jobFromData(freshJobSnap.exists ? freshJobSnap.data() : undefined);
      const freshHead = freshHeadSnap.exists ? headFromData(freshHeadSnap.data()) : null;
      if (!freshJob || !freshHead) return;
      const freshDecision = decideSweepAdvancement(freshJob, freshHead);
      if (freshDecision.action !== 'finalize') return;
      const matrixRef = database.collection(ROLE_PERMISSIONS_DOC_PATH[0]).doc(ROLE_PERMISSIONS_DOC_PATH[1]);
      tx.set(
        matrixRef,
        { rolePermissions: { [freshJob.roleId]: freshJob.targetRow }, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      tx.update(jobRef, { state: 'COMPLETED', updatedAt: FieldValue.serverTimestamp() });
      tx.update(headRef, { state: 'COMPLETED', updatedAt: FieldValue.serverTimestamp() });
    });
    result.finalized += 1;
  }

  void nowMs;
  return result;
}

export const roleSweepScheduler = onSchedule(
  { schedule: 'every 5 minutes', region: FUNCTIONS_REGION, timeoutSeconds: 120, retryCount: 0 },
  async (_event: ScheduledEvent) => {
    await runRoleSweepTick(db, Date.now());
  },
);
