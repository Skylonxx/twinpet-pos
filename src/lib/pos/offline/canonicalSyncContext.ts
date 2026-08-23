/**
 * PK-4 canonical mutation context.
 *
 * Production callers cannot supply branch/device. The mount hook reads
 * `useAuth()` internally; the getter reads `getDeviceId()` fresh (or a
 * test-only device override). Unmount clears the branch slot so retained
 * action closures fail closed.
 */

import { useEffect } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { getDeviceId } from '../deviceId';

let mountedBranchId: string | null = null;
let deviceIdOverrideForTests: string | null = null;

export function useMountCanonicalSyncContext(): void {
  const { branchId } = useAuth();
  mountedBranchId = branchId;
  useEffect(
    () => () => {
      mountedBranchId = null;
    },
    [],
  );
}

export function getCanonicalSyncContext(): Readonly<{
  branchId: string;
  deviceId: string;
}> | null {
  const deviceId = deviceIdOverrideForTests ?? getDeviceId();
  if (!mountedBranchId || mountedBranchId === 'ALL' || !deviceId) return null;
  return { branchId: mountedBranchId, deviceId };
}

/** @internal test-only */
export function __setCanonicalSyncContextForTests(
  branchId: string | null,
  deviceId?: string | null,
): void {
  mountedBranchId = branchId;
  if (deviceId !== undefined) deviceIdOverrideForTests = deviceId;
}

/** @internal test-only */
export function __resetCanonicalSyncContextForTests(): void {
  mountedBranchId = null;
  deviceIdOverrideForTests = null;
}
