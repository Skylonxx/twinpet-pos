import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * TPOS-R7 PIN identity isolation: verifyPinLogin may stamp PIN-resolved staff
 * claims ONLY onto an anonymous Firebase caller. A password / federated /
 * custom / malformed caller is rejected before any lookup, bcrypt compare,
 * setCustomUserClaims, or lastLoginAt write — even if a client bypasses the
 * client-side anonymous transition.
 */

const h = vi.hoisted(() => {
  type Doc = Record<string, unknown>;
  const docs = new Map<string, Doc>();
  const reads: string[] = [];
  const updates: Array<{ path: string; data: unknown }> = [];
  const setClaims = { fn: null as null | ((uid: string, claims: unknown) => Promise<void>) };

  function snap(id: string, data: Doc | undefined) {
    return { exists: data !== undefined, id, data: () => data };
  }

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          reads.push(`${name}/${id}`);
          return snap(id, docs.get(`${name}/${id}`));
        },
        update: async (data: unknown) => {
          updates.push({ path: `${name}/${id}`, data });
        },
      }),
      where: (_f1: string, _o1: string, username: unknown) => ({
        where: (_f2: string, _o2: string, branch: unknown) => ({
          where: () => ({
            limit: () => ({
              get: async () => {
                reads.push(`${name}?username=${String(username)}`);
                const out = [...docs.entries()]
                  .filter(([path]) => path.startsWith(`${name}/`))
                  .filter(([, d]) => d.username === username && (d.branchIds as string[]).includes(String(branch)))
                  .map(([path, d]) => ({ id: path.slice(name.length + 1), data: () => d }));
                return { docs: out };
              },
            }),
          }),
        }),
      }),
    }),
  };
  return { docs, reads, updates, setClaims, db };
});

const mockSetCustomUserClaims = vi.fn(async (_uid: string, _claims: unknown) => undefined);
const mockGetUser = vi.fn(async (_uid: string): Promise<unknown> => undefined);

vi.mock('../db', () => ({ db: h.db }));
vi.mock('../deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2', () => ({ setGlobalOptions: () => {} }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, fn: unknown) => fn,
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ setCustomUserClaims: mockSetCustomUserClaims, getUser: mockGetUser }),
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
  Timestamp: class Timestamp {},
}));

import {
  GENERIC_LOGIN_DENIED,
  PIN_SESSION_IDENTITY_REJECTED,
  isAnonymousPinCaller,
  isProviderlessPinAccount,
  verifyPinLogin,
} from '../index';

type Handler = (req: unknown) => Promise<{ success: boolean; user: { id: string } }>;
const handler = verifyPinLogin as unknown as Handler;

const STAFF_B_PIN = '4321';
const ADMIN_A_PIN = '9876';

/** A current, providerless anonymous Auth user record (what getUser returns). */
function providerlessRecord(uid: string) {
  return { uid, disabled: false, providerData: [], email: undefined, phoneNumber: undefined, multiFactor: undefined };
}

const ANON_AUTH = {
  uid: 'anon-pin-uid',
  token: { firebase: { sign_in_provider: 'anonymous', identities: {} } },
};
// Real password admin A: its legitimate claims must never be overwritten by PIN.
const PASSWORD_ADMIN_A_AUTH = {
  uid: 'admin-a',
  token: {
    email: 'admin@twinpet-pos.twinpet',
    staffId: 'admin-a',
    role: 'admin',
    branchIds: ['ALL'],
    firebase: { sign_in_provider: 'password', identities: { email: ['admin@twinpet-pos.twinpet'] } },
  },
};

function req(auth: unknown, username: string, pin: string) {
  return { auth, data: { pin, branchId: 'LDP-001', username } };
}

async function rejection(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  return p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: { code?: string; message: string }) => e,
  );
}

