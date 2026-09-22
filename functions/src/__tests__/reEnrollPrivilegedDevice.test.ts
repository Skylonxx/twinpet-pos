import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performReEnrollPrivilegedDevice, MAX_DEVICE_KEY_VERSION } from '../reEnrollPrivilegedDevice';
import { performBeginDeviceRegistration } from '../deviceEnrollment';
import { drp1SignedPrefix, encodeDrp1 } from '../oacFrame';
import { decodeEfr1, EFR1_OP_RE_ENROLLMENT } from '../staffSessionAssertionFrame';
import { privateKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Deterministic injection seams for the atomicity tests. All of them are
 * test-local: no helper module is modified to create a seam.
 *
 * - `failDocRead` / `failCollectionQuery` reject a specific read, standing in
 *   for a Firestore deadline/quota/transient rejection.
 * - `beforeTransaction` runs once immediately before a transaction body, which
 *   is how the same-device concurrency and branch-race interleavings are
 *   produced without sleeps or real parallelism.
 */
interface FakeFirestoreControl {
  /** `"collection/docId"` whose `.get()` rejects. */
  failDocRead: string | null;
  /** Collection name whose `.where(...).get()` rejects. */
  failCollectionQuery: string | null;
  /** Fired once before the next transaction body, then cleared by the caller. */
  beforeTransaction: (() => void | Promise<void>) | null;
}

function genericFakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Map<string, unknown>>();
  for (const [collection, docs] of Object.entries(seed)) {
    store.set(collection, new Map(Object.entries(docs)));
  }
  const control: FakeFirestoreControl = {
    failDocRead: null,
    failCollectionQuery: null,
    beforeTransaction: null,
  };
  function coll(name: string): Map<string, unknown> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }
  function docHandle(collectionName: string, id: string) {
    return {
      get: async () => {
        if (control.failDocRead === `${collectionName}/${id}`) {
          throw new Error('injected_doc_read_failure');
        }
        const m = coll(collectionName);
        return { exists: m.has(id), data: () => m.get(id) };
      },
      set: (data: unknown) => coll(collectionName).set(id, data),
      update: (patch: Record<string, unknown>) =>
        coll(collectionName).set(id, { ...(coll(collectionName).get(id) as Record<string, unknown>), ...patch }),
    };
  }
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => docHandle(name, id),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => {
          if (control.failCollectionQuery === name) {
            throw new Error('injected_collection_query_failure');
          }
          return {
            docs: Array.from(coll(name).values())
              .filter((d) => (d as Record<string, unknown>)[field] === value)
              .map((d) => ({ data: () => d })),
          };
        },
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      if (control.beforeTransaction) {
        await control.beforeTransaction();
      }
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (d: unknown) => void }, data: unknown) => ref.set(data),
        update: (ref: { update: (p: unknown) => void }, patch: unknown) => ref.update(patch),
      };
      await fn(tx);
    },
  } as unknown as Firestore;
  return { db, store, control };
}

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

const ADMIN_STAFF_ID = 'admin-staff-1';
const STAFF_ID = 'staff-1';

function baseSeed(
  securityDeviceId: Buffer,
  initialKey: ReturnType<typeof rawKeypair>,
  signingKey: ReturnType<typeof rawKeypair> = rawKeypair(),
) {
  const deviceIdHex = securityDeviceId.toString('hex');
  return {
    users: {
      [ADMIN_STAFF_ID]: { role: 'admin', isActive: true, deletedAt: null, authVersion: 1 },
      [STAFF_ID]: { role: 'staff', isActive: true, deletedAt: null, authVersion: 1 },
    },
    privilegedDeviceRegistrations: {
      [deviceIdHex]: {
        securityDeviceIdHex: deviceIdHex,
        validatedSecurityDeviceId: securityDeviceId.toString('base64'),
        validatedDevProofPublicKeyBase64: Buffer.from(initialKey.publicKeyBase64Url, 'base64url').toString('base64'),
        devProofRegistrationNonce: Buffer.alloc(32, 0x11).toString('base64'),
        branchId: 'B-HQ',
        status: 'ACTIVE',
        deviceKeyVersion: 1,
        registeredAtServerMs: 1000,
      },
    },
    privilegedOacKeysetMeta: { current: { activeSigningKeyId: 'key-1' } },
    privilegedOacSigningKeys: {
      'key-1': {
        signingKeyId: 'key-1',
        publicKeyBase64Url: signingKey.publicKeyBase64Url,
        privateKeyBase64Url: signingKey.privateKeyBase64Url,
        status: 'ACTIVE',
      },
    },
  };
}

