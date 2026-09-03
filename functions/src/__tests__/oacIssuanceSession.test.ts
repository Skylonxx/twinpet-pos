import bcrypt from 'bcryptjs';
import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  performBeginPrivilegedOacIssuanceSession,
  performCompletePrivilegedOacIssuanceSession,
} from '../oacIssuanceSession';
import { encodePin1, encodePtp1, pin1SignedPrefix, ptp1SignedPrefix } from '../oacFrame';
import { verifyOacEnvelopeSignature } from '../oacSigner';
import { privateKeyFromRaw, publicKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

function genericFakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Map<string, unknown>>();
  for (const [collection, docs] of Object.entries(seed)) store.set(collection, new Map(Object.entries(docs)));
  function coll(name: string): Map<string, unknown> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }
  function docHandle(collectionName: string, id: string) {
    return {
      get: async () => ({ exists: coll(collectionName).has(id), data: () => coll(collectionName).get(id) }),
      set: (data: unknown) => coll(collectionName).set(id, data),
      update: (patch: Record<string, unknown>) =>
        coll(collectionName).set(id, { ...(coll(collectionName).get(id) as Record<string, unknown>), ...patch }),
    };
  }
  const db = {
    collection: (name: string) => ({ doc: (id: string) => docHandle(name, id) }),
  } as unknown as Firestore;
  return { db, store };
}

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

const MANAGER_UID = 'manager-1';
const DEVICE_HEX = 'b'.repeat(32);
const BRANCH_ID = 'LDP-001';

