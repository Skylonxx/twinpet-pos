import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadCompletionIntent,
  recoverDeviceRegistrationCompletion,
  registerDevice,
  saveCompletionIntent,
  PENDING_COMPLETION_INTENT_SCHEMA,
  PENDING_COMPLETION_INTENT_STORAGE_KEY,
  PENDING_FINALIZATION_STORAGE_KEY,
  type PendingCompletionIntentV1,
} from './deviceRegistration';
import {
  claimEnrollmentGrantMinter,
  revokeEnrollmentGrant,
  takeEnrollmentGrant,
  type EnrollmentPreparationGrant,
} from './enrollmentGrant';
import { ensureFirebaseAuth } from '../firebaseAuth';

/**
 * TPOS-R7 pre-login enrollment: the non-injected (production) callable path of
 * registerDevice binds `beginDeviceRegistration` to the current UID, so it
 * runs ONLY with the one-shot grant minted by a completed AuthProvider
 * `prepareEnrollmentIdentity()` and never establishes or reuses an identity
 * itself. A caller-supplied UID or constructed object is never proof.
 * Registration needs only a Firebase UID — never staff claims. This suite
 * holds the (single) minter itself to drive the boundary directly; the
 * AuthProvider suite covers the real preparation that mints it.
 */

const h = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string; isAnonymous?: boolean } },
  begin: vi.fn(),
  complete: vi.fn(),
  beginCallers: [] as unknown[],
  readiness: vi.fn(async (): Promise<string> => 'NOT_ENROLLED'),
  current: true,
}));

vi.mock('../firebase', () => ({ auth: h.auth, app: {}, isFirebaseConfigured: true }));
vi.mock('../firebaseAuth', () => ({ ensureFirebaseAuth: vi.fn() }));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_fns: unknown, name: string) =>
    name === 'beginDeviceRegistration' ? h.begin : name === 'completeDeviceRegistration' ? h.complete : vi.fn(),
  ),
}));

const mockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true, configurable: true });

const mockEnsure = vi.mocked(ensureFirebaseAuth);
const SESSION_KEY = 'twinpet_session';
const STALE_ADMIN_SESSION = JSON.stringify({
  schemaVersion: 1,
  issuedAt: 1,
  user: {
    id: 'admin-uid', username: 'admin', firstName: 'A', lastName: 'A', role: 'admin',
    branchIds: ['ALL'], isActive: true, deletedAt: null,
  },
  branchId: 'ALL',
});
const minter = claimEnrollmentGrantMinter();
/** A grant exactly as a completed preparation for `requesterUid` mints it. */
const mint = (requesterUid = 'anon-enroll-uid') =>
  minter({ requesterUid, isPreparationCurrent: () => h.current, readDeviceReadiness: h.readiness });
const AUTH_ID = '0123456789abcdef0123456789abcdef';
const nativeInvoke = vi.fn();

const INTENT: PendingCompletionIntentV1 = {
  schema: PENDING_COMPLETION_INTENT_SCHEMA,
  version: 1,
  registrationSessionId: '11'.repeat(16),
  drp1Base64: Buffer.alloc(185, 7).toString('base64'),
  enrollmentGenerationId: '22'.repeat(16),
  stagedPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
};

beforeEach(() => {
  localStorage.clear();
  h.auth.currentUser = null;
  h.begin.mockReset();
  h.complete.mockReset();
  h.beginCallers = [];
  h.readiness.mockReset().mockResolvedValue('NOT_ENROLLED');
  h.current = true;
  revokeEnrollmentGrant();
  nativeInvoke.mockReset();
  mockEnsure.mockReset();
  mockEnsure.mockImplementation(async () => {
    h.auth.currentUser = { uid: 'anon-prelogin-uid' };
  });
});

