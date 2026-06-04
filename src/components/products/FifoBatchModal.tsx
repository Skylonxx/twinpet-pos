import { useMemo } from 'react';
import type { StockLot } from '../../lib/types';
import { fmtBaht, type FifoLotRow, type ProductListItem } from '../../lib/productCrud/types';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';

type Props = {
  product: ProductListItem;
  lots: StockLot[];
  onClose: () => void;
  onUpdateCost: (lotId: string, cost: number) => void;
};

function buildFifoRows(lots: StockLot[]): FifoLotRow[] {
  const sorted = [...lots].sort((a, b) => a.receivedAt.toDate().getTime() - b.receivedAt.toDate().getTime());
  let order = 1;
  const rows: FifoLotRow[] = [];

  for (const lot of sorted) {
    if (lot.qtyRemaining > 0) {
      rows.push({
        ...lot,
        fifoOrder: order,
        isNext: order === 1,
        grnLabel: lot.receivingId,
      });
      order++;
    }
  }
  for (const lot of sorted) {
    if (lot.qtyRemaining <= 0) {
      rows.push({ ...lot, fifoOrder: null, isNext: false, grnLabel: lot.receivingId });
    }
  }
  return rows;
}

export default function FifoBatchModal({ product, lots, onClose, onUpdateCost }: Props) {
  const rows = useMemo(() => buildFifoRows(lots), [lots]);

  const active = lots.filter((l) => l.qtyRemaining > 0);
  const totalQty = active.reduce((s, l) => s + l.qtyRemaining, 0);
  const totalVal = active.reduce((s, l) => s + l.qtyRemaining * l.costPerUnit, 0);
  const avgCost = totalQty > 0 ? totalVal / totalQty : product.avgCost;
  const nextCost = active[0]?.costPerUnit ?? product.avgCost;

  return (
    <div className="pc-modal-overlay pc-modal-overlay--stack" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="pc-fifo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pc-fifo-head">
          <div>
            <div className="pc-fifo-title">📦 คิวล็อต FIFO — {product.name}</div>
            <div style={{ fontSize: 11, color: 'var(--g400, #888780)', marginTop: 1 }}>
              {product.sku} · {product.barcode ?? '—'}
            </div>
          </div>
          <button type="button" className="pc-fifo-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" />
          </button>
        </div>

        <div className="pc-fifo-summary">
          <div className="pc-fifo-sum-item">
            <span className="pc-fsi-lbl">สต็อกรวม (ฐาน)</span>
            <span className="pc-fsi-val" style={{ color: 'var(--p600, #534ab7)' }}>
              {totalQty} ชิ้น
            </span>
          </div>
          <div className="pc-fifo-sum-item">
            <span className="pc-fsi-lbl">ต้นทุนเฉลี่ยถ่วงน้ำหนัก</span>
            <span className="pc-fsi-val">฿{fmtBaht(avgCost)} / ชิ้น</span>
          </div>
          <div className="pc-fifo-sum-item">
            <span className="pc-fsi-lbl">มูลค่าสต็อกรวม</span>
            <span className="pc-fsi-val" style={{ color: 'var(--green, #1d9e75)' }}>
              ฿{fmtBaht(totalVal)}
            </span>
          </div>
          <div className="pc-fifo-sum-item">
            <span className="pc-fsi-lbl">จำนวน lot ทั้งหมด</span>
            <span className="pc-fsi-val" style={{ color: 'var(--amber, #ba7517)' }}>
              {lots.length} lot
            </span>
          </div>
        </div>

        <div className="pc-fifo-note">
          <i className="ti ti-info-circle" aria-hidden="true" />
          ระบบตัดสต็อกแบบ <strong>FIFO</strong> — lot ที่รับเข้าก่อนถูกตัดออกก่อน &nbsp;|&nbsp; lot ถัดไป:{' '}
          <strong>฿{fmtBaht(nextCost)}/ชิ้น</strong>
        </div>

        <div className="pc-fifo-table-wrap">
          <Table>
            <TableHead className="sticky top-0 z-[1]">
              <TableRow>
                <TableHeadCell className="w-9 text-center">ลำดับ</TableHeadCell>
                <TableHeadCell>วันที่รับเข้า</TableHeadCell>
                <TableHeadCell>เลขอ้างอิง GRN</TableHeadCell>
                <TableHeadCell className="w-[90px] text-right">คงเหลือ (ชิ้น)</TableHeadCell>
                <TableHeadCell className="w-[90px] text-right">รับเข้าทั้งหมด</TableHeadCell>
                <TableHeadCell className="w-[110px] text-right">ต้นทุน/ชิ้น (฿)</TableHeadCell>
                <TableHeadCell className="w-[100px] text-right">มูลค่ารวม (฿)</TableHeadCell>
                <TableHeadCell className="w-20 text-center">สถานะ</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((b) => {
                const depleted = b.qtyRemaining <= 0;
                const partial = !depleted && b.qtyRemaining < b.qtyReceived;
                const rowVal = b.qtyRemaining * b.costPerUnit;
                return (
                  <TableRow key={b.id} className={depleted ? 'opacity-40' : ''}>
                    <TableCell className="text-center">
                      {b.fifoOrder ? (
                        <div className={`pc-lot-order${b.isNext ? ' next' : ''}`}>{b.fifoOrder}</div>
                      ) : (
                        <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <i className="ti ti-check" style={{ fontSize: 12, color: 'var(--g200, #d3d1c7)' }} aria-hidden="true" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {b.receivedAt.toDate().toLocaleDateString('th-TH', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell style={{ fontSize: 11, color: 'var(--p600, #534ab7)', fontWeight: 500 }}>{b.grnLabel}</TableCell>
                    <TableCell
                      className="text-right"
                      style={{ color: depleted ? 'var(--g400)' : partial ? 'var(--amber)' : 'var(--p900)' }}
                    >
                      {b.qtyRemaining}
                    </TableCell>
                    <TableCell className="text-right" style={{ color: 'var(--g400)' }}>
                      {b.qtyReceived}
                    </TableCell>
                    <TableCell className="text-right">
                      {depleted ? (
                        <span style={{ fontFamily: 'Prompt, sans-serif', color: 'var(--g400)' }}>฿{fmtBaht(b.costPerUnit)}</span>
                      ) : (
                        <div className="pc-batch-cost-cell">
                          <span style={{ fontSize: 10, color: 'var(--g400)' }}>฿</span>
                          <input
                            className="pc-batch-cost-inp"
                            type="number"
                            defaultValue={b.costPerUnit}
                            step={0.01}
                            onBlur={(e) => {
                              const v = parseFloat(e.target.value);
                              if (!Number.isNaN(v) && v >= 0 && v !== b.costPerUnit) {
                                onUpdateCost(b.id, v);
                              }
                            }}
                          />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right" style={{ color: depleted ? 'var(--g400)' : 'var(--green)' }}>
                      ฿{fmtBaht(rowVal)}
                    </TableCell>
                    <TableCell className="text-center">
                      {depleted ? (
                        <span className="pc-lot-status pc-lot-depleted">หมดแล้ว</span>
                      ) : partial ? (
                        <span className="pc-lot-status pc-lot-partial">
                          <i className="ti ti-circle-half-2" style={{ fontSize: 10 }} aria-hidden="true" /> กำลังตัด
                        </span>
                      ) : (
                        <span className="pc-lot-status pc-lot-active">
                          <i className="ti ti-circle-check" style={{ fontSize: 10 }} aria-hidden="true" /> พร้อมตัด
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="pc-fifo-footer">
          <div className="pc-fifo-footer-note">
            <i className="ti ti-lock" style={{ fontSize: 12, verticalAlign: -2, color: 'var(--g400)' }} aria-hidden="true" />
            การปรับต้นทุนต่อ lot บันทึก <strong>audit log</strong> อัตโนมัติ
          </div>
          <button type="button" className="pc-close-modal-btn" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}
