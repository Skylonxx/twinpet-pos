import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { generateRequestId } from './requestId'

/**
 * SEC-001 Packet C-A — the console's API layer. Every mutating call is an
 * issuer-signed request: the native `issuer_key_sign_request` command signs
 * the canonical-JSON `{purpose, requestId, ...fields}` payload with the
 * console's local Ed25519 issuer key, and the resulting signature travels
 * alongside the plain fields to the matching Functions callable, which
 * verifies it via `issuerSignatureAuth.ts` against the issuer's registered
 * public key. No shared secret ever leaves this console.
 */

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

function getInvoke(): TauriInvoke {
  const g = globalThis as unknown as {
    window?: { __TAURI__?: { core?: { invoke?: TauriInvoke } } }
    __TAURI__?: { core?: { invoke?: TauriInvoke } }
  }
  const invoke = g.window?.__TAURI__?.core?.invoke ?? g.__TAURI__?.core?.invoke
  if (typeof invoke !== 'function') {
    throw new Error('Tauri bridge is unavailable — the Issuer Console must run as a native app')
  }
  return invoke
}

async function signIssuerRequest(
  purpose: string,
  fields: Record<string, unknown>,
): Promise<{ requestId: string; signature: string }> {
  const requestId = generateRequestId()
  const signature = (await getInvoke()('issuer_key_sign_request', {
    purpose,
    requestId,
    fieldsJson: JSON.stringify(fields),
  })) as string
  return { requestId, signature }
}

export async function getOrCreateIssuerPublicKey(): Promise<string> {
  return (await getInvoke()('issuer_key_get_or_create_public_key')) as string
}

export interface RegisterIssuerParams {
  issuerId: string
  bootstrapTokenId: string
  bootstrapToken: string
}

export async function registerIssuer(params: RegisterIssuerParams): Promise<{ ok: true; issuerId: string } | { ok: false; code: string }> {
  const publicKeyBase64Url = await getOrCreateIssuerPublicKey()
  const { requestId, signature } = await signIssuerRequest('registerIssuer', {
    issuerId: params.issuerId,
    bootstrapTokenId: params.bootstrapTokenId,
  })
  const callable = httpsCallable(functions!, 'registerIssuer')
  const result = await callable({
    issuerId: params.issuerId,
    requestId,
    bootstrapTokenId: params.bootstrapTokenId,
    bootstrapToken: params.bootstrapToken,
    publicKeyBase64Url,
    signature,
  })
  return result.data as { ok: true; issuerId: string } | { ok: false; code: string }
}

export interface RevokeIssuerParams {
  issuerId: string
  reason?: string
}

export async function revokeIssuerRegistration(
  params: RevokeIssuerParams,
): Promise<{ ok: true; issuerId: string } | { ok: false; code: string }> {
  const callable = httpsCallable(functions!, 'revokeIssuerRegistration')
  const result = await callable({ issuerId: params.issuerId, reason: params.reason })
  return result.data as { ok: true; issuerId: string } | { ok: false; code: string }
}

export interface BeginEnrollmentIssuanceParams {
  issuerId: string
  branchId: string
}

export async function beginDeviceEnrollmentAuthorizationIssuance(
  params: BeginEnrollmentIssuanceParams,
): Promise<{ ok: true; enrollmentAuthId: string; expiresAtMillis: number } | { ok: false; code: string }> {
  const { requestId, signature } = await signIssuerRequest('beginDeviceEnrollmentAuthorizationIssuance', {
    issuerId: params.issuerId,
    branchId: params.branchId,
  })
  const callable = httpsCallable(functions!, 'beginDeviceEnrollmentAuthorizationIssuance')
  const result = await callable({ issuerId: params.issuerId, requestId, branchId: params.branchId, signature })
  return result.data as { ok: true; enrollmentAuthId: string; expiresAtMillis: number } | { ok: false; code: string }
}

export interface CompleteEnrollmentIssuanceParams {
  issuerId: string
  enrollmentAuthId: string
}

export async function completeDeviceEnrollmentAuthorizationIssuance(
  params: CompleteEnrollmentIssuanceParams,
): Promise<{ ok: true; enr1Base64: string } | { ok: false; code: string }> {
  const { requestId, signature } = await signIssuerRequest('completeDeviceEnrollmentAuthorizationIssuance', {
    issuerId: params.issuerId,
    enrollmentAuthId: params.enrollmentAuthId,
  })
  const callable = httpsCallable(functions!, 'completeDeviceEnrollmentAuthorizationIssuance')
  const result = await callable({
    issuerId: params.issuerId,
    requestId,
    enrollmentAuthId: params.enrollmentAuthId,
    signature,
  })
  return result.data as { ok: true; enr1Base64: string } | { ok: false; code: string }
}

export async function parseBootstrapImport(input: string): Promise<{ tokenId: string; rawToken: string }> {
  return (await getInvoke()('bootstrap_import_parse', { input })) as { tokenId: string; rawToken: string }
}

export async function exportEnrollmentFile(targetPath: string, enr1Base64: string): Promise<void> {
  await getInvoke()('file_export_write', { targetPath, enr1Base64 })
}
