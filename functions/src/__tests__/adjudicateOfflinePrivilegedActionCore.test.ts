import { createHash, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../db', () => ({ db: { __unused: true } }));
vi.mock('../deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: class extends Error {},
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
}));

import {
  OFFLINE_ADJUDICATION_IMMUTABLE_BINDING_FIELDS,
  computeServerPendingExpiry,
  parseDeviceRegistration,
  parseOfflineAdjudicationRecord,
  performAdjudicateOfflinePrivilegedAction,
  relayBranchEligible,
  strictBase64Decode,
  validateAdjudicationRequestShape,
  type AdjudicateOfflinePrivilegedActionDeps,
  type OfflineAdjudicationResponse,
} from '../adjudicateOfflinePrivilegedActionCore';
import {
  OFFLINE_ADJUDICATION_ANOMALY_REASONS,
  OFFLINE_ADJUDICATION_MANUAL_ATTENTION_REASONS,
  OFFLINE_ADJUDICATION_PROTOCOL_REASONS,
  OFFLINE_ADJUDICATION_RECORD_STATES,
  OFFLINE_ADJUDICATION_REJECTION_REASONS,
  OFFLINE_ADJUDICATION_RESPONSE_KINDS,
  OFFLINE_ADJUDICATION_RETRY_REASONS,
} from '../privilegedActionRegistry';
import {
  PAA1_ACTION_KIND_VOID_SETTLED_SALE,
  PAA1_APPROVAL_RESULT_APPROVED_LOCAL,
  PAA1_MANAGER_ROLE_MANAGER,
  encodePaa1,
  paa1SignaturePreimage,
  type PrivilegedActionAttestationFrameV1,
} from '../privilegedActionAttestationFrame';
import { encodeSsa1, ssa1SignaturePreimage } from '../staffSessionAssertionFrame';
import { signOacEnvelope } from '../oacSigner';
import { deriveOfflineVoidExecutionId, utcPlus7Date } from '../submitPrivilegedVoidCore';
import { publicKeyFromRaw } from '../signingKeyLoader';
import type { VoidIntentTxnOutcome } from '../voidIntent';

type Doc = Record<string, unknown>;

// ── Fixed clock: NOW sits inside the UTC+7 day of the target order. ─────────
const NOW = Date.UTC(2025, 10, 14, 6, 0, 0); // 2025-11-14T06:00:00Z → UTC+7 2025-11-14
const TARGET_DAY = utcPlus7Date(NOW);
const ORDER_CREATED = NOW - 3 * 60 * 60 * 1000;
const APPROVAL_LOWER = NOW - 60_000;
const APPROVAL_UPPER = APPROVAL_LOWER + 250;
const DAY_END = Date.UTC(2025, 10, 14, 17, 0, 0); // exclusive end of UTC+7 2025-11-14
const BRANCH = 'LDP-001';
const DEVICE_HEX = '101112131415161718191a1b1c1d1e1f';
const EXEC_ID_HEX = 'ab'.repeat(20);

