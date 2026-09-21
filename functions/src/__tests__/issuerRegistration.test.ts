import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { performRegisterIssuer, performRevokeIssuerRegistration } from '../issuerRegistration';
import { registerIssuerPossessionProofPayload, sha256HexOfBase64UrlToken } from '../issuerRegistrationCore';
import { privateKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * In-memory Firestore fake with real transaction semantics, so the
 * single-use-bootstrap-token race is expressible deterministically:
 *
 *  - transaction writes are BUFFERED and applied only at commit;
 *  - every `tx.get` records the document's version in the read set;
 *  - at commit, if any document in the read set changed since it was read,
 *    the attempt is discarded and the callback re-runs (Firestore's
 *    optimistic-concurrency retry);
 *  - `setBeforeCommit` installs a ONE-SHOT hook that fires after the callback
 *    body and before the conflict check, which is where a competing writer is
 *    injected. Self-clearing, so the retry does not re-fire it.
 *
 * No timers and no real concurrency: interleavings are explicit and stable.
 */
function fakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Map<string, unknown>>();
  const versions = new Map<string, number>();
  for (const [collection, docs] of Object.entries(seed)) {
    const m = new Map<string, unknown>();
    for (const [id, data] of Object.entries(docs)) m.set(id, data);
    store.set(collection, m);
  }

  let beforeCommit: (() => Promise<void> | void) | null = null;
  let beforeCommitFireCount = 0;

  function collectionMap(name: string): Map<string, unknown> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }
  const key = (c: string, id: string) => `${c}/${id}`;
  const versionOf = (c: string, id: string) => versions.get(key(c, id)) ?? 0;
  function bump(c: string, id: string) {
    versions.set(key(c, id), versionOf(c, id) + 1);
  }

  function applySet(c: string, id: string, data: unknown) {
    collectionMap(c).set(id, data);
    bump(c, id);
  }
  function applyUpdate(c: string, id: string, patch: Record<string, unknown>) {
    const m = collectionMap(c);
    m.set(id, { ...(m.get(id) as Record<string, unknown>), ...patch });
    bump(c, id);
  }
  function applyCreate(c: string, id: string, data: unknown) {
    const m = collectionMap(c);
    if (m.has(id)) throw new Error('already exists');
    m.set(id, data);
    bump(c, id);
  }

  function docHandle(collectionName: string, id: string) {
    return {
      __collection: collectionName,
      __id: id,
      get: async () => {
        const m = collectionMap(collectionName);
        return { exists: m.has(id), data: () => m.get(id) };
      },
      update: async (patch: Record<string, unknown>) => applyUpdate(collectionName, id, patch),
      set: (data: unknown) => applySet(collectionName, id, data),
      create: (data: unknown) => applyCreate(collectionName, id, data),
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
            const m = collectionMap(ref.__collection);
            return { exists: m.has(ref.__id), data: () => m.get(ref.__id) };
          },
          set: (ref: Ref, data: unknown) => {
            buffered.push(() => applySet(ref.__collection, ref.__id, data));
          },
          update: (ref: Ref, patch: Record<string, unknown>) => {
            buffered.push(() => applyUpdate(ref.__collection, ref.__id, patch));
          },
          create: (ref: Ref, data: unknown) => {
            buffered.push(() => applyCreate(ref.__collection, ref.__id, data));
          },
        };

        // Expected failures thrown by the callback abort the transaction
        // outright (Firestore does not retry arbitrary caller errors).
        const result = await fn(tx);

        if (beforeCommit) {
          const hook = beforeCommit;
          beforeCommit = null; // one-shot
          beforeCommitFireCount += 1;
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
        if (conflict) continue; // retry with fresh reads

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
    beforeCommitFireCount: () => beforeCommitFireCount,
  };
}

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

const ADMIN_UID = 'admin-1';

function seedAdmin() {
  return { users: { [ADMIN_UID]: { role: 'admin', isActive: true, deletedAt: null } } };
}

