import { describe, expect, it } from 'vitest'
import {
  REQUEST_ID_CONTRACT_RE,
  RequestIdContractError,
  assertMatchesRequestIdContract,
  generateRequestId,
} from './requestId'

describe('REQUEST_ID_CONTRACT_RE', () => {
  it('mirrors the Functions-side contract exactly', () => {
    expect(REQUEST_ID_CONTRACT_RE.source).toBe('^[A-Za-z0-9_-]{16,128}$')
  })
})

describe('generateRequestId', () => {
  it('produces a contract-valid id', () => {
    const id = generateRequestId()
    expect(REQUEST_ID_CONTRACT_RE.test(id)).toBe(true)
  })

  it('produces distinct ids across calls', () => {
    const a = generateRequestId()
    const b = generateRequestId()
    expect(a).not.toBe(b)
  })

  it('produces exactly 32 characters (24 random bytes, base64url, no padding)', () => {
    expect(generateRequestId()).toHaveLength(32)
  })
})

describe('assertMatchesRequestIdContract', () => {
  it('accepts a well-formed id', () => {
    expect(() => assertMatchesRequestIdContract('a'.repeat(32))).not.toThrow()
  })

  it('rejects a too-short id', () => {
    expect(() => assertMatchesRequestIdContract('short')).toThrow(RequestIdContractError)
  })

  it('rejects an id with invalid characters', () => {
    expect(() => assertMatchesRequestIdContract('has spaces'.padEnd(20, 'x'))).toThrow(RequestIdContractError)
  })

  it('rejects a too-long id', () => {
    expect(() => assertMatchesRequestIdContract('a'.repeat(129))).toThrow(RequestIdContractError)
  })
})