function buildSignedDrp1(nonce: Buffer, securityDeviceId: Buffer, device = rawKeypair()) {
  const devicePublicRaw = Buffer.from(device.publicKeyBase64Url, 'base64url');
  const unsigned = {
    enrollmentAuthId: '0'.repeat(32),
    deviceRegistrationNonce: nonce,
    securityDeviceId,
    devProofPublicKey: devicePublicRaw,
  };
  const prefix = drp1SignedPrefix(unsigned);
  const signature = ed25519Sign(null, prefix, privateKeyFromRaw(device.publicKeyBase64Url, device.privateKeyBase64Url));
  const drp1 = encodeDrp1({ ...unsigned, signature });
  return { drp1, device };
}

const DEVICES_COLLECTION = 'privilegedDeviceRegistrations';
const SESSIONS_COLLECTION = 'privilegedDeviceRegistrationSessions';

type Store = Map<string, Map<string, unknown>>;

function readDevice(store: Store, deviceIdHex: string): Record<string, unknown> {
  return store.get(DEVICES_COLLECTION)!.get(deviceIdHex) as Record<string, unknown>;
}

function readSession(store: Store, sessionId: string): Record<string, unknown> {
  return store.get(SESSIONS_COLLECTION)!.get(sessionId) as Record<string, unknown>;
}

function durableSnapshot(store: Store, deviceIdHex: string, sessionId: string) {
  return {
    device: JSON.stringify(readDevice(store, deviceIdHex) ?? null),
    session: JSON.stringify(readSession(store, sessionId) ?? null),
  };
}

/**
 * The atomicity invariant, asserted positively rather than by response shape:
 * a failure anywhere before the commit must leave the session PENDING and the
 * device registration byte-for-byte untouched, with no re-enrollment audit
 * field written.
 */
function expectDurableNoOp(
  store: Store,
  deviceIdHex: string,
  sessionId: string,
  before: ReturnType<typeof durableSnapshot>,
) {
  const device = readDevice(store, deviceIdHex);
  const session = readSession(store, sessionId);

  expect(session.status).toBe('PENDING');
  expect(device.reEnrolledAtServerMs).toBeUndefined();
  expect(device.reEnrolledByStaffId).toBeUndefined();
  expect(device.reEnrolledAt).toBeUndefined();

  const beforeDevice = JSON.parse(before.device) as Record<string, unknown>;
  expect(device.deviceKeyVersion).toBe(beforeDevice.deviceKeyVersion);
  expect(device.validatedDevProofPublicKeyBase64).toBe(beforeDevice.validatedDevProofPublicKeyBase64);
  expect(device.devProofRegistrationNonce).toBe(beforeDevice.devProofRegistrationNonce);

  // Whole-document equality, so a field this helper does not name explicitly
  // still cannot be mutated silently.
  expect(JSON.stringify(device)).toBe(before.device);
  expect(JSON.stringify(session)).toBe(before.session);
}

const ADMIN_AUTH = {
  uid: ADMIN_STAFF_ID,
  token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 },
};

/**
 * Builds a device + PENDING session + valid DRP1 that is ready to re-enroll,
 * plus a `call()` that invokes the function with those bindings.
 */
async function stagedReEnrollment(
  seedMutator?: (seed: ReturnType<typeof baseSeed>) => void,
) {
  const securityDeviceId = Buffer.alloc(16, 0x55);
  const deviceIdHex = securityDeviceId.toString('hex');
  const seed = baseSeed(securityDeviceId, rawKeypair());
  seedMutator?.(seed);
  const { db, store, control } = genericFakeFirestore(seed);

  const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
  if (!beginReg.ok) throw new Error('unreachable');
  const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
  const newKey = rawKeypair();
  const { drp1 } = buildSignedDrp1(nonce, securityDeviceId, newKey);

  const call = (overrides: Record<string, unknown> = {}, nowMs = 2100) =>
    performReEnrollPrivilegedDevice(
      db,
      ADMIN_AUTH,
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: 1,
        drp1Base64: drp1.toString('base64'),
        ...overrides,
      },
      nowMs,
    );

  return {
    db,
    store,
    control,
    securityDeviceId,
    deviceIdHex,
    sessionId: beginReg.registrationSessionId,
    newKey,
    call,
    snapshot: () => durableSnapshot(store, deviceIdHex, beginReg.registrationSessionId),
    expectNoOp: (before: ReturnType<typeof durableSnapshot>) =>
      expectDurableNoOp(store, deviceIdHex, beginReg.registrationSessionId, before),
  };
}

