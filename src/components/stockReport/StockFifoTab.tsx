import { useMemo, useState } from 'react';
import ProductImageThumb from '../products/ProductImageThumb';
import ProductPickerDialog from '../products/ProductPickerDialog';
import { DateRangeDropdown } from '../common/DateRangeDropdown';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';
import { formatFifoLotDate, formatFifoLotExpiry } from '../../lib/inventory/fifoQueueUtils';
import { EXPIRY_ALERT_LABELS, type ExpiryAlertLevel } from '../../lib/inventory/expiryPolicyTypes';
import {
  buildFifoTableRows,
  countSystemActiveLots,
  fifoHasActiveToolbarFilters,
  safeLotRemaining,
} from '../../lib/inventory/fifoTableUtils';
import { useExpiryPolicies } from '../../lib/inventory/useExpiryPolicies';
import type { DatePreset } from '../../lib/salesHistory/types';
import { fmtBaht, fmtNum, type StockReportProduct } from '../../lib/stockReport/types';

function ExpiryAlertBadge({
  level,
  daysLeft,
}: {
  level: ExpiryAlertLevel;
  daysLeft: number | null;
}) {
  const map = {
    safe: 'bg-[#e1f5ee] text-[#0f6e56]',
    warning: 'bg-[#faeeda] text-[#854f0b]',
    critical: 'bg-[#fcebeb] text-[#a32d2d]',
  } as const;
  const detail =
    daysLeft == null
      ? null
      : daysLeft < 0
        ? `หมดอายุ ${Math.abs(daysLeft)} วัน`
        : `${daysLeft} วัน`;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-[20px] px-2.5 py-[3px] text-[11px] font-medium ${
        map[level] ?? map.safe
      }`}
    >
      {EXPIRY_ALERT_LABELS[level] ?? EXPIRY_ALERT_LABELS.safe}
      {detail ? ` · ${detail}` : ''}
    </span>
  );
}

export default function StockFifoTab({
  productsWithCogs,
  categories,
  branchId,
  onToast,
}: {
  productsWithCogs: StockReportProduct[];
  categories: string[];
  branchId: string | null;
  onToast: (msg: string) => void;
}) {
  const { policies: expiryPolicies, defaultPolicy } = useExpiryPolicies();

  const [fifoPickedIds, setFifoPickedIds] = useState<Set<string>>(new Set());
  const [showFifoPicker, setShowFifoPicker] = useState(false);
  const [fifoSearch, setFifoSearch] = useState('');
  const [fifoCat, setFifoCat] = useState('');
  const [fifoExpiryFilter, setFifoExpiryFilter] = useState<'' | ExpiryAlertLevel>('');
  const [fifoFrom, setFifoFrom] = useState('');
  const [fifoTo, setFifoTo] = useState('');
  const [fifoDatePreset, setFifoDatePreset] = useState<DatePreset>('custom');

  const fifoSystemActiveLotCount = useMemo(
    () => countSystemActiveLots(productsWithCogs),
    [productsWithCogs],
  );

  const fifoTableRows = useMemo(
    () =>
      buildFifoTableRows({
        products: productsWithCogs,
        policies: expiryPolicies,
        search: fifoSearch,
        category: fifoCat,
        pickedProductIds: fifoPickedIds,
        receivedFrom: fifoFrom,
        receivedTo: fifoTo,
        expiryFilter: fifoExpiryFilter,
      }),
    [
      productsWithCogs,
      expiryPolicies,
      fifoSearch,
      fifoCat,
      fifoPickedIds,
      fifoFrom,
      fifoTo,
      fifoExpiryFilter,
    ],
  );

  const fifoToolbarFiltered = useMemo(
    () =>
      fifoHasActiveToolbarFilters({
        search: fifoSearch,
        category: fifoCat,
        pickedProductIds: fifoPickedIds,
        receivedFrom: fifoFrom,
        receivedTo: fifoTo,
        expiryFilter: fifoExpiryFilter,
      }),
    [fifoSearch, fifoCat, fifoPickedIds, fifoFrom, fifoTo, fifoExpiryFilter],
  );

  const fifoMetrics = useMemo(() => {
    const lotCount = fifoTableRows.length;
    const totalQty = fifoTableRows.reduce((s, r) => s + safeLotRemaining(r.lot), 0);
    const totalValue = fifoTableRows.reduce(
      (s, r) => s + safeLotRemaining(r.lot) * (Number(r.lot.costPerUnit) || 0),
      0,
    );
    const criticalCount = fifoTableRows.filter((r) => r.alertLevel === 'critical').length;
    return { lotCount, totalQty, totalValue, criticalCount };
  }, [fifoTableRows]);

  return (
    <div className="sr-panel active">
      <div className="sr-toolbar">
        <select className="sr-sel" value={fifoCat} onChange={(e) => setFifoCat(e.target.value)}>
          <option value="">ทุกหมวด</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="sr-search-wrap">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            placeholder="ค้นหาสินค้า..."
            value={fifoSearch}
            onChange={(e) => setFifoSearch(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="sr-btn sr-btn-ghost sr-btn-sm"
          onClick={() => setShowFifoPicker(true)}
        >
          <i className="ti ti-list-search" aria-hidden="true" /> เลือกสินค้า
          {fifoPickedIds.size > 0 ? ` (${fifoPickedIds.size})` : ''}
        </button>
        <DateRangeDropdown
          preset={fifoDatePreset}
          from={fifoFrom}
          to={fifoTo}
          onChange={({ preset, from, to }) => {
            setFifoDatePreset(preset);
            setFifoFrom(from);
            setFifoTo(to);
          }}
        />
        <div className="sr-stock-filter">
          {([
            ['', 'ทั้งหมด'],
            ['safe', 'ปลอดภัย'],
            ['warning', 'เฝ้าระวัง'],
            ['critical', 'วิกฤต'],
          ] as const).map(([val, lbl]) => (
            <button
              key={val || 'all'}
              type="button"
              className={`sr-sf${fifoExpiryFilter === val ? ' sr-on' : ''}`}
              onClick={() => setFifoExpiryFilter(val)}
            >
              {lbl}
            </button>
          ))}
        </div>
        <span className="sr-hint">Lot เก่าสุดออกก่อน</span>
      </div>

      {fifoTableRows.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-[var(--text-muted)]">
          {fifoSystemActiveLotCount > 0
            ? fifoToolbarFiltered
              ? 'ไม่มี Lot ตรงกับตัวกรองที่เลือก'
              : 'ไม่สามารถแสดง Lot ได้ — กดรีเฟรชหรือลองอีกครั้ง'
            : productsWithCogs.some((p) => p.qty > 0)
              ? 'มีสต็อกในระบบแต่ยังไม่พบ Lot — รอการซิงค์หรือกดรีเฟรช'
              : 'ยังไม่มี Lot คงเหลือในระบบ'}
        </div>
      ) : (
        <>
          <div className="sr-fifo-metrics">
            <div className="sr-metric-card">
              <div className="sr-metric-label">
                <i className="ti ti-stack" style={{ color: 'var(--p600)' }} aria-hidden="true" />
                Lot ในช่วง
              </div>
              <div className="sr-metric-num" style={{ color: 'var(--p600)' }}>
                {fifoMetrics.lotCount}
              </div>
              <div className="sr-metric-sub">นโยบายเริ่มต้น: {defaultPolicy.name}</div>
            </div>
            <div className="sr-metric-card">
              <div className="sr-metric-label">
                <i className="ti ti-package" style={{ color: 'var(--success)' }} aria-hidden="true" />
                คงเหลือรวม
              </div>
              <div className="sr-metric-num" style={{ color: 'var(--success)' }}>
                {fmtNum(fifoMetrics.totalQty)}
              </div>
              <div className="sr-metric-sub">หน่วย</div>
            </div>
            <div className="sr-metric-card">
              <div className="sr-metric-label">
                <i className="ti ti-calculator" style={{ color: 'var(--info)' }} aria-hidden="true" />
                มูลค่ารวม
              </div>
              <div className="sr-metric-num" style={{ color: 'var(--info)' }}>
                {fmtBaht(Math.round(fifoMetrics.totalValue))}
              </div>
              <div className="sr-metric-sub">จาก Lot ที่แสดง</div>
            </div>
            <div className="sr-metric-card">
              <div className="sr-metric-label">
                <i className="ti ti-alert-triangle" style={{ color: 'var(--danger)' }} aria-hidden="true" />
                วิกฤต
              </div>
              <div className="sr-metric-num" style={{ color: 'var(--danger)' }}>
                {fifoMetrics.criticalCount}
              </div>
              <div className="sr-metric-sub">Lot ใกล้/เลยหมดอายุ</div>
            </div>
          </div>
          <div className="sr-card">
            <div className="overflow-x-auto">
              <Table hoverable className="min-w-[600px]">
                <TableHead>
                  <TableRow>
                    <TableHeadCell className="w-11">#</TableHeadCell>
                    <TableHeadCell>รหัส (SKU)</TableHeadCell>
                    <TableHeadCell>ชื่อสินค้า</TableHeadCell>
                    <TableHeadCell>Lot / GRN</TableHeadCell>
                    <TableHeadCell>วันรับเข้า</TableHeadCell>
                    <TableHeadCell>วันหมดอายุ</TableHeadCell>
                    <TableHeadCell>สถานะ</TableHeadCell>
                    <TableHeadCell className="text-right">คงเหลือ</TableHeadCell>
                    <TableHeadCell className="text-right">ต้นทุน/หน่วย</TableHeadCell>
                    <TableHeadCell className="text-right">มูลค่า</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {fifoTableRows.map((row) => {
                    const { lot, product, fifoIndex, alertLevel, daysLeft } = row;
                    const remain = safeLotRemaining(lot);
                    const received = Number(lot.qtyReceived) || remain;
                    const pct = received > 0 ? Math.round((remain / received) * 100) : 0;
                    return (
                      <TableRow
                        key={lot.id}
                        className={fifoIndex === 1 ? 'bg-[rgba(83,74,183,0.04)]' : undefined}
                      >
                        <TableCell>
                          <div
                            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
                              fifoIndex === 1
                                ? 'bg-[var(--p600)] text-white'
                                : 'bg-[var(--p50)] text-[var(--p600)]'
                            }`}
                          >
                            {fifoIndex}
                          </div>
                        </TableCell>
                        <TableCell
                          className="whitespace-nowrap text-xs text-[var(--text-secondary)]"
                          style={{ fontFamily: "'Prompt', sans-serif" }}
                        >
                          {product.sku}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <ProductImageThumb
                              imageUrl={product.imageUrl}
                              alt={product.name}
                              variant="thumb"
                            />
                            <div>
                              <div className="text-[13px] font-medium">{product.name}</div>
                              {fifoIndex === 1 ? (
                                <span className="inline-block whitespace-nowrap rounded-[20px] bg-[var(--p600)] px-2 py-0.5 text-[10px] text-white">
                                  ตัดออกก่อน
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{lot.receivingId || lot.id}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatFifoLotDate(lot.receivedAt)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatFifoLotExpiry(lot.expiryDate)}
                        </TableCell>
                        <TableCell>
                          <ExpiryAlertBadge level={alertLevel} daysLeft={daysLeft} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="font-medium">{fmtNum(remain)}</div>
                          <div className="text-[11px] text-[var(--text-muted)]">
                            / {fmtNum(received)} ({pct}%)
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {fmtBaht(Number(lot.costPerUnit) || 0)}
                        </TableCell>
                        <TableCell className="text-right font-medium text-[var(--success)]">
                          {fmtBaht(remain * (Number(lot.costPerUnit) || 0))}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}

      <ProductPickerDialog
        open={showFifoPicker}
        branchId={branchId}
        onConfirm={(items) => {
          setFifoPickedIds(new Set(items.map((item) => item.id)));
          setShowFifoPicker(false);
          onToast(`กรอง FIFO ${items.length} รายการที่เลือก`);
        }}
        onClose={() => setShowFifoPicker(false)}
      />
    </div>
  );
}
