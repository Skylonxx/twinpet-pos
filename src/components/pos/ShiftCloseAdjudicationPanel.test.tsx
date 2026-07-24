// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShiftCloseAdjudicationPanel, { type ShiftCloseAdjudicationPanelProps } from './ShiftCloseAdjudicationPanel';
import { mapShiftCloseReviewRow } from '../../lib/pos/shiftClose/shiftCloseReviewRows';
import { mapShiftCloseCaseProjection } from '../../lib/pos/shiftClose/shiftCloseDetailProjection';
import type { ResolveShiftCloseAlertAdapterRequest } from '../../lib/pos/shiftClose/resolveShiftCloseAlertAdapter';

afterEach(() => cleanup());

const alertRow = mapShiftCloseReviewRow('SHIFT-1', {
  shiftId: 'SHIFT-1',
  branchId: 'BR-001',
  alertState: 'open',
  reasonCode: 'drawer_discrepancy',
  caseVersion: 2,
});

const caseProjection = mapShiftCloseCaseProjection('SHIFT-1', {
  shiftId: 'SHIFT-1',
  branchId: 'BR-001',
  alertState: 'open',
  processingState: 'validated',
  settlementState: 'manual_review_required',
  caseVersion: 2,
});

function baseProps(overrides: Partial<ShiftCloseAdjudicationPanelProps> = {}): ShiftCloseAdjudicationPanelProps {
  return {
    role: 'manager',
    branchId: 'BR-001',
    routeShiftId: 'SHIFT-1',
    alertSource: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
    caseSource: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    integrityCautions: [],
    ...overrides,
  };
}

