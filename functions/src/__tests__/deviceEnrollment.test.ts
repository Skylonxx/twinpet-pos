import { createHash, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  performBeginDeviceEnrollmentAuthorizationIssuance,
  performBeginDeviceRegistration,
  performCompleteDeviceEnrollmentAuthorizationIssuance,
  performCompleteDeviceRegistration,
} from '../deviceEnrollment';
import { canonicalJSON } from '../credentialStore';
import { completionRequestDigest } from '../deviceEnrollmentCore';
import { decodeEnr1, drp1SignedPrefix, encodeDrp1 } from '../oacFrame';
import { decodeEfr1, EFR1_OP_INITIAL_ENROLLMENT } from '../staffSessionAssertionFrame';
import { privateKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * SEC-001 R1 root-loader seam.
 *
 * The production root anchor was rotated to a key whose private seed lives only in
 * human custody, so this suite can no longer manufacture a valid production root by
 * setting the env var to a committed seed. It therefore substitutes an ephemeral
 * per-run root: `loadRootSigningKey` is replaced by a call to the REAL
 * `validateRootSigningSecret` with this suite's expected anchor, so every validation
 * rule the production loader applies (absence, non-canonical base64url, 32-byte
 * length, derived-public mismatch) still governs these tests — only the expected
 * anchor differs. That is what keeps the `root_signing_key_unavailable` durability
 * cases below honest. Fail-closed coverage of the real production loader itself
 * lives in `signingKeyLoader.test.ts` and is NOT claimed here. No production code
 * changes, and every other export is the real one via `importOriginal`.
 */
const testRootHolder = vi.hoisted(() => ({ publicKeyBase64Url: '' }));

vi.mock('../signingKeyLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../signingKeyLoader')>();
  return {
    ...actual,
    loadRootSigningKey: async (injectedSecret?: string) =>
      actual.validateRootSigningSecret(
        injectedSecret !== undefined ? injectedSecret : process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL,
        testRootHolder.publicKeyBase64Url,
      ),
  };
});

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

