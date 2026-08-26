// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { User } from '../types';

const BRANCH_STORAGE_KEY = 'twinpet_branch_id';

const { authState } = vi.hoisted(() => ({
  authState: {
    isAuthenticated: true,
    user: null as Pick<User, 'branchIds'> | null,
    branchId: null as string | null,
    setBranchId: vi.fn(),
  },
}));

vi.mock('./useAuth', () => ({
  useAuth: () => authState,
}));

vi.mock('../firebase', () => ({
  db: null,
  collections: { branches: 'branches' },
  isFirebaseConfigured: false,
}));

import { useBranch } from './useBranch';

function setAuth(allowedBranchIds: string[], sessionBranchId: string | null) {
  authState.isAuthenticated = true;
  authState.user = { branchIds: allowedBranchIds };
  authState.branchId = sessionBranchId;
}

afterEach(() => {
  cleanup();
  localStorage.removeItem(BRANCH_STORAGE_KEY);
  authState.isAuthenticated = true;
  authState.user = null;
  authState.branchId = null;
  authState.setBranchId.mockReset();
});

beforeEach(() => {
  localStorage.removeItem(BRANCH_STORAGE_KEY);
});

describe('useBranch — global ALL capability vs concrete workspace', () => {
  test('CASE A: allowed ALL + concrete session LDP-001 → effective LDP-001', () => {
    setAuth(['ALL'], 'LDP-001');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('LDP-001');
  });

  test('CASE B: explicitly allowed LDP-001 + session LDP-001 → effective LDP-001', () => {
    setAuth(['LDP-001'], 'LDP-001');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('LDP-001');
  });

  test('CASE C: unauthorized concrete session is not accepted (fallback to first allowed)', () => {
    setAuth(['LDP-002'], 'LDP-001');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('LDP-002');
    expect(result.current.branchId).not.toBe('LDP-001');
  });

  test('CASE D: session ALL is not converted into a fabricated physical branch', () => {
    setAuth(['ALL'], 'ALL');
    localStorage.setItem(BRANCH_STORAGE_KEY, 'LDP-001');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('ALL');
  });
});

describe('useBranch — authorization regressions', () => {
  test('branch-limited non-ALL user cannot use an arbitrary session branch', () => {
    setAuth(['LDP-001'], 'LDP-999');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('LDP-001');
    expect(result.current.branchId).not.toBe('LDP-999');
  });

  test('branch mismatch without ALL does not honor the mismatched session', () => {
    setAuth(['BR-A', 'BR-B'], 'BR-C');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('BR-A');
    expect(result.current.branchId).not.toBe('BR-C');
  });

  test('absence of selected physical branch with ALL capability keeps ALL (non-operational)', () => {
    setAuth(['ALL'], null);
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('ALL');
  });

  test('empty allowed list fail-closes to null even with a concrete session', () => {
    setAuth([], 'LDP-001');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBeNull();
  });

  test('unauthenticated user fail-closes to null', () => {
    authState.isAuthenticated = false;
    authState.user = { branchIds: ['ALL'] };
    authState.branchId = 'LDP-001';
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBeNull();
  });

  test('stored concrete branch is honored for ALL capability when session is absent', () => {
    setAuth(['ALL'], null);
    localStorage.setItem(BRANCH_STORAGE_KEY, 'LDP-001');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('LDP-001');
  });

  test('stored unauthorized branch is not accepted without ALL', () => {
    setAuth(['LDP-002'], null);
    localStorage.setItem(BRANCH_STORAGE_KEY, 'LDP-001');
    const { result } = renderHook(() => useBranch());
    expect(result.current.branchId).toBe('LDP-002');
    expect(result.current.branchId).not.toBe('LDP-001');
  });
});
