import { generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { performReanchorPrivilegedOacReceipt } from '../reanchorPrivilegedOacReceipt';
import {
  decodeSrf1,
  encodeSscp1,
  srf1SignaturePreimage,
  sscp1SignedPrefix,
  SSCP1_PURPOSE_LOGIN,
  SSCP1_PURPOSE_OAC_REANCHOR,
  SRF1_OBJECT_KIND_OAC,
  type StaffSessionDeviceChallengeProofV1,
} from '../staffSessionAssertionFrame';
import { signOacEnvelope } from '../oacSigner';
import { privateKeyFromRaw, publicKeyFromRaw } from '../signingKeyLoader';
import { canonicalJSON } from '../credentialStore';
import type { Firestore } from 'firebase-admin/firestore';
import type { OfflineAuthorizationCapabilityV1 } from '../privilegedActionRegistry';

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
        return { exists: m.has(id), id, data: () => m.get(id) };
      },
      set: (data: unknown) => coll(collectionName).set(id, data),
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
  } as unknown as Firestore;
  return { db, store };
}

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

const MANAGER_ID = 'mgr-001';
const BRANCH_ID = 'B-HQ';

function createValidOac(
  signingKey: ReturnType<typeof rawKeypair>,
  securityDeviceId: Buffer,
  nowMs: number = 1000,
  freshnessMs: number = 86_400_000,
): { oac: OfflineAuthorizationCapabilityV1; rawBytes: Buffer; base64: string } {
  const priv = privateKeyFromRaw(signingKey.publicKeyBase64Url, signingKey.privateKeyBase64Url);
  const unsigned = {
    oacId: 'OAC-001',
    schemaVersion: 1,
    managerStaffId: MANAGER_ID,
    managerRole: 'manager' as const,
    branchId: BRANCH_ID,
    deviceId: securityDeviceId.toString('hex'),
    allowedActions: ['VOID_PENDING_SALE' as const],
    authVersionAtIssue: 1,
    credentialVersionAtIssue: 1,
    revocationEpoch: 0,
    issuedAtServerMs: nowMs,
    freshnessExpiresAtServerMs: nowMs + freshnessMs,
    verifierAlgo: 'argon2id' as const,
    verifierParams: { m: 65536, t: 3, p: 1, saltLen: 16, hashLen: 32 },
    verifierSalt: Buffer.alloc(16, 1).toString('base64'),
    verifier: Buffer.alloc(32, 2).toString('base64'),
    pepperCommitment: Buffer.alloc(32, 3).toString('base64'),
  };
  const oac = signOacEnvelope(unsigned, 'key-1', priv);
  const rawBytes = Buffer.from(canonicalJSON(oac), 'utf8');
  return { oac, rawBytes, base64: rawBytes.toString('base64') };
}

