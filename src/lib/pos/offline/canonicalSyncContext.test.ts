// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getCanonicalSyncContext,
  useMountCanonicalSyncContext,
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from './canonicalSyncContext';
import hookSource from '../../../hooks/pos/useSyncCenterState.ts?raw';
import barSource from '../../../components/SyncStatusBar.tsx?raw';
import pageSource from '../../../pages/SyncCenterPage.tsx?raw';

const auth = vi.hoisted(() => ({ branchId: 'A' as string | null }));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ branchId: auth.branchId }),
}));

function Owner() {
  useMountCanonicalSyncContext();
  return null;
}

afterEach(() => {
  cleanup();
  __resetCanonicalSyncContextForTests();
  auth.branchId = 'A';
});

describe('canonicalSyncContext', () => {
  test('T-LIFE-1 mount hook has no caller-supplied branch/device parameters', () => {
    expect(useMountCanonicalSyncContext.length).toBe(0);
    expect(getCanonicalSyncContext.length).toBe(0);
  });

  test('T-LIFE-2 mount exposes current branch and device override', () => {
    __setCanonicalSyncContextForTests('B', 'dev-x');
    expect(getCanonicalSyncContext()).toEqual({ branchId: 'B', deviceId: 'dev-x' });
  });

  test('T-LIFE-3 reset and unmount clear context', () => {
    __setCanonicalSyncContextForTests(null, 'dev-x');
    const view = render(createElement(Owner));
    expect(getCanonicalSyncContext()).toEqual({ branchId: 'A', deviceId: 'dev-x' });
    view.unmount();
    expect(getCanonicalSyncContext()).toBeNull();
  });

  test('ALL and empty branch fail closed', () => {
    __setCanonicalSyncContextForTests('ALL', 'dev');
    expect(getCanonicalSyncContext()).toBeNull();
    __setCanonicalSyncContextForTests('', 'dev');
    expect(getCanonicalSyncContext()).toBeNull();
    __setCanonicalSyncContextForTests(null, 'dev');
    expect(getCanonicalSyncContext()).toBeNull();
  });

  test('test reset clears branch and device override', () => {
    __setCanonicalSyncContextForTests('B', 'Y');
    __resetCanonicalSyncContextForTests();
    expect(getCanonicalSyncContext()).toBeNull();
  });

  test('generic useSyncCenterState and SyncStatusBar do not mount canonical context', () => {
    expect(hookSource).not.toMatch(/\buseMountCanonicalSyncContext\s*\(/);
    expect(barSource).not.toMatch(/\buseMountCanonicalSyncContext\s*\(/);
    expect(pageSource).toMatch(/\buseMountCanonicalSyncContext\s*\(/);
  });
});