describe('performRegisterIssuer', () => {
  it('registers a new issuer given a valid bootstrap token and possession proof', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x11).toString('base64url');
    const { db, store } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-1': {
          tokenId: 'token-1',
          issuerId: 'hq-console-01',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'PENDING',
          expiresAtServerMs: 10_000,
        },
      },
    });

    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-1', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url)).toString(
      'base64',
    );

    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      {
        issuerId: 'hq-console-01',
        requestId: 'r'.repeat(32),
        bootstrapTokenId: 'token-1',
        bootstrapToken: rawToken,
        publicKeyBase64Url,
        signature,
      },
      1000,
    );

    expect(result).toEqual({ ok: true, issuerId: 'hq-console-01' });
    expect((store.get('privilegedIssuerBootstrapTokens')!.get('token-1') as { status: string }).status).toBe(
      'CONSUMED',
    );
    const registration = store.get('privilegedIssuerRegistrations')!.get('hq-console-01') as {
      active: boolean;
      revoked: boolean;
      publicKeyBase64Url: string;
    };
    expect(registration.active).toBe(true);
    expect(registration.revoked).toBe(false);
    expect(registration.publicKeyBase64Url).toBe(publicKeyBase64Url);
  });

  it('rejects a non-admin caller', async () => {
    const { db } = fakeFirestore({ users: { u1: { role: 'staff', isActive: true, deletedAt: null } } });
    const result = await performRegisterIssuer(db, { uid: 'u1', token: { role: 'staff' } }, {}, 1);
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('rejects an already-consumed bootstrap token', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x22).toString('base64url');
    const { db } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-2': {
          tokenId: 'token-2',
          issuerId: 'hq-console-01',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'CONSUMED',
          expiresAtServerMs: 10_000,
        },
      },
    });
    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-2', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url)).toString(
      'base64',
    );
    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', requestId: 'r'.repeat(32), bootstrapTokenId: 'token-2', bootstrapToken: rawToken, publicKeyBase64Url, signature },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'bootstrap_token_already_consumed' });
  });

  it('rejects a possession-proof signature from the wrong key', async () => {
    const { publicKeyBase64Url } = rawKeypair();
    const other = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x33).toString('base64url');
    const { db } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-3': {
          tokenId: 'token-3',
          issuerId: 'hq-console-01',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'PENDING',
          expiresAtServerMs: 10_000,
        },
      },
    });
    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-3', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(other.publicKeyBase64Url, other.privateKeyBase64Url)).toString(
      'base64',
    );
    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', requestId: 'r'.repeat(32), bootstrapTokenId: 'token-3', bootstrapToken: rawToken, publicKeyBase64Url, signature },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'bad_possession_proof' });
  });

  it('rejects a wrong-issuer bootstrap token binding', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x44).toString('base64url');
    const { db, store } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-4': {
          tokenId: 'token-4',
          issuerId: 'some-other-issuer',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'PENDING',
          expiresAtServerMs: 10_000,
        },
      },
    });
    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-4', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url)).toString(
      'base64',
    );
    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', requestId: 'r'.repeat(32), bootstrapTokenId: 'token-4', bootstrapToken: rawToken, publicKeyBase64Url, signature },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'bootstrap_token_issuer_mismatch' });
    expect(store.get('privilegedIssuerRegistrations')).toBeUndefined();
    expect((store.get('privilegedIssuerBootstrapTokens')!.get('token-4') as { status: string }).status).toBe('PENDING');
  });

  // --- F4: single-use bootstrap token linearization -------------------------

  /** Builds a valid registerIssuer request for `issuerId` with a fresh keypair. */
  function bootstrapRequest(issuerId: string, tokenId: string, rawToken: string, requestId: string) {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const payload = registerIssuerPossessionProofPayload(issuerId, tokenId, requestId);
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url)).toString(
      'base64',
    );
    return {
      publicKeyBase64Url,
      data: { issuerId, requestId, bootstrapTokenId: tokenId, bootstrapToken: rawToken, publicKeyBase64Url, signature },
    };
  }

  function seedPendingToken(tokenId: string, issuerId: string, rawToken: string) {
    return {
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        [tokenId]: {
          tokenId,
          issuerId,
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'PENDING',
          expiresAtServerMs: 10_000,
        },
      },
    };
  }

  it('F4: two concurrent requests with distinct requestIds and one token → exactly one registration', async () => {
    const rawToken = Buffer.alloc(32, 0x55).toString('base64url');
    const { db, store, setBeforeCommit, beforeCommitFireCount } = fakeFirestore(
      seedPendingToken('token-race', 'hq-console-01', rawToken),
    );

    const a = bootstrapRequest('hq-console-01', 'token-race', rawToken, 'a'.repeat(32));
    const b = bootstrapRequest('hq-console-01', 'token-race', rawToken, 'b'.repeat(32));
    expect(a.publicKeyBase64Url).not.toBe(b.publicKeyBase64Url);

    // Caller A enters its transaction and reads the token as PENDING; caller B
    // then runs to completion and consumes it. A's commit must observe the
    // conflict, retry, and abort on the now-CONSUMED token.
    let bResult: Awaited<ReturnType<typeof performRegisterIssuer>> | null = null;
    setBeforeCommit(async () => {
      bResult = await performRegisterIssuer(db, { uid: ADMIN_UID, token: { role: 'admin' } }, b.data, 1000);
    });

    const aResult = await performRegisterIssuer(db, { uid: ADMIN_UID, token: { role: 'admin' } }, a.data, 1000);

    expect(beforeCommitFireCount()).toBe(1);
    expect(bResult).toEqual({ ok: true, issuerId: 'hq-console-01' });
    expect(aResult).toEqual({ ok: false, code: 'bootstrap_token_already_consumed' });

    const registration = store.get('privilegedIssuerRegistrations')!.get('hq-console-01') as {
      publicKeyBase64Url: string;
      credentialVersion: number;
    };
    // The winner's key survives, and exactly one registration happened.
    expect(registration.publicKeyBase64Url).toBe(b.publicKeyBase64Url);
    expect(registration.publicKeyBase64Url).not.toBe(a.publicKeyBase64Url);
    expect(registration.credentialVersion).toBe(1);
    expect((store.get('privilegedIssuerBootstrapTokens')!.get('token-race') as { status: string }).status).toBe(
      'CONSUMED',
    );
  });

  it('F4: an expired token is rejected and writes nothing', async () => {
    const rawToken = Buffer.alloc(32, 0x66).toString('base64url');
    const { db, store } = fakeFirestore(seedPendingToken('token-exp', 'hq-console-01', rawToken));
    const req = bootstrapRequest('hq-console-01', 'token-exp', rawToken, 'c'.repeat(32));

    const result = await performRegisterIssuer(db, { uid: ADMIN_UID, token: { role: 'admin' } }, req.data, 20_000);

    expect(result).toEqual({ ok: false, code: 'bootstrap_token_expired' });
    expect(store.get('privilegedIssuerRegistrations')).toBeUndefined();
    expect((store.get('privilegedIssuerBootstrapTokens')!.get('token-exp') as { status: string }).status).toBe(
      'PENDING',
    );
  });

  it('F4: a token-hash mismatch is rejected and writes nothing', async () => {
    const rawToken = Buffer.alloc(32, 0x77).toString('base64url');
    const wrongToken = Buffer.alloc(32, 0x78).toString('base64url');
    const { db, store } = fakeFirestore(seedPendingToken('token-hash', 'hq-console-01', rawToken));
    const req = bootstrapRequest('hq-console-01', 'token-hash', wrongToken, 'd'.repeat(32));

    const result = await performRegisterIssuer(db, { uid: ADMIN_UID, token: { role: 'admin' } }, req.data, 1000);

    expect(result).toEqual({ ok: false, code: 'bootstrap_token_hash_mismatch' });
    expect(store.get('privilegedIssuerRegistrations')).toBeUndefined();
    expect((store.get('privilegedIssuerBootstrapTokens')!.get('token-hash') as { status: string }).status).toBe(
      'PENDING',
    );
  });

  it('F4: a token consumed after the outer pre-check is still rejected inside the transaction', async () => {
    const rawToken = Buffer.alloc(32, 0x79).toString('base64url');
    const { db, store, setBeforeCommit } = fakeFirestore(seedPendingToken('token-late', 'hq-console-01', rawToken));
    const req = bootstrapRequest('hq-console-01', 'token-late', rawToken, 'e'.repeat(32));

    // Consume the token out from under the in-flight transaction.
    setBeforeCommit(() => {
      void db.collection('privilegedIssuerBootstrapTokens').doc('token-late').update({ status: 'CONSUMED' });
    });

    const result = await performRegisterIssuer(db, { uid: ADMIN_UID, token: { role: 'admin' } }, req.data, 1000);

    expect(result).toEqual({ ok: false, code: 'bootstrap_token_already_consumed' });
    expect(store.get('privilegedIssuerRegistrations')).toBeUndefined();
  });
});