function rawPublicKeyBase64(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

const deviceKey = generateKeyPairSync('ed25519');
const serverKey = generateKeyPairSync('ed25519');
const SERVER_KEY_ID = 'server-k1';

function verifiableKeys() {
  return [
    {
      signingKeyId: SERVER_KEY_ID,
      publicKey: publicKeyFromRaw(
        (serverKey.publicKey.export({ format: 'jwk' }) as { x: string }).x,
      ),
      publicKeyBase64Url: (serverKey.publicKey.export({ format: 'jwk' }) as { x: string }).x,
      status: 'ACTIVE' as const,
    },
  ];
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── Fixture builders ───────────────────────────────────────────────────────

function buildSsa1(over: Partial<Parameters<typeof encodeSsa1>[0]> = {}) {
  const unsigned = {
    ssa1Id: 'ssa1-1',
    staffId: 'staff-1',
    securityDeviceId: Buffer.from(DEVICE_HEX, 'hex'),
    branchId: BRANCH,
    authVersionAtIssue: 4,
    issuedAtServerMs: APPROVAL_LOWER - 3_600_000,
    expiresAtServerMs: APPROVAL_LOWER + 3_600_000,
    signingKeyId: SERVER_KEY_ID,
    ...over,
  };
  const signature = ed25519Sign(null, ssa1SignaturePreimage(unsigned), serverKey.privateKey);
  const frame = { ...unsigned, signature };
  return { frame, bytes: encodeSsa1(frame) };
}

function buildOac(over: Record<string, unknown> = {}) {
  const unsigned = {
    oacId: 'oac-1',
    schemaVersion: 1 as const,
    managerStaffId: 'manager-1',
    managerRole: 'manager' as const,
    branchId: BRANCH,
    deviceId: DEVICE_HEX,
    allowedActions: ['VOID_PENDING_SALE', 'VOID_SETTLED_SALE'] as const,
    authVersionAtIssue: 9,
    credentialVersionAtIssue: 5,
    revocationEpoch: 3,
    issuedAtServerMs: APPROVAL_LOWER - 7_200_000,
    freshnessExpiresAtServerMs: APPROVAL_LOWER + 7_200_000,
    verifierAlgo: 'argon2id' as const,
    verifierParams: { m: 65536, t: 3, p: 1, saltLen: 16, hashLen: 32 },
    verifierSalt: 'c2FsdA==',
    verifier: 'dmVyaWZpZXI=',
    pepperCommitment: 'cGVwcGVy',
    ...over,
  };
  const signed = signOacEnvelope(unsigned as never, SERVER_KEY_ID, serverKey.privateKey);
  return { envelope: signed, bytes: Buffer.from(JSON.stringify(signed), 'utf8') };
}

type FrameOverrides = Partial<Omit<PrivilegedActionAttestationFrameV1, 'signature'>>;

function buildPaa1(opts: {
  frame?: FrameOverrides;
  ssa1Bytes?: Buffer;
  oacBytes?: Buffer;
  signWith?: KeyObject;
} = {}) {
  const ssa1 = buildSsa1();
  const oac = buildOac();
  const ssa1Bytes = opts.ssa1Bytes ?? ssa1.bytes;
  const oacBytes = opts.oacBytes ?? oac.bytes;

  const unsigned: Omit<PrivilegedActionAttestationFrameV1, 'signature'> = {
    attestationId: Buffer.from('a1a2a3a4a5a6a7a8a9aaabacadaeaf00', 'hex'),
    actionKind: PAA1_ACTION_KIND_VOID_SETTLED_SALE,
    approvalResultKind: PAA1_APPROVAL_RESULT_APPROVED_LOCAL,
    managerRoleKind: PAA1_MANAGER_ROLE_MANAGER,
    securityDeviceId: Buffer.from(DEVICE_HEX, 'hex'),
    deviceKeyVersion: 3,
    oacSchemaVersion: 1,
    revocationEpochAtIssue: 3,
    managerAuthVersionAtIssue: 9,
    managerCredentialVersionAtIssue: 5,
    ssa1AuthVersionAtIssue: 4,
    attemptCount: 0,
    ssa1ExpiresAtServerMs: APPROVAL_LOWER + 3_600_000,
    trustedApprovalLowerMs: APPROVAL_LOWER,
    trustedApprovalUpperMs: APPROVAL_UPPER,
    pendingExecutionExpiresAtMs: Math.min(APPROVAL_LOWER + 259_200_000, DAY_END),
    nonce: Buffer.alloc(32, 0x31),
    approvalProofDigest: Buffer.alloc(32, 0x32),
    oacDigest: Buffer.from(sha256Hex(oacBytes), 'hex'),
    ssa1Digest: Buffer.from(sha256Hex(ssa1Bytes), 'hex'),
    branchId: BRANCH,
    initiatingStaffId: 'staff-1',
    approvingManagerStaffId: 'manager-1',
    oacId: 'oac-1',
    ssa1Id: 'ssa1-1',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: TARGET_DAY,
    localIntentId: 'intent-1',
    ...opts.frame,
  };
  const signature = ed25519Sign(
    null,
    paa1SignaturePreimage(unsigned),
    opts.signWith ?? deviceKey.privateKey,
  );
  const bytes = encodePaa1({ ...unsigned, signature });
  return {
    frame: { ...unsigned, signature },
    bytes,
    request: {
      paa1Base64: bytes.toString('base64'),
      ssa1Base64: ssa1Bytes.toString('base64'),
      oacEnvelopeBytesBase64: oacBytes.toString('base64'),
    },
    adjudicationId: unsigned.attestationId.toString('hex'),
    attestationDigest: sha256Hex(bytes),
  };
}

/** IR-002 — an exact, schema-true 29-key durable record for a given state. */
function buildDurableRecordFor(
  paa1: ReturnType<typeof buildPaa1>,
  state: (typeof OFFLINE_ADJUDICATION_RECORD_STATES)[number],
): Doc {
  const common: Doc = {
    schemaVersion: 1,
    adjudicationId: paa1.adjudicationId,
    attestationDigest: paa1.attestationDigest,
    paa1SchemaVersion: 1,
    actionId: 'VOID_SETTLED_SALE',
    targetOrderId: 'order-1',
    branchId: BRANCH,
    initiatingStaffId: 'staff-1',
    approvingManagerStaffId: 'manager-1',
    oacId: 'oac-1',
    ssa1Id: 'ssa1-1',
    securityDeviceIdHex: DEVICE_HEX,
    deviceKeyVersion: 3,
    audience: 'privilegedVoid',
    trustedApprovalLowerMs: APPROVAL_LOWER,
    trustedApprovalUpperMs: APPROVAL_UPPER,
    serverPendingExpiryMs: DAY_END,
    firstSeenAtMillis: NOW,
    firstRelayCallerStaffId: 'relay-1',
  };
  if (state === 'TERMINALLY_REJECTED') {
    return {
      ...common,
      state,
      verdict: 'REJECTED',
      rejectionReason: 'device_not_active',
      manualAttentionReason: null,
      outcomeKind: null,
      offlineExecutionId: null,
      consumedAtMillis: null,
      terminalizedAtMillis: NOW,
      completedAtMillis: null,
      completingRelayCallerStaffId: null,
    };
  }
  if (state === 'CONSUMED_PENDING_EXECUTION') {
    return {
      ...common,
      state,
      verdict: null,
      rejectionReason: null,
      manualAttentionReason: null,
      outcomeKind: null,
      offlineExecutionId: EXEC_ID_HEX,
      consumedAtMillis: NOW,
      terminalizedAtMillis: null,
      completedAtMillis: null,
      completingRelayCallerStaffId: null,
    };
  }
  if (state === 'COMPLETED') {
    return {
      ...common,
      state,
      verdict: 'ACCEPTED',
      rejectionReason: null,
      manualAttentionReason: null,
      outcomeKind: 'VOID_APPLIED',
      offlineExecutionId: EXEC_ID_HEX,
      consumedAtMillis: NOW,
      terminalizedAtMillis: null,
      completedAtMillis: NOW,
      completingRelayCallerStaffId: 'relay-1',
    };
  }
  return {
    ...common,
    state: 'MANUAL_ATTENTION_REQUIRED',
    verdict: 'MANUAL_ATTENTION_REQUIRED',
    rejectionReason: null,
    manualAttentionReason: 'canonical_correlation_missing',
    outcomeKind: null,
    offlineExecutionId: EXEC_ID_HEX,
    consumedAtMillis: NOW,
    terminalizedAtMillis: null,
    completedAtMillis: NOW,
    completingRelayCallerStaffId: 'relay-1',
  };
}

// ── Fake Firestore with read/write spies (PE-NORM-02 collection boundaries) ──

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(
    Object.entries({
      'users/relay-1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: [BRANCH] },
      'users/staff-1': { isActive: true, deletedAt: null, authVersion: 4, role: 'staff', branchIds: [BRANCH] },
      'users/manager-1': { isActive: true, deletedAt: null, authVersion: 9, role: 'manager', branchIds: [BRANCH] },
      'userCredentials/manager-1': {
        pinHash: '$2b$10$realhashplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 5,
        credentialState: 'rotated_authoritative',
        disabled: false,
        updatedBy: 't',
      },
      'settings/_rolePermissions': {
        rolePermissions: {
          admin: ['pos_sale', 'pos_void'],
          manager: ['pos_sale', 'pos_void'],
          staff: ['pos_sale', 'pos_void'],
        },
      },
      'privilegedRevocationState/current': {
        revocationEpoch: 3,
        updatedAtServerMs: 1,
        updatedBy: 'seed',
        reason: null,
      },
      [`privilegedDeviceRegistrations/${DEVICE_HEX}`]: {
        status: 'ACTIVE',
        deviceKeyVersion: 3,
        branchId: BRANCH,
        validatedDevProofPublicKeyBase64: rawPublicKeyBase64(deviceKey.publicKey),
      },
      'asyncOrders/order-1': {
        branchId: BRANCH,
        status: 'settled',
        reconcileStatus: 'settled',
        serverCreatedAt: ORDER_CREATED,
      },
      ...seed,
    }).map(([k, v]) => [k, { ...v }]),
  );

  const reads: string[] = [];
  const writes: string[] = [];
  const failReads = new Set<string>();
  const resolveVal = (v: unknown): unknown =>
    v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts' ? NOW : v;

  function applyData(path: string, data: Doc, merge = false) {
    writes.push(path);
    const existing = merge ? (store.get(path) ?? {}) : {};
    const next: Doc = merge ? { ...existing } : {};
    for (const [k, v] of Object.entries(data)) next[k] = resolveVal(v);
    store.set(path, next);
  }
  function readAt(path: string) {
    reads.push(path);
    if (failReads.has(path)) throw new Error(`INJECTED_READ_FAILURE: ${path}`);
    const data = store.get(path);
    return { exists: data !== undefined, id: path.slice(path.lastIndexOf('/') + 1), data: () => data };
  }
  function docRef(path: string): any {
    return {
      __doc: true,
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => readAt(path),
      set: async (data: Doc, opts?: { merge?: boolean }) => applyData(path, data, opts?.merge === true),
    };
  }
  let txMutex: Promise<void> = Promise.resolve();
  // Interleaving seam: fires once, on entry to the FIRST transaction, before
  // any of its reads. Lets a test mutate live state in the exact window between
  // preflight (already read) and the first-consume transaction (about to read).
  let beforeTransaction: (() => void) | null = null;
  let beforeTransactionFireCount = 0;
  const database: any = {
    collection: (c: string) => ({ __col: true, path: c, doc: (id: string) => docRef(`${c}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (beforeTransaction) {
        const hook = beforeTransaction;
        beforeTransaction = null; // self-clearing: exactly one firing
        beforeTransactionFireCount += 1;
        hook();
      }
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const prior = txMutex;
      txMutex = prior.then(() => held);
      await prior;
      try {
        const tx = {
          get: async (x: { path: string }) => readAt(x.path),
          set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) =>
            applyData(r.path, data, opts?.merge === true),
          update: (r: { path: string }, data: Doc) => applyData(r.path, data, true),
          create: (r: { path: string }, data: Doc) => {
            if (store.has(r.path)) throw new Error(`ALREADY_EXISTS: ${r.path}`);
            applyData(r.path, data);
          },
        };
        return await fn(tx);
      } finally {
        release();
      }
    },
  };
  return {
    database,
    store,
    reads,
    writes,
    failReads,
    readsIn: (collection: string) => reads.filter((p) => p.startsWith(`${collection}/`)),
    writesIn: (collection: string) => writes.filter((p) => p.startsWith(`${collection}/`)),
    setBeforeFirstTransaction: (fn: () => void) => {
      beforeTransaction = fn;
    },
    beforeTransactionFireCount: () => beforeTransactionFireCount,
    resetSpies: () => {
      reads.length = 0;
      writes.length = 0;
    },
  };
}

const relayAuth = (over: Record<string, unknown> = {}) => ({
  uid: 'uid-relay',
  token: { staffId: 'relay-1', authVersion: 0, permissions: ['pos_void'], ...over },
});

const voidApplied: VoidIntentTxnOutcome = { kind: 'VOID_APPLIED' };

function baseDeps(
  db: ReturnType<typeof makeDb>,
  over: AdjudicateOfflinePrivilegedActionDeps = {},
): AdjudicateOfflinePrivilegedActionDeps {
  return {
    nowMillis: NOW,
    loadVerifiableSigningKeys: async () => verifiableKeys() as never,
    executeCanonicalVoid: async (_d, orderRef, options) => {
      await orderRef.set(
        {
          status: 'voided',
          voidReconciled: true,
          privilegedVoidExecutionId: options?.privilegedVoidExecutionId,
          privilegedVoidOacId: options?.oacId,
          ...(options?.authoritativeActorStaffId != null ? { voidedBy: options.authoritativeActorStaffId } : {}),
        },
        { merge: true },
      );
      return voidApplied;
    },
    ...over,
  };
}

async function run(
  db: ReturnType<typeof makeDb>,
  request: unknown,
  auth: unknown = relayAuth(),
  deps: AdjudicateOfflinePrivilegedActionDeps = {},
): Promise<OfflineAdjudicationResponse> {
  return performAdjudicateOfflinePrivilegedAction(
    db.database,
    request as never,
    auth as never,
    baseDeps(db, deps),
  );
}

// ── IR-002/IR-007 shared assertion helpers (Codex Exact Evidence Prescription 005 §1) ──

/**
 * The known P0 caller authorization performs exactly two reads of the relay's
 * own user document: one in `evaluateFreshPrivilegedAuthority`, one in the
 * explicit live caller check. Those two are the only legitimate `users` reads
 * for any request that reaches Stage R; the initiator/manager user docs are
 * never read until Stage F re-authenticates a fresh (record-absent) frame.
 */
function expectOnlyP0RelayUserReads(db: ReturnType<typeof makeDb>, label?: string): void {
  expect(db.readsIn('users'), label).toEqual(['users/relay-1', 'users/relay-1']);
  expect(db.reads, label).not.toContain('users/staff-1');
  expect(db.reads, label).not.toContain('users/manager-1');
}

function expectNoFreshClassBReads(db: ReturnType<typeof makeDb>, label?: string): void {
  expect(db.readsIn('userCredentials'), label).toHaveLength(0);
  expect(db.reads, label).not.toContain('userCredentials/staff-1');
  expect(db.reads, label).not.toContain('userCredentials/manager-1');
  expect(db.readsIn('privilegedRevocationState'), label).toHaveLength(0);
  expectOnlyP0RelayUserReads(db, label);
}

/**
 * The complete early-boundary proof for a record that must fail parsing at
 * Stage R: the unreadable anomaly, no write, an unchanged stored record, and
 * zero device/async-order/Class-B/canonical-executor side effects.
 */
function expectUnreadableEarlyBoundary(
  db: ReturnType<typeof makeDb>,
  adjudicationPath: string,
  before: Doc,
  result: OfflineAdjudicationResponse,
  executeCanonicalVoid: ReturnType<typeof vi.fn>,
  label?: string,
): void {
  expect(result, label).toMatchObject({
    family: 'ADJUDICATION',
    kind: 'ADJUDICATION_ANOMALY',
    anomalyReason: 'adjudication_record_unreadable',
    recordWritten: false,
  });
  expect(db.writes, label).toHaveLength(0);
  expect(db.store.get(adjudicationPath), label).toStrictEqual(before);
  expect(db.readsIn('privilegedDeviceRegistrations'), label).toHaveLength(0);
  expect(db.readsIn('asyncOrders'), label).toHaveLength(0);
  expectNoFreshClassBReads(db, label);
  expect(executeCanonicalVoid, label).not.toHaveBeenCalled();
}

// ═══════════════════════════════════════════════════════════════════════════

describe('D-1B contract surface', () => {
  test('the closed vocabularies have exactly the ratified cardinalities', () => {
    expect(OFFLINE_ADJUDICATION_PROTOCOL_REASONS).toHaveLength(8);
    expect(OFFLINE_ADJUDICATION_REJECTION_REASONS).toHaveLength(32);
    expect(OFFLINE_ADJUDICATION_MANUAL_ATTENTION_REASONS).toHaveLength(3);
    expect(OFFLINE_ADJUDICATION_ANOMALY_REASONS).toHaveLength(2);
    expect(OFFLINE_ADJUDICATION_RETRY_REASONS).toHaveLength(3);
    expect(OFFLINE_ADJUDICATION_RECORD_STATES).toHaveLength(4);
    expect(OFFLINE_ADJUDICATION_RESPONSE_KINDS).toHaveLength(7);
    expect(new Set(OFFLINE_ADJUDICATION_REJECTION_REASONS).size).toBe(32);
    // The anomaly family is disjoint from the rejection family (PE2-F01).
    for (const reason of OFFLINE_ADJUDICATION_ANOMALY_REASONS) {
      expect(OFFLINE_ADJUDICATION_REJECTION_REASONS).not.toContain(reason as never);
    }
  });

  test('strict base64 rejects a re-encoding mismatch', () => {
    expect(strictBase64Decode('aGVsbG8=')?.toString()).toBe('hello');
    expect(strictBase64Decode('aGVsbG8')).toBeNull();
    expect(strictBase64Decode('!!!!')).toBeNull();
    expect(strictBase64Decode('')).toBeNull();
  });

  test('request-shape validation requires three non-empty strings', () => {
    expect(validateAdjudicationRequestShape({} as never)).toBeNull();
    expect(validateAdjudicationRequestShape({ paa1Base64: 'a', ssa1Base64: 'b' } as never)).toBeNull();
    expect(
      validateAdjudicationRequestShape({ paa1Base64: 'a', ssa1Base64: 'b', oacEnvelopeBytesBase64: '' } as never),
    ).toBeNull();
    expect(
      validateAdjudicationRequestShape({ paa1Base64: 'a', ssa1Base64: 'b', oacEnvelopeBytesBase64: 'c' } as never),
    ).toEqual({ paa1Base64: 'a', ssa1Base64: 'b', oacEnvelopeBytesBase64: 'c' });
  });

  test('relay branch eligibility is exact for staff/manager and admits live ALL only for admin', () => {
    expect(relayBranchEligible('staff', [BRANCH], BRANCH)).toBe(true);
    expect(relayBranchEligible('staff', ['ALL'], BRANCH)).toBe(false);
    expect(relayBranchEligible('manager', ['OTHER'], BRANCH)).toBe(false);
    expect(relayBranchEligible('admin', ['ALL'], BRANCH)).toBe(true);
    expect(relayBranchEligible(null, [BRANCH], BRANCH)).toBe(false);
  });

  test('server pending-expiry recomputation takes the earlier bound', () => {
    // Under the D8 cross-midnight bar the day boundary always binds in practice.
    expect(computeServerPendingExpiry(APPROVAL_LOWER, TARGET_DAY)).toBe(DAY_END);
    // The frozen 72h term is implemented and binds in the counterfactual where
    // the approval predates the target day by more than 72 hours.
    const early = DAY_END - 259_200_000 - 1;
    expect(computeServerPendingExpiry(early, TARGET_DAY)).toBe(early + 259_200_000);
    expect(computeServerPendingExpiry(1, 'not-a-date')).toBeNull();
  });

  test('AC-6 — every one of the 32 rejection reasons is emitted through the single durable terminalizer', () => {
    const src = readFileSync(
      resolve(__dirname, '../adjudicateOfflinePrivilegedActionCore.ts'),
      'utf8',
    );
    const emitted = new Set(
      [...src.matchAll(/terminalize\(\s*\n?\s*'([a-z0-9_]+)'/g)].map((m) => m[1]),
    );
    for (const reason of OFFLINE_ADJUDICATION_REJECTION_REASONS) {
      expect(emitted, reason).toContain(reason);
    }
    expect(emitted.size).toBe(32);
    // `terminalize` is the only producer of a TERMINALLY_REJECTED record outside
    // the consume transaction's own in-transaction refusal branch (the target
    // checks plus the OPTION_A_LINEARIZE authority checks, which share the one
    // `tx.create`), and each call creates exactly one record via `tx.create`.
    const terminalCreates = [
      ...src.matchAll(/tx\.create\(adjudicationRef,\s*\{[\s\S]{0,400}?state: 'TERMINALLY_REJECTED'/g),
    ].length;
    expect(terminalCreates).toBe(2);
    expect(src).not.toMatch(/state: 'TERMINALLY_REJECTED'[\s\S]{0,200}?\.set\(/);
  });

  test('record and registration parsers fail closed', () => {
    expect(parseOfflineAdjudicationRecord(null)).toBeNull();
    expect(parseOfflineAdjudicationRecord({ schemaVersion: 2 })).toBeNull();
    expect(parseDeviceRegistration({ status: 'UNKNOWN' })).toBeNull();
    expect(parseDeviceRegistration({ status: 'ACTIVE', deviceKeyVersion: 0 })).toBeNull();
    expect(OFFLINE_ADJUDICATION_IMMUTABLE_BINDING_FIELDS).toContain('attestationDigest');
  });
});

describe('Stage P — relay gate and the three PERMANENT byte reasons', () => {
  test('an unauthenticated or non-privileged caller is CALLER_DEPENDENT and writes nothing', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    for (const auth of [
      null,
      relayAuth({ staffId: '' }),
      relayAuth({ permissions: [] }),
      relayAuth({ staffId: 'ghost' }),
    ]) {
      db.resetSpies();
      const res = await run(db, paa1.request, auth);
      expect(res).toEqual({
        family: 'PROTOCOL',
        kind: 'PROTOCOL_REJECTED',
        protocolReason: 'relay_caller_not_authorized',
        recoverability: 'CALLER_DEPENDENT',
        serverObservedAtMs: NOW,
      });
      expect(db.writes).toHaveLength(0);
    }
  });

  test.each<[string, unknown, string]>([
    ['request_shape_invalid', {}, 'request_shape_invalid'],
    ['attestation_base64_invalid', null, 'attestation_base64_invalid'],
    ['attestation_malformed', null, 'attestation_malformed'],
  ])(
    'AC-18 / PE-NORM-02 — %s is PERMANENT and touches no adjudication, device, or live-state doc',
    async (label, literalRequest) => {
      const db = makeDb();
      const good = buildPaa1();
      const request =
        label === 'request_shape_invalid'
          ? (literalRequest as never)
          : label === 'attestation_base64_invalid'
            ? { ...good.request, paa1Base64: 'not base64 !!' }
            : { ...good.request, paa1Base64: Buffer.alloc(400, 7).toString('base64') };

      db.resetSpies();
      const res = await run(db, request);
      expect(res).toEqual({
        family: 'PROTOCOL',
        kind: 'PROTOCOL_REJECTED',
        protocolReason: label,
        recoverability: 'PERMANENT',
        serverObservedAtMs: NOW,
      });
      // After P0, a PERMANENT classification reads nothing else.
      expect(db.readsIn('privilegedOfflineAdjudications')).toHaveLength(0);
      expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
      expect(db.readsIn('asyncOrders')).toHaveLength(0);
      expect(db.readsIn('userCredentials')).toHaveLength(0);
      expect(db.readsIn('privilegedRevocationState')).toHaveLength(0);
      // Only the P0 relay-auth reads of the caller's own user doc may have run.
      expect(db.readsIn('users').every((p) => p === 'users/relay-1')).toBe(true);
      expect(db.writes).toHaveLength(0);
    },
  );

  test('a PERMANENT protocol response is byte-identical on repeat', async () => {
    const db = makeDb();
    const bad = { ...buildPaa1().request, paa1Base64: 'not base64 !!' };
    expect(await run(db, bad)).toEqual(await run(db, bad));
  });
});

describe('Stage F — fresh attestation always authenticates the current device', () => {
  test('a valid frame consumes, executes canonically, and completes', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request);

    const executionId = deriveOfflineVoidExecutionId({
      adjudicationId: paa1.adjudicationId,
      actionId: 'VOID_SETTLED_SALE',
      targetOrderId: 'order-1',
      branchId: BRANCH,
      initiatingStaffId: 'staff-1',
      approvingManagerStaffId: 'manager-1',
      oacId: 'oac-1',
      audience: 'privilegedVoid',
    });
    expect(res).toEqual({
      family: 'ADJUDICATION',
      kind: 'ACCEPTED',
      adjudicationId: paa1.adjudicationId,
      targetOrderId: 'order-1',
      offlineExecutionId: executionId,
      outcomeKind: 'VOID_APPLIED',
      idempotent: false,
      serverAdjudicatedAtMs: NOW,
    });

    const record = db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!;
    expect(record.state).toBe('COMPLETED');
    expect(record.verdict).toBe('ACCEPTED');
    expect(record.offlineExecutionId).toBe(executionId);
    expect(record.attestationDigest).toBe(paa1.attestationDigest);
    // Model B: attribution stays with the ORIGINAL initiating staff.
    expect(db.store.get('asyncOrders/order-1')!.voidedBy).toBe('staff-1');
    expect(db.store.get('asyncOrders/order-1')!.privilegedVoidExecutionId).toBe(executionId);
  });

  test.each<[string, Record<string, Doc>, string]>([
    ['registration absent', { [`privilegedDeviceRegistrations/${DEVICE_HEX}`]: undefined as never }, 'device_registration_unavailable'],
    [
      'key version advanced',
      {
        [`privilegedDeviceRegistrations/${DEVICE_HEX}`]: {
          status: 'ACTIVE',
          deviceKeyVersion: 4,
          branchId: BRANCH,
          validatedDevProofPublicKeyBase64: rawPublicKeyBase64(deviceKey.publicKey),
        },
      },
      'device_key_material_unavailable',
    ],
    [
      're-enrolled with a different key at the same version',
      {
        [`privilegedDeviceRegistrations/${DEVICE_HEX}`]: {
          status: 'ACTIVE',
          deviceKeyVersion: 3,
          branchId: BRANCH,
          validatedDevProofPublicKeyBase64: rawPublicKeyBase64(generateKeyPairSync('ed25519').publicKey),
        },
      },
      'attestation_signature_invalid',
    ],
  ])('AC-20 — %s is STATE_DEPENDENT, writes no record, and is retry-safe', async (_l, seed, reason) => {
    const db = makeDb();
    for (const [k, v] of Object.entries(seed)) {
      if (v === undefined) db.store.delete(k);
      else db.store.set(k, v as Doc);
    }
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request);
    expect(res).toEqual({
      family: 'PROTOCOL',
      kind: 'PROTOCOL_REJECTED',
      protocolReason: reason,
      recoverability: 'STATE_DEPENDENT',
      serverObservedAtMs: NOW,
    });
    expect(db.writesIn('privilegedOfflineAdjudications')).toHaveLength(0);
    expect(await run(db, paa1.request)).toEqual(res);
  });

  test('a branch-ineligible relay is refused at F4 with no record written', async () => {
    const db = makeDb();
    db.store.set('users/relay-1', {
      isActive: true,
      deletedAt: null,
      authVersion: 0,
      role: 'staff',
      branchIds: ['OTHER-999'],
    });
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request);
    expect(res).toMatchObject({ kind: 'PROTOCOL_REJECTED', protocolReason: 'relay_branch_not_permitted', recoverability: 'CALLER_DEPENDENT' });
    expect(db.writesIn('privilegedOfflineAdjudications')).toHaveLength(0);
  });

  test('AC-6 — a durable Class-B rejection writes exactly one TERMINALLY_REJECTED record', async () => {
    const db = makeDb();
    db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, {
      status: 'REVOKED',
      deviceKeyVersion: 3,
      branchId: BRANCH,
      validatedDevProofPublicKeyBase64: rawPublicKeyBase64(deviceKey.publicKey),
    });
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request);
    expect(res).toMatchObject({ kind: 'REJECTED', rejectionReason: 'device_not_active', terminal: true, idempotent: false });
    const written = db.writesIn('privilegedOfflineAdjudications');
    expect(written).toEqual([`privilegedOfflineAdjudications/${paa1.adjudicationId}`]);
    const record = db.store.get(written[0])!;
    expect(record.state).toBe('TERMINALLY_REJECTED');
    expect(record.verdict).toBe('REJECTED');
    expect(record.offlineExecutionId).toBeNull();
  });

  test('a device whose branch drifted after enrollment is durably rejected', async () => {
    const db = makeDb();
    db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, {
      status: 'ACTIVE',
      deviceKeyVersion: 3,
      branchId: 'OTHER-999',
      validatedDevProofPublicKeyBase64: rawPublicKeyBase64(deviceKey.publicKey),
    });
    const res = await run(db, buildPaa1().request);
    expect(res).toMatchObject({ kind: 'REJECTED', rejectionReason: 'device_branch_mismatch' });
  });

  test.each<[string, () => { db: ReturnType<typeof makeDb>; request: unknown }, string]>([
    [
      'ssa1_digest_mismatch',
      () => {
        const db = makeDb();
        const p = buildPaa1();
        const other = buildSsa1({ ssa1Id: 'ssa1-2' });
        return { db, request: { ...p.request, ssa1Base64: other.bytes.toString('base64') } };
      },
      'ssa1_digest_mismatch',
    ],
    [
      'ssa1_signature_invalid',
      () => {
        const db = makeDb();
        const p = buildPaa1();
        return {
          db,
          request: p.request,
          // No verifiable key matches the SSA1 signing key id.
        };
      },
      'ssa1_signature_invalid',
    ],
    [
      'ssa1_binding_mismatch',
      () => {
        const db = makeDb();
        const ssa1 = buildSsa1({ staffId: 'staff-9' });
        const p = buildPaa1({ ssa1Bytes: ssa1.bytes });
        return { db, request: p.request };
      },
      'ssa1_binding_mismatch',
    ],
    [
      'oac_digest_mismatch',
      () => {
        const db = makeDb();
        const p = buildPaa1();
        const other = buildOac({ oacId: 'oac-9' });
        return { db, request: { ...p.request, oacEnvelopeBytesBase64: other.bytes.toString('base64') } };
      },
      'oac_digest_mismatch',
    ],
    [
      'action_not_allowed_by_oac',
      () => {
        const db = makeDb();
        const oac = buildOac({ allowedActions: ['VOID_PENDING_SALE'] });
        const p = buildPaa1({ oacBytes: oac.bytes });
        return { db, request: p.request };
      },
      'action_not_allowed_by_oac',
    ],
    [
      'oac_freshness_expired',
      () => {
        const db = makeDb();
        const oac = buildOac({ freshnessExpiresAtServerMs: APPROVAL_LOWER - 1 });
        const p = buildPaa1({ oacBytes: oac.bytes });
        return { db, request: p.request };
      },
      'oac_freshness_expired',
    ],
  ])('durable Class-B rejection: %s', async (label, build, reason) => {
    const { db, request } = build();
    const deps: AdjudicateOfflinePrivilegedActionDeps =
      label === 'ssa1_signature_invalid' ? { loadVerifiableSigningKeys: async () => [] } : {};
    const res = await run(db, request, relayAuth(), deps);
    expect(res).toMatchObject({ kind: 'REJECTED', rejectionReason: reason, terminal: true });
    expect(db.writesIn('privilegedOfflineAdjudications')).toHaveLength(1);
  });

  test.each<[string, Record<string, Doc | undefined>, string]>([
    ['initiator_not_found', { 'users/staff-1': undefined }, 'initiator_not_found'],
    [
      'initiator_inactive',
      { 'users/staff-1': { isActive: false, deletedAt: null, authVersion: 4, role: 'staff', branchIds: [BRANCH] } },
      'initiator_inactive',
    ],
    [
      'initiator_auth_version_changed',
      { 'users/staff-1': { isActive: true, deletedAt: null, authVersion: 5, role: 'staff', branchIds: [BRANCH] } },
      'initiator_auth_version_changed',
    ],
    [
      'initiator_branch_mismatch',
      { 'users/staff-1': { isActive: true, deletedAt: null, authVersion: 4, role: 'staff', branchIds: ['OTHER'] } },
      'initiator_branch_mismatch',
    ],
    ['manager_not_found', { 'users/manager-1': undefined }, 'manager_not_found'],
    [
      'manager_inactive_or_not_privileged',
      { 'users/manager-1': { isActive: true, deletedAt: null, authVersion: 9, role: 'staff', branchIds: [BRANCH] } },
      'manager_inactive_or_not_privileged',
    ],
    [
      'manager_auth_version_changed',
      { 'users/manager-1': { isActive: true, deletedAt: null, authVersion: 10, role: 'manager', branchIds: [BRANCH] } },
      'manager_auth_version_changed',
    ],
    [
      'manager_credential_version_changed',
      {
        'userCredentials/manager-1': {
          pinHash: 'h',
          algo: 'bcrypt',
          cost: 10,
          credentialVersion: 6,
          credentialState: 'rotated_authoritative',
          disabled: false,
          updatedBy: 't',
        },
      },
      'manager_credential_version_changed',
    ],
    [
      'manager_branch_mismatch',
      { 'users/manager-1': { isActive: true, deletedAt: null, authVersion: 9, role: 'manager', branchIds: ['OTHER'] } },
      'manager_branch_mismatch',
    ],
    [
      'revocation_epoch_changed',
      { 'privilegedRevocationState/current': { revocationEpoch: 4, updatedAtServerMs: 1, updatedBy: 's', reason: null } },
      'revocation_epoch_changed',
    ],
    ['target_order_not_found', { 'asyncOrders/order-1': undefined }, 'target_order_not_found'],
    [
      'target_branch_mismatch',
      {
        'asyncOrders/order-1': {
          branchId: 'OTHER',
          status: 'settled',
          reconcileStatus: 'settled',
          serverCreatedAt: ORDER_CREATED,
        },
      },
      'target_branch_mismatch',
    ],
    [
      'target_state_mismatch',
      {
        'asyncOrders/order-1': {
          branchId: BRANCH,
          status: 'completed',
          reconcileStatus: 'pending_reconcile',
          serverCreatedAt: ORDER_CREATED,
        },
      },
      'target_state_mismatch',
    ],
    [
      'target_already_voided',
      {
        'asyncOrders/order-1': {
          branchId: BRANCH,
          status: 'voided',
          reconcileStatus: 'settled',
          serverCreatedAt: ORDER_CREATED,
        },
      },
      'target_already_voided',
    ],
  ])('live-state Class-B rejection: %s', async (_label, seed, reason) => {
    const db = makeDb();
    for (const [k, v] of Object.entries(seed)) {
      if (v === undefined) db.store.delete(k);
      else db.store.set(k, v);
    }
    const res = await run(db, buildPaa1().request);
    expect(res).toMatchObject({ kind: 'REJECTED', rejectionReason: reason, terminal: true });
    expect(db.writesIn('privilegedOfflineAdjudications')).toHaveLength(1);
  });

  test('permission revocation for the original parties is durably terminal', async () => {
    const initiatorDenied = makeDb();
    initiatorDenied.store.set('settings/_rolePermissions', {
      rolePermissions: { admin: ['pos_void'], manager: ['pos_void'], staff: ['pos_sale'] },
    });
    initiatorDenied.store.set('users/relay-1', {
      isActive: true,
      deletedAt: null,
      authVersion: 0,
      role: 'manager',
      branchIds: [BRANCH],
    });
    expect(await run(initiatorDenied, buildPaa1().request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'initiator_permission_revoked',
    });

    const managerDenied = makeDb();
    managerDenied.store.set('settings/_rolePermissions', {
      rolePermissions: { admin: ['pos_void'], manager: ['pos_sale'], staff: ['pos_void'] },
    });
    expect(await run(managerDenied, buildPaa1().request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'manager_permission_revoked',
    });
  });

  test('an expired pending intent is rejected only by the server', async () => {
    const db = makeDb();
    const res = await run(db, buildPaa1().request, relayAuth(), { nowMillis: DAY_END + 1 });
    expect(res).toMatchObject({ kind: 'REJECTED', rejectionReason: 'pending_execution_expired_day_boundary' });
  });

  test('an attested lifetime longer than the server can authorise is rejected', async () => {
    const db = makeDb();
    const paa1 = buildPaa1({ frame: { pendingExecutionExpiresAtMs: DAY_END + 60_000 } });
    expect(await run(db, paa1.request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'attested_expiry_exceeds_authority',
    });
  });

  test('an order created on a different UTC+7 day is a day-boundary rejection', async () => {
    const db = makeDb();
    db.store.set('asyncOrders/order-1', {
      branchId: BRANCH,
      status: 'settled',
      reconcileStatus: 'settled',
      serverCreatedAt: ORDER_CREATED - 86_400_000,
    });
    expect(await run(db, buildPaa1().request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'pending_execution_expired_day_boundary',
    });
  });

  test('trusted bounds in the server future are a durable frame-residue rejection', async () => {
    const db = makeDb();
    const paa1 = buildPaa1({
      frame: {
        trustedApprovalLowerMs: NOW + 60_000,
        trustedApprovalUpperMs: NOW + 60_250,
        ssa1ExpiresAtServerMs: NOW + 3_600_000,
        pendingExecutionExpiresAtMs: DAY_END,
      },
    });
    expect(await run(db, paa1.request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'trusted_time_bounds_invalid',
    });
  });
});

describe('Stage R — durable replay before mutable device state', () => {
  async function seedTerminalRejection() {
    const db = makeDb();
    db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, {
      status: 'REVOKED',
      deviceKeyVersion: 3,
      branchId: BRANCH,
      validatedDevProofPublicKeyBase64: rawPublicKeyBase64(deviceKey.publicKey),
    });
    const paa1 = buildPaa1();
    const first = await run(db, paa1.request);
    expect(first).toMatchObject({ kind: 'REJECTED', rejectionReason: 'device_not_active' });
    return { db, paa1, first };
  }

  test('AC-1/AC-19 — a TERMINALLY_REJECTED replay survives key rotation and reads no registration', async () => {
    const { db, paa1, first } = await seedTerminalRejection();

    // Mutate every mutable authority the old ordering depended on.
    db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, {
      status: 'ACTIVE',
      deviceKeyVersion: 99,
      branchId: 'OTHER-999',
      validatedDevProofPublicKeyBase64: rawPublicKeyBase64(generateKeyPairSync('ed25519').publicKey),
    });
    db.store.set('users/manager-1', { isActive: false, deletedAt: null, authVersion: 77, role: 'staff', branchIds: [] });
    db.store.delete('asyncOrders/order-1');
    db.store.set('privilegedRevocationState/current', {
      revocationEpoch: 42,
      updatedAtServerMs: 1,
      updatedBy: 's',
      reason: null,
    });

    db.resetSpies();
    const replay = await run(db, paa1.request);
    expect(replay).toEqual({ ...first, idempotent: true });

    // AC-2 — zero device-registration reads, zero fresh Class-B reads.
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
    expect(db.readsIn('asyncOrders')).toHaveLength(0);
    expect(db.readsIn('userCredentials')).toHaveLength(0);
    expect(db.readsIn('privilegedRevocationState')).toHaveLength(0);
    expect(db.readsIn('users').every((p) => p === 'users/relay-1')).toBe(true);
    expect(db.readsIn('privilegedOfflineAdjudications')).toHaveLength(1);
    expect(db.writes).toHaveLength(0);
  });

  test('AC-1 — a COMPLETED replay returns the identical accepted outcome with no fresh reads', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const first = await run(db, paa1.request);
    expect(first).toMatchObject({ kind: 'ACCEPTED' });

    db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, {
      status: 'REVOKED',
      deviceKeyVersion: 99,
      branchId: 'OTHER',
      validatedDevProofPublicKeyBase64: rawPublicKeyBase64(generateKeyPairSync('ed25519').publicKey),
    });
    db.resetSpies();
    expect(await run(db, paa1.request)).toEqual({ ...first, idempotent: true });
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
    expect(db.readsIn('asyncOrders')).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  test('a MANUAL_ATTENTION_REQUIRED replay returns the identical stored result', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    // The order is voided by a different execution → correlation conflict.
    const first = await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async (_d, orderRef) => {
        await orderRef.set(
          { status: 'voided', voidReconciled: true, privilegedVoidExecutionId: 'someone-else' },
          { merge: true },
        );
        return { kind: 'VOID_APPLIED' };
      },
    });
    expect(first).toMatchObject({
      kind: 'MANUAL_ATTENTION_REQUIRED',
      manualAttentionReason: 'canonical_execution_unresolved',
    });

    db.resetSpies();
    expect(await run(db, paa1.request)).toEqual({ ...first, idempotent: true });
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  test('AC-21 — a branch-ineligible relay cannot retrieve or resume any of the four record states', async () => {
    const states: Record<string, Doc> = {};
    const paa1 = buildPaa1();
    const bindingBase = {
      schemaVersion: 1,
      adjudicationId: paa1.adjudicationId,
      attestationDigest: paa1.attestationDigest,
      paa1SchemaVersion: 1,
      actionId: 'VOID_SETTLED_SALE',
      targetOrderId: 'order-1',
      branchId: BRANCH,
      initiatingStaffId: 'staff-1',
      approvingManagerStaffId: 'manager-1',
      oacId: 'oac-1',
      ssa1Id: 'ssa1-1',
      securityDeviceIdHex: DEVICE_HEX,
      deviceKeyVersion: 3,
      audience: 'privilegedVoid',
      trustedApprovalLowerMs: APPROVAL_LOWER,
      trustedApprovalUpperMs: APPROVAL_UPPER,
      serverPendingExpiryMs: DAY_END,
      manualAttentionReason: null,
      outcomeKind: null,
      rejectionReason: null,
      verdict: null,
      offlineExecutionId: null,
      firstSeenAtMillis: NOW,
      consumedAtMillis: null,
      terminalizedAtMillis: null,
      completedAtMillis: null,
      firstRelayCallerStaffId: 'relay-1',
      completingRelayCallerStaffId: null,
    };
    states.TERMINALLY_REJECTED = {
      ...bindingBase,
      state: 'TERMINALLY_REJECTED',
      verdict: 'REJECTED',
      rejectionReason: 'device_not_active',
      terminalizedAtMillis: NOW,
    };
    states.COMPLETED = {
      ...bindingBase,
      state: 'COMPLETED',
      verdict: 'ACCEPTED',
      outcomeKind: 'VOID_APPLIED',
      offlineExecutionId: EXEC_ID_HEX,
      consumedAtMillis: NOW,
      completedAtMillis: NOW,
      completingRelayCallerStaffId: 'relay-1',
    };
    states.MANUAL_ATTENTION_REQUIRED = {
      ...bindingBase,
      state: 'MANUAL_ATTENTION_REQUIRED',
      verdict: 'MANUAL_ATTENTION_REQUIRED',
      manualAttentionReason: 'canonical_correlation_missing',
      offlineExecutionId: EXEC_ID_HEX,
      consumedAtMillis: NOW,
      completedAtMillis: NOW,
      completingRelayCallerStaffId: 'relay-1',
    };
    states.CONSUMED_PENDING_EXECUTION = {
      ...bindingBase,
      state: 'CONSUMED_PENDING_EXECUTION',
      offlineExecutionId: EXEC_ID_HEX,
      consumedAtMillis: NOW,
    };

    for (const [state, record] of Object.entries(states)) {
      const db = makeDb();
      db.store.set(`privilegedOfflineAdjudications/${paa1.adjudicationId}`, record);
      db.store.set('users/relay-1', {
        isActive: true,
        deletedAt: null,
        authVersion: 0,
        role: 'staff',
        branchIds: ['OTHER-999'],
      });
      db.resetSpies();
      const res = await run(db, paa1.request);
      expect(res, state).toMatchObject({
        kind: 'PROTOCOL_REJECTED',
        protocolReason: 'relay_branch_not_permitted',
        recoverability: 'CALLER_DEPENDENT',
      });
      // Phase C is never entered and the record is untouched.
      expect(db.writes, state).toHaveLength(0);
      expect(db.readsIn('asyncOrders'), state).toHaveLength(0);
      expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`), state).toEqual(record);
    }
  });

  test('AC-16/TR-2 — different bytes under the same adjudication id are an anomaly, never the stored verdict', async () => {
    const { db, paa1 } = await seedTerminalRejection();
    // Same attestationId, different bytes (a different local intent id).
    const impostor = buildPaa1({ frame: { localIntentId: 'intent-9' } });
    expect(impostor.adjudicationId).toBe(paa1.adjudicationId);
    expect(impostor.attestationDigest).not.toBe(paa1.attestationDigest);

    db.resetSpies();
    const res = await run(db, impostor.request);
    expect(res).toEqual({
      family: 'ADJUDICATION',
      kind: 'ADJUDICATION_ANOMALY',
      adjudicationId: paa1.adjudicationId,
      targetOrderId: 'order-1',
      anomalyReason: 'adjudication_record_binding_conflict',
      terminalForAutomation: true,
      recordWritten: false,
      serverObservedAtMs: NOW,
    });
    // AC-15/AN-1/AN-2 — no write of any kind, and no Class-B read.
    expect(db.writes).toHaveLength(0);
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
    expect(db.readsIn('asyncOrders')).toHaveLength(0);
  });

  test('AC-15 — an unreadable record is an anomaly and is never overwritten', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const corrupt = { schemaVersion: 2, state: 'WHO_KNOWS' };
    db.store.set(`privilegedOfflineAdjudications/${paa1.adjudicationId}`, corrupt);
    db.resetSpies();

    const res = await run(db, paa1.request);
    expect(res).toMatchObject({
      kind: 'ADJUDICATION_ANOMALY',
      anomalyReason: 'adjudication_record_unreadable',
      recordWritten: false,
    });
    expect(db.writes).toHaveLength(0);
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)).toEqual(corrupt);
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
  });

  test('PE-NORM-01 — a Stage-R lookup failure is PROTOCOL_RETRYABLE, not an ADJUDICATION retryable', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    db.failReads.add(`privilegedOfflineAdjudications/${paa1.adjudicationId}`);
    const res = await run(db, paa1.request);
    expect(res).toEqual({
      family: 'PROTOCOL',
      kind: 'PROTOCOL_RETRYABLE',
      retryReason: 'backend_unavailable',
      serverObservedAtMs: NOW,
    });
    expect(db.writes).toHaveLength(0);
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
  });

  test('AC-3 — a retryable response never writes terminal adjudication state', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    db.failReads.add(`privilegedDeviceRegistrations/${DEVICE_HEX}`);
    const res = await run(db, paa1.request);
    expect(res).toMatchObject({ kind: 'PROTOCOL_RETRYABLE', retryReason: 'backend_unavailable' });
    expect(db.writesIn('privilegedOfflineAdjudications')).toHaveLength(0);
  });
});