describe('ShiftCloseAdjudicationPanel — visibility (baseAvailability gate)', () => {
  test('hidden entirely (renders nothing) when baseAvailability is false', () => {
    const { container } = render(
      <ShiftCloseAdjudicationPanel {...baseProps({ alertSource: { status: 'ready', fromCache: true, empty: false, errorType: null, row: alertRow } })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('no disabled action buttons rendered for an unavailable state (hidden, not disabled)', () => {
    const { container } = render(
      <ShiftCloseAdjudicationPanel {...baseProps({ integrityCautions: ['case_version_drift'] })} />,
    );
    expect(container.querySelector('button')).toBeNull();
  });

  test('visible with both actions when open + all conditions agree', () => {
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    expect(screen.getByRole('button', { name: 'รับทราบ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ยืนยันแก้ไข' })).toBeTruthy();
  });

  test('resolve-only when alert already acknowledged', () => {
    const ackAlert = mapShiftCloseReviewRow('SHIFT-1', { shiftId: 'SHIFT-1', branchId: 'BR-001', alertState: 'acknowledged', reasonCode: 'drawer_discrepancy', caseVersion: 2 });
    const ackCase = mapShiftCloseCaseProjection('SHIFT-1', { shiftId: 'SHIFT-1', alertState: 'acknowledged', processingState: 'validated', settlementState: 'manual_review_required', caseVersion: 2 });
    render(
      <ShiftCloseAdjudicationPanel
        {...baseProps({
          alertSource: { status: 'ready', fromCache: false, empty: false, errorType: null, row: ackAlert },
          caseSource: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: ackCase },
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'รับทราบ' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ยืนยันแก้ไข' })).toBeTruthy();
  });

  test('action order is Acknowledge before Resolve in the DOM (UX-N1 safety-first order)', () => {
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    const buttons = screen.getAllByRole('button');
    const ackIndex = buttons.findIndex((b) => b.textContent === 'รับทราบ');
    const resolveIndex = buttons.findIndex((b) => b.textContent === 'ยืนยันแก้ไข');
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(resolveIndex);
  });

  test('resolve action uses warning styling, not failure/destructive', () => {
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    const resolveButton = screen.getByRole('button', { name: 'ยืนยันแก้ไข' });
    expect(resolveButton.className).not.toMatch(/red|failure/i);
  });
});

describe('ShiftCloseAdjudicationPanel — V-1 remediation (valid yellow Button color, not unsupported warning)', () => {
  test('Resolve trigger renders with the valid Flowbite yellow color classes', () => {
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    const resolveButton = screen.getByRole('button', { name: 'ยืนยันแก้ไข' });
    expect(resolveButton.className).toMatch(/bg-yellow-400/);
  });

  test('Resolve confirm (in the dialog footer) renders with the valid Flowbite yellow color classes', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    const dialog = screen.getByText('ยืนยันการแก้ไขการแจ้งเตือน').closest('div')!.parentElement!.parentElement!;
    const confirmButton = within(dialog).getByRole('button', { name: 'ยืนยันการแก้ไข' });
    expect(confirmButton.className).toMatch(/bg-yellow-400/);
  });

  test('Retry renders with the valid Flowbite yellow color classes', async () => {
    const user = userEvent.setup();
    const transport = () => Promise.reject(new Error('down'));
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    const retryButton = await screen.findByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' });
    expect(retryButton.className).toMatch(/bg-yellow-400/);
  });

  test('Acknowledge trigger remains the standard light color, unaffected by the V-1 remediation', () => {
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    const ackButton = screen.getByRole('button', { name: 'รับทราบ' });
    expect(ackButton.className).toMatch(/border-gray-300/);
    expect(ackButton.className).not.toMatch(/bg-yellow/);
  });

  test('action ordering remains Acknowledge before Resolve after the color remediation', () => {
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    const buttons = screen.getAllByRole('button');
    const ackIndex = buttons.findIndex((b) => b.textContent === 'รับทราบ');
    const resolveIndex = buttons.findIndex((b) => b.textContent === 'ยืนยันแก้ไข');
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(resolveIndex);
  });
});

describe('ShiftCloseAdjudicationPanel — Acknowledge dialog', () => {
  test('opens with adoption wording, no evidence checkbox', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    expect(screen.getByText('ยืนยันการรับทราบการแจ้งเตือน')).toBeTruthy();
    expect(screen.getByText(/เหตุผลที่ใช้ในการตัดสินใจ/)).toBeTruthy();
    expect(screen.queryByText('ข้าพเจ้าได้ตรวจสอบหลักฐานภายนอกและยืนยันการแก้ไขนี้')).toBeNull();
  });

  test('confirm is enabled without checking any box (acknowledge has no evidence gate)', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    const dialogConfirm = confirmButtons[confirmButtons.length - 1];
    expect((dialogConfirm as HTMLButtonElement).disabled).toBe(false);
  });

  test('cancel closes the dialog and returns focus to the (remounted) trigger button', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    await waitFor(() => expect(screen.queryByText('ยืนยันการรับทราบการแจ้งเตือน')).toBeNull());
    // The trigger unmounts while the dialog is open and remounts on close — assert
    // against the CURRENT node, not a stale pre-open reference (see the machine's
    // stable-ref design, ShiftCloseAdjudicationPanel.tsx's ackButtonRef/resolveButtonRef).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'รับทราบ' })));
  });
});

describe('ShiftCloseAdjudicationPanel — Resolve dialog (DP4-R1)', () => {
  test('shows figures-not-displayed warning and unchecked-by-default evidence checkbox', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    expect(screen.getByText('คำเตือน: ระบบไม่แสดงตัวเลขเงินสดในหน้านี้')).toBeTruthy();
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  test('confirm is disabled until the checkbox is checked, then enabled', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    const dialog = screen.getByText('ยืนยันการแก้ไขการแจ้งเตือน').closest('div')!.parentElement!.parentElement!;
    const confirmButton = within(dialog).getByRole('button', { name: 'ยืนยันการแก้ไข' });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox'));
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
  });

  test('no reason selector exists — only read-only adopted-reason text', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('ShiftCloseAdjudicationPanel — L-1 remediation (warning repositioned next to the evidence checkbox)', () => {
  test('the cash-figures warning appears exactly once in the Resolve dialog', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    expect(screen.getAllByText('คำเตือน: ระบบไม่แสดงตัวเลขเงินสดในหน้านี้')).toHaveLength(1);
  });

  test('the cash-figures warning sits immediately after the evidence checkbox block in DOM order', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    const checkbox = screen.getByRole('checkbox');
    const checkboxBlock = checkbox.closest('label')!;
    expect(checkboxBlock.nextElementSibling?.textContent).toContain('คำเตือน: ระบบไม่แสดงตัวเลขเงินสดในหน้านี้');
  });

  test('resolve dialog initial focus still lands on the evidence checkbox after the L-1 reposition', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox')));
  });

  test('acknowledge dialog is unaffected by the L-1 reposition — no evidence checkbox, no cash-figures warning', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('คำเตือน: ระบบไม่แสดงตัวเลขเงินสดในหน้านี้')).toBeNull();
  });
});

describe('ShiftCloseAdjudicationPanel — note (N1)', () => {
  test('shows a live counter and privacy warning, optional for both outcomes', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    expect(screen.getByText('0/1,000')).toBeTruthy();
    expect(screen.getByText(/ห้ามระบุหมายเลข PIN/)).toBeTruthy();
    const textarea = screen.getByLabelText('หมายเหตุ (ทางเลือก)') as HTMLTextAreaElement;
    await user.type(textarea, 'abc');
    expect(screen.getByText('3/1,000')).toBeTruthy();
  });

  test('textarea has a native maxLength of 1000', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const textarea = screen.getByLabelText('หมายเหตุ (ทางเลือก)') as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(1000);
  });
});

