import { describe, expect, it } from 'vitest';
import {
  validateOacProvisioningTransport,
} from './oacProvisioningTransport';

describe('oacProvisioningTransport', () => {
  const sampleOac = {
    oacId: 'OAC-12345',
    schemaVersion: 1,
    managerStaffId: 'MGR-1',
    branchId: 'B-HQ',
    deviceId: 'DEV-01',
    freshnessExpiresAtServerMs: 2_000_000_000_000,
  };
  const sampleOacBytesBase64 = btoa(JSON.stringify(sampleOac));
  const sampleSrf1Base64 = btoa('mock-srf1-receipt');

  it('validates and preserves exact raw base64 without re-serialization', () => {
    const res = validateOacProvisioningTransport(sampleOacBytesBase64, sampleSrf1Base64);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('fail');
    expect(res.payload.oacEnvelopeBytesBase64).toBe(sampleOacBytesBase64);
    expect(res.payload.srf1OacBase64).toBe(sampleSrf1Base64);
    expect(res.payload.oacId).toBe('OAC-12345');
    expect(res.payload.branchId).toBe('B-HQ');
    expect(res.payload.deviceId).toBe('DEV-01');
  });

  it('rejects missing or empty fields', () => {
    expect(validateOacProvisioningTransport('', sampleSrf1Base64)).toEqual({
      ok: false,
      code: 'missing_payload',
    });
    expect(validateOacProvisioningTransport(sampleOacBytesBase64, null)).toEqual({
      ok: false,
      code: 'missing_payload',
    });
  });

  it('rejects malformed OAC json content', () => {
    const badBase64 = btoa('not-json');
    expect(validateOacProvisioningTransport(badBase64, sampleSrf1Base64)).toEqual({
      ok: false,
      code: 'malformed_oac',
    });
  });
});
