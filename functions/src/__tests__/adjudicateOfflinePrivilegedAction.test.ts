import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../db', () => ({ db: { __unused: true } }));
vi.mock('../deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (opts: unknown, handler: unknown) => Object.assign(handler as object, { __opts: opts }),
  HttpsError: class extends Error {},
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
}));

import {
  adjudicateOfflinePrivilegedAction,
  handleAdjudicateOfflinePrivilegedAction,
} from '../adjudicateOfflinePrivilegedAction';
import { OFFLINE_ADJUDICATION_RESPONSE_KINDS } from '../privilegedActionRegistry';

const repoRoot = resolve(__dirname, '../../..');
const NOW = 1_763_100_000_000;

function throwingDb() {
  return {
    collection: () => {
      throw new Error('catastrophic backend failure');
    },
    runTransaction: async () => {
      throw new Error('catastrophic backend failure');
    },
  } as never;
}

describe('adjudicateOfflinePrivilegedAction callable', () => {
  test('is registered on the correct region with the landed privileged CORS allowlist', () => {
    const opts = (adjudicateOfflinePrivilegedAction as unknown as { __opts: Record<string, unknown> }).__opts;
    expect(opts.region).toBe('asia-southeast1');
    expect(Array.isArray(opts.cors)).toBe(true);
    expect((opts.cors as RegExp[]).map(String)).toEqual(
      [
        /^https?:\/\/localhost:\d+$/,
        /^https:\/\/.*\.firebaseapp\.com$/,
        /^https:\/\/.*\.web\.app$/,
      ].map(String),
    );
  });

  test('AC-8 — the callable is total: an unexpected failure becomes PROTOCOL_RETRYABLE, never a throw', async () => {
    const res = await handleAdjudicateOfflinePrivilegedAction(
      throwingDb(),
      { paa1Base64: 'AAAA', ssa1Base64: 'AAAA', oacEnvelopeBytesBase64: 'AAAA' },
      { uid: 'u', token: { staffId: 's', authVersion: 0, permissions: ['pos_void'] } },
      { nowMillis: NOW },
    );
    // A backend failure at the P0 relay gate is classified precisely.
    expect(res).toEqual({
      family: 'PROTOCOL',
      kind: 'PROTOCOL_RETRYABLE',
      retryReason: 'backend_unavailable',
      serverObservedAtMs: NOW,
    });
    expect(OFFLINE_ADJUDICATION_RESPONSE_KINDS).toContain(res.kind);

    // Anything that escapes the core entirely still resolves to a response.
    const hostileRequest = {
      get paa1Base64(): string {
        throw new Error('hostile getter');
      },
      ssa1Base64: 'AAAA',
      oacEnvelopeBytesBase64: 'AAAA',
    };
    const database = {
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              isActive: true,
              deletedAt: null,
              authVersion: 0,
              role: 'staff',
              branchIds: ['LDP-001'],
              rolePermissions: { staff: ['pos_void'] },
            }),
          }),
        }),
      }),
    } as never;
    const escaped = await handleAdjudicateOfflinePrivilegedAction(
      database,
      hostileRequest as never,
      { uid: 'u', token: { staffId: 's1', authVersion: 0, permissions: ['pos_void'] } },
      { nowMillis: NOW, readStagedDenyHead: async () => null },
    );
    expect(escaped).toEqual({
      family: 'PROTOCOL',
      kind: 'PROTOCOL_RETRYABLE',
      retryReason: 'internal_error',
      serverObservedAtMs: NOW,
    });
  });

  test('a missing request body is a PERMANENT shape rejection, not a throw', async () => {
    const database = {
      collection: (c: string) => ({
        doc: () => ({
          get: async () => ({
            exists: c === 'users' || c === 'settings',
            data: () =>
              c === 'users'
                ? { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['LDP-001'] }
                : { rolePermissions: { staff: ['pos_void'] } },
          }),
        }),
      }),
    } as never;
    const res = await handleAdjudicateOfflinePrivilegedAction(
      database,
      {},
      { uid: 'u', token: { staffId: 's1', authVersion: 0, permissions: ['pos_void'] } },
      { nowMillis: NOW },
    );
    expect(res).toEqual({
      family: 'PROTOCOL',
      kind: 'PROTOCOL_REJECTED',
      protocolReason: 'request_shape_invalid',
      recoverability: 'PERMANENT',
      serverObservedAtMs: NOW,
    });
  });

  test('the callable is exported from index.ts and is present exactly once in the deploy inventory', () => {
    const indexSrc = readFileSync(resolve(repoRoot, 'functions/src/index.ts'), 'utf8');
    expect(indexSrc).toContain(
      "export { adjudicateOfflinePrivilegedAction } from './adjudicateOfflinePrivilegedAction';",
    );
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'functions/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const matches = pkg.scripts.deploy.match(/functions:adjudicateOfflinePrivilegedAction(?![A-Za-z0-9_])/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test('the wrapper adds no decision logic of its own', () => {
    const src = readFileSync(resolve(repoRoot, 'functions/src/adjudicateOfflinePrivilegedAction.ts'), 'utf8');
    // No verdict/reason strings are minted in the wrapper except the total
    // fallback, and it never writes.
    expect(src).not.toMatch(/runTransaction|\.set\(|\.create\(|\.update\(/);
    expect([...src.matchAll(/retryReason: '/g)]).toHaveLength(1);
  });
});
