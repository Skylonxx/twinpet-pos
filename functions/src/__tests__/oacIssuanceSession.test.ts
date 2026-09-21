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

/**
 * In-memory Firestore fake with real transaction semantics, so the F6
 * one-winner consume is expressible deterministically:
 *
 *  - transaction writes are BUFFERED and applied only at commit;
 *  - every `tx.get` records the document's version in the read set;
 *  - at commit, a changed read-set document discards the attempt and re-runs
 *    the callback (Firestore's optimistic-concurrency retry);
 *  - `setBeforeCommit` installs a ONE-SHOT hook that fires after the callback
 *    body and before the conflict check — where a competing completion is
 *    injected. Self-clearing, so retries do not re-fire it.
 *
 * No timers and no real concurrency: interleavings are explicit and stable.
 */
function genericFakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Map<string, unknown>>();
  const versions = new Map<string, number>();
  for (const [collection, docs] of Object.entries(seed)) store.set(collection, new Map(Object.entries(docs)));

  let beforeCommit: (() => Promise<void> | void) | null = null;

  function coll(name: string): Map<string, unknown> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }
  const key = (c: string, id: string) => `${c}/${id}`;
  const versionOf = (c: string, id: string) => versions.get(key(c, id)) ?? 0;
  const bump = (c: string, id: string) => versions.set(key(c, id), versionOf(c, id) + 1);

  function applySet(c: string, id: string, data: unknown) {
    coll(c).set(id, data);
    bump(c, id);
  }
  function applyUpdate(c: string, id: string, patch: Record<string, unknown>) {
    coll(c).set(id, { ...(coll(c).get(id) as Record<string, unknown>), ...patch });
    bump(c, id);
  }

  function docHandle(collectionName: string, id: string) {
    return {
      __collection: collectionName,
      __id: id,
      get: async () => ({ exists: coll(collectionName).has(id), data: () => coll(collectionName).get(id) }),
      set: (data: unknown) => applySet(collectionName, id, data),
      update: (patch: Record<string, unknown>) => applyUpdate(collectionName, id, patch),
    };
  }

  type Ref = { __collection: string; __id: string };

  const db = {
    collection: (name: string) => ({ doc: (id: string) => docHandle(name, id) }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const readSet = new Map<string, number>();
        const buffered: Array<() => void> = [];
        const tx = {
          get: async (ref: Ref) => {
            readSet.set(key(ref.__collection, ref.__id), versionOf(ref.__collection, ref.__id));
            return {
              exists: coll(ref.__collection).has(ref.__id),
              data: () => coll(ref.__collection).get(ref.__id),
            };
          },
          set: (ref: Ref, data: unknown) => buffered.push(() => applySet(ref.__collection, ref.__id, data)),
          update: (ref: Ref, patch: Record<string, unknown>) =>
            buffered.push(() => applyUpdate(ref.__collection, ref.__id, patch)),
        };

        const result = await fn(tx);

        if (beforeCommit) {
          const hook = beforeCommit;
          beforeCommit = null; // one-shot
          await hook();
        }

        let conflict = false;
        for (const [k, v] of readSet) {
          const [c, i] = k.split('/');
          if (versionOf(c, i) !== v) {
            conflict = true;
            break;
          }
        }
        if (conflict) continue;

        for (const w of buffered) w();
        return result;
      }
      throw new Error('transaction_max_retries_exceeded');
    },
  } as unknown as Firestore;

  return {
    db,
    store,
    setBeforeCommit: (hook: () => Promise<void> | void) => {
      beforeCommit = hook;
    },
    /** Mutates a document outside any transaction (bumps its version). */
    mutate: (c: string, id: string, patch: Record<string, unknown>) => applyUpdate(c, id, patch),
    remove: (c: string, id: string) => {
      coll(c).delete(id);
      bump(c, id);
    },
  };
}

