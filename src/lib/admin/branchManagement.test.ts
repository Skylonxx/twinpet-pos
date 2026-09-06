import { describe, expect, it } from 'vitest';
import { validateBranchForm } from './branchManagement';
import { isCanonicalIdentifier } from '../../../functions/src/staffSessionAssertionFrame';

describe('validateBranchForm identifier contract parity', () => {
  it('accepts valid 64-character branch IDs', () => {
    const id64 = 'B' + 'x'.repeat(63);
    const err = validateBranchForm({ id: id64, name: 'Branch 64', isActive: true }, 'create');
    expect(err).toBeNull();
    expect(isCanonicalIdentifier(id64)).toBe(true);
  });

  it('accepts valid 65-character branch IDs', () => {
    const id65 = 'B' + 'x'.repeat(64);
    const err = validateBranchForm({ id: id65, name: 'Branch 65', isActive: true }, 'create');
    expect(err).toBeNull();
    expect(isCanonicalIdentifier(id65)).toBe(true);
  });

  it('accepts valid 1499-character branch IDs', () => {
    const id1499 = 'B' + 'x'.repeat(1498);
    const err = validateBranchForm({ id: id1499, name: 'Branch 1499', isActive: true }, 'create');
    expect(err).toBeNull();
    expect(isCanonicalIdentifier(id1499)).toBe(true);
  });

  it('accepts valid 1500-character branch IDs', () => {
    const id1500 = 'B' + 'x'.repeat(1499);
    const err = validateBranchForm({ id: id1500, name: 'Branch 1500', isActive: true }, 'create');
    expect(err).toBeNull();
    expect(isCanonicalIdentifier(id1500)).toBe(true);
  });

  it('rejects 1501-character branch IDs', () => {
    const id1501 = 'B' + 'x'.repeat(1500);
    const err = validateBranchForm({ id: id1501, name: 'Branch 1501', isActive: true }, 'create');
    expect(err).toBe('Branch ID ต้องไม่เกิน 1,500 ตัวอักษร');
    expect(isCanonicalIdentifier(id1501)).toBe(false);
  });

  it('rejects invalid characters (spaces, special punctuation)', () => {
    expect(validateBranchForm({ id: 'B 01', name: 'Branch Space', isActive: true }, 'create')).toBe(
      'Branch ID ใช้ได้เฉพาะตัวอักษร ตัวเลข _ และ -',
    );
    expect(validateBranchForm({ id: 'B@01', name: 'Branch At', isActive: true }, 'create')).toBe(
      'Branch ID ใช้ได้เฉพาะตัวอักษร ตัวเลข _ และ -',
    );
    expect(isCanonicalIdentifier('B 01')).toBe(false);
    expect(isCanonicalIdentifier('B@01')).toBe(false);
  });

  it('accepts underscores and hyphens in branch IDs', () => {
    expect(validateBranchForm({ id: 'BRANCH_01-HQ', name: 'Branch HQ', isActive: true }, 'create')).toBeNull();
    expect(isCanonicalIdentifier('BRANCH_01-HQ')).toBe(true);
  });
});
