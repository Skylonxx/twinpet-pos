// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_NAME_TH,
  SYNC_CENTER_CHANNEL_ORDER,
  VOID_TERMINAL_REASON_TH,
  buildSyncCenterAggregate,
  resolveActiveSyncScope,
  type SyncCenterReadResult,
  type SyncCenterRow,
  type SyncCenterView,
} from '../lib/pos/offline/syncCenterModel';
import type { UseSyncCenterStateResult } from '../hooks/pos/useSyncCenterState';
import type { VoidTerminalReason } from '../lib/pos/offline/voidIntentStore';
import pageSource from './SyncCenterPage.tsx?raw';

const auth = vi.hoisted(() => ({
  role: 'manager' as 'manager' | 'staff' | 'admin',
  branchId: 'A' as string | null,
}));

const hook = vi.hoisted(() => ({
  current: null as UseSyncCenterStateResult | null,
}));

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { role: auth.role, name: 'Tester' },
    branchId: auth.branchId,
  }),
}));

vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branch: { name: 'สาขาทดสอบ' }, branchId: 'A' }),
}));

vi.mock('../lib/firebase', () => ({
  isFirebaseConfigured: true,
}));

vi.mock('../lib/pos/deviceId', () => ({
  getDeviceId: () => 'X',
}));

vi.mock('../hooks/pos/useSyncCenterState', () => ({
  useSyncCenterState: () => {
    if (!hook.current) throw new Error('hook fixture missing');
    return hook.current;
  },
}));

import SyncCenterPage from './SyncCenterPage';

const NOW = 1_700_000_000_000;

function scopeA() {
  const r = resolveActiveSyncScope('A', 'X');
  if (!r.ok) throw new Error(r.reason);
  return r.scope;
}

function emptyRead(over: Partial<SyncCenterReadResult> = {}): SyncCenterReadResult {
  return {
    scope: scopeA(),
    reversal: { ok: true, rows: [] },
    voidIntent: { ok: true, rows: [] },
    shiftClose: { ok: true, rows: [] },
    shiftOpen: { ok: true, rows: [] },
    saleIntent: { ok: true, rows: [] },
    orchestrator: { lastCycle: null, webLocksAvailable: true, ch4AttemptExhaustedIds: [] },
    isOnline: true,
    ...over,
  };
}

function row(over: Partial<SyncCenterRow> & Pick<SyncCenterRow, 'channel' | 'id' | 'state'>): SyncCenterRow {
  return {
    scopeKind: 'branch_device',
    branchId: 'A',
    deviceId: 'X',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    attempts: 1,
    nextEligibleAtMs: NOW + 9_000,
    reasonCode: over.reasonCode ?? over.state,
    reasonTh: over.reasonTh ?? 'รายละเอียด',
    lastErrorAtMs: null,
    isStale: false,
    attemptCeilingReached: false,
    shiftKind: null,
    actionable: [],
    ...over,
  };
}

function fixture(over: Partial<UseSyncCenterStateResult> = {}, view?: SyncCenterView): UseSyncCenterStateResult {
  const aggregate =
    view && view.status === 'scoped'
      ? view.aggregate
      : buildSyncCenterAggregate(emptyRead(), NOW);
  return {
    view: view ?? { status: 'scoped', aggregate },
    status: 'ready',
    refresh: vi.fn(),
    isBusy: false,
    isOnline: true,
    scope: scopeA(),
    actor: { role: auth.role },
    retryItem: vi.fn(async () => ({
      mutation: 'noop' as const,
      mutationReason: 'already_eligible',
      cycle: 'requested' as const,
      rowAfter: null,
    })),
    resweep: vi.fn(async () => ({ accepted: true, reason: null, cycle: 'requested' as const })),
    ...over,
  };
}

function renderPage() {
  return render(createElement(MemoryRouter, null, createElement(SyncCenterPage)));
}

afterEach(() => {
  cleanup();
  hook.current = null;
  auth.role = 'manager';
});