describe('Concurrency, resume, and the two-phase canonical contract', () => {
  test('AC-5 — concurrent byte-identical submissions produce one record and identical responses', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const [a, b] = await Promise.all([run(db, paa1.request), run(db, paa1.request)]);
    // The loser adopts the winner's exact record result. The only field that
    // differs is `idempotent`, which reports whether *this* call did the work.
    const strip = (r: OfflineAdjudicationResponse) => ({ ...r, idempotent: undefined });
    expect(strip(a)).toEqual(strip(b));
    expect(a).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'VOID_APPLIED' });
    expect(b).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'VOID_APPLIED' });
    expect([(a as { idempotent: boolean }).idempotent, (b as { idempotent: boolean }).idempotent].sort()).toEqual([
      false,
      true,
    ]);
    // Exactly one durable record, created exactly once.
    const path = `privilegedOfflineAdjudications/${paa1.adjudicationId}`;
    expect(db.writes.filter((p) => p === path).length).toBeGreaterThan(0);
    expect(db.store.get(path)!.state).toBe('COMPLETED');
    expect(db.store.get(path)!.consumedAtMillis).toBe(NOW);
  });

  test('AC-13 — CONSUMED_PENDING_EXECUTION resumes Phase C only and never re-adjudicates', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    // First pass: the canonical void throws, leaving the record consumed.
    const first = await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async () => {
        throw new Error('transient');
      },
    });
    expect(first).toMatchObject({ family: 'ADJUDICATION', kind: 'RETRYABLE', retryReason: 'internal_error', terminal: false });
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe(
      'CONSUMED_PENDING_EXECUTION',
    );

    // Now break every fresh-authorization input. Resume must not consult them.
    db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, {
      status: 'REVOKED',
      deviceKeyVersion: 99,
      branchId: 'OTHER',
      validatedDevProofPublicKeyBase64: rawPublicKeyBase64(generateKeyPairSync('ed25519').publicKey),
    });
    db.store.set('users/manager-1', { isActive: false, deletedAt: null, authVersion: 1, role: 'staff', branchIds: [] });
    db.resetSpies();

    const resumed = await run(db, paa1.request);
    expect(resumed).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'VOID_APPLIED' });
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
    expect(db.readsIn('userCredentials')).toHaveLength(0);
    expect(db.readsIn('privilegedRevocationState')).toHaveLength(0);
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe('COMPLETED');
  });

  test('no double canonical void — a completed record replays without re-executing', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    let executions = 0;
    const deps: AdjudicateOfflinePrivilegedActionDeps = {
      executeCanonicalVoid: async (_d, orderRef, options) => {
        executions += 1;
        await orderRef.set(
          {
            status: 'voided',
            voidReconciled: true,
            privilegedVoidExecutionId: options?.privilegedVoidExecutionId,
          },
          { merge: true },
        );
        return voidApplied;
      },
    };
    await run(db, paa1.request, relayAuth(), deps);
    await run(db, paa1.request, relayAuth(), deps);
    await run(db, paa1.request, relayAuth(), deps);
    expect(executions).toBe(1);
  });

  test('correlation missing and conflict route to manual attention without re-voiding', async () => {
    for (const [existing, reason] of [
      [undefined, 'canonical_correlation_missing'],
      ['other-execution', 'canonical_correlation_conflict'],
    ] as const) {
      const db = makeDb();
      const paa1 = buildPaa1();
      db.store.set('asyncOrders/order-1', {
        branchId: BRANCH,
        status: 'settled',
        reconcileStatus: 'settled',
        serverCreatedAt: ORDER_CREATED,
      });
      let executions = 0;
      const res = await run(db, paa1.request, relayAuth(), {
        executeCanonicalVoid: async (_d, orderRef) => {
          executions += 1;
          await orderRef.set(
            {
              status: 'voided',
              voidReconciled: true,
              ...(existing ? { privilegedVoidExecutionId: existing } : {}),
            },
            { merge: true },
          );
          return { kind: 'NOOP', reason: 'already_reconciled' };
        },
      });
      expect(res).toMatchObject({ kind: 'MANUAL_ATTENTION_REQUIRED', manualAttentionReason: reason });
      expect(executions).toBe(1);
      expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe(
        'MANUAL_ATTENTION_REQUIRED',
      );
      // Replay returns the stored result and does not re-execute.
      const replay = await run(db, paa1.request);
      expect(replay).toEqual({ ...res, idempotent: true });
      expect(executions).toBe(1);
    }
  });

  test('an order that vanished after consumption routes to manual attention', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async (_d, orderRef) => {
        await orderRef.set({}, { merge: true });
        return { kind: 'NOOP', reason: 'absent' };
      },
    });
    expect(res).toMatchObject({
      kind: 'MANUAL_ATTENTION_REQUIRED',
      manualAttentionReason: 'canonical_execution_unresolved',
    });
  });

  test('AC-7 — no transition leaves a terminal state', async () => {
    const paa1 = buildPaa1();
    const terminal = ['TERMINALLY_REJECTED', 'COMPLETED', 'MANUAL_ATTENTION_REQUIRED'] as const;
    for (const state of terminal) {
      const db = makeDb();
      const record: Doc = {
        schemaVersion: 1,
        state,
        adjudicationId: paa1.adjudicationId,
        attestationDigest: paa1.attestationDigest,
        paa1SchemaVersion: 1,
        actionId: 'VOID_SETTLED_SALE',
        targetOrderId: 'order-1',
        branchId: BRANCH,
        initiatingStaffId: 'staff-1',
        approvingManagerStaffId: 'manager-1',
        oacId: 'oac-1',
        ssa1Id: 'ssa1-1',
        securityDeviceIdHex: DEVICE_HEX,
        deviceKeyVersion: 3,
        audience: 'privilegedVoid',
        trustedApprovalLowerMs: APPROVAL_LOWER,
        trustedApprovalUpperMs: APPROVAL_UPPER,
        serverPendingExpiryMs: DAY_END,
        offlineExecutionId: state === 'TERMINALLY_REJECTED' ? null : EXEC_ID_HEX,
        verdict: state === 'COMPLETED' ? 'ACCEPTED' : state === 'TERMINALLY_REJECTED' ? 'REJECTED' : 'MANUAL_ATTENTION_REQUIRED',
        rejectionReason: state === 'TERMINALLY_REJECTED' ? 'device_not_active' : null,
        manualAttentionReason: state === 'MANUAL_ATTENTION_REQUIRED' ? 'canonical_correlation_missing' : null,
        outcomeKind: state === 'COMPLETED' ? 'VOID_APPLIED' : null,
        firstSeenAtMillis: NOW,
        consumedAtMillis: state === 'TERMINALLY_REJECTED' ? null : NOW,
        terminalizedAtMillis: state === 'TERMINALLY_REJECTED' ? NOW : null,
        completedAtMillis: state === 'TERMINALLY_REJECTED' ? null : NOW,
        firstRelayCallerStaffId: 'relay-1',
        completingRelayCallerStaffId: state === 'TERMINALLY_REJECTED' ? null : 'relay-1',
      };
      db.store.set(`privilegedOfflineAdjudications/${paa1.adjudicationId}`, record);
      db.resetSpies();
      await run(db, paa1.request);
      expect(db.writes, state).toHaveLength(0);
      expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state, state).toBe(state);
    }
  });
});

