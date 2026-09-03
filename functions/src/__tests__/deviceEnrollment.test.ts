import { createHash, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  performBeginDeviceEnrollmentAuthorizationIssuance,
  performBeginDeviceRegistration,
  performCompleteDeviceEnrollmentAuthorizationIssuance,
  performCompleteDeviceRegistration,
} from '../deviceEnrollment';
import { canonicalJSON } from '../credentialStore';
import { decodeEnr1, drp1SignedPrefix, encodeDrp1 } from '../oacFrame';
import { privateKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

// Generic in-memory Firestore fake shared by this file's tests: collections
// are plain Maps; transactions operate on the same store synchronously.
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
      create: (data: unknown) => {
        const m = coll(collectionName);
        if (m.has(id)) throw new Error('already exists');
        m.set(id, data);
      },
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
        create: (ref: { create: (d: unknown) => void }, data: unknown) => ref.create(data),
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

const ADMIN_UID = 'admin-1';
const STAFF_UID = 'staff-1';

function baseSeed(issuer: ReturnType<typeof rawKeypair>, signingKey: ReturnType<typeof rawKeypair>) {
  return {
    users: {
      [ADMIN_UID]: { role: 'admin', isActive: true, deletedAt: null },
      [STAFF_UID]: { role: 'staff', isActive: true, deletedAt: null },
    },
    privilegedIssuerRegistrations: {
      'issuer-1': {
        issuerId: 'issuer-1',
        publicKeyBase64Url: issuer.publicKeyBase64Url,
        active: true,
        revoked: false,
        credentialVersion: 1,
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

let requestIdCounter = 0;

function issuerSignedRequest(
  issuer: ReturnType<typeof rawKeypair>,
  purpose: string,
  fields: Record<string, unknown>,
): { requestId: string; signature: string } {
  requestIdCounter += 1;
  const requestId = createHash('sha256')
    .update(`${purpose}:${requestIdCounter}:${JSON.stringify(fields)}`)
    .digest('hex')
    .slice(0, 40);
  const payload = Buffer.from(canonicalJSON({ purpose, ...fields, requestId }), 'utf8');
  const signature = ed25519Sign(null, payload, privateKeyFromRaw(issuer.publicKeyBase64Url, issuer.privateKeyBase64Url)).toString(
    'base64',
  );
  return { requestId, signature };
}

describe('beginDeviceEnrollmentAuthorizationIssuance', () => {
  it('mints a PENDING enrollment authorization for a valid admin + issuer-signed request', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const { requestId, signature } = issuerSignedRequest(issuer, 'beginDeviceEnrollmentAuthorizationIssuance', {
      issuerId: 'issuer-1',
      branchId: 'LDP-001',
    });
    const result = await performBeginDeviceEnrollmentAuthorizationIssuance(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'issuer-1', requestId, branchId: 'LDP-001', signature },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.enrollmentAuthId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a non-admin caller', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const result = await performBeginDeviceEnrollmentAuthorizationIssuance(
      db,
      { uid: STAFF_UID, token: { role: 'staff' } },
      {},
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('rejects a bad issuer signature', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const result = await performBeginDeviceEnrollmentAuthorizationIssuance(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'issuer-1', requestId: 'r'.repeat(32), branchId: 'LDP-001', signature: Buffer.alloc(64).toString('base64') },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'issuer_auth_failed' });
  });
});

async function beginAndCompleteIssuance(
  db: Firestore,
  issuer: ReturnType<typeof rawKeypair>,
  branchId = 'LDP-001',
  nowMs = 1000,
) {
  const begin = issuerSignedRequest(issuer, 'beginDeviceEnrollmentAuthorizationIssuance', { issuerId: 'issuer-1', branchId });
  const beginResult = await performBeginDeviceEnrollmentAuthorizationIssuance(
    db,
    { uid: ADMIN_UID, token: { role: 'admin' } },
    { issuerId: 'issuer-1', requestId: begin.requestId, branchId, signature: begin.signature },
    nowMs,
  );
  if (!beginResult.ok) throw new Error(`begin failed: ${beginResult.code}`);

  const complete = issuerSignedRequest(issuer, 'completeDeviceEnrollmentAuthorizationIssuance', {
    issuerId: 'issuer-1',
    enrollmentAuthId: beginResult.enrollmentAuthId,
  });
  const completeResult = await performCompleteDeviceEnrollmentAuthorizationIssuance(
    db,
    { uid: ADMIN_UID, token: { role: 'admin' } },
    { issuerId: 'issuer-1', requestId: complete.requestId, enrollmentAuthId: beginResult.enrollmentAuthId, signature: complete.signature },
    nowMs + 1,
  );
  return { enrollmentAuthId: beginResult.enrollmentAuthId, completeResult };
}

describe('completeDeviceEnrollmentAuthorizationIssuance', () => {
  it('signs and returns a decodable, verifiable ENR1 frame; marks the authorization ISSUED', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db, store } = genericFakeFirestore(baseSeed(issuer, signingKey));

    const { enrollmentAuthId, completeResult } = await beginAndCompleteIssuance(db, issuer);
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) throw new Error('unreachable');

    const decoded = decodeEnr1(Buffer.from(completeResult.enr1Base64, 'base64'));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('unreachable');
    expect(decoded.value.enrollmentAuthId).toBe(enrollmentAuthId);
    expect(decoded.value.branchId).toBe('LDP-001');

    const authRecord = store.get('privilegedDeviceEnrollmentAuthorizations')!.get(enrollmentAuthId) as {
      status: string;
    };
    expect(authRecord.status).toBe('ISSUED');
  });

  it('rejects completing an authorization that is not PENDING (e.g. already ISSUED)', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer);

    const complete2 = issuerSignedRequest(issuer, 'completeDeviceEnrollmentAuthorizationIssuance', {
      issuerId: 'issuer-1',
      enrollmentAuthId,
    });
    const second = await performCompleteDeviceEnrollmentAuthorizationIssuance(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'issuer-1', requestId: complete2.requestId, enrollmentAuthId, signature: complete2.signature },
      2000,
    );
    expect(second).toEqual({ ok: false, code: 'authorization_wrong_status' });
  });
});