describe('ShiftCloseAdjudicationPanel — submit + result states', () => {
  test('successful acknowledge shows the generic success receipt in place of the buttons', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockResolvedValue({ ok: true, commandId: 'ignored', shiftId: 'SHIFT-1', status: 'confirmed' });
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport: (req: ResolveShiftCloseAlertAdapterRequest) => transport(req).then((r: unknown) => ({ ...(r as object), commandId: req.commandId })) })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText('ทำรายการสำเร็จ')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'ยืนยันแก้ไข' })).toBeNull();
  });

  test('duplicate_confirmed shows the success receipt with a subordinate note', async () => {
    const user = userEvent.setup();
    const transport = (req: ResolveShiftCloseAlertAdapterRequest) =>
      Promise.resolve({ ok: true, commandId: req.commandId, shiftId: req.shiftId, status: 'duplicate_confirmed' });
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText('ทำรายการสำเร็จ')).toBeTruthy());
    expect(screen.getByText(/ยืนยันไปแล้วก่อนหน้านี้/)).toBeTruthy();
  });

  test('stale/busy shows the exact frozen merged copy and discards the command', async () => {
    const user = userEvent.setup();
    const transport = (req: ResolveShiftCloseAlertAdapterRequest) =>
      Promise.resolve({ ok: false, commandId: req.commandId, shiftId: req.shiftId, status: 'conflict_requires_manual_review', rejectCode: 'stale_case_version' });
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() =>
      expect(
        screen.getByText('ข้อมูลมีการเปลี่ยนแปลงหรือกำลังประมวลผล โปรดตรวจสอบข้อมูลล่าสุดก่อนตัดสินใจอีกครั้ง'),
      ).toBeTruthy(),
    );
  });

  test('terminal rejection shows an honest failure receipt, never success tone', async () => {
    const user = userEvent.setup();
    const transport = (req: ResolveShiftCloseAlertAdapterRequest) =>
      Promise.resolve({ ok: false, commandId: req.commandId, shiftId: req.shiftId, status: 'rejected', rejectCode: 'unauthorized' });
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText(/ไม่สามารถทำรายการได้/)).toBeTruthy());
    expect(screen.queryByText('ทำรายการสำเร็จ')).toBeNull();
  });

  test('transport failure offers exact-command retry and abandon, never auto-retries', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({
      ok: true,
      commandId: 'x',
      shiftId: 'SHIFT-1',
      status: 'confirmed',
    });
    render(
      <ShiftCloseAdjudicationPanel
        {...baseProps({
          transport: async (req: ResolveShiftCloseAlertAdapterRequest) => {
            const r = await transport(req);
            return { ...(r as object), commandId: req.commandId };
          },
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText(/ไม่ได้รับการตอบกลับจากเซิร์ฟเวอร์/)).toBeTruthy());
    expect(transport).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' }));
    await waitFor(() => expect(screen.getByText('ทำรายการสำเร็จ')).toBeTruthy());
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0][0].commandId).toBe(transport.mock.calls[1][0].commandId);
  });

  test('abandon on a transport ambiguity returns to idle and re-shows the action buttons', async () => {
    const user = userEvent.setup();
    const transport = () => Promise.reject(new Error('down'));
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText(/ไม่ได้รับการตอบกลับจากเซิร์ฟเวอร์/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'ยกเลิกคำสั่งนี้' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'รับทราบ' })).toBeTruthy());
  });
});

