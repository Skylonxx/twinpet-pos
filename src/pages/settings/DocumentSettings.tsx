import { useCallback, useState } from 'react';
import {
  CURRENCY_OPTIONS,
  DOC_PREFIX_FIELDS,
  LINE_PREFIX_FIELDS,
  TAX_TYPE_OPTIONS,
  type DocumentPrefixes,
  type LinePrefixes,
  type SystemSettingsForm,
} from '../../lib/settings/systemTypes';
import { useSystemSettings } from '../../lib/settings/useSystemSettings';
import './DocumentSettings.css';

type DocTab = 'general' | 'docPrefix' | 'linePrefix' | 'other';

const TABS: { id: DocTab; label: string; icon: string }[] = [
  { id: 'general', label: 'ทั่วไป & ภาษี', icon: 'ti-receipt-tax' },
  { id: 'docPrefix', label: 'คำนำหน้าเอกสาร', icon: 'ti-file-invoice' },
  { id: 'linePrefix', label: 'คำนำหน้ารายการ', icon: 'ti-list-numbers' },
  { id: 'other', label: 'อื่นๆ', icon: 'ti-dots' },
];

const MONTH_OPTIONS = [
  { value: 1, label: 'มกราคม' },
  { value: 2, label: 'กุมภาพันธ์' },
  { value: 3, label: 'มีนาคม' },
  { value: 4, label: 'เมษายน' },
  { value: 5, label: 'พฤษภาคม' },
  { value: 6, label: 'มิถุนายน' },
  { value: 7, label: 'กรกฎาคม' },
  { value: 8, label: 'สิงหาคม' },
  { value: 9, label: 'กันยายน' },
  { value: 10, label: 'ตุลาคม' },
  { value: 11, label: 'พฤศจิกายน' },
  { value: 12, label: 'ธันวาคม' },
];