describe('beginDeviceRegistration', () => {
  it('returns a fresh session and 32-byte nonce for any authenticated caller', async () => {
    const { db } = genericFakeFirestore();
    const result = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(Buffer.from(result.deviceRegistrationNonceBase64, 'base64').length).toBe(32);
  });

  it('rejects an unauthenticated caller', async () => {
    const { db } = genericFakeFirestore();
    const result = await performBeginDeviceRegistration(db, null, 1);
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });
});

function buildSignedDrp1(enrollmentAuthId: string, nonce: Buffer, securityDeviceId: Buffer) {
  const device = rawKeypair();
  const devicePublicRaw = Buffer.from(device.publicKeyBase64Url, 'base64url');
  const unsigned = { enrollmentAuthId, deviceRegistrationNonce: nonce, securityDeviceId, devProofPublicKey: devicePublicRaw };
  const prefix = drp1SignedPrefix(unsigned);
  const signature = ed25519Sign(null, prefix, privateKeyFromRaw(device.publicKeyBase64Url, device.privateKeyBase64Url));
  const drp1 = encodeDrp1({ ...unsigned, signature });
  return { drp1, device };
}

describe('completeDeviceRegistration', () => {
  it('validates DRP1, consumes the authorization + session, and persists the device registration', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db, store } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);

    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const securityDeviceId = Buffer.alloc(16, 0x77);
    const { drp1 } = buildSignedDrp1(enrollmentAuthId, nonce, securityDeviceId);

    const result = await performCompleteDeviceRegistration(
      db,
      { uid: STAFF_UID },
      { registrationSessionId: beginReg.registrationSessionId, drp1Base64: drp1.toString('base64') },
      2100,
    );
    expect(result).toEqual({ ok: true, securityDeviceIdHex: securityDeviceId.toString('hex'), branchId: 'LDP-001' });

    const authRecord = store.get('privilegedDeviceEnrollmentAuthorizations')!.get(enrollmentAuthId) as { status: string };
    expect(authRecord.status).toBe('CONSUMED');
    const deviceRecord = store.get('privilegedDeviceRegistrations')!.get(securityDeviceId.toString('hex'));
    expect(deviceRecord).toBeDefined();
  });

  it('rejects a DRP1 whose nonce does not match the session nonce', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);
    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const { drp1 } = buildSignedDrp1(enrollmentAuthId, Buffer.alloc(32, 0x01), Buffer.alloc(16, 0x77));

    const result = await performCompleteDeviceRegistration(
      db,
      { uid: STAFF_UID },
      { registrationSessionId: beginReg.registrationSessionId, drp1Base64: drp1.toString('base64') },
      2100,
    );
    expect(result).toEqual({ ok: false, code: 'drp1_nonce_mismatch' });
  });

  it('rejects a DRP1 whose self-signature does not verify against its own embedded public key', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);
    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(enrollmentAuthId, nonce, Buffer.alloc(16, 0x77));
    const tampered = Buffer.from(drp1);
    tampered[tampered.length - 1] ^= 0xff; // flip a signature byte

    const result = await performCompleteDeviceRegistration(
      db,
      { uid: STAFF_UID },
      { registrationSessionId: beginReg.registrationSessionId, drp1Base64: tampered.toString('base64') },
      2100,
    );
    expect(result).toEqual({ ok: false, code: 'drp1_bad_self_signature' });
  });

  it('rejects a session owned by a different requester', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);
    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(enrollmentAuthId, nonce, Buffer.alloc(16, 0x77));

    const result = await performCompleteDeviceRegistration(
      db,
      { uid: 'someone-else' },
      { registrationSessionId: beginReg.registrationSessionId, drp1Base64: drp1.toString('base64') },
      2100,
    );
    expect(result).toEqual({ ok: false, code: 'session_wrong_owner' });
  });

  it('rejects when the enrollment authorization has not been ISSUED yet', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const begin = issuerSignedRequest(issuer, 'beginDeviceEnrollmentAuthorizationIssuance', {
      issuerId: 'issuer-1',
      branchId: 'LDP-001',
    });
    const beginResult = await performBeginDeviceEnrollmentAuthorizationIssuance(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'issuer-1', requestId: begin.requestId, branchId: 'LDP-001', signature: begin.signature },
      1000,
    );
    if (!beginResult.ok) throw new Error('unreachable');

    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(beginResult.enrollmentAuthId, nonce, Buffer.alloc(16, 0x77));

    const result = await performCompleteDeviceRegistration(
      db,
      { uid: STAFF_UID },
      { registrationSessionId: beginReg.registrationSessionId, drp1Base64: drp1.toString('base64') },
      2100,
    );
    expect(result).toEqual({ ok: false, code: 'enrollment_authorization_wrong_status' });
  });
});
