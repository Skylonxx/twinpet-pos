import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { performReEnrollPrivilegedDevice, MAX_DEVICE_KEY_VERSION } from '../reEnrollPrivilegedDevice';
import { performBeginDeviceRegistration } from '../deviceEnrollment';
import { drp1SignedPrefix, encodeDrp1 } from '../oacFrame';
import { decodeEfr1, EFR1_OP_RE_ENROLLMENT } from '../staffSessionAssertionFrame';
import { privateKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

function genericFakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Map<string, unknown>>();
  for (const [collection, docs] of Object.entries(seed)) {
    store.set(collection, new Map(Object.entries(docs)));
  }
  function coll(name: string): Map<string, unknown> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }
  function docHandle(collectionName: string, id: string) {
    return {
      get: async () => {
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
        get: async () => ({
          docs: Array.from(coll(name).values())
            .filter((d) => (d as Record<string, unknown>)[field] === value)
            .map((d) => ({ data: () => d })),
        }),
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (d: unknown) => void }, data: unknown) => ref.set(data),
        update: (ref: { update: (p: unknown) => void }, patch: unknown) => ref.update(patch),
      };
      await fn(tx);
    },
  } as unknown as Firestore;
  return { db, store };
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

  it('fails closed when root signing key secret is unavailable', async () => {
    delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    const securityDeviceId = Buffer.alloc(16, 0x55);
    const initialKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(securityDeviceId, initialKey));
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
    expect(res).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
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
});