function baseSeed(
  deviceKey: ReturnType<typeof rawKeypair>,
  signingKey: ReturnType<typeof rawKeypair>,
  securityDeviceId: Buffer,
) {
  const deviceIdHex = securityDeviceId.toString('hex');
  const devicePubRaw = Buffer.from(deviceKey.publicKeyBase64Url, 'base64url');
  return {
    users: {
      [MANAGER_ID]: {
        staffId: MANAGER_ID,
        role: 'manager',
        isActive: true,
        deletedAt: null,
        authVersion: 1,
        branchId: BRANCH_ID,
      },
    },
    userCredentials: {
      [MANAGER_ID]: {
        pinHash: 'hash',
        algo: 'bcrypt',
        cost: 10,
        credentialVersion: 1,
        credentialState: 'rotated_authoritative',
        disabled: false,
      },
    },
    privilegedRevocationState: {
      current: { revocationEpoch: 0 },
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
  purpose: number = SSCP1_PURPOSE_OAC_REANCHOR,
  intendedStaffId: string = MANAGER_ID,
  branchId: string = BRANCH_ID,
) {
  const unsigned: Omit<StaffSessionDeviceChallengeProofV1, 'signature'> = {
    purpose,
    challengeNonce: Buffer.alloc(32, 0x99),
    securityDeviceId,
    deviceKeyVersion: 1,
    branchId,
    challengeGeneration: BigInt(5),
    intendedStaffId,
  };
  const prefix = sscp1SignedPrefix(unsigned);
  const priv = privateKeyFromRaw(deviceKey.publicKeyBase64Url, deviceKey.privateKeyBase64Url);
  const signature = ed25519Sign(null, prefix, priv);
  const sscp1: StaffSessionDeviceChallengeProofV1 = { ...unsigned, signature };
  return encodeSscp1(sscp1);
}

describe('performReanchorPrivilegedOacReceipt', () => {
  it('denies unauthenticated caller', async () => {
    const { db } = genericFakeFirestore();
    const res = await performReanchorPrivilegedOacReceipt(db, null, {});
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('re-anchors a valid, fresh OAC with a fresh SRF1-OAC receipt', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const nowMs = 1_700_000_000_000;
    const { base64: oacBase64, oac } = createValidOac(signingKey, secDevId, nowMs, 86_400_000);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);

    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      nowMs + 1000,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('fail');
    expect(res.oacId).toBe(oac.oacId);

    const srf1Bytes = Buffer.from(res.srf1OacBase64, 'base64');
    const decodedSrf1 = decodeSrf1(srf1Bytes);
    expect(decodedSrf1.ok).toBe(true);
    if (!decodedSrf1.ok) throw new Error('fail');
    expect(decodedSrf1.value.objectKind).toBe(SRF1_OBJECT_KIND_OAC);

    const serverPub = publicKeyFromRaw(signingKey.publicKeyBase64Url);
    expect(ed25519Verify(null, srf1SignaturePreimage(decodedSrf1.value), serverPub, decodedSrf1.value.signature)).toBe(
      true,
    );
  });

  it('rejects re-anchoring an expired OAC (never extends freshness)', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const issueTime = 1_000_000;
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId, issueTime, 1000); // expires at 1_001_000
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);

    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      issueTime + 5000, // expired!
    );

    expect(res).toEqual({ ok: false, code: 'oac_freshness_expired' });
  });

  it('rejects if caller is not the manager who provisioned the OAC', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId, SSCP1_PURPOSE_OAC_REANCHOR, 'other-mgr');

    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: 'other-mgr', authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'manager_mismatch' });
  });

  it('rejects purpose replay: LOGIN proof submitted to OAC re-anchor', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId, SSCP1_PURPOSE_LOGIN);

    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'sscp1_purpose_mismatch' });
  });

  it('rejects missing or non-finite token authVersion', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);
    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId));

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('rejects stale or mismatched live manager authVersion', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.users[MANAGER_ID].authVersion = 2; // live manager bumped
    const { db } = genericFakeFirestore(seed);

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'manager_auth_version_mismatch' });
  });

  it('rejects when manager branch authorization was removed after OAC issuance', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.users[MANAGER_ID].branchId = 'B-OTHER'; // moved branch
    const { db } = genericFakeFirestore(seed);

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'manager_branch_mismatch' });
  });

  it('rejects when device moved branch', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.privilegedDeviceRegistrations[secDevId.toString('hex')].branchId = 'B-OTHER';
    const { db } = genericFakeFirestore(seed);

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'device_branch_mismatch' });
  });

  it('rejects when device status is missing or not ACTIVE', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId);
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.privilegedDeviceRegistrations[secDevId.toString('hex')].status = 'SUSPENDED';
    const { db } = genericFakeFirestore(seed);

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'device_not_active' });
  });

  it('rejects cross-device proof', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId1 = Buffer.alloc(16, 0x44);
    const secDevId2 = Buffer.alloc(16, 0x77);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId1);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId2); // proof for device 2
    const { db } = genericFakeFirestore(baseSeed(deviceKey, signingKey, secDevId1));

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'device_mismatch' });
  });

  it('rejects stale device key version', async () => {
    const deviceKey = rawKeypair();
    const signingKey = rawKeypair();
    const secDevId = Buffer.alloc(16, 0x44);
    const { base64: oacBase64 } = createValidOac(signingKey, secDevId);
    const sscp1Bytes = buildSignedSscp1(deviceKey, secDevId); // version 1
    const seed = baseSeed(deviceKey, signingKey, secDevId);
    seed.privilegedDeviceRegistrations[secDevId.toString('hex')].deviceKeyVersion = 2; // bumped
    const { db } = genericFakeFirestore(seed);

    const res = await performReanchorPrivilegedOacReceipt(
      db,
      { uid: 'u1', token: { staffId: MANAGER_ID, authVersion: 1 } },
      { oacEnvelopeBytesBase64: oacBase64, sscp1Base64: sscp1Bytes.toString('base64') },
      2000,
    );

    expect(res).toEqual({ ok: false, code: 'device_key_version_mismatch' });
  });
});
