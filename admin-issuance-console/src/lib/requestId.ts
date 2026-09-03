/**
 * SEC-001 Packet C-A — client-generated `requestId` for issuer-signed
 * request replay protection. Matched server contract:
 * `functions/src/issuerRequestChallenge.ts`'s `REQUEST_ID_RE` — kept as an
 * explicit runtime assertion here (not just a comment) so the two sides can
 * never silently drift apart.
 */

/** Mirrors functions/src/issuerRequestChallenge.ts::REQUEST_ID_RE exactly. */
export const REQUEST_ID_CONTRACT_RE = /^[A-Za-z0-9_-]{16,128}$/

export class RequestIdContractError extends Error {
  constructor(requestId: string) {
    super(`requestId "${requestId}" does not match the Functions-side contract ${REQUEST_ID_CONTRACT_RE}`)
    this.name = 'RequestIdContractError'
  }
}

/** Manifest-contract assertion: throws if `id` would be rejected server-side. */
export function assertMatchesRequestIdContract(id: string): void {
  if (!REQUEST_ID_CONTRACT_RE.test(id)) {
    throw new RequestIdContractError(id)
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Generates a fresh, contract-valid requestId (24 random bytes, base64url — 32 chars). */
export function generateRequestId(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const id = base64UrlEncode(bytes)
  assertMatchesRequestIdContract(id)
  return id
}
