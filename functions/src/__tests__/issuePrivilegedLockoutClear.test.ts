import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { performIssuePrivilegedLockoutClear } from '../issuePrivilegedLockoutClear';
import { decodeLct1 } from '../oacFrame';
import { publicKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';
import { verify as ed25519Verify } from 'node:crypto';
import { lct1SignedPrefix } from '../oacFrame';

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

const ADMIN_UID = 'admin-1';
const MANAGER_UID = 'mgr-1';
const DEVICE_HEX = 'a'.repeat(32);
const LOCKOUT_ID_HEX = 'b'.repeat(64);

function buildSeed(signingKey: ReturnType<typeof rawKeypair>) {
  return {
    users: {
      [ADMIN_UID]: { role: 'admin', isActive: true, deletedAt: null },
      [MANAGER_UID]: { role: 'manager', isActive: true, deletedAt: null },
    },
    privilegedDeviceRegistrations: {
      [DEVICE_HEX]: {
        securityDeviceIdHex: DEVICE_HEX,
        branchId: 'B01',
        registeredAtServerMs: 1_700_000_000_000,
        status: 'ACTIVE',
        isActive: true,
      },
    },
    privilegedOacKeysetMeta: {
      current: { activeSigningKeyId: 'key-1' },
    },
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

describe('issuePrivilegedLockoutClear', () => {
  const key = rawKeypair();

  it('rejects unauthenticated caller', async () => {
    const { db } = genericFakeFirestore(buildSeed(key));
    const res = await performIssuePrivilegedLockoutClear(db, null, {
      securityDeviceIdHex: DEVICE_HEX,
      managerStaffId: MANAGER_UID,
      lockoutIdHex: LOCKOUT_ID_HEX,
    });
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('rejects non-admin caller', async () => {
    const { db } = genericFakeFirestore(buildSeed(key));
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: MANAGER_UID, token: { role: 'manager' } },
      {
        securityDeviceIdHex: DEVICE_HEX,
        managerStaffId: MANAGER_UID,
        lockoutIdHex: LOCKOUT_ID_HEX,
      },
    );
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('rejects invalid request shape', async () => {
    const { db } = genericFakeFirestore(buildSeed(key));
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: 'invalid', managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'invalid_request_shape' });
  });

  it('rejects unregistered device', async () => {
    const { db } = genericFakeFirestore(buildSeed(key));
    const otherDevHex = 'c'.repeat(32);
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: otherDevHex, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'device_not_registered' });
  });

  it('rejects inactive device', async () => {
    const seed = buildSeed(key);
    seed.privilegedDeviceRegistrations[DEVICE_HEX].status = 'INACTIVE';
    const { db } = genericFakeFirestore(seed);
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'device_inactive' });
  });

  it('rejects revoked device', async () => {
    const seed = buildSeed(key);
    seed.privilegedDeviceRegistrations[DEVICE_HEX].status = 'REVOKED';
    const { db } = genericFakeFirestore(seed);
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'device_inactive' });
  });

  it('rejects mismatched device id in record', async () => {
    const seed = buildSeed(key);
    seed.privilegedDeviceRegistrations[DEVICE_HEX].securityDeviceIdHex = 'd'.repeat(32);
    const { db } = genericFakeFirestore(seed);
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'device_not_registered' });
  });

  it('rejects malformed device record (missing branchId or branchId is ALL)', async () => {
    const seed1 = buildSeed(key);
    delete (seed1.privilegedDeviceRegistrations[DEVICE_HEX] as Record<string, unknown>).branchId;
    const { db: db1 } = genericFakeFirestore(seed1);
    const res1 = await performIssuePrivilegedLockoutClear(
      db1,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res1).toEqual({ ok: false, code: 'device_not_registered' });

    const seed2 = buildSeed(key);
    seed2.privilegedDeviceRegistrations[DEVICE_HEX].branchId = 'ALL';
    const { db: db2 } = genericFakeFirestore(seed2);
    const res2 = await performIssuePrivilegedLockoutClear(
      db2,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res2).toEqual({ ok: false, code: 'device_not_registered' });
  });

  it('rejects non-existent manager', async () => {
    const { db } = genericFakeFirestore(buildSeed(key));
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: 'unknown_mgr', lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'manager_not_found' });
  });

  it('rejects inactive manager', async () => {
    const seed = buildSeed(key);
    seed.users[MANAGER_UID].isActive = false;
    const { db } = genericFakeFirestore(seed);
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'manager_inactive' });
  });

  it('rejects deleted manager', async () => {
    const seed = buildSeed(key);
    seed.users[MANAGER_UID].deletedAt = 1_700_000_000_000;
    const { db } = genericFakeFirestore(seed);
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'manager_inactive' });
  });

  it('rejects non-manager target (e.g. cashier)', async () => {
    const seed = buildSeed(key);
    seed.users[MANAGER_UID].role = 'cashier';
    const { db } = genericFakeFirestore(seed);
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'manager_not_found' });
  });

  it('rejects malformed managerStaffId with invalid_request_shape', async () => {
    const { db } = genericFakeFirestore(buildSeed(key));
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: 'mgr bad spaces', lockoutIdHex: LOCKOUT_ID_HEX },
    );
    expect(res).toEqual({ ok: false, code: 'invalid_request_shape' });
  });

  it('issues valid signed LCT1 for authenticated admin', async () => {
    const { db } = genericFakeFirestore(buildSeed(key));
    const nowMs = 1_773_000_000_000;
    const res = await performIssuePrivilegedLockoutClear(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { securityDeviceIdHex: DEVICE_HEX, managerStaffId: MANAGER_UID, lockoutIdHex: LOCKOUT_ID_HEX },
      nowMs,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');

    expect(res.securityDeviceIdHex).toBe(DEVICE_HEX);
    expect(res.managerStaffId).toBe(MANAGER_UID);
    expect(res.lockoutIdHex).toBe(LOCKOUT_ID_HEX);
    expect(res.issuedAtServerMs).toBe(nowMs);

    const decoded = decodeLct1(Buffer.from(res.lct1Base64, 'base64'));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('unreachable');
    expect(decoded.value.securityDeviceId.toString('hex')).toBe(DEVICE_HEX);
    expect(decoded.value.managerStaffId).toBe(MANAGER_UID);
    expect(decoded.value.lockoutId.toString('hex')).toBe(LOCKOUT_ID_HEX);
    expect(decoded.value.signingKeyId).toBe('key-1');

    // Verify signature against public key
    const pubKey = publicKeyFromRaw(key.publicKeyBase64Url);
    const payload = lct1SignedPrefix(decoded.value);
    expect(ed25519Verify(null, payload, pubKey, decoded.value.signature)).toBe(true);
  });
});
