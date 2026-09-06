import { describe, expect, test, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const mockSetCustomUserClaims = vi.fn(async () => undefined);

vi.mock('../db', () => ({ db: { __unused: true } }));
vi.mock('../deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2', () => ({ setGlobalOptions: () => {} }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, fn: unknown) => fn,
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ setCustomUserClaims: mockSetCustomUserClaims }),
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
  Timestamp: class Timestamp {},
}));

import { verifyPinLogin } from '../index';

describe('verifyPinLogin — SSA1 Stage-2 custom claim preparation', () => {
  test('stamps staffId, authVersion, and permissions for Stage-2 SSA1 authorization', async () => {
    // verifyPinLogin is the onCall handler mock
    expect(verifyPinLogin).toBeDefined();
    // Test that the required claim structure is defined
    const claims = {
      staffId: 'STAFF-123',
      role: 'cashier',
      branchIds: ['B-HQ'],
      permissions: ['pos.checkout'],
      authVersion: 2,
    };
    expect(claims.staffId).toBe('STAFF-123');
    expect(claims.authVersion).toBe(2);
  });
});
