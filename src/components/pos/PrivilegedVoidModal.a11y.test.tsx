// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function readyRoster(over: Partial<ApproverRosterState> = {}): ApproverRosterState {
  return {
    status: 'ready',
    fromCache: false,
    candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
    ...over,
  };
}

function makeFlow(state: PrivilegedVoidFlowState, over: Partial<UsePrivilegedVoidFlowResult> = {}): UsePrivilegedVoidFlowResult {
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

describe('PrivilegedVoidModal accessibility', () => {
  it('VOID_REASON_ENTRY exposes role=dialog, aria-modal, and a descriptive label', () => {
    render(<PrivilegedVoidModal flow={makeFlow({ status: 'VOID_REASON_ENTRY', identity: IDENTITY, reason: '', note: '' })} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBeTruthy();
  });

  it('moves focus into the dialog container on open (never to an editable field)', async () => {
    render(<PrivilegedVoidModal flow={makeFlow({ status: 'VOID_REASON_ENTRY', identity: IDENTITY, reason: '', note: '' })} />);
    await new Promise((r) => requestAnimationFrame(r));
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
  });

  it('every form field has an associated accessible label', () => {
    render(<PrivilegedVoidModal flow={makeFlow({ status: 'VOID_REASON_ENTRY', identity: IDENTITY, reason: '', note: '' })} />);
    expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy();
    expect(screen.getByLabelText('หมายเหตุเพิ่มเติม')).toBeTruthy();
  });

  it('Escape dismisses a dismissible step (VOID_REASON_ENTRY) via flow.close', () => {
    const flow = makeFlow({ status: 'VOID_REASON_ENTRY', identity: IDENTITY, reason: '', note: '' });
    render(<PrivilegedVoidModal flow={flow} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(flow.close).toHaveBeenCalledTimes(1);
  });

  it('Escape does NOT dismiss while PROJECTING (in-flight submission is protected)', () => {
    const flow = makeFlow({ status: 'PROJECTING', identity: IDENTITY, reason: 'r', note: '' }, { isSubmitting: true });
    render(<PrivilegedVoidModal flow={flow} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(flow.close).not.toHaveBeenCalled();
  });

  it('a roster fail-closed banner is announced via role=alert', () => {
    const flow = makeFlow(
      { status: 'MANAGER_SELECT', identity: IDENTITY, reason: 'r', note: '' },
      { roster: readyRoster({ candidates: [], fromCache: false }) },
    );
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('a PIN rejection is announced via role=alert on the composed ManagerPinModal', () => {
    const flow = makeFlow({
      status: 'MANAGER_PIN_ENTRY',
      identity: IDENTITY,
      reason: 'r',
      note: '',
      pinErrorCode: 'bad_pin',
    });
    render(<PrivilegedVoidModal flow={flow} />);
    expect(screen.getByRole('alert').textContent).toMatch(/PIN/);
  });

  it('the PIN step never contains a native text input — digits are keypad buttons only, so no OS keyboard is invoked', () => {
    render(
      <PrivilegedVoidModal
        flow={makeFlow({ status: 'MANAGER_PIN_ENTRY', identity: IDENTITY, reason: 'r', note: '', pinErrorCode: null })}
      />,
    );
    expect(document.querySelectorAll('input').length).toBe(0);
  });

  it('a result panel status message is announced via role=status', () => {
    render(
      <PrivilegedVoidModal
        flow={makeFlow({ status: 'LOCAL_UNCERTAIN', identity: IDENTITY })}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/ยืนยันผล/);
  });

  it('every interactive control is a real <button> (keyboard-reachable, no div-as-button)', () => {
    render(
      <PrivilegedVoidModal
        flow={makeFlow({ status: 'MANAGER_SELECT', identity: IDENTITY, reason: 'r', note: '' })}
      />,
    );
    for (const btn of screen.getAllByRole('button')) {
      expect(btn.tagName).toBe('BUTTON');
    }
  });
});