/** A canonical, strictly-parseable ACTIVE device registration record. */
function activeDeviceRecord(devProofPublicKeyBase64: string, branchId: string = BRANCH_ID) {
  return {
    securityDeviceIdHex: DEVICE_HEX,
    branchId,
    status: 'ACTIVE' as const,
    deviceKeyVersion: 1,
    validatedDevProofPublicKeyBase64: devProofPublicKeyBase64,
  };
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
      // Canonical ACTIVE record: the strict parser requires status and a
      // positive deviceKeyVersion, which the pre-F5 fixture omitted.
      [DEVICE_HEX]: activeDeviceRecord('AA=='),
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
  const fake = genericFakeFirestore(seed);
  const { db, store } = fake;

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
  store.get('privilegedDeviceRegistrations')!.set(DEVICE_HEX, activeDeviceRecord(devicePublicRaw.toString('base64')));

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

  return { db, store, fake, begin, ptp1Base64, pin1Base64, signingKey, devicePublicRaw };
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

    expect(typeof result.oacEnvelopeBytesBase64).toBe('string');
    expect(typeof result.srf1OacBase64).toBe('string');
    const rawBytes = Buffer.from(result.oacEnvelopeBytesBase64, 'base64');
    expect(JSON.parse(rawBytes.toString('utf8')).oacId).toBe(result.oac.oacId);
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

  // --- F5: strict ACTIVE device contract ------------------------------------

  const managerAuth = { uid: MANAGER_UID, token: { staffId: MANAGER_UID, authVersion: 0 } };

  async function beginWithDevice(deviceDoc: Record<string, unknown> | null) {
    const signingKey = rawKeypair();
    const seed = await seedManagerWithPin('123456', signingKey);
    if (deviceDoc === null) {
      delete (seed as Record<string, unknown>).privilegedDeviceRegistrations;
    } else {
      (seed as Record<string, Record<string, unknown>>).privilegedDeviceRegistrations = { [DEVICE_HEX]: deviceDoc };
    }
    const { db } = genericFakeFirestore(seed);
    return performBeginPrivilegedOacIssuanceSession(db, managerAuth, { securityDeviceIdHex: DEVICE_HEX }, 1000);
  }

  it('F5: begin refuses a REVOKED device', async () => {
    const result = await beginWithDevice({ ...activeDeviceRecord('AA=='), status: 'REVOKED' });
    expect(result).toEqual({ ok: false, code: 'device_not_active' });
  });

  it('F5: begin refuses a device record with no status field', async () => {
    const rec = { ...activeDeviceRecord('AA==') } as Record<string, unknown>;
    delete rec.status;
    const result = await beginWithDevice(rec);
    expect(result).toEqual({ ok: false, code: 'device_not_registered' });
  });

  it('F5: begin refuses a non-positive deviceKeyVersion', async () => {
    const result = await beginWithDevice({ ...activeDeviceRecord('AA=='), deviceKeyVersion: 0 });
    expect(result).toEqual({ ok: false, code: 'device_not_registered' });
  });

  it('F5: begin refuses an empty device proof key', async () => {
    const result = await beginWithDevice({ ...activeDeviceRecord('') });
    expect(result).toEqual({ ok: false, code: 'device_not_registered' });
  });

  it('F5: begin accepts a canonical ACTIVE record', async () => {
    const result = await beginWithDevice(activeDeviceRecord('AA=='));
    expect(result.ok).toBe(true);
  });

  it('F5: a device revoked between begin and completion cannot mint an OAC', async () => {
    const { db, store, fake, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    fake.mutate('privilegedDeviceRegistrations', DEVICE_HEX, { status: 'REVOKED' });

    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      managerAuth,
      { sessionId: begin.ok ? begin.sessionId : '', pin: '123456', ptp1Base64, pin1Base64 },
      1100,
    );

    expect(result).toEqual({ ok: false, code: 'device_not_active' });
    // The session must remain retryable after an accidental revocation.
    const session = store.get('privilegedOacIssuanceSessions')!.get(begin.ok ? begin.sessionId : '') as {
      status: string;
    };
    expect(session.status).toBe('PENDING');
  });

  it('F5: a device whose branch changed between begin and completion is refused', async () => {
    const { db, store, fake, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    fake.mutate('privilegedDeviceRegistrations', DEVICE_HEX, { branchId: 'OTHER-BRANCH' });

    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      managerAuth,
      { sessionId: begin.ok ? begin.sessionId : '', pin: '123456', ptp1Base64, pin1Base64 },
      1100,
    );

    expect(result).toEqual({ ok: false, code: 'device_branch_mismatch' });
    const session = store.get('privilegedOacIssuanceSessions')!.get(begin.ok ? begin.sessionId : '') as {
      status: string;
    };
    expect(session.status).toBe('PENDING');
  });

  it('F5: a device deleted between begin and completion is refused', async () => {
    const { db, store, fake, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    fake.remove('privilegedDeviceRegistrations', DEVICE_HEX);

    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      managerAuth,
      { sessionId: begin.ok ? begin.sessionId : '', pin: '123456', ptp1Base64, pin1Base64 },
      1100,
    );

    expect(result).toEqual({ ok: false, code: 'device_not_registered' });
    const session = store.get('privilegedOacIssuanceSessions')!.get(begin.ok ? begin.sessionId : '') as {
      status: string;
    };
    expect(session.status).toBe('PENDING');
  });

  // --- F6: one-winner anti-replay linearization -----------------------------

  it('F6: two concurrent completions yield exactly one OAC', async () => {
    const { db, store, fake, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    const sessionId = begin.ok ? begin.sessionId : '';
    const args = { sessionId, pin: '123456', ptp1Base64, pin1Base64 };

    // Caller A reads the session as PENDING inside its transaction; caller B
    // then completes end-to-end and consumes it. A must observe the conflict,
    // retry, see CONSUMED, and emit nothing.
    let bResult: Awaited<ReturnType<typeof performCompletePrivilegedOacIssuanceSession>> | null = null;
    fake.setBeforeCommit(async () => {
      bResult = await performCompletePrivilegedOacIssuanceSession(db, managerAuth, args, 1101);
    });

    const aResult = await performCompletePrivilegedOacIssuanceSession(db, managerAuth, args, 1100);

    const successes = [aResult, bResult!].filter((r) => r.ok);
    expect(successes).toHaveLength(1);
    expect(bResult!.ok).toBe(true);
    expect(aResult).toEqual({ ok: false, code: 'session_already_consumed' });

    const session = store.get('privilegedOacIssuanceSessions')!.get(sessionId) as {
      status: string;
      consumedAtServerMs: number;
    };
    expect(session.status).toBe('CONSUMED');
    expect(session.consumedAtServerMs).toBe(1101);
  });

  it('F6: three concurrent completions yield exactly one OAC', async () => {
    const { db, store, fake, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    const sessionId = begin.ok ? begin.sessionId : '';
    const args = { sessionId, pin: '123456', ptp1Base64, pin1Base64 };

    const others: Array<Awaited<ReturnType<typeof performCompletePrivilegedOacIssuanceSession>>> = [];
    fake.setBeforeCommit(async () => {
      others.push(await performCompletePrivilegedOacIssuanceSession(db, managerAuth, args, 1101));
      others.push(await performCompletePrivilegedOacIssuanceSession(db, managerAuth, args, 1102));
    });

    const aResult = await performCompletePrivilegedOacIssuanceSession(db, managerAuth, args, 1100);

    const all = [aResult, ...others];
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.ok)).toHaveLength(1);
    for (const failed of all.filter((r) => !r.ok)) {
      expect(failed).toEqual({ ok: false, code: 'session_already_consumed' });
    }
    expect((store.get('privilegedOacIssuanceSessions')!.get(sessionId) as { status: string }).status).toBe('CONSUMED');
  });

  it('F6: a session that expires before the consume commits is not consumed', async () => {
    const { db, store, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    const sessionId = begin.ok ? begin.sessionId : '';

    // nowMs past the session's expiry: the transaction's re-validation must
    // reject it rather than consuming an expired session.
    const expiredAt = (begin.ok ? begin.expiresAtMillis : 0) + 1;
    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      managerAuth,
      { sessionId, pin: '123456', ptp1Base64, pin1Base64 },
      expiredAt,
    );

    expect(result).toEqual({ ok: false, code: 'session_expired' });
    expect((store.get('privilegedOacIssuanceSessions')!.get(sessionId) as { status: string }).status).toBe('PENDING');
  });

  it('F6: a signing failure leaves the session PENDING (signing precedes the consume)', async () => {
    const { db, store, begin, ptp1Base64, pin1Base64 } = await fullHappyPathSetup();
    const sessionId = begin.ok ? begin.sessionId : '';
    // Remove the active signing key so OAC signing cannot happen at all.
    store.get('privilegedOacSigningKeys')!.delete('key-1');

    const result = await performCompletePrivilegedOacIssuanceSession(
      db,
      managerAuth,
      { sessionId, pin: '123456', ptp1Base64, pin1Base64 },
      1100,
    );

    expect(result).toEqual({ ok: false, code: 'signing_key_unavailable' });
    expect((store.get('privilegedOacIssuanceSessions')!.get(sessionId) as { status: string }).status).toBe('PENDING');
  });
});
