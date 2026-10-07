// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from './LoginPage';
import { useAuth } from '../lib/hooks/useAuth';
import { useActiveBranches } from '../lib/branches';
import {
  finalizeDeviceEnrollmentRetry,
  loadEnrollmentRecoveryState,
  recoverDeviceRegistrationCompletion,
  registerDevice,
  type EnrollmentRecoveryState,
  type FinalizeRetryContext,
  type PendingCompletionIntentV1,
} from '../lib/auth/deviceRegistration';
import { DeviceNotReadyError, type NativeDeviceReadiness } from '../lib/auth/nativeDeviceReadiness';
import { PinIdentityError } from '../lib/auth/pinIdentityError';
import type { EnrollmentPreparationGrant } from '../lib/auth/enrollmentGrant';

/**
 * TPOS-R7 pre-login bootstrap: LoginPage (a GuestRoute page, outside
 * ProtectedRoute) is the enrollment / recovery surface while the AuthProvider
 * device gate is not READY. Only strong READY dismisses it; a fresh ceremony
 * is offered only for a clean NOT_ENROLLED device; device failures are never
 * rendered as "PIN incorrect".
 */

vi.mock('../lib/hooks/useAuth');
vi.mock('../lib/branches');
// Keep the real Tauri bridge detection; stub only the ceremony + durable recovery reads.
vi.mock('../lib/auth/deviceRegistration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/auth/deviceRegistration')>()),
  loadEnrollmentRecoveryState: vi.fn(),
  registerDevice: vi.fn(),
  recoverDeviceRegistrationCompletion: vi.fn(),
  finalizeDeviceEnrollmentRetry: vi.fn(),
}));

const mockRecoveryState = vi.mocked(loadEnrollmentRecoveryState);
const mockRegister = vi.mocked(registerDevice);
const mockRecover = vi.mocked(recoverDeviceRegistrationCompletion);
const mockFinalize = vi.mocked(finalizeDeviceEnrollmentRetry);

const TAURI_KEY = '__TAURI__';
const BOOTSTRAP = 'login-device-bootstrap';
const FRESH_BLOCKED = 'device-enrollment-fresh-blocked';
const PICK = 'เลือกไฟล์ลงทะเบียน';
const CONFIRM = 'ยืนยันลงทะเบียนเครื่องนี้';
const RECHECK = 'ตรวจสอบสถานะเครื่องอีกครั้ง';
const RECOVER = 'กู้คืนการลงทะเบียน';
const FINALIZE = 'ยืนยันในเครื่องให้เสร็จ';
const PIN_INVALID_LABEL = 'PIN ไม่ถูกต้อง กรุณาลองใหม่';
const AUTH_ID = '0123456789abcdef0123456789abcdef';

const PENDING_CTX: FinalizeRetryContext = {
  enrollmentGenerationId: 'ab'.repeat(16),
  securityDeviceIdHex: 'cd'.repeat(16),
  branchId: 'LDP-001',
  deviceKeyVersion: 1,
  acceptedPublicKeyBase64: 'cHVia2V5',
  serverFinalizationReceiptBase64: 'cmVjZWlwdA==',
  expectedOperationKind: 'INITIAL_ENROLLMENT',
};
const INTENT = { enrollmentGenerationId: 'ef'.repeat(16) } as PendingCompletionIntentV1;

let loginWithPinMock: ReturnType<typeof vi.fn>;
let loginWithUsernameMock: ReturnType<typeof vi.fn>;
let completeLoginMock: ReturnType<typeof vi.fn>;
let refreshSpy: Mock<() => void>;
let prepareSpy: Mock<() => Promise<EnrollmentPreparationGrant>>;
const GRANT = Object.freeze({}) as unknown as EnrollmentPreparationGrant;
/** What the (stateful) mocked AuthProvider gate holds initially / after a refresh. */
let initialReadiness: NativeDeviceReadiness;
let readinessOnRefresh: NativeDeviceReadiness;
let deviceKeyPresent: boolean;