describe('performRevokeIssuerRegistration', () => {
  it('revokes a registered issuer', async () => {
    const { db, store } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerRegistrations: {
        'hq-console-01': { issuerId: 'hq-console-01', active: true, revoked: false, publicKeyBase64Url: 'x', credentialVersion: 1 },
      },
    });
    const result = await performRevokeIssuerRegistration(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', reason: 'device lost' },
      2000,
    );
    expect(result).toEqual({ ok: true, issuerId: 'hq-console-01' });
    const registration = store.get('privilegedIssuerRegistrations')!.get('hq-console-01') as {
      revoked: boolean;
      active: boolean;
    };
    expect(registration.revoked).toBe(true);
    expect(registration.active).toBe(false);
  });

  it('rejects revoking an unregistered issuer', async () => {
    const { db } = fakeFirestore(seedAdmin());
    const result = await performRevokeIssuerRegistration(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'ghost' },
      1,
    );
    expect(result).toEqual({ ok: false, code: 'issuer_not_registered' });
  });

  it('rejects a non-admin caller', async () => {
    const { db } = fakeFirestore({ users: { u1: { role: 'manager', isActive: true, deletedAt: null } } });
    const result = await performRevokeIssuerRegistration(db, { uid: 'u1', token: { role: 'manager' } }, { issuerId: 'x' }, 1);
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });
});
