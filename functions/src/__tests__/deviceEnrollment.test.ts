import { createHash, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  performBeginDeviceEnrollmentAuthorizationIssuance,
  performBeginDeviceRegistration,
  performCompleteDeviceEnrollmentAuthorizationIssuance,
  performCompleteDeviceRegistration,
} from '../deviceEnrollment';
import { canonicalJSON } from '../credentialStore';
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
