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
// Presentation + read-only journal observation ONLY: this panel polls the
// existing Sale Intent Journal on an interval and never calls any of its
// mutating methods (transitionStatus / markManualReview / pruneSaleIntents /
// …). Expanding/collapsing the failed-sale list is local component state and
// never touches journal storage — closing it does not acknowledge, resolve,
// or delete anything.

const POLL_INTERVAL_MS = 5000;

export default function SaleIntentSyncPanel() {
  const journalRef = useRef(createSaleIntentJournal());
  const deviceId = useMemo(() => getDeviceId(), []);
  const [pending, setPending] = useState<{ count: number; isStale: boolean }>({
    count: 0,
    isStale: false,
  });
  const [attentionRows, setAttentionRows] = useState<SaleIntentAttentionRow[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const entries = await readDeviceSaleIntentEntries(journalRef.current);
      if (cancelled) return;
      const summary = selectDevicePendingSummary(entries, deviceId, Date.now());
      setPending({ count: summary.count, isStale: summary.isStale });
      setAttentionRows(selectDeviceAttentionRows(entries, deviceId));
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

  const hasAttention = attentionRows.length > 0;

  return (
    <div className="p6ss-panel" data-testid="p6ss-panel">
      {pending.count > 0 && (
        <div
          className={`p6ss-chip p6ss-chip--pending${pending.isStale ? ' p6ss-chip--stale' : ''}`}
          role="status"
          aria-live="polite"
          data-testid="p6ss-pending-chip"
          title="บิลที่บันทึกในเครื่องนี้ กำลังรอส่งขึ้นเซิร์ฟเวอร์"
        >
          <i className="ti ti-device-desktop-cog" aria-hidden="true" />
          <span>
            {pending.count} บิลรอซิงก์ (เครื่องนี้)
            {pending.isStale ? ' — ค้างนานผิดปกติ' : ''}
          </span>
        </div>
      )}

      {hasAttention && (
        <button
          type="button"
          className="p6ss-chip p6ss-chip--attention"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="p6ss-attention-badge"
          title="มีบิลที่ต้องตรวจสอบด้วยตนเอง — การขายยังสมบูรณ์ ไม่ใช่ใบเสร็จเสีย"
        >
          <i className="ti ti-alert-triangle" aria-hidden="true" />
          <span>{attentionRows.length} บิลต้องตรวจสอบ</span>
        </button>
      )}

      {hasAttention && expanded && (
        <div className="p6ss-attention-list" role="region" aria-label="รายการบิลที่ต้องตรวจสอบ" data-testid="p6ss-attention-list">
          <div className="p6ss-attention-header">
            <span>บิลที่ต้องตรวจสอบ (รายการนี้เป็นข้อมูลอ่านอย่างเดียว)</span>
            <button
              type="button"
              className="p6ss-attention-close"
              onClick={() => setExpanded(false)}
              aria-label="ปิด"
            >
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          </div>
          <ul className="p6ss-attention-rows">
            {attentionRows.map((row) => (
              <li key={row.asyncOrderId} className="p6ss-attention-row" data-testid="p6ss-attention-row">
                <div className="p6ss-attention-row-top">
                  <span className="p6ss-attention-bill">{row.billId}</span>
                  <span className="p6ss-attention-amount">{row.totalAmount.toLocaleString('th-TH')} บาท</span>
                </div>
                <div className="p6ss-attention-row-bottom">
                  <span className="p6ss-attention-time">{new Date(row.createdAtIso).toLocaleString('th-TH')}</span>
                  <span className="p6ss-attention-status">{row.status}</span>
                </div>
                <div className="p6ss-attention-reason">{row.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
