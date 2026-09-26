import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  registerDevice,
  finalizeDeviceEnrollmentRetry,
  extractPublicKeyFromDrp1,
  loadPendingFinalization,
  loadCompletionIntent,
  loadEnrollmentRecoveryState,
  parseCompletionIntent,
  recoverDeviceRegistrationCompletion,
  saveCompletionIntent,
  PENDING_COMPLETION_INTENT_SCHEMA,
  PENDING_COMPLETION_INTENT_STORAGE_KEY,
  PENDING_FINALIZATION_STORAGE_KEY,
  type FinalizeRetryContext,
  type PendingCompletionIntentV1,
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
  // Each test starts from empty durable storage (the completion intent is
  // never silently overwritten, so state must not leak between tests).
  beforeEach(() => {
    localStorage.clear();
  });

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
            registrationSessionId: '5e55000000000000000000000000000a',
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
            registrationSessionId: '5e55000000000000000000000000000a',
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
            registrationSessionId: '5e55000000000000000000000000000a',
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
            registrationSessionId: '5e55000000000000000000000000000a',
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
            registrationSessionId: '5e55000000000000000000000000000a',
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
              registrationSessionId: '5e55000000000000000000000000000b',
              deviceRegistrationNonceBase64: 'bm9uY2U=',
            },
          };
        },
        completeDeviceRegistration: async (payload: any) => {
          callOrder.push('server_complete');
          expect(payload.registrationSessionId).toBe('5e55000000000000000000000000000b');
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
              registrationSessionId: '5e55000000000000000000000000000c',
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
    it('Defect A: localStorage write failure aborts before the complete callable and native finalize, preserves prior state', async () => {
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
      const completeCallable = vi.fn(async () => ({
        data: {
          ok: true,
          securityDeviceIdHex: '0102030405060708090a0b0c0d0e0f10',
          branchId: 'LDP-001',
          deviceKeyVersion: 1,
          acceptedPublicKeyBase64: expectedPubKeyBase64,
          serverFinalizationReceiptBase64: 'fake-receipt',
        },
      }));

      try {
        const res = await registerDevice('auth-1', {
          customInvoke: invoke,
          customCallables: {
            beginDeviceRegistration: async () => ({
              data: {
                ok: true,
                registrationSessionId: '5e55000000000000000000000000000d',
                deviceRegistrationNonceBase64: 'bm9uY2U=',
              },
            }),
            completeDeviceRegistration: completeCallable,
          },
        });

        expect(res.ok).toBe(false);
        if (res.ok) throw new Error('expected failure');
        // The completion intent cannot be made durable, so the server is never called.
        expect(res.code).toBe('completion_intent_save_failed');
        expect(completeCallable).toHaveBeenCalledTimes(0);
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
              registrationSessionId: '5e55000000000000000000000000000a',
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

  describe('Durable completion intent & explicit response-loss recovery (Gemini-178/180)', () => {
    const SESSION = '5e55000000000000000000000000000e';
    const GEN = '0102030405060708090a0b0c0d0e0f10';
    const SEC_ID = '11223344556677889900aabbccddeeff';
    // The native proof command returns DRP1 as unpadded base64url.
    const nativeDrp1 = Buffer.from(dummyDrp1).toString('base64url');

    const validIntent = (): PendingCompletionIntentV1 => ({
      schema: PENDING_COMPLETION_INTENT_SCHEMA,
      version: 1,
      registrationSessionId: SESSION,
      drp1Base64: dummyDrp1Base64,
      enrollmentGenerationId: GEN,
      stagedPublicKeyBase64: expectedPubKeyBase64,
    });

    const serverOk = (receipt = 'receipt-1') => ({
      data: {
        ok: true,
        securityDeviceIdHex: SEC_ID,
        branchId: 'LDP-001',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: receipt,
        oks1Base64: 'oks1-1',
      },
    });

    const committed = {
      success: true,
      status: 'COMMITTED',
      securityDeviceIdHex: SEC_ID,
      branchId: 'LDP-001',
      deviceKeyVersion: 1,
      enrollmentGenerationIdHex: GEN,
      acceptedPublicKeyBase64: expectedPubKeyBase64,
    };

    /** Records the relative order of server calls, native calls and durable storage mutations. */
    function harness(
      opts: { finalize?: 'ok' | 'throw'; complete?: (request: unknown) => Promise<{ data: unknown }> } = {},
    ) {
      const events: string[] = [];
      const invoke = vi.fn(async (cmd: string) => {
        events.push(cmd);
        if (cmd === 'native_generate_device_registration_proof') {
          return { drp1Base64: nativeDrp1, enrollmentGenerationId: GEN, stagedPublicKeyBase64: expectedPubKeyBase64 };
        }
        if (cmd === 'native_finalize_device_enrollment') {
          if (opts.finalize === 'throw') throw new Error('NATIVE_FINALIZE_FAILED');
          return committed;
        }
        throw new Error(`unexpected command ${cmd}`);
      });
      const begin = vi.fn(async () => {
        events.push('server_begin');
        return { data: { ok: true, registrationSessionId: SESSION, deviceRegistrationNonceBase64: 'bm9uY2U=' } };
      });
      const complete = vi.fn(async (request: unknown): Promise<{ data: unknown }> => {
        events.push('server_complete');
        return opts.complete ? opts.complete(request) : serverOk();
      });
      const realSet = localStorage.setItem;
      const realRemove = localStorage.removeItem;
      localStorage.setItem = (k: string, v: string) => {
        events.push(`set:${k}`);
        realSet(k, v);
      };
      localStorage.removeItem = (k: string) => {
        events.push(`remove:${k}`);
        realRemove(k);
      };
      const restore = () => {
        localStorage.setItem = realSet;
        localStorage.removeItem = realRemove;
      };
      return {
        events,
        invoke,
        begin,
        complete,
        restore,
        options: { customInvoke: invoke, customCallables: { beginDeviceRegistration: begin, completeDeviceRegistration: complete } },
      };
    }

    it('saves the intent BEFORE the complete call, and the finalize context BEFORE clearing the intent', async () => {
      const h = harness();
      try {
        const res = await registerDevice('auth-1', h.options);
        expect(res.ok).toBe(true);
      } finally {
        h.restore();
      }
      expect(h.events).toEqual([
        'server_begin',
        'native_generate_device_registration_proof',
        `set:${PENDING_COMPLETION_INTENT_STORAGE_KEY}`,
        'server_complete',
        `set:${PENDING_FINALIZATION_STORAGE_KEY}`,
        `remove:${PENDING_COMPLETION_INTENT_STORAGE_KEY}`,
        'native_finalize_device_enrollment',
        `remove:${PENDING_FINALIZATION_STORAGE_KEY}`,
      ]);
      // The native base64url DRP1 is sent as its canonical standard-base64 form (same bytes).
      expect(h.complete).toHaveBeenCalledWith({
        registrationSessionId: SESSION,
        drp1Base64: dummyDrp1Base64,
        enrollmentGenerationId: GEN,
      });
      expect(loadCompletionIntent()).toBeNull();
      expect(loadPendingFinalization()).toBeNull();
    });

    it('intent save failure => complete callable count 0', async () => {
      const h = harness();
      const realSet = localStorage.setItem;
      localStorage.setItem = (k: string, v: string) => {
        if (k === PENDING_COMPLETION_INTENT_STORAGE_KEY) throw new Error('QUOTA');
        realSet(k, v);
      };
      try {
        const res = await registerDevice('auth-1', h.options);
        expect(res).toMatchObject({ ok: false, code: 'completion_intent_save_failed' });
      } finally {
        h.restore();
      }
      expect(h.complete).toHaveBeenCalledTimes(0);
      expect(h.invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
    });

    it('a valid pending intent is never overwritten (a new registration cannot reach the server)', async () => {
      saveCompletionIntent(validIntent());
      expect(() => saveCompletionIntent({ ...validIntent(), registrationSessionId: 'ff'.repeat(16) })).toThrow(
        'completion_intent_already_pending',
      );
      const h = harness();
      try {
        const res = await registerDevice('auth-1', h.options);
        expect(res).toMatchObject({ ok: false, code: 'completion_intent_save_failed' });
      } finally {
        h.restore();
      }
      expect(h.complete).toHaveBeenCalledTimes(0);
      expect(loadCompletionIntent()).toEqual(validIntent());
    });

    it('strict parser rejects malformed / extra-key / non-canonical records without repair', () => {
      const v = validIntent();
      expect(parseCompletionIntent(v)).toEqual(v);
      const bad: unknown[] = [
        null,
        [],
        { ...v, extra: 1 },
        { ...v, schema: 'other' },
        { ...v, version: 2 },
        { ...v, registrationSessionId: SESSION.toUpperCase() },
        { ...v, enrollmentGenerationId: 'zz'.repeat(16) },
        { ...v, drp1Base64: nativeDrp1 }, // base64url is not the stored canonical form
        { ...v, drp1Base64: Buffer.alloc(184).toString('base64') },
        { ...v, stagedPublicKeyBase64: Buffer.alloc(31).toString('base64') },
        { ...v, stagedPublicKeyBase64: `${expectedPubKeyBase64.slice(0, 42)}r=` }, // non-canonical trailing bits
      ];
      for (const candidate of bad) expect(parseCompletionIntent(candidate)).toBeNull();
      const missing: Record<string, unknown> = { ...v };
      delete missing.drp1Base64;
      expect(parseCompletionIntent(missing)).toBeNull();
      localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, '{not json');
      expect(loadCompletionIntent()).toBeNull();
    });

    it('FinalizeRetryContext save failure => intent kept, native finalize count 0, single server call', async () => {
      const h = harness();
      const realSet = localStorage.setItem;
      localStorage.setItem = (k: string, v: string) => {
        if (k === PENDING_FINALIZATION_STORAGE_KEY) throw new Error('QUOTA');
        realSet(k, v);
      };
      try {
        const res = await registerDevice('auth-1', h.options);
        expect(res).toMatchObject({ ok: false, code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED' });
      } finally {
        h.restore();
      }
      expect(h.complete).toHaveBeenCalledTimes(1);
      expect(h.invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
      expect(loadCompletionIntent()).not.toBeNull();
      expect(loadPendingFinalization()).toBeNull();
    });

    it('intent clear failure => both records remain and the finalize context wins (no server replay)', async () => {
      const h = harness({ finalize: 'throw' });
      const realRemove = localStorage.removeItem;
      localStorage.removeItem = (k: string) => {
        if (k === PENDING_COMPLETION_INTENT_STORAGE_KEY) throw new Error('LOCKED');
        realRemove(k);
      };
      try {
        const res = await registerDevice('auth-1', h.options);
        expect(res).toMatchObject({ ok: false, code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED' });
      } finally {
        h.restore();
      }
      expect(loadCompletionIntent()).not.toBeNull();
      expect(loadPendingFinalization()).not.toBeNull();
      expect(loadEnrollmentRecoveryState().kind).toBe('finalization_pending');

      const recover = harness();
      try {
        expect(await recoverDeviceRegistrationCompletion(recover.options)).toEqual({ ok: false, code: 'finalization_pending' });
      } finally {
        recover.restore();
      }
      expect(recover.complete).toHaveBeenCalledTimes(0);
    });

    it('an explicit first-call server rejection (nothing consumed) releases the intent; a committed-but-invalid response keeps it', async () => {
      const rejected = harness({ complete: async () => ({ data: { ok: false, code: 'enrollment_authorization_expired' } }) });
      try {
        expect(await registerDevice('auth-1', rejected.options)).toEqual({ ok: false, code: 'enrollment_authorization_expired' });
      } finally {
        rejected.restore();
      }
      expect(loadCompletionIntent()).toBeNull();

      // ok:true (the server committed) but the accepted key does not match the staged key.
      const mismatched = harness({
        complete: async () => ({
          data: { ...serverOk().data, acceptedPublicKeyBase64: Buffer.alloc(32, 0xbb).toString('base64') },
        }),
      });
      try {
        expect(await registerDevice('auth-1', mismatched.options)).toEqual({ ok: false, code: 'accepted_public_key_mismatch' });
      } finally {
        mismatched.restore();
      }
      expect(loadCompletionIntent()).toEqual(validIntent());
    });

    it('N2: a server-side ambiguous outcome (callable internal error) keeps the intent; the client does not classify error codes', async () => {
      const h = harness({
        complete: async () => {
          throw Object.assign(new Error('internal'), { code: 'functions/internal' });
        },
      });
      try {
        await expect(registerDevice('auth-1', h.options)).rejects.toThrow('internal');
      } finally {
        h.restore();
      }
      expect(loadCompletionIntent()).toEqual(validIntent());
      expect(loadPendingFinalization()).toBeNull();
    });

    // --- N4: finalization authority is released only after intent absence is PROVEN ---

    const ctxFor = (gen = GEN): FinalizeRetryContext => ({
      enrollmentGenerationId: gen,
      securityDeviceIdHex: SEC_ID,
      branchId: 'LDP-001',
      deviceKeyVersion: 1,
      acceptedPublicKeyBase64: expectedPubKeyBase64,
      serverFinalizationReceiptBase64: 'receipt-1',
      oks1Base64: 'oks1-1',
      expectedOperationKind: 'INITIAL_ENROLLMENT',
    });

    const nativeReturning = (status: 'COMMITTED' | 'ALREADY_COMMITTED') =>
      vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd !== 'native_finalize_device_enrollment' || !args) throw new Error(`unexpected command ${cmd}`);
        return { ...committed, status };
      });

    /** Makes removal of the intent key fail: 'throw' raises, 'silent' returns normally without removing. */
    function breakIntentRemoval(mode: 'throw' | 'silent') {
      const realRemove = localStorage.removeItem;
      localStorage.removeItem = (k: string) => {
        if (k === PENDING_COMPLETION_INTENT_STORAGE_KEY) {
          if (mode === 'throw') throw new Error('LOCKED');
          return;
        }
        realRemove(k);
      };
      return () => {
        localStorage.removeItem = realRemove;
      };
    }

    it('N4-A: both intent removals fail after a verified native COMMITTED -> not success; finalize context and intent both retained; no replay', async () => {
      const h = harness(); // native finalize returns COMMITTED
      const restoreRemoval = breakIntentRemoval('throw');
      let res;
      try {
        res = await registerDevice('auth-1', h.options);
      } finally {
        restoreRemoval();
        h.restore();
      }
      expect(res).toMatchObject({
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'completion_intent_cleanup_failed',
      });
      expect(h.invoke).toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
      expect(h.complete).toHaveBeenCalledTimes(1);
      expect(loadPendingFinalization()).toEqual(ctxFor());
      expect(loadCompletionIntent()).toEqual(validIntent());
      expect(loadEnrollmentRecoveryState().kind).toBe('finalization_pending');
    });

    it('N4-B: a later local retry reuses the ORIGINAL receipt/OKS1, cleans up, and only then clears the finalize context', async () => {
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(ctxFor()));
      localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, JSON.stringify(validIntent()));
      const invoke = nativeReturning('ALREADY_COMMITTED');
      const serverComplete = vi.fn();

      const res = await finalizeDeviceEnrollmentRetry(loadPendingFinalization()!, invoke);

      expect(res).toEqual({ ok: true, securityDeviceIdHex: SEC_ID, branchId: 'LDP-001', deviceKeyVersion: 1 });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0][1]).toMatchObject({ serverReceiptBase64: 'receipt-1', oks1Base64: 'oks1-1' });
      expect(serverComplete).not.toHaveBeenCalled();
      expect(loadCompletionIntent()).toBeNull();
      expect(loadPendingFinalization()).toBeNull();
    });

    it('N4-C: no completion intent -> verified commit clears the finalize context and succeeds (unchanged)', async () => {
      const res = await finalizeDeviceEnrollmentRetry(ctxFor(), nativeReturning('COMMITTED'));
      expect(res.ok).toBe(true);
      expect(loadPendingFinalization()).toBeNull();
    });

    it('N4-D: same-generation intent removed and read back absent -> both cleared, success', async () => {
      saveCompletionIntent(validIntent());
      const res = await finalizeDeviceEnrollmentRetry(ctxFor(), nativeReturning('COMMITTED'));
      expect(res.ok).toBe(true);
      expect(loadCompletionIntent()).toBeNull();
      expect(loadPendingFinalization()).toBeNull();
    });

    it('N4-E: a different-generation intent after a verified commit fails closed; neither record cleared; no server call', async () => {
      saveCompletionIntent({ ...validIntent(), enrollmentGenerationId: 'ab'.repeat(16) });
      const invoke = nativeReturning('COMMITTED');
      const res = await finalizeDeviceEnrollmentRetry(ctxFor(), invoke);
      expect(res).toMatchObject({
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'completion_intent_generation_conflict',
        retryContext: ctxFor(),
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(loadPendingFinalization()).toEqual(ctxFor());
      expect(loadCompletionIntent()?.enrollmentGenerationId).toBe('ab'.repeat(16));
      expect(loadEnrollmentRecoveryState().kind).toBe('conflict');
    });

    it('N4-F: removeItem returns normally but the intent is still present -> read-back catches it; context retained, no success', async () => {
      saveCompletionIntent(validIntent());
      const restoreRemoval = breakIntentRemoval('silent');
      let res;
      try {
        res = await finalizeDeviceEnrollmentRetry(ctxFor(), nativeReturning('COMMITTED'));
      } finally {
        restoreRemoval();
      }
      expect(res).toMatchObject({ ok: false, errorDetail: 'completion_intent_cleanup_failed' });
      expect(loadPendingFinalization()).toEqual(ctxFor());
      expect(loadCompletionIntent()).toEqual(validIntent());
    });

    // --- N4 strict absence: only a raw-null getItem proves the intent absent ---

    /**
     * Storage seam for the intent key only: counts reads, can make the Nth and
     * later reads throw, and can make removal leave malformed bytes behind.
     * Records the order of intent reads/removals and finalize-context removal.
     */
    function intentStorageSeam(opts: { throwReadsFrom?: number; removalLeaves?: string } = {}) {
      const events: string[] = [];
      let intentReads = 0;
      const realGet = localStorage.getItem;
      const realRemove = localStorage.removeItem;
      const realSet = localStorage.setItem;
      localStorage.getItem = (k: string) => {
        if (k === PENDING_COMPLETION_INTENT_STORAGE_KEY) {
          intentReads += 1;
          events.push(`read:intent#${intentReads}`);
          if (opts.throwReadsFrom !== undefined && intentReads >= opts.throwReadsFrom) throw new Error('SecurityError');
        }
        return realGet(k);
      };
      localStorage.removeItem = (k: string) => {
        events.push(`remove:${k === PENDING_COMPLETION_INTENT_STORAGE_KEY ? 'intent' : k === PENDING_FINALIZATION_STORAGE_KEY ? 'ctx' : k}`);
        if (k === PENDING_COMPLETION_INTENT_STORAGE_KEY && opts.removalLeaves !== undefined) {
          realSet(k, opts.removalLeaves);
          return;
        }
        realRemove(k);
      };
      return {
        events,
        restore: () => {
          localStorage.getItem = realGet;
          localStorage.removeItem = realRemove;
        },
      };
    }

    async function finalizeWithSeam(seamOpts: Parameters<typeof intentStorageSeam>[0]) {
      const invoke = nativeReturning('COMMITTED');
      const serverComplete = vi.fn();
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(ctxFor()));
      const seam = intentStorageSeam(seamOpts);
      try {
        const res = await finalizeDeviceEnrollmentRetry(ctxFor(), invoke);
        return { res, events: seam.events, invoke, serverComplete };
      } finally {
        seam.restore();
      }
    }

    it('N4-G: initial intent read failure after native COMMITTED -> not success, same context retained, no server call', async () => {
      const { res, invoke, serverComplete } = await finalizeWithSeam({ throwReadsFrom: 1 });
      expect(res).toEqual({
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'completion_intent_read_failed',
        retryContext: ctxFor(),
      });
      expect(invoke).toHaveBeenCalledTimes(1); // native committed; nothing else
      expect(serverComplete).not.toHaveBeenCalled();
      expect(loadPendingFinalization()).toEqual(ctxFor());
    });

    it.each([
      ['malformed JSON', '{"schema":"twinpet.pendingCompletionIntent",'],
      ['schema-invalid record', JSON.stringify({ ...validIntent(), version: 2 })],
    ])('N4-H: initial %s -> not success, context retained, raw bytes NOT auto-deleted', async (_label, raw) => {
      localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, raw);
      // The tolerant convenience loader reports "no intent" for these bytes...
      expect(loadCompletionIntent()).toBeNull();
      // ...but the finalization authority gate must not treat them as absence.
      const { res, serverComplete } = await finalizeWithSeam({});
      expect(res).toMatchObject({
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'completion_intent_malformed',
        retryContext: ctxFor(),
      });
      expect(loadPendingFinalization()).toEqual(ctxFor());
      expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).toBe(raw);
      expect(serverComplete).not.toHaveBeenCalled();
    });

    it('N4-I: valid same-generation intent, removal attempted, post-removal read fails -> not success, context retained', async () => {
      saveCompletionIntent(validIntent());
      const { res, events } = await finalizeWithSeam({ throwReadsFrom: 2 });
      expect(res).toMatchObject({ ok: false, errorDetail: 'completion_intent_read_failed', retryContext: ctxFor() });
      expect(events).toEqual(['read:intent#1', 'remove:intent', 'read:intent#2']);
      expect(loadPendingFinalization()).toEqual(ctxFor());
    });

    it('N4-J: removal leaves malformed bytes behind -> strict post-read PRESENT_MALFORMED -> not success, context retained', async () => {
      saveCompletionIntent(validIntent());
      const { res } = await finalizeWithSeam({ removalLeaves: '{"truncated' });
      expect(res).toMatchObject({ ok: false, errorDetail: 'completion_intent_malformed', retryContext: ctxFor() });
      expect(loadPendingFinalization()).toEqual(ctxFor());
      expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).toBe('{"truncated');
    });

    it('N4-K: raw key proven absent (getItem -> null) -> context cleared, success', async () => {
      const { res, events } = await finalizeWithSeam({});
      expect(res).toEqual({ ok: true, securityDeviceIdHex: SEC_ID, branchId: 'LDP-001', deviceKeyVersion: 1 });
      expect(events).toEqual(['read:intent#1', 'remove:ctx']);
      expect(loadPendingFinalization()).toBeNull();
    });

    it('N4-L: same-generation removal, strict post-read null, THEN context clear, success', async () => {
      saveCompletionIntent(validIntent());
      const { res, events } = await finalizeWithSeam({});
      expect(res.ok).toBe(true);
      expect(events).toEqual(['read:intent#1', 'remove:intent', 'read:intent#2', 'remove:ctx']);
      expect(loadCompletionIntent()).toBeNull();
      expect(loadPendingFinalization()).toBeNull();
    });

    it('a thrown first complete preserves the intent exactly', async () => {
      const h = harness({
        complete: async () => {
          throw new Error('deadline-exceeded');
        },
      });
      try {
        await expect(registerDevice('auth-1', h.options)).rejects.toThrow('deadline-exceeded');
      } finally {
        h.restore();
      }
      expect(loadCompletionIntent()).toEqual(validIntent());
      expect(h.invoke).not.toHaveBeenCalledWith('native_finalize_device_enrollment', expect.anything());
    });

    it('explicit recovery replays the exact saved request once: no begin, no proof, no ENR1 import', async () => {
      saveCompletionIntent(validIntent());
      const h = harness();
      let res;
      try {
        res = await recoverDeviceRegistrationCompletion(h.options);
      } finally {
        h.restore();
      }
      expect(res).toEqual({ ok: true, securityDeviceIdHex: SEC_ID, branchId: 'LDP-001', deviceKeyVersion: 1 });
      expect(h.complete).toHaveBeenCalledTimes(1);
      expect(h.complete).toHaveBeenCalledWith({
        registrationSessionId: SESSION,
        drp1Base64: dummyDrp1Base64,
        enrollmentGenerationId: GEN,
      });
      expect(h.begin).toHaveBeenCalledTimes(0);
      expect(h.invoke).not.toHaveBeenCalledWith('native_generate_device_registration_proof', expect.anything());
      expect(h.invoke).not.toHaveBeenCalledWith('native_import_device_enrollment_file');
      expect(h.invoke.mock.calls.map(([c]) => c)).toEqual(['native_finalize_device_enrollment']);
      expect(loadCompletionIntent()).toBeNull();
      expect(loadPendingFinalization()).toBeNull();
    });

    it('no automatic retry: a server rejection or transport failure calls complete once and keeps the intent', async () => {
      saveCompletionIntent(validIntent());
      const rejecting = harness({ complete: async () => ({ data: { ok: false, code: 'completion_replay_mismatch' } }) });
      try {
        expect(await recoverDeviceRegistrationCompletion(rejecting.options)).toEqual({
          ok: false,
          code: 'completion_replay_mismatch',
        });
      } finally {
        rejecting.restore();
      }
      expect(rejecting.complete).toHaveBeenCalledTimes(1);
      expect(loadCompletionIntent()).toEqual(validIntent());

      const failing = harness({
        complete: async () => {
          throw new Error('unavailable');
        },
      });
      try {
        expect(await recoverDeviceRegistrationCompletion(failing.options)).toMatchObject({
          ok: false,
          code: 'completion_transport_failed',
        });
      } finally {
        failing.restore();
      }
      expect(failing.complete).toHaveBeenCalledTimes(1);
      expect(loadCompletionIntent()).toEqual(validIntent());
    });

    it('precedence: a same-generation finalize context wins; a different-generation pair fails closed', async () => {
      expect(await recoverDeviceRegistrationCompletion(harness().options)).toEqual({ ok: false, code: 'no_completion_intent' });

      saveCompletionIntent(validIntent());
      const ctx: FinalizeRetryContext = {
        enrollmentGenerationId: GEN,
        securityDeviceIdHex: SEC_ID,
        branchId: 'LDP-001',
        deviceKeyVersion: 1,
        acceptedPublicKeyBase64: expectedPubKeyBase64,
        serverFinalizationReceiptBase64: 'receipt-1',
        expectedOperationKind: 'INITIAL_ENROLLMENT',
      };
      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(ctx));
      expect(loadEnrollmentRecoveryState()).toEqual({ kind: 'finalization_pending', context: ctx });

      localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify({ ...ctx, enrollmentGenerationId: 'ab'.repeat(16) }));
      expect(loadEnrollmentRecoveryState()).toEqual({ kind: 'conflict' });
      const h = harness();
      try {
        expect(await recoverDeviceRegistrationCompletion(h.options)).toEqual({ ok: false, code: 'recovery_state_conflict' });
      } finally {
        h.restore();
      }
      expect(h.complete).toHaveBeenCalledTimes(0);
      // Neither record is auto-deleted.
      expect(loadCompletionIntent()).not.toBeNull();
      expect(loadPendingFinalization()).not.toBeNull();
    });

    it('cross-layer seam: commit + lost response -> module restart -> explicit recovery reaches local finalize once', async () => {
      // Server seam: the first complete COMMITS (3 durable writes) and the
      // response is lost; a replay of the exact request performs 0 writes and
      // returns freshly recomputed material (proven for the real server in
      // functions/src/__tests__/deviceEnrollment.test.ts, and the native
      // fresh-runtime acceptance in src-tauri privileged_auth command_glue_tests).
      const server = { writes: 0, completeCalls: 0, begins: 0, requests: [] as unknown[] };
      const serverComplete = async (req: unknown): Promise<{ data: unknown }> => {
        server.completeCalls += 1;
        server.requests.push(req);
        if (server.completeCalls === 1) {
          server.writes += 3;
          throw new Error('response lost after commit');
        }
        return serverOk('receipt-recomputed');
      };
      const firstRun = harness({ complete: serverComplete });
      try {
        await expect(registerDevice('auth-1', firstRun.options)).rejects.toThrow('response lost after commit');
      } finally {
        firstRun.restore();
      }
      server.begins = firstRun.begin.mock.calls.length;

      // App restart: fresh module instance, durable storage only.
      vi.resetModules();
      const restarted = await import('./deviceRegistration');
      const loaded = restarted.loadCompletionIntent();
      expect(loaded).toEqual(validIntent());

      const secondRun = harness({ complete: serverComplete });
      let recovered;
      try {
        recovered = await restarted.recoverDeviceRegistrationCompletion(secondRun.options);
      } finally {
        secondRun.restore();
      }

      expect(recovered).toEqual({ ok: true, securityDeviceIdHex: SEC_ID, branchId: 'LDP-001', deviceKeyVersion: 1 });
      expect(server.completeCalls).toBe(2);
      expect(server.requests[1]).toEqual(server.requests[0]); // exact same request replayed
      expect(server.writes).toBe(3); // replay added zero writes
      expect(server.begins).toBe(1); // no second beginDeviceRegistration
      expect(secondRun.begin).toHaveBeenCalledTimes(0);
      const nativeCalls = [...firstRun.invoke.mock.calls, ...secondRun.invoke.mock.calls].map(([c]) => c);
      expect(nativeCalls.filter((c) => c === 'native_generate_device_registration_proof')).toHaveLength(1);
      expect(nativeCalls).not.toContain('native_import_device_enrollment_file');
      // The same staged generation reaches the local finalize path with the fresh receipt.
      expect(secondRun.invoke).toHaveBeenCalledWith(
        'native_finalize_device_enrollment',
        expect.objectContaining({
          enrollmentGenerationId: GEN,
          deviceKeyVersion: 1,
          serverReceiptBase64: 'receipt-recomputed',
          expectedOperationKind: 'INITIAL_ENROLLMENT',
        }),
      );
      expect(restarted.loadCompletionIntent()).toBeNull();
      expect(restarted.loadPendingFinalization()).toBeNull();
    });
  });
});