describe('Model-B relay', () => {
  test('a different relay operator can complete an intent the original cashier started', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async () => {
        throw new Error('transient');
      },
    });

    // A different cashier signs in at the same branch and relays the same bytes.
    db.store.set('users/relay-2', {
      isActive: true,
      deletedAt: null,
      authVersion: 2,
      role: 'staff',
      branchIds: [BRANCH],
    });
    const res = await run(
      db,
      paa1.request,
      { uid: 'uid-2', token: { staffId: 'relay-2', authVersion: 2, permissions: ['pos_void'] } },
    );
    expect(res).toMatchObject({ kind: 'ACCEPTED' });
    // Attribution stays with the original initiating staff, not the relay.
    expect(db.store.get('asyncOrders/order-1')!.voidedBy).toBe('staff-1');
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.firstRelayCallerStaffId).toBe(
      'relay-1',
    );
  });

  test('the relay cannot substitute the bound manager or action — the bytes decide', async () => {
    const db = makeDb();
    // The relay IS the approving manager; the frame still names manager-1.
    db.store.set('users/relay-1', {
      isActive: true,
      deletedAt: null,
      authVersion: 0,
      role: 'manager',
      branchIds: [BRANCH],
    });
    db.store.set('users/manager-1', { isActive: false, deletedAt: null, authVersion: 9, role: 'manager', branchIds: [BRANCH] });
    expect(await run(db, buildPaa1().request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'manager_inactive_or_not_privileged',
    });
  });
});

describe('IR-001 — OAC freshness uses the conservative upper trusted-approval bound', () => {
  test('upper bound one millisecond past freshness expiry is rejected', async () => {
    const db = makeDb();
    const oac = buildOac({ freshnessExpiresAtServerMs: APPROVAL_UPPER - 1 });
    const paa1 = buildPaa1({ oacBytes: oac.bytes });
    expect(await run(db, paa1.request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'oac_freshness_expired',
    });
  });

  test('upper bound exactly at freshness expiry is allowed', async () => {
    const db = makeDb();
    const oac = buildOac({ freshnessExpiresAtServerMs: APPROVAL_UPPER });
    const paa1 = buildPaa1({ oacBytes: oac.bytes });
    expect(await run(db, paa1.request)).toMatchObject({ kind: 'ACCEPTED' });
  });

  test('upper bound one millisecond inside freshness expiry is allowed', async () => {
    const db = makeDb();
    const oac = buildOac({ freshnessExpiresAtServerMs: APPROVAL_UPPER + 1 });
    const paa1 = buildPaa1({ oacBytes: oac.bytes });
    expect(await run(db, paa1.request)).toMatchObject({ kind: 'ACCEPTED' });
  });

  test('a trace where lower <= expiry < upper is rejected even though the lower bound alone would pass', async () => {
    const db = makeDb();
    // lower is well before expiry, but the conservative upper bound is past it.
    const oac = buildOac({ freshnessExpiresAtServerMs: APPROVAL_LOWER + 1 });
    const paa1 = buildPaa1({ oacBytes: oac.bytes });
    expect(paa1.frame.trustedApprovalLowerMs).toBeLessThanOrEqual(APPROVAL_LOWER + 1);
    expect(paa1.frame.trustedApprovalUpperMs).toBeGreaterThan(APPROVAL_LOWER + 1);
    expect(await run(db, paa1.request)).toMatchObject({
      kind: 'REJECTED',
      rejectionReason: 'oac_freshness_expired',
    });
  });
});