// Ephemeral per-run root for the mocked loader above (see its comment).
const testRoot = rawKeypair();
testRootHolder.publicKeyBase64Url = testRoot.publicKeyBase64Url;

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
  const originalEnv = process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;

  beforeEach(() => {
    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = testRoot.privateKeyBase64Url;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = originalEnv;
    } else {
      delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    }
  });

  // --- F3: precompute-before-consume durable no-op harness ------------------

  /**
   * Snapshots the three collections `completeDeviceRegistration` may mutate.
   * F3's invariant is that ANY post-validation failure leaves all three byte
   * identical — the caller must always be able to retry with the same DRP1.
   */
  function durableSnapshot(store: Map<string, Map<string, unknown>>) {
    const pick = (c: string) => JSON.stringify(Array.from(store.get(c)?.entries() ?? []));
    return {
      auth: pick('privilegedDeviceEnrollmentAuthorizations'),
      session: pick('privilegedDeviceRegistrationSessions'),
      device: pick('privilegedDeviceRegistrations'),
    };
  }

  /**
   * Drives a registration up to (but not through) completion.
   *
   * `afterStaging` runs once the authorization is ISSUED and the session is
   * PENDING — i.e. exactly the state a real caller reaches before invoking
   * `completeDeviceRegistration`. Keyset/signing-key faults must be injected
   * there, not in the seed, because issuing the ENR1 authorization itself
   * needs a working signing key.
   */
  async function stagedRegistration(afterStaging?: (store: Map<string, Map<string, unknown>>) => void) {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const seed = baseSeed(issuer, signingKey) as unknown as Record<string, Record<string, unknown>>;
    const { db, store } = genericFakeFirestore(seed);
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);
    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const securityDeviceId = Buffer.alloc(16, 0x77);
    const { drp1 } = buildSignedDrp1(enrollmentAuthId, nonce, securityDeviceId);
    afterStaging?.(store);
    return {
      db,
      store,
      signingKey,
      complete: () =>
        performCompleteDeviceRegistration(
          db,
          { uid: STAFF_UID },
          { registrationSessionId: beginReg.registrationSessionId, drp1Base64: drp1.toString('base64') },
          2100,
        ),
    };
  }

  function expectDurableNoOp(store: Map<string, Map<string, unknown>>, before: ReturnType<typeof durableSnapshot>) {
    const after = durableSnapshot(store);
    expect(after.auth).toBe(before.auth);
    expect(after.session).toBe(before.session);
    expect(after.device).toBe(before.device);
    // Explicit, readable restatement of the same invariant.
    const auth = Array.from(store.get('privilegedDeviceEnrollmentAuthorizations')!.values())[0] as { status: string };
    const session = Array.from(store.get('privilegedDeviceRegistrationSessions')!.values())[0] as { status: string };
    expect(auth.status).toBe('ISSUED');
    expect(session.status).toBe('PENDING');
    expect(store.get('privilegedDeviceRegistrations')?.size ?? 0).toBe(0);
  }

  it('F3: fails closed with a durable no-op when the root signing key is absent', async () => {
    delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    const { store, complete } = await stagedRegistration();
    const before = durableSnapshot(store);

    const result = await complete();

    expect(result).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
    expectDurableNoOp(store, before);
  });

  it('F3: fails closed with a durable no-op when the root key is malformed', async () => {
    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = 'not-a-valid-32-byte-key';
    const { store, complete } = await stagedRegistration();
    const before = durableSnapshot(store);

    const result = await complete();

    expect(result).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
    expectDurableNoOp(store, before);
  });

  it('F3: fails closed with a durable no-op when there is no active signing key', async () => {
    const { store, complete } = await stagedRegistration((s) => {
      // Point the keyset meta at a signing key document that does not exist,
      // only once the authorization has already been issued.
      s.get('privilegedOacKeysetMeta')!.set('current', { activeSigningKeyId: 'missing-key' });
    });
    const before = durableSnapshot(store);

    const result = await complete();

    expect(result).toEqual({ ok: false, code: 'signing_key_unavailable' });
    expectDurableNoOp(store, before);
  });

  it('F3: fails closed with a durable no-op when keyset manifest construction fails', async () => {
    const { store, complete } = await stagedRegistration((s) => {
      // A VERIFY_ONLY record re-using the ACTIVE key's signingKeyId makes the
      // verifiable set inconsistent, so buildOacKeysetManifest rejects it.
      const keys = s.get('privilegedOacSigningKeys')!;
      const active = keys.get('key-1') as Record<string, unknown>;
      keys.set('key-1-dup', { ...active, status: 'VERIFY_ONLY', verifyUntilServerMs: 9_000_000 });
    });
    const before = durableSnapshot(store);

    const result = await complete();

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('duplicate_signing_key_id');
    expectDurableNoOp(store, before);
  });

  it('F3: the happy path consumes each one-time record exactly once and returns both artifacts', async () => {
    const { store, complete } = await stagedRegistration();

    const result = await complete();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(typeof result.oks1Base64).toBe('string');
    expect(result.oks1Base64!.length).toBeGreaterThan(0);
    expect(typeof result.serverFinalizationReceiptBase64).toBe('string');

    const auth = Array.from(store.get('privilegedDeviceEnrollmentAuthorizations')!.values())[0] as { status: string };
    const session = Array.from(store.get('privilegedDeviceRegistrationSessions')!.values())[0] as { status: string };
    expect(auth.status).toBe('CONSUMED');
    expect(session.status).toBe('CONSUMED');
    expect(store.get('privilegedDeviceRegistrations')!.size).toBe(1);
    const device = Array.from(store.get('privilegedDeviceRegistrations')!.values())[0] as { status: string };
    expect(device.status).toBe('ACTIVE');
  });

  it('F3: an already-ACTIVE device leaves the authorization and session unchanged', async () => {
    const { db, store, complete } = await stagedRegistration();
    // Pre-create the device this DRP1 would register.
    db.collection('privilegedDeviceRegistrations')
      .doc(Buffer.alloc(16, 0x77).toString('hex'))
      .set({ status: 'ACTIVE', branchId: 'LDP-001', deviceKeyVersion: 1, validatedDevProofPublicKeyBase64: 'x' });
    const before = durableSnapshot(store);

    const result = await complete();

    expect(result).toEqual({ ok: false, code: 'device_already_enrolled_reenroll_required' });
    const after = durableSnapshot(store);
    expect(after.auth).toBe(before.auth);
    expect(after.session).toBe(before.session);
    expect(after.device).toBe(before.device);
  });

  it('validates DRP1, consumes the authorization + session, and persists the device registration', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db, store } = genericFakeFirestore(baseSeed(issuer, signingKey));
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);

    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const securityDeviceId = Buffer.alloc(16, 0x77);
    const { drp1, device } = buildSignedDrp1(enrollmentAuthId, nonce, securityDeviceId);

    const result = await performCompleteDeviceRegistration(
      db,
      { uid: STAFF_UID },
      { registrationSessionId: beginReg.registrationSessionId, drp1Base64: drp1.toString('base64') },
      2100,
    );
    expect(result).toEqual({
      ok: true,
      securityDeviceIdHex: securityDeviceId.toString('hex'),
      branchId: 'LDP-001',
      deviceKeyVersion: 1,
      acceptedPublicKeyBase64: Buffer.from(device.publicKeyBase64Url, 'base64url').toString('base64'),
      serverFinalizationReceiptBase64: expect.any(String),
      oks1Base64: expect.any(String),
    });

    if (result.ok) {
      const decodedReceipt = decodeEfr1(Buffer.from(result.serverFinalizationReceiptBase64, 'base64'));
      expect(decodedReceipt.ok).toBe(true);
      if (decodedReceipt.ok) {
        expect(decodedReceipt.value.operationKind).toBe(EFR1_OP_INITIAL_ENROLLMENT);
        expect(decodedReceipt.value.securityDeviceId).toEqual(securityDeviceId);
        expect(decodedReceipt.value.deviceKeyVersion).toBe(1);
        expect(decodedReceipt.value.branchId).toBe('LDP-001');
      }
    }

    const authRecord = store.get('privilegedDeviceEnrollmentAuthorizations')!.get(enrollmentAuthId) as { status: string };
    expect(authRecord.status).toBe('CONSUMED');
    const deviceRecord = store.get('privilegedDeviceRegistrations')!.get(securityDeviceId.toString('hex')) as {
      status: string;
      deviceKeyVersion: number;
    };
    expect(deviceRecord).toBeDefined();
    expect(deviceRecord.status).toBe('ACTIVE');
    expect(deviceRecord.deviceKeyVersion).toBe(1);
  });

  it('rejects initial registration when device is already enrolled', async () => {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const seed = baseSeed(issuer, signingKey);
    const securityDeviceId = Buffer.alloc(16, 0x77);
    const existingDeviceIdHex = securityDeviceId.toString('hex');
    (seed as Record<string, unknown>).privilegedDeviceRegistrations = {
      [existingDeviceIdHex]: {
        securityDeviceIdHex: existingDeviceIdHex,
        status: 'ACTIVE',
        deviceKeyVersion: 1,
      },
    };
    const { db } = genericFakeFirestore(seed);
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);

    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1 } = buildSignedDrp1(enrollmentAuthId, nonce, securityDeviceId);

    const result = await performCompleteDeviceRegistration(
      db,
      { uid: STAFF_UID },
      { registrationSessionId: beginReg.registrationSessionId, drp1Base64: drp1.toString('base64') },
      2100,
    );
    expect(result).toEqual({ ok: false, code: 'device_already_enrolled_reenroll_required' });
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

