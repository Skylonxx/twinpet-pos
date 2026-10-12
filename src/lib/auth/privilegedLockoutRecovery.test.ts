/**
 * TPOS-USABLE-POS-VOID-LOCKOUT-RECOVERY-SURFACE-CLAUDE-001 — D-V12..D-V17
 * admin lockout recovery episode. Fake native bridge + fake callable
 * transport + fake primary-admin check: no live Firebase, no real native.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPrivilegedLockoutRecoveryForTests,
  readPrivilegedLockoutStatus,
  runPrivilegedLockoutRecovery,
  type IssueLockoutClearRequest,
  type NativeInvoke,
} from './privilegedLockoutRecovery';

vi.mock('../firebase', () => ({
  app: undefined,
  auth: undefined,
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));

const ADMIN = { id: 'adminUid01', role: 'admin' };
const MANAGER = 'zcVi9fMgr01';
const DEVICE = 'ab'.repeat(16);
const LOCKOUT = 'cd'.repeat(32);
const LCT1 = 'TENUMQEC'.repeat(20);
const NOW = 1_791_800_000_000;

type Log = Array<{ cmd: string; args?: Record<string, unknown> }>;

function lockedContext(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    managerStaffId: MANAGER,
    lockedOut: true,
    consecutiveFailedAttempts: 5,
    lockedAtMs: NOW - 4 * 3_600_000,
    cooldownRemainingMs: 0,
    securityDeviceIdHex: DEVICE,
    lockoutIdHex: LOCKOUT,
    clearTokenRecorded: false,
    errorCode: null,
    ...over,
  };
}

const NOT_LOCKED = {
  ok: false,
  managerStaffId: null,
  lockedOut: false,
  consecutiveFailedAttempts: 0,
  lockedAtMs: null,
  cooldownRemainingMs: 0,
  securityDeviceIdHex: null,
  lockoutIdHex: null,
  clearTokenRecorded: false,
  errorCode: 'NOT_LOCKED',
};

function issuedOk(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    lct1Base64: LCT1,
    securityDeviceIdHex: DEVICE,
    managerStaffId: MANAGER,
    lockoutIdHex: LOCKOUT,
    issuedAtServerMs: NOW,
    expiresAtServerMs: NOW + 900_000,
    ...over,
  };
}

/** Native fake: context reads follow `contexts` in order (last one repeats). */
function fakeNative(
  log: Log,
  opts: { contexts?: unknown[]; clear?: unknown | (() => unknown) } = {},
): NativeInvoke {
  const contexts = opts.contexts ?? [lockedContext(), NOT_LOCKED];
  let reads = 0;
  return async (cmd, args) => {
    log.push({ cmd, args });
    if (cmd === 'native_get_privileged_lockout_recovery_context') {
      const next = contexts[Math.min(reads, contexts.length - 1)];
      reads += 1;
      return next;
    }
    if (cmd === 'native_clear_offline_lockout') {
      const c = opts.clear ?? { ok: true, managerStaffId: MANAGER, reopensNow: true, cooldownRemainingMs: 0, errorCode: null };
      return typeof c === 'function' ? (c as () => unknown)() : c;
    }
    throw new Error(`unexpected native command ${cmd}`);
  };
}

function fakeIssue(calls: IssueLockoutClearRequest[], response: unknown | (() => unknown) = issuedOk()) {
  return async (req: IssueLockoutClearRequest) => {
    calls.push(req);
    return typeof response === 'function' ? (response as () => unknown)() : response;
  };
}

const primaryAdmin = async () => true;

function count(log: Log, cmd: string) {
  return log.filter((e) => e.cmd === cmd).length;
}

