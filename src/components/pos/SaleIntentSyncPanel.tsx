import { useEffect, useMemo, useRef, useState } from 'react';
import './SaleIntentSyncPanel.css';
import { createSaleIntentJournal } from '../../lib/pos/offline/saleIntentJournal';
import { getDeviceId } from '../../lib/pos/deviceId';
import {
  readDeviceSaleIntentEntries,
  selectDeviceAttentionRows,
  selectDevicePendingSummary,
  type SaleIntentAttentionRow,
} from '../../lib/pos/offline/saleIntentUiSelectors';

// Packet 6 · Device-scoped pending count + journal-sourced failure badge.
//
// UAT UX fix (Packet 6 UX): the wide inline text chips that overflowed the POS
// action toolbar on tablets are replaced by ONE compact icon + numeric badge.
// The full pending/attention detail now lives in a tap-to-open popover so the
// header stays narrow. The badge count remains visible at a glance, so the
// cashier still sees "how many bills are waiting" without opening anything.
//
// Presentation + read-only journal observation ONLY: this panel polls the
// existing Sale Intent Journal on an interval and never calls any of its
// mutating methods (transitionStatus / markManualReview / pruneSaleIntents /
// …). Opening/closing the popover (and click-away / Escape close) is LOCAL
// component state and never touches journal storage — closing it does not
// acknowledge, resolve, or delete anything.
//
// `onStatusChange` reports the current device-local pending/attention snapshot
// UP to the POS page so it can suppress the separate SyncIndicator's misleading
// "ซิงก์แล้ว" success note while local bills are still pending (the two are
// distinct channels: SyncIndicator = server/Firestore sync; this panel = this
// device's local journal). It is an explicit read-only status boundary — it
// carries no journal handle and no mutation.

const POLL_INTERVAL_MS = 5000;

export type SaleIntentPanelStatus = {
  pendingCount: number;
  attentionCount: number;
  isStale: boolean;
};

export default function SaleIntentSyncPanel({
  onStatusChange,
}: {
  onStatusChange?: (status: SaleIntentPanelStatus) => void;
}) {
  const journalRef = useRef(createSaleIntentJournal());
  const deviceId = useMemo(() => getDeviceId(), []);
  const [pending, setPending] = useState<{ count: number; isStale: boolean }>({
    count: 0,
    isStale: false,
  });
  const [attentionRows, setAttentionRows] = useState<SaleIntentAttentionRow[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback in a ref so the polling effect never re-subscribes
  // when the parent passes a new function identity.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const entries = await readDeviceSaleIntentEntries(journalRef.current);
      if (cancelled) return;
      const summary = selectDevicePendingSummary(entries, deviceId, Date.now());
      const rows = selectDeviceAttentionRows(entries, deviceId);
      setPending({ count: summary.count, isStale: summary.isStale });
      setAttentionRows(rows);
      onStatusChangeRef.current?.({
        pendingCount: summary.count,
        attentionCount: rows.length,
        isStale: summary.isStale,
      });
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    window.addEventListener('online', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('online', refresh);
    };
  }, [deviceId]);

  const hasPending = pending.count > 0;
  const hasAttention = attentionRows.length > 0;
  const visible = hasPending || hasAttention;

  // Touch-friendly dismissal: while the popover is open a pointer/tap OUTSIDE the
  // panel closes it, and Escape closes it. Both only flip LOCAL open-state (never
  // a journal write) and are attached only while open, so there is no lingering
  // global keyboard side effect when the popover is closed.
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // If the panel goes idle (nothing pending / no attention) while the popover is
  // open, close it so a stale empty popover never lingers.
  useEffect(() => {
    if (!visible && open) setOpen(false);
  }, [visible, open]);

  if (!visible) return null;

  const tone = hasAttention ? 'attention' : pending.isStale ? 'stale' : 'pending';
  // The badge surfaces the most actionable number: attention (needs a look) wins
  // over a plain pending count.
  const badgeCount = hasAttention ? attentionRows.length : pending.count;

  return (
    <div className="p6ss-panel" data-testid="p6ss-panel" ref={panelRef}>
      <button
        type="button"
        className={`p6ss-trigger p6ss-trigger--${tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="p6ss-trigger"
        title="สถานะบิลในเครื่องนี้ (แตะเพื่อดูรายละเอียด)"
      >
        <i
          className={`ti ${hasAttention ? 'ti-alert-triangle' : 'ti-device-desktop-cog'}`}
          aria-hidden="true"
        />
        <span className="p6ss-trigger-label">{hasAttention ? 'ต้องตรวจสอบ' : 'ค้างซิงก์'}</span>
        <span className="p6ss-badge" data-testid="p6ss-badge">
          {badgeCount}
        </span>
      </button>

      {open && (
        <div
          className="p6ss-popover"
          role="dialog"
          aria-label="สถานะบิลในเครื่องนี้"
          data-testid="p6ss-popover"
        >
          <div className="p6ss-popover-header">
            <span>บิลในเครื่องนี้</span>
            <button
              type="button"
              className="p6ss-popover-close"
              onClick={() => setOpen(false)}
              aria-label="ปิด"
            >
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          </div>

          {hasPending && (
            <div
              className={`p6ss-pending-line${pending.isStale ? ' p6ss-pending-line--stale' : ''}`}
              data-testid="p6ss-pending-line"
            >
              <i className="ti ti-device-desktop-cog" aria-hidden="true" />
              <span>
                {pending.count} บิลในเครื่องนี้รอซิงก์
                {pending.isStale ? ' — ค้างนานผิดปกติ' : ''}
              </span>
            </div>
          )}

          {hasAttention && (
            <div className="p6ss-attention-block">
              <div className="p6ss-attention-title">
                ต้องตรวจสอบ (รายการนี้เป็นข้อมูลอ่านอย่างเดียว)
              </div>
              <ul
                className="p6ss-attention-rows"
                data-testid="p6ss-attention-list"
                aria-label="รายการบิลที่ต้องตรวจสอบ"
              >
                {attentionRows.map((row) => (
                  <li
                    key={row.asyncOrderId}
                    className="p6ss-attention-row"
                    data-testid="p6ss-attention-row"
                  >
                    <div className="p6ss-attention-row-top">
                      <span className="p6ss-attention-bill">{row.billId}</span>
                      <span className="p6ss-attention-amount">
                        {row.totalAmount.toLocaleString('th-TH')} บาท
                      </span>
                    </div>
                    <div className="p6ss-attention-row-bottom">
                      <span className="p6ss-attention-time">
                        {new Date(row.createdAtIso).toLocaleString('th-TH')}
                      </span>
                      <span className="p6ss-attention-status">{row.status}</span>
                    </div>
                    <div className="p6ss-attention-reason">{row.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