describe('IR-002 — strict state-discriminated record parser', () => {
  const parserPaa1 = buildPaa1();
  const validBase = {
    schemaVersion: 1,
    adjudicationId: parserPaa1.adjudicationId,
    attestationDigest: parserPaa1.attestationDigest,
    paa1SchemaVersion: 1,
    actionId: 'VOID_SETTLED_SALE',
    targetOrderId: 'order-1',
    branchId: BRANCH,
    initiatingStaffId: 'staff-1',
    approvingManagerStaffId: 'manager-1',
    oacId: 'oac-1',
    ssa1Id: 'ssa1-1',
    securityDeviceIdHex: DEVICE_HEX,
    deviceKeyVersion: 3,
    audience: 'privilegedVoid',
    trustedApprovalLowerMs: APPROVAL_LOWER,
    trustedApprovalUpperMs: APPROVAL_UPPER,
    serverPendingExpiryMs: DAY_END,
    firstSeenAtMillis: NOW,
    firstRelayCallerStaffId: 'relay-1',
  };

  function validFor(state: (typeof OFFLINE_ADJUDICATION_RECORD_STATES)[number]): Doc {
    if (state === 'TERMINALLY_REJECTED') {
      return {
        ...validBase,
        state,
        verdict: 'REJECTED',
        rejectionReason: 'device_not_active',
        manualAttentionReason: null,
        outcomeKind: null,
        offlineExecutionId: null,
        consumedAtMillis: null,
        terminalizedAtMillis: NOW,
        completedAtMillis: null,
        completingRelayCallerStaffId: null,
      };
    }
    if (state === 'CONSUMED_PENDING_EXECUTION') {
      return {
        ...validBase,
        state,
        verdict: null,
        rejectionReason: null,
        manualAttentionReason: null,
        outcomeKind: null,
        offlineExecutionId: EXEC_ID_HEX,
        consumedAtMillis: NOW,
        terminalizedAtMillis: null,
        completedAtMillis: null,
        completingRelayCallerStaffId: null,
      };
    }
    if (state === 'COMPLETED') {
      return {
        ...validBase,
        state,
        verdict: 'ACCEPTED',
        rejectionReason: null,
        manualAttentionReason: null,
        outcomeKind: 'VOID_APPLIED',
        offlineExecutionId: EXEC_ID_HEX,
        consumedAtMillis: NOW,
        terminalizedAtMillis: null,
        completedAtMillis: NOW,
        completingRelayCallerStaffId: 'relay-1',
      };
    }
    return {
      ...validBase,
      state: 'MANUAL_ATTENTION_REQUIRED',
      verdict: 'MANUAL_ATTENTION_REQUIRED',
      rejectionReason: null,
      manualAttentionReason: 'canonical_correlation_missing',
      outcomeKind: null,
      offlineExecutionId: EXEC_ID_HEX,
      consumedAtMillis: NOW,
      terminalizedAtMillis: null,
      completedAtMillis: NOW,
      completingRelayCallerStaffId: 'relay-1',
    };
  }

  test('a near-valid record for every state parses successfully', () => {
    for (const state of OFFLINE_ADJUDICATION_RECORD_STATES) {
      expect(parseOfflineAdjudicationRecord(validFor(state)), state).not.toBeNull();
    }
  });

  test('wrong verdict for state is unreadable', () => {
    expect(parseOfflineAdjudicationRecord({ ...validFor('TERMINALLY_REJECTED'), verdict: 'ACCEPTED' })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), verdict: 'REJECTED' })).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('CONSUMED_PENDING_EXECUTION'), verdict: 'ACCEPTED' }),
    ).toBeNull();
  });

  test('wrong reason family for state is unreadable', () => {
    // A manual-attention reason is not a member of the closed rejection enum.
    expect(
      parseOfflineAdjudicationRecord({
        ...validFor('TERMINALLY_REJECTED'),
        rejectionReason: 'canonical_correlation_missing',
      }),
    ).toBeNull();
  });

  test('a missing required field for state is unreadable', () => {
    expect(parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), outcomeKind: null })).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('CONSUMED_PENDING_EXECUTION'), offlineExecutionId: null }),
    ).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('MANUAL_ATTENTION_REQUIRED'), manualAttentionReason: null }),
    ).toBeNull();
  });

  test('a populated field that must be null for the state is unreadable', () => {
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('TERMINALLY_REJECTED'), offlineExecutionId: 'exec-1' }),
    ).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), rejectionReason: 'device_not_active' }),
    ).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('CONSUMED_PENDING_EXECUTION'), outcomeKind: 'NOOP' }),
    ).toBeNull();
  });

  test('an unknown enum member is unreadable', () => {
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('TERMINALLY_REJECTED'), rejectionReason: 'not_a_real_reason' }),
    ).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), outcomeKind: 'NOT_A_REAL_KIND' }),
    ).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...validFor('TERMINALLY_REJECTED'), state: 'WHO_KNOWS' })).toBeNull();
  });

  test('an invalid or non-finite persisted timestamp is unreadable', () => {
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('TERMINALLY_REJECTED'), terminalizedAtMillis: Number.NaN }),
    ).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), completedAtMillis: Number.POSITIVE_INFINITY }),
    ).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), completedAtMillis: '123' as never }),
    ).toBeNull();
  });

  test('a missing required persisted terminal/completion timestamp is unreadable — PE-RM-NORM-03', () => {
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('TERMINALLY_REJECTED'), terminalizedAtMillis: null }),
    ).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), completedAtMillis: null })).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('MANUAL_ATTENTION_REQUIRED'), completedAtMillis: null }),
    ).toBeNull();
  });

  test('every one of the 29 keys is required — deleting any single key is unreadable', () => {
    for (const state of OFFLINE_ADJUDICATION_RECORD_STATES) {
      const record = validFor(state) as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const mutated = { ...record };
        delete mutated[key];
        expect(parseOfflineAdjudicationRecord(mutated), `${state}/${key}`).toBeNull();
      }
    }
  });

  test('an unknown/extraneous key is rejected for every state', () => {
    for (const state of OFFLINE_ADJUDICATION_RECORD_STATES) {
      expect(parseOfflineAdjudicationRecord({ ...validFor(state), extraneousKey: 'x' }), state).toBeNull();
    }
  });

  test('adjudicationId must be exactly 32 lowercase hex and non-zero', () => {
    const valid = validFor('COMPLETED');
    expect(parseOfflineAdjudicationRecord({ ...valid, adjudicationId: '0'.repeat(32) })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...valid, adjudicationId: 'A'.repeat(32) })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...valid, adjudicationId: 'g'.repeat(32) })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...valid, adjudicationId: 'a'.repeat(31) })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...valid, adjudicationId: 'a'.repeat(33) })).toBeNull();
  });

  test('attestationDigest must be exactly 64 lowercase hex', () => {
    const valid = validFor('COMPLETED');
    expect(parseOfflineAdjudicationRecord({ ...valid, attestationDigest: 'A'.repeat(64) })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...valid, attestationDigest: 'a'.repeat(63) })).toBeNull();
  });

  test('securityDeviceIdHex must be exactly 32 lowercase hex', () => {
    const valid = validFor('COMPLETED');
    expect(parseOfflineAdjudicationRecord({ ...valid, securityDeviceIdHex: 'A'.repeat(32) })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...valid, securityDeviceIdHex: DEVICE_HEX.slice(0, 31) })).toBeNull();
  });

  test('offlineExecutionId must be exactly 40 lowercase hex for every consumed-derived state', () => {
    for (const state of ['CONSUMED_PENDING_EXECUTION', 'COMPLETED', 'MANUAL_ATTENTION_REQUIRED'] as const) {
      const valid = validFor(state);
      expect(parseOfflineAdjudicationRecord({ ...valid, offlineExecutionId: 'A'.repeat(40) }), state).toBeNull();
      expect(
        parseOfflineAdjudicationRecord({ ...valid, offlineExecutionId: EXEC_ID_HEX.slice(0, 39) }),
        state,
      ).toBeNull();
    }
  });

  test.each(['targetOrderId', 'branchId', 'initiatingStaffId', 'approvingManagerStaffId', 'oacId', 'ssa1Id'] as const)(
    'canonical identifier field %s rejects empty, punctuation/spaces, and over-length values',
    (field) => {
      const valid = validFor('COMPLETED');
      expect(parseOfflineAdjudicationRecord({ ...valid, [field]: '' })).toBeNull();
      expect(parseOfflineAdjudicationRecord({ ...valid, [field]: 'has space' })).toBeNull();
      expect(parseOfflineAdjudicationRecord({ ...valid, [field]: 'punct!' })).toBeNull();
      expect(parseOfflineAdjudicationRecord({ ...valid, [field]: 'a'.repeat(1501) })).toBeNull();
    },
  );

  test('branchId literal ALL is rejected even though it is grammatically canonical', () => {
    expect(parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), branchId: 'ALL' })).toBeNull();
  });

  test('self-approval (approvingManagerStaffId === initiatingStaffId) is rejected', () => {
    const valid = validFor('COMPLETED');
    expect(
      parseOfflineAdjudicationRecord({ ...valid, approvingManagerStaffId: valid.initiatingStaffId }),
    ).toBeNull();
  });

  test('actionId is restricted to the closed privileged-action set', () => {
    expect(parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), actionId: 'DELETE_EVERYTHING' })).toBeNull();
  });

  test('audience must be exactly the privileged-void audience literal', () => {
    expect(
      parseOfflineAdjudicationRecord({ ...validFor('COMPLETED'), audience: 'resolveShiftCloseAlert' }),
    ).toBeNull();
  });

  test('deviceKeyVersion must be a positive u32', () => {
    const valid = validFor('COMPLETED');
    for (const bad of [0, -1, 1.5, 0x100000000, Number.NaN]) {
      expect(parseOfflineAdjudicationRecord({ ...valid, deviceKeyVersion: bad }), String(bad)).toBeNull();
    }
    expect(parseOfflineAdjudicationRecord({ ...valid, deviceKeyVersion: 0xffffffff })).not.toBeNull();
  });

  test.each(['trustedApprovalLowerMs', 'serverPendingExpiryMs', 'firstSeenAtMillis'] as const)(
    '%s rejects NaN, infinity, fractional, negative, zero, and values beyond MAX_SAFE_INTEGER',
    (field) => {
      const valid = validFor('COMPLETED');
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 0, Number.MAX_SAFE_INTEGER + 2]) {
        expect(parseOfflineAdjudicationRecord({ ...valid, [field]: bad }), `${field}=${bad}`).toBeNull();
      }
    },
  );

  test('trustedApprovalUpperMs must be a positive safe integer >= trustedApprovalLowerMs', () => {
    const valid = validFor('COMPLETED');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 0, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseOfflineAdjudicationRecord({ ...valid, trustedApprovalUpperMs: bad }), String(bad)).toBeNull();
    }
    expect(
      parseOfflineAdjudicationRecord({
        ...valid,
        trustedApprovalUpperMs: (valid.trustedApprovalLowerMs as number) - 1,
      }),
    ).toBeNull();
    expect(
      parseOfflineAdjudicationRecord({ ...valid, trustedApprovalUpperMs: valid.trustedApprovalLowerMs }),
    ).not.toBeNull();
  });

  test('serverPendingExpiryMs must strictly exceed trustedApprovalLowerMs', () => {
    const valid = validFor('COMPLETED');
    expect(
      parseOfflineAdjudicationRecord({ ...valid, serverPendingExpiryMs: valid.trustedApprovalLowerMs }),
    ).toBeNull();
  });

  test('lifecycle timestamps (when non-null) reject fractional, negative, zero, and unsafe-integer values', () => {
    const rejected = validFor('TERMINALLY_REJECTED');
    for (const bad of [1.5, -1, 0, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseOfflineAdjudicationRecord({ ...rejected, terminalizedAtMillis: bad }), String(bad)).toBeNull();
    }
    const completed = validFor('COMPLETED');
    for (const bad of [1.5, -1, 0, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseOfflineAdjudicationRecord({ ...completed, completedAtMillis: bad }), String(bad)).toBeNull();
    }
    const consumed = validFor('CONSUMED_PENDING_EXECUTION');
    for (const bad of [1.5, -1, 0, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseOfflineAdjudicationRecord({ ...consumed, consumedAtMillis: bad }), String(bad)).toBeNull();
    }
  });

  // IR-002 — exhaustive nullability, exactly per Codex Exact Evidence
  // Prescription 005 §3. Every one of the 29 fields is covered, in every
  // state, as either required-non-null or required-null.
  const COMMON_REQUIRED_NON_NULL = [
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
    'firstSeenAtMillis',
    'firstRelayCallerStaffId',
  ] as const;

  const REQUIRED_NON_NULL_BY_STATE = {
    TERMINALLY_REJECTED: [...COMMON_REQUIRED_NON_NULL, 'verdict', 'rejectionReason', 'terminalizedAtMillis'],
    CONSUMED_PENDING_EXECUTION: [...COMMON_REQUIRED_NON_NULL, 'offlineExecutionId', 'consumedAtMillis'],
    COMPLETED: [
      ...COMMON_REQUIRED_NON_NULL,
      'offlineExecutionId',
      'verdict',
      'outcomeKind',
      'consumedAtMillis',
      'completedAtMillis',
      'completingRelayCallerStaffId',
    ],
    MANUAL_ATTENTION_REQUIRED: [
      ...COMMON_REQUIRED_NON_NULL,
      'offlineExecutionId',
      'verdict',
      'manualAttentionReason',
      'consumedAtMillis',
      'completedAtMillis',
      'completingRelayCallerStaffId',
    ],
  } as const;

  test('every required-non-null field is explicitly non-null for every durable state', () => {
    for (const [state, fields] of Object.entries(REQUIRED_NON_NULL_BY_STATE)) {
      const base = validFor(state as (typeof OFFLINE_ADJUDICATION_RECORD_STATES)[number]);
      for (const field of fields) {
        expect(parseOfflineAdjudicationRecord({ ...base, [field]: null }), `${state}/${field}`).toBeNull();
      }
    }
  });

  const REQUIRED_NULL_POPULATION_BY_STATE = {
    TERMINALLY_REJECTED: [
      ['offlineExecutionId', EXEC_ID_HEX],
      ['manualAttentionReason', 'canonical_correlation_missing'],
      ['outcomeKind', 'VOID_APPLIED'],
      ['consumedAtMillis', NOW],
      ['completedAtMillis', NOW],
      ['completingRelayCallerStaffId', 'relay-1'],
    ],
    CONSUMED_PENDING_EXECUTION: [
      ['verdict', 'ACCEPTED'],
      ['rejectionReason', 'device_not_active'],
      ['manualAttentionReason', 'canonical_correlation_missing'],
      ['outcomeKind', 'VOID_APPLIED'],
      ['terminalizedAtMillis', NOW],
      ['completedAtMillis', NOW],
      ['completingRelayCallerStaffId', 'relay-1'],
    ],
    COMPLETED: [
      ['rejectionReason', 'device_not_active'],
      ['manualAttentionReason', 'canonical_correlation_missing'],
      ['terminalizedAtMillis', NOW],
    ],
    MANUAL_ATTENTION_REQUIRED: [
      ['rejectionReason', 'device_not_active'],
      ['outcomeKind', 'VOID_APPLIED'],
      ['terminalizedAtMillis', NOW],
    ],
  } as const;

  test('every required-null field is explicitly null for every durable state', () => {
    for (const [state, flips] of Object.entries(REQUIRED_NULL_POPULATION_BY_STATE)) {
      const base = validFor(state as (typeof OFFLINE_ADJUDICATION_RECORD_STATES)[number]);
      for (const [field, value] of flips) {
        expect(parseOfflineAdjudicationRecord({ ...base, [field]: value }), `${state}/${field}`).toBeNull();
      }
    }
  });

  // IR-002 — closed-vocabulary parser cases, exactly per Prescription 005 §4.
  test('unknown manual-attention reason is unreadable', () => {
    expect(
      parseOfflineAdjudicationRecord({
        ...validFor('MANUAL_ATTENTION_REQUIRED'),
        manualAttentionReason: 'not_a_real_manual_attention_reason',
      }),
    ).toBeNull();
  });

  test('unknown verdict is unreadable in every terminal state', () => {
    for (const state of ['TERMINALLY_REJECTED', 'COMPLETED', 'MANUAL_ATTENTION_REQUIRED'] as const) {
      expect(parseOfflineAdjudicationRecord({ ...validFor(state), verdict: 'NOT_A_REAL_VERDICT' }), state).toBeNull();
    }
  });

  test('null terminal verdict is unreadable in every terminal state', () => {
    for (const state of ['TERMINALLY_REJECTED', 'COMPLETED', 'MANUAL_ATTENTION_REQUIRED'] as const) {
      expect(parseOfflineAdjudicationRecord({ ...validFor(state), verdict: null }), state).toBeNull();
    }
  });

  test('state-incompatible known verdict values are unreadable', () => {
    const rows: ReadonlyArray<readonly [(typeof OFFLINE_ADJUDICATION_RECORD_STATES)[number], string]> = [
      ['TERMINALLY_REJECTED', 'ACCEPTED'],
      ['TERMINALLY_REJECTED', 'MANUAL_ATTENTION_REQUIRED'],
      ['CONSUMED_PENDING_EXECUTION', 'ACCEPTED'],
      ['CONSUMED_PENDING_EXECUTION', 'REJECTED'],
      ['CONSUMED_PENDING_EXECUTION', 'MANUAL_ATTENTION_REQUIRED'],
      ['COMPLETED', 'REJECTED'],
      ['COMPLETED', 'MANUAL_ATTENTION_REQUIRED'],
      ['MANUAL_ATTENTION_REQUIRED', 'ACCEPTED'],
      ['MANUAL_ATTENTION_REQUIRED', 'REJECTED'],
    ];
    for (const [state, verdict] of rows) {
      expect(parseOfflineAdjudicationRecord({ ...validFor(state), verdict }), `${state}/${verdict}`).toBeNull();
    }
  });

  test('TERMINALLY_REJECTED requires terminalizedAtMillis === firstSeenAtMillis', () => {
    const base = validFor('TERMINALLY_REJECTED');
    expect(
      parseOfflineAdjudicationRecord({ ...base, terminalizedAtMillis: (base.firstSeenAtMillis as number) + 1 }),
    ).toBeNull();
  });

  test('CONSUMED_PENDING_EXECUTION and every derived state require consumedAtMillis === firstSeenAtMillis', () => {
    for (const state of ['CONSUMED_PENDING_EXECUTION', 'COMPLETED', 'MANUAL_ATTENTION_REQUIRED'] as const) {
      const base = validFor(state);
      expect(
        parseOfflineAdjudicationRecord({ ...base, consumedAtMillis: (base.firstSeenAtMillis as number) + 1 }),
        state,
      ).toBeNull();
    }
  });

  test('COMPLETED and MANUAL_ATTENTION_REQUIRED require completedAtMillis >= consumedAtMillis', () => {
    for (const state of ['COMPLETED', 'MANUAL_ATTENTION_REQUIRED'] as const) {
      const base = validFor(state);
      expect(
        parseOfflineAdjudicationRecord({ ...base, completedAtMillis: (base.consumedAtMillis as number) - 1 }),
        state,
      ).toBeNull();
      expect(
        parseOfflineAdjudicationRecord({ ...base, completedAtMillis: base.consumedAtMillis }),
        state,
      ).not.toBeNull();
    }
  });

  test('firstRelayCallerStaffId and completingRelayCallerStaffId must be canonical identifiers', () => {
    const consumed = validFor('CONSUMED_PENDING_EXECUTION');
    expect(parseOfflineAdjudicationRecord({ ...consumed, firstRelayCallerStaffId: '' })).toBeNull();
    expect(parseOfflineAdjudicationRecord({ ...consumed, firstRelayCallerStaffId: 'bad id' })).toBeNull();
    const completed = validFor('COMPLETED');
    expect(parseOfflineAdjudicationRecord({ ...completed, completingRelayCallerStaffId: 'bad id' })).toBeNull();
  });
});