describe('reEnrollPrivilegedDevice', () => {
  const originalEnv = process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;

  beforeEach(() => {
    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = Buffer.alloc(32, 0x5a).toString('base64url');
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = originalEnv;
    } else {
      delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    }
  });

  it('fails closed with a durable no-op when root signing key secret is unavailable', async () => {
    delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    const staged = await stagedReEnrollment();
    const before = staged.snapshot();

    const res = await staged.call();

    expect(res).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
    staged.expectNoOp(before);
  });

  it('denies unauthenticated caller', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, rawKeypair()));
    const res = await performReEnrollPrivilegedDevice(db, null, {});
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('denies non-admin caller', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, rawKeypair()));
    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: STAFF_ID, token: { staffId: STAFF_ID, role: 'staff', authVersion: 1 } },
      {},
    );
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('denies UID-only caller without staffId claim even if UID matches an admin doc', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, rawKeypair()));
    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID },
      {},
    );
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('denies caller with missing or non-finite token authVersion', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, rawKeypair()));
    const res1 = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin' } },
      {},
    );
    expect(res1).toEqual({ ok: false, code: 'not_authorized' });

    const res2 = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: NaN } },
      {},
    );
    expect(res2).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('denies caller if live admin authVersion does not match token authVersion', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, rawKeypair()));
    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 99 } },
      {},
    );
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('atomically increments deviceKeyVersion and updates key on successful re-enrollment', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const initialKey = rawKeypair();
    const { db, store } = genericFakeFirestore(baseSeed(securityDeviceId, initialKey));

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');

    const newKey = rawKeypair();
    const { drp1 } = buildSignedDrp1(nonce, securityDeviceId, newKey);

    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: 1,
        drp1Base64: drp1.toString('base64'),
      },
      2100,
    );

    expect(res).toEqual({
      ok: true,
      securityDeviceIdHex: securityDeviceId.toString('hex'),
      branchId: 'B-HQ',
      newDeviceKeyVersion: 2,
      acceptedPublicKeyBase64: Buffer.from(newKey.publicKeyBase64Url, 'base64url').toString('base64'),
      serverFinalizationReceiptBase64: expect.any(String),
      oks1Base64: expect.any(String),
    });

    const deviceRecord = store
      .get('privilegedDeviceRegistrations')!
      .get(securityDeviceId.toString('hex')) as Record<string, unknown>;
    expect(deviceRecord.deviceKeyVersion).toBe(2);
    expect(deviceRecord.status).toBe('ACTIVE');
    expect(deviceRecord.reEnrolledByStaffId).toBe(ADMIN_STAFF_ID);
    expect(deviceRecord.validatedDevProofPublicKeyBase64).toBe(
      Buffer.from(newKey.publicKeyBase64Url, 'base64url').toString('base64'),
    );
  });

  it('rejects when expectedDeviceKeyVersion is missing or invalid shape', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, rawKeypair()));

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(nonce, securityDeviceId);

    const invalidVersions = [
      undefined,
      null,
      '1',
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      1.5,
      MAX_DEVICE_KEY_VERSION + 1,
      Number.MAX_SAFE_INTEGER + 10,
    ];

    for (const v of invalidVersions) {
      const res = await performReEnrollPrivilegedDevice(
        db,
        { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
        {
          registrationSessionId: beginReg.registrationSessionId,
          expectedDeviceKeyVersion: v,
          drp1Base64: drp1.toString('base64'),
        },
        2100,
      );
      expect(res).toEqual({ ok: false, code: 'invalid_request_shape' });
    }
  });

  it('rejects when live device registration has missing or invalid deviceKeyVersion', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const deviceIdHex = securityDeviceId.toString('hex');
    const seed = baseSeed(securityDeviceId, rawKeypair());

    // Test with missing deviceKeyVersion in DB
    delete (seed.privilegedDeviceRegistrations[deviceIdHex] as Record<string, unknown>).deviceKeyVersion;
    const { db } = genericFakeFirestore(seed);

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(nonce, securityDeviceId);

    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: 1,
        drp1Base64: drp1.toString('base64'),
      },
      2100,
    );
    expect(res).toEqual({ ok: false, code: 'device_key_version_invalid' });
  });

  it('allows increment from MAX_DEVICE_KEY_VERSION - 1 to MAX_DEVICE_KEY_VERSION', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const deviceIdHex = securityDeviceId.toString('hex');
    const seed = baseSeed(securityDeviceId, rawKeypair());
    (seed.privilegedDeviceRegistrations[deviceIdHex] as Record<string, unknown>).deviceKeyVersion = MAX_DEVICE_KEY_VERSION - 1;
    const { db, store } = genericFakeFirestore(seed);

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const newKey = rawKeypair();
    const { drp1 } = buildSignedDrp1(nonce, securityDeviceId, newKey);

    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: MAX_DEVICE_KEY_VERSION - 1,
        drp1Base64: drp1.toString('base64'),
      },
      2100,
    );
    expect(res).toEqual({
      ok: true,
      securityDeviceIdHex: securityDeviceId.toString('hex'),
      branchId: 'B-HQ',
      newDeviceKeyVersion: MAX_DEVICE_KEY_VERSION,
      acceptedPublicKeyBase64: Buffer.from(newKey.publicKeyBase64Url, 'base64url').toString('base64'),
      serverFinalizationReceiptBase64: expect.any(String),
      oks1Base64: expect.any(String),
    });

    const deviceRecord = store
      .get('privilegedDeviceRegistrations')!
      .get(securityDeviceId.toString('hex')) as Record<string, unknown>;
    expect(deviceRecord.deviceKeyVersion).toBe(MAX_DEVICE_KEY_VERSION);
  });

  it('rejects on version integer overflow at MAX_DEVICE_KEY_VERSION boundary', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const deviceIdHex = securityDeviceId.toString('hex');
    const seed = baseSeed(securityDeviceId, rawKeypair());
    (seed.privilegedDeviceRegistrations[deviceIdHex] as Record<string, unknown>).deviceKeyVersion = MAX_DEVICE_KEY_VERSION;
    const { db } = genericFakeFirestore(seed);

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(nonce, securityDeviceId);

    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: MAX_DEVICE_KEY_VERSION,
        drp1Base64: drp1.toString('base64'),
      },
      2100,
    );
    expect(res).toEqual({ ok: false, code: 'device_key_version_overflow' });
  });

  it('rejects when expectedDeviceKeyVersion does not match current version', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, rawKeypair()));

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(nonce, securityDeviceId);

    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: 99, // mismatch
        drp1Base64: drp1.toString('base64'),
      },
      2100,
    );

    expect(res).toEqual({ ok: false, code: 'device_key_version_mismatch' });
  });

  it('rejects when device is not found', async () => {
    const registeredDevice = Buffer.alloc(16, 0x11);
    const unknownDevice = Buffer.alloc(16, 0x99);
    const { db } = genericFakeFirestore(baseSeed(registeredDevice, rawKeypair()));

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(nonce, unknownDevice);

    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: 1,
        drp1Base64: drp1.toString('base64'),
      },
      2100,
    );

    expect(res).toEqual({ ok: false, code: 'device_not_found' });
  });

  describe('IR-005: live branch fail-closed pre-mutation', () => {
    const invalidBranches = [
      { name: 'missing branch', value: undefined },
      { name: 'empty branch', value: '' },
      { name: 'invalid character branch', value: 'branch invalid!' },
      { name: '>1500 branch', value: 'b'.repeat(1501) },
    ];

    for (const { name, value } of invalidBranches) {
      it(`rejects on ${name} and does not mutate session or device`, async () => {
        const securityDeviceId = Buffer.alloc(16, 0x55);
        const deviceIdHex = securityDeviceId.toString('hex');
        const initialKey = rawKeypair();
        const seed = baseSeed(securityDeviceId, initialKey);
        if (value === undefined) {
          delete (seed.privilegedDeviceRegistrations[deviceIdHex] as Record<string, unknown>).branchId;
        } else {
          (seed.privilegedDeviceRegistrations[deviceIdHex] as Record<string, unknown>).branchId = value;
        }

        const { db, store } = genericFakeFirestore(seed);

        const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
        if (!beginReg.ok) throw new Error('unreachable');
        const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
        const { drp1 } = buildSignedDrp1(nonce, securityDeviceId);

        const sessionBefore = JSON.parse(
          JSON.stringify(store.get('privilegedDeviceRegistrationSessions')!.get(beginReg.registrationSessionId)),
        );
        const deviceBefore = JSON.parse(
          JSON.stringify(store.get('privilegedDeviceRegistrations')!.get(deviceIdHex)),
        );

        const res = await performReEnrollPrivilegedDevice(
          db,
          { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
          {
            registrationSessionId: beginReg.registrationSessionId,
            expectedDeviceKeyVersion: 1,
            drp1Base64: drp1.toString('base64'),
          },
          2100,
        );

        expect(res).toEqual({ ok: false, code: 'device_branch_invalid' });

        const sessionAfter = JSON.parse(
          JSON.stringify(store.get('privilegedDeviceRegistrationSessions')!.get(beginReg.registrationSessionId)),
        );
        const deviceAfter = JSON.parse(
          JSON.stringify(store.get('privilegedDeviceRegistrations')!.get(deviceIdHex)),
        );

        expect(sessionAfter).toEqual(sessionBefore);
        expect(sessionAfter.status).not.toBe('CONSUMED');
        expect(deviceAfter).toEqual(deviceBefore);
        expect(deviceAfter.deviceKeyVersion).toBe(1);
        expect(deviceAfter.validatedDevProofPublicKeyBase64).toBe(deviceBefore.validatedDevProofPublicKeyBase64);
      });
    }
  });

  it('returns valid EFR1 receipt bound to enrollmentGenerationId and signed by active key', async () => {
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const initialKey = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, initialKey, signingKey));

    const beginReg = await performBeginDeviceRegistration(db, { uid: ADMIN_STAFF_ID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');

    const newKey = rawKeypair();
    const { drp1 } = buildSignedDrp1(nonce, securityDeviceId, newKey);
    const testGenId = 'ab'.repeat(16);

    const res = await performReEnrollPrivilegedDevice(
      db,
      { uid: ADMIN_STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
      {
        registrationSessionId: beginReg.registrationSessionId,
        expectedDeviceKeyVersion: 1,
        drp1Base64: drp1.toString('base64'),
        enrollmentGenerationId: testGenId,
      },
      2100,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.serverFinalizationReceiptBase64).toBeDefined();
      const decoded = decodeEfr1(Buffer.from(res.serverFinalizationReceiptBase64, 'base64'));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.operationKind).toBe(EFR1_OP_RE_ENROLLMENT);
        expect(decoded.value.enrollmentGenerationId.toString('hex')).toBe(testGenId);
        expect(decoded.value.securityDeviceId.toString('hex')).toBe(securityDeviceId.toString('hex'));
        expect(decoded.value.deviceKeyVersion).toBe(2);
        expect(decoded.value.acceptedPublicKey.toString('base64')).toBe(
          Buffer.from(newKey.publicKeyBase64Url, 'base64url').toString('base64'),
        );
        expect(decoded.value.branchId).toBe('B-HQ');
      }
    }
  });

  // --- F3 / OPTION_A_PRECOMPUTE_BEFORE_CONSUME ------------------------------
  // Every fallible step needed to build the success response now runs before
  // the durable commit. These tests assert the invariant positively: on any
  // such failure the session stays PENDING and the device registration is
  // byte-for-byte untouched. A response-shape assertion alone is not accepted
  // as proof, because the pre-remediation code returned exactly the same
  // envelope while the rotation had already committed.
  describe('durable-no-op atomicity', () => {
    it('T2: version mismatch is a durable no-op', async () => {
      const staged = await stagedReEnrollment();
      const before = staged.snapshot();

      const res = await staged.call({ expectedDeviceKeyVersion: 99 });

      expect(res).toEqual({ ok: false, code: 'device_key_version_mismatch' });
      staged.expectNoOp(before);
    });

    it('T4: malformed root signing key is a durable no-op', async () => {
      process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = 'not-a-valid-32-byte-key';
      const staged = await stagedReEnrollment();
      const before = staged.snapshot();

      const res = await staged.call();

      expect(res).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
      staged.expectNoOp(before);
    });

    it('T5: keyset manifest construction failure is a durable no-op', async () => {
      const staged = await stagedReEnrollment((seed) => {
        // A VERIFY_ONLY record re-using the ACTIVE key's signingKeyId makes the
        // verifiable set inconsistent, so buildOacKeysetManifest rejects it.
        const keys = seed.privilegedOacSigningKeys as Record<string, unknown>;
        keys['key-1-dup'] = {
          ...(keys['key-1'] as Record<string, unknown>),
          status: 'VERIFY_ONLY',
          verifyUntilServerMs: 9_000_000,
        };
      });
      const before = staged.snapshot();

      const res = await staged.call();

      expect(res).toEqual({ ok: false, code: 'duplicate_signing_key_id' });
      staged.expectNoOp(before);
    });

    it('T6: unavailable active signing key is a durable no-op', async () => {
      const staged = await stagedReEnrollment((seed) => {
        // Point keyset meta at a signing-key document that does not exist.
        seed.privilegedOacKeysetMeta.current = { activeSigningKeyId: 'missing-key' };
      });
      const before = staged.snapshot();

      const res = await staged.call();

      expect(res).toEqual({ ok: false, code: 'signing_key_unavailable' });
      staged.expectNoOp(before);
    });

    it('T7a: verifiable-keyset query rejection is a durable no-op', async () => {
      const staged = await stagedReEnrollment();
      const before = staged.snapshot();
      staged.control.failCollectionQuery = 'privilegedOacSigningKeys';

      await expect(staged.call()).rejects.toThrow('injected_collection_query_failure');

      staged.expectNoOp(before);
    });

    it('T7b: revocation-epoch read rejection is a durable no-op', async () => {
      const staged = await stagedReEnrollment();
      const before = staged.snapshot();
      staged.control.failDocRead = 'privilegedRevocationState/current';

      await expect(staged.call()).rejects.toThrow('injected_doc_read_failure');

      staged.expectNoOp(before);
    });

    it('T8: OKS1 encoding failure is a durable no-op', async () => {
      const staged = await stagedReEnrollment((seed) => {
        // OKS1 encodes the key count as a u8, so a verifiable set larger than
        // 255 makes oks1SignedPrefix throw. buildOacKeysetManifest does not cap
        // the count, so this reaches the encoder — a throw, not an ok:false.
        const keys = seed.privilegedOacSigningKeys as Record<string, unknown>;
        const spare = rawKeypair();
        for (let i = 0; i < 255; i += 1) {
          keys[`vk-${i}`] = {
            signingKeyId: `vk-${i}`,
            publicKeyBase64Url: spare.publicKeyBase64Url,
            privateKeyBase64Url: spare.privateKeyBase64Url,
            status: 'VERIFY_ONLY',
            verifyUntilServerMs: 9_000_000,
          };
        }
      });
      const before = staged.snapshot();

      await expect(staged.call()).rejects.toThrow('OKS1 keys must be 1-255 entries');

      staged.expectNoOp(before);
    });

    it('T9: retry after a failed precompute does not inflate deviceKeyVersion', async () => {
      delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
      const staged = await stagedReEnrollment();
      const before = staged.snapshot();

      const failed = await staged.call();
      expect(failed).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
      staged.expectNoOp(before);

      // Repair the environment and retry with the ORIGINAL expected version.
      process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = Buffer.alloc(32, 0x5a).toString('base64url');
      const retried = await staged.call();

      expect(retried.ok).toBe(true);
      if (retried.ok) {
        expect(retried.newDeviceKeyVersion).toBe(2);
        expect(retried.serverFinalizationReceiptBase64).toEqual(expect.any(String));
      }
      // Exactly one increment across both attempts — never 3.
      expect(readDevice(staged.store, staged.deviceIdHex).deviceKeyVersion).toBe(2);
      expect(readSession(staged.store, staged.sessionId).status).toBe('CONSUMED');
    });

    it('T10: replaying a consumed session does not mutate the device again', async () => {
      const staged = await stagedReEnrollment();

      const first = await staged.call();
      expect(first.ok).toBe(true);
      const afterFirst = staged.snapshot();

      const replay = await staged.call();

      expect(replay).toEqual({ ok: false, code: 'session_already_consumed' });
      expect(staged.snapshot()).toEqual(afterFirst);
      expect(readDevice(staged.store, staged.deviceIdHex).deviceKeyVersion).toBe(2);
    });

    it('T11: concurrent same-device re-enrollment increments exactly once', async () => {
      const staged = await stagedReEnrollment();

      // A second, independent PENDING session against the same device.
      const beginReg2 = await performBeginDeviceRegistration(staged.db, { uid: ADMIN_STAFF_ID }, 2000);
      if (!beginReg2.ok) throw new Error('unreachable');
      const nonce2 = Buffer.from(beginReg2.deviceRegistrationNonceBase64, 'base64');
      const { drp1: drp1b } = buildSignedDrp1(nonce2, staged.securityDeviceId, rawKeypair());

      // Deterministic interleaving: caller B has already pre-read v1 and
      // precomputed its receipt; caller A then runs to completion inside B's
      // pre-commit window, so B's authoritative in-transaction read sees v2.
      let winner: Awaited<ReturnType<typeof staged.call>> | undefined;
      staged.control.beforeTransaction = async () => {
        staged.control.beforeTransaction = null;
        winner = await staged.call();
      };

      const loser = await performReEnrollPrivilegedDevice(
        staged.db,
        ADMIN_AUTH,
        {
          registrationSessionId: beginReg2.registrationSessionId,
          expectedDeviceKeyVersion: 1,
          drp1Base64: drp1b.toString('base64'),
        },
        2100,
      );

      expect(winner?.ok).toBe(true);
      expect(loser).toEqual({ ok: false, code: 'device_key_version_mismatch' });

      // Exactly N+1, never N+2.
      expect(readDevice(staged.store, staged.deviceIdHex).deviceKeyVersion).toBe(2);
      expect(readSession(staged.store, staged.sessionId).status).toBe('CONSUMED');
      // The loser's one-time session was never burned.
      expect(readSession(staged.store, beginReg2.registrationSessionId).status).toBe('PENDING');
    });

    it('T12: an expired session is a durable no-op', async () => {
      const staged = await stagedReEnrollment();
      const before = staged.snapshot();

      // Session was minted at 2000 with a 10-minute TTL.
      const res = await staged.call({}, 2000 + 10 * 60 * 1000 + 1);

      expect(res).toEqual({ ok: false, code: 'session_expired' });
      staged.expectNoOp(before);
    });

    it('T12: a session owned by another caller is a durable no-op', async () => {
      const staged = await stagedReEnrollment();
      const before = staged.snapshot();

      const res = await performReEnrollPrivilegedDevice(
        staged.db,
        { uid: STAFF_ID, token: { staffId: ADMIN_STAFF_ID, role: 'admin', authVersion: 1 } },
        { registrationSessionId: staged.sessionId, expectedDeviceKeyVersion: 1, drp1Base64: '' },
        2100,
      );

      expect(res).toEqual({ ok: false, code: 'session_wrong_owner' });
      staged.expectNoOp(before);
    });

    it('T13: a branch change between pre-read and commit is a durable no-op', async () => {
      const staged = await stagedReEnrollment();
      const before = JSON.parse(staged.snapshot().device) as Record<string, unknown>;

      // The pre-read observes B-HQ and the receipt is signed over it; the live
      // branch then moves before the authoritative in-transaction read.
      staged.control.beforeTransaction = () => {
        staged.control.beforeTransaction = null;
        const device = readDevice(staged.store, staged.deviceIdHex);
        staged.store.get(DEVICES_COLLECTION)!.set(staged.deviceIdHex, { ...device, branchId: 'B-2' });
      };

      const res = await staged.call();

      expect(res).toEqual({ ok: false, code: 'device_branch_changed' });

      // The harness moved branchId, so assert every other field is untouched
      // rather than whole-document equality.
      const device = readDevice(staged.store, staged.deviceIdHex);
      expect(readSession(staged.store, staged.sessionId).status).toBe('PENDING');
      expect(device.branchId).toBe('B-2');
      expect(device.deviceKeyVersion).toBe(before.deviceKeyVersion);
      expect(device.validatedDevProofPublicKeyBase64).toBe(before.validatedDevProofPublicKeyBase64);
      expect(device.devProofRegistrationNonce).toBe(before.devProofRegistrationNonce);
      expect(device.reEnrolledAtServerMs).toBeUndefined();
      expect(device.reEnrolledByStaffId).toBeUndefined();
      expect(device.reEnrolledAt).toBeUndefined();
    });
  });
});
