import { useEffect, useState } from 'react';
import './ReceivingVoidDialog.css';

const VOID_REASONS = [
  'บันทึกผิด / ข้อมูลไม่ถูกต้อง',
  'ซัพพลายเออร์ยกเลิกการส่ง',
  'สินค้าไม่ตรงตามใบสั่งซื้อ',
  'รับเข้าซ้ำ',
  'อื่นๆ',
];

type ReceivingVoidDialogProps = {
  open: boolean;
  grnId: string | null;
  processing: boolean;
  onClose: () => void;
  onConfirm: (reason: string, note: string) => void;
};

export default function ReceivingVoidDialog({
  open,
  grnId,
  processing,
  onClose,
  onConfirm,
}: ReceivingVoidDialogProps) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
    }
  }, [open]);

  if (!open || !grnId) return null;

  return (
    <div className="rcv-void-overlay" role="dialog" aria-modal="true">
      <div className="rcv-void-modal">
        <div className="rcv-void-modal-icon">
          <i className="ti ti-ban" aria-hidden="true" />
        </div>
        <div className="rcv-void-modal-title">ยืนยันการยกเลิกบิล</div>
        <div className="rcv-void-modal-sub">
          เอกสาร {grnId} จะถูกเปลี่ยนสถานะเป็น &quot;ยกเลิก&quot;
          <br />
          ระบบจะคืนสต็อกที่รับเข้าแล้ว และเก็บเอกสารไว้ในประวัติ
        </div>
        <div className="rcv-void-field">
          <label>
            เหตุผลการยกเลิก <span className="rcv-void-req">*</span>
          </label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">เลือกเหตุผล</option>
            {VOID_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="rcv-void-field">
          <label>หมายเหตุเพิ่มเติม</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="ระบุรายละเอียดเพิ่มเติม..."
          />
        </div>
        <div className="rcv-void-actions">
          <button type="button" className="rcv-void-cancel" onClick={onClose} disabled={processing}>
            ปิด
          </button>
          <button
            type="button"
            className="rcv-void-confirm"
            disabled={!reason || processing}
            onClick={() => onConfirm(reason, note)}
          >
            {processing ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิกบิล'}
          </button>
        </div>
      </div>
    </div>
  );
}
