/**
 * Process/module-realm trusted orchestration owner authority.
 * Exact owner-gated facade over four raw Row29 mutation primitives.
 * No durable state. No application wiring. No cross-context coordination.
 *
 * Guarantee: one live owner per semantic (branchId, deviceId) per JavaScript
 * module realm. This module does not claim cross-tab exclusivity.
 */

// C5 cart-first host: relative value-import order is load-bearing and must
// not be auto-sorted. Cart-store value imports MUST precede evidence-store
// value imports so this file enters the two-predicate cycle cart-first.
import {
  acquireSaleSubmissionResumeFence,
  beginActiveCartGeneration,
  isAuthenticAcquiredResumeFenceAuthorization,
  releaseSaleSubmissionResumeFence,
} from './activeCartSnapshotStore';
import {
  commitSaleSubmissionAbsenceSeal,
  commitSaleSubmissionEvidenceEntry,
  proveSaleSubmissionEvidencePresence,
} from './saleSubmissionEvidenceStore';

declare const TrustedOrchestrationOwnerBrand: unique symbol;

export type TrustedOrchestrationOwner = {
  readonly [TrustedOrchestrationOwnerBrand]: true;
};

export type ClaimTrustedOrchestrationOwnerResult =
  | { ok: true; owner: TrustedOrchestrationOwner }
  | { ok: false };

export type ReleaseTrustedOrchestrationOwnerResult =
  | { ok: true }
  | { ok: false };

type OwnerMintScope = {
  branchId: string;
  deviceId: string;
};

const liveOwners = new Map<string, Map<string, TrustedOrchestrationOwner>>();
const authenticOwners = new WeakSet<TrustedOrchestrationOwner>();
const ownerMints = new WeakMap<TrustedOrchestrationOwner, OwnerMintScope>();

export function claimTrustedOrchestrationOwner(
  branchId: string,
  deviceId: string,
): ClaimTrustedOrchestrationOwnerResult {
  if (typeof branchId !== 'string' || typeof deviceId !== 'string') {
    return { ok: false };
  }
  const existingBranch = liveOwners.get(branchId);
  const existingOwner = existingBranch === undefined ? undefined : existingBranch.get(deviceId);
  if (existingOwner !== undefined) {
    return { ok: false };
  }
  const owner = Object.freeze({}) as TrustedOrchestrationOwner;
  authenticOwners.add(owner);
  ownerMints.set(owner, { branchId, deviceId });
  let inner = existingBranch;
  if (inner === undefined) {
    inner = new Map();
    liveOwners.set(branchId, inner);
  }
  inner.set(deviceId, owner);
  return { ok: true, owner };
}

export function isAuthenticTrustedOrchestrationOwner(
  owner: TrustedOrchestrationOwner,
): boolean {
  if (owner === null || typeof owner !== 'object') {
    return false;
  }
  if (!authenticOwners.has(owner)) {
    return false;
  }
  return ownerMints.has(owner);
}

export function isTrustedOrchestrationOwnerFor(
  owner: TrustedOrchestrationOwner,
  branchId: string,
  deviceId: string,
): boolean {
  if (!isAuthenticTrustedOrchestrationOwner(owner)) {
    return false;
  }
  const minted = ownerMints.get(owner);
  if (minted === undefined) {
    return false;
  }
  if (minted.branchId !== branchId || minted.deviceId !== deviceId) {
    return false;
  }
  const inner = liveOwners.get(minted.branchId);
  if (inner === undefined) {
    return false;
  }
  return inner.get(minted.deviceId) === owner;
}

export function releaseTrustedOrchestrationOwner(
  owner: TrustedOrchestrationOwner,
): ReleaseTrustedOrchestrationOwnerResult {
  if (owner === null || typeof owner !== 'object') {
    return { ok: false };
  }
  const minted = ownerMints.get(owner);
  if (minted === undefined) {
    return { ok: false };
  }
  const inner = liveOwners.get(minted.branchId);
  if (inner === undefined) {
    return { ok: false };
  }
  if (inner.get(minted.deviceId) !== owner) {
    return { ok: false };
  }
  inner.delete(minted.deviceId);
  if (inner.size === 0) {
    liveOwners.delete(minted.branchId);
  }
  authenticOwners.delete(owner);
  ownerMints.delete(owner);
  return { ok: true };
}

