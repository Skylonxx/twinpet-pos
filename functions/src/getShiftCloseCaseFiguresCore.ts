/**
 * getShiftCloseCaseFiguresCore — pure decision core. [Packet 5 / UI-B2 / Packet S]
 * No Firestore handle, no clock, no logging, no network, no process, no reflection.
 * Every exported signature takes curated types, primitives, or `unknown`.
 */
import {
  ALERT_STATES,
  PROCESSING_STATES,
  SETTLEMENT_STATES,
  VALIDATION_VERDICTS,
  type ValidationVerdict,
} from './shiftCloseValidationTypes';

/* MARKER:IMPORTS */

/** Source of truth: shiftCloseEvidenceCaptureCore.ts:40 (SCHEMA_VERSION = 1). */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Source of truth: shiftCloseValidationWorkerCore.ts:76 (VALIDATION_SCHEMA_VERSION = 1). */
export const SUPPORTED_VALIDATION_SCHEMA_VERSION = 1;

export interface CuratedRequestView {
  branchId: string;
  shiftId: string;
  expectedCaseVersion: number;
}

export interface CuratedAuthClaims {
  staffIdPresent: true;
  role: 'manager' | 'admin';
  branchIds: readonly string[];
}

export interface CuratedCaseView {
  shiftId: string;
  branchId: string;
  caseVersion: number;
  schemaVersion: number;
  selectedRunId: string | null;
  selectedCloseHash: string | null;
}

export interface CuratedRunView {
  runId: string;
  shiftId: string;
  branchId: string;
  closeHash: string;
  evidenceId: string;
  schemaVersion: number;
  validationSchemaVersion: number;
  validationVerdict: ValidationVerdict;
  serverExpectedCashMinor: number | null;
  serverExpectedCashDeltaMinor: number | null;
}

export interface CuratedEvidenceView {
  evidenceId: string;
  shiftId: string;
  branchId: string;
  closeHash: string;
  schemaVersion: number;
  expectedCash: number | null;
  actualCashCount: number | null;
  variance: number | null;
}

export type GetShiftCloseCaseFiguresResponse =
  | {
      status: 'ok';
      reportedExpectedCashBaht: number | null;
      reportedActualCashCountBaht: number | null;
      reportedVarianceBaht: number | null;
      serverExpectedCashMinor: number | null;
      serverExpectedCashDeltaMinor: number | null;
      validationVerdict: ValidationVerdict;
    }
  | { status: 'provisional_no_selected_run' }
  | { status: 'case_not_found' }
  | { status: 'unsupported_case_state' }
  | { status: 'stale_case_version' }
  | { status: 'unavailable_data_anomaly' }
  | { status: 'unauthorized' };

export interface CaseDecision {
  response: GetShiftCloseCaseFiguresResponse | null;
  view: CuratedCaseView | null;
}

export interface RunDecision {
  response: GetShiftCloseCaseFiguresResponse | null;
  view: CuratedRunView | null;
}

export interface EvidenceDecision {
  response: GetShiftCloseCaseFiguresResponse | null;
  view: CuratedEvidenceView | null;
}

export type FieldRead<T> =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'null' }
  | { kind: 'value'; value: T };

type CoreLiteralKey =
  | 'branchId'
  | 'shiftId'
  | 'expectedCaseVersion'
  | 'token'
  | 'staffId'
  | 'role'
  | 'branchIds'
  | 'caseVersion'
  | 'processingState'
  | 'settlementState'
  | 'alertState'
  | 'selectedRunId'
  | 'selectedCloseHash'
  | 'runId'
  | 'closeHash'
  | 'evidenceId'
  | 'validationVerdict'
  | 'serverComputedDrawer'
  | 'perFieldDeltas'
  | 'expectedCashMinor'
  | 'expectedCash'
  | 'actualCashCount'
  | 'variance'
  | 'schemaVersion'
  | 'validationSchemaVersion';

type SafeShapeKind = 'record' | 'array';

const MISSING = { kind: 'missing' } as const;
const INVALID = { kind: 'invalid' } as const;
const NULL_READ = { kind: 'null' } as const;

const MAX_ID_LENGTH = 200;
const REQUEST_KEY_SET = 'branchId,expectedCaseVersion,shiftId';
const BRANCH_WILDCARD = 'ALL';
const ROLE_VALUES: readonly string[] = ['admin', 'manager'];
const ID_JOIN = '_';

