/**
 * TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002 — D-V6/D-V7 JIT OAC
 * ceremony helper. Uses an injected fake secondary Firebase factory and a fake
 * native bridge: no live Firebase, no real native.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetProvisionManagerOacForTests,
  provisionManagerOac,
  type NativeInvoke,
} from './provisionManagerOac';
import type { SecondaryFirebaseContext, SecondaryFirebaseFactory } from '../../auth/managerApprovalPrincipal';

vi.mock('../../firebase', () => ({
  app: undefined,
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));

const MANAGER = 'mgr-1';
const BRANCH = 'LDP-001';
const DEVICE = 'ab'.repeat(16);
const PIN = '1234';

function oacBytesBase64(over: Record<string, unknown> = {}) {
  const json = JSON.stringify({ oacId: 'oac-1', managerStaffId: MANAGER, branchId: BRANCH, deviceId: DEVICE, ...over });
  return { json, b64: btoa(json) };
}

type CallLog = Array<{ name: string; data: unknown }>;

function fakeFactory(handlers: Record<string, (data: unknown) => unknown>, log: CallLog, disposed: { n: number }) {
  const factory: SecondaryFirebaseFactory = {
    create: (): SecondaryFirebaseContext => ({
      signInAnonymously: async () => undefined,
      call: async <Req, Res>(name: string, data: Req) => {
        log.push({ name, data });
        const h = handlers[name];
        if (!h) throw new Error(`unexpected callable ${name}`);
        return (await h(data)) as Res;
      },
      getClaims: async () => ({ staffId: MANAGER, role: 'manager', branchIds: [BRANCH] }),
      dispose: async () => {
        disposed.n += 1;
      },
    }),
  };
  return factory;
}

function happyHandlers(over: Record<string, (data: unknown) => unknown> = {}) {
  const oac = oacBytesBase64();
  return {
    verifyPinLogin: () => ({ success: true, user: { id: MANAGER } }),
    beginPrivilegedOacIssuanceSession: () => ({ ok: true, sessionId: 'sess-1', nonceBase64: 'bm9uY2U=', expiresAtMillis: 1 }),
    completePrivilegedOacIssuanceSession: () => ({ ok: true, oacEnvelopeBytesBase64: oac.b64, srf1OacBase64: 'c3JmMQ==' }),
    getOacKeysetManifest: () => ({ ok: true, oks1Base64: 'b2tzMQ==' }),
    ...over,
  };
}

function nativeBridge(over: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const invoke = vi.fn<NativeInvoke>(async (cmd, args) => {
    if (cmd === 'native_get_device_registration_status') {
      return over.status ? over.status(args) : { securityDeviceIdHex: DEVICE, deviceKeyPresent: true, storedOacCount: 0 };
    }
    if (cmd === 'native_complete_oac_provisioning' && args?.phase === 'produce_proof') {
      return over.produce ? over.produce(args) : { ptp1Base64: 'cHRwMQ==', pin1Base64: 'cGluMQ==' };
    }
    if (cmd === 'native_complete_oac_provisioning' && args?.phase === 'persist_result') {
      return over.persist ? over.persist(args) : null;
    }
    throw new Error(`unexpected native ${cmd}`);
  });
  return invoke;
}

let log: CallLog;
let disposed: { n: number };

beforeEach(() => {
  __resetProvisionManagerOacForTests();
  log = [];
  disposed = { n: 0 };
});
afterEach(() => vi.restoreAllMocks());

const names = () => log.map((c) => c.name);

describe('provisionManagerOac', () => {
  it('runs the existing five-step ceremony exactly once for the selected manager and persists only that manager', async () => {
    const invoke = nativeBridge();
    const out = await provisionManagerOac(
      { managerStaffId: MANAGER, branchId: BRANCH, pin: PIN },
      { invoke, isOnline: () => true, principalFactory: fakeFactory(happyHandlers(), log, disposed) },
    );
    expect(out).toEqual({ kind: 'provisioned' });
    expect(names()).toEqual([
      'verifyPinLogin',
      'beginPrivilegedOacIssuanceSession',
      'completePrivilegedOacIssuanceSession',
      'getOacKeysetManifest',
    ]);
    expect(log[0]!.data).toEqual({ pin: PIN, branchId: BRANCH, userId: MANAGER });
    expect(log[1]!.data).toEqual({ securityDeviceIdHex: DEVICE });
    const nativeCalls = invoke.mock.calls.map((c) => [c[0], (c[1] as Record<string, unknown> | undefined)?.phase]);
    expect(nativeCalls).toEqual([
      ['native_get_device_registration_status', undefined],
      ['native_complete_oac_provisioning', 'produce_proof'],
      ['native_complete_oac_provisioning', 'persist_result'],
    ]);
    const produce = invoke.mock.calls[1]![1]!;
    expect(produce).toMatchObject({ managerStaffId: MANAGER, sessionId: 'sess-1', securityDeviceIdHex: DEVICE });
    const persist = invoke.mock.calls[2]![1]!;
    expect(persist.managerStaffId).toBe(MANAGER);
    // The exact server canonical bytes, decoded — never re-serialized.
    expect(persist.oacEnvelopeJson).toBe(oacBytesBase64().json);
    expect(disposed.n).toBe(1);
  });

  it('offline: no network call, no native call', async () => {
    const invoke = nativeBridge();
    const out = await provisionManagerOac(
      { managerStaffId: MANAGER, branchId: BRANCH, pin: PIN },
      { invoke, isOnline: () => false, principalFactory: fakeFactory(happyHandlers(), log, disposed) },
    );
    expect(out).toEqual({ kind: 'offline' });
    expect(log).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uncertain completion (transport failure): never replays complete, never persists', async () => {
    const invoke = nativeBridge();
    const out = await provisionManagerOac(
      { managerStaffId: MANAGER, branchId: BRANCH, pin: PIN },
      {
        invoke,
        isOnline: () => true,
        principalFactory: fakeFactory(
          happyHandlers({
            completePrivilegedOacIssuanceSession: () => {
              throw new Error('network');
            },
          }),
          log,
          disposed,
        ),
      },
    );
    expect(out).toEqual({ kind: 'uncertain' });
    expect(names().filter((n) => n === 'completePrivilegedOacIssuanceSession')).toHaveLength(1);
    expect(names().filter((n) => n === 'beginPrivilegedOacIssuanceSession')).toHaveLength(1);
    expect(invoke.mock.calls.some((c) => (c[1] as Record<string, unknown> | undefined)?.phase === 'persist_result')).toBe(false);
    expect(disposed.n).toBe(1);
  });

  it.each([
    ['invalid_pin', 'pin_rejected'],
    ['oac_provision_forbidden_legacy_pin4', 'not_eligible'],
    ['not_authorized', 'not_eligible'],
    ['device_branch_mismatch', 'device_not_ready'],
    ['session_already_consumed', 'failed'],
    ['session_expired', 'failed'],
  ] as const)('definite completion rejection %s -> %s, no retry, no persist', async (code, kind) => {
    const invoke = nativeBridge();
    const out = await provisionManagerOac(
      { managerStaffId: MANAGER, branchId: BRANCH, pin: PIN },
      {
        invoke,
        isOnline: () => true,
        principalFactory: fakeFactory(
          happyHandlers({ completePrivilegedOacIssuanceSession: () => ({ ok: false, code }) }),
          log,
          disposed,
        ),
      },
    );
    expect(out).toEqual({ kind });
    expect(names().filter((n) => n === 'completePrivilegedOacIssuanceSession')).toHaveLength(1);
    expect(invoke.mock.calls.some((c) => (c[1] as Record<string, unknown> | undefined)?.phase === 'persist_result')).toBe(false);
  });

  it('a server envelope bound to a different manager/branch/device is never persisted', async () => {
    for (const over of [{ managerStaffId: 'mgr-OTHER' }, { branchId: 'LDP-999' }, { deviceId: 'cd'.repeat(16) }]) {
      __resetProvisionManagerOacForTests();
      log = [];
      const invoke = nativeBridge();
      const bad = oacBytesBase64(over);
      const out = await provisionManagerOac(
        { managerStaffId: MANAGER, branchId: BRANCH, pin: PIN },
        {
          invoke,
          isOnline: () => true,
          principalFactory: fakeFactory(
            happyHandlers({
              completePrivilegedOacIssuanceSession: () => ({ ok: true, oacEnvelopeBytesBase64: bad.b64, srf1OacBase64: 'x' }),
            }),
            log,
            disposed,
          ),
        },
      );
      expect(out).toEqual({ kind: 'uncertain' });
      expect(invoke.mock.calls.some((c) => (c[1] as Record<string, unknown> | undefined)?.phase === 'persist_result')).toBe(false);
    }
  });

  it('verifyPinLogin refusal of the manager PIN: pin_rejected, no ceremony call at all', async () => {
    const invoke = nativeBridge();
    const out = await provisionManagerOac(
      { managerStaffId: MANAGER, branchId: BRANCH, pin: '9999' },
      {
        invoke,
        isOnline: () => true,
        principalFactory: fakeFactory(
          happyHandlers({
            verifyPinLogin: () => {
              throw Object.assign(new Error('denied'), { code: 'functions/permission-denied' });
            },
          }),
          log,
          disposed,
        ),
      },
    );
    expect(out).toEqual({ kind: 'pin_rejected' });
    expect(names()).toEqual(['verifyPinLogin']);
    expect(disposed.n).toBe(1);
  });

  it('a native keyset re-anchor refusal on persist maps to device_not_ready', async () => {
    const invoke = nativeBridge({
      persist: () => {
        throw 'PROVISIONING_MANIFEST_MISMATCH: supplied OKS1 keyset does not match';
      },
    });
    const out = await provisionManagerOac(
      { managerStaffId: MANAGER, branchId: BRANCH, pin: PIN },
      { invoke, isOnline: () => true, principalFactory: fakeFactory(happyHandlers(), log, disposed) },
    );
    expect(out).toEqual({ kind: 'device_not_ready' });
  });

  it('concurrent second ceremony is refused without any network or native call (single-flight)', async () => {
    let releaseBegin!: () => void;
    const gate = new Promise<void>((r) => (releaseBegin = r));
    const invoke = nativeBridge();
    const factory = fakeFactory(
      happyHandlers({
        beginPrivilegedOacIssuanceSession: async () => {
          await gate;
          return { ok: true, sessionId: 'sess-1', nonceBase64: 'bm9uY2U=', expiresAtMillis: 1 };
        },
      }),
      log,
      disposed,
    );
    const first = provisionManagerOac({ managerStaffId: MANAGER, branchId: BRANCH, pin: PIN }, { invoke, isOnline: () => true, principalFactory: factory });
    await vi.waitFor(() => expect(names()).toContain('beginPrivilegedOacIssuanceSession'));
    const callsBefore = log.length;
    const nativeBefore = invoke.mock.calls.length;
    const second = await provisionManagerOac({ managerStaffId: MANAGER, branchId: BRANCH, pin: PIN }, { invoke, isOnline: () => true, principalFactory: factory });
    expect(second).toEqual({ kind: 'failed' });
    expect(log.length).toBe(callsBefore);
    expect(invoke.mock.calls.length).toBe(nativeBefore);
    releaseBegin();
    expect(await first).toEqual({ kind: 'provisioned' });
    expect(names().filter((n) => n === 'beginPrivilegedOacIssuanceSession')).toHaveLength(1);
  });

  it('never logs the PIN or OAC material', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    const invoke = nativeBridge();
    await provisionManagerOac(
      { managerStaffId: MANAGER, branchId: BRANCH, pin: PIN },
      { invoke, isOnline: () => true, principalFactory: fakeFactory(happyHandlers(), log, disposed) },
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('ALL / empty branch or no native bridge fails closed before any call', async () => {
    expect(
      await provisionManagerOac({ managerStaffId: MANAGER, branchId: 'ALL', pin: PIN }, { invoke: nativeBridge(), isOnline: () => true, principalFactory: fakeFactory(happyHandlers(), log, disposed) }),
    ).toEqual({ kind: 'failed' });
    expect(
      await provisionManagerOac({ managerStaffId: MANAGER, branchId: BRANCH, pin: PIN }, { invoke: null, isOnline: () => true, principalFactory: fakeFactory(happyHandlers(), log, disposed) }),
    ).toEqual({ kind: 'device_not_ready' });
    expect(log).toEqual([]);
  });
});