function installTauri() {
  const invoke = vi.fn(async (cmd: string) => {
    // Weak display-only status used by the card; never a gate decision.
    if (cmd === 'native_get_device_registration_status') {
      return { securityDeviceIdHex: null, deviceKeyPresent, storedOacCount: 0 };
    }
    if (cmd === 'native_import_device_enrollment_file') {
      return {
        enrollmentAuthId: AUTH_ID,
        branchId: 'LDP-001',
        issuerId: 'hq-console-01',
        issuedAtServerMs: 1_790_000_000_000,
        expiresAtServerMs: 1_790_001_800_000,
      };
    }
    throw new Error(`unexpected native command ${cmd}`);
  });
  (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
  return invoke;
}

function setRecovery(state: EnrollmentRecoveryState) {
  mockRecoveryState.mockReturnValue(state);
}

async function enterPin() {
  fireEvent.change(screen.getByLabelText('Username', { selector: '#inp-pin-user' }), { target: { value: 'admin' } });
  for (const d of ['1', '2', '3', '4']) fireEvent.click(screen.getByText(d));
}

beforeEach(() => {
  // TPOS-R7 0.1.6 confirm-time ENR1 expiry gate: the imported fixture below is
  // confirmed one minute after issuance (29 minutes of validity left).
  vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000 + 60_000);
  initialReadiness = 'NOT_ENROLLED';
  readinessOnRefresh = 'NOT_ENROLLED';
  deviceKeyPresent = false;
  setRecovery({ kind: 'none' });
  mockRegister.mockReset();
  mockRecover.mockReset();
  mockFinalize.mockReset();
  loginWithPinMock = vi.fn();
  loginWithUsernameMock = vi.fn();
  completeLoginMock = vi.fn();
  refreshSpy = vi.fn();
  prepareSpy = vi.fn(async () => GRANT);
  vi.mocked(useAuth).mockImplementation(() => {
    const [deviceReadiness, setDeviceReadiness] = useState<NativeDeviceReadiness>(initialReadiness);
    return {
      loginWithPin: loginWithPinMock,
      loginWithUsername: loginWithUsernameMock,
      completeLogin: completeLoginMock,
      isAuthenticated: false,
      isLoading: false,
      user: null,
      branchId: null,
      setBranchId: vi.fn(),
      logout: vi.fn(),
      session: null,
      firebaseUser: null,
      prepareEnrollmentIdentity: prepareSpy,
      deviceReadiness,
      refreshDeviceReadiness: async () => {
        refreshSpy();
        setDeviceReadiness(readinessOnRefresh);
        return readinessOnRefresh;
      },
    } as never;
  });
  vi.mocked(useActiveBranches).mockReturnValue({
    branches: [{ id: 'LDP-001', name: 'หนองสังข์', isActive: true }] as never,
    loading: false,
    error: null,
    reload: vi.fn(),
    getLabel: vi.fn((id: string) => id),
  });
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)[TAURI_KEY];
  vi.restoreAllMocks();
});

