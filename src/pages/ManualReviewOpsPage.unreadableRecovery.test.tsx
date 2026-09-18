// @vitest-environment jsdom

/**
 * SEC-001 N3 Phase 2 — Manual Review Ops unreadable privileged-evidence recovery UI.
 *
 * The destructive affordance for unreadable privileged-evidence rows lives ONLY on
 * this route-only Manager/Admin surface — never on the Sync Center, whose privileged
 * section stays passive by landed confinement. These tests pin the operator contract:
 * who may see it, that removal needs an explicit per-row confirmation and a reason,
 * that a row carrying server-adjudication traces offers no local delete at all, that
 * every refusal is visible, and that export reads the stored capture.
 */

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  DiscardedPrivilegedEvidenceCaptureV1,
  DiscardUnreadablePrivilegedEvidenceOutcome,
  RawUnreadablePrivilegedEvidenceEntry,
} from '../lib/pos/offline/privilegedEvidenceStore';

const h = vi.hoisted(() => {
  const state = {
    actorRole: 'manager' as string,
    unreadableRows: [] as RawUnreadablePrivilegedEvidenceEntry[],
    captures: [] as DiscardedPrivilegedEvidenceCaptureV1[],
    discardOutcome: {
      kind: 'discarded',
      key: 'corrupt-1',
      captureRecordId: 'cap-1',
      classification: 'no_server_evidence_detected',
    } as DiscardUnreadablePrivilegedEvidenceOutcome,
    canonicalScope: { branchId: 'LDP-001', deviceId: 'dev-1' } as
      | { branchId: string; deviceId: string }
      | null,
    failUnreadableRead: false,
  };
  return {
    state,
    discardSpy: vi.fn(async (store: unknown, input: Record<string, unknown>) => {
      void store;
      void input;
      return state.discardOutcome;
    }),
    exportSpy: vi.fn(async (store: unknown, captureRecordId: string) => {
      void store;
      void captureRecordId;
      return 'exported' as 'exported' | 'not_found';
    }),
  };
});

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'mgr-1', role: h.state.actorRole, name: 'Manager' },
    branchId: 'LDP-001',
  }),
}));

vi.mock('../lib/pos/offline/reversalLocalStore', () => ({
  createIndexedDbReversalStore: () => ({}),
}));

vi.mock('../lib/pos/offline/offlineReversalQueue', () => ({
  listQueue: async () => [],
  resolveManualReview: vi.fn(),
}));

vi.mock('../lib/pos/offline/reversalRejectionLog', () => ({
  listReversalRejections: async () => [],
}));

vi.mock('../lib/pos/offline/voidIntentStore', () => ({
  listTerminalVoidIntents: async () => [],
  subscribeVoidIntentStore: () => () => undefined,
}));

vi.mock('../lib/pos/offline/canonicalSyncContext', () => ({
  getCanonicalSyncContext: () => h.state.canonicalScope,
}));

// The classifier is the REAL one — the panel's advisory badge and the
// escalation branch must never drift from the store's own rule.
vi.mock('../lib/pos/offline/privilegedEvidenceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/offline/privilegedEvidenceStore')>();
  return {
    classifyRawUnreadablePrivilegedEvidence: actual.classifyRawUnreadablePrivilegedEvidence,
    listRawUnreadablePrivilegedEvidence: async () => {
      if (h.state.failUnreadableRead) throw new Error('idb unavailable');
      return h.state.unreadableRows;
    },
    listDiscardedPrivilegedEvidenceCaptures: async () => h.state.captures,
    discardUnreadablePrivilegedEvidenceRow: h.discardSpy,
    exportDiscardedPrivilegedEvidenceCapture: h.exportSpy,
  };
});

import ManualReviewOpsPage from './ManualReviewOpsPage';

const CLEAN_ROW: RawUnreadablePrivilegedEvidenceEntry = {
  key: 'corrupt-1',
  rawValue: { garbage: true, nested: { serverVerdict: 'ACCEPTED' } },
};