const ANOMALY: GetShiftCloseCaseFiguresResponse = { status: 'unavailable_data_anomaly' };
const UNSUPPORTED: GetShiftCloseCaseFiguresResponse = { status: 'unsupported_case_state' };
const STALE: GetShiftCloseCaseFiguresResponse = { status: 'stale_case_version' };
const DENIED: GetShiftCloseCaseFiguresResponse = { status: 'unauthorized' };

/**
 * The ONLY place permitted to use Object.getPrototypeOf,
 * Object.getOwnPropertyDescriptors, or Object.getOwnPropertySymbols (C7).
 */
function isSafeSerializedShape(value: unknown, kind: SafeShapeKind): boolean {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  const isArrayValue = Array.isArray(value);
  if (kind === 'record') {
    if (isArrayValue) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
  } else {
    if (!isArrayValue) return false;
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  for (const descriptor of descriptors) {
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
  }
  return true;
}

function isPlainScalar(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return true;
  return false;
}

function sortedKeys(raw: object): string {
  return Object.keys(raw).sort().join(',');
}

function hasOwnLiteral(record: object, key: CoreLiteralKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readOwnLiteral(record: object, key: CoreLiteralKey): unknown {
  return (record as { [k in CoreLiteralKey]?: unknown })[key];
}

function ownRead(present: boolean, value: unknown): FieldRead<unknown> {
  if (!present) return MISSING;
  return { kind: 'value', value };
}

function asRequiredId(read: FieldRead<unknown>): FieldRead<string> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'string') return INVALID;
  if (value.length === 0) return INVALID;
  if (value.length > MAX_ID_LENGTH) return INVALID;
  return { kind: 'value', value };
}

function asNullableId(read: FieldRead<unknown>): FieldRead<string | null> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'string') return INVALID;
  if (value.length === 0) return INVALID;
  if (value.trim().length === 0) return INVALID;
  if (value.length > MAX_ID_LENGTH) return INVALID;
  return { kind: 'value', value };
}

function asInteger(read: FieldRead<unknown>): FieldRead<number> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'number') return INVALID;
  if (!Number.isSafeInteger(value)) return INVALID;
  return { kind: 'value', value };
}

function asNullableFinite(read: FieldRead<unknown>): FieldRead<number | null> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'number') return INVALID;
  if (!Number.isFinite(value)) return INVALID;
  return { kind: 'value', value };
}

function asNullableSafeInteger(read: FieldRead<unknown>): FieldRead<number | null> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'number') return INVALID;
  if (!Number.isSafeInteger(value)) return INVALID;
  return { kind: 'value', value };
}

function asEnum(read: FieldRead<unknown>, allowed: readonly string[]): FieldRead<string> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'string') return INVALID;
  if (!allowed.includes(value)) return INVALID;
  return { kind: 'value', value };
}

function asRecord(read: FieldRead<unknown>): FieldRead<object> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isSafeSerializedShape(value, 'record')) return INVALID;
  return { kind: 'value', value: value as object };
}

function asArray(read: FieldRead<unknown>): FieldRead<readonly unknown[]> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isSafeSerializedShape(value, 'array')) return INVALID;
  return { kind: 'value', value: value as readonly unknown[] };
}

function asPresent(read: FieldRead<unknown>): FieldRead<true> {
  if (read.kind !== 'value') return read;
  if (read.value === null) return NULL_READ;
  if (read.value === undefined) return INVALID;
  return { kind: 'value', value: true };
}

/** J10: nested missing -> null; explicit null -> null; invalid -> reject. */
function minorFrom(map: object): FieldRead<number | null> {
  const read = asNullableSafeInteger(
    ownRead(hasOwnLiteral(map, 'expectedCashMinor'), readOwnLiteral(map, 'expectedCashMinor')),
  );
  if (read.kind === 'missing') return NULL_READ;
  return read;
}

/* MARKER:HELPERS */