async function seedManagerWithPin(pin: string, signingKey: ReturnType<typeof rawKeypair>) {
  const pinHash = await bcrypt.hash(pin, 10);
  return {
    users: {
      [MANAGER_UID]: { role: 'manager', isActive: true, deletedAt: null, authVersion: 0, branchIds: [BRANCH_ID] },
    },
    userCredentials: {
      [MANAGER_UID]: {
        pinHash,
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 5,
        credentialState: 'rotated_authoritative',
        disabled: false,
      },
    },
    privilegedDeviceRegistrations: {
      [DEVICE_HEX]: { securityDeviceIdHex: DEVICE_HEX, branchId: BRANCH_ID, validatedDevProofPublicKeyBase64: '' },
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

describe('performBeginPrivilegedOacIssuanceSession', () => {
  it('rejects a non-manager caller', async () => {
    const { db } = genericFakeFirestore({
      users: { u1: { role: 'staff', isActive: true, deletedAt: null, authVersion: 0 } },
    });
    const result = await performBeginPrivilegedOacIssuanceSession(
      db,
      { uid: 'u1', token: { staffId: 'u1', authVersion: 0 } },
      { securityDeviceIdHex: DEVICE_HEX },
      1,
    );
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('rejects an unregistered device', async () => {
    const signingKey = rawKeypair();
    const seed = await seedManagerWithPin('123456', signingKey);
    delete (seed as Record<string, unknown>).privilegedDeviceRegistrations;
    const { db } = genericFakeFirestore(seed);
    const result = await performBeginPrivilegedOacIssuanceSession(
      db,
      { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
      { securityDeviceIdHex: DEVICE_HEX },
      1,
    );
    expect(result).toEqual({ ok: false, code: 'device_not_registered' });
  });
});

async function fullHappyPathSetup(pin = '123456') {
  const signingKey = rawKeypair();
  const seed = await seedManagerWithPin(pin, signingKey);
  const { db, store } = genericFakeFirestore(seed);

  const begin = await performBeginPrivilegedOacIssuanceSession(
    db,
    { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
    { securityDeviceIdHex: DEVICE_HEX },
    1000,
  );
  if (!begin.ok) throw new Error(`begin failed: ${begin.code}`);

  const device = rawKeypair();
  const devicePublicRaw = Buffer.from(device.publicKeyBase64Url, 'base64url');
  // Register the device's public key on the seeded device registration doc.
  store.get('privilegedDeviceRegistrations')!.set(DEVICE_HEX, {
    securityDeviceIdHex: DEVICE_HEX,
    branchId: BRANCH_ID,
    validatedDevProofPublicKeyBase64: devicePublicRaw.toString('base64'),
  });

  const nonce = Buffer.from(begin.nonceBase64, 'base64');
  const ptp1Unsigned = {
    securityDeviceId: Buffer.from(DEVICE_HEX, 'hex'),
    oacIssuanceSessionId: begin.sessionId,
    managerStaffId: MANAGER_UID,
    nonce,
    devProofPublicKey: devicePublicRaw,
  };
  const devicePrivateKey = privateKeyFromRaw(device.publicKeyBase64Url, device.privateKeyBase64Url);
  const ptp1Signature = ed25519Sign(null, ptp1SignedPrefix(ptp1Unsigned), devicePrivateKey);
  const ptp1Base64 = encodePtp1({ ...ptp1Unsigned, signature: ptp1Signature }).toString('base64');

  const pin1Unsigned = {
    securityDeviceId: Buffer.from(DEVICE_HEX, 'hex'),
    oacIssuanceSessionId: begin.sessionId,
    managerStaffId: MANAGER_UID,
    verifierAlgo: 'argon2id',
    m: 65536,
    t: 3,
    p: 1,
    verifierSalt: Buffer.alloc(16, 0x11),
    verifier: Buffer.alloc(32, 0x22),
    pepperCommitment: Buffer.alloc(32, 0x33),
    devProofPublicKey: devicePublicRaw,
  };
  const pin1Signature = ed25519Sign(null, pin1SignedPrefix(pin1Unsigned), devicePrivateKey);
  const pin1Base64 = encodePin1({ ...pin1Unsigned, signature: pin1Signature }).toString('base64');

  return { db, store, begin, ptp1Base64, pin1Base64, signingKey };
}

describe('performCompletePrivilegedOacIssuanceSession', () => {
  it('issues a signed OAC that verifies against the active signing key', async () => {
    const { db, begin, ptp1Base64, pin1Base64, signingKey } = await fullHappyPathSetup();
    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
      { sessionId: begin.ok ? begin.sessionId : '', pin: '123456', ptp1Base64, pin1Base64 },
      1100,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.oac.branchId).toBe(BRANCH_ID);
    expect(result.oac.allowedActions).toEqual(['VOID_PENDING_SALE', 'VOID_SETTLED_SALE']);
    const publicKey = publicKeyFromRaw(signingKey.publicKeyBase64Url);
    expect(verifyOacEnvelopeSignature(result.oac, publicKey)).toBe(true);
  });

  it('rejects an invalid PIN', async () => {
    const { db, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup('123456');
    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
      { sessionId: begin.ok ? begin.sessionId : '', pin: '999999', ptp1Base64, pin1Base64 },
      1100,
    );
    expect(result).toEqual({ ok: false, code: 'invalid_pin' });
  });

  it('rejects a legacy PIN4 (cannot provision OAC)', async () => {
    const { db, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup('1234');
    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
      { sessionId: begin.ok ? begin.sessionId : '', pin: '1234', ptp1Base64, pin1Base64 },
      1100,
    );
    expect(result).toEqual({ ok: false, code: 'oac_provision_forbidden_legacy_pin4' });
  });

  it('rejects a PTP1 whose device key does not match the registered device', async () => {
    const { db, begin, pin1Base64 } = await fullHappyPathSetup();
    const otherDevice = rawKeypair();
    const otherPublicRaw = Buffer.from(otherDevice.publicKeyBase64Url, 'base64url');
    const nonce = begin.ok ? Buffer.from(begin.nonceBase64, 'base64') : Buffer.alloc(32);
    const ptp1Unsigned = {
      securityDeviceId: Buffer.from(DEVICE_HEX, 'hex'),
      oacIssuanceSessionId: begin.ok ? begin.sessionId : '',
      managerStaffId: MANAGER_UID,
      nonce,
      devProofPublicKey: otherPublicRaw,
    };
    const sig = ed25519Sign(
      null,
      ptp1SignedPrefix(ptp1Unsigned),
      privateKeyFromRaw(otherDevice.publicKeyBase64Url, otherDevice.privateKeyBase64Url),
    );
    const tamperedPtp1 = encodePtp1({ ...ptp1Unsigned, signature: sig }).toString('base64');

    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
      { sessionId: begin.ok ? begin.sessionId : '', pin: '123456', ptp1Base64: tamperedPtp1, pin1Base64 },
      1100,
    );
    expect(result).toEqual({ ok: false, code: 'tuple_device_key_mismatch' });
  });

  it('rejects reusing a session a second time (already consumed)', async () => {
    const { db, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    const first = await performCompletePrivilegedOacIssuanceSession(
      db,
      { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
      { sessionId: begin.ok ? begin.sessionId : '', pin: '123456', ptp1Base64, pin1Base64 },
      1100,
    );
    expect(first.ok).toBe(true);
    const second = await performCompletePrivilegedOacIssuanceSession(
      db,
      { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } },
      { sessionId: begin.ok ? begin.sessionId : '', pin: '123456', ptp1Base64, pin1Base64 },
      1200,
    );
    expect(second).toEqual({ ok: false, code: 'session_already_consumed' });
  });
});
