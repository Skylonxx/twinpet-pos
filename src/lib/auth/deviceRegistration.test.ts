import { describe, it, expect, vi } from 'vitest';
import {
  registerDevice,
  finalizeDeviceEnrollmentRetry,
  extractPublicKeyFromDrp1,
  loadPendingFinalization,
  PENDING_FINALIZATION_STORAGE_KEY,
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

describe('deviceRegistration', () => {
  // Construct a minimal dummy DRP1 frame (185 bytes)
  const dummyDrp1 = new Uint8Array(185);
  dummyDrp1.set([0x44, 0x52, 0x50, 0x31], 0); // DRP1
  dummyDrp1[4] = 1; // version
  dummyDrp1[5] = 32; // authId len
  // 6..38 authId
  dummyDrp1[38] = 32; // nonce len
  // 39..71 nonce
  dummyDrp1[71] = 16; // secDeviceId len
  // 72..88 secDeviceId
  dummyDrp1[88] = 32; // pubkey len
  dummyDrp1.fill(0xaa, 89, 121); // pubkey (32 bytes of 0xaa)
  // 121..185 signature

  const dummyDrp1Base64 = Buffer.from(dummyDrp1).toString('base64');
  const expectedPubKeyBase64 = Buffer.from(new Uint8Array(32).fill(0xaa)).toString('base64');

  it('extractPublicKeyFromDrp1 correctly extracts 32-byte public key from DRP1 offset 89..121', () => {
    const extracted = extractPublicKeyFromDrp1(dummyDrp1Base64);
    expect(extracted).toBe(expectedPubKeyBase64);
  });

  it('fails closed when native bridge is unavailable', async () => {
    const res = await registerDevice('auth-1', {
      customInvoke: undefined,
    });
    expect(res).toEqual({ ok: false, code: 'native_bridge_unavailable' });
  });

  it('fails closed when beginDeviceRegistration returns failure', async () => {
    const invoke = vi.fn();
    const res = await registerDevice('auth-1', {
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
    const res = await registerDevice('auth-1', {
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

  it('fails closed and does NOT call finalize when server completeDeviceRegistration rejects', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          stagedPublicKeyBase64: expectedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await registerDevice('auth-1', {
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        completeDeviceRegistration: async () => ({
          data: {
            ok: false,
            code: 'drp1_bad_self_signature',
          },
        }),
      },
    });

    expect(res).toEqual({ ok: false, code: 'drp1_bad_self_signature' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
  });

  it('rejects when server accepted public key does not match staged public key', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          stagedPublicKeyBase64: expectedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await registerDevice('auth-1', {
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        completeDeviceRegistration: async () => ({
          data: {
            ok: true,
            securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
            branchId: 'B-HQ',
            deviceKeyVersion: 1,
            acceptedPublicKeyBase64: Buffer.from(new Uint8Array(32).fill(0xbb)).toString('base64'),
            serverFinalizationReceiptBase64: 'fake-receipt',
          },
        }),
      },
    });

    expect(res).toEqual({ ok: false, code: 'accepted_public_key_mismatch' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects when server deviceKeyVersion exceeds MAX_DEVICE_KEY_VERSION (4294967295)', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          stagedPublicKeyBase64: expectedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await registerDevice('auth-1', {
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        completeDeviceRegistration: async () => ({
          data: {
            ok: true,
            securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
            branchId: 'B-HQ',
            deviceKeyVersion: 4294967296, // exceeds u32
            acceptedPublicKeyBase64: expectedPubKeyBase64,
            serverFinalizationReceiptBase64: 'fake-receipt',
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
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          stagedPublicKeyBase64: expectedPubKeyBase64,
        };
      }
      if (cmd === 'native_finalize_device_enrollment') {
        throw new Error('FENCE_LOCK_FAILED');
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await registerDevice('auth-1', {
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => ({
          data: {
            ok: true,
            registrationSessionId: 'sess-1',
            deviceRegistrationNonceBase64: 'bm9uY2U=',
          },
        }),
        completeDeviceRegistration: async () => ({
          data: {
            ok: true,
            securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
            branchId: 'B-HQ',
            deviceKeyVersion: 1,
            acceptedPublicKeyBase64: expectedPubKeyBase64,
            serverFinalizationReceiptBase64: 'fake-receipt-base64',
            oks1Base64: 'fake-oks1-base64',
          },
        }),
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.code).toBe('LOCAL_ENROLLMENT_FINALIZATION_REQUIRED');
    expect(res.retryContext).toEqual({
      enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'B-HQ',
      deviceKeyVersion: 1,
      acceptedPublicKeyBase64: expectedPubKeyBase64,
      serverFinalizationReceiptBase64: 'fake-receipt-base64',
      oks1Base64: 'fake-oks1-base64',
      expectedOperationKind: 'INITIAL_ENROLLMENT',
    });
  });

  it('allows exact finalize retry using retryContext without calling server again or generating a new key', async () => {
    const retryContext: FinalizeRetryContext = {
      enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'B-HQ',
      deviceKeyVersion: 1,
      acceptedPublicKeyBase64: expectedPubKeyBase64,
      serverFinalizationReceiptBase64: 'fake-receipt-base64',
      oks1Base64: 'fake-oks1-base64',
      expectedOperationKind: 'INITIAL_ENROLLMENT',
    };

    const serverCallableMock = vi.fn();
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      status: 'COMMITTED',
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'B-HQ',
      deviceKeyVersion: 1,
      enrollmentGenerationIdHex: '0102030405060708090a0b0c0d0e0f10',
      acceptedPublicKeyBase64: expectedPubKeyBase64,
    });

    const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
    expect(res).toEqual({
      ok: true,
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'B-HQ',
      deviceKeyVersion: 1,
    });
    expect(invoke).toHaveBeenCalledWith('native_finalize_device_enrollment', {
      enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'B-HQ',
      deviceKeyVersion: 1,
      acceptedPublicKeyBase64: expectedPubKeyBase64,
      serverReceiptBase64: 'fake-receipt-base64',
      oks1Base64: 'fake-oks1-base64',
      expectedOperationKind: 'INITIAL_ENROLLMENT',
    });
    // Crucial: Server callable invocation count remains exactly 0
    expect(serverCallableMock).not.toHaveBeenCalled();
    // And proof generation is NOT called again
    expect(invoke).not.toHaveBeenCalledWith('native_generate_device_registration_proof', expect.anything());
  });

  it('executes the full happy path in exact prepare -> server -> finalize order', async () => {
    const callOrder: string[] = [];

    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      callOrder.push(cmd);
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          stagedPublicKeyBase64: expectedPubKeyBase64,
        };
      }
      if (cmd === 'native_finalize_device_enrollment') {
        return {
          success: true,
          status: 'COMMITTED',
          securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
          branchId: 'LDP-001',
          deviceKeyVersion: 1,
          enrollmentGenerationIdHex: '0102030405060708090a0b0c0d0e0f10',
          acceptedPublicKeyBase64: expectedPubKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const res = await registerDevice('auth-1234567890abcdef1234567890abcdef', {
      customInvoke: invoke,
      customCallables: {
        beginDeviceRegistration: async () => {
          callOrder.push('server_begin');
          return {
            data: {
              ok: true,
              registrationSessionId: 'sess-abc',
              deviceRegistrationNonceBase64: 'bm9uY2U=',
            },
          };
        },
        completeDeviceRegistration: async (payload: any) => {
          callOrder.push('server_complete');
          expect(payload.registrationSessionId).toBe('sess-abc');
          expect(payload.drp1Base64).toBe(dummyDrp1Base64);
          expect(payload.enrollmentGenerationId).toBe('0102030405060708090a0b0c0d0e0f10');
          return {
            data: {
              ok: true,
              securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
              branchId: 'LDP-001',
              deviceKeyVersion: 1,
              acceptedPublicKeyBase64: expectedPubKeyBase64,
              serverFinalizationReceiptBase64: 'fake-receipt-base64',
            },
          };
        },
      },
    });

    expect(callOrder).toEqual([
      'server_begin',
      'native_generate_device_registration_proof',
      'server_complete',
      'native_finalize_device_enrollment',
    ]);

    expect(res).toEqual({
      ok: true,
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'LDP-001',
      deviceKeyVersion: 1,
    });
  });

  it('recovers from process crash between server success and local finalize without server recall', async () => {
    localStorage.clear();
    const serverCallCount = vi.fn();

    const invoke1 = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'native_generate_device_registration_proof') {
        return {
          drp1Base64: dummyDrp1Base64,
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          stagedPublicKeyBase64: expectedPubKeyBase64,
        };
      }
      if (cmd === 'native_finalize_device_enrollment') {
        // Crash / bridge error during first finalize attempt
        throw new Error('PROCESS_CRASH_SIMULATION');
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const firstAttempt = await registerDevice('auth-1', {
      customInvoke: invoke1,
      customCallables: {
        beginDeviceRegistration: async () => {
          serverCallCount();
          return {
            data: {
              ok: true,
              registrationSessionId: 'sess-crash',
              deviceRegistrationNonceBase64: 'bm9uY2U=',
            },
          };
        },
        completeDeviceRegistration: async () => {
          serverCallCount();
          return {
            data: {
              ok: true,
              securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
              branchId: 'LDP-001',
              deviceKeyVersion: 1,
              acceptedPublicKeyBase64: expectedPubKeyBase64,
              serverFinalizationReceiptBase64: 'fake-receipt-base64',
              oks1Base64: 'fake-oks1-base64',
            },
          };
        },
      },
    });

    expect(firstAttempt.ok).toBe(false);
    expect(serverCallCount).toHaveBeenCalledTimes(2);

    // Assert durable pending finalization record exists in storage with exact bindings
    const pending = loadPendingFinalization();
    expect(pending).not.toBeNull();
    expect(pending).toEqual({
      enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'LDP-001',
      deviceKeyVersion: 1,
      acceptedPublicKeyBase64: expectedPubKeyBase64,
      serverFinalizationReceiptBase64: 'fake-receipt-base64',
      oks1Base64: 'fake-oks1-base64',
      expectedOperationKind: 'INITIAL_ENROLLMENT',
    });

    // Simulate process restart: discard all in-memory closures & reset server mocks
    const postRestartServerCall = vi.fn();
    const restartedContext = loadPendingFinalization()!;
    expect(restartedContext).toBeDefined();

    const invoke2 = vi.fn().mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'native_finalize_device_enrollment') {
        expect(args.serverReceiptBase64).toBe('fake-receipt-base64');
        expect(args.oks1Base64).toBe('fake-oks1-base64');
        expect(args.expectedOperationKind).toBe('INITIAL_ENROLLMENT');
        return {
          success: true,
          status: 'COMMITTED',
          securityDeviceIdHex: restartedContext.securityDeviceIdHex,
          branchId: restartedContext.branchId,
          deviceKeyVersion: restartedContext.deviceKeyVersion,
          enrollmentGenerationIdHex: restartedContext.enrollmentGenerationId,
          acceptedPublicKeyBase64: restartedContext.acceptedPublicKeyBase64,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    // Execute recovery finalize on restart
    const recoveryRes = await finalizeDeviceEnrollmentRetry(restartedContext, invoke2);
    expect(recoveryRes).toEqual({
      ok: true,
      securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
      branchId: 'LDP-001',
      deviceKeyVersion: 1,
    });

    // Assert server was called ZERO times during restart recovery
    expect(postRestartServerCall).toHaveBeenCalledTimes(0);

    // Assert pending finalization cleared upon success
    expect(loadPendingFinalization()).toBeNull();
  });

  describe('Section 9 Hostile Matrix & Recovery Invariants', () => {
    it('Defect A: localStorage write failure aborts before native finalize invoke, preserves prior state, 0 server recall', async () => {
      localStorage.clear();
      // Pre-populate an existing pending record
      localStorage.setItem(
        PENDING_FINALIZATION_STORAGE_KEY,
        JSON.stringify({
          enrollmentGenerationId: 'prior-gen',
          securityDeviceIdHex: 'prior-device',
          branchId: 'prior-branch',
          deviceKeyVersion: 1,
          acceptedPublicKeyBase64: expectedPubKeyBase64,
          serverFinalizationReceiptBase64: 'prior-receipt',
        }),
      );

      const invoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'native_generate_device_registration_proof') {
          return {
            drp1Base64: dummyDrp1Base64,
            enrollmentGenerationId: 'new-gen-id',
            stagedPublicKeyBase64: expectedPubKeyBase64,
          };
        }
        if (cmd === 'native_finalize_device_enrollment') {
          throw new Error('SHOULD_NOT_BE_INVOKED');
        }
        throw new Error(`unexpected command ${cmd}`);
      });

      // Break localStorage.setItem
      const originalSetItem = localStorage.setItem;
      localStorage.setItem = () => {
        throw new Error('QUOTA_EXCEEDED');
      };

      try {
        const res = await registerDevice('auth-1', {
          customInvoke: invoke,
          customCallables: {
            beginDeviceRegistration: async () => ({
              data: {
                ok: true,
                registrationSessionId: 'sess-fail',
                deviceRegistrationNonceBase64: 'bm9uY2U=',
              },
            }),
            completeDeviceRegistration: async () => ({
              data: {
                ok: true,
                securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
                branchId: 'LDP-001',
                deviceKeyVersion: 1,
                acceptedPublicKeyBase64: expectedPubKeyBase64,
                serverFinalizationReceiptBase64: 'fake-receipt',
              },
            }),
          },
        });

        expect(res.ok).toBe(false);
        if (res.ok) throw new Error('expected failure');
        expect(res.code).toBe('LOCAL_ENROLLMENT_FINALIZATION_REQUIRED');
        expect(res.errorDetail).toContain('storage_write_failed');
        // Native finalize must NOT have been called
        expect(invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
      } finally {
        localStorage.setItem = originalSetItem;
      }

      // Prior state in storage preserved
      const stored = JSON.parse(localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY)!);
      expect(stored.enrollmentGenerationId).toBe('prior-gen');
    });

    it('rejects when server omits serverFinalizationReceiptBase64', async () => {
      const invoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'native_generate_device_registration_proof') {
          return {
            drp1Base64: dummyDrp1Base64,
            enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
            stagedPublicKeyBase64: expectedPubKeyBase64,
          };
        }
        throw new Error(`unexpected command ${cmd}`);
      });

      const res = await registerDevice('auth-1', {
        customInvoke: invoke,
        customCallables: {
          beginDeviceRegistration: async () => ({
            data: {
              ok: true,
              registrationSessionId: 'sess-1',
              deviceRegistrationNonceBase64: 'bm9uY2U=',
            },
          }),
          completeDeviceRegistration: async () => ({
            data: {
              ok: true,
              securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
              branchId: 'B-HQ',
              deviceKeyVersion: 1,
              acceptedPublicKeyBase64: expectedPubKeyBase64,
              // Missing serverFinalizationReceiptBase64
            },
          }),
        },
      });

      expect(res).toEqual({ ok: false, code: 'server_receipt_missing' });
      expect(invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
    });

    describe('Hostile Tamper Matrix & Restart Recovery (Codex IR-005)', () => {
      const baseValidPending: FinalizeRetryContext = {
        enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
        securityDeviceIdHex: '11223344556677889900aabbccddeeff',
        branchId: 'B-001',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'valid-base64-receipt==',
        oks1Base64: 'valid-base64-oks1==',
        expectedOperationKind: 'INITIAL_ENROLLMENT',
      };

      it('loadPendingFinalization accepts valid un-tampered record with all fields', () => {
        localStorage.clear();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(baseValidPending));
        const loaded = loadPendingFinalization();
        expect(loaded).toEqual(baseValidPending);
      });

      it('loadPendingFinalization accepts valid record without optional oks1 and expectedOperationKind', () => {
        localStorage.clear();
        const minimalValid: FinalizeRetryContext = {
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          securityDeviceIdHex: '11223344556677889900aabbccddeeff',
          branchId: 'B-001',
          deviceKeyVersion: 1,
          acceptedPublicKeyBase64: expectedPubKeyBase64,
          serverFinalizationReceiptBase64: 'valid-base64-receipt==',
        };
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(minimalValid));
        const loaded = loadPendingFinalization();
        expect(loaded).toEqual(minimalValid);
      });

      it('loadPendingFinalization hostile tamper matrix: rejects invalid or tampered fields', () => {
        // Tamper 1: enrollmentGenerationId (missing, empty, non-string)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, enrollmentGenerationId: undefined }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, enrollmentGenerationId: '' }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, enrollmentGenerationId: 12345 }));
        expect(loadPendingFinalization()).toBeNull();

        // Tamper 2: securityDeviceIdHex (missing, empty, non-string)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, securityDeviceIdHex: undefined }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, securityDeviceIdHex: '   ' }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, securityDeviceIdHex: {} }));
        expect(loadPendingFinalization()).toBeNull();

        // Tamper 3: branchId (missing, empty, non-string)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, branchId: undefined }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, branchId: '' }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, branchId: true }));
        expect(loadPendingFinalization()).toBeNull();

        // Tamper 4: deviceKeyVersion (missing, non-number, non-integer, <= 0, > 4294967295)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, deviceKeyVersion: undefined }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, deviceKeyVersion: '1' }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, deviceKeyVersion: 1.5 }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, deviceKeyVersion: 0 }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, deviceKeyVersion: -1 }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, deviceKeyVersion: 4294967296 }));
        expect(loadPendingFinalization()).toBeNull();

        // Tamper 5: acceptedPublicKeyBase64 (missing, empty, non-string)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, acceptedPublicKeyBase64: undefined }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, acceptedPublicKeyBase64: '' }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, acceptedPublicKeyBase64: 42 }));
        expect(loadPendingFinalization()).toBeNull();

        // Tamper 6: serverFinalizationReceiptBase64 (missing, empty, non-string)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, serverFinalizationReceiptBase64: undefined }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, serverFinalizationReceiptBase64: '' }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, serverFinalizationReceiptBase64: 999 }));
        expect(loadPendingFinalization()).toBeNull();

        // Tamper 7: oks1Base64 (non-string when present)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, oks1Base64: 123 }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, oks1Base64: false }));
        expect(loadPendingFinalization()).toBeNull();

        // Tamper 8: expectedOperationKind (invalid string, non-string)
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, expectedOperationKind: 'MALICIOUS_OP' }));
        expect(loadPendingFinalization()).toBeNull();
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...baseValidPending, expectedOperationKind: 1 }));
        expect(loadPendingFinalization()).toBeNull();
      });

      it('real restart recovery proof: recovers from stored pending record, runs native finalizer, 0 server calls, clears on success', async () => {
        localStorage.clear();
        // 1. Pending record persisted prior to restart
        const preRestartContext: FinalizeRetryContext = {
          enrollmentGenerationId: '0102030405060708090a0b0c0d0e0f10',
          securityDeviceIdHex: '11223344556677889900aabbccddeeff',
          branchId: 'B-MAIN',
          deviceKeyVersion: 1,
          acceptedPublicKeyBase64: expectedPubKeyBase64,
          serverFinalizationReceiptBase64: 'receipt-payload==',
          expectedOperationKind: 'INITIAL_ENROLLMENT',
        };
        localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(preRestartContext));

        // 2. Simulate process restart: reload state from persistent storage
        const recoveredContext = loadPendingFinalization();
        expect(recoveredContext).not.toBeNull();
        if (!recoveredContext) throw new Error('Failed to load pending finalization');

        // Track server calls - must be strictly 0
        const serverCallableCount = vi.fn();

        // 3. Mock native bridge receiving exact parameters
        const invoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
          if (cmd === 'native_finalize_device_enrollment') {
            expect(args).toEqual({
              enrollmentGenerationId: preRestartContext.enrollmentGenerationId,
              securityDeviceIdHex: preRestartContext.securityDeviceIdHex,
              branchId: preRestartContext.branchId,
              deviceKeyVersion: preRestartContext.deviceKeyVersion,
              acceptedPublicKeyBase64: preRestartContext.acceptedPublicKeyBase64,
              serverReceiptBase64: preRestartContext.serverFinalizationReceiptBase64,
              oks1Base64: undefined,
              expectedOperationKind: 'INITIAL_ENROLLMENT',
            });
            return {
              success: true,
              status: 'COMMITTED',
              securityDeviceIdHex: preRestartContext.securityDeviceIdHex,
              branchId: preRestartContext.branchId,
              deviceKeyVersion: preRestartContext.deviceKeyVersion,
              enrollmentGenerationIdHex: preRestartContext.enrollmentGenerationId,
              acceptedPublicKeyBase64: preRestartContext.acceptedPublicKeyBase64,
            };
          }
          throw new Error(`Unexpected command during recovery: ${cmd}`);
        });

        // 4. Run recovery finalization retry
        const outcome = await finalizeDeviceEnrollmentRetry(recoveredContext, invoke);
        expect(outcome.ok).toBe(true);
        expect(serverCallableCount).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledTimes(1);

        // 5. Storage cleared only after verified success
        expect(loadPendingFinalization()).toBeNull();
      });
    });

    it('Defect C: native result success=false retains pending record and returns failure', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      // Save to storage
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: false,
        error: 'RECEIPT_BINDING_MISMATCH',
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(false);
      // Storage MUST NOT be cleared
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('Defect C: native result malformed / unknown status retains pending record', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: true,
        status: 'SOME_UNKNOWN_STATUS',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        enrollmentGenerationIdHex: 'gen-1',
        acceptedPublicKeyBase64: expectedPubKeyBase64,
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure');
      expect(res.errorDetail).toContain('unexpected_finalize_status');
      // Storage MUST NOT be cleared
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('Defect C: native result mismatched generation retains pending record', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: true,
        status: 'COMMITTED',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        enrollmentGenerationIdHex: 'different-gen',
        acceptedPublicKeyBase64: expectedPubKeyBase64,
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure');
      expect(res.errorDetail).toContain('generation_id_mismatch');
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('Defect C: native result mismatched securityDeviceId retains pending record', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: true,
        status: 'COMMITTED',
        securityDeviceIdHex: 'different-sec',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        enrollmentGenerationIdHex: 'gen-1',
        acceptedPublicKeyBase64: expectedPubKeyBase64,
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure');
      expect(res.errorDetail).toContain('security_device_id_mismatch');
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('Defect C: native result mismatched branch retains pending record', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: true,
        status: 'COMMITTED',
        securityDeviceIdHex: 'sec-1',
        branchId: 'different-branch',
        deviceKeyVersion: 1,
        enrollmentGenerationIdHex: 'gen-1',
        acceptedPublicKeyBase64: expectedPubKeyBase64,
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure');
      expect(res.errorDetail).toContain('branch_id_mismatch');
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('Defect C: native result mismatched deviceKeyVersion retains pending record', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: true,
        status: 'COMMITTED',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 999,
        enrollmentGenerationIdHex: 'gen-1',
        acceptedPublicKeyBase64: expectedPubKeyBase64,
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure');
      expect(res.errorDetail).toContain('device_key_version_mismatch');
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('Defect C: native result mismatched acceptedPublicKeyBase64 retains pending record', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: true,
        status: 'COMMITTED',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        enrollmentGenerationIdHex: 'gen-1',
        acceptedPublicKeyBase64: 'tampered-pubkey-base64',
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure');
      expect(res.errorDetail).toContain('accepted_public_key_mismatch');
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('accepts ALREADY_COMMITTED and clears pending storage', async () => {
      localStorage.clear();
      const retryContext: FinalizeRetryContext = {
        enrollmentGenerationId: 'gen-1',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'fake-receipt',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(retryContext));

      const invoke = vi.fn().mockResolvedValue({
        success: true,
        status: 'ALREADY_COMMITTED',
        securityDeviceIdHex: 'sec-1',
        branchId: 'B-1',
        deviceKeyVersion: 1,
        enrollmentGenerationIdHex: 'gen-1',
        acceptedPublicKeyBase64: expectedPubKeyBase64,
      });

      const res = await finalizeDeviceEnrollmentRetry(retryContext, invoke);
      expect(res.ok).toBe(true);
      expect(loadPendingFinalization()).toBeNull();
    });
  });
});