describe('registerDevice — first-enrollment begin boundary requires a one-shot preparation grant (TPOS-R7)', () => {
  const ANON = { uid: 'anon-enroll-uid', isAnonymous: true };
  const PASSWORD = { uid: 'admin-uid', isAnonymous: false };
  const RECOVERY_CASES: Array<[string, Record<string, string>]> = [
    ['finalization pending', { [PENDING_FINALIZATION_STORAGE_KEY]: '{"enrollmentGenerationId":"g"}' }],
    ['completion intent pending', { [PENDING_COMPLETION_INTENT_STORAGE_KEY]: JSON.stringify(INTENT) }],
    ['malformed recovery bytes', { [PENDING_COMPLETION_INTENT_STORAGE_KEY]: 'not-json' }],
    [
      'conflict (both keys)',
      {
        [PENDING_FINALIZATION_STORAGE_KEY]: '{"enrollmentGenerationId":"a"}',
        [PENDING_COMPLETION_INTENT_STORAGE_KEY]: '{"enrollmentGenerationId":"b"}',
      },
    ],
  ];

  const register = (enrollmentGrant?: unknown) =>
    registerDevice(AUTH_ID, {
      customInvoke: nativeInvoke,
      enrollmentGrant: enrollmentGrant as EnrollmentPreparationGrant | undefined,
    });

  function expectNoBegin() {
    expect(h.begin).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(nativeInvoke).not.toHaveBeenCalled();
  }

  function seed(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }
  function expectUnchanged(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) expect(localStorage.getItem(k)).toBe(v);
  }

  beforeEach(() => {
    h.auth.currentUser = ANON;
    h.begin.mockImplementation(async () => {
      h.beginCallers.push(h.auth.currentUser);
      return { data: { ok: false, code: 'test_stop_after_begin' } };
    });
  });

  describe('A/B/C. direct call that knows the anonymous UID but never prepared', () => {
    it.each([
      ['no grant', undefined],
      ['the UID string itself', ANON.uid],
      ['a constructed object carrying the UID', { requesterUid: ANON.uid }],
      ['a constructed "prepared" marker', { prepared: true, requesterUid: ANON.uid }],
      ['an empty frozen object shaped like a grant', Object.freeze(Object.create(null))],
    ])('A. clean recovery, no session, %s → enrollment_identity_not_prepared, zero begin', async (_l, forged) => {
      expect(await register(forged)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
      expectNoBegin();
    });

    it('A2. a forged attempt does not consume or replace the genuine live grant', async () => {
      const grant = mint();
      expect(await register({ requesterUid: ANON.uid })).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
      expect(await register(grant)).toEqual({ ok: false, code: 'test_stop_after_begin' });
      expect(h.begin).toHaveBeenCalledTimes(1);
    });

    it('B. anonymous UID + stale admin twinpet_session, no preparation → zero begin, session untouched', async () => {
      localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
      expect(await register(ANON.uid)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
      expectNoBegin();
      expect(localStorage.getItem(SESSION_KEY)).toBe(STALE_ADMIN_SESSION);
    });

    it.each(RECOVERY_CASES)('C. anonymous UID + %s, no preparation → zero begin, recovery unchanged', async (_l, entries) => {
      seed(entries);
      expect(await register({ requesterUid: ANON.uid })).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
      expectNoBegin();
      expectUnchanged(entries);
    });
  });

  it('D. valid grant → begin exactly once under the exact prepared anonymous UID; grant consumed', async () => {
    const grant = mint();

    const result = await register(grant);

    expect(result).toEqual({ ok: false, code: 'test_stop_after_begin' });
    expect(h.begin).toHaveBeenCalledTimes(1);
    // begin carries no payload: the server binds the session to request.auth.uid only.
    expect(h.begin).toHaveBeenCalledWith();
    expect(h.beginCallers).toEqual([ANON]);
    expect(h.readiness).toHaveBeenCalledTimes(1);
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(takeEnrollmentGrant(grant)).toBeNull();
  });

  it('E. replay of a used grant → enrollment_identity_not_prepared, no second begin', async () => {
    const grant = mint();
    await register(grant);

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
    expect(h.begin).toHaveBeenCalledTimes(1);
  });

  it('E2. two concurrent uses of one grant (double submit) → exactly one begin', async () => {
    const grant = mint();

    const [a, b] = await Promise.all([register(grant), register(grant)]);

    expect(h.begin).toHaveBeenCalledTimes(1);
    expect([a, b]).toContainEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
    expect([a, b]).toContainEqual({ ok: false, code: 'test_stop_after_begin' });
  });

  it('E3. a newer preparation revokes the older grant', async () => {
    const older = mint();
    const newer = mint();

    expect(await register(older)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
    expect(await register(newer)).toEqual({ ok: false, code: 'test_stop_after_begin' });
    expect(h.begin).toHaveBeenCalledTimes(1);
  });

  it('E4. a rejected attempt still consumes the grant (one attempt per preparation)', async () => {
    const grant = mint();
    h.readiness.mockResolvedValueOnce('UNAVAILABLE');
    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_not_allowed' });

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
    expect(h.begin).not.toHaveBeenCalled();
  });

  describe('K. native bridge unavailable — the grant is consumed before the bridge check', () => {
    const TAURI_KEY = ['_', '_', 'T', 'A', 'U', 'R', 'I', '_', '_'].join('');
    const g = globalThis as unknown as Record<string, unknown>;
    /** Production lookup only: no customInvoke, so the real bridge probe decides. */
    const registerViaRealBridge = (enrollmentGrant?: unknown) =>
      registerDevice(AUTH_ID, { enrollmentGrant: enrollmentGrant as EnrollmentPreparationGrant | undefined });

    beforeEach(() => {
      delete g[TAURI_KEY];
    });
    afterEach(() => {
      delete g[TAURI_KEY];
    });

    it('K. bridge unavailable consumes a genuine grant; the same grant is refused once the bridge is back', async () => {
      const grant = mint();

      expect(await registerViaRealBridge(grant)).toEqual({ ok: false, code: 'native_bridge_unavailable' });
      expectNoBegin();
      expect(h.readiness).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY)).toBeNull();

      g[TAURI_KEY] = { core: { invoke: nativeInvoke } };

      expect(await registerViaRealBridge(grant)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
      expectNoBegin();
      expect(h.readiness).not.toHaveBeenCalled();
      expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY)).toBeNull();
      expect(takeEnrollmentGrant(grant)).toBeNull();
    });

    it.each([
      ['no grant', undefined],
      ['a constructed object carrying the UID', { requesterUid: ANON.uid }],
    ])('K2. bridge unavailable + %s → enrollment_identity_not_prepared before bridge status; live grant kept', async (_l, forged) => {
      const grant = mint();

      expect(await registerViaRealBridge(forged)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
      expectNoBegin();

      g[TAURI_KEY] = { core: { invoke: nativeInvoke } };
      expect(await registerViaRealBridge(grant)).toEqual({ ok: false, code: 'test_stop_after_begin' });
      expect(h.begin).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['a different anonymous UID', { uid: 'anon-other', isAnonymous: true }],
    ['a password UID', PASSWORD],
    ['no Firebase user', null],
  ])('F. identity changed after preparation to %s → enrollment_identity_not_anonymous, zero begin', async (_l, user) => {
    const grant = mint();
    h.auth.currentUser = user;

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_identity_not_anonymous' });
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.auth.currentUser).toEqual(user);
  });

  it('F2. identity changes while the boundary awaits readiness → zero begin', async () => {
    const grant = mint();
    h.readiness.mockImplementationOnce(async () => {
      h.auth.currentUser = PASSWORD;
      return 'NOT_ENROLLED';
    });

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_identity_not_anonymous' });
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('F3. preparation superseded by a newer auth operation (PIN/password/logout) → zero begin', async () => {
    h.current = false;
    const grant = mint();

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('F4. supersession that happens while the boundary awaits readiness → zero begin', async () => {
    const grant = mint();
    h.readiness.mockImplementationOnce(async () => {
      h.current = false;
      return 'NOT_ENROLLED';
    });

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
    expect(h.begin).not.toHaveBeenCalled();
  });

  it.each(RECOVERY_CASES)('G. %s appears after preparation → enrollment_recovery_pending, recovery unchanged', async (_l, entries) => {
    const grant = mint();
    seed(entries);

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_recovery_pending' });
    expect(h.begin).not.toHaveBeenCalled();
    expectUnchanged(entries);
  });

  it('G2. recovery storage unreadable at the boundary → fail closed, zero begin', async () => {
    const grant = mint();
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const result = await register(grant);
    getItem.mockRestore();

    expect(result).toEqual({ ok: false, code: 'enrollment_recovery_pending' });
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('H. twinpet_session written after preparation (e.g. a late restore) → enrollment_session_present', async () => {
    const grant = mint();
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_session_present' });
    expect(h.begin).not.toHaveBeenCalled();
    expect(localStorage.getItem(SESSION_KEY)).toBe(STALE_ADMIN_SESSION);
  });

  it.each(['READY', 'INVALID_OR_INCOMPLETE', 'UNAVAILABLE', 'not_native'])(
    'I. readiness %s at the boundary → enrollment_not_allowed, zero begin',
    async (readiness) => {
      const grant = mint();
      h.readiness.mockResolvedValueOnce(readiness);

      expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_not_allowed' });
      expect(h.begin).not.toHaveBeenCalled();
    },
  );

  it('I2. readiness read throws → enrollment_not_allowed, zero begin', async () => {
    const grant = mint();
    h.readiness.mockRejectedValueOnce(new Error('native raw failure'));

    expect(await register(grant)).toEqual({ ok: false, code: 'enrollment_not_allowed' });
    expect(h.begin).not.toHaveBeenCalled();
  });

  describe('J. runtime/test seams', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('an injected customCallables.beginDeviceRegistration is refused outside test mode', async () => {
      vi.stubEnv('MODE', 'production');
      const injected = vi.fn(async () => ({ data: { ok: true } }));

      const result = await registerDevice(AUTH_ID, {
        customInvoke: nativeInvoke,
        customCallables: { beginDeviceRegistration: injected },
      });

      expect(result).toEqual({ ok: false, code: 'enrollment_identity_not_prepared' });
      expect(injected).not.toHaveBeenCalled();
      expect(h.begin).not.toHaveBeenCalled();
      expect(nativeInvoke).not.toHaveBeenCalled();
    });

    it('the grant minter can be claimed only once (this suite already holds it)', () => {
      expect(() => claimEnrollmentGrantMinter()).toThrow();
    });
  });
});

describe('recoverDeviceRegistrationCompletion — recovery semantics preserved pre-login (TPOS-R7)', () => {
  it('does NOT mint a new Firebase identity: no user => not_authenticated, no replay, intent kept', async () => {
    saveCompletionIntent(INTENT);

    const result = await recoverDeviceRegistrationCompletion({ customInvoke: nativeInvoke });

    expect(result).toEqual({ ok: false, code: 'not_authenticated' });
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(loadCompletionIntent()).toEqual(INTENT);
  });

  it('with the original persisted Firebase user, replays the exact saved request once — no begin, no new proof', async () => {
    h.auth.currentUser = { uid: 'original-uid' };
    saveCompletionIntent(INTENT);
    h.complete.mockResolvedValue({ data: { ok: false, code: 'session_expired' } });

    await recoverDeviceRegistrationCompletion({ customInvoke: nativeInvoke });

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledWith({
      registrationSessionId: INTENT.registrationSessionId,
      drp1Base64: INTENT.drp1Base64,
      enrollmentGenerationId: INTENT.enrollmentGenerationId,
    });
    expect(nativeInvoke).not.toHaveBeenCalledWith('native_generate_device_registration_proof', expect.anything());
    // A rejected recovery never deletes the durable evidence.
    expect(loadCompletionIntent()).toEqual(INTENT);
  });
});
