import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const adminAppMocks = vi.hoisted(() => ({
  initializeApp: vi.fn((opts: { projectId?: string; credential?: unknown } = {}) => ({
    name: '[DEFAULT]',
    options: { projectId: opts.projectId },
  })),
  cert: vi.fn((value: unknown) => ({ __operatorCert: value })),
  getApps: vi.fn((): unknown[] => []),
  applicationDefault: vi.fn(),
}));

const firestoreAdminMocks = vi.hoisted(() => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
  getFirestore: vi.fn((app: unknown, databaseId?: string) => ({
    __operatorTestFirestore: true,
    app,
    databaseId,
  })),
}));

vi.mock('firebase-admin/app', () => adminAppMocks);
vi.mock('firebase-admin/firestore', () => firestoreAdminMocks);

import {
  executeCensusUsernamesCli,
  isCensusUsernamesCliEntry,
  parseCensusUsernamesCliArgs,
} from '../censusUsernames';
import {
  executeRepairUsernameReservationsCli,
  isRepairUsernameReservationsCliEntry,
  parseRepairUsernameReservationsCliArgs,
} from '../repairUsernameReservations';
import {
  executeMigrateUsernameReservationsCli,
  isMigrateUsernameReservationsCliEntry,
  parseMigrateUsernameReservationsCliArgs,
} from '../migrateUsernameReservations';
import {
  executeVerifyUsernameReservationCompletenessCli,
  isVerifyUsernameReservationCompletenessCliEntry,
  parseVerifyUsernameReservationCompletenessCliArgs,
} from '../verifyUsernameReservationCompleteness';
import {
  executeSetUsernameMigrationMaintenanceModeCli,
  isSetUsernameMigrationMaintenanceModeCliEntry,
  parseSetUsernameMigrationMaintenanceModeCliArgs,
} from '../setUsernameMigrationMaintenanceMode';
import {
  executeMigrateCredentialsCli,
  isMigrateCredentialsCliEntry,
  parseMigrateCredentialsCliArgs,
} from '../migrateCredentials';
import {
  executeRecoverUserCredentialCli,
  formatRecoverUserCredentialCliResult,
  isRecoverUserCredentialCliEntry,
  parseRecoverUserCredentialCliArgs,
} from '../recoverUserCredential';

type Doc = Record<string, unknown>;

const TARGET = ['--project=demo-twinpet', '--database=pos-db', '--credentials=unused-sa.json'];
const EMPTY_ENV: NodeJS.ProcessEnv = {};

