import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createPosSupplier, updatePosSupplier, type PosSupplierForm } from '../../lib/pos/useSuppliers';
import type { Supplier } from '../../lib/types';
import '../../pages/CustomerPage.css';

type Props = {
  open: boolean;
  branchId: string;
  editSupplier?: Supplier | null;
  prefillName?: string;
  onSaved: (supplier: Supplier) => void;
  onClose: () => void;
};

const CM_VARS: React.CSSProperties = {
  '--p50': '#eeedfe',
  '--p100': '#cecbf6',
  '--p400': '#7f77dd',
  '--p600': '#534ab7',
  '--p800': '#3c3489',
  '--p900': '#26215c',
  '--g50': '#f8f8fc',
  '--g100': '#f1efe8',
  '--g200': '#d3d1c7',
  '--g400': '#888780',
  '--g600': '#5f5e5a',
  '--green': '#1d9e75',
  '--red': '#e24b4a',
  '--border': 'rgba(0,0,0,0.08)',
  '--border-md': 'rgba(0,0,0,0.13)',
  '--radius-sm': '6px',
  '--radius-md': '8px',
  '--radius-lg': '12px',
} as React.CSSProperties;

function SectionTitle({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="cm-form-section-title">
      <i className={`ti ${icon}`} aria-hidden="true" />
      {children}
    </div>
  );
}

function supplierToForm(s: Supplier): PosSupplierForm {
  return {
    name: s.name,
    contactName: s.contactName,
    phone: s.phone,
    email: s.email ?? '',
    taxId: s.taxId ?? '',
    address: s.address ?? '',
    bankName: s.bankName ?? '',
    bankAccount: s.bankAccount ?? '',
    note: s.note,
  };
}

function emptyForm(prefillName = ''): PosSupplierForm {
  return {
    name: prefillName,
    contactName: '',
    phone: '',
    email: '',
    taxId: '',
    address: '',
    bankName: '',
    bankAccount: '',
    note: '',
  };
}

export default function PosSupplierModal({
  open,
  branchId,
  editSupplier = null,
  prefillName = '',
  onSaved,
  onClose,
}: Props) {
  const isEdit = editSupplier !== null;
  const [form, setForm] = useState<PosSupplierForm>(() =>
    isEdit ? supplierToForm(editSupplier!) : emptyForm(prefillName),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setForm(editSupplier ? supplierToForm(editSupplier) : emptyForm(prefillName));
    setError(null);
    setSaving(false);
    setTimeout(() => nameRef.current?.focus(), 60);
  }, [open, editSupplier, prefillName]);

  if (!open) return null;

  const set = <K extends keyof PosSupplierForm>(key: K, value: PosSupplierForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setError('กรุณากรอกชื่อผู้จำหน่าย');
      return;
    }
    if (!form.phone.trim()) {
      setError('กรุณากรอกเบอร์โทรศัพท์');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let supplier: Supplier;
      if (isEdit && editSupplier) {
        supplier = await updatePosSupplier(editSupplier, form);
      } else {
        supplier = await createPosSupplier(branchId, form);
      }
      onSaved(supplier);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
      setSaving(false);
    }
  };

  const title = isEdit ? 'แก้ไขข้อมูลผู้จำหน่าย' : 'เพิ่มผู้จำหน่ายใหม่';

  return createPortal(
    <div
      className="cm-dialog-overlay"
      style={{ ...CM_VARS, zIndex: 1100 } as React.CSSProperties}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="cm-dialog cm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <div className="cm-dialog-header cm-dialog-header-premium">
          <div>
            <span className="cm-dialog-title">{title}</span>
            <span className="cm-dialog-subtitle">Supplier · ข้อมูลผู้จำหน่าย / คู่ค้า</span>
          </div>
          <button type="button" className="cm-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="cm-dialog-body cm-dialog-body-form">
          {error && (
            <div style={{
              marginTop: '16px',
              padding: '10px 14px',
              background: '#faece7',
              color: '#993c1d',
              border: '1px solid #facfbd',
              borderRadius: '8px',
              fontSize: '13px',
            }}>
              {error}
            </div>
          )}

          <section className="cm-form-section">
            <SectionTitle icon="ti-user">ข้อมูลทั่วไป</SectionTitle>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  ชื่อบริษัท / ผู้จำหน่าย <span className="cm-form-required">*</span>
                </label>
                <input
                  ref={nameRef}
                  className="cm-form-input"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="บริษัท ท็อปเพ็ท จำกัด"
                  disabled={saving}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">ชื่อผู้ติดต่อ</label>
                <input
                  className="cm-form-input"
                  value={form.contactName}
                  onChange={(e) => set('contactName', e.target.value)}
                  placeholder="คุณสมชาย"
                  disabled={saving}
                />
              </div>
            </div>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  เบอร์โทรศัพท์ <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={form.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  placeholder="081-234-5678"
                  disabled={saving}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">อีเมล</label>
                <input
                  className="cm-form-input"
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  placeholder="supplier@example.com"
                  disabled={saving}
                />
              </div>
            </div>
          </section>

          <div className="cm-form-divider" />

          <section className="cm-form-section">
            <SectionTitle icon="ti-map-pin">ข้อมูลที่อยู่ / ภาษี</SectionTitle>
            <div className="cm-form-group">
              <label className="cm-form-label">เลขประจำตัวผู้เสียภาษี</label>
              <input
                className="cm-form-input"
                value={form.taxId}
                onChange={(e) => set('taxId', e.target.value)}
                placeholder="0105560000000"
                disabled={saving}
              />
            </div>
            <div className="cm-form-group">
              <label className="cm-form-label">ที่อยู่</label>
              <textarea
                className="cm-form-textarea"
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                rows={2}
                placeholder="ที่อยู่บริษัทสำหรับออกเอกสาร / ใบกำกับภาษี"
                disabled={saving}
              />
            </div>
          </section>

          <div className="cm-form-divider" />

          <section className="cm-form-section">
            <SectionTitle icon="ti-building-bank">ข้อมูลบัญชีธนาคาร</SectionTitle>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">ชื่อธนาคาร</label>
                <input
                  className="cm-form-input"
                  value={form.bankName}
                  onChange={(e) => set('bankName', e.target.value)}
                  placeholder="กสิกรไทย / กรุงไทย..."
                  disabled={saving}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">เลขที่บัญชี</label>
                <input
                  className="cm-form-input"
                  value={form.bankAccount}
                  onChange={(e) => set('bankAccount', e.target.value)}
                  placeholder="xxx-x-xxxxx-x"
                  disabled={saving}
                />
              </div>
            </div>
          </section>

          <div className="cm-form-divider" />

          <section className="cm-form-section">
            <SectionTitle icon="ti-notes">หมายเหตุ</SectionTitle>
            <div className="cm-form-group">
              <textarea
                className="cm-form-textarea"
                value={form.note}
                onChange={(e) => set('note', e.target.value)}
                rows={2}
                placeholder="หมายเหตุ / สถานะ"
                disabled={saving}
              />
            </div>
          </section>
        </div>

        <div className="cm-dialog-footer cm-dialog-footer-premium">
          <button type="button" className="cm-btn cm-btn-ghost" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="cm-btn cm-btn-primary"
            disabled={saving}
            onClick={() => void handleSubmit()}
          >
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