const SERVER_ROW: RawUnreadablePrivilegedEvidenceEntry = {
  key: 'server-ish-1',
  rawValue: { serverVerdict: 'ACCEPTED', broken: true },
};

const CAPTURE: DiscardedPrivilegedEvidenceCaptureV1 = {
  captureKind: 'privileged_evidence_unreadable_discard_v1',
  captureRecordId: 'privileged_evidence_unreadable_discard:9000000:corrupt-1',
  sourceStore: 'privilegedEvidence',
  rawKey: 'corrupt-1',
  rawValue: { garbage: true },
  classification: 'no_server_evidence_detected',
  branchId: 'LDP-001',
  deviceId: 'dev-1',
  actorStaffId: 'mgr-1',
  actorRole: 'manager',
  reasonCode: 'unreadable_row_support_cleared',
  discardedAtMs: 9_000_000,
};

async function renderPage(): Promise<void> {
  render(createElement(ManualReviewOpsPage));
  await waitFor(() => {
    expect(screen.getByText('คิวตรวจสอบด้วยตนเอง')).toBeTruthy();
  });
}

/** Open the destructive confirmation for the one eligible row. */
async function openDiscardModal(): Promise<void> {
  const button = await screen.findByRole('button', { name: 'ลบรายการนี้' });
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  h.state.actorRole = 'manager';
  h.state.unreadableRows = [];
  h.state.captures = [];
  h.state.canonicalScope = { branchId: 'LDP-001', deviceId: 'dev-1' };
  h.state.discardOutcome = {
    kind: 'discarded',
    key: 'corrupt-1',
    captureRecordId: 'cap-1',
    classification: 'no_server_evidence_detected',
  };
  h.discardSpy.mockClear();
  h.exportSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('N3 Phase 2 UI — authority gate', () => {
  test('Staff sees neither the page nor any recovery control', async () => {
    h.state.actorRole = 'staff';
    h.state.unreadableRows = [CLEAN_ROW];
    render(createElement(ManualReviewOpsPage));
    await waitFor(() => {
      expect(screen.getByText(/เฉพาะผู้จัดการ\/ผู้ดูแลระบบ/)).toBeTruthy();
    });
    expect(screen.queryByText('ข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้ (อุปกรณ์นี้)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ลบรายการนี้' })).toBeNull();
    expect(h.discardSpy).not.toHaveBeenCalled();
  });

  test('Manager sees the panel, the raw key and the advisory classification', async () => {
    h.state.unreadableRows = [CLEAN_ROW];
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('ข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้ (อุปกรณ์นี้)')).toBeTruthy();
    });
    expect(screen.getByText('corrupt-1')).toBeTruthy();
    expect(screen.getByText('ไม่พบร่องรอยผลตัดสินจากเซิร์ฟเวอร์')).toBeTruthy();
    // An empty store renders an honest empty state, not a silent blank.
    cleanup();
    h.state.unreadableRows = [];
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('ไม่มีข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้บนอุปกรณ์นี้')).toBeTruthy();
    });
  });
});

describe('N3 Phase 2 UI — C2 support-only server-evidence policy', () => {
  test('a server-evidence row offers escalation and NO local delete path', async () => {
    h.state.unreadableRows = [SERVER_ROW];
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('พบร่องรอยผลตัดสินจากเซิร์ฟเวอร์')).toBeTruthy();
    });
    expect(screen.getByText(/ส่งให้ฝ่ายสนับสนุนตรวจสอบ/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ลบรายการนี้' })).toBeNull();
    expect(h.discardSpy).not.toHaveBeenCalled();
  });

  test('with both row kinds present, exactly one row is deletable — one control, no bulk action', async () => {
    h.state.unreadableRows = [SERVER_ROW, CLEAN_ROW];
    await renderPage();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'ลบรายการนี้' })).toHaveLength(1);
    });
    for (const label of [/ลบทั้งหมด/, /ล้างทั้งหมด/, /กู้คืนทั้งหมด/]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });
});

