/**
 * getShiftCloseCaseFigures — I/O shell. [Packet 5 / UI-B2 / Packet S]
 * onCall wiring + exactly three direct document reads. Every decision is
 * delegated to the pure getShiftCloseCaseFiguresCore module.
 *
 * K1 boundary:
 *   invalid request      -> HttpsError('invalid-argument'), zero reads, no union member
 *   unexpected exception -> exactly one safe log, then HttpsError('internal')
 *   validated outcomes   -> one of the seven business-union members
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import {
  caseDecisionResponse,
  caseDecisionView,
  curateCallableAuth,
  curateCaseDocument,
  curateEvidenceDocument,
  curateRequestView,
  curateRunDocument,
  decideAuthorization,
  decideShiftCloseCaseFigures,
  evidenceDecisionResponse,
  evidenceDecisionView,
  readCuratedCaseSelectedRunId,
  readCuratedRequestShiftId,
  readCuratedRunEvidenceId,
  responseCaseNotFound,
  responseProvisionalNoSelectedRun,
  responseUnavailableDataAnomaly,
  runDecisionResponse,
  runDecisionView,
  type GetShiftCloseCaseFiguresResponse,
} from './getShiftCloseCaseFiguresCore';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';

/* MARKER:IMPORTS */

export async function performGetShiftCloseCaseFigures(
  database: Firestore,
  rawRequest: unknown,
  rawAuth: unknown,
): Promise<GetShiftCloseCaseFiguresResponse> {
  const request = curateRequestView(rawRequest);
  if (request === null) {
    throw new HttpsError('invalid-argument', 'คำขอไม่ถูกต้อง');
  }

  const freshness = await evaluateFreshPrivilegedAuthority(database, rawAuth as AuthLike);
  const denial = decideAuthorization(curateCallableAuth(rawAuth), request, freshness.ok);
  if (denial !== null) return denial;

  const shiftId = readCuratedRequestShiftId(request);
  let stage: 'read_case' | 'read_run' | 'read_evidence' = 'read_case';

  /* MARKER:BODY */

  try {
    const caseSnap = await database.collection('shiftCloseCases').doc(shiftId).get();

    /* MARKER:POSTCASE */

    if (!caseSnap.exists) return responseCaseNotFound();
    const caseDecision = curateCaseDocument(request, caseSnap.id, caseSnap.data());
    const caseStatus = caseDecisionResponse(caseDecision);
    if (caseStatus !== null) return caseStatus;
    const caseView = caseDecisionView(caseDecision);
    if (caseView === null) return responseUnavailableDataAnomaly();

    const selectedRunId = readCuratedCaseSelectedRunId(caseView);
    if (selectedRunId === null) return responseProvisionalNoSelectedRun();

    stage = 'read_run';
    const runSnap = await database.collection('shiftCloseValidationRuns').doc(selectedRunId).get();
    if (!runSnap.exists) return responseUnavailableDataAnomaly();
    const runDecision = curateRunDocument(caseView, runSnap.id, runSnap.data());
    const runStatus = runDecisionResponse(runDecision);
    if (runStatus !== null) return runStatus;
    const runView = runDecisionView(runDecision);
    if (runView === null) return responseUnavailableDataAnomaly();

    const evidenceId = readCuratedRunEvidenceId(runView);

    stage = 'read_evidence';
    const evidenceSnap = await database.collection('shiftCloseEvidence').doc(evidenceId).get();
    if (!evidenceSnap.exists) return responseUnavailableDataAnomaly();
    const evidenceDecision = curateEvidenceDocument(
      caseView,
      runView,
      evidenceSnap.id,
      evidenceSnap.data(),
    );
    const evidenceStatus = evidenceDecisionResponse(evidenceDecision);
    if (evidenceStatus !== null) return evidenceStatus;
    const evidenceView = evidenceDecisionView(evidenceDecision);
    if (evidenceView === null) return responseUnavailableDataAnomaly();

    return decideShiftCloseCaseFigures(runView, evidenceView);
  } catch {
    console.error({ operation: 'getShiftCloseCaseFigures', stage, code: 'unavailable' });
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
}

/* MARKER:HANDLER */

export const getShiftCloseCaseFigures = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    return performGetShiftCloseCaseFigures(db, request.data, request.auth);
  },
);