describe('IR-002 — exact 51-case callable corruption matrix', () => {
  // Codex Exact Evidence Prescription 005 §2 — one explicit per-state table,
  // 12 + 13 + 13 + 13 = 51 independently named callable cases. A generic
  // `actionId` mutation never substitutes for the state-specific
  // reason/outcome/verdict evidence a row below asserts.
  type CorruptionRow = { label: string; mutate: (base: Doc) => Doc };

  const TERMINALLY_REJECTED_ROWS: readonly CorruptionRow[] = [
    { label: 'unknown/extraneous key', mutate: (base) => ({ ...base, extraneousKey: 'x' }) },
    { label: 'bad canonical identifier grammar', mutate: (base) => ({ ...base, targetOrderId: 'order 1' }) },
    { label: 'invalid width/range', mutate: (base) => ({ ...base, adjudicationId: 'a'.repeat(31) }) },
    {
      label: 'unknown rejection reason',
      mutate: (base) => ({ ...base, rejectionReason: 'not_a_real_rejection_reason' }),
    },
    { label: 'unknown verdict', mutate: (base) => ({ ...base, verdict: 'NOT_A_REAL_VERDICT' }) },
    { label: 'null required verdict', mutate: (base) => ({ ...base, verdict: null }) },
    { label: 'state-incompatible known verdict', mutate: (base) => ({ ...base, verdict: 'ACCEPTED' }) },
    {
      label: 'wrong state/value combination — populated execution id',
      mutate: (base) => ({ ...base, offlineExecutionId: EXEC_ID_HEX }),
    },
    {
      label: 'missing required lifecycle field',
      mutate: (base) => {
        const corrupted = { ...base };
        delete corrupted.firstSeenAtMillis;
        return corrupted;
      },
    },
    { label: 'forbidden populated lifecycle field', mutate: (base) => ({ ...base, consumedAtMillis: NOW }) },
    { label: 'unsafe/non-safe timestamp', mutate: (base) => ({ ...base, terminalizedAtMillis: Number.NaN }) },
    {
      label: 'broken time/lifecycle relationship',
      mutate: (base) => ({ ...base, terminalizedAtMillis: (base.firstSeenAtMillis as number) + 1 }),
    },
  ];

  const CONSUMED_PENDING_EXECUTION_ROWS: readonly CorruptionRow[] = [
    { label: 'unknown/extraneous key', mutate: (base) => ({ ...base, extraneousKey: 'x' }) },
    { label: 'bad canonical identifier grammar', mutate: (base) => ({ ...base, targetOrderId: 'order 1' }) },
    { label: 'invalid width/range', mutate: (base) => ({ ...base, attestationDigest: 'A'.repeat(64) }) },
    { label: 'unknown verdict', mutate: (base) => ({ ...base, verdict: 'NOT_A_REAL_VERDICT' }) },
    {
      label: 'wrong state/value combination — populated verdict',
      mutate: (base) => ({ ...base, verdict: 'ACCEPTED' }),
    },
    {
      label: 'wrong state/value combination — populated rejection reason',
      mutate: (base) => ({ ...base, rejectionReason: 'device_not_active' }),
    },
    {
      label: 'wrong state/value combination — populated manual reason',
      mutate: (base) => ({ ...base, manualAttentionReason: 'canonical_correlation_missing' }),
    },
    {
      label: 'wrong state/value combination — populated outcome',
      mutate: (base) => ({ ...base, outcomeKind: 'VOID_APPLIED' }),
    },
    { label: 'missing required lifecycle field', mutate: (base) => ({ ...base, consumedAtMillis: null }) },
    {
      label: 'forbidden populated lifecycle field',
      mutate: (base) => ({ ...base, completingRelayCallerStaffId: 'relay-1' }),
    },
    {
      label: 'unsafe/non-safe timestamp',
      mutate: (base) => ({ ...base, consumedAtMillis: Number.MAX_SAFE_INTEGER + 1 }),
    },
    {
      label: 'broken time/lifecycle relationship',
      mutate: (base) => ({ ...base, consumedAtMillis: (base.firstSeenAtMillis as number) + 1 }),
    },
    {
      label: 'invalid execution-id grammar',
      mutate: (base) => ({ ...base, offlineExecutionId: EXEC_ID_HEX.slice(0, 39) }),
    },
  ];

  const COMPLETED_ROWS: readonly CorruptionRow[] = [
    { label: 'unknown/extraneous key', mutate: (base) => ({ ...base, extraneousKey: 'x' }) },
    { label: 'bad canonical identifier grammar', mutate: (base) => ({ ...base, targetOrderId: 'order 1' }) },
    {
      label: 'invalid width/range',
      mutate: (base) => ({ ...base, securityDeviceIdHex: DEVICE_HEX.slice(0, 31) }),
    },
    { label: 'unknown outcome kind', mutate: (base) => ({ ...base, outcomeKind: 'NOT_A_REAL_OUTCOME' }) },
    { label: 'unknown verdict', mutate: (base) => ({ ...base, verdict: 'NOT_A_REAL_VERDICT' }) },
    { label: 'null required verdict', mutate: (base) => ({ ...base, verdict: null }) },
    { label: 'state-incompatible known verdict', mutate: (base) => ({ ...base, verdict: 'REJECTED' }) },
    {
      label: 'wrong state/value combination — populated rejection reason',
      mutate: (base) => ({ ...base, rejectionReason: 'device_not_active' }),
    },
    {
      label: 'missing required lifecycle field',
      mutate: (base) => ({ ...base, completingRelayCallerStaffId: null }),
    },
    { label: 'forbidden populated lifecycle field', mutate: (base) => ({ ...base, terminalizedAtMillis: NOW }) },
    { label: 'unsafe/non-safe timestamp', mutate: (base) => ({ ...base, completedAtMillis: 1.5 }) },
    {
      label: 'broken time/lifecycle relationship',
      mutate: (base) => ({ ...base, completedAtMillis: (base.consumedAtMillis as number) - 1 }),
    },
    {
      label: 'invalid execution-id grammar',
      mutate: (base) => ({ ...base, offlineExecutionId: EXEC_ID_HEX.toUpperCase() }),
    },
  ];

  const MANUAL_ATTENTION_REQUIRED_ROWS: readonly CorruptionRow[] = [
    { label: 'unknown/extraneous key', mutate: (base) => ({ ...base, extraneousKey: 'x' }) },
    { label: 'bad canonical identifier grammar', mutate: (base) => ({ ...base, targetOrderId: 'order 1' }) },
    { label: 'invalid width/range', mutate: (base) => ({ ...base, deviceKeyVersion: 0x1_0000_0000 }) },
    {
      label: 'unknown manual-attention reason',
      mutate: (base) => ({ ...base, manualAttentionReason: 'not_a_real_manual_attention_reason' }),
    },
    { label: 'unknown verdict', mutate: (base) => ({ ...base, verdict: 'NOT_A_REAL_VERDICT' }) },
    { label: 'null required verdict', mutate: (base) => ({ ...base, verdict: null }) },
    { label: 'state-incompatible known verdict', mutate: (base) => ({ ...base, verdict: 'ACCEPTED' }) },
    {
      label: 'wrong state/value combination — forbidden outcome kind',
      mutate: (base) => ({ ...base, outcomeKind: 'VOID_APPLIED' }),
    },
    { label: 'missing required lifecycle field', mutate: (base) => ({ ...base, completedAtMillis: null }) },
    { label: 'forbidden populated lifecycle field', mutate: (base) => ({ ...base, terminalizedAtMillis: NOW }) },
    {
      label: 'unsafe/non-safe timestamp',
      mutate: (base) => ({ ...base, completedAtMillis: Number.POSITIVE_INFINITY }),
    },
    {
      label: 'broken time/lifecycle relationship',
      mutate: (base) => ({ ...base, completedAtMillis: (base.consumedAtMillis as number) - 1 }),
    },
    { label: 'invalid execution-id grammar', mutate: (base) => ({ ...base, offlineExecutionId: 'z'.repeat(40) }) },
  ];

  const ROWS_BY_STATE: Record<(typeof OFFLINE_ADJUDICATION_RECORD_STATES)[number], readonly CorruptionRow[]> = {
    TERMINALLY_REJECTED: TERMINALLY_REJECTED_ROWS,
    CONSUMED_PENDING_EXECUTION: CONSUMED_PENDING_EXECUTION_ROWS,
    COMPLETED: COMPLETED_ROWS,
    MANUAL_ATTENTION_REQUIRED: MANUAL_ATTENTION_REQUIRED_ROWS,
  };

  test('the matrix contains exactly 51 rows: 12 rejected, 13 consumed, 13 completed, 13 manual-attention', () => {
    expect(TERMINALLY_REJECTED_ROWS).toHaveLength(12);
    expect(CONSUMED_PENDING_EXECUTION_ROWS).toHaveLength(13);
    expect(COMPLETED_ROWS).toHaveLength(13);
    expect(MANUAL_ATTENTION_REQUIRED_ROWS).toHaveLength(13);
    const total =
      TERMINALLY_REJECTED_ROWS.length +
      CONSUMED_PENDING_EXECUTION_ROWS.length +
      COMPLETED_ROWS.length +
      MANUAL_ATTENTION_REQUIRED_ROWS.length;
    expect(total).toBe(51);
  });

  for (const state of OFFLINE_ADJUDICATION_RECORD_STATES) {
    for (const row of ROWS_BY_STATE[state]) {
      test(`${state}: ${row.label} is unreadable before device/Class-B/canonical execution`, async () => {
        const paa1 = buildPaa1();
        const db = makeDb();
        const adjudicationPath = `privilegedOfflineAdjudications/${paa1.adjudicationId}`;

        const corrupted = row.mutate(buildDurableRecordFor(paa1, state));
        const before = structuredClone(corrupted);
        db.store.set(adjudicationPath, corrupted);
        db.resetSpies();
        const executeCanonicalVoid = vi.fn(async () => voidApplied);

        const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

        expectUnreadableEarlyBoundary(db, adjudicationPath, before, res, executeCanonicalVoid);
      });
    }
  }
});