export async function beginOwnedActiveCartGeneration(
  owner: TrustedOrchestrationOwner,
  input: Parameters<typeof beginActiveCartGeneration>[0],
): Promise<Awaited<ReturnType<typeof beginActiveCartGeneration>>> {
  const branchId = input.branchId;
  const deviceId = input.deviceId;
  const asyncOrderId = input.asyncOrderId;
  const billId = input.billId;
  if (!isTrustedOrchestrationOwnerFor(owner, branchId, deviceId)) {
    return { ok: false };
  }
  return beginActiveCartGeneration({
    branchId,
    deviceId,
    asyncOrderId,
    billId,
  });
}

export async function acquireOwnedSaleSubmissionResumeFence(
  owner: TrustedOrchestrationOwner,
  input: Parameters<typeof acquireSaleSubmissionResumeFence>[0],
): Promise<Awaited<ReturnType<typeof acquireSaleSubmissionResumeFence>>> {
  const branchId = input.branchId;
  const deviceId = input.deviceId;
  if (!isTrustedOrchestrationOwnerFor(owner, branchId, deviceId)) {
    return { ok: false };
  }
  return acquireSaleSubmissionResumeFence({
    branchId,
    deviceId,
  });
}

export async function commitOwnedSaleSubmissionAbsenceSeal(
  owner: TrustedOrchestrationOwner,
  authorization: Parameters<typeof commitSaleSubmissionAbsenceSeal>[0],
): Promise<Awaited<ReturnType<typeof commitSaleSubmissionAbsenceSeal>>> {
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }
  const branchId = authorization.branchId;
  const deviceId = authorization.deviceId;
  if (!isTrustedOrchestrationOwnerFor(owner, branchId, deviceId)) {
    return { ok: false };
  }
  return commitSaleSubmissionAbsenceSeal(authorization);
}

export async function commitOwnedSaleSubmissionEvidenceEntry(
  owner: TrustedOrchestrationOwner,
  authorization: Parameters<typeof commitSaleSubmissionEvidenceEntry>[0],
): Promise<Awaited<ReturnType<typeof commitSaleSubmissionEvidenceEntry>>> {
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }
  const branchId = authorization.branchId;
  const deviceId = authorization.deviceId;
  if (!isTrustedOrchestrationOwnerFor(owner, branchId, deviceId)) {
    return { ok: false };
  }
  return commitSaleSubmissionEvidenceEntry(authorization);
}

export async function proveOwnedSaleSubmissionEvidencePresence(
  owner: TrustedOrchestrationOwner,
  authorization: Parameters<typeof proveSaleSubmissionEvidencePresence>[0],
): Promise<Awaited<ReturnType<typeof proveSaleSubmissionEvidencePresence>>> {
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }
  const branchId = authorization.branchId;
  const deviceId = authorization.deviceId;
  if (!isTrustedOrchestrationOwnerFor(owner, branchId, deviceId)) {
    return { ok: false };
  }
  return proveSaleSubmissionEvidencePresence(authorization);
}

export async function releaseOwnedSaleSubmissionResumeFence(
  owner: TrustedOrchestrationOwner,
  authorization: Parameters<typeof releaseSaleSubmissionResumeFence>[0],
  request: Parameters<typeof releaseSaleSubmissionResumeFence>[1],
): Promise<Awaited<ReturnType<typeof releaseSaleSubmissionResumeFence>>> {
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }
  const branchId = authorization.branchId;
  const deviceId = authorization.deviceId;
  if (!isTrustedOrchestrationOwnerFor(owner, branchId, deviceId)) {
    return { ok: false };
  }
  const freshRequest =
    request.outcome === 'evidence_present'
      ? { outcome: 'evidence_present' as const, proof: request.proof }
      : { outcome: 'evidence_proven_absent' as const, proof: request.proof };
  if (!isTrustedOrchestrationOwnerFor(owner, branchId, deviceId)) {
    return { ok: false };
  }
  return releaseSaleSubmissionResumeFence(authorization, freshRequest);
}
