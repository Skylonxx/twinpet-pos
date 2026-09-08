// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApproverRosterState } from '../../lib/auth/useApproverRoster';
import type { PrivilegedVoidFlowState } from '../../lib/pos/privilegedVoid/privilegedVoidFlowMachine';
import type { UsePrivilegedVoidFlowResult } from '../../hooks/pos/usePrivilegedVoidFlow';
import PrivilegedVoidModal from './PrivilegedVoidModal';

afterEach(cleanup);

const IDENTITY = {
  localIntentId: 'intent-1',
  actionId: 'VOID_PENDING_SALE' as const,
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2026-09-07',
  targetBranchId: 'LDP-001',
  operatorStaffId: 'staff-1',
  managerStaffId: 'mgr-1',
};

const SAFE_ROW = {
  targetOrderId: 'order-1',
  classification: 'active_open' as const,
  syncStatus: 'PRIVILEGED_INTENT_QUEUED' as const,
  manualReviewStatus: 'NOT_REQUIRED' as const,
  serverVerdict: null,
  updatedAtMs: 1_000,
};

const RECORD_SUMMARY = {
  adjudicationId: 'a'.repeat(32),
  localIntentId: 'intent-1',
  actionId: 'VOID_PENDING_SALE' as const,
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2026-09-07',
  branchId: 'LDP-001',
  approvingManagerStaffId: 'mgr-1',
  syncStatus: 'PRIVILEGED_INTENT_QUEUED' as const,
  manualReviewStatus: 'NOT_REQUIRED' as const,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};

function readyRoster(over: Partial<ApproverRosterState> = {}): ApproverRosterState {
  return {
    status: 'ready',
    fromCache: false,
    candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
    ...over,
  };
}

export function makeFlow(state: PrivilegedVoidFlowState, over: Partial<UsePrivilegedVoidFlowResult> = {}): UsePrivilegedVoidFlowResult {
  return {
    state,
    roster: readyRoster(),
    isSubmitting: false,
    open: vi.fn(),
    submitReason: vi.fn(),
    chooseManager: vi.fn(),
    backToManagerSelect: vi.fn(),
    submitPin: vi.fn(),
    close: vi.fn(),
    retryReconciliation: vi.fn(),
    ...over,
  };
}

