// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import sessionSrc from './session.ts?raw';
import {
  clearSession,
  loadSession,
  saveSession,
  SESSION_SCHEMA_VERSION,
  type AuthSession,
} from './session';
import type { User } from '../types';

const SESSION_KEY = 'twinpet_session';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    username: 'somchai',
    firstName: 'สมชาย',
    lastName: 'ใจดี',
    role: 'staff',
    branchIds: ['B1'],
    isActive: true,
    deletedAt: null,
    pin: '',
    permissions: {},
    ...overrides,
  } as User;
}

function makeV1Session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    issuedAt: 1_700_000_000_000,
    user: makeUser(),
    branchId: 'B1',
    ...overrides,
  };
}

afterEach(() => {
  clearSession();
});

describe('session — PK-2A DEC-01 schema / validation', () => {
  test('valid v1 restores and preserves finite issuedAt', () => {
    const session = makeV1Session({ issuedAt: 1_712_345_678_900 });
    saveSession(session);
    expect(loadSession()).toEqual(session);
  });

  test('malformed JSON → null', () => {
    localStorage.setItem(SESSION_KEY, '{not-json');
    expect(loadSession()).toBeNull();
  });

  test('non-object / array → null', () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(['nope']));
    expect(loadSession()).toBeNull();
    localStorage.setItem(SESSION_KEY, JSON.stringify(null));
    expect(loadSession()).toBeNull();
  });

  test('missing/invalid branchId → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ schemaVersion: 1, issuedAt: 1, user: makeUser(), branchId: '' }),
    );
    expect(loadSession()).toBeNull();
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ schemaVersion: 1, issuedAt: 1, user: makeUser() }),
    );
    expect(loadSession()).toBeNull();
  });

  test('missing user → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ schemaVersion: 1, issuedAt: 1, branchId: 'B1' }),
    );
    expect(loadSession()).toBeNull();
  });

  test('user.id empty → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        issuedAt: 1,
        branchId: 'B1',
        user: makeUser({ id: '' }),
      }),
    );
    expect(loadSession()).toBeNull();
  });

  test('branchIds not array of strings → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        issuedAt: 1,
        branchId: 'B1',
        user: { ...makeUser(), branchIds: [1, 2] },
      }),
    );
    expect(loadSession()).toBeNull();
  });

  test('role outside enum → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        issuedAt: 1,
        branchId: 'B1',
        user: { ...makeUser(), role: 'superuser' },
      }),
    );
    expect(loadSession()).toBeNull();
  });

  test('firstName non-string → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        issuedAt: 1,
        branchId: 'B1',
        user: { ...makeUser(), firstName: 12 },
      }),
    );
    expect(loadSession()).toBeNull();
  });

  test('lastName non-string → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        issuedAt: 1,
        branchId: 'B1',
        user: { ...makeUser(), lastName: null },
      }),
    );
    expect(loadSession()).toBeNull();
  });

  test('schemaVersion 2 → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...makeV1Session(), schemaVersion: 2 }),
    );
    expect(loadSession()).toBeNull();
  });

  test('schemaVersion non-number → null', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...makeV1Session(), schemaVersion: 'x' }),
    );
    expect(loadSession()).toBeNull();
  });

  test('legacy structurally valid blob → v1 in memory, issuedAt null', () => {
    const legacy = {
      user: makeUser({
        createdAt: { seconds: 1, nanoseconds: 0 } as unknown as User['createdAt'],
        updatedAt: { seconds: 2, nanoseconds: 0 } as unknown as User['updatedAt'],
        lastLoginAt: { seconds: 3, nanoseconds: 0 } as unknown as User['lastLoginAt'],
      }),
      branchId: 'B1',
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(legacy));
    const loaded = loadSession();
    expect(loaded).toEqual({
      schemaVersion: 1,
      issuedAt: null,
      user: legacy.user,
      branchId: 'B1',
    });
  });

  test('legacy load does NOT rewrite localStorage', () => {
    const legacyRaw = JSON.stringify({ user: makeUser(), branchId: 'B1' });
    localStorage.setItem(SESSION_KEY, legacyRaw);
    loadSession();
    expect(localStorage.getItem(SESSION_KEY)).toBe(legacyRaw);
  });

  test('issuedAt non-finite/invalid → null while session otherwise restores', () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...makeV1Session(), issuedAt: 'nope' }),
    );
    expect(loadSession()?.issuedAt).toBeNull();
    expect(loadSession()?.schemaVersion).toBe(1);

    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...makeV1Session(), issuedAt: Number.NaN }),
    );
    expect(loadSession()?.issuedAt).toBeNull();
  });

  test('save/load round-trip preserves schemaVersion + issuedAt', () => {
    const session = makeV1Session({ issuedAt: 42 });
    saveSession(session);
    expect(loadSession()).toEqual(session);
  });

  test('issuedAt is not used for expiry', () => {
    // Contract: no age comparison against issuedAt; no timeout logout constants.
    expect(sessionSrc).not.toMatch(/Date\.now\(\)\s*-\s*.*issuedAt/);
    expect(sessionSrc).not.toMatch(/issuedAt\s*<|issuedAt\s*>|issuedAt\s*-/);
    expect(sessionSrc.includes('SESSION_MAX_AGE')).toBe(false);
    expect(sessionSrc.includes('SESSION_TTL')).toBe(false);
    expect(sessionSrc.includes('expiresAt')).toBe(false);
  });

  test('rejected invalid blob remains in localStorage', () => {
    const invalid = JSON.stringify({ schemaVersion: 1, branchId: 'B1', user: { id: '' } });
    localStorage.setItem(SESSION_KEY, invalid);
    expect(loadSession()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBe(invalid);
  });
});
