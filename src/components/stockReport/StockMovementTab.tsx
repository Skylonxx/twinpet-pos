import { useMemo, useState } from 'react';
import ProductImageThumb from '../products/ProductImageThumb';
import { DateRangeDropdown } from '../common/DateRangeDropdown';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';
import { downloadCsv } from '../../lib/stockReport/exportCsv';
import type { DatePreset } from '../../lib/salesHistory/types';
import {
  fmtBaht,
  fmtNum,
  inDateRange,
  monthStartIso,
  todayIso,
  tsToDate,
  type StockReportMovement,
  type StockReportProduct,
} from '../../lib/stockReport/types';

const MV_META = {
  in: { icon: 'ti-arrow-bar-to-down', cls: 'bg-[#eaf3de] text-[#3b6d11]', label: 'รับเข้า', clr: '#3B6D11' },
  out: { icon: 'ti-arrow-bar-up', cls: 'bg-[#eeedfe] text-[#534ab7]', label: 'ตัดออก', clr: '#534AB7' },
  adj: { icon: 'ti-adjustments-alt', cls: 'bg-[#e6f1fb] text-[#185fa5]', label: 'ปรับสต็อก', clr: '#185FA5' },
  void: { icon: 'ti-arrow-back-up', cls: 'bg-[#fcebeb] text-[#a32d2d]', label: 'Void คืน', clr: '#A32D2D' },
} as const;

export default function StockMovementTab({
  products,
  movements,
  categories,
  onToast,
}: {
  products: StockReportProduct[];
  movements: StockReportMovement[];
  categories: string[];
  onToast: (msg: string) => void;
}) {
  const [mvSearch, setMvSearch] = useState('');
  const [mvCat, setMvCat] = useState('');
  const [mvType, setMvType] = useState('');
  const [mvFrom, setMvFrom] = useState(monthStartIso());
  const [mvTo, setMvTo] = useState(todayIso());
  const [mvDatePreset, setMvDatePreset] = useState<DatePreset>('month');

  const filteredMovements = useMemo(() => {
    const q = mvSearch.trim().toLowerCase();
    return movements.filter((m) => {
      const mq = !q || `${m.productName}${m.productSku}${m.refId}`.toLowerCase().includes(q);
      const mc = !mvCat || products.find((p) => p.id === m.productId)?.category === mvCat;
      const mt = !mvType || m.displayType === mvType;
      const md = inDateRange(tsToDate(m.createdAt), mvFrom, mvTo);
      return mq && mc && mt && md;
    });
  }, [movements, mvSearch, mvCat, mvType, mvFrom, mvTo, products]);

  const exportMovementCsv = () => {
    const rows = [
      ['Date', 'Time', 'SKU', 'Product', 'Type', 'Qty', 'Cost/Unit', 'Value', 'Ref', 'By'],
      ...filteredMovements.map((m) => {
        const d = tsToDate(m.createdAt);
        return [
          d.toLocaleDateString('th-TH'),
          d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
          m.productSku,
          m.productName,
          m.displayType,
          String(m.qty),
          String(m.costPerUnit),
          String(Math.abs(m.qty) * m.costPerUnit),
          m.refId,
          m.staffName,
        ];
      }),
    ];
    downloadCsv(rows, 'stock_movement');
    onToast('Export Movement เรียบร้อย');
  };

  return (
    <div className="sr-panel active">
      <div className="sr-toolbar">
        <select className="sr-sel" value={mvCat} onChange={(e) => setMvCat(e.target.value)}>
          <option value="">ทั้งหมด</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="sr-search-wrap">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            placeholder="ค้นหาสินค้า / เลขที่..."
            value={mvSearch}
            onChange={(e) => setMvSearch(e.target.value)}
          />
        </div>
        <select className="sr-sel" value={mvType} onChange={(e) => setMvType(e.target.value)}>
          <option value="">ทุกประเภท</option>
          <option value="in">รับเข้า</option>
          <option value="out">ตัดออก (ขาย)</option>
          <option value="adj">ปรับสต็อก</option>
          <option value="void">Void คืน</option>
        </select>
        <DateRangeDropdown
          preset={mvDatePreset}
          from={mvFrom}
          to={mvTo}
          onChange={({ preset, from, to }) => {
            setMvDatePreset(preset);
            setMvFrom(from);
            setMvTo(to);
          }}
        />
        <button type="button" className="sr-btn sr-btn-ghost sr-btn-sm" onClick={exportMovementCsv}>
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
      </div>
      <div className="sr-card">
        <div className="overflow-x-auto">
          <Table hoverable className="min-w-[600px]">
            <TableHead>
              <TableRow>
                <TableHeadCell>วันที่/เวลา</TableHeadCell>
                <TableHeadCell>รหัส (SKU)</TableHeadCell>
                <TableHeadCell>ชื่อสินค้า</TableHeadCell>
                <TableHeadCell>ประเภท</TableHeadCell>
                <TableHeadCell className="text-right">จำนวน</TableHeadCell>
                <TableHeadCell className="text-right">ต้นทุน/หน่วย</TableHeadCell>
                <TableHeadCell className="text-right">มูลค่า</TableHeadCell>
                <TableHeadCell>เอกสารอ้างอิง</TableHeadCell>
                <TableHeadCell>โดย</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredMovements.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-[13px] text-[var(--text-muted)]"
                  >
                    ไม่พบรายการในช่วงวันที่เลือก
                  </TableCell>
                </TableRow>
              ) : (
                filteredMovements.map((m) => {
                  const meta = MV_META[m.displayType];
                  const d = tsToDate(m.createdAt);
                  const qSign =
                    m.displayType === 'out' || (m.displayType === 'adj' && m.qty < 0)
                      ? '-'
                      : '+';
                  const qClr =
                    m.displayType === 'out' || m.qty < 0 ? 'var(--danger)' : 'var(--success)';
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        <div className="font-medium">
                          {d.toLocaleTimeString('th-TH', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                        <div className="text-[var(--text-muted)]">
                          {d.toLocaleDateString('th-TH')}
                        </div>
                      </TableCell>
                      <TableCell
                        className="whitespace-nowrap text-xs text-[var(--text-secondary)]"
                        style={{ fontFamily: "'Prompt', sans-serif" }}
                      >
                        {m.productSku}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <ProductImageThumb
                            imageUrl={m.imageUrl}
                            alt={m.productName}
                            variant="thumb"
                          />
                          <div className="text-[13px] font-medium">{m.productName}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div
                            className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] ${meta.cls}`}
                          >
                            <i className={`ti ${meta.icon}`} aria-hidden="true" />
                          </div>
                          <span className="text-xs" style={{ color: meta.clr }}>
                            {meta.label}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium" style={{ color: qClr }}>
                        {qSign}
                        {fmtNum(Math.abs(m.qty))}
                      </TableCell>
                      <TableCell className="text-right">{fmtBaht(m.costPerUnit)}</TableCell>
                      <TableCell className="text-right font-medium">
                        {fmtBaht(Math.abs(m.qty) * m.costPerUnit)}
                      </TableCell>
                      <TableCell className="text-xs text-[var(--info)]">{m.refId}</TableCell>
                      <TableCell className="text-xs text-[var(--text-secondary)]">
                        {m.staffName}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