const EXISTING_DEPLOY_FUNCTIONS = [
  'verifyPinLogin',
  'reconcileOrder',
  'retryReconcile',
  'resolveTransferDiscrepancy',
  'resolveReversal',
  'shiftCloseEvidenceCapture',
  'shiftCloseValidationSweep',
  'shiftCloseSourceEventAsyncOrders',
  'shiftCloseSourceEventOrders',
  'shiftCloseSourceEventCashTransactions',
  'shiftCloseSourceEventCreditPayments',
  'resolveShiftCloseAlert',
  'getShiftCloseCaseFigures',
  'getOrderReceipt',
];

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const resolveVal = (cur: unknown, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'inc') {
      return ((cur as number) ?? 0) + ((v as { n: number }).n ?? 0);
    }
    return v;
  };
  function docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      collection: (n: string) => col(`${path}/${n}`),
      set: async (data: Doc, opts?: { merge?: boolean }) => {
        const existing = opts?.merge ? (store.get(path) ?? {}) : {};
        const next: Doc = opts?.merge ? { ...existing } : {};
        const source = opts?.merge ? data : data;
        if (!opts?.merge) {
          store.set(path, { ...data });
          return;
        }
        for (const [k, v] of Object.entries(source)) next[k] = resolveVal(existing[k], v);
        store.set(path, next);
      },
      get: async () => {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
    };
  }
  function col(path: string) {
    return {
      doc: (id: string) => docRef(`${path}/${id}`),
      get: async () => {
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
          .map(([p, data]) => ({
            id: p.slice(p.lastIndexOf('/') + 1),
            data: () => data,
            ref: docRef(p),
          }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
  }
  return {
    collection: (c: string) => col(c),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: { path: string }, data: Doc) => {
          ops.push(() => {
            store.set(ref.path, { ...data });
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (r: { path: string }) => {
          const data = store.get(r.path);
          return { exists: data !== undefined, data: () => data };
        },
        set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) => {
          const existing = opts?.merge ? (store.get(r.path) ?? {}) : {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        update: (r: { path: string }, data: Doc) => {
          const existing = store.get(r.path) ?? {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        delete: (r: { path: string }) => store.delete(r.path),
      };
      return fn(tx);
    },
    __store: store,
  };
}

function snapshot(store: Map<string, Doc>): string {
  return JSON.stringify([...store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe('operator CLI entrypoints', () => {
  test('importing CLI modules does not treat vitest as an operator entry', () => {
    const entry = process.argv[1] ?? '';
    expect(isCensusUsernamesCliEntry(entry)).toBe(false);
    expect(isRepairUsernameReservationsCliEntry(entry)).toBe(false);
    expect(isMigrateUsernameReservationsCliEntry(entry)).toBe(false);
    expect(isVerifyUsernameReservationCompletenessCliEntry(entry)).toBe(false);
    expect(isSetUsernameMigrationMaintenanceModeCliEntry(entry)).toBe(false);
    expect(isMigrateCredentialsCliEntry(entry)).toBe(false);
    expect(isRecoverUserCredentialCliEntry(entry)).toBe(false);
    expect(isCensusUsernamesCliEntry('lib/scripts/censusUsernames.js')).toBe(true);
    expect(isCensusUsernamesCliEntry('src/scripts/__tests__/censusUsernames.test.ts')).toBe(false);
  });

  test('missing project/database/credentials reject before mutation', async () => {
    const db = makeDb({ 'users/u1': { username: 'ann', deletedAt: null } });
    const before = snapshot(db.__store);
    expect(() => parseCensusUsernamesCliArgs(['--database=pos-db', '--credentials=x.json', '--censusOperationId=op'], EMPTY_ENV))
      .toThrow(/MISSING_PROJECT/);
    expect(() => parseCensusUsernamesCliArgs(['--project=demo', '--credentials=x.json', '--censusOperationId=op'], EMPTY_ENV))
      .toThrow(/MISSING_DATABASE/);
    expect(() => parseCensusUsernamesCliArgs(['--project=demo', '--database=pos-db', '--censusOperationId=op'], EMPTY_ENV))
      .toThrow(/MISSING_CREDENTIALS/);
    expect(() => parseCensusUsernamesCliArgs(
      ['--project=demo', '--database=pos-db', '--censusOperationId=op'],
      { GOOGLE_APPLICATION_CREDENTIALS: 'from-env.json' },
    )).not.toThrow();
    expect(snapshot(db.__store)).toBe(before);
  });

  test('missing or invalid command/phase rejects before mutation', async () => {
    const db = makeDb({
      'users/u1': { username: 'ann', pin: '$2b$10$hash', deletedAt: null },
      'userCredentials/u1': { pinHash: '$2b$10$hash', credentialState: 'backfilled_not_trusted', disabled: false },
    });
    const before = snapshot(db.__store);
    expect(() => parseCensusUsernamesCliArgs([...TARGET], EMPTY_ENV)).toThrow(/MISSING_CENSUS_OPERATION_ID/);
    expect(() => parseRepairUsernameReservationsCliArgs([...TARGET, '--censusOperationId=op'], EMPTY_ENV))
      .toThrow(/MISSING_SNAPSHOT_DIGEST/);
    expect(() => parseMigrateUsernameReservationsCliArgs(
      [...TARGET, '--censusOperationId=op', '--snapshotDigest=abc'],
      EMPTY_ENV,
    )).toThrow(/MISSING_REQUESTED_EPOCH/);
    expect(() => parseVerifyUsernameReservationCompletenessCliArgs([...TARGET], EMPTY_ENV))
      .toThrow(/MISSING_REQUESTED_EPOCH/);
    expect(() => parseSetUsernameMigrationMaintenanceModeCliArgs([...TARGET], EMPTY_ENV)).toThrow(/MISSING_ENABLE/);
    expect(() => parseMigrateCredentialsCliArgs([...TARGET], EMPTY_ENV)).toThrow(/MISSING_PHASE/);
    expect(() => parseMigrateCredentialsCliArgs([...TARGET, '--phase=not_a_phase'], EMPTY_ENV)).toThrow(/INVALID_PHASE/);
    expect(() => parseMigrateCredentialsCliArgs([...TARGET, '--phase=waive'], EMPTY_ENV)).toThrow(/MISSING_USER_ID/);
    expect(() => parseRecoverUserCredentialCliArgs([...TARGET, '--rotateIdempotencyKey=k'], EMPTY_ENV))
      .toThrow(/MISSING_TARGET/);
    expect(snapshot(db.__store)).toBe(before);
  });

  test('missing --apply rejects before mutation', async () => {
    const db = makeDb({ 'users/u1': { username: 'ann', deletedAt: null } });
    const before = snapshot(db.__store);
    const args = parseCensusUsernamesCliArgs([...TARGET, '--censusOperationId=op-1'], EMPTY_ENV);
    expect(args.apply).toBe(false);
    await expect(executeCensusUsernamesCli(args, { database: db as never })).rejects.toThrow(/MISSING_APPLY/);
    expect(snapshot(db.__store)).toBe(before);
  });

  test('census CLI maps to runCensusUsernames', async () => {
    const db = makeDb({ 'users/u1': { username: 'Somchai', deletedAt: null } });
    const args = parseCensusUsernamesCliArgs(
      [...TARGET, '--censusOperationId=op-cli', '--requestedEpoch=0', '--apply'],
      EMPTY_ENV,
    );
    const header = await executeCensusUsernamesCli(args, { database: db as never });
    expect(header.censusOperationId).toBe('op-cli');
    expect(header.liveUserCount).toBe(1);
    expect(db.__store.has('migrationControl/usernameCensus/headers/op-cli')).toBe(true);
  });

  test('repair CLI maps to runRepairUsernameReservations with required inputs', async () => {
    const db = makeDb({ 'users/u1': { username: 'ann', deletedAt: null } });
    const args = parseRepairUsernameReservationsCliArgs(
      [...TARGET, '--censusOperationId=missing', '--snapshotDigest=nope', '--apply'],
      EMPTY_ENV,
    );
    const res = await executeRepairUsernameReservationsCli(args, { database: db as never });
    expect(res.ok).toBe(false);
    expect(res.writes).toBe(0);
    expect(res.error).toMatch(/CENSUS_HEADER_ABSENT/);
  });

  test('migrate-username-reservations CLI maps to runMigrateUsernameReservations', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: false, epoch: 1 },
    });
    const args = parseMigrateUsernameReservationsCliArgs(
      [...TARGET, '--censusOperationId=op', '--snapshotDigest=x', '--requestedEpoch=1', '--apply'],
      EMPTY_ENV,
    );
    const res = await executeMigrateUsernameReservationsCli(args, { database: db as never });
    expect(res.ok).toBe(false);
    expect(res.writes).toBe(0);
    expect(res.error).toBe('SELF_GATE_DENIED');
  });

  test('verify CLI maps to runVerifyUsernameReservationCompleteness', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: true, epoch: 1 },
      'users/a': { username: 'ann', deletedAt: null },
    });
    const args = parseVerifyUsernameReservationCompletenessCliArgs(
      [...TARGET, '--requestedEpoch=2', '--apply'],
      EMPTY_ENV,
    );
    const res = await executeVerifyUsernameReservationCompletenessCli(args, { database: db as never });
    expect(res.ok).toBe(false);
    expect(db.__store.get('migrationControl/usernameReservations')).toMatchObject({
      maintenanceMode: true,
      epoch: 1,
    });
  });

  test('maintenance CLI cannot request the reverse transition', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { maintenanceMode: true, complete: true, epoch: 1 },
    });
    const before = snapshot(db.__store);
    expect(() => parseSetUsernameMigrationMaintenanceModeCliArgs([...TARGET, '--disable', '--apply'], EMPTY_ENV))
      .toThrow(/MAINTENANCE_FALSE_REJECTED/);
    expect(() => parseSetUsernameMigrationMaintenanceModeCliArgs(
      [...TARGET, '--requested=false', '--apply'],
      EMPTY_ENV,
    )).toThrow(/MAINTENANCE_FALSE_REJECTED/);
    expect(snapshot(db.__store)).toBe(before);
    const args = parseSetUsernameMigrationMaintenanceModeCliArgs([...TARGET, '--enable', '--apply'], EMPTY_ENV);
    const res = await executeSetUsernameMigrationMaintenanceModeCli(args, { database: db as never });
    expect(res.ok).toBe(true);
    expect(res.noop).toBe(true);
    expect(res.maintenanceMode).toBe(true);
  });

  test('credential CLI phases map to reviewed core operations and cannot bypass pendingRotation', async () => {
    const db = makeDb({
      'users/u1': { username: 'a', pin: '$2b$10$hash', deletedAt: null },
      'userCredentials/u1': {
        pinHash: '$2b$10$hash',
        credentialState: 'readers_cut_over_rotation_required',
        disabled: false,
      },
    });
    const backfill = parseMigrateCredentialsCliArgs([...TARGET, '--phase=backfill', '--apply'], EMPTY_ENV);
    expect(backfill.phase).toBe('backfill');
    const cutover = parseMigrateCredentialsCliArgs([...TARGET, '--phase=cut_over_readers', '--apply'], EMPTY_ENV);
    expect(cutover.phase).toBe('cut_over_readers');
    const waive = parseMigrateCredentialsCliArgs([...TARGET, '--phase=waive', '--userId=u1', '--apply'], EMPTY_ENV);
    expect(waive.phase).toBe('waive');
    const clearArgs = parseMigrateCredentialsCliArgs([...TARGET, '--phase=clear_legacy_pin', '--apply'], EMPTY_ENV);
    const clear = await executeMigrateCredentialsCli(clearArgs, { database: db as never });
    expect(clear).toMatchObject({
      ok: false,
      phase: 'clear_legacy_pin',
      error: 'LEGACY_PIN_CLEAR_BLOCKED_PENDING_ROTATION',
    });
    expect(db.__store.get('users/u1')).toMatchObject({ pin: '$2b$10$hash' });
  });

  test('recovery CLI routes through in-process rotate and never uses auth.createUser', async () => {
    const src = readFileSync(resolve(__dirname, '../recoverUserCredential.ts'), 'utf8');
    expect(src).not.toMatch(/\.createUser\s*\(/);
    expect(src).not.toMatch(/from ['"]firebase-admin\/auth['"]/);
    expect(src).toMatch(/performSetUserAccount/);
    expect(src).toMatch(/kind: 'operator_cli'/);

    const db = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: false, epoch: 1 },
      'users/target': { username: 'admin', role: 'admin', isActive: true, deletedAt: null, authVersion: 0 },
    });
    const pin = '7777';
    const args = parseRecoverUserCredentialCliArgs(
      [...TARGET, '--userId=target', `--pin=${pin}`, '--rotateIdempotencyKey=rec-cli', '--apply'],
      EMPTY_ENV,
    );
    const res = await executeRecoverUserCredentialCli(args, { database: db as never });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('rotated');
    const logged = formatRecoverUserCredentialCliResult(res);
    expect(logged).not.toContain(pin);
    expect(JSON.stringify(db.__store)).not.toContain(pin);
  });

  test('CLI handling does not log raw PIN/password secrets', () => {
    const recoverSrc = readFileSync(resolve(__dirname, '../recoverUserCredential.ts'), 'utf8');
    const migrateSrc = readFileSync(resolve(__dirname, '../migrateCredentials.ts'), 'utf8');
    expect(recoverSrc).not.toMatch(/console\.log\(\s*args\.pin/);
    expect(recoverSrc).not.toMatch(/console\.error\(\s*args\.pin/);
    expect(recoverSrc).not.toMatch(/console\.log\([^)]*\$\{[^}]*pin/);
    expect(recoverSrc).toMatch(/redactSecret\(formatRecoverUserCredentialCliResult\(result\), args\.pin\)/);
    expect(recoverSrc).toMatch(/redactSecret\(message, args\.pin\)/);
    expect(migrateSrc).not.toMatch(/console\.log\([^)]*\$\{[^}]*pin/);
    const pin = '2468';
    expect(formatRecoverUserCredentialCliResult({
      ok: false,
      status: 'invalid_argument',
      message: 'bad',
    })).not.toContain(pin);
  });

  test('package scripts point at the seven modules and setUserAccount is allowlisted', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['census-usernames']).toContain('lib/scripts/censusUsernames.js');
    expect(pkg.scripts['repair-username-reservations']).toContain('lib/scripts/repairUsernameReservations.js');
    expect(pkg.scripts['migrate-username-reservations']).toContain('lib/scripts/migrateUsernameReservations.js');
    expect(pkg.scripts['verify-username-reservation-completeness']).toContain(
      'lib/scripts/verifyUsernameReservationCompleteness.js',
    );
    expect(pkg.scripts['set-username-migration-maintenance-mode']).toContain(
      'lib/scripts/setUsernameMigrationMaintenanceMode.js',
    );
    expect(pkg.scripts['migrate-credentials']).toContain('lib/scripts/migrateCredentials.js');
    expect(pkg.scripts['recover-user-credential']).toContain('lib/scripts/recoverUserCredential.js');
    for (const name of EXISTING_DEPLOY_FUNCTIONS) {
      expect(pkg.scripts.deploy).toContain(`functions:${name}`);
    }
    expect(pkg.scripts.deploy).toContain('functions:setUserAccount');
    const functionRefs = [...pkg.scripts.deploy.matchAll(/functions:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(functionRefs).toEqual([...EXISTING_DEPLOY_FUNCTIONS, 'setUserAccount']);
  });

  test('operator modules do not silently default FIRESTORE_DATABASE_ID', () => {
    const files = [
      'censusUsernames.ts',
      'repairUsernameReservations.ts',
      'migrateUsernameReservations.ts',
      'verifyUsernameReservationCompleteness.ts',
      'setUsernameMigrationMaintenanceMode.ts',
      'migrateCredentials.ts',
      'recoverUserCredential.ts',
    ];
    for (const file of files) {
      const src = readFileSync(resolve(__dirname, `../${file}`), 'utf8');
      expect(src).not.toMatch(/FIRESTORE_DATABASE_ID/);
    }
  });
});

