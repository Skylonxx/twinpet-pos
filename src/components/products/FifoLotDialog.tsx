import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmtBaht, type ProductListItem } from '../../lib/productCrud/types';
import type { StockLot } from '../../lib/types';

type Props = {
  open: boolean;
  product: ProductListItem;
  fetchLots: (productId: string) => Promise<StockLot[]>;
  onClose: () => void;
};

function parseDate(d: unknown): Date {
  if (
    d != null &&
    typeof d === 'object' &&
    'toDate' in d &&
    typeof (d as { toDate: unknown }).toDate === 'function'
  ) {
    return (d as { toDate: () => Date }).toDate();
  }
  if (d instanceof Date) return d;
  if (
    d != null &&
    typeof d === 'object' &&
    'seconds' in d &&
    typeof (d as { seconds: unknown }).seconds === 'number'
  ) {
    return new Date((d as { seconds: number }).seconds * 1000);
  }
  return new Date(0);
}

export default function FifoLotDialog({ open, product, fetchLots, onClose }: Props) {
  const [lots, setLots] = useState<StockLot[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void fetchLots(product.id)
      .then((rows) => {
        if (!cancelled) setLots(rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, product.id, fetchLots]);

  const activeLots = useMemo(
    () =>
      lots
        .filter((l) => !l.isDepleted && l.qtyRemaining > 0)
        .sort((a, b) => parseDate(a.receivedAt).getTime() - parseDate(b.receivedAt).getTime()),
    [lots],
  );

  if (!open) return null;

  return createPortal(
    <div className="pc-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="pc-fifo-lot-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pc-fifo-head">
          <div>
            <div className="pc-fifo-title">คิวล็อต FIFO — {product.name}</div>
            <div style={{ fontSize: 11, color: 'var(--g400, #888780)', marginTop: 1 }}>
              {product.sku} · เรียงตามวันที่รับเข้า (เก่าก่อน)
            </div>
          </div>
          <button type="button" className="pc-fifo-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" />
          </button>
        </div>

        <div className="pc-fifo-lot-body">
          {loading ? (
            <div className="pc-fifo-lot-loading">กำลังโหลด...</div>
          ) : activeLots.length === 0 ? (
            <div className="pc-fifo-lot-empty">ไม่มี lot คงเหลือ</div>
          ) : (
            <table className="pc-fifo-lot-table">
              <thead>
                <tr>
                  <th>วันที่รับเข้า</th>
                  <th className="r">ต้นทุน/หน่วย</th>
                  <th className="r">คงเหลือ</th>
                </tr>
              </thead>
              <tbody>
                {activeLots.map((lot) => (
                  <tr key={lot.id}>
                    <td>
                      {parseDate(lot.receivedAt).toLocaleDateString('th-TH', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="r">฿{fmtBaht(lot.costPerUnit)}</td>
                    <td className="r">{lot.qtyRemaining}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="pc-fifo-footer">
          <button type="button" className="pc-close-modal-btn" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