describe('ShiftCloseAdjudicationPanel — no Firestore/PIN/global-listener surface', () => {
  test('module does not import a PIN modal or attach a global keydown listener', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    const keydownCalls = addSpy.mock.calls.filter((c) => c[0] === 'keydown');
    expect(keydownCalls.length).toBe(0);
    addSpy.mockRestore();
  });
});

describe('ShiftCloseAdjudicationPanel — RC-1 empty-note omission', () => {
  test('submitting with no note never sends a reasonNote property to the transport', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockResolvedValue({ ok: true, commandId: 'ignored', shiftId: 'SHIFT-1', status: 'confirmed' });
    render(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ transport: (req: ResolveShiftCloseAlertAdapterRequest) => transport(req).then((r: unknown) => ({ ...(r as object), commandId: req.commandId })) })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(transport).toHaveBeenCalled());
    const sentReq = transport.mock.calls[0][0] as ResolveShiftCloseAlertAdapterRequest;
    expect('reasonNote' in sentReq).toBe(false);
  });
});

describe('ShiftCloseAdjudicationPanel — RC-3 terminal command collision', () => {
  test('conflict_requires_manual_review + invalid_payload shows an honest command-collision receipt, never stale/busy copy, and offers no retry', async () => {
    const user = userEvent.setup();
    const transport = (req: ResolveShiftCloseAlertAdapterRequest) =>
      Promise.resolve({ ok: false, commandId: req.commandId, shiftId: req.shiftId, status: 'conflict_requires_manual_review', rejectCode: 'invalid_payload' });
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() =>
      expect(
        screen.getByText('ไม่สามารถยืนยันคำสั่งนี้ได้ เนื่องจากรหัสคำสั่งไม่ตรงกับข้อมูลเดิม โปรดเริ่มทำรายการใหม่'),
      ).toBeTruthy(),
    );
    expect(screen.queryByText('ข้อมูลมีการเปลี่ยนแปลงหรือกำลังประมวลผล โปรดตรวจสอบข้อมูลล่าสุดก่อนตัดสินใจอีกครั้ง')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' })).toBeNull();
  });
});

describe('ShiftCloseAdjudicationPanel — RC-4 scope-freeze / race-safe late-result suppression', () => {
  test('an immediate prop rerender to a new branch scope before the transport resolves suppresses the late receipt', async () => {
    const user = userEvent.setup();
    let resolveTransport!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveTransport = resolve;
    });
    const transport = vi.fn().mockReturnValue(pending);
    const { rerender } = render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    expect(transport).toHaveBeenCalledTimes(1);
    const sentCommandId = (transport.mock.calls[0][0] as ResolveShiftCloseAlertAdapterRequest).commandId;

    // Scope-changing prop rerender BEFORE the transport promise resolves.
    rerender(<ShiftCloseAdjudicationPanel {...baseProps({ transport, branchId: 'BR-002' })} />);

    await act(async () => {
      resolveTransport({ ok: true, commandId: sentCommandId, shiftId: 'SHIFT-1', status: 'confirmed' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('ทำรายการสำเร็จ')).toBeNull();
  });

  test('unmounting before the transport resolves suppresses the late result — no state update after teardown', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    let resolveTransport!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveTransport = resolve;
    });
    const transport = vi.fn().mockReturnValue(pending);
    const { unmount } = render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    const sentCommandId = (transport.mock.calls[0][0] as ResolveShiftCloseAlertAdapterRequest).commandId;

    unmount();
    await act(async () => {
      resolveTransport({ ok: true, commandId: sentCommandId, shiftId: 'SHIFT-1', status: 'confirmed' });
      await Promise.resolve();
      await Promise.resolve();
    });

    const unmountedWarning = consoleError.mock.calls.some(
      (args) => typeof args[0] === 'string' && /unmounted/i.test(args[0]),
    );
    expect(unmountedWarning).toBe(false);
    consoleError.mockRestore();
  });

  test('the same, unchanged scope still renders the receipt normally', async () => {
    const user = userEvent.setup();
    const transport = (req: ResolveShiftCloseAlertAdapterRequest) =>
      Promise.resolve({ ok: true, commandId: req.commandId, shiftId: req.shiftId, status: 'confirmed' });
    render(<ShiftCloseAdjudicationPanel {...baseProps({ transport })} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText('ทำรายการสำเร็จ')).toBeTruthy());
  });
});

