import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  formatFifoLotDate,
  formatFifoLotExpiry,
  getActiveFifoLots,
} from '../../lib/inventory/fifoQueueUtils';
import { fmtBaht, fmtNum } from '../../lib/stockReport/types';
import type { StockLot } from '../../lib/types';
import './FifoQueueModal.css';

type Props = {
  open: boolean;
  productName: string;
  /** Pre-loaded lots (Stock Report). When omitted, `fetchLots` + `productId` are used. */
  lots?: StockLot[];
  productId?: string;
  branchId?: string | null;
  fetchLots?: (productId: string) => Promise<StockLot[]>;
  /** Raise above nested modals (Product Form). */
  stack?: boolean;
  onClose: () => void;
};

export default function FifoQueueModal({
  open,
  productName,
  lots: lotsProp,
  productId,
  branchId,
  fetchLots,
  stack = false,
  onClose,
}: Props) {
  const [fetchedLots, setFetchedLots] = useState<StockLot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usesFetch = Boolean(fetchLots && productId);

  useEffect(() => {
    if (!open || !usesFetch || !productId || !fetchLots) {
      if (!open) {
        setFetchedLots([]);
        setError(null);
        setLoading(false);
      }
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setFetchedLots([]);

    void fetchLots(productId)
      .then((rows) => {
        if (cancelled) return;
        setFetchedLots(rows);
      })
      .catch((err) => {
        console.error('[FifoQueueModal] fetchLots failed', { productId, branchId, err });
        if (!cancelled) {
          setFetchedLots([]);
          setError('โหลดข้อมูล lot ไม่สำเร็จ');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, usesFetch, productId, branchId, fetchLots]);

  const activeLots = useMemo(() => {
    const source = usesFetch ? fetchedLots : (lotsProp ?? []);
    return getActiveFifoLots(source);
  }, [usesFetch, fetchedLots, lotsProp]);

  const totalRemain = activeLots.reduce((s, l) => s + l.qtyRemaining, 0);

  if (!open) return null;

  return createPortal(
    <div
      className={`fqm-overlay${stack ? ' fqm-overlay--stack' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="fqm-title"
      onClick={onClose}
    >
      <div className="fqm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fqm-header">
          <span className="fqm-title" id="fqm-title">
            FIFO Queue: {productName}
          </span>
          <button type="button" className="fqm-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="fqm-body">
          {loading ? (
            <div className="fqm-loading">กำลังโหลด...</div>
          ) : error ? (
            <div className="fqm-error">{error}</div>
          ) : activeLots.length === 0 ? (
            <div className="fqm-empty">ไม่มี lot คงเหลือ</div>
          ) : (
            <>
              <p className="fqm-summary">
                คงเหลือรวม <b>{fmtNum(totalRemain)}</b> หน่วย จาก <b>{activeLots.length}</b> Lot
              </p>
              {activeLots.map((lot, i) => (
                <div key={lot.id} className={`fqm-lot-item${i === 0 ? ' next' : ''}`}>
                  <div className="fqm-lot-head">
                    <span className="fqm-lot-id">{lot.receivingId || lot.id}</span>
                    {i === 0 ? <span className="fqm-next-label">ตัดออกก่อน</span> : null}
                  </div>
                  <div className="fqm-lot-grid">
                    <div className="fqm-lot-kv">
                      <span>รับเข้า</span>
                      <b>{formatFifoLotDate(lot.receivedAt)}</b>
                    </div>
                    <div className="fqm-lot-kv">
                      <span>วันหมดอายุ</span>
                      <b>{formatFifoLotExpiry(lot.expiryDate)}</b>
                    </div>
                    <div className="fqm-lot-kv">
                      <span>คงเหลือ</span>
                      <b>
                        {fmtNum(lot.qtyRemaining)}/{fmtNum(lot.qtyReceived)}
                      </b>
                    </div>
                    <div className="fqm-lot-kv">
                      <span>ต้นทุน</span>
                      <b className="cost">{fmtBaht(lot.costPerUnit)}</b>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="fqm-footer">
          <button type="button" className="fqm-close-btn" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