describe('SyncCenterPage', () => {
  it('N-C1 renders all five channels including trusted_resume as อ่านสถานะไม่ได้', () => {
    hook.current = fixture();
    renderPage();
    for (const channel of SYNC_CENTER_CHANNEL_ORDER) {
      expect(screen.getAllByText(CHANNEL_NAME_TH[channel]).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/อ่านสถานะไม่ได้/)).toBeTruthy();
  });

  it('N-C2 each VoidTerminalReason Thai string can render', () => {
    const reasons = Object.keys(VOID_TERMINAL_REASON_TH) as VoidTerminalReason[];
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.rows = reasons.map((reason, i) =>
      row({
        channel: 'void_intent',
        id: `t${i}`,
        state: 'attention',
        reasonCode: 'terminal',
        reasonTh: VOID_TERMINAL_REASON_TH[reason],
      }),
    );
    agg.unifiedAttention = reasons.length;
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    for (const reason of reasons) {
      expect(screen.getAllByText(VOID_TERMINAL_REASON_TH[reason]).length).toBeGreaterThan(0);
    }
  });

  it('N-C4 action feedback is not optimistic success', async () => {
    const retryItem = vi.fn(async () => ({
      mutation: 'cleared' as const,
      mutationReason: 'cleared',
      cycle: 'requested' as const,
      rowAfter: null,
    }));
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.rows = [
      row({
        channel: 'void_intent',
        id: 'v1',
        state: 'waiting_retry',
        actionable: ['item_retry_now'],
      }),
    ];
    agg.unifiedPending = 1;
    hook.current = fixture({ retryItem }, { status: 'scoped', aggregate: agg });
    renderPage();
    const button = screen.getAllByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' })[0];
    button.click();
    expect(await screen.findByText(/รับคำขอแล้ว — กำลังตรวจสอบสถานะจากข้อมูลในเครื่อง/)).toBeTruthy();
    expect(screen.queryByText('ซิงก์สำเร็จ')).toBeNull();
  });

  it('N-C5 page source has no resolveManualReview or callRetryReconcile', () => {
    expect(pageSource).not.toContain('resolveManualReview');
    expect(pageSource).not.toContain('callRetryReconcile');
  });

  it('N-C6 pending status renders a spinner and never a clean empty state', () => {
    hook.current = fixture({ status: 'pending' });
    renderPage();
    expect(screen.getByLabelText('กำลังโหลดศูนย์ซิงก์')).toBeTruthy();
    expect(screen.queryByText('ไม่มีรายการค้าง')).toBeNull();
  });

  it('D2=A contextual shift-close-review link appears for a rejected shift row', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.rows = [
      row({
        channel: 'shift_intent',
        id: 'close:s1',
        state: 'attention',
        shiftKind: 'close',
        reasonCode: 'rejected_manual_attention',
        actionable: ['open_shift_close_review'],
      }),
    ];
    agg.unifiedAttention = 1;
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    const links = screen.getAllByRole('link', { name: /ตรวจสอบการปิดรอบ/ });
    expect(links.some((a) => a.getAttribute('href') === '/shift-close-review')).toBe(true);
  });

  it('null-device shift is labelled ไม่ทราบเครื่อง', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.rows = [
      row({
        channel: 'shift_intent',
        id: 'open:s1',
        state: 'pending',
        deviceId: null,
        scopeKind: 'branch',
        shiftKind: 'open',
      }),
    ];
    agg.unifiedPending = 1;
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    expect(screen.getAllByText('ไม่ทราบเครื่อง').length).toBeGreaterThan(0);
  });

  it('scope_unavailable disables global resweep and shows honest copy', () => {
    hook.current = fixture(
      { scope: null },
      { status: 'scope_unavailable', reason: 'no_branch' },
    );
    renderPage();
    expect(screen.getByText(/ยังไม่ได้เลือกสาขา/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ตรวจสอบและส่งใหม่ทั้งหมด' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('offline disables global resweep and item retry, shows no-request copy, and does not invoke handlers', () => {
    const retryItem = vi.fn();
    const resweep = vi.fn();
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.rows = [
      row({
        channel: 'void_intent',
        id: 'v1',
        state: 'waiting_retry',
        actionable: ['item_retry_now'],
        reasonTh: 'รอส่งใหม่',
      }),
      row({
        channel: 'void_intent',
        id: 'term',
        state: 'attention',
        reasonCode: 'terminal',
        reasonTh: VOID_TERMINAL_REASON_TH.authority_refused,
      }),
      row({
        channel: 'offline_reversal',
        id: 'mr',
        state: 'attention',
        reasonCode: 'manual_review_required',
        actionable: ['open_manual_review'],
      }),
    ];
    agg.unifiedPending = 1;
    agg.unifiedAttention = 2;
    hook.current = fixture({ isOnline: false, retryItem, resweep }, { status: 'scoped', aggregate: agg });
    renderPage();

    expect(screen.getAllByText(VOID_TERMINAL_REASON_TH.authority_refused).length).toBeGreaterThan(0);
    expect(screen.getAllByText('รอส่งใหม่').length).toBeGreaterThan(0);
    expect(screen.getByText('ออฟไลน์ — ส่งหรือตรวจไม่ได้ตอนนี้ ไม่มีคำขอถูกส่ง')).toBeTruthy();

    const resweepButton = screen.getByRole('button', { name: 'ตรวจสอบและส่งใหม่ทั้งหมด' });
    expect(resweepButton).toHaveProperty('disabled', true);
    resweepButton.click();
    expect(resweep).not.toHaveBeenCalled();

    const retryButtons = screen.getAllByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' });
    expect(retryButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    retryButtons.forEach((b) => b.click());
    expect(retryItem).not.toHaveBeenCalled();

    expect(
      screen.getAllByRole('link', { name: 'ดูคำขอยกเลิกบิลที่ไม่ถูกส่ง' }).some(
        (a) => a.getAttribute('href') === '/manual-review',
      ),
    ).toBe(true);
    expect(
      screen.getAllByRole('link', { name: 'ตรวจสอบด้วยตนเอง' }).some(
        (a) => a.getAttribute('href') === '/manual-review',
      ),
    ).toBe(true);
  });

  it('offline view and navigation do not call Manual Review resolver APIs', () => {
    expect(pageSource).not.toContain('resolveManualReview');
    expect(pageSource).not.toContain('callRetryReconcile');
  });
});

describe('SyncCenterPage — SEC-001 Packet E / E-2 privileged (non-channel) section', () => {
  it('E2-P1 renders a distinct, headed privileged section separate from the five-channel overview', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.privilegedRows = [
      {
        id: 'a'.repeat(32),
        branchId: 'A',
        targetOrderId: 'order-1',
        createdAtMs: NOW,
        updatedAtMs: NOW,
        statusClass: 'manual_attention',
        statusTh: 'ต้องตรวจสอบด้วยตนเอง',
        detailTh: 'ต้องให้เจ้าหน้าที่ตรวจสอบก่อนดำเนินการต่อ',
        attentionClass: 'requires_attention',
        contributesToAttentionCount: true,
        integrityConflict: false,
      },
    ];
    agg.privilegedAttentionCount = 1;
    agg.unifiedAttention = 1;
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    expect(screen.getByRole('heading', { name: /การยกเลิกบิลที่อนุมัติแบบออฟไลน์/ })).toBeTruthy();
    expect(screen.getByText('ต้องตรวจสอบด้วยตนเอง')).toBeTruthy();
    expect(screen.getByText('ต้องให้เจ้าหน้าที่ตรวจสอบก่อนดำเนินการต่อ')).toBeTruthy();
    for (const channel of SYNC_CENTER_CHANNEL_ORDER) {
      expect(screen.getAllByText(CHANNEL_NAME_TH[channel]).length).toBeGreaterThan(0);
    }
  });

  it('E2-P2 display-only: zero action controls render for a privileged row, including a manual-attention one', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.privilegedRows = [
      {
        id: 'a'.repeat(32),
        branchId: 'A',
        targetOrderId: 'order-1',
        createdAtMs: NOW,
        updatedAtMs: NOW,
        statusClass: 'manual_attention',
        statusTh: 'ต้องตรวจสอบด้วยตนเอง',
        detailTh: 'ต้องให้เจ้าหน้าที่ตรวจสอบก่อนดำเนินการต่อ',
        attentionClass: 'requires_attention',
        contributesToAttentionCount: true,
        integrityConflict: false,
      },
    ];
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    const section = screen.getByRole('heading', { name: /การยกเลิกบิลที่อนุมัติแบบออฟไลน์/ }).closest('section')!;
    expect(section.querySelectorAll('button')).toHaveLength(0);
    expect(section.querySelectorAll('a')).toHaveLength(0);
    for (const forbidden of ['แก้ไข', 'Retry', 'Resolve', 'Force']) {
      expect(section.textContent).not.toContain(forbidden);
    }
  });

  it('E2-P3 empty state shows honest copy, not a hidden/absent section', () => {
    hook.current = fixture();
    renderPage();
    expect(screen.getByText('ไม่มีรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์')).toBeTruthy();
  });

  it('E2-P4 unavailable privileged read shows an honest unavailable message, not a false empty state', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.privilegedAvailability = 'unavailable';
    agg.privilegedUnavailableReason = 'อ่านรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์ไม่ได้';
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    expect(screen.getByText('อ่านรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์ไม่ได้')).toBeTruthy();
    expect(screen.queryByText('ไม่มีรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์')).toBeNull();
  });

  it('E2-P5 status is not communicated by color alone: an icon and text both accompany an attention-worthy row', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.privilegedRows = [
      {
        id: 'a'.repeat(32),
        branchId: 'A',
        targetOrderId: 'order-1',
        createdAtMs: NOW,
        updatedAtMs: NOW,
        statusClass: 'uncertain',
        statusTh: 'ผลลัพธ์ยังไม่ชัดเจน — ต้องตรวจสอบ',
        detailTh: 'เซิร์ฟเวอร์รับคำขอไว้แต่ยังสรุปผลไม่ได้ — ต้องให้เจ้าหน้าที่ตรวจสอบ',
        attentionClass: 'requires_attention',
        contributesToAttentionCount: true,
        integrityConflict: false,
      },
    ];
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    expect(screen.getByText('ผลลัพธ์ยังไม่ชัดเจน — ต้องตรวจสอบ')).toBeTruthy();
    const section = screen.getByRole('heading', { name: /การยกเลิกบิลที่อนุมัติแบบออฟไลน์/ }).closest('section')!;
    expect(section.querySelector('.ti-alert-triangle[aria-hidden="true"]')).toBeTruthy();
    expect(section.textContent).toContain('ผลลัพธ์ยังไม่ชัดเจน');
  });

  it('E2-P6 page source names no privileged manual-resolution action and never renders raw journal fields', () => {
    expect(pageSource).not.toContain('resolvePrivileged');
    expect(pageSource).not.toContain('retryPrivileged');
    expect(pageSource).not.toContain('approvePrivileged');
    expect(pageSource).not.toContain('overridePrivileged');
    expect(pageSource).not.toContain('forcePrivileged');
    expect(pageSource).not.toMatch(/\bpaa1Base64\b/);
    expect(pageSource).not.toMatch(/\bssa1Base64\b/);
    expect(pageSource).not.toMatch(/\boacEnvelopeBytesBase64\b/);
    expect(pageSource).not.toMatch(/\bPrivilegedEvidenceJournalRecordV1\b/);
    expect(pageSource).not.toContain('ซิงก์แล้ว');
    expect(pageSource).not.toContain('ซิงก์สำเร็จ');
    expect(pageSource).not.toContain('ส่งข้อมูลเรียบร้อย');
  });

  it('RC-E2-002-P1 an unavailable privileged read (reader unreadableCount fail-closed) never presents the unified count as complete privileged coverage, alongside real ordinary attention', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.rows = [
      row({
        channel: 'void_intent',
        id: 'v1',
        state: 'attention',
        reasonCode: 'terminal',
        reasonTh: VOID_TERMINAL_REASON_TH.authority_refused,
      }),
    ];
    agg.unifiedAttention = 1;
    // Mirrors what buildSyncCenterAggregate produces when the reader's
    // privilegedEvidence channel reports `{ ok: false }` after RC-E2-002's
    // unreadableCount fail-closed — never a partial/healthy row set.
    agg.privilegedRows = [];
    agg.privilegedAvailability = 'unavailable';
    agg.privilegedUnavailableReason = 'อ่านรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์ไม่ได้';
    agg.privilegedAttentionCount = 0;
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    expect(screen.getByText('อ่านรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์ไม่ได้')).toBeTruthy();
    expect(screen.queryByText('ไม่มีรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์')).toBeNull();
    // Ordinary attention still renders honestly alongside the unavailable privileged section.
    expect(screen.getAllByText(VOID_TERMINAL_REASON_TH.authority_refused).length).toBeGreaterThan(0);
  });

  it('RC-E2-002-P2 exact otherwise-clean regression: privileged unavailable never renders global clean or attention-complete copy, and the global unreadable count is truthful and non-zero', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.privilegedAvailability = 'unavailable';
    agg.privilegedUnavailableReason = 'อ่านรายการยกเลิกบิลที่อนุมัติแบบออฟไลน์ไม่ได้';
    agg.privilegedUnavailableCount = 1;
    agg.unavailableSourceCount = 1;
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    // 4. no unconditional global "ไม่มีรายการค้าง"
    expect(screen.queryByText('ไม่มีรายการค้าง')).toBeNull();
    // 5. no unconditional global "ไม่มีรายการที่ต้องตรวจสอบ" — attention is
    // empty but that must not be presented as proof every source was read.
    expect(screen.queryByText('ไม่มีรายการที่ต้องตรวจสอบ')).toBeNull();
    expect(screen.getByText('ไม่พบรายการ แต่บางแหล่งข้อมูลอ่านไม่ได้')).toBeTruthy();
    // global "อ่านไม่ได้" summary must be non-zero even though every ordinary
    // channel is healthy — it speaks for the privileged section too.
    expect(screen.getByText('อ่านไม่ได้ 1')).toBeTruthy();
  });

  it('E2-P7 the privileged section does not bury ordinary content: pending/attention channel sections still render', () => {
    const agg = buildSyncCenterAggregate(emptyRead(), NOW);
    agg.rows = [
      row({ channel: 'void_intent', id: 'v1', state: 'waiting_retry', actionable: ['item_retry_now'] }),
    ];
    agg.unifiedPending = 1;
    agg.privilegedRows = [
      {
        id: 'a'.repeat(32),
        branchId: 'A',
        targetOrderId: 'order-1',
        createdAtMs: NOW,
        updatedAtMs: NOW,
        statusClass: 'queued',
        statusTh: 'รอส่งไปยังเซิร์ฟเวอร์',
        detailTh: 'บันทึกไว้ในเครื่องแล้ว ยังไม่ได้ส่ง',
        attentionClass: 'none',
        contributesToAttentionCount: false,
        integrityConflict: false,
      },
    ];
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    renderPage();
    expect(screen.getByRole('heading', { name: /การยกเลิกบิลที่อนุมัติแบบออฟไลน์/ })).toBeTruthy();
    expect(screen.getByText('รอส่งไปยังเซิร์ฟเวอร์')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' }).length).toBeGreaterThan(0);
  });
});