const SENTINEL_PIN = '7391';
const PROJECT_A = 'twinpet-cli-project-a';
const PROJECT_B = 'twinpet-cli-project-b';
const DATABASE_ID = 'pos-db-exact-bound';

type OperatorCliSpec = {
  name: string;
  file: string;
  extraArgs: string[];
};

const OPERATOR_CLIS: OperatorCliSpec[] = [
  { name: 'censusUsernames', file: 'censusUsernames.ts', extraArgs: ['--censusOperationId=op-boundary'] },
  {
    name: 'repairUsernameReservations',
    file: 'repairUsernameReservations.ts',
    extraArgs: ['--censusOperationId=op-boundary', '--snapshotDigest=deadbeef'],
  },
  {
    name: 'migrateUsernameReservations',
    file: 'migrateUsernameReservations.ts',
    extraArgs: ['--censusOperationId=op-boundary', '--snapshotDigest=deadbeef', '--requestedEpoch=1'],
  },
  {
    name: 'verifyUsernameReservationCompleteness',
    file: 'verifyUsernameReservationCompleteness.ts',
    extraArgs: ['--requestedEpoch=1'],
  },
  {
    name: 'setUsernameMigrationMaintenanceMode',
    file: 'setUsernameMigrationMaintenanceMode.ts',
    extraArgs: ['--enable'],
  },
  { name: 'migrateCredentials', file: 'migrateCredentials.ts', extraArgs: ['--phase=backfill'] },
  {
    name: 'recoverUserCredential',
    file: 'recoverUserCredential.ts',
    extraArgs: ['--userId=target', `--pin=${SENTINEL_PIN}`, '--rotateIdempotencyKey=rec-boundary'],
  },
];