describe('N3 Phase 2 UI — destructive confirmation', () => {
  test('the confirmation names what is destroyed and states that absence of server evidence is not proof', async () => {
    h.state.unreadableRows = [CLEAN_ROW];
    await renderPage();
    await openDiscardModal();

    expect(screen.getByText('ลบข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้')).toBeTruthy();
    expect(screen.getByText(/การลบนี้ถาวรและย้อนกลับไม่ได้/)).toBeTruthy();
    expect(screen.getByText(/ไม่ได้พิสูจน์ว่าไม่เคยมีการส่งหรือไม่มีผลบนเซิร์ฟเวอร์/)).toBeTruthy();
    // The modal opens focused on the mandatory reason field.
    expect((document.activeElement as HTMLElement | null)?.id).toBe('ue-reason');
    expect(h.discardSpy).not.toHaveBeenCalled();
  });

  test('cancel closes without calling the discard, and Escape is non-destructive', async () => {
    h.state.unreadableRows = [CLEAN_ROW];
    await renderPage();
    await openDiscardModal();

    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    });
    expect(h.discardSpy).not.toHaveBeenCalled();

    if (screen.queryByRole('button', { name: 'ยกเลิก' })) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก' }));
      });
    }
    await waitFor(() => {
      expect(screen.queryByText(/การลบนี้ถาวรและย้อนกลับไม่ได้/)).toBeNull();
    });
    expect(h.discardSpy).not.toHaveBeenCalled();
  });

  test('a blank reason is refused in the builder — visibly, and without reaching the store', async () => {
    h.state.unreadableRows = [CLEAN_ROW];
    await renderPage();
    await openDiscardModal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบถาวร' }));
    });

    expect(await screen.findByText('กรุณาระบุเหตุผล (reasonCode)')).toBeTruthy();
    expect(h.discardSpy).not.toHaveBeenCalled();
  });

  test('pressing Enter in the reason field never confirms the destruction', async () => {
    h.state.unreadableRows = [CLEAN_ROW];
    await renderPage();
    await openDiscardModal();

    const reason = screen.getByLabelText(/เหตุผล \(reasonCode\)/);
    await act(async () => {
      fireEvent.change(reason, { target: { value: 'unreadable_row_support_cleared' } });
      fireEvent.keyDown(reason, { key: 'Enter', code: 'Enter' });
      fireEvent.submit(reason);
    });
    expect(h.discardSpy).not.toHaveBeenCalled();
  });

  test('a missing canonical scope refuses visibly and never reaches the store', async () => {
    h.state.unreadableRows = [CLEAN_ROW];
    h.state.canonicalScope = null;
    await renderPage();
    await openDiscardModal();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/เหตุผล \(reasonCode\)/), {
        target: { value: 'cleared' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบถาวร' }));
    });

    expect(
      await screen.findByText('ไม่พบสาขา/อุปกรณ์ปัจจุบัน — ไม่สามารถบันทึกหลักฐานได้'),
    ).toBeTruthy();
    expect(h.discardSpy).not.toHaveBeenCalled();
  });
});

