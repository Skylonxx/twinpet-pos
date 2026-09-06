import { describe, it, expect, vi } from 'vitest';
import { reEnrollDevice } from './reEnrollDevice';
import {
  finalizeDeviceEnrollmentRetry,
  loadPendingFinalization,
  type FinalizeRetryContext,
} from './deviceRegistration';

const mockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', {
  value: mockStorage,
  writable: true,
  configurable: true,
});

describe('reEnrollDevice', () => {
  const dummyDrp1Base64 = 'ZHJwMV9kdW1teV9iYXNlNjQ=';
  const acceptedPubKeyBase64 = 'cHVia2V5X2Jhc2U2NA==';
  const dummySecDeviceIdHex = '0102030405060708090a0b0c0d0e0f10';
  const dummyGenerationId = '0102030405060708090a0b0c0d0e0f10';

  it('rejects invalid expectedDeviceKeyVersion (0, negative, fractional, NaN, > u32::MAX)', async () => {
    const invoke = vi.fn();
    for (const invalidVersion of [0, -1, 1.5, NaN, Infinity, 4294967296]) {
      const res = await reEnrollDevice({
        enrollmentAuthId: 'auth-1',
        expectedDeviceKeyVersion: invalidVersion,
        customInvoke: invoke,
      });
      expect(res).toEqual({ ok: false, code: 'invalid_device_key_version' });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed when native bridge is unavailable', async () => {
    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: undefined,
    });
    expect(res).toEqual({ ok: false, code: 'native_bridge_unavailable' });
  });

  it('fails closed when beginDeviceRegistration returns failure', async () => {
    const invoke = vi.fn();
    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({ data: { ok: false, code: 'session_rejected' } }),
      },
    });
    expect(res).toEqual({ ok: false, code: 'session_rejected' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed when native_generate_device_registration_proof fails', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('DPAPI_FAILED'));
    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.code).toBe('proof_generation_failed');
    expect(invoke).toHaveBeenCalledWith('native_generate_device_registration_proof', {
      enrollmentAuthId: 'auth-1',
      deviceRegistrationNonceBase64: 'bm9uY2U=',
    });
  });

  it('fails closed and does NOT call finalize when server reEnrollPrivilegedDevice rejects', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        reEnrollPrivilegedDevice: async () => ({
          data: {
            ok: false,
            code: 'device_key_version_mismatch',
          },
        }),
      },
    });

    expect(res).toEqual({ ok: false, code: 'device_key_version_mismatch' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
  });

  it('rejects when server accepted public key does not match staged public key', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        reEnrollPrivilegedDevice: async () => ({
          data: {
            ok: true,
            securityDeviceIdHex: dummySecDeviceIdHex,
            branchId: 'B-HQ',
            newDeviceKeyVersion: 2,
            acceptedPublicKeyBase64: Buffer.from(new Uint8Array(32).fill(0xee)).toString('base64'),
            serverFinalizationReceiptBase64: 'fake-receipt',
          },
        }),
      },
    });

    expect(res).toEqual({ ok: false, code: 'accepted_public_key_mismatch' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects when server newDeviceKeyVersion exceeds MAX_DEVICE_KEY_VERSION (4294967295)', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        reEnrollPrivilegedDevice: async () => ({
          data: {
            ok: true,
            securityDeviceIdHex: dummySecDeviceIdHex,
            branchId: 'B-HQ',
            newDeviceKeyVersion: 4294967296,
            acceptedPublicKeyBase64: acceptedPubKeyBase64,
          },
        }),
      },
    });

    expect(res).toEqual({ ok: false, code: 'invalid_server_confirmation_bindings' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('returns LOCAL_ENROLLMENT_FINALIZATION_REQUIRED when server succeeds but native finalize fails', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      if (cmd === 'native_finalize_device_enrollment') {
        throw new Error('REPLACE_FILE_ERROR');
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        reEnrollPrivilegedDevice: async () => ({
          data: {
            ok: true,
            securityDeviceIdHex: dummySecDeviceIdHex,
            branchId: 'B-HQ',
            newDeviceKeyVersion: 2,
            acceptedPublicKeyBase64: acceptedPubKeyBase64,
            serverFinalizationReceiptBase64: 'fake-receipt-base64',
          },
        }),
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.code).toBe('LOCAL_ENROLLMENT_FINALIZATION_REQUIRED');
    expect(res.retryContext).toEqual({
      enrollmentGenerationId: dummyGenerationId,
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
      acceptedPublicKeyBase64: acceptedPubKeyBase64,
      serverFinalizationReceiptBase64: 'fake-receipt-base64',
      expectedOperationKind: 'RE_ENROLLMENT',
    });
  });

  it('allows exact finalize retry using retryContext without calling server again or generating a new key', async () => {
    const retryContext: FinalizeRetryContext = {
      enrollmentGenerationId: dummyGenerationId,
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
      acceptedPublicKeyBase64: acceptedPubKeyBase64,
      serverFinalizationReceiptBase64: 'fake-receipt-base64',
      expectedOperationKind: 'RE_ENROLLMENT',
    };

    const serverCallableMock = vi.fn();
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      status: 'COMMITTED',
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
      enrollmentGenerationIdHex: dummyGenerationId,
      acceptedPublicKeyBase64: acceptedPubKeyBase64,
    });

    const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
    expect(res).toEqual({
      ok: true,
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
    });
    expect(invoke).toHaveBeenCalledWith('native_finalize_device_enrollment', {
      enrollmentGenerationId: dummyGenerationId,
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
      acceptedPublicKeyBase64: acceptedPubKeyBase64,
      serverReceiptBase64: 'fake-receipt-base64',
      oks1Base64: undefined,
      expectedOperationKind: 'RE_ENROLLMENT',
    });
    // Server callable invocation count remains exactly 0
    expect(serverCallableMock).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('native_generate_device_registration_proof', expect.anything());
  });

  it('executes the full happy path in exact prepare -> server -> finalize order', async () => {
    const callOrder: string[] = [];

    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      callOrder.push(cmd);
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      if (cmd === 'native_finalize_device_enrollment') {
        return {
          success: true,
          status: 'COMMITTED',
          securityDeviceIdHex: dummySecDeviceIdHex,
          branchId: 'B-HQ',
          deviceKeyVersion: 2,
          enrollmentGenerationIdHex: dummyGenerationId,
          acceptedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => {
          callOrder.push('server_begin');
          return {
            data: {
              ok: true,
              registrationSessionId: 'sess-1',
              deviceRegistrationNonceBase64: 'bm9uY2U=',
            },
          };
        },
        reEnrollPrivilegedDevice: async (payload: any) => {
          callOrder.push('server_re_enroll');
          expect(payload.registrationSessionId).toBe('sess-1');
          expect(payload.drp1Base64).toBe(dummyDrp1Base64);
          expect(payload.expectedDeviceKeyVersion).toBe(1);
          expect(payload.enrollmentGenerationId).toBe(dummyGenerationId);
          return {
            data: {
              ok: true,
              securityDeviceIdHex: dummySecDeviceIdHex,
              branchId: 'B-HQ',
              newDeviceKeyVersion: 2,
              acceptedPublicKeyBase64: acceptedPubKeyBase64,
              serverFinalizationReceiptBase64: 'fake-receipt-base64',
            },
          };
        },
      },
    });

    expect(callOrder).toEqual([
      'server_begin',
      'native_generate_device_registration_proof',
      'server_re_enroll',
      'native_finalize_device_enrollment',
    ]);

    expect(res).toEqual({
      ok: true,
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
    });
  });

  it('recovers from process crash between server re-enroll success and local finalize without server recall', async () => {
    localStorage.clear();
    const serverCallCount = vi.fn();

    const invoke1 = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      if (cmd === 'native_finalize_device_enrollment') {
        throw new Error('CRASH_DURING_FINALIZE');
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const firstAttempt = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke1,
      customCallables: {
        beginDeviceRegistration: async () => {
          serverCallCount();
          return {
            data: {
              ok: true,
              registrationSessionId: 'sess-1',
              deviceRegistrationNonceBase64: 'bm9uY2U=',
            },
          };
        },
        reEnrollPrivilegedDevice: async () => {
          serverCallCount();
          return {
            data: {
              ok: true,
              securityDeviceIdHex: dummySecDeviceIdHex,
              branchId: 'B-HQ',
              newDeviceKeyVersion: 2,
              acceptedPublicKeyBase64: acceptedPubKeyBase64,
              serverFinalizationReceiptBase64: 'fake-receipt-base64',
            },
          };
        },
      },
    });

    expect(firstAttempt.ok).toBe(false);
    expect(serverCallCount).toHaveBeenCalledTimes(2);

    // Verify persisted across simulated crash
    const persisted = loadPendingFinalization();
    expect(persisted).toEqual({
      enrollmentGenerationId: dummyGenerationId,
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
      acceptedPublicKeyBase64: acceptedPubKeyBase64,
      serverFinalizationReceiptBase64: 'fake-receipt-base64',
      expectedOperationKind: 'RE_ENROLLMENT',
    });

    // Simulate restart: discard in-memory state, read storage, retry finalize
    const postRestartServerCall = vi.fn();
    const restartedContext = loadPendingFinalization()!;
    const invoke2 = vi.fn().mockResolvedValue({
      success: true,
      status: 'COMMITTED',
      securityDeviceIdHex: dummySecDeviceIdHex,
      branchId: 'B-HQ',
      deviceKeyVersion: 2,
      enrollmentGenerationIdHex: dummyGenerationId,
      acceptedPublicKeyBase64: acceptedPubKeyBase64,
    });

    const recoveryRes = await finalizeDeviceEnrollmentRetry(restartedContext, invoke2);
    expect(recoveryRes.ok).toBe(true);
    expect(postRestartServerCall).toHaveBeenCalledTimes(0);
    expect(loadPendingFinalization()).toBeNull();
  });

  it('fails closed when server response is missing serverFinalizationReceiptBase64', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await reEnrollDevice({
      enrollmentAuthId: 'auth-1',
      expectedDeviceKeyVersion: 1,
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        reEnrollPrivilegedDevice: async () => ({
          data: {
            ok: true,
            securityDeviceIdHex: dummySecDeviceIdHex,
            branchId: 'B-HQ',
            newDeviceKeyVersion: 2,
            acceptedPublicKeyBase64: acceptedPubKeyBase64,
            // serverFinalizationReceiptBase64 missing!
          },
        }),
      },
    });

    expect(res).toEqual({ ok: false, code: 'server_receipt_missing' });
    expect(invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
  });

  it('Defect A: localStorage write failure aborts re-enrollment before native finalize invoke', async () => {
    localStorage.clear();
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: dummyGenerationId,
          stagedPublicKeyBase64: acceptedPubKeyBase64,
        };
      }
      if (cmd === 'native_finalize_device_enrollment') {
        throw new Error('SHOULD_NOT_BE_INVOKED');
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('DISK_FULL');
    };

    try {
      const res = await reEnrollDevice({
        enrollmentAuthId: 'auth-1',
        expectedDeviceKeyVersion: 1,
        customInvoke: invoke,
        customCallables: {
          beginDeviceRegistration: async () => ({
            data: {
              ok: true,
              registrationSessionId: 'sess-1',
              deviceRegistrationNonceBase64: 'bm9uY2U=',
            },
          }),
          reEnrollPrivilegedDevice: async () => ({
            data: {
              ok: true,
              securityDeviceIdHex: dummySecDeviceIdHex,
              branchId: 'B-HQ',
              newDeviceKeyVersion: 2,
              acceptedPublicKeyBase64: acceptedPubKeyBase64,
              serverFinalizationReceiptBase64: 'fake-receipt',
            },
          }),
        },
      });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure');
      expect(res.code).toBe('LOCAL_ENROLLMENT_FINALIZATION_REQUIRED');
      expect(res.errorDetail).toContain('storage_write_failed');
      expect(invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });
});
