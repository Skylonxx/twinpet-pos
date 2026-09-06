import { generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { performIssueOfflineStaffSessionAssertion } from '../issueOfflineStaffSessionAssertion';
import {
  decodeSsa1,
  decodeSrf1,
  encodeSscp1,
  ssa1SignaturePreimage,
  srf1SignaturePreimage,
  sscp1SignedPrefix,
  SSCP1_PURPOSE_LOGIN,
  SSCP1_PURPOSE_REFRESH,
  SRF1_OBJECT_KIND_SSA1,
  type StaffSessionDeviceChallengeProofV1,
} from '../staffSessionAssertionFrame';
import { privateKeyFromRaw, publicKeyFromRaw } from '../signingKeyLoader';
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
    };
  }
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => docHandle(name, id),
    }),
  } as unknown as Firestore;
  return { db, store };
}

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

const STAFF_ID = 'staff-101';
const BRANCH_ID = 'B-HQ';

function baseSeed(
  deviceKey: ReturnType<typeof rawKeypair>,
  signingKey: ReturnType<typeof rawKeypair>,
  securityDeviceId: Buffer,
) {
  const deviceIdHex = securityDeviceId.toString('hex');
  const devicePubRaw = Buffer.from(deviceKey.publicKeyBase64Url, 'base64url');
  return {
    users: {
      [STAFF_ID]: {
        staffId: STAFF_ID,
        role: 'cashier',
        isActive: true,
        deletedAt: null,
        authVersion: 1,
        branchId: BRANCH_ID,
      },
    },
    privilegedDeviceRegistrations: {
      [deviceIdHex]: {
        securityDeviceIdHex: deviceIdHex,
        validatedSecurityDeviceId: securityDeviceId.toString('base64'),
        validatedDevProofPublicKeyBase64: devicePubRaw.toString('base64'),
        devProofRegistrationNonce: Buffer.alloc(32, 0x11).toString('base64'),
        branchId: BRANCH_ID,
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

function buildSignedSscp1(
  deviceKey: ReturnType<typeof rawKeypair>,
  securityDeviceId: Buffer,
  purpose: number = SSCP1_PURPOSE_LOGIN,
  intendedStaffId: string = STAFF_ID,
  branchId: string = BRANCH_ID,
) {
  const unsigned: Omit<StaffSessionDeviceChallengeProofV1, 'signature'> = {
    purpose,
    challengeNonce: Buffer.alloc(32, 0x44),
    securityDeviceId,
    deviceKeyVersion: 1,
    branchId,
    challengeGeneration: BigInt(1),
    intendedStaffId,
  };
  const prefix = sscp1SignedPrefix(unsigned);
  const priv = privateKeyFromRaw(deviceKey.publicKeyBase64Url, deviceKey.privateKeyBase64Url);
  const signature = ed25519Sign(null, prefix, priv);
  const sscp1: StaffSessionDeviceChallengeProofV1 = { ...unsigned, signature };
  return encodeSscp1(sscp1);
}

describe('performIssueOfflineStaffSessionAssertion', () => {
  it('denies unauthenticated caller', async () => {
    const { db } = genericFakeFirestore();
    const res = await performIssueOfflineStaffSessionAssertion(db, null, {});
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('denies caller without staffId claim', async () => {
    const { db } = genericFakeFirestore();
    const res = await performIssueOfflineStaffSessionAssertion(db, { uid: 'anon-1' }, {});
    expect(res).toEqual({ ok: false, code: 'staff_identity_claim_missing' });
  });

  it('issues SSA1 and SRF1 frames when all claims, proofs, and bindings verify', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('fail');

    const ssa1Bytes = Buffer.from(res.ssa1Base64, 'base64');
    const decodedSsa1 = decodeSsa1(ssa1Bytes);
    expect(decodedSsa1.ok).toBe(true);
    if (!decodedSsa1.ok) throw new Error('fail');
    expect(decodedSsa1.value.staffId).toBe(STAFF_ID);
    expect(decodedSsa1.value.branchId).toBe(BRANCH_ID);

    const srf1Bytes = Buffer.from(res.srf1Base64, 'base64');
    const decodedSrf1 = decodeSrf1(srf1Bytes);
    expect(decodedSrf1.ok).toBe(true);
    if (!decodedSrf1.ok) throw new Error('fail');
    expect(decodedSrf1.value.objectKind).toBe(SRF1_OBJECT_KIND_SSA1);

    // Verify signatures with server signing key
    const serverPub = publicKeyFromRaw(signingKey.publicKeyBase64Url);
    expect(ed25519Verify(null, ssa1SignaturePreimage(decodedSsa1.value), serverPub, decodedSsa1.value.signature)).toBe(
      true,
    );
    expect(ed25519Verify(null, srf1SignaturePreimage(decodedSrf1.value), serverPub, decodedSrf1.value.signature)).toBe(
      true,
    );
  });

  it('rejects purpose replay: REFRESH purpose proof submitted to LOGIN issuance', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId, SSCP1_PURPOSE_REFRESH);

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'sscp1_purpose_mismatch' });
  });

  it('rejects if proof intendedStaffId does not match token staffId', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId, SSCP1_PURPOSE_LOGIN, 'other-staff');

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'sscp1_staff_mismatch' });
  });

  it('rejects if device registration does not exist', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const registeredDevId = Buffer.alloc(16, 0x55);
    const unregisteredDevId = Buffer.alloc(16, 0x99);
    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, registeredDevId));

    const sscp1Bytes = buildSignedSscp1(deviceKey, unregisteredDevId);

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'device_not_found' });
  });

  it('rejects if token authVersion is missing or non-finite', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'staff_auth_version_mismatch' });
  });

  it('rejects if live user authVersion is stale or missing', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.users[STAFF_ID].authVersion = 2; // live version bumped
    const { db } = genericFakeFirestore(seed);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'staff_auth_version_mismatch' });
  });

  it('rejects if user branch does not authorize proof branch', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.users[STAFF_ID].branchId = 'B-BRANCH-A';
    const { db } = genericFakeFirestore(seed);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId, SSCP1_PURPOSE_LOGIN, STAFF_ID, 'B-HQ');

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'staff_branch_mismatch' });
  });

  it('rejects if device status is missing or not ACTIVE', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.privilegedDeviceRegistrations[secDevId.toString('hex')].status = 'REVOKED';
    const { db } = genericFakeFirestore(seed);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'device_not_active' });
  });

  it('rejects if deviceKeyVersion is stale', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x55);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.privilegedDeviceRegistrations[secDevId.toString('hex')].deviceKeyVersion = 2; // bumped on server
    const { db } = genericFakeFirestore(seed);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId); // proof has deviceKeyVersion = 1

    const res = await performIssueOfflineStaffSessionAssertion(
      db,
      { uid: 'anon-uid', token: { staffId: STAFF_ID, authVersion: 1 } },
      { sscp1Base64: sscp1Bytes.toString('base64') },
      1_700_000_000_000,
    );

    expect(res).toEqual({ ok: false, code: 'device_key_version_mismatch' });
  });
});