beforeAll(async () => {
  const staffHash = await bcrypt.hash(STAFF_B_PIN, 4);
  const adminHash = await bcrypt.hash(ADMIN_A_PIN, 4);
  h.docs.set('users/staff-b', {
    username: 'cashier', role: 'staff', branchIds: ['LDP-001'], isActive: true, deletedAt: null,
    firstName: 'B', lastName: 'Staff', authVersion: 2, permissions: {},
  });
  h.docs.set('userCredentials/staff-b', { pinHash: staffHash, credentialState: 'rotated_authoritative', disabled: false });
  h.docs.set('users/admin-a', {
    username: 'admin', role: 'admin', branchIds: ['ALL'], isActive: true, deletedAt: null,
    firstName: 'A', lastName: 'Admin', authVersion: 3, permissions: {},
  });
  h.docs.set('userCredentials/admin-a', { pinHash: adminHash, credentialState: 'rotated_authoritative', disabled: false });
});

let compareSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mockSetCustomUserClaims.mockClear();
  mockGetUser.mockReset().mockImplementation(async (uid: string) => providerlessRecord(uid));
  h.reads.length = 0;
  h.updates.length = 0;
  compareSpy?.mockRestore();
  compareSpy = vi.spyOn(bcrypt, 'compare');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function expectZeroPinWork() {
  expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  expect(h.updates).toEqual([]);
  expect(compareSpy).not.toHaveBeenCalled();
  expect(h.reads).toEqual([]);
}