describe('runPrivilegedLockoutRecovery (D-V14 one episode)', () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    __resetPrivilegedLockoutRecoveryForTests();
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  it('1. admin + locked + cooldown 0: one read, one issuance, one native clear, unlocked re-read, success', async () => {
    const log: Log = [];
    const calls: IssueLockoutClearRequest[] = [];
    const out = await runPrivilegedLockoutRecovery(
      { managerStaffId: MANAGER, operator: ADMIN },
      { invoke: fakeNative(log), issueLockoutClear: fakeIssue(calls), isPrimaryAdminPrincipal: primaryAdmin },
    );
    expect(out).toEqual({ kind: 'recovered' });
    expect(log.map((e) => e.cmd)).toEqual([
      'native_get_privileged_lockout_recovery_context',
      'native_clear_offline_lockout',
      'native_get_privileged_lockout_recovery_context',
    ]);
    expect(log[0]!.args).toEqual({ managerStaffId: MANAGER });
    expect(log[1]!.args).toEqual({ lct1BytesBase64: LCT1 });
    expect(calls).toEqual([{ securityDeviceIdHex: DEVICE, managerStaffId: MANAGER, lockoutIdHex: LOCKOUT }]);
  });

  it('2. non-admin operator or non-admin primary principal: no callable, no native clear', async () => {
    for (const operator of [{ id: 'mgrUid02', role: 'manager' }, { id: 'staff03', role: 'staff' }, null]) {
      const log: Log = [];
      const calls: IssueLockoutClearRequest[] = [];
      const out = await runPrivilegedLockoutRecovery(
        { managerStaffId: MANAGER, operator },
        { invoke: fakeNative(log), issueLockoutClear: fakeIssue(calls), isPrimaryAdminPrincipal: primaryAdmin },
      );
      expect(out).toEqual({ kind: 'not_admin' });
      expect(calls).toHaveLength(0);
      expect(log).toHaveLength(0);
    }

    // Admin role in the app session, but the primary Firebase user is not that
    // admin's own role=admin account (e.g. a Quick PIN anonymous identity).
    const log: Log = [];
    const calls: IssueLockoutClearRequest[] = [];
    const out = await runPrivilegedLockoutRecovery(
      { managerStaffId: MANAGER, operator: ADMIN },
      { invoke: fakeNative(log), issueLockoutClear: fakeIssue(calls), isPrimaryAdminPrincipal: async () => false },
    );
    expect(out).toEqual({ kind: 'not_admin' });
    expect(calls).toHaveLength(0);
    expect(count(log, 'native_clear_offline_lockout')).toBe(0);
  });

  it('3. cooldown > 0: reports remaining time, no callable, no native clear', async () => {
    const log: Log = [];
    const calls: IssueLockoutClearRequest[] = [];
    const out = await runPrivilegedLockoutRecovery(
      { managerStaffId: MANAGER, operator: ADMIN },
      {
        invoke: fakeNative(log, { contexts: [lockedContext({ cooldownRemainingMs: 420_000 })] }),
        issueLockoutClear: fakeIssue(calls),
        isPrimaryAdminPrincipal: primaryAdmin,
      },
    );
    expect(out).toEqual({ kind: 'cooldown', cooldownRemainingMs: 420_000 });
    expect(calls).toHaveLength(0);
    expect(count(log, 'native_clear_offline_lockout')).toBe(0);
  });

  it('4. callable refuses, throws, or returns a mismatched tuple: terminal, no native clear', async () => {
    const responses: Array<unknown | (() => unknown)> = [
      { ok: false, code: 'not_authorized' },
      { ok: false, code: 'device_not_registered' },
      () => {
        throw new Error('network');
      },
      null,
      issuedOk({ managerStaffId: 'otherMgr' }),
      issuedOk({ securityDeviceIdHex: 'ef'.repeat(16) }),
      issuedOk({ lockoutIdHex: 'ee'.repeat(32) }),
      issuedOk({ lct1Base64: '' }),
      issuedOk({ lct1Base64: 'not base64!' }),
      issuedOk({ expiresAtServerMs: NOW }),
      issuedOk({ expiresAtServerMs: NOW + 16 * 60_000 }),
    ];
    for (const response of responses) {
      __resetPrivilegedLockoutRecoveryForTests();
      const log: Log = [];
      const calls: IssueLockoutClearRequest[] = [];
      const out = await runPrivilegedLockoutRecovery(
        { managerStaffId: MANAGER, operator: ADMIN },
        { invoke: fakeNative(log), issueLockoutClear: fakeIssue(calls, response), isPrimaryAdminPrincipal: primaryAdmin },
      );
      expect(out).toEqual({ kind: 'failed' });
      expect(calls).toHaveLength(1);
      expect(count(log, 'native_clear_offline_lockout')).toBe(0);
    }
  });

  it('5. callable succeeds but native clear fails/uncertain: terminal, no retry, no second issuance', async () => {
    const clears: Array<unknown | (() => unknown)> = [
      { ok: false, managerStaffId: MANAGER, reopensNow: false, cooldownRemainingMs: 0, errorCode: 'DENIED_UNVERIFIABLE' },
      { ok: true, managerStaffId: MANAGER, reopensNow: false, cooldownRemainingMs: 1000, errorCode: null },
      { ok: true, managerStaffId: 'otherMgr', reopensNow: true, cooldownRemainingMs: 0, errorCode: null },
      () => {
        throw new Error('ipc');
      },
    ];
    for (const clear of clears) {
      __resetPrivilegedLockoutRecoveryForTests();
      const log: Log = [];
      const calls: IssueLockoutClearRequest[] = [];
      const out = await runPrivilegedLockoutRecovery(
        { managerStaffId: MANAGER, operator: ADMIN },
        { invoke: fakeNative(log, { clear }), issueLockoutClear: fakeIssue(calls), isPrimaryAdminPrincipal: primaryAdmin },
      );
      expect(out).toEqual({ kind: 'failed' });
      expect(calls).toHaveLength(1);
      expect(count(log, 'native_clear_offline_lockout')).toBe(1);
    }

    // Native reports success but the re-read still shows a lockout: not success.
    const log: Log = [];
    const calls: IssueLockoutClearRequest[] = [];
    const out = await runPrivilegedLockoutRecovery(
      { managerStaffId: MANAGER, operator: ADMIN },
      {
        invoke: fakeNative(log, { contexts: [lockedContext(), lockedContext()] }),
        issueLockoutClear: fakeIssue(calls),
        isPrimaryAdminPrincipal: primaryAdmin,
      },
    );
    expect(out).toEqual({ kind: 'failed' });
    expect(calls).toHaveLength(1);
    expect(count(log, 'native_clear_offline_lockout')).toBe(1);
  });

  it('6. manager-id mismatch between selection and native context: stop before the callable', async () => {
    const contexts = [lockedContext({ managerStaffId: 'otherMgr' }), lockedContext({ securityDeviceIdHex: 'XYZ' })];
    for (const ctx of contexts) {
      __resetPrivilegedLockoutRecoveryForTests();
      const log: Log = [];
      const calls: IssueLockoutClearRequest[] = [];
      const out = await runPrivilegedLockoutRecovery(
        { managerStaffId: MANAGER, operator: ADMIN },
        { invoke: fakeNative(log, { contexts: [ctx] }), issueLockoutClear: fakeIssue(calls), isPrimaryAdminPrincipal: primaryAdmin },
      );
      expect(out).toEqual({ kind: 'failed' });
      expect(calls).toHaveLength(0);
      expect(count(log, 'native_clear_offline_lockout')).toBe(0);
    }

    // Non-canonical target or the admin targeting itself: nothing at all is called.
    for (const managerStaffId of ['', 'a b', '../x', ADMIN.id]) {
      const log: Log = [];
      const calls: IssueLockoutClearRequest[] = [];
      const out = await runPrivilegedLockoutRecovery(
        { managerStaffId, operator: ADMIN },
        { invoke: fakeNative(log), issueLockoutClear: fakeIssue(calls), isPrimaryAdminPrincipal: primaryAdmin },
      );
      expect(out).toEqual({ kind: 'failed' });
      expect(calls).toHaveLength(0);
      expect(log).toHaveLength(0);
    }
  });

  it('not locked: no callable and no native clear', async () => {
    const log: Log = [];
    const calls: IssueLockoutClearRequest[] = [];
    const out = await runPrivilegedLockoutRecovery(
      { managerStaffId: MANAGER, operator: ADMIN },
      { invoke: fakeNative(log, { contexts: [NOT_LOCKED] }), issueLockoutClear: fakeIssue(calls), isPrimaryAdminPrincipal: primaryAdmin },
    );
    expect(out).toEqual({ kind: 'not_locked' });
    expect(calls).toHaveLength(0);
    expect(count(log, 'native_clear_offline_lockout')).toBe(0);
  });

  it('a concurrent second episode is refused without any call', async () => {
    const log: Log = [];
    const calls: IssueLockoutClearRequest[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowIssue = async (req: IssueLockoutClearRequest) => {
      calls.push(req);
      await gate;
      return issuedOk();
    };
    const deps = { invoke: fakeNative(log), issueLockoutClear: slowIssue, isPrimaryAdminPrincipal: primaryAdmin };
    const first = runPrivilegedLockoutRecovery({ managerStaffId: MANAGER, operator: ADMIN }, deps);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = await runPrivilegedLockoutRecovery({ managerStaffId: MANAGER, operator: ADMIN }, deps);
    expect(second).toEqual({ kind: 'failed' });
    release();
    expect(await first).toEqual({ kind: 'recovered' });
    expect(calls).toHaveLength(1);
    expect(count(log, 'native_clear_offline_lockout')).toBe(1);
  });

  it('7. success invokes no OAC, enrollment, PIN or staff-session native command', async () => {
    const log: Log = [];
    await runPrivilegedLockoutRecovery(
      { managerStaffId: MANAGER, operator: ADMIN },
      { invoke: fakeNative(log), issueLockoutClear: fakeIssue([]), isPrimaryAdminPrincipal: primaryAdmin },
    );
    expect(new Set(log.map((e) => e.cmd))).toEqual(
      new Set(['native_get_privileged_lockout_recovery_context', 'native_clear_offline_lockout']),
    );

    const src = readFileSync(resolve(__dirname, 'privilegedLockoutRecovery.ts'), 'utf8');
    for (const forbidden of [
      'native_complete_oac_provisioning',
      'native_persist_oac_reanchor',
      'native_verify_offline_pin',
      'native_attest_privileged_action',
      'native_import_device_enrollment_file',
      'native_generate_device_registration_proof',
      'native_finalize_device_enrollment',
      'native_abandon_device_enrollment_staging',
      'native_clear_staff_session',
      'native_persist_staff_session_assertion',
      'beginPrivilegedOacIssuanceSession',
      'completePrivilegedOacIssuanceSession',
      'verifyPinLogin',
      'reEnrollPrivilegedDevice',
      'signInAnonymously',
      'signInWithCustomToken',
      'managerApprovalPrincipal',
      'firebase/firestore',
    ]) {
      expect(src.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('8. never logs or returns ids, tokens or raw codes', async () => {
    const outcomes = [];
    outcomes.push(
      await runPrivilegedLockoutRecovery(
        { managerStaffId: MANAGER, operator: ADMIN },
        { invoke: fakeNative([]), issueLockoutClear: fakeIssue([]), isPrimaryAdminPrincipal: primaryAdmin },
      ),
    );
    outcomes.push(
      await runPrivilegedLockoutRecovery(
        { managerStaffId: MANAGER, operator: ADMIN },
        {
          invoke: fakeNative([], {
            clear: { ok: false, managerStaffId: MANAGER, reopensNow: false, cooldownRemainingMs: 0, errorCode: 'DENIED_UNVERIFIABLE' },
          }),
          issueLockoutClear: fakeIssue([]),
          isPrimaryAdminPrincipal: primaryAdmin,
        },
      ),
    );
    outcomes.push(await readPrivilegedLockoutStatus(MANAGER, { invoke: fakeNative([]) }));
    const text = JSON.stringify(outcomes);
    for (const secret of [DEVICE, LOCKOUT, LCT1, 'DENIED_UNVERIFIABLE', 'NOT_LOCKED', 'not_authorized']) {
      expect(text.includes(secret), secret).toBe(false);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();

    const src = readFileSync(resolve(__dirname, 'privilegedLockoutRecovery.ts'), 'utf8');
    expect(src).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|analytics/);
  });
});

describe('readPrivilegedLockoutStatus (display-safe)', () => {
  it('maps the native context to locked / not_locked / unavailable without identifiers', async () => {
    expect(await readPrivilegedLockoutStatus(MANAGER, { invoke: fakeNative([], { contexts: [lockedContext({ cooldownRemainingMs: 5 })] }) })).toEqual({
      kind: 'locked',
      cooldownRemainingMs: 5,
    });
    expect(await readPrivilegedLockoutStatus(MANAGER, { invoke: fakeNative([], { contexts: [NOT_LOCKED] }) })).toEqual({ kind: 'not_locked' });
    expect(
      await readPrivilegedLockoutStatus(MANAGER, { invoke: fakeNative([], { contexts: [{ ...NOT_LOCKED, errorCode: 'DENIED_UNVERIFIABLE' }] }) }),
    ).toEqual({ kind: 'unavailable' });
    expect(await readPrivilegedLockoutStatus(MANAGER, { invoke: null })).toEqual({ kind: 'unavailable' });
    expect(await readPrivilegedLockoutStatus('../x', { invoke: fakeNative([]) })).toEqual({ kind: 'unavailable' });
  });
});