export default function DocumentSettings() {
  const { form, loading, saving, updateForm, save, cancel, isDirty } = useSystemSettings();
  const [tab, setTab] = useState<DocTab>('general');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warn' } | null>(null);

  const showToast = useCallback((msg: string, type: 'success' | 'warn' = 'success') => {
    setToast({ msg, type });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const set = useCallback(
    <K extends keyof SystemSettingsForm>(key: K, val: SystemSettingsForm[K]) => {
      updateForm({ [key]: val });
    },
    [updateForm],
  );

  const setDocPrefix = (key: keyof DocumentPrefixes, val: string) => {
    if (!form) return;
    updateForm({ docPrefixes: { ...form.docPrefixes, [key]: val } });
  };

  const setLinePrefix = (key: keyof LinePrefixes, val: string) => {
    if (!form) return;
    updateForm({ linePrefixes: { ...form.linePrefixes, [key]: val } });
  };

  const handleCurrencyChange = (code: string) => {
    const cur = CURRENCY_OPTIONS.find((c) => c.code === code);
    if (!cur || !form) return;
    updateForm({
      currencyCode: cur.code,
      currencySymbol: cur.symbol,
      currencyName: cur.name,
    });
  };

  const handleSave = async () => {
    try {
      await save();
      showToast('บันทึกการตั้งค่าเรียบร้อย', 'success');
    } catch {
      showToast('บันทึกไม่สำเร็จ', 'warn');
    }
  };

  const handleCancel = () => {
    cancel();
    showToast('ยกเลิกการเปลี่ยนแปลง', 'warn');
  };

  if (loading || !form) {
    return (
      <div className="docstg-page">
        <div className="docstg-loading">กำลังโหลดการตั้งค่า...</div>
      </div>
    );
  }

  return (
    <div className="docstg-page">
      <div className="docstg-header">
        <div>
          <div className="docstg-title">ตั้งค่าทั่วไป & เอกสาร</div>
          <div className="docstg-sub">การตั้งค่าระดับระบบ — ภาษี สกุลเงิน และคำนำหน้าเอกสาร</div>
        </div>
        <div className="docstg-header-actions">
          <button
            type="button"
            className="docstg-btn docstg-btn-ghost"
            onClick={handleCancel}
            disabled={!isDirty() || saving}
          >
            ยกเลิก
          </button>
          <button
            type="button"
            className="docstg-btn docstg-btn-primary"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            <i className="ti ti-device-floppy" aria-hidden="true" />
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>

      <div className="docstg-tabs" role="tablist" aria-label="แท็บตั้งค่า">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`docstg-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <i className={`ti ${t.icon}`} aria-hidden="true" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="docstg-content">
        {tab === 'general' ? (
          <>
            <div className="docstg-section-title">ประเภทภาษี & อัตรา VAT</div>
            <div className="docstg-section-sub">กำหนดวิธีคิดภาษีและอัตราภาษีมูลค่าเพิ่มสำหรับทั้งระบบ</div>

            <div className="docstg-card">
              <div className="docstg-card-head">
                <i className="ti ti-receipt-tax" aria-hidden="true" /> ประเภทภาษี
              </div>
              <div className="docstg-card-body">
                <div className="docstg-radio-group">
                  {TAX_TYPE_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      className={`docstg-radio-card${form.taxType === opt.value ? ' selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="taxType"
                        value={opt.value}
                        checked={form.taxType === opt.value}
                        onChange={() => set('taxType', opt.value)}
                      />
                      <div>
                        <div className="docstg-radio-label">{opt.label}</div>
                        <div className="docstg-radio-desc">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>

                {form.taxType !== 'no_vat' ? (
                  <div className="docstg-form-group" style={{ marginTop: 16 }}>
                    <label className="docstg-form-label">อัตราภาษี VAT (%)</label>
                    <input
                      className="docstg-form-input docstg-input-sm"
                      type="number"
                      min={0}
                      max={100}
                      step={0.01}
                      value={form.vatRate}
                      onChange={(e) => set('vatRate', Number(e.target.value) || 0)}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <div className="docstg-card">
              <div className="docstg-card-head">
                <i className="ti ti-currency-baht" aria-hidden="true" /> สกุลเงิน
              </div>
              <div className="docstg-card-body">
                <div className="docstg-form-row">
                  <div className="docstg-form-group">
                    <label className="docstg-form-label">สกุลเงิน</label>
                    <select
                      className="docstg-form-input"
                      value={form.currencyCode}
                      onChange={(e) => handleCurrencyChange(e.target.value)}
                    >
                      {CURRENCY_OPTIONS.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code} — {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="docstg-form-group">
                    <label className="docstg-form-label">สัญลักษณ์</label>
                    <input
                      className="docstg-form-input docstg-readonly"
                      value={form.currencySymbol}
                      readOnly
                    />
                  </div>
                </div>
                <div className="docstg-preview-box">
                  ตัวอย่าง: {form.currencySymbol}1,234.50 ({form.currencyName})
                </div>
              </div>
            </div>

            <div className="docstg-card">
              <div className="docstg-card-head">
                <i className="ti ti-note" aria-hidden="true" /> หมายเหตุทั่วไป
              </div>
              <div className="docstg-card-body">
                <div className="docstg-form-group">
                  <label className="docstg-form-label">ข้อความหมายเหตุ (แสดงบนเอกสาร)</label>
                  <textarea
                    className="docstg-form-textarea"
                    rows={4}
                    value={form.generalNote}
                    onChange={(e) => set('generalNote', e.target.value)}
                    placeholder="เช่น ราคานี้รวมภาษีมูลค่าเพิ่มแล้ว / สินค้าขายแล้วไม่รับคืน"
                  />
                  <span className="docstg-form-hint">
                    ข้อความนี้จะแสดงท้ายเอกสาร A4 และใบเสร็จ (ถ้าเปิดใช้งาน)
                  </span>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {tab === 'docPrefix' ? (
          <>
            <div className="docstg-section-title">คำนำหน้าเอกสาร</div>
            <div className="docstg-section-sub">
              กำหนด prefix สำหรับเลขที่เอกสารแต่ละประเภท — ระบบจะต่อท้ายด้วยวันที่และลำดับ
            </div>

            <div className="docstg-card">
              <div className="docstg-card-head">
                <i className="ti ti-hash" aria-hidden="true" /> Prefix เอกสาร
              </div>
              <div className="docstg-card-body">
                <div className="docstg-prefix-grid">
                  {DOC_PREFIX_FIELDS.map((field) => (
                    <div key={field.key} className="docstg-form-group">
                      <label className="docstg-form-label">{field.label}</label>
                      <input
                        className="docstg-form-input"
                        value={form.docPrefixes[field.key]}
                        onChange={(e) => setDocPrefix(field.key, e.target.value.toUpperCase())}
                        placeholder={field.hint}
                        maxLength={8}
                      />
                      <span className="docstg-form-hint">{field.hint}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        ) : null}

        {tab === 'linePrefix' ? (
          <>
            <div className="docstg-section-title">คำนำหน้ารายการ</div>
            <div className="docstg-section-sub">
              กำหนด prefix สำหรับรหัสสินค้า บาร์โค้ด และหมายเลขติดตามสต็อก
            </div>

            <div className="docstg-card">
              <div className="docstg-card-head">
                <i className="ti ti-barcode" aria-hidden="true" /> Prefix รายการ
              </div>
              <div className="docstg-card-body">
                <div className="docstg-prefix-grid docstg-prefix-grid-2">
                  {LINE_PREFIX_FIELDS.map((field) => (
                    <div key={field.key} className="docstg-form-group">
                      <label className="docstg-form-label">{field.label}</label>
                      <input
                        className="docstg-form-input"
                        value={form.linePrefixes[field.key]}
                        onChange={(e) => setLinePrefix(field.key, e.target.value.toUpperCase())}
                        placeholder={field.hint}
                        maxLength={8}
                      />
                      <span className="docstg-form-hint">{field.hint}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        ) : null}

        {tab === 'other' ? (
          <>
            <div className="docstg-section-title">การตั้งค่าอื่นๆ</div>
            <div className="docstg-section-sub">รูปแบบวันที่ ลำดับเลขเอกสาร และปีบัญชี</div>

            <div className="docstg-card">
              <div className="docstg-card-head">
                <i className="ti ti-calendar" aria-hidden="true" /> รูปแบบ & ลำดับ
              </div>
              <div className="docstg-card-body">
                <div className="docstg-form-row">
                  <div className="docstg-form-group">
                    <label className="docstg-form-label">รูปแบบวันที่</label>
                    <select
                      className="docstg-form-input"
                      value={form.dateFormat}
                      onChange={(e) => set('dateFormat', e.target.value)}
                    >
                      <option value="dd/MM/yyyy">dd/MM/yyyy (25/05/2026)</option>
                      <option value="dd-MM-yyyy">dd-MM-yyyy (25-05-2026)</option>
                      <option value="yyyy-MM-dd">yyyy-MM-dd (2026-05-25)</option>
                    </select>
                  </div>
                  <div className="docstg-form-group">
                    <label className="docstg-form-label">จำนวนหลักลำดับเอกสาร</label>
                    <input
                      className="docstg-form-input"
                      type="number"
                      min={2}
                      max={8}
                      value={form.docNumberPadding}
                      onChange={(e) => set('docNumberPadding', Number(e.target.value) || 4)}
                    />
                    <span className="docstg-form-hint">
                      ตัวอย่าง: {form.docPrefixes.salesReceipt}-20250526-
                      {String(1).padStart(form.docNumberPadding, '0')}
                    </span>
                  </div>
                </div>

                <div className="docstg-form-row">
                  <div className="docstg-form-group">
                    <label className="docstg-form-label">เดือนเริ่มต้นปีบัญชี</label>
                    <select
                      className="docstg-form-input"
                      value={form.fiscalYearStartMonth}
                      onChange={(e) => set('fiscalYearStartMonth', Number(e.target.value))}
                    >
                      {MONTH_OPTIONS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="docstg-form-group">
                    <label className="docstg-form-label">ข้อความลายน้ำสำเนา</label>
                    <input
                      className="docstg-form-input"
                      value={form.copyWatermark}
                      onChange={(e) => set('copyWatermark', e.target.value)}
                      placeholder="สำเนา / COPY"
                    />
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {toast ? (
        <div className="docstg-toast-wrap">
          <div className={`docstg-toast ${toast.type}`}>
            <i
              className={`ti ${toast.type === 'success' ? 'ti-circle-check' : 'ti-alert-triangle'}`}
              aria-hidden="true"
            />
            {toast.msg}
          </div>
        </div>
      ) : null}
    </div>
  );
}
