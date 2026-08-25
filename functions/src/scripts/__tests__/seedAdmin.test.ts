import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { assertSeedAdminResetPinDisabled } from '../seed-admin';

const src = readFileSync(resolve(__dirname, '../seed-admin.ts'), 'utf8');

describe('seed-admin T031 / T004', () => {
  afterEach(() => {
    delete process.env.SEED_ADMIN_RESET_PIN;
  });

  test('SEED_ADMIN_RESET_PIN hard-fails before any write', () => {
    process.env.SEED_ADMIN_RESET_PIN = '1';
    expect(() => assertSeedAdminResetPinDisabled()).toThrow(/decommissioned|recoverUserCredential/);
  });

  test('source never logs password or plaintext PIN', () => {
    expect(src).not.toMatch(/Password\s*: \$\{CONFIG\.password\}/);
    expect(src).not.toMatch(/PIN \(plain\)/);
    expect(src).not.toMatch(/PIN ใหม่\s*: \$\{CONFIG\.pin\}/);
    expect(src).not.toMatch(/console\.log\(`[^`]*\$\{CONFIG\.pin\}/);
    expect(src).not.toMatch(/console\.log\(`[^`]*\$\{CONFIG\.password\}/);
  });
});
