/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const useAuthMock = vi.fn()
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => useAuthMock() }))

const registerIssuerMock = vi.fn()
const parseBootstrapImportMock = vi.fn()
const beginMock = vi.fn()
const completeMock = vi.fn()
const exportMock = vi.fn()

vi.mock('../lib/issuerApi', () => ({
  registerIssuer: (...args: unknown[]) => registerIssuerMock(...args),
  parseBootstrapImport: (...args: unknown[]) => parseBootstrapImportMock(...args),
  beginDeviceEnrollmentAuthorizationIssuance: (...args: unknown[]) => beginMock(...args),
  completeDeviceEnrollmentAuthorizationIssuance: (...args: unknown[]) => completeMock(...args),
  exportEnrollmentFile: (...args: unknown[]) => exportMock(...args),
}))

import { IssuerConsolePage } from './IssuerConsolePage'

beforeEach(() => {
  useAuthMock.mockReset()
  registerIssuerMock.mockReset()
  parseBootstrapImportMock.mockReset()
  beginMock.mockReset()
  completeMock.mockReset()
  exportMock.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('IssuerConsolePage — auth gating', () => {
  it('shows a loading state', () => {
    useAuthMock.mockReturnValue({ status: 'loading', signIn: vi.fn(), signOutUser: vi.fn(), error: null })
    render(<IssuerConsolePage />)
    expect(screen.getByText(/กำลังตรวจสอบสิทธิ์/)).toBeTruthy()
  })

  it('shows a sign-in form when signed out', () => {
    useAuthMock.mockReturnValue({ status: 'signed-out', signIn: vi.fn(), signOutUser: vi.fn(), error: null })
    render(<IssuerConsolePage />)
    expect(screen.getByLabelText('email')).toBeTruthy()
  })

  it('shows a non-admin warning for a non-admin signed-in account', () => {
    useAuthMock.mockReturnValue({ status: 'signed-in-non-admin', signIn: vi.fn(), signOutUser: vi.fn(), error: null })
    render(<IssuerConsolePage />)
    expect(screen.getByRole('alert').textContent).toContain('ไม่มีสิทธิ์ผู้ดูแลระบบ')
  })

  it('does not render the issuer-registration form for a non-admin', () => {
    useAuthMock.mockReturnValue({ status: 'signed-in-non-admin', signIn: vi.fn(), signOutUser: vi.fn(), error: null })
    render(<IssuerConsolePage />)
    expect(screen.queryByLabelText('issuerId')).toBeNull()
  })
})

describe('IssuerConsolePage — admin flows', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({ status: 'signed-in-admin', signIn: vi.fn(), signOutUser: vi.fn(), error: null })
  })

  it('registers an issuer end to end', async () => {
    parseBootstrapImportMock.mockResolvedValue({ tokenId: 'token-1', rawToken: 'raw-1' })
    registerIssuerMock.mockResolvedValue({ ok: true, issuerId: 'issuer-1' })
    render(<IssuerConsolePage />)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('issuerId'), 'issuer-1')
    await user.type(screen.getByLabelText('bootstrapCredential'), 'token-1:raw-1')
    await user.click(screen.getByText('ลงทะเบียน Issuer'))

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('issuer-1'))
    expect(registerIssuerMock).toHaveBeenCalledWith({
      issuerId: 'issuer-1',
      bootstrapTokenId: 'token-1',
      bootstrapToken: 'raw-1',
    })
  })

  it('runs the begin -> complete -> export enrollment flow', async () => {
    beginMock.mockResolvedValue({ ok: true, enrollmentAuthId: 'a'.repeat(32), expiresAtMillis: 1 })
    completeMock.mockResolvedValue({ ok: true, enr1Base64: 'ZW5yMQ==' })
    exportMock.mockResolvedValue(undefined)
    render(<IssuerConsolePage />)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('branchId'), 'LDP-001')
    await user.click(screen.getByText('เริ่มออกสิทธิ์'))
    await waitFor(() => expect(beginMock).toHaveBeenCalled())

    await user.click(screen.getByText('ออกไฟล์ลงทะเบียน'))
    await waitFor(() => expect(completeMock).toHaveBeenCalled())

    await waitFor(() => expect(screen.getByLabelText('exportPath')).toBeTruthy())
    await user.type(screen.getByLabelText('exportPath'), 'C:/exports/a.enr1')
    await user.click(screen.getByText('บันทึกไฟล์'))
    await waitFor(() => expect(exportMock).toHaveBeenCalledWith('C:/exports/a.enr1', 'ZW5yMQ=='))
  })

  it('shows a failure code when begin issuance fails', async () => {
    beginMock.mockResolvedValue({ ok: false, code: 'issuer_auth_failed' })
    render(<IssuerConsolePage />)
    const user = userEvent.setup()
    await user.click(screen.getByText('เริ่มออกสิทธิ์'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('issuer_auth_failed'))
  })
})