describe('N3 Phase 2 UI — outcomes', () => {
  test('a successful discard passes the trusted acting context, then refreshes into the capture list', async () => {
    h.state.unreadableRows = [CLEAN_ROW];
    await renderPage();
    await openDiscardModal();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/เหตุผล \(reasonCode\)/), {
        target: { value: 'unreadable_row_support_cleared' },
      });
    });

    // The refreshed read returns the cleared list plus the durable capture.
    h.state.unreadableRows = [];
    h.state.captures = [CAPTURE];

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบถาวร' }));
    });

    await waitFor(() => {
      expect(h.discardSpy).toHaveBeenCalledTimes(1);
    });
    const input = h.discardSpy.mock.calls[0][1];
    expect(input.key).toBe('corrupt-1');
    expect(input.actorStaffId).toBe('mgr-1');
    expect(input.actorRole).toBe('manager');
    expect(input.branchId).toBe('LDP-001');
    expect(input.deviceId).toBe('dev-1');
    expect(input.reasonCode).toBe('unreadable_row_support_cleared');
    expect('acknowledgedServerEvidence' in input).toBe(false);

    await waitFor(() => {
      expect(screen.getByText('ไม่มีข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้บนอุปกรณ์นี้')).toBeTruthy();
      expect(screen.getByText(CAPTURE.reasonCode)).toBeTruthy();
    });
  });

  test('every store refusal reason is shown to the operator', async () => {
    const reasons = [
      ['server_evidence_present', /ต้องส่งให้ฝ่ายสนับสนุนตรวจสอบ/],
      ['capture_failed', /บันทึกหลักฐานไม่สำเร็จ/],
      ['capture_key_collision', /มีบันทึกหลักฐานรหัสเดียวกันอยู่แล้ว/],
      ['not_found', /ไม่พบรายการนี้แล้ว/],
      ['readable_row', /อ่านได้ตามปกติ/],
      ['reserved_key', /คีย์ระบบ/],
      ['unauthorized', /เฉพาะผู้จัดการ/],
    ] as const;

    for (const [reason, copy] of reasons) {
      h.state.discardOutcome = { kind: 'refused', reason };
      h.state.unreadableRows = [CLEAN_ROW];
      await renderPage();
      await openDiscardModal();
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/เหตุผล \(reasonCode\)/), {
          target: { value: 'cleared' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบถาวร' }));
      });
      expect(await screen.findByText(copy), reason).toBeTruthy();
      cleanup();
      h.discardSpy.mockClear();
    }
  });

  test('export hands the STORED capture id to the export helper and surfaces a miss', async () => {
    h.state.unreadableRows = [];
    h.state.captures = [CAPTURE];
    await renderPage();

    const exportButton = await screen.findByRole('button', { name: 'ส่งออกหลักฐาน' });
    await act(async () => {
      fireEvent.click(exportButton);
    });
    await waitFor(() => {
      expect(h.exportSpy).toHaveBeenCalledTimes(1);
    });
    expect(h.exportSpy.mock.calls[0][1]).toBe(CAPTURE.captureRecordId);

    h.exportSpy.mockResolvedValueOnce('not_found');
    await act(async () => {
      fireEvent.click(exportButton);
    });
    expect(await screen.findByText('ไม่พบบันทึกหลักฐานนี้แล้ว — กรุณารีเฟรชหน้านี้')).toBeTruthy();
  });

  test('a failing diagnostic read shows an error, never a false "nothing wrong" empty state', async () => {
    h.state.failUnreadableRead = true;
    try {
      await renderPage();
      await waitFor(() => {
        expect(screen.getByText(/โหลดรายการที่อ่านไม่ได้ไม่สำเร็จ:/)).toBeTruthy();
      });
      expect(screen.queryByText('ไม่มีข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้บนอุปกรณ์นี้')).toBeNull();
    } finally {
      h.state.failUnreadableRead = false;
    }
  });
});

describe('N3 Phase 2 UI — Sync Center stays out of it', () => {
  test('the recovery surface wires no Sync Center mutation and names no privileged resolve action', async () => {
    const source = (await import('./ManualReviewOpsPage.tsx?raw')).default;
    expect(source).not.toMatch(/SyncCenter/);
    expect(source).not.toMatch(/SyncStatusBar/);
    for (const forbidden of [
      'resolvePrivileged',
      'retryPrivileged',
      'forcePrivileged',
      'approvePrivileged',
      'overridePrivileged',
      'resubmitPrivileged',
      'ingestAttestedPrivilegedAction',
      'claimPrivilegedEvidenceRow',
      'applyPrivilegedEvidenceDisposition',
      'acknowledgedServerEvidence',
    ]) {
      expect(source, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    // No repair/normalization wording, and no claim about the server's outcome.
    expect(source).not.toContain('ซ่อมข้อมูลสำเร็จ');
    expect(source).not.toContain('ยกเลิกบิลสำเร็จแล้ว');
  });
});