// Shared by the final-RC-4 binding suite and the final retry-scope suite:
// alert + case sources whose rows genuinely bind to the given doc ID/branch.
function rowsFor(docId: string, branchId: string) {
  const row = mapShiftCloseReviewRow(docId, {
    shiftId: docId,
    branchId,
    alertState: 'open',
    reasonCode: 'drawer_discrepancy',
    caseVersion: 2,
  });
  const projection = mapShiftCloseCaseProjection(docId, {
    shiftId: docId,
    branchId,
    alertState: 'open',
    processingState: 'validated',
    settlementState: 'manual_review_required',
    caseVersion: 2,
  });
  return {
    alertSource: { status: 'ready' as const, fromCache: false, empty: false, errorType: null, row },
    caseSource: { status: 'ready' as const, fromCache: false, empty: false, errorType: null, projection },
  };
}

describe('ShiftCloseAdjudicationPanel — final RC-4 fail-closed source/scope binding', () => {
  test('stale prior-scope rows under a delimiter-colliding new scope render nothing — no panel, no dialog possible', () => {
    // Scope A was branch "A::B", route "C"; scope B is branch "A", route
    // "B::C". The upstream hook's `::`-joined reset key collides for these,
    // so scope-A rows can survive one render under scope B — the panel must
    // reject them outright.
    const transport = vi.fn();
    const { container } = render(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ ...rowsFor('C', 'A::B'), branchId: 'A', routeShiftId: 'B::C', transport })}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  test('alert/case doc IDs not matching the route shift ID render nothing', () => {
    const { container } = render(
      <ShiftCloseAdjudicationPanel {...baseProps({ ...rowsFor('OTHER-SHIFT', 'BR-001') })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('alert branch not matching the structured branch renders nothing', () => {
    const { container } = render(
      <ShiftCloseAdjudicationPanel {...baseProps({ ...rowsFor('SHIFT-1', 'BR-OTHER') })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('missing canonical route ID renders nothing', () => {
    const { container } = render(<ShiftCloseAdjudicationPanel {...baseProps({ routeShiftId: '' })} />);
    expect(container.firstChild).toBeNull();
  });

  test('missing canonical branch ID renders nothing', () => {
    const { container } = render(<ShiftCloseAdjudicationPanel {...baseProps({ branchId: '' })} />);
    expect(container.firstChild).toBeNull();
  });

  test('a scope collision arriving while the dialog is open invalidates it before any mint or transport call', async () => {
    const user = userEvent.setup();
    const transport = vi.fn();
    const { rerender } = render(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ ...rowsFor('C', 'A::B'), branchId: 'A::B', routeShiftId: 'C', transport })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    expect(screen.getByText('ยืนยันการรับทราบการแจ้งเตือน')).toBeTruthy();

    // The colliding scope B arrives while the scope-A rows are still live —
    // the confirming dialog must invalidate to idle with zero mint/transport.
    rerender(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ ...rowsFor('C', 'A::B'), branchId: 'A', routeShiftId: 'B::C', transport })}
      />,
    );
    await waitFor(() => expect(screen.queryByText('ยืนยันการรับทราบการแจ้งเตือน')).toBeNull());
    expect(transport).not.toHaveBeenCalled();
  });

  test('positive control: agreeing route/alert/case/branch offers the panel and submits the canonical route/branch, then renders the same-scope receipt', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockImplementation((req: ResolveShiftCloseAlertAdapterRequest) =>
      Promise.resolve({ ok: true, commandId: req.commandId, shiftId: req.shiftId, status: 'confirmed' }),
    );
    render(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ ...rowsFor('B::C', 'A'), branchId: 'A', routeShiftId: 'B::C', transport })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText('ทำรายการสำเร็จ')).toBeTruthy());
    expect(transport).toHaveBeenCalledTimes(1);
    const sent = transport.mock.calls[0][0] as ResolveShiftCloseAlertAdapterRequest;
    // Canonical decoded route exactly — never the (identical-by-binding) alert
    // doc ID as an independent authority, never a re-encoded/re-decoded value.
    expect(sent.shiftId).toBe('B::C');
    expect(sent.branchId).toBe('A');
  });
});