describe('LoginPage — pre-login device enrollment bootstrap (TPOS-R7)', () => {
  it('native NOT_ENROLLED: enrollment card offered on the login screen; gate applies to both login modes', async () => {
    installTauri();
    render(<LoginPage />);

    const panel = await screen.findByTestId(BOOTSTRAP);
    expect(panel.textContent).toContain('ยังไม่ได้ลงทะเบียน');
    expect(panel.textContent).toContain('Quick PIN และ Username');
    expect(await screen.findByRole('button', { name: PICK })).toBeDefined();
  });

  it('native READY: no bootstrap panel, normal PIN login available', async () => {
    initialReadiness = 'READY';
    installTauri();
    render(<LoginPage />);

    expect(screen.queryByTestId(BOOTSTRAP)).toBeNull();
    expect(screen.getByRole('button', { name: 'ยืนยัน PIN' })).toBeDefined();
  });

  it('web (not_native): no bootstrap UI', () => {
    initialReadiness = 'not_native';
    render(<LoginPage />);

    expect(screen.queryByTestId(BOOTSTRAP)).toBeNull();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
  });

  it.each(['INVALID_OR_INCOMPLETE', 'UNAVAILABLE'] as const)(
    'native %s: fails closed — safe support message, NO fresh enrollment, explicit re-check only',
    async (readiness) => {
      initialReadiness = readiness;
      readinessOnRefresh = readiness;
      installTauri();
      render(<LoginPage />);

      const panel = await screen.findByTestId(BOOTSTRAP);
      expect(panel.textContent).toContain('ยังเข้าสู่ระบบไม่ได้');
      expect(await screen.findByTestId(FRESH_BLOCKED)).toBeDefined();
      expect(screen.queryByRole('button', { name: PICK })).toBeNull();
      expect(mockRegister).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: RECHECK }));
      await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    },
  );

  it('weak key presence alone never dismisses the bootstrap (no onEnrolled from status)', async () => {
    deviceKeyPresent = true;
    installTauri();
    render(<LoginPage />);

    await screen.findByTestId(BOOTSTRAP);
    await new Promise((r) => setTimeout(r, 50));
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId(BOOTSTRAP)).toBeDefined();
  });

  it('successful finalize + strong READY: bootstrap dismissed without restarting the app', async () => {
    readinessOnRefresh = 'READY';
    installTauri();
    mockRegister.mockImplementation(async () => {
      deviceKeyPresent = true;
      return { ok: true, securityDeviceIdHex: 'cd'.repeat(16), branchId: 'LDP-001', deviceKeyVersion: 1 };
    });
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole('button', { name: PICK }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));

    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith(AUTH_ID, { enrollmentGrant: GRANT }),
    );
    expect(mockRegister.mock.calls[0]![1]!.enrollmentGrant).toBe(GRANT);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId(BOOTSTRAP)).toBeNull());
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(loginWithPinMock).not.toHaveBeenCalled();
  });

  it('successful finalize but strong readiness NOT READY: stays blocked with a safe device-security error', async () => {
    readinessOnRefresh = 'INVALID_OR_INCOMPLETE';
    installTauri();
    mockRegister.mockImplementation(async () => {
      deviceKeyPresent = true;
      return { ok: true, securityDeviceIdHex: 'cd'.repeat(16), branchId: 'LDP-001', deviceKeyVersion: 1 };
    });
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole('button', { name: PICK }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));

    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/ข้อมูลความปลอดภัยในเครื่องยังไม่สมบูรณ์/)).toBeDefined();
    expect(screen.getByTestId(BOOTSTRAP)).toBeDefined();
    expect(await screen.findByTestId(FRESH_BLOCKED)).toBeDefined();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
  });

  it('failed registration: no readiness refresh, bootstrap stays', async () => {
    installTauri();
    mockRegister.mockResolvedValue({ ok: false, code: 'ENROLLMENT_AUTH_EXPIRED' } as never);
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole('button', { name: PICK }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));

    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId(BOOTSTRAP)).toBeDefined();
  });

  it.each(['NOT_ENROLLED', 'INVALID_OR_INCOMPLETE'] as const)(
    'completion_pending (%s): offers only explicit recovery — no auto-retry, no fresh enrollment',
    async (readiness) => {
      initialReadiness = readiness;
      installTauri();
      setRecovery({ kind: 'completion_pending', intent: INTENT });
      render(<LoginPage />);

      expect(await screen.findByRole('button', { name: RECOVER })).toBeDefined();
      expect(screen.queryByRole('button', { name: PICK })).toBeNull();
      expect(mockRecover).not.toHaveBeenCalled();
      expect(mockRegister).not.toHaveBeenCalled();
    },
  );

  it.each(['NOT_ENROLLED', 'INVALID_OR_INCOMPLETE'] as const)(
    'finalization_pending (%s): offers only the local-only finalize — not auto-run, no fresh enrollment',
    async (readiness) => {
      initialReadiness = readiness;
      installTauri();
      setRecovery({ kind: 'finalization_pending', context: PENDING_CTX });
      render(<LoginPage />);

      expect(await screen.findByRole('button', { name: FINALIZE })).toBeDefined();
      expect(screen.queryByRole('button', { name: PICK })).toBeNull();
      expect(mockFinalize).not.toHaveBeenCalled();
      expect(mockRegister).not.toHaveBeenCalled();
    },
  );

  it('explicit local finalize success is still gated on strong READY', async () => {
    initialReadiness = 'INVALID_OR_INCOMPLETE';
    readinessOnRefresh = 'READY';
    installTauri();
    setRecovery({ kind: 'finalization_pending', context: PENDING_CTX });
    mockFinalize.mockImplementation(async () => {
      setRecovery({ kind: 'none' });
      return { ok: true } as never;
    });
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole('button', { name: FINALIZE }));

    await waitFor(() => expect(mockFinalize).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId(BOOTSTRAP)).toBeNull());
  });

  it('conflict: fails closed with no enrollment or recovery action', async () => {
    installTauri();
    setRecovery({ kind: 'conflict' });
    render(<LoginPage />);

    const panel = await screen.findByTestId(BOOTSTRAP);
    await waitFor(() => expect(panel.textContent).toContain('ไม่ตรงกัน'));
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    expect(screen.queryByRole('button', { name: RECOVER })).toBeNull();
    expect(screen.queryByRole('button', { name: FINALIZE })).toBeNull();
  });
});

