// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeviceSecurityEnrollmentCard from './DeviceSecurityEnrollmentCard';
import { EnrollmentIdentityError } from '../../lib/auth/enrollmentIdentityError';
import type { EnrollmentPreparationGrant } from '../../lib/auth/enrollmentGrant';
import {
  finalizeDeviceEnrollmentRetry,
  getNativeDeviceEnrollmentInvoke,
  loadCompletionIntent,
  loadEnrollmentRecoveryState,
  loadPendingFinalization,
  recoverDeviceRegistrationCompletion,
  registerDevice,
  type DeviceRegistrationResult,
  type FinalizeRetryContext,
  type PendingCompletionIntentV1,
} from '../../lib/auth/deviceRegistration';

vi.mock('../../lib/auth/deviceRegistration', () => ({
  ENROLLMENT_STAGING_ABANDON_FAILED: 'enrollment_staging_abandon_failed',
  getNativeDeviceEnrollmentInvoke: vi.fn(),
  loadPendingFinalization: vi.fn(),
  loadCompletionIntent: vi.fn(),
  loadEnrollmentRecoveryState: vi.fn(),
  recoverDeviceRegistrationCompletion: vi.fn(),
  registerDevice: vi.fn(),
  finalizeDeviceEnrollmentRetry: vi.fn(),
}));

const mockGetInvoke = vi.mocked(getNativeDeviceEnrollmentInvoke);
const mockLoadPending = vi.mocked(loadPendingFinalization);
const mockLoadIntent = vi.mocked(loadCompletionIntent);
const mockRecoveryState = vi.mocked(loadEnrollmentRecoveryState);
const mockRecover = vi.mocked(recoverDeviceRegistrationCompletion);
const mockRegister = vi.mocked(registerDevice);
const mockFinalize = vi.mocked(finalizeDeviceEnrollmentRetry);
/** Opaque grant double; the card must hand this exact object to registerDevice. */
const GRANT = Object.freeze({}) as unknown as EnrollmentPreparationGrant;
const mockPrepare = vi.fn(async () => GRANT);

/** Test double with the real precedence: finalize context > completion intent; different generations conflict. */
function recoveryStateFromMocks() {
  const context = mockLoadPending();
  const intent = mockLoadIntent();
  if (context) {
    return intent && intent.enrollmentGenerationId !== context.enrollmentGenerationId
      ? ({ kind: 'conflict' } as const)
      : ({ kind: 'finalization_pending', context } as const);
  }
  return intent ? ({ kind: 'completion_pending', intent } as const) : ({ kind: 'none' } as const);
}

const AUTH_ID = '0123456789abcdef0123456789abcdef';
const SAFE_DTO = {
  enrollmentAuthId: AUTH_ID,
  branchId: 'branch-1',
  issuerId: 'hq-console-01',
  issuedAtServerMs: 1_790_000_000_000,
  expiresAtServerMs: 1_790_001_800_000,
};
const PENDING_CTX: FinalizeRetryContext = {
  enrollmentGenerationId: 'ab'.repeat(16),
  securityDeviceIdHex: 'cd'.repeat(16),
  branchId: 'branch-1',
  deviceKeyVersion: 1,
  acceptedPublicKeyBase64: 'cHVia2V5',
  serverFinalizationReceiptBase64: 'cmVjZWlwdA==',
  expectedOperationKind: 'INITIAL_ENROLLMENT',
};
const OK_RESULT: DeviceRegistrationResult = {
  ok: true,
  securityDeviceIdHex: 'cd'.repeat(16),
  branchId: 'branch-1',
  deviceKeyVersion: 1,
};

const PICK = 'เลือกไฟล์ลงทะเบียน';
const CONFIRM = 'ยืนยันลงทะเบียนเครื่องนี้';
const RECOVER = 'ยืนยันในเครื่องให้เสร็จ';
const SUCCESS_TEXT = 'ลงทะเบียนความปลอดภัยของเครื่องนี้สำเร็จ';

type Responses = { deviceKeyPresent: boolean[]; importResult?: unknown; importError?: unknown };

function installNative(responses: Responses) {
  const statusQueue = [...responses.deviceKeyPresent];
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'native_get_device_registration_status') {
      const present = statusQueue.length > 1 ? statusQueue.shift()! : statusQueue[0]!;
      return { securityDeviceIdHex: null, deviceKeyPresent: present, storedOacCount: 0 };
    }
    if (cmd === 'native_import_device_enrollment_file') {
      if (responses.importError !== undefined) throw responses.importError;
      return responses.importResult ?? SAFE_DTO;
    }
    throw new Error(`unexpected native command ${cmd}`);
  });
  mockGetInvoke.mockReturnValue(invoke);
  return invoke;
}