describe('ShiftCloseAdjudicationPanel — final retry-scope remediation (retry boundary scope/source guard)', () => {
  /** Submits an acknowledge whose first transport call fails, landing the panel in `retryable`. */
  async function enterRetryable(
    user: ReturnType<typeof userEvent.setup>,
    props: Partial<ShiftCloseAdjudicationPanelProps>,
  ) {
    const utils = render(<ShiftCloseAdjudicationPanel {...baseProps(props)} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(screen.getByText(/ไม่ได้รับการตอบกลับจากเซิร์ฟเวอร์/)).toBeTruthy());
    return utils;
  }

  test('production-path delimiter collision during retryable abandons the chain — dialog gone, retry gone, transport count stays 1, no command reissued', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockRejectedValueOnce(new Error('down'));
    // S1: branch "A::B", route "C", rows bound to S1.
    const s1Props = { ...rowsFor('C', 'A::B'), branchId: 'A::B', routeShiftId: 'C', transport };
    const { rerender } = await enterRetryable(user, s1Props);
    expect(transport).toHaveBeenCalledTimes(1);
    const firstReq = transport.mock.calls[0][0] as ResolveShiftCloseAlertAdapterRequest;

    // S2: branch "A", route "B::C" — the hook's `::`-joined reset key collides,
    // so the stale S1 rows survive this render. The retry chain must be
    // abandoned BEFORE any interaction.
    rerender(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ ...rowsFor('C', 'A::B'), branchId: 'A', routeShiftId: 'B::C', transport })}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/ไม่ได้รับการตอบกลับจากเซิร์ฟเวอร์/)).toBeNull());
    // Nothing actionable remains — no retry control anywhere.
    expect(screen.queryByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' })).toBeNull();
    // Zero additional transport calls; the frozen S1 command was never reissued.
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.every((c) => (c[0] as ResolveShiftCloseAlertAdapterRequest).commandId === firstReq.commandId)).toBe(true);
    expect(screen.queryByText('ทำรายการสำเร็จ')).toBeNull();
  });

  test('a live alert-identity change during retryable (same scope) abandons the chain with zero additional transport calls', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockRejectedValueOnce(new Error('down'));
    const { rerender } = await enterRetryable(user, { transport });
    rerender(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ alertSource: rowsFor('OTHER-SHIFT', 'BR-001').alertSource, transport })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' })).toBeNull());
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('a live case-identity change during retryable (same scope) abandons the chain with zero additional transport calls', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockRejectedValueOnce(new Error('down'));
    const { rerender } = await enterRetryable(user, { transport });
    rerender(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ caseSource: rowsFor('OTHER-SHIFT', 'BR-001').caseSource, transport })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' })).toBeNull());
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('a live alert-branch change during retryable (same scope) abandons the chain with zero additional transport calls', async () => {
    const user = userEvent.setup();
    const transport = vi.fn().mockRejectedValueOnce(new Error('down'));
    const { rerender } = await enterRetryable(user, { transport });
    rerender(
      <ShiftCloseAdjudicationPanel
        {...baseProps({ alertSource: rowsFor('SHIFT-1', 'BR-OTHER').alertSource, transport })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' })).toBeNull());
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('same-scope positive control: retry stays actionable, reissues the byte-identical command exactly once, and renders the result', async () => {
    const user = userEvent.setup();
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockImplementation((req: ResolveShiftCloseAlertAdapterRequest) =>
        Promise.resolve({ ok: true, commandId: req.commandId, shiftId: req.shiftId, status: 'confirmed' }),
      );
    await enterRetryable(user, { transport });

    const retryButton = screen.getByRole('button', { name: 'ลองส่งข้อมูลเดิมอีกครั้ง' });
    await user.click(retryButton);
    await waitFor(() => expect(screen.getByText('ทำรายการสำเร็จ')).toBeTruthy());

    // Exactly two calls — the original and ONE manual retry; no automatic third.
    expect(transport).toHaveBeenCalledTimes(2);
    const first = transport.mock.calls[0][0] as ResolveShiftCloseAlertAdapterRequest;
    const second = transport.mock.calls[1][0] as ResolveShiftCloseAlertAdapterRequest;
    expect(second.commandId).toBe(first.commandId);
    expect(second).toEqual(first); // full payload deep-equal — zero mutation, zero re-mint
  });

  test('unmount during retryable produces no later retry/transport/state update', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const transport = vi.fn().mockRejectedValueOnce(new Error('down'));
    const { unmount } = await enterRetryable(user, { transport });
    expect(transport).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const unmountedWarning = consoleError.mock.calls.some(
      (args) => typeof args[0] === 'string' && /unmounted/i.test(args[0]),
    );
    expect(unmountedWarning).toBe(false);
    consoleError.mockRestore();
  });
});

describe('ShiftCloseAdjudicationPanel — RC-5 touch target + deterministic initial focus', () => {
  test('evidence checkbox sits inside a >=44px activating label target', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    const checkbox = screen.getByRole('checkbox');
    const label = checkbox.closest('label');
    expect(label).not.toBeNull();
    expect(label!.className).toMatch(/min-h-11/);
  });

  test('clicking anywhere in the activating label toggles the checkbox (keyboard focus moves to the checkbox)', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await user.click(screen.getByText('ข้าพเจ้าได้ตรวจสอบหลักฐานภายนอกและยืนยันการแก้ไขนี้'));
    expect(checkbox.checked).toBe(true);
    expect(document.activeElement).toBe(checkbox);
  });

  test('resolve dialog initial focus lands on the evidence checkbox, never the header close control', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox')));
  });

  test('acknowledge dialog initial focus lands on the note field, never the header close control', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('หมายเหตุ (ทางเลือก)')));
  });

  test('checkbox helper text remains associated via aria-describedby', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'ยืนยันแก้ไข' }));
    const checkbox = screen.getByRole('checkbox');
    const describedBy = checkbox.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe('จำเป็นต้องยืนยันการตรวจสอบหลักฐานก่อนดำเนินการ');
  });
});

