/**
 * Persistent read-only sync status in the POS shell header.
 * Does not mount canonical mutation context and hosts no item actions.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSyncCenterState } from '../hooks/pos/useSyncCenterState';
import {
  SCOPE_UNAVAILABLE_COPY,
  aggregateForbidsClean,
} from '../lib/pos/offline/syncCenterModel';

function formatHm(ms: number): string {
  return new Date(ms).toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function SyncStatusBar() {
  const { view, status, isBusy, isOnline } = useSyncCenterState();

  const labelParts: string[] = [];
  let body: ReactNode;

  if (view.status === 'scope_unavailable') {
    const copy = SCOPE_UNAVAILABLE_COPY[view.reason];
    labelParts.push(copy);
    body = (
      <span className="truncate text-xs text-[var(--text-secondary)]" title={copy}>
        {copy}
      </span>
    );
  } else {
    const agg = view.aggregate;
    const pending = agg.unifiedPending;
    const attention = agg.unifiedAttention;
    const unavailable = agg.unavailableChannelCount;
    const syncing = isBusy || agg.rows.some((r) => r.state === 'in_flight');
    const last = agg.lastSyncCheckAtMs;
    const forbidsClean = status === 'pending' || aggregateForbidsClean(agg);

    if (!isOnline) labelParts.push('ออฟไลน์');
    labelParts.push(`รอส่ง ${pending}`);
    if (syncing) labelParts.push('กำลังส่ง');
    if (attention > 0) labelParts.push(`ต้องตรวจสอบ ${attention}`);
    if (unavailable > 0) labelParts.push(`อ่านไม่ได้ ${unavailable}`);
    if (last != null) labelParts.push(`ตรวจสอบล่าสุด ${formatHm(last)}`);
    else labelParts.push('ยังไม่ได้ตรวจสอบ');

    body = (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-secondary)]">
        {!isOnline && (
          <span className="inline-flex items-center gap-1 text-[var(--warn)]">
            <i className="ti ti-wifi-off" aria-hidden="true" />
            <span className="hidden min-[361px]:inline">ออฟไลน์</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`รอส่ง ${pending}`}>
          <i className="ti ti-clock" aria-hidden="true" />
          <span>
            <span className="hidden min-[768px]:inline">รอส่ง </span>
            {pending}
          </span>
        </span>
        {syncing && (
          <span className="hidden min-[1080px]:inline-flex items-center gap-1">
            <i className="ti ti-refresh" aria-hidden="true" />
            กำลังส่ง
          </span>
        )}
        {attention > 0 && (
          <span
            className="inline-flex items-center gap-1 text-[var(--warn)]"
            aria-label={`ต้องตรวจสอบ ${attention}`}
          >
            <i className="ti ti-alert-triangle" aria-hidden="true" />
            <span className="hidden min-[361px]:inline">ต้องตรวจสอบ </span>
            {attention}
          </span>
        )}
        {unavailable > 0 && (
          <span
            className="hidden min-[1080px]:inline text-[var(--warn)]"
            title={agg.channels
              .filter((c) => c.availability === 'unavailable')
              .map((c) => c.channel)
              .join(', ')}
          >
            บางช่องทางอ่านไม่ได้
          </span>
        )}
        {last != null ? (
          <span className="hidden min-[768px]:inline whitespace-nowrap">
            ตรวจสอบล่าสุด {formatHm(last)}
          </span>
        ) : (
          <span className="hidden min-[768px]:inline">ยังไม่ได้ตรวจสอบ</span>
        )}
        {!forbidsClean && pending === 0 && attention === 0 && (
          <span className="hidden min-[1080px]:inline">ไม่มีรายการค้าง</span>
        )}
      </span>
    );
  }

  return (
    <Link
      to="/sync-center"
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--p50)] hover:text-[var(--p600)]"
      aria-label={`ศูนย์ซิงก์: ${labelParts.join(' · ')}`}
    >
      <span role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5">
        <i className="ti ti-refresh-alert shrink-0" aria-hidden="true" />
        {body}
      </span>
    </Link>
  );
}