describe('PrivilegedVoidModal', () => {
  it('renders nothing while IDLE', () => {
    const { container } = render(<PrivilegedVoidModal flow={makeFlow({ status: 'IDLE' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('PRECHECK shows a loading indicator, no editable manager-id input anywhere', () => {
    render(<PrivilegedVoidModal flow={makeFlow({ status: 'PRECHECK', identity: IDENTITY })} />);
    expect(screen.getByText('กำลังตรวจสอบสถานะ...')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /manager|ผู้จัดการ/i })).toBeNull();
  });

  it('VOID_REASON_ENTRY requires a reason before submitting, and calls flow.submitReason with reason+note', () => {
    const flow = makeFlow({ status: 'VOID_REASON_ENTRY', identity: IDENTITY, reason: '', note: '' });
    render(<PrivilegedVoidModal flow={flow} />);
    const next = screen.getByText('ถัดไป') as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.change(screen.getByLabelText('หมายเหตุเพิ่มเติม'), { target: { value: 'note text' } });
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(flow.submitReason).toHaveBeenCalledWith('ลูกค้าเปลี่ยนใจ', 'note text');
  });

  it('MANAGER_SELECT renders roster candidates ONLY — no free-text manager-id field — and picking calls chooseManager', () => {
    const flow = makeFlow({ status: 'MANAGER_SELECT', identity: IDENTITY, reason: 'r', note: '' });
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByText('Manager One'));
    expect(flow.chooseManager).toHaveBeenCalledWith('mgr-1');
  });

  it('MANAGER_SELECT fails closed with a distinct message when the roster is a cache-only empty result', () => {
    const flow = makeFlow(
      { status: 'MANAGER_SELECT', identity: IDENTITY, reason: 'r', note: '' },
      { roster: readyRoster({ candidates: [], fromCache: true }) },
    );
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.getByTestId('pvm-roster-fail-closed')).toBeTruthy();
  });

  it('MANAGER_SELECT fails closed on a disabled roster', () => {
    const flow = makeFlow(
      { status: 'MANAGER_SELECT', identity: IDENTITY, reason: 'r', note: '' },
      { roster: { status: 'disabled', fromCache: false, candidates: [] } },
    );
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.getByTestId('pvm-roster-fail-closed')).toBeTruthy();
  });

  it('MANAGER_PIN_ENTRY composes the landed ManagerPinModal and disables it while submitting', () => {
    const flow = makeFlow(
      { status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null },
      { isSubmitting: true },
    );
    render(<PrivilegedVoidModal flow={flow} />);
    const modal = screen.getByTestId('privileged-void-pin-modal');
    expect(within(modal).getByText('1').closest('button')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('MANAGER_PIN_ENTRY forwards the raw six-digit PIN buffer to flow.submitPin exactly once, never storing it in this component', () => {
    const flow = makeFlow({ status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null });
    render(<PrivilegedVoidModal flow={flow} />);
    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(screen.getByText(d));
    fireEvent.click(screen.getByText('ยืนยัน'));
    expect(flow.submitPin).toHaveBeenCalledTimes(1);
    expect(flow.submitPin).toHaveBeenCalledWith('123456');
  });

  it('RC-E1-001: fewer than 6 digits cannot submit (Submit stays disabled)', () => {
    const flow = makeFlow({ status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null });
    render(<PrivilegedVoidModal flow={flow} />);
    for (const d of ['1', '2', '3', '4', '5']) fireEvent.click(screen.getByText(d));
    const submit = screen.getByText('ยืนยัน') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(flow.submitPin).not.toHaveBeenCalled();
  });

  it('RC-E1-001: exactly 6 digits enables Submit', () => {
    const flow = makeFlow({ status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null });
    render(<PrivilegedVoidModal flow={flow} />);
    for (const d of ['1', '2', '3', '4', '5']) fireEvent.click(screen.getByText(d));
    const submit = screen.getByText('ยืนยัน') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByText('6'));
    expect(submit.disabled).toBe(false);
  });

  it('RC-E1-001: the PIN buffer is capped at 6 digits — a 7th digit press is not accepted', () => {
    const flow = makeFlow({ status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null });
    render(<PrivilegedVoidModal flow={flow} />);
    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(screen.getByText(d));
    fireEvent.click(screen.getByText('7'));
    fireEvent.click(screen.getByText('ยืนยัน'));
    expect(flow.submitPin).toHaveBeenCalledWith('123456');
    expect(flow.submitPin).not.toHaveBeenCalledWith('1234567');
  });

  it('RC-E1-001: no PIN digit is rendered anywhere — the masked display shows dot slots only', () => {
    const flow = makeFlow({ status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null });
    render(<PrivilegedVoidModal flow={flow} />);
    for (const d of ['1', '2', '3']) fireEvent.click(screen.getByText(d));
    const display = screen.getByTestId('mpin-display');
    expect(display.textContent).toBe('');
    expect(display.querySelectorAll('.mpin-dot--filled').length).toBe(3);
  });

  it('MANAGER_PIN_ENTRY never renders the raw pinErrorCode', () => {
    const flow = makeFlow({
      status: 'MANAGER_PIN_ENTRY',
      identity: IDENTITY,
      reason: 'r',
      note: '',
      pinErrorCode: 'SOME_RAW_D1B_CODE',
    });
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.queryByText('SOME_RAW_D1B_CODE')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/PIN ไม่ถูกต้อง/);
  });

  it('PROJECTING shows a spinner and is not dismissible via Escape/outside click', () => {
    const flow = makeFlow({ status: 'PROJECTING', identity: IDENTITY, reason: 'r', note: '' }, { isSubmitting: true });
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.getByText('กำลังส่งคำขอ...')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(flow.close).not.toHaveBeenCalled();
  });

  it('CAPTURED_PENDING_ADJUDICATION never renders completed-void wording, and Close calls flow.close', () => {
    const flow = makeFlow({ status: 'CAPTURED_PENDING_ADJUDICATION', identity: IDENTITY, record: RECORD_SUMMARY });
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.queryByText(/ยกเลิกบิลสำเร็จ/)).toBeNull();
    fireEvent.click(screen.getByText('ปิด'));
    expect(flow.close).toHaveBeenCalledTimes(1);
  });

  it('LOCAL_UNCERTAIN offers a reconciliation retry that never mints a new attempt directly', () => {
    const flow = makeFlow({ status: 'LOCAL_UNCERTAIN', identity: IDENTITY });
    render(<PrivilegedVoidModal flow={flow} />);
    fireEvent.click(screen.getByText('ตรวจสอบอีกครั้ง'));
    expect(flow.retryReconciliation).toHaveBeenCalledTimes(1);
    expect(flow.submitPin).not.toHaveBeenCalled();
  });

  it('RECOVERED_ACTIVE with a known row does not offer a reconciliation retry (nothing to reconcile)', () => {
    const flow = makeFlow({ status: 'RECOVERED_ACTIVE', identity: IDENTITY, row: SAFE_ROW });
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.queryByText('ตรวจสอบอีกครั้ง')).toBeNull();
  });

  it('MANUAL_ATTENTION renders a read-only status only — no action button beyond Close', () => {
    const flow = makeFlow({ status: 'MANUAL_ATTENTION', identity: IDENTITY, row: SAFE_ROW });
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.getByText('ต้องให้เจ้าหน้าที่ตรวจสอบ')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['ปิด']);
  });

  it('RC-E1-005: back/cancel from PIN(A) then selecting a DIFFERENT manager calls backToManagerSelect then chooseManager(B) — real rendered back-then-reselect path', () => {
    const flow = makeFlow({
      status: 'MANAGER_PIN_ENTRY',
      identity: { ...IDENTITY, managerStaffId: 'mgr-1' },
      reason: 'r',
      note: '',
      pinErrorCode: null,
    });
    const { rerender } = render(<PrivilegedVoidModal flow={flow} />);

    const pinModal = screen.getByTestId('privileged-void-pin-modal');
    fireEvent.click(within(pinModal).getByText('ยกเลิก'));
    expect(flow.backToManagerSelect).toHaveBeenCalledTimes(1);

    // The real hook/machine would now render MANAGER_SELECT with the prior
    // manager binding still carried in `identity` (see
    // `privilegedVoidFlowMachine.backToManagerSelect`) — that carried
    // binding is exactly what lets `chooseManager` detect a real change.
    const backAtSelect = makeFlow(
      { status: 'MANAGER_SELECT', identity: { ...IDENTITY, managerStaffId: 'mgr-1' }, reason: 'r', note: '' },
      {
        roster: readyRoster({
          candidates: [
            { userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' },
            { userId: 'mgr-2', displayName: 'Manager Two', username: 'm2', role: 'manager' },
          ],
        }),
        chooseManager: flow.chooseManager,
      },
    );
    rerender(<PrivilegedVoidModal flow={backAtSelect} />);

    fireEvent.click(screen.getByText('Manager Two'));
    expect(flow.chooseManager).toHaveBeenCalledWith('mgr-2');
    expect(flow.chooseManager).not.toHaveBeenCalledWith('mgr-1');
  });
});