export function curateRequestView(raw: unknown): CuratedRequestView | null {
  if (!isSafeSerializedShape(raw, 'record')) return null;
  const record = raw as object;
  if (sortedKeys(record) !== REQUEST_KEY_SET) return null;
  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  const versionRead = asInteger(
    ownRead(
      hasOwnLiteral(record, 'expectedCaseVersion'),
      readOwnLiteral(record, 'expectedCaseVersion'),
    ),
  );
  if (branchIdRead.kind !== 'value') return null;
  if (shiftIdRead.kind !== 'value') return null;
  if (versionRead.kind !== 'value') return null;
  if (branchIdRead.value.trim().length === 0) return null;
  if (branchIdRead.value === BRANCH_WILDCARD) return null;
  if (shiftIdRead.value.trim().length === 0) return null;
  if (versionRead.value < 0) return null;
  return {
    branchId: branchIdRead.value,
    shiftId: shiftIdRead.value,
    expectedCaseVersion: versionRead.value,
  };
}

export function curateCallableAuth(rawAuth: unknown): CuratedAuthClaims | null {
  if (!isSafeSerializedShape(rawAuth, 'record')) return null;
  const container = rawAuth as object;
  const tokenRead = asRecord(
    ownRead(hasOwnLiteral(container, 'token'), readOwnLiteral(container, 'token')),
  );
  if (tokenRead.kind !== 'value') return null;
  const token = tokenRead.value;
  const staffRead = asPresent(
    ownRead(hasOwnLiteral(token, 'staffId'), readOwnLiteral(token, 'staffId')),
  );
  if (staffRead.kind !== 'value') return null;
  const roleRead = asEnum(
    ownRead(hasOwnLiteral(token, 'role'), readOwnLiteral(token, 'role')),
    ROLE_VALUES,
  );
  if (roleRead.kind !== 'value') return null;
  const branchRead = asArray(
    ownRead(hasOwnLiteral(token, 'branchIds'), readOwnLiteral(token, 'branchIds')),
  );
  if (branchRead.kind !== 'value') return null;
  const branchIds: string[] = [];
  for (const entry of branchRead.value) {
    if (typeof entry === 'string') branchIds.push(entry);
  }
  return {
    staffIdPresent: true,
    role: roleRead.value as 'manager' | 'admin',
    branchIds,
  };
}

/* MARKER:CURATION */