describe('verifyPinLogin provider guard — anonymous caller (unchanged behavior)', () => {
  test('anonymous + valid PIN: claims stamped on the anonymous UID, lastLoginAt updated', async () => {
    const out = await handler(req(ANON_AUTH, 'cashier', STAFF_B_PIN));

    expect(out.success).toBe(true);
    expect(out.user.id).toBe('staff-b');
    expect(mockSetCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('anon-pin-uid', {
      staffId: 'staff-b',
      role: 'staff',
      branchIds: ['LDP-001'],
      permissions: ['pos_sale', 'product_view'],
      authVersion: 2,
    });
    expect(h.updates).toEqual([{ path: 'users/staff-b', data: { lastLoginAt: { __fv: 'ts' } } }]);
  });

  test('anonymous + wrong PIN: generic permission-denied, no claims, no lastLoginAt', async () => {
    const err = await rejection(handler(req(ANON_AUTH, 'cashier', '0000')));

    expect(err.code).toBe('permission-denied');
    expect(err.message).toBe(GENERIC_LOGIN_DENIED);
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  test('no auth at all: unauthenticated (unchanged)', async () => {
    const err = await rejection(handler(req(undefined, 'cashier', STAFF_B_PIN)));
    expect(err.code).toBe('unauthenticated');
    expectZeroPinWork();
  });

  test('anonymous + malformed PIN: invalid-argument (unchanged)', async () => {
    const err = await rejection(handler(req(ANON_AUTH, 'cashier', '12a4')));
    expect(err.code).toBe('invalid-argument');
    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });
});

describe('verifyPinLogin provider guard — password caller never receives PIN claims', () => {
  test('password admin A + staff B valid PIN: rejected before lookup; zero claims / lastLoginAt / bcrypt', async () => {
    const err = await rejection(handler(req(PASSWORD_ADMIN_A_AUTH, 'cashier', STAFF_B_PIN)));

    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe(PIN_SESSION_IDENTITY_REJECTED);
    expectZeroPinWork();
  });

  test('password caller + invalid PIN: byte-identical rejection (no PIN/identity oracle)', async () => {
    const valid = await rejection(handler(req(PASSWORD_ADMIN_A_AUTH, 'cashier', STAFF_B_PIN)));
    const invalid = await rejection(handler(req(PASSWORD_ADMIN_A_AUTH, 'cashier', '0000')));
    const ghost = await rejection(handler(req(PASSWORD_ADMIN_A_AUTH, 'nobody', '0000')));

    expect([invalid.code, invalid.message]).toEqual([valid.code, valid.message]);
    expect([ghost.code, ghost.message]).toEqual([valid.code, valid.message]);
    expect(invalid.message).not.toBe(GENERIC_LOGIN_DENIED);
    expectZeroPinWork();
  });

  test("same staff: password admin A with admin A's own valid PIN is still rejected (modes isolated, not UID equality)", async () => {
    const err = await rejection(handler(req(PASSWORD_ADMIN_A_AUTH, 'admin', ADMIN_A_PIN)));

    expect(err.code).toBe('failed-precondition');
    expectZeroPinWork();
  });

  test('the same admin PIN under an anonymous identity succeeds and stamps the ANONYMOUS UID, never admin-a', async () => {
    await handler(req(ANON_AUTH, 'admin', ADMIN_A_PIN));

    expect(mockSetCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(mockSetCustomUserClaims.mock.calls[0]![0]).toBe('anon-pin-uid');
    expect(mockSetCustomUserClaims.mock.calls.some((c) => c[0] === 'admin-a')).toBe(false);
  });
});

describe('verifyPinLogin provider guard — missing / unknown provider metadata fails closed', () => {
  const cases: Array<[string, unknown]> = [
    ['no token', { uid: 'u1' }],
    ['token without firebase', { uid: 'u1', token: {} }],
    ['firebase is not an object', { uid: 'u1', token: { firebase: 'anonymous' } }],
    ['missing sign_in_provider', { uid: 'u1', token: { firebase: { identities: {} } } }],
    ['non-string provider', { uid: 'u1', token: { firebase: { sign_in_provider: 1, identities: {} } } }],
    ['custom token', { uid: 'u1', token: { firebase: { sign_in_provider: 'custom', identities: {} } } }],
    ['google.com', { uid: 'u1', token: { firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['x'] } } } }],
    ['phone', { uid: 'u1', token: { firebase: { sign_in_provider: 'phone', identities: { phone: ['+66'] } } } }],
    ['case-variant "Anonymous"', { uid: 'u1', token: { firebase: { sign_in_provider: 'Anonymous', identities: {} } } }],
    ['anonymous with linked identities', { uid: 'u1', token: { firebase: { sign_in_provider: 'anonymous', identities: { email: ['x@y'] } } } }],
    ['anonymous with identities null', { uid: 'u1', token: { firebase: { sign_in_provider: 'anonymous', identities: null } } }],
    ['anonymous with identities array', { uid: 'u1', token: { firebase: { sign_in_provider: 'anonymous', identities: [] } } }],
    ['anonymous with primitive identities', { uid: 'u1', token: { firebase: { sign_in_provider: 'anonymous', identities: 'x' } } }],
    ['password', { uid: 'u1', token: { firebase: { sign_in_provider: 'password', identities: {} } } }],
    ['apple.com', { uid: 'u1', token: { firebase: { sign_in_provider: 'apple.com', identities: {} } } }],
    ['oidc.custom', { uid: 'u1', token: { firebase: { sign_in_provider: 'oidc.custom', identities: {} } } }],
  ];

  test.each(cases)('%s → failed-precondition, zero PIN work', async (_label, auth) => {
    const err = await rejection(handler(req(auth, 'cashier', STAFF_B_PIN)));

    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe(PIN_SESSION_IDENTITY_REJECTED);
    expectZeroPinWork();
  });

  test('isAnonymousPinCaller accepts only canonical anonymous metadata', () => {
    expect(isAnonymousPinCaller(ANON_AUTH)).toBe(true);
    expect(isAnonymousPinCaller({ token: { firebase: { sign_in_provider: 'anonymous' } } })).toBe(true);
    expect(isAnonymousPinCaller(PASSWORD_ADMIN_A_AUTH)).toBe(false);
    expect(isAnonymousPinCaller(undefined)).toBe(false);
    for (const [, auth] of cases) expect(isAnonymousPinCaller(auth as never)).toBe(false);
  });
});

describe('verifyPinLogin provider guard — token identities may be absent', () => {
  test('anonymous token with identities ABSENT + providerless account + valid PIN: success', async () => {
    const auth = { uid: 'anon-no-ids', token: { firebase: { sign_in_provider: 'anonymous' } } };
    const out = await handler(req(auth, 'cashier', STAFF_B_PIN));

    expect(out.success).toBe(true);
    expect(mockGetUser).toHaveBeenCalledWith('anon-no-ids');
    expect(mockSetCustomUserClaims.mock.calls.map((c) => c[0])).toEqual(['anon-no-ids']);
  });
});

describe('verifyPinLogin live account check — linked / upgraded account never receives PIN claims', () => {
  const linked: Array<[string, (uid: string) => unknown]> = [
    ['providerData non-empty (password linked)', (uid) => ({
      ...providerlessRecord(uid),
      providerData: [{ providerId: 'password', uid: 'a@b' }],
    })],
    ['providerData non-empty (google.com linked)', (uid) => ({
      ...providerlessRecord(uid),
      providerData: [{ providerId: 'google.com', uid: 'g1' }],
    })],
    ['email attached', (uid) => ({ ...providerlessRecord(uid), email: 'admin@twinpet-pos.twinpet' })],
    ['phone attached', (uid) => ({ ...providerlessRecord(uid), phoneNumber: '+66800000000' })],
    // Rejection-only extra signal; NOT an independent no-password proof.
    ['non-empty passwordHash present (rejection-only signal)', (uid) => ({ ...providerlessRecord(uid), passwordHash: 'x' })],
    ['MFA factor enrolled', (uid) => ({ ...providerlessRecord(uid), multiFactor: { enrolledFactors: [{ uid: 'f' }] } })],
    ['MFA malformed: null', (uid) => ({ ...providerlessRecord(uid), multiFactor: null })],
    ['MFA malformed: primitive string', (uid) => ({ ...providerlessRecord(uid), multiFactor: 'none' })],
    ['MFA malformed: primitive number', (uid) => ({ ...providerlessRecord(uid), multiFactor: 0 })],
    ['MFA malformed: primitive false', (uid) => ({ ...providerlessRecord(uid), multiFactor: false })],
    ['MFA malformed: array', (uid) => ({ ...providerlessRecord(uid), multiFactor: [] })],
    ['MFA malformed: {}', (uid) => ({ ...providerlessRecord(uid), multiFactor: {} })],
    ['MFA malformed: { enrolledFactors: undefined }', (uid) => ({ ...providerlessRecord(uid), multiFactor: { enrolledFactors: undefined } })],
    ['MFA malformed: { enrolledFactors: null }', (uid) => ({ ...providerlessRecord(uid), multiFactor: { enrolledFactors: null } })],
    ['MFA malformed: { enrolledFactors: {} }', (uid) => ({ ...providerlessRecord(uid), multiFactor: { enrolledFactors: {} } })],
    ['MFA malformed: { enrolledFactors: "x" }', (uid) => ({ ...providerlessRecord(uid), multiFactor: { enrolledFactors: 'x' } })],
    ['disabled account', (uid) => ({ ...providerlessRecord(uid), disabled: true })],
    ['providerData missing (ambiguous shape)', (uid) => ({ uid, disabled: false })],
    ['record for a different uid', () => providerlessRecord('someone-else')],
    ['null record', () => null],
  ];

  test.each(linked)(
    'OLD anonymous token + current record "%s" + valid PIN → failed-precondition before any PIN work',
    async (_label, record) => {
      mockGetUser.mockImplementation(async (uid: string) => record(uid));

      const err = await rejection(handler(req(ANON_AUTH, 'cashier', STAFF_B_PIN)));

      expect(err.code).toBe('failed-precondition');
      expect(err.message).toBe(PIN_SESSION_IDENTITY_REJECTED);
      expect(mockGetUser).toHaveBeenCalledWith('anon-pin-uid');
      expectZeroPinWork();
    },
  );

  test('upgraded account: valid PIN, wrong PIN and malformed PIN are byte-identical (no oracle)', async () => {
    mockGetUser.mockImplementation(async (uid: string) => ({ ...providerlessRecord(uid), email: 'x@y' }));

    const a = await rejection(handler(req(ANON_AUTH, 'cashier', STAFF_B_PIN)));
    const b = await rejection(handler(req(ANON_AUTH, 'cashier', '0000')));
    const c = await rejection(handler(req(ANON_AUTH, 'nobody', '12x')));

    expect([b.code, b.message]).toEqual([a.code, a.message]);
    expect([c.code, c.message]).toEqual([a.code, a.message]);
    expectZeroPinWork();
  });

  test.each([
    ['user-not-found', () => Object.assign(new Error('no user'), { code: 'auth/user-not-found' })],
    ['transient Admin error', () => new Error('ECONNRESET')],
  ])('getUser failure (%s) → same identity rejection, zero PIN work', async (_label, makeErr) => {
    mockGetUser.mockImplementation(async () => {
      throw makeErr();
    });

    const err = await rejection(handler(req(ANON_AUTH, 'cashier', STAFF_B_PIN)));

    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe(PIN_SESSION_IDENTITY_REJECTED);
    expectZeroPinWork();
  });

  test('non-anonymous tokens are rejected WITHOUT a live lookup', async () => {
    await rejection(handler(req(PASSWORD_ADMIN_A_AUTH, 'cashier', STAFF_B_PIN)));
    await rejection(handler(req({ uid: 'c', token: { firebase: { sign_in_provider: 'custom', identities: {} } } }, 'cashier', STAFF_B_PIN)));
    await rejection(handler(req({ uid: 'g', token: { firebase: { sign_in_provider: 'google.com', identities: {} } } }, 'cashier', STAFF_B_PIN)));

    expect(mockGetUser).not.toHaveBeenCalled();
    expectZeroPinWork();
  });

  test('live check runs before Firestore reads, bcrypt, claims and lastLoginAt (call order)', async () => {
    await handler(req(ANON_AUTH, 'cashier', STAFF_B_PIN));

    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(mockGetUser.mock.invocationCallOrder[0]).toBeLessThan(compareSpy.mock.invocationCallOrder[0]!);
    expect(mockGetUser.mock.invocationCallOrder[0]).toBeLessThan(mockSetCustomUserClaims.mock.invocationCallOrder[0]!);
  });

  test('isProviderlessPinAccount: only a providerless, enabled, same-uid record passes', () => {
    expect(isProviderlessPinAccount(providerlessRecord('u') as never, 'u')).toBe(true);
    expect(isProviderlessPinAccount({ ...providerlessRecord('u'), email: '' } as never, 'u')).toBe(true);
    for (const [, record] of linked) expect(isProviderlessPinAccount(record('u') as never, 'u')).toBe(false);
    expect(isProviderlessPinAccount(undefined, 'u')).toBe(false);
  });

  test('normal providerless anonymous record shapes pass (MFA absent or present-and-empty)', () => {
    // Shape getUser() returns for a plain anonymous user: no email / phone /
    // multiFactor keys at all, providerData [].
    const plainAnon = {
      uid: 'u',
      disabled: false,
      emailVerified: false,
      providerData: [],
      metadata: { creationTime: 'x', lastSignInTime: 'y' },
      tokensValidAfterTime: 'z',
    };
    expect(isProviderlessPinAccount(plainAnon as never, 'u')).toBe(true);
    expect(isProviderlessPinAccount({ ...plainAnon, multiFactor: { enrolledFactors: [] } } as never, 'u')).toBe(true);
    // passwordHash absent / '' is accepted only because it is NOT treated as
    // evidence either way; email + providerData + token provider are the guard.
    expect(isProviderlessPinAccount({ ...plainAnon, passwordHash: '' } as never, 'u')).toBe(true);
  });

  test('a password account is rejected via providerData / email even with no passwordHash from getUser()', () => {
    const pwAccount = {
      uid: 'u',
      disabled: false,
      email: 'admin@twinpet-pos.twinpet',
      providerData: [{ providerId: 'password', uid: 'admin@twinpet-pos.twinpet' }],
      // passwordHash intentionally absent, as getUser() typically returns it
    };
    expect(isProviderlessPinAccount(pwAccount as never, 'u')).toBe(false);
    expect(isProviderlessPinAccount({ ...pwAccount, email: undefined } as never, 'u')).toBe(false);
    expect(isProviderlessPinAccount({ ...pwAccount, providerData: [] } as never, 'u')).toBe(false);
  });

  test('normal providerless anonymous record with present-empty MFA → PIN login proceeds', async () => {
    mockGetUser.mockImplementation(async (uid: string) => ({ ...providerlessRecord(uid), multiFactor: { enrolledFactors: [] } }));

    const out = await handler(req(ANON_AUTH, 'cashier', STAFF_B_PIN));

    expect(out.success).toBe(true);
    expect(mockSetCustomUserClaims).toHaveBeenCalledTimes(1);
  });
});