function resetAdminMocks() {
  adminAppMocks.initializeApp.mockClear();
  adminAppMocks.cert.mockClear();
  adminAppMocks.getApps.mockClear();
  adminAppMocks.applicationDefault.mockClear();
  adminAppMocks.getApps.mockImplementation(() => []);
  firestoreAdminMocks.getFirestore.mockReset();
  firestoreAdminMocks.getFirestore.mockImplementation((app: unknown, databaseId?: string) => ({
    __operatorTestFirestore: true,
    app,
    databaseId,
  }));
}

function stringifyCliLog(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    return String(a);
  }).join(' ');
}

async function runCliMain(
  moduleFile: string,
  argvFlags: string[],
  setup?: () => void,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  resetAdminMocks();
  setup?.();

  const originalArgv = process.argv.slice();
  const envSnapshot = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    RECOVER_USER_PIN: process.env.RECOVER_USER_PIN,
    FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID,
    GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  };
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.RECOVER_USER_PIN;
  delete process.env.FIRESTORE_DATABASE_ID;
  delete process.env.GCLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;

  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(stringifyCliLog(args));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(stringifyCliLog(args));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCode = typeof code === 'number' ? code : code == null ? 0 : Number(code) || 1;
    return undefined as never;
  }) as typeof process.exit);

  process.argv = [originalArgv[0] ?? process.execPath, resolve(__dirname, `../${moduleFile}`), ...argvFlags];

  try {
    vi.resetModules();
    switch (moduleFile) {
      case 'censusUsernames.ts':
        await import('../censusUsernames');
        break;
      case 'repairUsernameReservations.ts':
        await import('../repairUsernameReservations');
        break;
      case 'migrateUsernameReservations.ts':
        await import('../migrateUsernameReservations');
        break;
      case 'verifyUsernameReservationCompleteness.ts':
        await import('../verifyUsernameReservationCompleteness');
        break;
      case 'setUsernameMigrationMaintenanceMode.ts':
        await import('../setUsernameMigrationMaintenanceMode');
        break;
      case 'migrateCredentials.ts':
        await import('../migrateCredentials');
        break;
      case 'recoverUserCredential.ts':
        await import('../recoverUserCredential');
        break;
      default:
        throw new Error(`unknown operator CLI module: ${moduleFile}`);
    }
    await vi.dynamicImportSettled();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (exitCode !== undefined || stdout.length > 0 || stderr.length > 0) break;
      await new Promise<void>((r) => setImmediate(r));
    }
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.argv = originalArgv;
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  if (exitCode === undefined && stdout.length === 0 && stderr.length === 0) {
    throw new Error(`CLI ${moduleFile} produced no exit/stdout/stderr; main() likely did not run`);
  }

  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('operator CLI real main() boundary', () => {
  const tempDirs: string[] = [];

  function writeCredentialFixture(projectId: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'twinpet-operator-cli-'));
    tempDirs.push(dir);
    const path = join(dir, 'sa.json');
    writeFileSync(path, JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      client_email: 'operator-cli-test@example.invalid',
      private_key: '-----BEGIN PRIVATE KEY-----\nNOT_A_REAL_KEY\n-----END PRIVATE KEY-----\n',
    }));
    return path;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(OPERATOR_CLIS)('$name main() without --apply fails before credentials/Admin/Firestore', async (cli) => {
    const credentialsPath = join(tmpdir(), 'twinpet-operator-cli-must-not-open', `${cli.name}.json`);
    const result = await runCliMain(cli.file, [
      `--project=${PROJECT_A}`,
      `--database=${DATABASE_ID}`,
      `--credentials=${credentialsPath}`,
      ...cli.extraArgs,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/MISSING_APPLY/);
    expect(result.stderr).not.toMatch(/CREDENTIALS_FILE_MISSING/);
    expect(result.stderr).not.toContain(SENTINEL_PIN);
    expect(result.stdout).not.toContain(SENTINEL_PIN);
    expect(adminAppMocks.getApps).not.toHaveBeenCalled();
    expect(adminAppMocks.initializeApp).not.toHaveBeenCalled();
    expect(adminAppMocks.cert).not.toHaveBeenCalled();
    expect(adminAppMocks.applicationDefault).not.toHaveBeenCalled();
    expect(firestoreAdminMocks.getFirestore).not.toHaveBeenCalled();
  });

  test.each(OPERATOR_CLIS)('$name main() rejects credential project mismatch before Firestore return', async (cli) => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const result = await runCliMain(cli.file, [
      `--project=${PROJECT_B}`,
      `--database=${DATABASE_ID}`,
      `--credentials=${credentialsPath}`,
      ...cli.extraArgs,
      '--apply',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/PROJECT_MISMATCH/);
    expect(result.stderr).toContain(PROJECT_B);
    expect(result.stderr).toContain(PROJECT_A);
    expect(adminAppMocks.initializeApp).not.toHaveBeenCalled();
    expect(adminAppMocks.cert).not.toHaveBeenCalled();
    expect(adminAppMocks.applicationDefault).not.toHaveBeenCalled();
    expect(firestoreAdminMocks.getFirestore).not.toHaveBeenCalled();
  });

  test.each(OPERATOR_CLIS)('$name main() binds exact requested project and database at Admin open', async (cli) => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const result = await runCliMain(cli.file, [
      `--project=${PROJECT_A}`,
      `--database=${DATABASE_ID}`,
      `--credentials=${credentialsPath}`,
      ...cli.extraArgs,
      '--apply',
    ]);
    expect(adminAppMocks.applicationDefault).not.toHaveBeenCalled();
    expect(adminAppMocks.cert).toHaveBeenCalledTimes(1);
    expect(adminAppMocks.cert).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_A,
      clientEmail: 'operator-cli-test@example.invalid',
    }));
    expect(adminAppMocks.initializeApp).toHaveBeenCalledTimes(1);
    const initOpts = adminAppMocks.initializeApp.mock.calls[0]?.[0] as {
      projectId?: string;
      credential?: unknown;
    };
    expect(initOpts.projectId).toBe(PROJECT_A);
    expect(initOpts.credential).toEqual({
      __operatorCert: expect.objectContaining({
        projectId: PROJECT_A,
        clientEmail: 'operator-cli-test@example.invalid',
      }),
    });
    expect(firestoreAdminMocks.getFirestore).toHaveBeenCalledTimes(1);
    const fsCall = firestoreAdminMocks.getFirestore.mock.calls[0] ?? [];
    expect(fsCall).toHaveLength(2);
    expect(fsCall[1]).toBe(DATABASE_ID);
    expect(fsCall[0]).toEqual(expect.objectContaining({
      options: expect.objectContaining({ projectId: PROJECT_A }),
    }));
    expect(result.stderr).not.toContain(SENTINEL_PIN);
    expect(result.stdout).not.toContain(SENTINEL_PIN);
  });

  test('recover main() success path redacts sentinel PIN from stdout and stderr', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const recoveryDb = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: false, epoch: 1 },
      'users/target': { username: 'admin', role: 'admin', isActive: true, deletedAt: null, authVersion: 0 },
    });
    const result = await runCliMain(
      'recoverUserCredential.ts',
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--userId=target',
        `--pin=${SENTINEL_PIN}`,
        '--rotateIdempotencyKey=rec-cli-main-success',
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => recoveryDb);
      },
    );
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toMatch(/"ok":\s*true/);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).not.toContain(SENTINEL_PIN);
    expect(result.stderr).not.toContain(SENTINEL_PIN);
    expect(result.stdout).not.toMatch(/--pin=/);
    expect(result.stderr).not.toMatch(/--pin=/);
  });

  test('recover main() forced-error path redacts sentinel PIN and exits non-zero', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const result = await runCliMain(
      'recoverUserCredential.ts',
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--userId=target',
        `--pin=${SENTINEL_PIN}`,
        '--rotateIdempotencyKey=rec-cli-main-error',
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => {
          throw new Error(`forced-op-error:${SENTINEL_PIN}`);
        });
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/forced-op-error:/);
    expect(result.stderr).toContain('[redacted]');
    expect(result.stderr).not.toContain(SENTINEL_PIN);
    expect(result.stdout).not.toContain(SENTINEL_PIN);
    expect(result.stderr).not.toMatch(/--pin=/);
    expect(result.stdout).not.toMatch(/--pin=/);
  });

  test('recover parser error does not echo argv --pin or sentinel PIN', async () => {
    const credentialsPath = join(tmpdir(), 'twinpet-operator-cli-must-not-open', 'recover-parse.json');
    const result = await runCliMain('recoverUserCredential.ts', [
      `--project=${PROJECT_A}`,
      `--database=${DATABASE_ID}`,
      `--credentials=${credentialsPath}`,
      `--pin=${SENTINEL_PIN}`,
      '--rotateIdempotencyKey=rec-cli-parse',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/MISSING_TARGET/);
    expect(result.stderr).not.toContain(SENTINEL_PIN);
    expect(result.stdout).not.toContain(SENTINEL_PIN);
    expect(result.stderr).not.toMatch(/--pin=/);
    expect(result.stdout).not.toMatch(/--pin=/);
    expect(adminAppMocks.initializeApp).not.toHaveBeenCalled();
    expect(firestoreAdminMocks.getFirestore).not.toHaveBeenCalled();
  });
});
