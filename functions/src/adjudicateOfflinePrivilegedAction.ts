/**
 * adjudicateOfflinePrivilegedAction — SEC-001 Packet D / D-1B callable.
 *
 * Thin Functions-runtime wrapper. All decision logic lives in
 * `adjudicateOfflinePrivilegedActionCore.ts` so it is unit-testable without the
 * runtime. The callable is *total*: every reachable path returns exactly one of
 * the seven response kinds, and no path throws to the client — an unexpected
 * exception becomes `PROTOCOL_RETRYABLE`/`internal_error`, which never writes a
 * server verdict and is always safe to retry with byte-identical bytes.
 */

import { onCall } from 'firebase-functions/v2/https';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import {
  performAdjudicateOfflinePrivilegedAction,
  type AdjudicateOfflinePrivilegedActionDeps,
  type AdjudicateOfflinePrivilegedActionRequest,
  type OfflineAdjudicationResponse,
} from './adjudicateOfflinePrivilegedActionCore';

export type {
  AdjudicateOfflinePrivilegedActionRequest,
  OfflineAdjudicationResponse,
} from './adjudicateOfflinePrivilegedActionCore';

export async function handleAdjudicateOfflinePrivilegedAction(
  database: Parameters<typeof performAdjudicateOfflinePrivilegedAction>[0],
  req: AdjudicateOfflinePrivilegedActionRequest,
  auth: AuthLike,
  deps: AdjudicateOfflinePrivilegedActionDeps = {},
): Promise<OfflineAdjudicationResponse> {
  try {
    return await performAdjudicateOfflinePrivilegedAction(database, req, auth, deps);
  } catch {
    return {
      family: 'PROTOCOL',
      kind: 'PROTOCOL_RETRYABLE',
      retryReason: 'internal_error',
      serverObservedAtMs: deps.nowMillis ?? Date.now(),
    };
  }
}

export const adjudicateOfflinePrivilegedAction = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) =>
    handleAdjudicateOfflinePrivilegedAction(
      db,
      (request.data ?? {}) as AdjudicateOfflinePrivilegedActionRequest,
      request.auth as AuthLike,
    ),
);
