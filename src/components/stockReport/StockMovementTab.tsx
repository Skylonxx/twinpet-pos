import { useMemo, useState } from 'react';
import ProductImageThumb from '../products/ProductImageThumb';
import { DateRangeDropdown } from '../common/DateRangeDropdown';
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
  in: { icon: 'ti-arrow-bar-to-down', cls: 'sr-mv-in', label: 'รับเข้า', clr: '#3B6D11' },
  out: { icon: 'ti-arrow-bar-up', cls: 'sr-mv-out', label: 'ตัดออก', clr: '#534AB7' },
  adj: { icon: 'ti-adjustments-alt', cls: 'sr-mv-adj', label: 'ปรับสต็อก', clr: '#185FA5' },
  void: { icon: 'ti-arrow-back-up', cls: 'sr-mv-void', label: 'Void คืน', clr: '#A32D2D' },
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
        <div className="sr-table-scroll">
          <table className="sr-table">
            <thead>
              <tr>
                <th>วันที่/เวลา</th>
                <th>รหัส (SKU)</th>
                <th>ชื่อสินค้า</th>
                <th>ประเภท</th>
                <th className="num">จำนวน</th>
                <th className="num">ต้นทุน/หน่วย</th>
                <th className="num">มูลค่า</th>
                <th>เอกสารอ้างอิง</th>
                <th>โดย</th>
              </tr>
            </thead>
            <tbody>
              {filteredMovements.length === 0 ? (
                <tr>
                  <td colSpan={9} className="sr-empty">
                    ไม่พบรายการในช่วงวันที่เลือก
                  </td>
                </tr>
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
                    <tr key={m.id}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                        <div style={{ fontWeight: 500 }}>
                          {d.toLocaleTimeString('th-TH', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>
                          {d.toLocaleDateString('th-TH')}
                        </div>
                      </td>
                      <td className="sr-col-sku">{m.productSku}</td>
                      <td>
                        <div className="sr-prod-cell">
                          <ProductImageThumb
                            imageUrl={m.imageUrl}
                            alt={m.productName}
                            variant="thumb"
                          />
                          <div style={{ fontWeight: 500, fontSize: 13 }}>{m.productName}</div>
                        </div>
                      </td>
                      <td>
                        <div className="sr-mv-cell">
                          <div className={`sr-mv-icon ${meta.cls}`}>
                            <i className={`ti ${meta.icon}`} aria-hidden="true" />
                          </div>
                          <span style={{ fontSize: 12, color: meta.clr }}>{meta.label}</span>
                        </div>
                      </td>
                      <td className="num" style={{ fontWeight: 500, color: qClr }}>
                        {qSign}
                        {fmtNum(Math.abs(m.qty))}
                      </td>
                      <td className="num">{fmtBaht(m.costPerUnit)}</td>
                      <td className="num" style={{ fontWeight: 500 }}>
                        {fmtBaht(Math.abs(m.qty) * m.costPerUnit)}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--info)' }}>{m.refId}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {m.staffName}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
