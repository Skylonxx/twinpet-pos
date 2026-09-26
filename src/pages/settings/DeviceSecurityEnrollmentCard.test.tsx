// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeviceSecurityEnrollmentCard from './DeviceSecurityEnrollmentCard';
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
  render(<DeviceSecurityEnrollmentCard branchId={branchId} />);
  fireEvent.click(await screen.findByRole('button', { name: PICK }));
  return screen.findByRole('button', { name: CONFIRM });
}

beforeEach(() => {
  mockLoadPending.mockReturnValue(null);
  mockLoadIntent.mockReturnValue(null);
  mockRecoveryState.mockImplementation(recoveryStateFromMocks);
});

afterEach(() => {
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
    expect(screen.getByText(/ใช้ได้เฉพาะในแอป Twinpet POS/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('2. native, unenrolled, no pending: initial enrollment action is available', async () => {
    const invoke = installNative({ deviceKeyPresent: [false] });
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: PICK }));
    expect(await screen.findByText(/ไฟล์ลงทะเบียนไม่ถูกต้อง/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: CONFIRM })).toBeNull();
  });

  it('3c. never renders raw native import error text', async () => {
    installNative({ deviceKeyPresent: [false], importError: 'cannot read enrollment file: C:\\secret\\path.enr1' });
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    expect(mockRegister).toHaveBeenCalledWith(AUTH_ID);
  });

  it('5. confirm: calls registerDevice exactly once with the exact enrollmentAuthId', async () => {
    installNative({ deviceKeyPresent: [false, true] });
    mockRegister.mockResolvedValue(OK_RESULT);
    const confirm = await pickFile();
    expect(screen.queryByText(/ไม่ตรงกับสาขาปัจจุบัน/)).toBeNull();
    fireEvent.click(confirm);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister.mock.calls[0]).toEqual([AUTH_ID]);
  });

  it('6. double-click while busy does not duplicate the picker or the registration', async () => {
    const invoke = installNative({ deviceKeyPresent: [false, true] });
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
    fireEvent.click(await screen.findByRole('button', { name: RECOVER }));
    expect(await screen.findByText(/ยืนยันในเครื่องยังไม่สำเร็จ \(รหัส: LOCAL_ENROLLMENT_FINALIZATION_REQUIRED\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: RECOVER })).toBeTruthy();
    expect(screen.queryByRole('button', { name: PICK })).toBeNull();
    expect(document.body.textContent).not.toContain('raw');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('12. already enrolled: no initial enrollment action and no re-enroll action', async () => {
    const invoke = installNative({ deviceKeyPresent: [true] });
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
    expect(await screen.findByText('เครื่องนี้ลงทะเบียนความปลอดภัยแล้ว')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith('native_import_device_enrollment_file');
  });

  it('12b. status read failure fails closed: no enrollment action', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('status unavailable');
    });
    mockGetInvoke.mockReturnValue(invoke);
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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
    render(<DeviceSecurityEnrollmentCard branchId="branch-1" />);
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

  it('13. integration keeps Claim Existing Device separate (source contract)', () => {
    const settings = readFileSync(resolve(process.cwd(), 'src/pages/SettingsPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(settings).toContain(
      '<PosDevicesSettings branchId={branchId} userId={user?.id ?? null} onToast={showToast} />\n' +
        '              <DeviceSecurityEnrollmentCard branchId={branchId} />',
    );
    const card = readFileSync(resolve(process.cwd(), 'src/pages/settings/DeviceSecurityEnrollmentCard.tsx'), 'utf8');
    const imports = card.match(/from '[^']+'/g) ?? [];
    expect(imports).toEqual(["from 'react'", "from '../../components/ui'", "from '../../lib/auth/deviceRegistration'"]);
    expect(card).not.toMatch(/claimDevice|registerThisDevice|reEnrollDevice|deviceKeyVersion|console\./);
  });
});
