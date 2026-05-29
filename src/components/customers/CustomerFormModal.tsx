import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useCustomerTiers } from '../../lib/customers/customerTiers';
import {
  CONTACT_TYPE_OPTIONS,
  customerToForm,
  EMPTY_FORM,
  normalizeCustomerForm,
  type CustomerFormData,
} from '../../lib/customers/types';
import type { ContactType, Customer } from '../../lib/types';
import { DEFAULT_CUSTOMER_TIER } from '../../lib/types';

type Props = {
  open: boolean;
  editCustomer: Customer | null;
  priceLevels: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (form: CustomerFormData) => Promise<void>;
  saving: boolean;
};

function SectionTitle({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="cm-form-section-title">
      <i className={`ti ${icon}`} aria-hidden="true" />
      {children}
    </div>
  );
}

export default function CustomerFormModal({
  open,
  editCustomer,
  priceLevels,
  onClose,
  onSave,
  saving,
}: Props) {
  const [form, setForm] = useState<CustomerFormData>(EMPTY_FORM);
  const { tiers } = useCustomerTiers();

  const tierIds = useMemo(() => new Set(tiers.map((t) => t.id)), [tiers]);
  const customerTypeValue = form.customerType.trim() || DEFAULT_CUSTOMER_TIER;
  const selectValue = tierIds.has(customerTypeValue)
    ? customerTypeValue
    : customerTypeValue !== DEFAULT_CUSTOMER_TIER
      ? customerTypeValue
      : DEFAULT_CUSTOMER_TIER;

  useEffect(() => {
    if (!open) return;
    setForm(editCustomer ? customerToForm(editCustomer) : { ...EMPTY_FORM });
  }, [open, editCustomer]);

  if (!open) return null;

  const set = <K extends keyof CustomerFormData>(key: K, val: CustomerFormData[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const setContactType = (type: ContactType) => {
    setForm((f) => {
      const next = { ...f, contactType: type };
      if (type === 'retail') next.priceLevelId = 'RETAIL';
      return next;
    });
  };

  const isWholesale = form.contactType === 'wholesale';
  const wholesaleLevels = priceLevels.filter((p) => p.id !== 'RETAIL');

  const handleSubmit = () => {
    void onSave(normalizeCustomerForm(form));
  };

  const title = editCustomer ? 'แก้ไขลูกค้า' : 'เพิ่มลูกค้าใหม่';

  return (
    <div className="cm-dialog-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cm-dialog cm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <div className="cm-dialog-header cm-dialog-header-premium">
          <div>
            <span className="cm-dialog-title">{title}</span>
            <span className="cm-dialog-subtitle">Customer · ข้อมูลลูกค้า / สมาชิก</span>
          </div>
          <button type="button" className="cm-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="cm-dialog-body cm-dialog-body-form">
          <section className="cm-form-section">
            <SectionTitle icon="ti-category">ประเภทผู้ติดต่อ</SectionTitle>
            <div className="cm-contact-type-grid">
              {CONTACT_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`cm-contact-type-card${form.contactType === opt.id ? ' selected' : ''}`}
                  onClick={() => setContactType(opt.id)}
                >
                  <span className="cm-contact-type-icon">{opt.icon}</span>
                  <span className="cm-contact-type-label">{opt.label}</span>
                  <span className="cm-contact-type-desc">{opt.desc}</span>
                </button>
              ))}
            </div>
          </section>

          <div className="cm-form-divider" />

          <section className="cm-form-section">
            <SectionTitle icon="ti-user">ข้อมูลทั่วไป</SectionTitle>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  ชื่อ <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={form.firstName}
                  onChange={(e) => set('firstName', e.target.value)}
                  placeholder="ชื่อ"
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">
                  นามสกุล <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={form.lastName}
                  onChange={(e) => set('lastName', e.target.value)}
                  placeholder="นามสกุล"
                />
              </div>
            </div>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  เบอร์โทร <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={form.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  placeholder="08x-xxx-xxxx"
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">อีเมล</label>
                <input
                  className="cm-form-input"
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  placeholder="email@example.com"
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
                placeholder="13 หลัก"
              />
            </div>
            <div className="cm-form-group">
              <label className="cm-form-label">ที่อยู่</label>
              <textarea
                className="cm-form-textarea"
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                rows={2}
                placeholder="ที่อยู่สำหรับออกเอกสาร / ใบกำกับภาษี"
              />
            </div>
          </section>

          <div className="cm-form-divider" />

          <section className="cm-form-section">
            <SectionTitle icon="ti-credit-card">ข้อมูลบัญชี / เครดิต</SectionTitle>
            <div className="cm-form-group">
              <label className="cm-form-label">กลุ่มลูกค้า (Customer Type)</label>
              <select
                className="cm-form-select"
                value={selectValue}
                onChange={(e) => set('customerType', e.target.value)}
              >
                {!tierIds.has(customerTypeValue) && customerTypeValue !== DEFAULT_CUSTOMER_TIER ? (
                  <option value={customerTypeValue}>{customerTypeValue} (ไม่พบในระบบ)</option>
                ) : null}
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.name}
                  </option>
                ))}
              </select>
              <p className="cm-form-hint">
                เลือกจากกลุ่มที่กำหนดใน &quot;จัดการกลุ่มลูกค้า&quot; — ใช้กำหนดราคาพิเศษใน POS
              </p>
            </div>
            {isWholesale ? (
              <div className="cm-form-group">
                <label className="cm-form-label">ระดับราคาขายส่ง</label>
                <select
                  className="cm-form-select"
                  value={form.priceLevelId}
                  onChange={(e) => set('priceLevelId', e.target.value)}
                >
                  {(wholesaleLevels.length ? wholesaleLevels : priceLevels).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="cm-form-hint">ลูกค้าทั่วไปใช้ราคา Retail มาตรฐาน</p>
            )}
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">วงเงินเชื่อ (฿)</label>
                <input
                  className="cm-form-input"
                  type="number"
                  min={0}
                  value={form.creditLimit}
                  onChange={(e) => set('creditLimit', Number(e.target.value))}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">เครดิตเทอม (วัน)</label>
                <input
                  className="cm-form-input"
                  type="number"
                  min={0}
                  value={form.creditDays}
                  onChange={(e) => set('creditDays', Number(e.target.value))}
                />
              </div>
            </div>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">แท็ก</label>
                <input
                  className="cm-form-input"
                  value={form.tags}
                  onChange={(e) => set('tags', e.target.value)}
                  placeholder="VIP, ลูกค้าประจำ..."
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">สถานะ</label>
                <select
                  className="cm-form-select"
                  value={form.isActive ? 'active' : 'inactive'}
                  onChange={(e) => set('isActive', e.target.value === 'active')}
                >
                  <option value="active">ใช้งานอยู่</option>
                  <option value="inactive">ระงับชั่วคราว</option>
                </select>
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
                placeholder="บันทึกเพิ่มเติม..."
              />
            </div>
          </section>
        </div>

        <div className="cm-dialog-footer cm-dialog-footer-premium">
          <button type="button" className="cm-btn cm-btn-ghost" onClick={onClose}>
            ยกเลิก
          </button>
          <button type="button" className="cm-btn cm-btn-primary" disabled={saving} onClick={handleSubmit}>
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>
  );
}