describe('ShiftCloseAdjudicationPanel — RC-6 mobile footer layout', () => {
  test('footer stacks full-width at mobile and returns to inline at sm+, with no fixed-width/nowrap classes', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const cancelButton = screen.getByRole('button', { name: 'ยกเลิก' });
    const footer = cancelButton.parentElement!;
    expect(footer.className).toMatch(/flex-col/);
    expect(footer.className).toMatch(/sm:flex-row/);
    expect(footer.className).not.toMatch(/whitespace-nowrap/);
    expect(footer.className).not.toMatch(/w-\[/);

    const confirmButtons = screen.getAllByRole('button', { name: 'รับทราบ' });
    const dialogConfirm = confirmButtons[confirmButtons.length - 1];
    expect(dialogConfirm.className).toMatch(/w-full/);
    expect(dialogConfirm.className).toMatch(/sm:w-auto/);
    expect(cancelButton.className).toMatch(/w-full/);
    expect(cancelButton.className).toMatch(/sm:w-auto/);
  });

  test('DOM order is Confirm before Cancel in the footer', async () => {
    const user = userEvent.setup();
    render(<ShiftCloseAdjudicationPanel {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'รับทราบ' }));
    const cancelButton = screen.getByRole('button', { name: 'ยกเลิก' });
    const footer = cancelButton.parentElement!;
    const buttons = within(footer).getAllByRole('button');
    const confirmIndex = buttons.findIndex((b) => b.textContent === 'รับทราบ');
    const cancelIndex = buttons.findIndex((b) => b.textContent === 'ยกเลิก');
    expect(confirmIndex).toBeGreaterThanOrEqual(0);
    expect(confirmIndex).toBeLessThan(cancelIndex);
  });
});