export function curateCaseDocument(
  request: CuratedRequestView,
  caseSnapshotId: string,
  raw: unknown,
): CaseDecision {
  if (!isSafeSerializedShape(raw, 'record')) return { response: ANOMALY, view: null };
  const record = raw as object;

  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  if (branchIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };

  const versionRead = asInteger(
    ownRead(hasOwnLiteral(record, 'caseVersion'), readOwnLiteral(record, 'caseVersion')),
  );
  if (versionRead.kind !== 'value') return { response: STALE, view: null };
  if (versionRead.value !== request.expectedCaseVersion) return { response: STALE, view: null };

  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  if (shiftIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== request.shiftId) return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== caseSnapshotId) return { response: ANOMALY, view: null };

  const schemaRead = asInteger(
    ownRead(hasOwnLiteral(record, 'schemaVersion'), readOwnLiteral(record, 'schemaVersion')),
  );
  if (schemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };

  const processingRead = asEnum(
    ownRead(hasOwnLiteral(record, 'processingState'), readOwnLiteral(record, 'processingState')),
    PROCESSING_STATES,
  );
  const settlementRead = asEnum(
    ownRead(hasOwnLiteral(record, 'settlementState'), readOwnLiteral(record, 'settlementState')),
    SETTLEMENT_STATES,
  );
  const alertRead = asEnum(
    ownRead(hasOwnLiteral(record, 'alertState'), readOwnLiteral(record, 'alertState')),
    ALERT_STATES,
  );
  if (processingRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (settlementRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (alertRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (processingRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (settlementRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (alertRead.kind !== 'value') return { response: UNSUPPORTED, view: null };

  const runIdRead = asNullableId(
    ownRead(hasOwnLiteral(record, 'selectedRunId'), readOwnLiteral(record, 'selectedRunId')),
  );
  const hashRead = asNullableId(
    ownRead(
      hasOwnLiteral(record, 'selectedCloseHash'),
      readOwnLiteral(record, 'selectedCloseHash'),
    ),
  );
  if (runIdRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (hashRead.kind === 'invalid') return { response: ANOMALY, view: null };
  const selectedRunId = runIdRead.kind === 'value' ? runIdRead.value : null;
  const selectedCloseHash = hashRead.kind === 'value' ? hashRead.value : null;
  if (selectedRunId !== null && selectedCloseHash === null) {
    return { response: ANOMALY, view: null };
  }

  return {
    response: null,
    view: {
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      caseVersion: versionRead.value,
      schemaVersion: schemaRead.value,
      selectedRunId,
      selectedCloseHash,
    },
  };
}

export function curateRunDocument(
  caseView: CuratedCaseView,
  runSnapshotId: string,
  raw: unknown,
): RunDecision {
  if (!isSafeSerializedShape(raw, 'record')) return { response: ANOMALY, view: null };
  const record = raw as object;

  const runIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'runId'), readOwnLiteral(record, 'runId')),
  );
  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  const hashRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'closeHash'), readOwnLiteral(record, 'closeHash')),
  );
  const evidenceRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'evidenceId'), readOwnLiteral(record, 'evidenceId')),
  );
  const schemaRead = asInteger(
    ownRead(hasOwnLiteral(record, 'schemaVersion'), readOwnLiteral(record, 'schemaVersion')),
  );
  const validationSchemaRead = asInteger(
    ownRead(
      hasOwnLiteral(record, 'validationSchemaVersion'),
      readOwnLiteral(record, 'validationSchemaVersion'),
    ),
  );
  const verdictRead = asEnum(
    ownRead(
      hasOwnLiteral(record, 'validationVerdict'),
      readOwnLiteral(record, 'validationVerdict'),
    ),
    VALIDATION_VERDICTS,
  );
  const drawerRead = asRecord(
    ownRead(
      hasOwnLiteral(record, 'serverComputedDrawer'),
      readOwnLiteral(record, 'serverComputedDrawer'),
    ),
  );
  const deltasRead = asRecord(
    ownRead(hasOwnLiteral(record, 'perFieldDeltas'), readOwnLiteral(record, 'perFieldDeltas')),
  );
  if (runIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (shiftIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (branchIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (hashRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (evidenceRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (schemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (validationSchemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (verdictRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (drawerRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (deltasRead.kind !== 'value') return { response: ANOMALY, view: null };

  if (runSnapshotId !== caseView.selectedRunId) return { response: ANOMALY, view: null };
  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };
  if (branchIdRead.value !== caseView.branchId) return { response: ANOMALY, view: null };
  if (hashRead.value !== caseView.selectedCloseHash) return { response: ANOMALY, view: null };
  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };
  if (validationSchemaRead.value !== SUPPORTED_VALIDATION_SCHEMA_VERSION) {
    return { response: ANOMALY, view: null };
  }
  if (evidenceRead.value !== shiftIdRead.value + ID_JOIN + hashRead.value) {
    return { response: ANOMALY, view: null };
  }

  const drawerMinor = minorFrom(drawerRead.value);
  const deltaMinor = minorFrom(deltasRead.value);
  if (drawerMinor.kind === 'invalid') return { response: ANOMALY, view: null };
  if (deltaMinor.kind === 'invalid') return { response: ANOMALY, view: null };

  return {
    response: null,
    view: {
      runId: runIdRead.value,
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      closeHash: hashRead.value,
      evidenceId: evidenceRead.value,
      schemaVersion: schemaRead.value,
      validationSchemaVersion: validationSchemaRead.value,
      validationVerdict: verdictRead.value as ValidationVerdict,
      serverExpectedCashMinor: drawerMinor.kind === 'value' ? drawerMinor.value : null,
      serverExpectedCashDeltaMinor: deltaMinor.kind === 'value' ? deltaMinor.value : null,
    },
  };
}

export function curateEvidenceDocument(
  caseView: CuratedCaseView,
  runView: CuratedRunView,
  evidenceSnapshotId: string,
  raw: unknown,
): EvidenceDecision {
  if (!isSafeSerializedShape(raw, 'record')) return { response: ANOMALY, view: null };
  const record = raw as object;

  const evidenceRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'evidenceId'), readOwnLiteral(record, 'evidenceId')),
  );
  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  const hashRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'closeHash'), readOwnLiteral(record, 'closeHash')),
  );
  const schemaRead = asInteger(
    ownRead(hasOwnLiteral(record, 'schemaVersion'), readOwnLiteral(record, 'schemaVersion')),
  );
  const expectedRead = asNullableFinite(
    ownRead(hasOwnLiteral(record, 'expectedCash'), readOwnLiteral(record, 'expectedCash')),
  );
  const actualRead = asNullableFinite(
    ownRead(hasOwnLiteral(record, 'actualCashCount'), readOwnLiteral(record, 'actualCashCount')),
  );
  const varianceRead = asNullableFinite(
    ownRead(hasOwnLiteral(record, 'variance'), readOwnLiteral(record, 'variance')),
  );
  if (evidenceRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (shiftIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (branchIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (hashRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (schemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (expectedRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (expectedRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (actualRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (actualRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (varianceRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (varianceRead.kind === 'invalid') return { response: ANOMALY, view: null };

  if (evidenceSnapshotId !== runView.evidenceId) return { response: ANOMALY, view: null };
  if (evidenceRead.value !== evidenceSnapshotId) return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };
  if (branchIdRead.value !== caseView.branchId) return { response: ANOMALY, view: null };
  if (hashRead.value !== runView.closeHash) return { response: ANOMALY, view: null };
  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };

  return {
    response: null,
    view: {
      evidenceId: evidenceRead.value,
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      closeHash: hashRead.value,
      schemaVersion: schemaRead.value,
      expectedCash: expectedRead.kind === 'value' ? expectedRead.value : null,
      actualCashCount: actualRead.kind === 'value' ? actualRead.value : null,
      variance: varianceRead.kind === 'value' ? varianceRead.value : null,
    },
  };
}

/* MARKER:DECISIONS */

export function readCuratedRequestShiftId(request: CuratedRequestView): string {
  return request.shiftId;
}

export function readCuratedCaseSelectedRunId(caseView: CuratedCaseView): string | null {
  return caseView.selectedRunId;
}

export function readCuratedRunEvidenceId(runView: CuratedRunView): string {
  return runView.evidenceId;
}

export function caseDecisionResponse(
  decision: CaseDecision,
): GetShiftCloseCaseFiguresResponse | null {
  return decision.response;
}

export function caseDecisionView(decision: CaseDecision): CuratedCaseView | null {
  return decision.view;
}

export function runDecisionResponse(
  decision: RunDecision,
): GetShiftCloseCaseFiguresResponse | null {
  return decision.response;
}

export function runDecisionView(decision: RunDecision): CuratedRunView | null {
  return decision.view;
}

export function evidenceDecisionResponse(
  decision: EvidenceDecision,
): GetShiftCloseCaseFiguresResponse | null {
  return decision.response;
}

export function evidenceDecisionView(decision: EvidenceDecision): CuratedEvidenceView | null {
  return decision.view;
}

export function hasBranchAuthority(claims: CuratedAuthClaims, branchId: string): boolean {
  if (claims.role !== 'manager' && claims.role !== 'admin') return false;
  if (claims.branchIds.includes(BRANCH_WILDCARD)) return true;
  return claims.branchIds.includes(branchId);
}

export function decideAuthorization(
  claims: CuratedAuthClaims | null,
  request: CuratedRequestView,
  freshnessVerified: boolean,
): GetShiftCloseCaseFiguresResponse | null {
  if (claims === null) return DENIED;
  if (freshnessVerified !== true) return DENIED;
  if (!hasBranchAuthority(claims, request.branchId)) return DENIED;
  return null;
}

export function decideShiftCloseCaseFigures(
  runView: CuratedRunView,
  evidenceView: CuratedEvidenceView,
): GetShiftCloseCaseFiguresResponse {
  return {
    status: 'ok',
    reportedExpectedCashBaht: evidenceView.expectedCash,
    reportedActualCashCountBaht: evidenceView.actualCashCount,
    reportedVarianceBaht: evidenceView.variance,
    serverExpectedCashMinor: runView.serverExpectedCashMinor,
    serverExpectedCashDeltaMinor: runView.serverExpectedCashDeltaMinor,
    validationVerdict: runView.validationVerdict,
  };
}

export function responseCaseNotFound(): GetShiftCloseCaseFiguresResponse {
  return { status: 'case_not_found' };
}

export function responseProvisionalNoSelectedRun(): GetShiftCloseCaseFiguresResponse {
  return { status: 'provisional_no_selected_run' };
}

export function responseUnavailableDataAnomaly(): GetShiftCloseCaseFiguresResponse {
  return { status: 'unavailable_data_anomaly' };
}

/* MARKER:RESPONSES */