const statusCalls = (invoke: ReturnType<typeof installNative>) =>
  invoke.mock.calls.filter(([cmd]) => cmd === 'native_get_device_registration_status').length;

async function pickFile(branchId: string | null = 'branch-1') {
  render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId={branchId} />);
  fireEvent.click(await screen.findByRole('button', { name: PICK }));
  return screen.findByRole('button', { name: CONFIRM });
}

/** Card clock for the confirm-time expiry gate: one minute after issuance (29 min of validity left). */
const NOW_COMFORTABLY_VALID = SAFE_DTO.issuedAtServerMs + 60_000;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW_COMFORTABLY_VALID);
  mockPrepare.mockReset().mockImplementation(async () => GRANT);
  mockLoadPending.mockReturnValue(null);
  mockLoadIntent.mockReturnValue(null);
  mockRecoveryState.mockImplementation(recoveryStateFromMocks);
});

afterEach(() => {
  nowSpy.mockRestore();
  cleanup();
  vi.clearAllMocks();
  mockGetInvoke.mockReset();
  mockLoadPending.mockReset();
  mockLoadIntent.mockReset();
  mockRecoveryState.mockReset();
  mockRecover.mockReset();
  mockRegister.mockReset();
  mockFinalize.mockReset();
});

describe('DeviceSecurityEnrollmentCard', () => {
  it('1. browser / non-native: shows unavailable state, no native call and no action', () => {
    mockGetInvoke.mockReturnValue(null);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    expect(screen.getByText(/ใช้ได้เฉพาะในแอป Twinpet POS/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('2. native, unenrolled, no pending: initial enrollment action is available', async () => {
    const invoke = installNative({ deviceKeyPresent: [false] });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    expect(await screen.findByRole('button', { name: PICK })).toBeTruthy();
    expect(statusCalls(invoke)).toBe(1);
    expect(invoke).not.toHaveBeenCalledWith('native_import_device_enrollment_file');
  });

  it('3. picker: uses the native picker and shows only the safe metadata', async () => {
    const invoke = installNative({ deviceKeyPresent: [false] });
    await pickFile();
    expect(invoke).toHaveBeenCalledWith('native_import_device_enrollment_file');
    expect(screen.getByText('branch-1')).toBeTruthy();
    expect(screen.getByText('hq-console-01')).toBeTruthy();
    expect(screen.queryByText(AUTH_ID)).toBeNull();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('3b. rejects a DTO whose enrollmentAuthId is not lowercase hex32', async () => {
    installNative({ deviceKeyPresent: [false], importResult: { ...SAFE_DTO, enrollmentAuthId: 'NOT-HEX' } });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: PICK }));
    expect(await screen.findByText(/ไฟล์ลงทะเบียนไม่ถูกต้อง/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: CONFIRM })).toBeNull();
  });

  it('3c. never renders raw native import error text', async () => {
    installNative({ deviceKeyPresent: [false], importError: 'cannot read enrollment file: C:\\secret\\path.enr1' });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: PICK }));
    expect(await screen.findByText(/ไฟล์ลงทะเบียนไม่ถูกต้องหรือหมดอายุ/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('secret');
  });

  it('4. branch mismatch: prominent warning, and registerDevice still receives only the enrollmentAuthId', async () => {
    installNative({ deviceKeyPresent: [false, true] });
    mockRegister.mockResolvedValue(OK_RESULT);
    const confirm = await pickFile('branch-2');
    expect(screen.getByText(/ไม่ตรงกับสาขาปัจจุบัน \(branch-2\)/)).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister).toHaveBeenCalledWith(AUTH_ID, { enrollmentGrant: GRANT });
    expect(mockRegister.mock.calls[0]![1]!.enrollmentGrant).toBe(GRANT);
  });

  it('5. confirm: calls registerDevice exactly once with the exact enrollmentAuthId', async () => {
    installNative({ deviceKeyPresent: [false, true] });
    mockRegister.mockResolvedValue(OK_RESULT);
    const confirm = await pickFile();
    expect(screen.queryByText(/ไม่ตรงกับสาขาปัจจุบัน/)).toBeNull();
    fireEvent.click(confirm);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister.mock.calls[0]).toEqual([AUTH_ID, { enrollmentGrant: GRANT }]);
    // The exact capability the preparation returned — never reconstructed.
    expect(mockRegister.mock.calls[0]![1]!.enrollmentGrant).toBe(GRANT);
  });

  it('6. double-click while busy does not duplicate the picker or the registration', async () => {
    const invoke = installNative({ deviceKeyPresent: [false, true] });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    const pick = await screen.findByRole('button', { name: PICK });
    fireEvent.click(pick);
    fireEvent.click(pick);
    const confirm = await screen.findByRole('button', { name: CONFIRM });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'native_import_device_enrollment_file')).toHaveLength(1);

    let resolveRegister!: (r: DeviceRegistrationResult) => void;
    mockRegister.mockReturnValue(new Promise((r) => (resolveRegister = r)));
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    resolveRegister(OK_RESULT);
    expect(await screen.findByText(SUCCESS_TEXT)).toBeTruthy();
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('7. final success: shows success and refreshes native status (enrolled, no further action)', async () => {
    const invoke = installNative({ deviceKeyPresent: [false, true] });
    mockRegister.mockResolvedValue(OK_RESULT);
    fireEvent.click(await pickFile());
    expect(await screen.findByText(SUCCESS_TEXT)).toBeTruthy();
    await waitFor(() => expect(statusCalls(invoke)).toBe(2));
    expect(await screen.findByText('ลงทะเบียนแล้ว')).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
  });

  it('8. LOCAL_ENROLLMENT_FINALIZATION_REQUIRED: no success, pending recovery shown, no second registerDevice', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadPending.mockReturnValueOnce(null).mockReturnValue(PENDING_CTX);
    mockRegister.mockResolvedValue({
      ok: false,
      code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
      errorDetail: 'native_finalize_failed: disk',
      retryContext: PENDING_CTX,
    });
    fireEvent.click(await pickFile());
    const recover = await screen.findByRole('button', { name: RECOVER });
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    expect(document.body.textContent).not.toContain('native_finalize_failed');

    mockFinalize.mockResolvedValue({ ok: false, code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED', retryContext: PENDING_CTX });
    fireEvent.click(recover);
    await waitFor(() => expect(mockFinalize).toHaveBeenCalledWith(PENDING_CTX));
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('8b. registerDevice transport exception: no success, surfaces failure, adopts a persisted pending context', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadPending.mockReturnValueOnce(null).mockReturnValue(PENDING_CTX);
    mockRegister.mockRejectedValue(new Error('internal'));
    fireEvent.click(await pickFile());
    expect(await screen.findByText(/ติดต่อเซิร์ฟเวอร์ไม่สำเร็จ/)).toBeTruthy();
    expect(screen.getByRole('button', { name: RECOVER })).toBeTruthy();
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('9. pending on mount: initial enrollment blocked; recovery uses finalizeDeviceEnrollmentRetry only', async () => {
    installNative({ deviceKeyPresent: [false, true] });
    mockLoadPending.mockReturnValue(PENDING_CTX);
    mockFinalize.mockResolvedValue(OK_RESULT);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    const recover = await screen.findByRole('button', { name: RECOVER });
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    fireEvent.click(recover);
    await waitFor(() => expect(mockFinalize).toHaveBeenCalledTimes(1));
    expect(mockFinalize).toHaveBeenCalledWith(PENDING_CTX);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('10. recovery success: shows success and refreshes status', async () => {
    const invoke = installNative({ deviceKeyPresent: [false, true] });
    mockLoadPending.mockReturnValueOnce(PENDING_CTX).mockReturnValue(null);
    mockFinalize.mockResolvedValue(OK_RESULT);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: RECOVER }));
    expect(await screen.findByText('ยืนยันการลงทะเบียนในเครื่องนี้สำเร็จ')).toBeTruthy();
    await waitFor(() => expect(statusCalls(invoke)).toBe(2));
    expect(await screen.findByText('ลงทะเบียนแล้ว')).toBeTruthy();
    expect(screen.queryByRole('button', { name: RECOVER })).toBeNull();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('11. recovery failure: remains blocked, typed error shown, no server enrollment', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadPending.mockReturnValue(PENDING_CTX);
    mockFinalize.mockResolvedValue({
      ok: false,
      code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
      errorDetail: 'native_finalize_failed: C:\\raw\\detail',
      retryContext: PENDING_CTX,
    });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: RECOVER }));
    expect(await screen.findByText(/ยืนยันในเครื่องยังไม่สำเร็จ \(รหัส: LOCAL_ENROLLMENT_FINALIZATION_REQUIRED\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: RECOVER })).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    expect(document.body.textContent).not.toContain('raw');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('12. already enrolled: no initial enrollment action and no re-enroll action', async () => {
    const invoke = installNative({ deviceKeyPresent: [true] });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    expect(await screen.findByText('เครื่องนี้ลงทะเบียนความปลอดภัยแล้ว')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith('native_import_device_enrollment_file');
  });

  it('12b. status read failure fails closed: no enrollment action', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('status unavailable');
    });
    mockGetInvoke.mockReturnValue(invoke);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    expect(await screen.findByText('ตรวจสอบสถานะความปลอดภัยของเครื่องไม่สำเร็จ')).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
  });

  // --- Completion-intent (lost response) recovery state -------------------

  const RECOVER_COMPLETION = 'กู้คืนการลงทะเบียน';
  const INTENT: PendingCompletionIntentV1 = {
    schema: 'twinpet.pendingCompletionIntent',
    version: 1,
    registrationSessionId: '5e55000000000000000000000000000e',
    drp1Base64: `RFJQMQ${'A'.repeat(242)}`,
    enrollmentGenerationId: 'ef'.repeat(16), // differs from PENDING_CTX ('ab'×16)
    stagedPublicKeyBase64: 'cHVia2V5cHVia2V5cHVia2V5cHVia2V5cHVia2V5cHU=',
  };

  it('14. a completion intent blocks the picker and exposes exactly one recovery action', async () => {
    const invoke = installNative({ deviceKeyPresent: [false] });
    mockLoadIntent.mockReturnValue(INTENT);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    expect(await screen.findByRole('button', { name: RECOVER_COMPLETION })).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    expect(screen.queryByRole('button', { name: RECOVER })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith('native_import_device_enrollment_file');
  });

  it('15. rapid recovery clicks invoke the helper once; no picker/begin/proof/register/re-enroll path', async () => {
    const invoke = installNative({ deviceKeyPresent: [false, true] });
    mockLoadIntent.mockReturnValueOnce(INTENT).mockReturnValue(null);
    let resolveRecover!: (r: DeviceRegistrationResult) => void;
    mockRecover.mockReturnValue(new Promise((r) => (resolveRecover = r)));
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    const button = await screen.findByRole('button', { name: RECOVER_COMPLETION });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    resolveRecover(OK_RESULT);
    expect(await screen.findByText('กู้คืนและลงทะเบียนความปลอดภัยของเครื่องนี้สำเร็จ')).toBeTruthy();
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([cmd]) => cmd).every((cmd) => cmd === 'native_get_device_registration_status')).toBe(true);
  });

  it('16. recovered full success refreshes native status and shows enrolled', async () => {
    const invoke = installNative({ deviceKeyPresent: [false, true] });
    mockLoadIntent.mockReturnValueOnce(INTENT).mockReturnValue(null);
    mockRecover.mockResolvedValue(OK_RESULT);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: RECOVER_COMPLETION }));
    expect(await screen.findByText('กู้คืนและลงทะเบียนความปลอดภัยของเครื่องนี้สำเร็จ')).toBeTruthy();
    await waitFor(() => expect(statusCalls(invoke)).toBe(2));
    expect(await screen.findByText('ลงทะเบียนแล้ว')).toBeTruthy();
    expect(screen.queryByRole('button', { name: RECOVER_COMPLETION })).toBeNull();
  });

  it('17. recovered but locally unfinalized -> transitions to the finalization-pending state', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadIntent.mockReturnValueOnce(INTENT).mockReturnValue(null);
    mockLoadPending.mockReturnValueOnce(null).mockReturnValue(PENDING_CTX);
    mockRecover.mockResolvedValue({ ok: false, code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED', retryContext: PENDING_CTX });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: RECOVER_COMPLETION }));
    expect(await screen.findByRole('button', { name: RECOVER })).toBeTruthy();
    expect(screen.queryByRole('button', { name: RECOVER_COMPLETION })).toBeNull();
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  it('18. recovery failure stays blocking with a typed code and no raw detail', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadIntent.mockReturnValue(INTENT);
    mockRecover.mockResolvedValue({ ok: false, code: 'completion_replay_mismatch', errorDetail: 'C:\\raw\\secret' });
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: RECOVER_COMPLETION }));
    expect(await screen.findByText(/กู้คืนการลงทะเบียนไม่สำเร็จ \(รหัส: completion_replay_mismatch\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: RECOVER_COMPLETION })).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    expect(document.body.textContent).not.toContain('secret');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('19. never renders the raw intent (DRP1, session id, generation, staged key)', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadIntent.mockReturnValue(INTENT);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    await screen.findByRole('button', { name: RECOVER_COMPLETION });
    const text = document.body.textContent ?? '';
    for (const value of [INTENT.drp1Base64, INTENT.registrationSessionId, INTENT.enrollmentGenerationId, INTENT.stagedPublicKeyBase64]) {
      expect(text).not.toContain(value);
    }
  });

  it('20. finalize context and intent for different generations fail closed with no action', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadPending.mockReturnValue(PENDING_CTX);
    mockLoadIntent.mockReturnValue(INTENT);
    render(<DeviceSecurityEnrollmentCard prepareEnrollmentIdentity={mockPrepare} branchId="branch-1" />);
    expect(await screen.findByText(/ข้อมูลการลงทะเบียนค้างที่ไม่ตรงกัน/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(mockRecover).not.toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('21. a transport failure on first enrollment moves the card to explicit completion recovery', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockLoadIntent.mockReturnValueOnce(null).mockReturnValue(INTENT);
    mockRegister.mockRejectedValue(new Error('deadline-exceeded'));
    fireEvent.click(await pickFile());
    expect(await screen.findByText(/ติดต่อเซิร์ฟเวอร์ไม่สำเร็จ/)).toBeTruthy();
    expect(screen.getByRole('button', { name: RECOVER_COMPLETION })).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('22. confirm: identity preparation runs once, strictly before registerDevice', async () => {
    installNative({ deviceKeyPresent: [false, true] });
    mockRegister.mockResolvedValue(OK_RESULT);
    fireEvent.click(await pickFile());
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockPrepare.mock.invocationCallOrder[0]).toBeLessThan(mockRegister.mock.invocationCallOrder[0]!);
  });

  it('23. picking a file has no identity side effect (preparation only on confirm)', async () => {
    installNative({ deviceKeyPresent: [false] });
    await pickFile();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it.each([
    ['ENROLLMENT_IDENTITY_UNAVAILABLE', /เตรียมเซสชันสำหรับลงทะเบียนเครื่องไม่สำเร็จ/],
    ['ENROLLMENT_IDENTITY_TRANSITION_BLOCKED', /มีข้อมูลการลงทะเบียนที่ค้างอยู่/],
  ] as const)('24. %s: no registerDevice, fixed identity message, never "invalid ENR1"', async (code, text) => {
    installNative({ deviceKeyPresent: [false] });
    mockPrepare.mockRejectedValue(new EnrollmentIdentityError(code));
    fireEvent.click(await pickFile());
    expect(await screen.findByText(text)).toBeTruthy();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(screen.queryByText(/ไฟล์ลงทะเบียนไม่ถูกต้อง/)).toBeNull();
  });

  it('25. a raw (non-identity) preparation error is never rendered', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockPrepare.mockRejectedValue(new Error('FirebaseError: auth/network-request-failed uid=nbwi47'));
    fireEvent.click(await pickFile());
    expect(await screen.findByText(/เตรียมเซสชันสำหรับลงทะเบียนเครื่องไม่สำเร็จ/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('FirebaseError');
    expect(document.body.textContent).not.toContain('nbwi47');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  // --- TPOS-R7 0.1.6: confirm-time ENR1 expiry gate (before ANY mutation) ---

  const EXPIRES = SAFE_DTO.expiresAtServerMs;
  const MARGIN = 5 * 60 * 1000;

  it.each([
    ['exactly at expiry', EXPIRES, /ไฟล์ลงทะเบียนหมดอายุแล้ว/],
    ['after expiry', EXPIRES + 1, /ไฟล์ลงทะเบียนหมดอายุแล้ว/],
    ['inside the safety margin', EXPIRES - MARGIN + 1, /ไฟล์ลงทะเบียนใกล้หมดอายุ/],
    ['one second before expiry', EXPIRES - 1_000, /ไฟล์ลงทะเบียนใกล้หมดอายุ/],
  ] as const)('26. confirm %s: no identity preparation, no registerDevice, file must be re-picked', async (_label, now, text) => {
    installNative({ deviceKeyPresent: [false] });
    const confirm = await pickFile();
    nowSpy.mockReturnValue(now);
    fireEvent.click(confirm);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText(/ยังไม่ได้เริ่มการลงทะเบียน|ระบบยังไม่เริ่มการลงทะเบียน/)).toBeTruthy();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: CONFIRM })).toBeNull();
    expect(screen.getByRole('button', { name: PICK })).toBeTruthy();
  });

  it('27. boundary: exactly the safety margin remaining is still allowed to start', async () => {
    installNative({ deviceKeyPresent: [false, true] });
    mockRegister.mockResolvedValue(OK_RESULT);
    const confirm = await pickFile();
    nowSpy.mockReturnValue(EXPIRES - MARGIN);
    fireEvent.click(confirm);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockPrepare).toHaveBeenCalledTimes(1);
  });

  it('28. a file picked while comfortably valid but confirmed after it became unsafe is refused at confirm', async () => {
    installNative({ deviceKeyPresent: [false] });
    // Picked with 29 minutes left (beforeEach clock) ...
    const confirm = await pickFile();
    expect(screen.getByText(/หมดอายุ/)).toBeTruthy();
    // ... confirmed 26 minutes later, with only 3 minutes left.
    nowSpy.mockReturnValue(NOW_COMFORTABLY_VALID + 26 * 60_000);
    fireEvent.click(confirm);
    expect(await screen.findByText(/ไฟล์ลงทะเบียนใกล้หมดอายุ/)).toBeTruthy();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  // --- TPOS-R7 0.1.6: definitive post-staging rejection messaging ---

  it('29. definitive rejection with the staged generation abandoned: failed, but safe to retry with a fresh ENR1', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockRegister.mockResolvedValue({ ok: false, code: 'enrollment_authorization_expired', stagingAbandoned: true });
    fireEvent.click(await pickFile());
    const notice = await screen.findByText(/ล้างข้อมูลการลงทะเบียนที่ค้างในเครื่องเรียบร้อยแล้ว/);
    expect(notice.textContent).toContain('enrollment_authorization_expired');
    expect(notice.textContent).toContain('ลงทะเบียนใหม่ได้ด้วยไฟล์ลงทะเบียนใหม่');
    expect(screen.queryByText(SUCCESS_TEXT)).toBeNull();
  });

  it('30. staged-generation abandon failure: fixed administrator-attention message that does not invite a retry', async () => {
    installNative({ deviceKeyPresent: [false] });
    mockRegister.mockResolvedValue({
      ok: false,
      code: 'enrollment_staging_abandon_failed',
      errorDetail: 'server_rejection: enrollment_authorization_expired',
    });
    fireEvent.click(await pickFile());
    const notice = await screen.findByText(/ต้องให้ผู้ดูแลระบบตรวจสอบ/);
    expect(notice.textContent).toContain('ห้ามลงทะเบียนซ้ำ');
    expect(notice.textContent).not.toContain('enrollment_authorization_expired');
    expect(notice.textContent).not.toContain('ลงทะเบียนใหม่ได้');
  });

  it('13. integration keeps Claim Existing Device separate (source contract)', () => {
    const settings = readFileSync(resolve(process.cwd(), 'src/pages/SettingsPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(settings).toContain(
      '<PosDevicesSettings branchId={branchId} userId={user?.id ?? null} onToast={showToast} />\n' +
        '              <DeviceSecurityEnrollmentCard branchId={branchId} prepareEnrollmentIdentity={prepareEnrollmentIdentity} />',
    );
    const card = readFileSync(resolve(process.cwd(), 'src/pages/settings/DeviceSecurityEnrollmentCard.tsx'), 'utf8');
    const imports = card.match(/from '[^']+'/g) ?? [];
    expect(imports).toEqual([
      "from 'react'",
      "from '../../components/ui'",
      "from '../../lib/auth/deviceRegistration'",
      // Type-only: the opaque grant the card passes through unchanged.
      "from '../../lib/auth/enrollmentGrant'",
      "from '../../lib/auth/enrollmentIdentityError'",
      // Pure confirm-time ENR1 expiry gate (no I/O).
      "from '../../lib/auth/enrollmentExpiry'",
    ]);
    expect(card).not.toMatch(/claimDevice|registerThisDevice|reEnrollDevice|deviceKeyVersion|console\./);
  });
});
