import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const httpsCallableMock = vi.fn()

vi.mock('firebase/functions', () => ({
  httpsCallable: (...args: unknown[]) => httpsCallableMock(...args),
}))

vi.mock('../firebase', () => ({ functions: {} }))

import {
  beginDeviceEnrollmentAuthorizationIssuance,
  completeDeviceEnrollmentAuthorizationIssuance,
  exportEnrollmentFile,
  getOrCreateIssuerPublicKey,
  parseBootstrapImport,
  registerIssuer,
  revokeIssuerRegistration,
} from './issuerApi'
import { REQUEST_ID_CONTRACT_RE } from './requestId'

type InvokeCall = { cmd: string; args?: Record<string, unknown> }

function installTauriMock(handler: (call: InvokeCall) => unknown) {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => handler({ cmd, args }))
  ;(globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
    core: { invoke },
  }
  return invoke
}

afterEach(() => {
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__
  httpsCallableMock.mockReset()
})

beforeEach(() => {
  httpsCallableMock.mockImplementation(() => async (data: unknown) => ({ data: { ok: true, __echo: data } }))
})

describe('getOrCreateIssuerPublicKey', () => {
  it('invokes the native command and returns its result', async () => {
    installTauriMock(({ cmd }) => {
      expect(cmd).toBe('issuer_key_get_or_create_public_key')
      return 'pubkey-b64url'
    })
    expect(await getOrCreateIssuerPublicKey()).toBe('pubkey-b64url')
  })

  it('throws a clear error when the Tauri bridge is unavailable', async () => {
    await expect(getOrCreateIssuerPublicKey()).rejects.toThrow('Tauri bridge is unavailable')
  })
})

describe('registerIssuer', () => {
  it('signs a fresh requestId and forwards the full payload to the callable', async () => {
    const invoke = installTauriMock(({ cmd, args }) => {
      if (cmd === 'issuer_key_get_or_create_public_key') return 'pubkey-b64url'
      if (cmd === 'issuer_key_sign_request') {
        expect(args?.purpose).toBe('registerIssuer')
        expect(REQUEST_ID_CONTRACT_RE.test(args?.requestId as string)).toBe(true)
        const fields = JSON.parse(args?.fieldsJson as string)
        expect(fields).toEqual({ issuerId: 'issuer-1', bootstrapTokenId: 'token-1' })
        return 'signature-b64'
      }
      throw new Error(`unexpected invoke ${cmd}`)
    })

    const result = await registerIssuer({ issuerId: 'issuer-1', bootstrapTokenId: 'token-1', bootstrapToken: 'raw' })
    expect(result).toMatchObject({ ok: true })
    expect(invoke).toHaveBeenCalledWith('issuer_key_get_or_create_public_key')

    const callArgs = (result as { __echo?: unknown }).__echo as Record<string, unknown>
    expect(callArgs).toMatchObject({
      issuerId: 'issuer-1',
      bootstrapTokenId: 'token-1',
      bootstrapToken: 'raw',
      publicKeyBase64Url: 'pubkey-b64url',
      signature: 'signature-b64',
    })
    expect(typeof callArgs.requestId).toBe('string')
  })
})

describe('revokeIssuerRegistration', () => {
  it('calls the callable directly with no native signing', async () => {
    const result = await revokeIssuerRegistration({ issuerId: 'issuer-1', reason: 'lost device' })
    expect(result).toMatchObject({ ok: true })
  })
})

describe('beginDeviceEnrollmentAuthorizationIssuance / completeDeviceEnrollmentAuthorizationIssuance', () => {
  it('signs and forwards begin', async () => {
    installTauriMock(({ cmd, args }) => {
      if (cmd === 'issuer_key_sign_request') {
        expect(args?.purpose).toBe('beginDeviceEnrollmentAuthorizationIssuance')
        return 'sig'
      }
      throw new Error(`unexpected ${cmd}`)
    })
    const result = await beginDeviceEnrollmentAuthorizationIssuance({ issuerId: 'issuer-1', branchId: 'LDP-001' })
    expect(result).toMatchObject({ ok: true })
  })

  it('signs and forwards complete', async () => {
    installTauriMock(({ cmd, args }) => {
      if (cmd === 'issuer_key_sign_request') {
        expect(args?.purpose).toBe('completeDeviceEnrollmentAuthorizationIssuance')
        return 'sig'
      }
      throw new Error(`unexpected ${cmd}`)
    })
    const result = await completeDeviceEnrollmentAuthorizationIssuance({
      issuerId: 'issuer-1',
      enrollmentAuthId: 'a'.repeat(32),
    })
    expect(result).toMatchObject({ ok: true })
  })
})

describe('parseBootstrapImport / exportEnrollmentFile', () => {
  it('parseBootstrapImport delegates to the native command', async () => {
    installTauriMock(({ cmd, args }) => {
      expect(cmd).toBe('bootstrap_import_parse')
      expect(args?.input).toBe('token-id:raw-token')
      return { tokenId: 'token-id', rawToken: 'raw-token' }
    })
    expect(await parseBootstrapImport('token-id:raw-token')).toEqual({ tokenId: 'token-id', rawToken: 'raw-token' })
  })

  it('exportEnrollmentFile delegates to the native command', async () => {
    const invoke = installTauriMock(({ cmd }) => {
      expect(cmd).toBe('file_export_write')
      return undefined
    })
    await exportEnrollmentFile('C:/exports/enrollment.enr1', 'base64data')
    expect(invoke).toHaveBeenCalledWith('file_export_write', {
      targetPath: 'C:/exports/enrollment.enr1',
      enr1Base64: 'base64data',
    })
  })
})