describe('IR-002/IR-007 — 12 malformed persisted terminal timestamp rows are unreadable at Stage R', () => {
  // Codex Exact Evidence Prescription 005 §6 — exactly these 12 independently
  // labeled rows, each proving the malformed record never reaches
  // `responseForTerminalRecord`, the device registry, Class-B state, or the
  // canonical executor.
  const ROWS: ReadonlyArray<{
    state: (typeof OFFLINE_ADJUDICATION_RECORD_STATES)[number];
    field: 'terminalizedAtMillis' | 'completedAtMillis';
    label: string;
    value: (base: Doc) => unknown;
  }> = [
    { state: 'TERMINALLY_REJECTED', field: 'terminalizedAtMillis', label: 'null', value: () => null },
    { state: 'TERMINALLY_REJECTED', field: 'terminalizedAtMillis', label: 'NaN', value: () => Number.NaN },
    { state: 'TERMINALLY_REJECTED', field: 'terminalizedAtMillis', label: '1.5', value: () => 1.5 },
    {
      state: 'TERMINALLY_REJECTED',
      field: 'terminalizedAtMillis',
      label: 'firstSeenAtMillis + 1',
      value: (base) => (base.firstSeenAtMillis as number) + 1,
    },
    { state: 'COMPLETED', field: 'completedAtMillis', label: 'null', value: () => null },
    {
      state: 'COMPLETED',
      field: 'completedAtMillis',
      label: 'POSITIVE_INFINITY',
      value: () => Number.POSITIVE_INFINITY,
    },
    {
      state: 'COMPLETED',
      field: 'completedAtMillis',
      label: 'MAX_SAFE_INTEGER + 1',
      value: () => Number.MAX_SAFE_INTEGER + 1,
    },
    {
      state: 'COMPLETED',
      field: 'completedAtMillis',
      label: 'consumedAtMillis - 1',
      value: (base) => (base.consumedAtMillis as number) - 1,
    },
    { state: 'MANUAL_ATTENTION_REQUIRED', field: 'completedAtMillis', label: 'null', value: () => null },
    {
      state: 'MANUAL_ATTENTION_REQUIRED',
      field: 'completedAtMillis',
      label: 'POSITIVE_INFINITY',
      value: () => Number.POSITIVE_INFINITY,
    },
    {
      state: 'MANUAL_ATTENTION_REQUIRED',
      field: 'completedAtMillis',
      label: 'MAX_SAFE_INTEGER + 1',
      value: () => Number.MAX_SAFE_INTEGER + 1,
    },
    {
      state: 'MANUAL_ATTENTION_REQUIRED',
      field: 'completedAtMillis',
      label: 'consumedAtMillis - 1',
      value: (base) => (base.consumedAtMillis as number) - 1,
    },
  ];

  test('the row set contains exactly 12 independently labeled cases', () => {
    expect(ROWS).toHaveLength(12);
  });

  for (const row of ROWS) {
    test(`missing invalid unsafe or inconsistent persisted terminal timestamps are unreadable at Stage R — ${row.state}/${row.field}=${row.label}`, async () => {
      const paa1 = buildPaa1();
      const base = buildDurableRecordFor(paa1, row.state);
      const adjudicationPath = `privilegedOfflineAdjudications/${paa1.adjudicationId}`;
      const corrupted = { ...base, [row.field]: row.value(base) };

      // Persistent Stage-R parser evidence for the exact fixture.
      expect(parseOfflineAdjudicationRecord(corrupted)).toBeNull();

      const before = structuredClone(corrupted);
      const db = makeDb();
      db.store.set(adjudicationPath, corrupted);
      db.resetSpies();
      const executeCanonicalVoid = vi.fn(async () => voidApplied);

      const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

      expectUnreadableEarlyBoundary(db, adjudicationPath, before, res, executeCanonicalVoid);
    });
  }
});

describe('IR-003 — transactionally guarded Phase-C terminalization', () => {
  test('the adjudication record deleted before the terminalizing transaction re-read is an unreadable anomaly, no write', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async (_d, orderRef, options) => {
        await orderRef.set(
          { status: 'voided', voidReconciled: true, privilegedVoidExecutionId: options?.privilegedVoidExecutionId },
          { merge: true },
        );
        // Simulates the record vanishing in the window between dispatch and
        // the terminalizing transaction's own re-read.
        db.store.delete(`privilegedOfflineAdjudications/${paa1.adjudicationId}`);
        return voidApplied;
      },
    });
    expect(res).toMatchObject({ kind: 'ADJUDICATION_ANOMALY', anomalyReason: 'adjudication_record_unreadable' });
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)).toBeUndefined();
  });

  test('the adjudication record replaced with a different binding before the terminalizing transaction re-read is a binding-conflict anomaly, no overwrite', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async (_d, orderRef, options) => {
        await orderRef.set(
          { status: 'voided', voidReconciled: true, privilegedVoidExecutionId: options?.privilegedVoidExecutionId },
          { merge: true },
        );
        const path = `privilegedOfflineAdjudications/${paa1.adjudicationId}`;
        const current = db.store.get(path)!;
        // Same adjudicationId, but a different immutable binding field.
        db.store.set(path, { ...current, targetOrderId: 'order-999' });
        return voidApplied;
      },
    });
    expect(res).toMatchObject({
      kind: 'ADJUDICATION_ANOMALY',
      anomalyReason: 'adjudication_record_binding_conflict',
    });
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.targetOrderId).toBe('order-999');
  });
});

describe('IR-004 — atomic actor/OAC binding, crash-after-canonical-commit', () => {
  test('OAC correlation is written atomically with the canonical effect', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    await run(db, paa1.request);
    expect(db.store.get('asyncOrders/order-1')!.privilegedVoidOacId).toBe('oac-1');
    expect(db.store.get('asyncOrders/order-1')!.voidedBy).toBe('staff-1');
  });

  test('a crash immediately after the canonical commit leaves correct attribution and needs no repair write on resume', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const first = await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async (_d, orderRef, options) => {
        await orderRef.set(
          {
            status: 'voided',
            voidReconciled: true,
            privilegedVoidExecutionId: options?.privilegedVoidExecutionId,
            privilegedVoidOacId: options?.oacId,
            ...(options?.authoritativeActorStaffId != null ? { voidedBy: options.authoritativeActorStaffId } : {}),
          },
          { merge: true },
        );
        // Crash after the canonical effect commits, before Phase C terminalizes.
        throw new Error('crash-after-canonical-commit');
      },
    });
    expect(first).toMatchObject({ family: 'ADJUDICATION', kind: 'RETRYABLE' });
    // The canonical/async attribution is already correct before any resume.
    expect(db.store.get('asyncOrders/order-1')!.voidedBy).toBe('staff-1');
    expect(db.store.get('asyncOrders/order-1')!.privilegedVoidOacId).toBe('oac-1');
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe(
      'CONSUMED_PENDING_EXECUTION',
    );

    db.resetSpies();
    const resumed = await run(db, paa1.request);
    expect(resumed).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'NOOP' });
    // No repair write to the order is needed or performed on resume.
    expect(db.writesIn('asyncOrders')).toHaveLength(0);
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe('COMPLETED');
  });
});

describe('IR-005 — exclusive pending-execution expiry', () => {
  test('nowMillis exactly at the server pending expiry is expired (exclusive end)', async () => {
    const db = makeDb();
    const res = await run(db, buildPaa1().request, relayAuth(), { nowMillis: DAY_END });
    expect(res).toMatchObject({ kind: 'REJECTED', rejectionReason: 'pending_execution_expired_day_boundary' });
  });

  test('nowMillis one millisecond before the server pending expiry is still eligible', async () => {
    const db = makeDb();
    const res = await run(db, buildPaa1().request, relayAuth(), { nowMillis: DAY_END - 1 });
    expect(res).toMatchObject({ kind: 'ACCEPTED' });
  });
});

describe('IR-007 — durable replay stability at a different server clock', () => {
  const LATER = NOW + 999_000;
  const EARLIER = NOW - 999_000;

  test('TERMINALLY_REJECTED created at t1 replays identically at t2 and t0 except idempotent', async () => {
    const db = makeDb();
    db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, {
      status: 'REVOKED',
      deviceKeyVersion: 3,
      branchId: BRANCH,
      validatedDevProofPublicKeyBase64: rawPublicKeyBase64(deviceKey.publicKey),
    });
    const paa1 = buildPaa1();
    const adjudicationPath = `privilegedOfflineAdjudications/${paa1.adjudicationId}`;
    const executeCanonicalVoid = vi.fn(async () => voidApplied);

    const first = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });
    expect(first).toMatchObject({ kind: 'REJECTED', idempotent: false, serverAdjudicatedAtMs: NOW });
    expect(db.store.get(adjudicationPath)!.terminalizedAtMillis).toBe(NOW);

    for (const t of [LATER, EARLIER]) {
      db.resetSpies();
      executeCanonicalVoid.mockClear();
      const replay = await run(db, paa1.request, relayAuth(), { nowMillis: t, executeCanonicalVoid });
      expect(replay, String(t)).toEqual({ ...first, idempotent: true });
      expect(replay, String(t)).toMatchObject({ serverAdjudicatedAtMs: NOW });
      expect(db.writes, String(t)).toHaveLength(0);
      expect(db.readsIn('privilegedDeviceRegistrations'), String(t)).toHaveLength(0);
      expect(db.readsIn('asyncOrders'), String(t)).toHaveLength(0);
      expectNoFreshClassBReads(db, String(t));
      expect(executeCanonicalVoid, String(t)).not.toHaveBeenCalled();
    }
  });

  test('COMPLETED created at t1 replays identically at t2 and t0 except idempotent', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const adjudicationPath = `privilegedOfflineAdjudications/${paa1.adjudicationId}`;
    // The same canonical correlated order update as the default executor, so
    // the first call reaches COMPLETED.
    const executeCanonicalVoid = vi.fn(
      async (
        _d: any,
        orderRef: any,
        options?: { privilegedVoidExecutionId?: string; oacId?: string; authoritativeActorStaffId?: string },
      ) => {
        await orderRef.set(
          {
            status: 'voided',
            voidReconciled: true,
            privilegedVoidExecutionId: options?.privilegedVoidExecutionId,
            privilegedVoidOacId: options?.oacId,
            ...(options?.authoritativeActorStaffId != null ? { voidedBy: options.authoritativeActorStaffId } : {}),
          },
          { merge: true },
        );
        return voidApplied;
      },
    );

    const first = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });
    expect(first).toMatchObject({ kind: 'ACCEPTED', idempotent: false, serverAdjudicatedAtMs: NOW });
    expect(db.store.get(adjudicationPath)!.completedAtMillis).toBe(NOW);

    for (const t of [LATER, EARLIER]) {
      db.resetSpies();
      executeCanonicalVoid.mockClear();
      const replay = await run(db, paa1.request, relayAuth(), { nowMillis: t, executeCanonicalVoid });
      expect(replay, String(t)).toEqual({ ...first, idempotent: true });
      expect(replay, String(t)).toMatchObject({ serverAdjudicatedAtMs: NOW });
      expect(db.writes, String(t)).toHaveLength(0);
      expect(db.readsIn('privilegedDeviceRegistrations'), String(t)).toHaveLength(0);
      expect(db.readsIn('asyncOrders'), String(t)).toHaveLength(0);
      expectNoFreshClassBReads(db, String(t));
      expect(executeCanonicalVoid, String(t)).not.toHaveBeenCalled();
    }
  });

  test('MANUAL_ATTENTION_REQUIRED created at t1 replays identically at t2 and t0 except idempotent', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const adjudicationPath = `privilegedOfflineAdjudications/${paa1.adjudicationId}`;
    // Deliberate mismatching execution-id write — the canonical effect lands
    // under a different execution than this attempt, forcing MANUAL_ATTENTION_REQUIRED.
    const executeCanonicalVoid = vi.fn(async (_d: any, orderRef: any) => {
      await orderRef.set(
        { status: 'voided', voidReconciled: true, privilegedVoidExecutionId: 'someone-else' },
        { merge: true },
      );
      return voidApplied;
    });

    const first = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });
    expect(first).toMatchObject({
      kind: 'MANUAL_ATTENTION_REQUIRED',
      idempotent: false,
      serverAdjudicatedAtMs: NOW,
    });
    expect(db.store.get(adjudicationPath)!.completedAtMillis).toBe(NOW);

    for (const t of [LATER, EARLIER]) {
      db.resetSpies();
      executeCanonicalVoid.mockClear();
      const replay = await run(db, paa1.request, relayAuth(), { nowMillis: t, executeCanonicalVoid });
      expect(replay, String(t)).toEqual({ ...first, idempotent: true });
      expect(replay, String(t)).toMatchObject({ serverAdjudicatedAtMs: NOW });
      expect(db.writes, String(t)).toHaveLength(0);
      expect(db.readsIn('privilegedDeviceRegistrations'), String(t)).toHaveLength(0);
      expect(db.readsIn('asyncOrders'), String(t)).toHaveLength(0);
      expectNoFreshClassBReads(db, String(t));
      expect(executeCanonicalVoid, String(t)).not.toHaveBeenCalled();
    }
  });

  test('converse: a fresh (non-replay) call stamps serverAdjudicatedAtMs from its own invocation clock', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const res = await run(db, paa1.request, relayAuth(), { nowMillis: NOW + 12_345 });
    expect(res).toMatchObject({ kind: 'ACCEPTED', idempotent: false, serverAdjudicatedAtMs: NOW + 12_345 });
  });
});