describe('LoginPage — device errors are not rendered as PIN/password-invalid (TPOS-R7)', () => {
  it.each([
    'DEVICE_NOT_ENROLLED',
    'DEVICE_ENROLLMENT_INVALID',
    'DEVICE_STATUS_UNAVAILABLE',
    'DEVICE_SESSION_PREPARATION_FAILED',
    'DEVICE_SESSION_ISSUANCE_FAILED',
    'DEVICE_SESSION_PERSIST_FAILED',
  ] as const)('Quick PIN %s: fixed device message shown, PinPad "PIN incorrect" NOT shown', async (code) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initialReadiness = 'READY';
    loginWithPinMock.mockRejectedValue(new DeviceNotReadyError(code));
    render(<LoginPage />);

    await enterPin();

    expect(await screen.findByText(new DeviceNotReadyError(code).message, {}, { timeout: 3000 })).toBeDefined();
    expect(screen.queryByText(PIN_INVALID_LABEL)).toBeNull();
    expect(completeLoginMock).not.toHaveBeenCalled();
  });

  it.each([
    'PIN_IDENTITY_UNAVAILABLE',
    'PIN_IDENTITY_TRANSITION_BLOCKED',
    'PIN_IDENTITY_REJECTED',
  ] as const)('Quick PIN %s: fixed identity message shown, PinPad "PIN incorrect" NOT shown', async (code) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initialReadiness = 'READY';
    loginWithPinMock.mockRejectedValue(new PinIdentityError(code));
    render(<LoginPage />);

    await enterPin();

    expect(await screen.findByText(new PinIdentityError(code).message, {}, { timeout: 3000 })).toBeDefined();
    expect(screen.queryByText(PIN_INVALID_LABEL)).toBeNull();
    expect(completeLoginMock).not.toHaveBeenCalled();
  });

  it('completeLogin device refusal after PIN success: device message, not PIN-invalid', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initialReadiness = 'READY';
    loginWithPinMock.mockResolvedValue({ id: 'staff-1', branchIds: ['LDP-001'], role: 'staff' });
    completeLoginMock.mockRejectedValue(new DeviceNotReadyError('DEVICE_NOT_ENROLLED'));
    render(<LoginPage />);

    await enterPin();

    expect(
      await screen.findByText(new DeviceNotReadyError('DEVICE_NOT_ENROLLED').message, {}, { timeout: 3000 }),
    ).toBeDefined();
    expect(screen.queryByText(PIN_INVALID_LABEL)).toBeNull();
  });

  it('Username/Password on a not-READY native device: fixed device message, no app session', async () => {
    installTauri();
    loginWithUsernameMock.mockRejectedValue(new DeviceNotReadyError('DEVICE_NOT_ENROLLED'));
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('tab', { name: /Username/ }));
    fireEvent.change(screen.getByLabelText('Username', { selector: '#inp-user' }), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /เข้าสู่ระบบ/ }));

    expect(await screen.findByText(new DeviceNotReadyError('DEVICE_NOT_ENROLLED').message)).toBeDefined();
    expect(completeLoginMock).not.toHaveBeenCalled();
  });

  it('control: a real PIN/branch denial still shows the PIN-invalid state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initialReadiness = 'READY';
    loginWithPinMock.mockRejectedValue(new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้'));
    render(<LoginPage />);

    await enterPin();

    expect(await screen.findByText(PIN_INVALID_LABEL, {}, { timeout: 3000 })).toBeDefined();
  });
});