describe('completeDeviceRegistration — consumed-session exact replay (response-loss recovery)', () => {
  const originalEnv = process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
  const GEN = '0123456789abcdef0123456789abcdef';
  const SEC_ID = Buffer.alloc(16, 0x77);
  const SEC_ID_HEX = SEC_ID.toString('hex');
  // Far beyond the 10-minute session TTL: consumed recovery is not expiry-bound.
  const REPLAY_AT = 2100 + 24 * 60 * 60 * 1000;

  beforeEach(() => {
    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = testRoot.privateKeyBase64Url;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = originalEnv;
    } else {
      delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    }
  });

  /** Counts every durable mutation attempted through a wrapped fake db. */
  function withWriteCounter(inner: Firestore) {
    const counts = { writes: 0, transactions: 0 };
    const db = {
      collection: (name: string) => {
        const c = inner.collection(name) as unknown as { doc: (id: string) => Record<string, (...a: unknown[]) => unknown> };
        return {
          ...c,
          doc: (id: string) => {
            const h = c.doc(id);
            const count =
              (fn: (...a: unknown[]) => unknown) =>
              (...a: unknown[]) => {
                counts.writes += 1;
                return fn(...a);
              };
            return { ...h, set: count(h.set), update: count(h.update), create: count(h.create) };
          },
        };
      },
      runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
        counts.transactions += 1;
        return (inner as unknown as { runTransaction: (f: typeof fn) => Promise<void> }).runTransaction(fn);
      },
    } as unknown as Firestore;
    return { db, counts };
  }

  const snapshotAll = (store: Map<string, Map<string, unknown>>) =>
    JSON.stringify(Array.from(store.entries()).map(([c, m]) => [c, Array.from(m.entries())]));

  /** Runs a real first completion that COMMITS, then returns the replay seam. */
  async function committedRegistration() {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db, store } = genericFakeFirestore(baseSeed(issuer, signingKey) as unknown as Record<string, Record<string, unknown>>);
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);
    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1, device } = buildSignedDrp1(enrollmentAuthId, nonce, SEC_ID);
    const request = {
      registrationSessionId: beginReg.registrationSessionId,
      drp1Base64: drp1.toString('base64'),
      enrollmentGenerationId: GEN,
    };
    const first = await performCompleteDeviceRegistration(db, { uid: STAFF_UID }, request, 2100);
    if (!first.ok) throw new Error(`first completion failed: ${first.code}`);
    const replay = (req: Record<string, unknown> = request, uid = STAFF_UID, target: Firestore = db) =>
      performCompleteDeviceRegistration(target, { uid }, req, REPLAY_AT);
    return { db, store, request, drp1, device, nonce, enrollmentAuthId, first, replay, sessionId: beginReg.registrationSessionId };
  }

  const deviceDoc = (store: Map<string, Map<string, unknown>>) =>
    store.get('privilegedDeviceRegistrations')!.get(SEC_ID_HEX) as Record<string, unknown>;

  async function expectRejectedWithZeroWrites(
    setup: Awaited<ReturnType<typeof committedRegistration>>,
    expectedCode: string,
    req?: Record<string, unknown>,
    uid?: string,
  ) {
    const before = snapshotAll(setup.store);
    const { db, counts } = withWriteCounter(setup.db);
    const result = await setup.replay(req ?? setup.request, uid ?? STAFF_UID, db);
    expect(result).toEqual({ ok: false, code: expectedCode });
    expect(counts).toEqual({ writes: 0, transactions: 0 });
    expect(snapshotAll(setup.store)).toBe(before);
  }

  it('the first happy path consumes once and stores the exact completion digest', async () => {
    const { store, drp1, sessionId } = await committedRegistration();
    const session = store.get('privilegedDeviceRegistrationSessions')!.get(sessionId) as Record<string, unknown>;
    expect(session.status).toBe('CONSUMED');
    expect(session.completionRequestSha256).toBe(completionRequestDigest(sessionId, drp1, GEN));
    expect(store.get('privilegedDeviceRegistrations')!.size).toBe(1);
  });

  it('an exact replay of a consumed session returns fresh valid material with ZERO writes', async () => {
    const setup = await committedRegistration();
    const before = snapshotAll(setup.store);
    const { db, counts } = withWriteCounter(setup.db);

    const result = await setup.replay(setup.request, STAFF_UID, db);

    expect(result).toEqual({
      ok: true,
      securityDeviceIdHex: SEC_ID_HEX,
      branchId: 'LDP-001',
      deviceKeyVersion: 1,
      acceptedPublicKeyBase64: Buffer.from(setup.device.publicKeyBase64Url, 'base64url').toString('base64'),
      serverFinalizationReceiptBase64: expect.any(String),
      oks1Base64: expect.any(String),
    });
    expect(counts).toEqual({ writes: 0, transactions: 0 });
    expect(snapshotAll(setup.store)).toBe(before); // no status/version/timestamp change anywhere
    if (!result.ok || !setup.first.ok) throw new Error('unreachable');

    const efr1 = decodeEfr1(Buffer.from(result.serverFinalizationReceiptBase64, 'base64'));
    expect(efr1.ok).toBe(true);
    if (!efr1.ok) throw new Error('unreachable');
    expect(efr1.value.operationKind).toBe(EFR1_OP_INITIAL_ENROLLMENT);
    expect(efr1.value.enrollmentGenerationId.toString('hex')).toBe(GEN);
    expect(efr1.value.securityDeviceId).toEqual(SEC_ID);
    expect(efr1.value.deviceKeyVersion).toBe(1);
    expect(efr1.value.acceptedPublicKey).toEqual(Buffer.from(setup.device.publicKeyBase64Url, 'base64url'));
    expect(efr1.value.receiptNonce).toEqual(setup.nonce);
    expect(efr1.value.branchId).toBe('LDP-001');
    // Freshly recomputed (new serverSentAt), not a persisted copy of the first receipt.
    expect(result.serverFinalizationReceiptBase64).not.toBe(setup.first.serverFinalizationReceiptBase64);
    expect(deviceDoc(setup.store).deviceKeyVersion).toBe(1);
  });

  it('rejects a replay whose request digest differs (different generation)', async () => {
    const setup = await committedRegistration();
    await expectRejectedWithZeroWrites(setup, 'completion_replay_mismatch', { ...setup.request, enrollmentGenerationId: 'f'.repeat(32) });
  });

  it('rejects a different validly-signed DRP1 for the same session nonce', async () => {
    const setup = await committedRegistration();
    const { drp1: other } = buildSignedDrp1(setup.enrollmentAuthId, setup.nonce, SEC_ID);
    await expectRejectedWithZeroWrites(setup, 'completion_replay_mismatch', { ...setup.request, drp1Base64: other.toString('base64') });
  });

  it('rejects a tampered DRP1', async () => {
    const setup = await committedRegistration();
    const tampered = Buffer.from(setup.drp1);
    tampered[tampered.length - 1] ^= 0xff;
    await expectRejectedWithZeroWrites(setup, 'drp1_bad_self_signature', { ...setup.request, drp1Base64: tampered.toString('base64') });
  });

  it('rejects a replay from a different requester', async () => {
    const setup = await committedRegistration();
    await expectRejectedWithZeroWrites(setup, 'session_wrong_owner', undefined, 'someone-else');
  });

  it.each([
    ['device missing', (s: Map<string, Map<string, unknown>>) => s.get('privilegedDeviceRegistrations')!.delete(SEC_ID_HEX)],
    ['device REVOKED', (s: Map<string, Map<string, unknown>>) => (deviceDoc(s).status = 'REVOKED')],
    ['device branch changed', (s: Map<string, Map<string, unknown>>) => (deviceDoc(s).branchId = 'LDP-002')],
    ['device version 2 (re-enrolled)', (s: Map<string, Map<string, unknown>>) => (deviceDoc(s).deviceKeyVersion = 2)],
    ['device key changed', (s: Map<string, Map<string, unknown>>) => (deviceDoc(s).validatedDevProofPublicKeyBase64 = Buffer.alloc(32, 9).toString('base64'))],
    ['device nonce changed', (s: Map<string, Map<string, unknown>>) => (deviceDoc(s).devProofRegistrationNonce = Buffer.alloc(32, 9).toString('base64'))],
    ['reEnrolledAtServerMs present', (s: Map<string, Map<string, unknown>>) => (deviceDoc(s).reEnrolledAtServerMs = 5000)],
    [
      'authorization not CONSUMED',
      (s: Map<string, Map<string, unknown>>) => {
        const auths = s.get('privilegedDeviceEnrollmentAuthorizations')!;
        for (const [id, a] of auths) auths.set(id, { ...(a as object), status: 'ISSUED' });
      },
    ],
    [
      'authorization branch differs from device branch',
      (s: Map<string, Map<string, unknown>>) => {
        const auths = s.get('privilegedDeviceEnrollmentAuthorizations')!;
        for (const [id, a] of auths) auths.set(id, { ...(a as object), branchId: 'LDP-009' });
      },
    ],
  ])('rejects when the committed state changed: %s', async (_label, mutate) => {
    const setup = await committedRegistration();
    mutate(setup.store);
    await expectRejectedWithZeroWrites(setup, 'device_state_changed');
  });

  it('a legacy consumed session without a stored digest fails closed', async () => {
    const setup = await committedRegistration();
    const sessions = setup.store.get('privilegedDeviceRegistrationSessions')!;
    const { completionRequestSha256: _drop, ...legacy } = sessions.get(setup.sessionId) as Record<string, unknown>;
    sessions.set(setup.sessionId, legacy);
    await expectRejectedWithZeroWrites(setup, 'legacy_session_unrecoverable');
  });

  it('root key failure during replay: zero writes, and a later explicit replay still succeeds', async () => {
    const setup = await committedRegistration();
    delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    await expectRejectedWithZeroWrites(setup, 'root_signing_key_unavailable');
    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = testRoot.privateKeyBase64Url;
    expect((await setup.replay()).ok).toBe(true);
  });

  it('active signing key failure during replay: zero writes', async () => {
    const setup = await committedRegistration();
    setup.store.get('privilegedOacKeysetMeta')!.set('current', { activeSigningKeyId: 'missing-key' });
    await expectRejectedWithZeroWrites(setup, 'signing_key_unavailable');
  });

  // --- N2: a rejected transaction is adjudicated from the session, not trusted ---

  type TxMode = 'commit_then_reject' | 'commit_then_retry' | 'reject_without_commit';

  /**
   * Wraps a fake db so `runTransaction` can model Firestore outcomes the plain
   * fake cannot: the commit is APPLIED and then the call rejects (lost commit
   * acknowledgement), the commit is applied and the runner RETRIES the
   * callback (which then observes its own writes), or it rejects without
   * committing. Hooks mutate the store at exact points.
   */
  function faultyTransactions(
    inner: Firestore,
    mode: TxMode,
    hooks: { afterCommit?: () => void; beforeReject?: () => void; failSessionRereads?: boolean } = {},
  ) {
    const counts = { transactions: 0, callbackRuns: 0, sessionGets: 0 };
    const innerRun = (fn: (tx: unknown) => Promise<void>) =>
      (inner as unknown as { runTransaction: (f: typeof fn) => Promise<void> }).runTransaction(fn);
    const db = {
      collection: (name: string) => {
        const c = inner.collection(name) as unknown as { doc: (id: string) => Record<string, (...a: unknown[]) => unknown> };
        if (name !== 'privilegedDeviceRegistrationSessions' || !hooks.failSessionRereads) return c;
        return {
          ...c,
          doc: (id: string) => {
            const h = c.doc(id);
            return {
              ...h,
              get: async () => {
                counts.sessionGets += 1;
                if (counts.sessionGets > 1) throw new Error('UNAVAILABLE: session reread failed');
                return h.get();
              },
            };
          },
        };
      },
      runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
        counts.transactions += 1;
        const counted = async (tx: unknown) => {
          counts.callbackRuns += 1;
          return fn(tx);
        };
        if (mode === 'reject_without_commit') {
          hooks.beforeReject?.();
          throw new Error('ABORTED: transaction contention');
        }
        await innerRun(counted); // the commit is durably applied
        hooks.afterCommit?.();
        if (mode === 'commit_then_retry') await innerRun(counted); // retry observes its own writes and throws
        throw new Error('DEADLINE_EXCEEDED: commit acknowledgement lost');
      },
    } as unknown as Firestore;
    return { db, counts };
  }

  /** Everything up to (not including) the first completion call. */
  async function stagedForCompletion() {
    const issuer = rawKeypair();
    const signingKey = rawKeypair();
    const { db, store } = genericFakeFirestore(baseSeed(issuer, signingKey) as unknown as Record<string, Record<string, unknown>>);
    const { enrollmentAuthId } = await beginAndCompleteIssuance(db, issuer, 'LDP-001', 1000);
    const beginReg = await performBeginDeviceRegistration(db, { uid: STAFF_UID }, 2000);
    if (!beginReg.ok) throw new Error('unreachable');
    const nonce = Buffer.from(beginReg.deviceRegistrationNonceBase64, 'base64');
    const { drp1, device } = buildSignedDrp1(enrollmentAuthId, nonce, SEC_ID);
    const request = {
      registrationSessionId: beginReg.registrationSessionId,
      drp1Base64: drp1.toString('base64'),
      enrollmentGenerationId: GEN,
    };
    const session = () =>
      store.get('privilegedDeviceRegistrationSessions')!.get(beginReg.registrationSessionId) as Record<string, unknown>;
    return { db, store, request, nonce, device, drp1, session, sessionId: beginReg.registrationSessionId };
  }

  function expectCommittedExactlyOnce(store: Map<string, Map<string, unknown>>, sessionId: string, drp1: Buffer) {
    const session = store.get('privilegedDeviceRegistrationSessions')!.get(sessionId) as Record<string, unknown>;
    expect(session.status).toBe('CONSUMED');
    expect(session.completionRequestSha256).toBe(completionRequestDigest(sessionId, drp1, GEN));
    expect(store.get('privilegedDeviceRegistrations')!.size).toBe(1);
    expect(deviceDoc(store).deviceKeyVersion).toBe(1);
    const auths = Array.from(store.get('privilegedDeviceEnrollmentAuthorizations')!.values()) as Array<{ status: string }>;
    expect(auths.map((a) => a.status)).toEqual(['CONSUMED']);
  }

  it('N2-A: commit applied then acknowledgement lost -> reread CONSUMED -> exact replay success, no second write', async () => {
    const s = await stagedForCompletion();
    const { db: counted, counts: writes } = withWriteCounter(s.db);
    const { db, counts } = faultyTransactions(counted, 'commit_then_reject');

    const result = await performCompleteDeviceRegistration(db, { uid: STAFF_UID }, s.request, 2100);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(counts).toMatchObject({ transactions: 1, callbackRuns: 1 });
    expect(writes.writes).toBe(3); // the one applied commit only; the replay wrote nothing
    expectCommittedExactlyOnce(s.store, s.sessionId, s.drp1);
    const efr1 = decodeEfr1(Buffer.from(result.serverFinalizationReceiptBase64, 'base64'));
    if (!efr1.ok) throw new Error('EFR1 must decode');
    expect(efr1.value.operationKind).toBe(EFR1_OP_INITIAL_ENROLLMENT);
    expect(efr1.value.enrollmentGenerationId.toString('hex')).toBe(GEN);
    expect(efr1.value.securityDeviceId).toEqual(SEC_ID);
    expect(efr1.value.deviceKeyVersion).toBe(1);
    expect(efr1.value.receiptNonce).toEqual(s.nonce);
    expect(efr1.value.branchId).toBe('LDP-001');
    expect(typeof result.oks1Base64).toBe('string');
  });

  it('N2-B: commit applied, runner retries and observes its own ACTIVE device -> exact replay success', async () => {
    const s = await stagedForCompletion();
    const { db: counted, counts: writes } = withWriteCounter(s.db);
    const { db, counts } = faultyTransactions(counted, 'commit_then_retry');

    const result = await performCompleteDeviceRegistration(db, { uid: STAFF_UID }, s.request, 2100);

    expect(result.ok).toBe(true);
    expect(counts).toMatchObject({ transactions: 1, callbackRuns: 2 });
    expect(writes.writes).toBe(3);
    expectCommittedExactlyOnce(s.store, s.sessionId, s.drp1);
  });

  it('N2-C: a genuine pre-commit semantic failure (session still PENDING) keeps its structured code and writes nothing', async () => {
    const s = await stagedForCompletion();
    s.store.set('privilegedDeviceRegistrations', new Map([[SEC_ID_HEX, { status: 'ACTIVE', branchId: 'LDP-001', deviceKeyVersion: 1 }]]));
    const durable = () =>
      JSON.stringify(
        ['privilegedDeviceEnrollmentAuthorizations', 'privilegedDeviceRegistrationSessions', 'privilegedDeviceRegistrations'].map(
          (c) => Array.from(s.store.get(c)?.entries() ?? []),
        ),
      );
    const before = durable();
    const { db, counts } = withWriteCounter(s.db);

    const result = await performCompleteDeviceRegistration(db, { uid: STAFF_UID }, s.request, 2100);

    expect(result).toEqual({ ok: false, code: 'device_already_enrolled_reenroll_required' });
    expect(counts.writes).toBe(0);
    expect(s.session().status).toBe('PENDING');
    expect(durable()).toBe(before);
  });

  it('N2-D: transaction rejected and the session reread fails -> throws (ambiguous), never a structured rejection', async () => {
    const s = await stagedForCompletion();
    const { db: counted, counts: writes } = withWriteCounter(s.db);
    const { db } = faultyTransactions(counted, 'reject_without_commit', { failSessionRereads: true });

    await expect(performCompleteDeviceRegistration(db, { uid: STAFF_UID }, s.request, 2100)).rejects.toThrow(
      'completion_outcome_unknown',
    );
    expect(writes.writes).toBe(0);
    expect(s.session().status).toBe('PENDING');
  });

  it.each([
    ['unknown status', (s: Awaited<ReturnType<typeof stagedForCompletion>>) => (s.session().status = 'EXPIRED')],
    ['malformed session', (s: Awaited<ReturnType<typeof stagedForCompletion>>) => delete s.session().requesterUid],
    [
      'missing session',
      (s: Awaited<ReturnType<typeof stagedForCompletion>>) =>
        s.store.get('privilegedDeviceRegistrationSessions')!.delete(s.sessionId),
    ],
  ])('N2-E: transaction rejected and the reread shows %s -> throws (ambiguous)', async (_label, mutate) => {
    const s = await stagedForCompletion();
    const { db } = faultyTransactions(s.db, 'reject_without_commit', { beforeReject: () => mutate(s) });
    await expect(performCompleteDeviceRegistration(db, { uid: STAFF_UID }, s.request, 2100)).rejects.toThrow(
      'completion_outcome_unknown',
    );
  });

  it('N2-F: commit applied but the replay cannot prove it (device changed) -> throws, never a structured rejection', async () => {
    const s = await stagedForCompletion();
    const { db } = faultyTransactions(s.db, 'commit_then_reject', {
      afterCommit: () => {
        deviceDoc(s.store).status = 'REVOKED';
      },
    });
    await expect(performCompleteDeviceRegistration(db, { uid: STAFF_UID }, s.request, 2100)).rejects.toThrow(
      'completion_outcome_unknown',
    );
  });

  it('keyset manifest failure during replay: zero writes', async () => {
    const setup = await committedRegistration();
    const keys = setup.store.get('privilegedOacSigningKeys')!;
    keys.set('key-1-dup', { ...(keys.get('key-1') as object), status: 'VERIFY_ONLY', verifyUntilServerMs: 9e15 });
    await expectRejectedWithZeroWrites(setup, 'duplicate_signing_key_id');
  });
});