describe('IR-007 — source-level no-fallback regression', () => {
  const src = readFileSync(resolve(__dirname, '../adjudicateOfflinePrivilegedActionCore.ts'), 'utf8');

  function extractFunctionBody(source: string, signaturePrefix: string): string {
    const start = source.indexOf(signaturePrefix);
    if (start === -1) throw new Error(`signature not found: ${signaturePrefix}`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error('unbalanced braces while extracting function body');
  }

  test('responseForTerminalRecord accepts only the terminal record union and invents nothing', () => {
    expect(src).toMatch(/responseForTerminalRecord = \(record: OfflineAdjudicationTerminalRecord\)/);
    expect(src).not.toMatch(/responseForTerminalRecord = \(record: OfflineAdjudicationRecordView\)/);

    const body = extractFunctionBody(
      src,
      'const responseForTerminalRecord = (record: OfflineAdjudicationTerminalRecord)',
    );
    expect(body).not.toMatch(/nowMillis/);
    expect(body).not.toMatch(/\?\?/);
    expect(body).not.toMatch(/target_state_mismatch/);
    expect(body).not.toMatch(/'NOOP'/);
    expect(body).not.toMatch(/canonical_execution_unresolved/);
    expect(body).not.toMatch(/''/);
  });

  test('the full source has no replay-fallback expressions and no dead null-execution-id repair branch', () => {
    expect(src).not.toMatch(/terminalizedAtMillis\s*\?\?\s*nowMillis/);
    expect(src).not.toMatch(/completedAtMillis\s*\?\?\s*nowMillis/);
    expect(src).not.toMatch(/rejectionReason\s*\?\?/);
    expect(src).not.toMatch(/offlineExecutionId\s*\?\?\s*''/);
    expect(src).not.toMatch(/outcomeKind\s*\?\?\s*'NOOP'/);
    expect(src).not.toMatch(/manualAttentionReason\s*\?\?/);
    expect(src).not.toMatch(/executionId\s*==\s*null/);
  });
});

// ── OPTION_A_LINEARIZE — first-consume authority linearization ──────────────
//
// Every case here exercises the same window: preflight has already read live
// authority and passed, and a sentinel then changes before the first-consume
// transaction reads it. `setBeforeFirstTransaction` fires exactly once, on
// entry to the first transaction, which on a Stage-F happy path IS the consume
// transaction (no `terminalize()` runs when preflight passes). Each test
// asserts the hook fired, so a future refactor that inserts an earlier
// transaction fails loudly instead of silently testing nothing.

const MANAGER_CREDENTIAL_SEED: Doc = {
  pinHash: '$2b$10$realhashplaceholderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  algo: 'bcrypt',
  cost: 10,
  credentialVersion: 5,
  credentialState: 'rotated_authoritative',
  disabled: false,
  updatedBy: 't',
};

const activeDeviceSeed = (over: Doc = {}): Doc => ({
  status: 'ACTIVE',
  deviceKeyVersion: 3,
  branchId: BRANCH,
  validatedDevProofPublicKeyBase64: rawPublicKeyBase64(deviceKey.publicKey),
  ...over,
});

/** The canonical void executor, wrapped so a test can prove it never ran. */
function countingVoidExecutor() {
  const calls: unknown[] = [];
  const executeCanonicalVoid: NonNullable<AdjudicateOfflinePrivilegedActionDeps['executeCanonicalVoid']> =
    async (_d, orderRef, options) => {
      calls.push(options);
      await orderRef.set(
        {
          status: 'voided',
          voidReconciled: true,
          privilegedVoidExecutionId: options?.privilegedVoidExecutionId,
          privilegedVoidOacId: options?.oacId,
          ...(options?.authoritativeActorStaffId != null ? { voidedBy: options.authoritativeActorStaffId } : {}),
        },
        { merge: true },
      );
      return voidApplied;
    };
  return { calls, executeCanonicalVoid };
}

describe('OPTION_A_LINEARIZE — authority is re-read inside the first-consume transaction', () => {
  test('PRIMARY — a manager credential rotation landing before first consume is terminally refused', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const { calls, executeCanonicalVoid } = countingVoidExecutor();
    db.setBeforeFirstTransaction(() => {
      db.store.set('userCredentials/manager-1', { ...MANAGER_CREDENTIAL_SEED, credentialVersion: 6 });
    });

    const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

    // The interleaving actually happened, at the first transaction boundary.
    expect(db.beforeTransactionFireCount()).toBe(1);
    // Preflight saw the valid credential; the transaction saw the rotated one.
    // Exactly two reads: F11 preflight, then the transactional re-read.
    expect(db.readsIn('userCredentials')).toEqual([
      'userCredentials/manager-1',
      'userCredentials/manager-1',
    ]);

    expect(res).toMatchObject({
      family: 'ADJUDICATION',
      kind: 'REJECTED',
      rejectionReason: 'manager_credential_version_changed',
      terminal: true,
      idempotent: false,
    });

    // A durable refusal, never a consume.
    const record = db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!;
    expect(record.state).toBe('TERMINALLY_REJECTED');
    expect(record.rejectionReason).toBe('manager_credential_version_changed');
    expect(record.consumedAtMillis).toBeNull();
    expect(record.offlineExecutionId).toBeNull();
    expect(record.terminalizedAtMillis).toBe(NOW);
    expect(parseOfflineAdjudicationRecord(record)).not.toBeNull();
    expect(db.writesIn('privilegedOfflineAdjudications')).toHaveLength(1);

    // The order is untouched and downstream execution never ran.
    expect(db.writesIn('asyncOrders')).toHaveLength(0);
    expect(db.store.get('asyncOrders/order-1')!.status).toBe('settled');
    expect(db.store.get('asyncOrders/order-1')!.privilegedVoidExecutionId).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test.each<[string, (db: ReturnType<typeof makeDb>) => void, string]>([
    [
      'manager deactivated',
      (db) =>
        db.store.set('users/manager-1', {
          isActive: false,
          deletedAt: null,
          authVersion: 9,
          role: 'manager',
          branchIds: [BRANCH],
        }),
      'manager_inactive_or_not_privileged',
    ],
    [
      'manager demoted',
      (db) =>
        db.store.set('users/manager-1', {
          isActive: true,
          deletedAt: null,
          authVersion: 9,
          role: 'staff',
          branchIds: [BRANCH],
        }),
      'manager_inactive_or_not_privileged',
    ],
    [
      'manager branch moved',
      (db) =>
        db.store.set('users/manager-1', {
          isActive: true,
          deletedAt: null,
          authVersion: 9,
          role: 'manager',
          branchIds: ['OTHER'],
        }),
      'manager_branch_mismatch',
    ],
    [
      'initiator deactivated',
      (db) =>
        db.store.set('users/staff-1', {
          isActive: false,
          deletedAt: null,
          authVersion: 4,
          role: 'staff',
          branchIds: [BRANCH],
        }),
      'initiator_inactive',
    ],
    [
      'initiator session force-invalidated (authVersion bumped)',
      (db) =>
        db.store.set('users/staff-1', {
          isActive: true,
          deletedAt: null,
          authVersion: 5,
          role: 'staff',
          branchIds: [BRANCH],
        }),
      'initiator_auth_version_changed',
    ],
    [
      'device revoked',
      (db) => db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, activeDeviceSeed({ status: 'REVOKED' })),
      'device_not_active',
    ],
    [
      'device registration deleted',
      (db) => db.store.delete(`privilegedDeviceRegistrations/${DEVICE_HEX}`),
      'device_not_active',
    ],
    [
      'device rebound to another branch',
      (db) => db.store.set(`privilegedDeviceRegistrations/${DEVICE_HEX}`, activeDeviceSeed({ branchId: 'OTHER' })),
      'device_branch_mismatch',
    ],
    [
      'global revocation epoch bumped (emergency revoke)',
      (db) =>
        db.store.set('privilegedRevocationState/current', {
          revocationEpoch: 4,
          updatedAtServerMs: 1,
          updatedBy: 'emergency',
          reason: 'compromise',
        }),
      'revocation_epoch_changed',
    ],
    [
      'manager role loses pos_void',
      (db) =>
        db.store.set('settings/_rolePermissions', {
          rolePermissions: {
            admin: ['pos_sale', 'pos_void'],
            manager: ['pos_sale'],
            staff: ['pos_sale', 'pos_void'],
          },
        }),
      'manager_permission_revoked',
    ],
    [
      'initiator role loses pos_void',
      (db) =>
        db.store.set('settings/_rolePermissions', {
          rolePermissions: {
            admin: ['pos_sale', 'pos_void'],
            manager: ['pos_sale', 'pos_void'],
            staff: ['pos_sale'],
          },
        }),
      'initiator_permission_revoked',
    ],
    [
      'staged-deny round opens for the manager role',
      (db) =>
        db.store.set('privilegedStagedRoleDeny/manager', {
          state: 'DRAINING',
          changeId: 'change-1',
          deniedPermissions: ['pos_void'],
        }),
      'manager_permission_revoked',
    ],
    [
      'staged-deny round opens for the initiator role',
      (db) =>
        db.store.set('privilegedStagedRoleDeny/staff', {
          state: 'VERIFYING',
          changeId: 'change-1',
          deniedPermissions: ['pos_void'],
        }),
      'initiator_permission_revoked',
    ],
    [
      'a present-but-malformed staged-deny head still fails closed (C-A-RC-003-R1)',
      (db) =>
        db.store.set('privilegedStagedRoleDeny/manager', {
          state: 'BOGUS',
          changeId: 'change-1',
          deniedPermissions: ['pos_void'],
        }),
      'manager_permission_revoked',
    ],
  ])('sentinel interleaving: %s', async (label, mutate, reason) => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const { calls, executeCanonicalVoid } = countingVoidExecutor();
    db.setBeforeFirstTransaction(() => mutate(db));

    const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

    expect(db.beforeTransactionFireCount(), label).toBe(1);
    expect(res, label).toMatchObject({
      family: 'ADJUDICATION',
      kind: 'REJECTED',
      rejectionReason: reason,
      terminal: true,
      idempotent: false,
    });

    const record = db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!;
    expect(record.state, label).toBe('TERMINALLY_REJECTED');
    expect(record.rejectionReason, label).toBe(reason);
    expect(record.consumedAtMillis, label).toBeNull();
    expect(record.offlineExecutionId, label).toBeNull();
    expect(parseOfflineAdjudicationRecord(record), label).not.toBeNull();
    expect(db.writesIn('privilegedOfflineAdjudications'), label).toHaveLength(1);
    expect(db.writesIn('asyncOrders'), label).toHaveLength(0);
    expect(db.store.get('asyncOrders/order-1')!.status, label).toBe('settled');
    expect(calls, label).toHaveLength(0);
  });

  test('CONTROL — with no mutation at the boundary the frame still consumes and completes', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const { calls, executeCanonicalVoid } = countingVoidExecutor();
    db.setBeforeFirstTransaction(() => {
      /* the interleaving window opens and nothing changes */
    });

    const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

    expect(db.beforeTransactionFireCount()).toBe(1);
    expect(res).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'VOID_APPLIED', idempotent: false });
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe('COMPLETED');
    expect(calls).toHaveLength(1);
  });

  test('CONTROL — the relay caller is not bound-action authority: deactivating it at the boundary still consumes', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const { calls, executeCanonicalVoid } = countingVoidExecutor();
    db.setBeforeFirstTransaction(() => {
      db.store.set('users/relay-1', {
        isActive: false,
        deletedAt: NOW,
        authVersion: 0,
        role: 'staff',
        branchIds: [BRANCH],
      });
    });

    const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

    expect(db.beforeTransactionFireCount()).toBe(1);
    expect(res).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'VOID_APPLIED' });
    expect(calls).toHaveLength(1);
    // The relay document is read exactly twice, both at the P0 preflight gate,
    // and never inside the transaction. Model B: transport, zero authority.
    expect(db.readsIn('users').filter((p) => p === 'users/relay-1')).toHaveLength(2);
    // The bound parties ARE re-read: once at preflight, once transactionally.
    expect(db.readsIn('users').filter((p) => p === 'users/staff-1')).toHaveLength(2);
    expect(db.readsIn('users').filter((p) => p === 'users/manager-1')).toHaveLength(2);
  });

  test('CONTROL — benign re-enrolment is not revocation: a key-version bump alone still consumes', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    const { calls, executeCanonicalVoid } = countingVoidExecutor();
    db.setBeforeFirstTransaction(() => {
      // Re-enrolment: ACTIVE, same branch, new key material at a new version.
      db.store.set(
        `privilegedDeviceRegistrations/${DEVICE_HEX}`,
        activeDeviceSeed({
          deviceKeyVersion: 4,
          validatedDevProofPublicKeyBase64: rawPublicKeyBase64(generateKeyPairSync('ed25519').publicKey),
        }),
      );
    });

    const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

    expect(db.beforeTransactionFireCount()).toBe(1);
    expect(res).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'VOID_APPLIED' });
    expect(calls).toHaveLength(1);
    // The frame was already authenticated at F2/F3 against the key that signed
    // it; the transaction re-reads status/branch only.
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(2);
  });

  test('CONTROL — an existing CONSUMED_PENDING_EXECUTION replay never re-reads transactional authority', async () => {
    const db = makeDb();
    const paa1 = buildPaa1();
    // First pass consumes but the canonical void fails, leaving the record.
    await run(db, paa1.request, relayAuth(), {
      executeCanonicalVoid: async () => {
        throw new Error('transient');
      },
    });
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe(
      'CONSUMED_PENDING_EXECUTION',
    );

    // Now revoke the manager every way at once, then replay.
    db.store.set('userCredentials/manager-1', { ...MANAGER_CREDENTIAL_SEED, credentialVersion: 6 });
    db.store.set('users/manager-1', {
      isActive: false,
      deletedAt: NOW,
      authVersion: 77,
      role: 'staff',
      branchIds: [],
    });
    db.store.set('privilegedRevocationState/current', {
      revocationEpoch: 9,
      updatedAtServerMs: 1,
      updatedBy: 'emergency',
      reason: null,
    });
    db.store.set('privilegedStagedRoleDeny/manager', {
      state: 'DRAINING',
      changeId: 'change-1',
      deniedPermissions: ['pos_void'],
    });
    db.resetSpies();

    const replay = await run(db, paa1.request);

    expect(replay).toMatchObject({ kind: 'ACCEPTED', outcomeKind: 'VOID_APPLIED' });
    expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`)!.state).toBe('COMPLETED');
    // Not one of the linearized sentinels is consulted on the replay path.
    expect(db.readsIn('userCredentials')).toHaveLength(0);
    expect(db.readsIn('privilegedRevocationState')).toHaveLength(0);
    expect(db.readsIn('privilegedDeviceRegistrations')).toHaveLength(0);
    expect(db.readsIn('users').every((p) => p === 'users/relay-1')).toBe(true);
    // The single settings/staged-deny read is the P0 relay gate, not the
    // transaction: the relay gate is unchanged and still runs.
    expect(db.readsIn('settings')).toEqual(['settings/_rolePermissions']);
    expect(db.readsIn('privilegedStagedRoleDeny')).toEqual(['privilegedStagedRoleDeny/staff']);
  });

  test.each<[string, string]>([
    ['role-permission matrix', 'settings/_rolePermissions'],
    ['initiator staged-deny head', 'privilegedStagedRoleDeny/staff'],
    ['manager staged-deny head', 'privilegedStagedRoleDeny/manager'],
    ['manager credential', 'userCredentials/manager-1'],
    ['initiator user document', 'users/staff-1'],
  ])(
    'a transaction-bound %s read FAILURE propagates for retry and never becomes a durable revocation',
    async (label, path) => {
      const db = makeDb();
      const paa1 = buildPaa1();
      const { calls, executeCanonicalVoid } = countingVoidExecutor();
      // Preflight succeeds; the failure is injected only for the transaction.
      db.setBeforeFirstTransaction(() => db.failReads.add(path));

      const res = await run(db, paa1.request, relayAuth(), { executeCanonicalVoid });

      expect(db.beforeTransactionFireCount(), label).toBe(1);
      // A transient read failure is not proof of revocation: it must surface as
      // the retryable transaction outcome, never as a terminal verdict.
      expect(res, label).toMatchObject({
        family: 'ADJUDICATION',
        kind: 'RETRYABLE',
        retryReason: 'transaction_contention',
        terminal: false,
      });
      expect(db.writesIn('privilegedOfflineAdjudications'), label).toHaveLength(0);
      expect(db.store.get(`privilegedOfflineAdjudications/${paa1.adjudicationId}`), label).toBeUndefined();
      expect(db.writesIn('asyncOrders'), label).toHaveLength(0);
      expect(calls, label).toHaveLength(0);
    },
  );
});
