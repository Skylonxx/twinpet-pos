import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useOutletContext } from 'react-router-dom';
import { useUomUnits, createUomUnit } from '../lib/settings/useUomUnits';
import { useAuth } from '../lib/hooks/useAuth';
import { navItemBySlug, type SettingsOutletContext } from '../lib/settings/settingsNav';
import {
  NOTIF_EVENTS,
  PAY_METHOD_DEFS,
  type NotifEventKey,
  type SettingsFormData,
  type SettingsSection,
} from '../lib/settings/types';
import { useSettings } from '../lib/settings/useSettings';
import type { PosDevice, PosDeviceType, UomUnit } from '../lib/types';
import ExpiryPolicySettings from './settings/ExpiryPolicySettings';
import PosDevicesSettings from './settings/PosDevicesSettings';
import PriceLevelManager from '../components/admin/PriceLevelManager';
import './SettingsPage.css';

function Toggle({
  checked,
  disabled,
  onChange,
  small,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  small?: boolean;
}) {
  return (
    <label className={`stg-toggle${small ? ' stg-toggle-sm' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="stg-toggle-track" />
      <div className="stg-toggle-thumb" />
    </label>
  );
}

function ReceiptPreview({ form }: { form: SettingsFormData }) {
  const lines = form.receiptHeader.split('\n');
  return (
    <div className="stg-receipt-preview">
      {form.showLogoOnReceipt ? (
        form.receiptLogoUrl ? (
          <div style={{ textAlign: 'center', marginBottom: 6 }}>
            <img
              src={form.receiptLogoUrl}
              alt=""
              style={{ maxWidth: 120, maxHeight: 40, objectFit: 'contain', filter: 'invert(1)', opacity: 0.9 }}
            />
          </div>
        ) : (
          <div style={{ textAlign: 'center', marginBottom: 6, fontSize: 22 }}>🐾</div>
        )
      ) : null}
      {lines.map((l, i) => (
        <div key={i} className={`stg-rp-center${i === 0 ? ' stg-rp-bold' : ''}`}>
          {l}
        </div>
      ))}
      <div className="stg-rp-center" style={{ fontSize: 11, color: '#aaa' }}>
        {form.address.split('\n')[0]}
      </div>
      <div className="stg-rp-center" style={{ fontSize: 11, color: '#aaa' }}>
        Tel: {form.phone}
      </div>
      <div className="stg-rp-divider" />
      <div className="stg-rp-row">
        <span>บิลเลขที่</span>
        <span>TW-0588</span>
      </div>
      <div className="stg-rp-row">
        <span>วันที่</span>
        <span>25/05/2569 14:30</span>
      </div>
      <div className="stg-rp-row">
        <span>พนักงาน</span>
        <span>สมชาย</span>
      </div>
      <div className="stg-rp-divider" />
      <div className="stg-rp-row">
        <span>Royal Canin 3kg</span>
        <span />
      </div>
      <div className="stg-rp-row">
        <span>  1 x ฿480</span>
        <span>฿480</span>
      </div>
      <div className="stg-rp-divider" />
      <div className="stg-rp-row">
        <span>รวม</span>
        <span>฿720</span>
      </div>
      {form.vatRegistered && form.showVatOnReceipt ? (
        <div className="stg-rp-row">
          <span>VAT {form.vatRate}%</span>
          <span>฿47.10</span>
        </div>
      ) : null}
      <div className="stg-rp-row stg-rp-bold">
        <span>ยอดสุทธิ</span>
        <span>฿720</span>
      </div>
      <div className="stg-rp-divider" />
      {form.receiptFooter.split('\n').map((l, i) => (
        <div key={i} className="stg-rp-center" style={{ fontSize: 11 }}>
          {l}
        </div>
      ))}
    </div>
  );
}

function deviceTypeLabel(type: PosDeviceType): string {
  if (type === 'desktop') return 'Desktop';
  if (type === 'tablet') return 'Tablet';
  return 'Mobile';
}

function formatDeviceLastSeen(d: PosDevice): string {
  if (!d.lastSeenAt) return '—';
  const dt = d.lastSeenAt.toDate();
  const now = new Date();
  const isToday = dt.toDateString() === now.toDateString();
  const time = dt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  return isToday ? `วันนี้ ${time}` : dt.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function SettingsPage() {
  const { branchId, user } = useAuth();
  const {
    form,
    updateForm,
    priceLevels,
    setPriceLevels,
    devices,
    loading,
    saving,
    lastSavedAt,
    save,
    cancel,
    isDirty,
    uploadLogo,
    forceLogoutDevice,
    removeDevice,
    addDevice,
  } = useSettings(branchId);

  const {
    units: uomUnits,
    setUnits: setUomUnits,
    saving: uomSaving,
    saveAll: saveUomUnits,
    isDirty: isUomDirty,
    cancel: cancelUom,
  } = useUomUnits();

  // Active section is driven by the URL (unified Settings sidebar), not local state.
  const location = useLocation();
  const slug = location.pathname.split('/').pop() ?? '';
  const section = (navItemBySlug(slug)?.section ?? 'branch') as SettingsSection;

  // Report unsaved-changes upward so SettingsLayout can guard cross-scope nav.
  const { setDirty } = useOutletContext<SettingsOutletContext>();
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'info' | 'warn' } | null>(null);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [dangerAction, setDangerAction] = useState('');
  const [dangerConfirm, setDangerConfirm] = useState('');
  const [newDevice, setNewDevice] = useState({ name: '', token: '', type: 'desktop' as PosDeviceType });
  const branchLogoRef = useRef<HTMLInputElement>(null);
  const receiptLogoRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string, type: 'success' | 'info' | 'warn' = 'info') => {
    setToast({ msg, type });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const handleSave = async () => {
    try {
      await save();
      if (isUomDirty()) {
        await saveUomUnits(uomUnits);
      }
      showToast('บันทึกการตั้งค่าเรียบร้อย', 'success');
    } catch {
      showToast('บันทึกไม่สำเร็จ', 'warn');
    }
  };

  const handleCancel = () => {
    cancel();
    cancelUom();
    showToast('ยกเลิกการเปลี่ยนแปลง', 'info');
  };

  const handleLogoUpload = async (file: File, kind: 'branch' | 'receipt') => {
    try {
      await uploadLogo(file, kind);
      showToast('อัปโหลดโลโก้เรียบร้อย', 'success');
    } catch {
      showToast('อัปโหลดไม่สำเร็จ', 'warn');
    }
  };

  const onlineCount = useMemo(() => devices.filter((d) => d.isOnline).length, [devices]);

  const set = useCallback(
    <K extends keyof SettingsFormData>(key: K, val: SettingsFormData[K]) => {
      updateForm({ [key]: val });
    },
    [updateForm],
  );

  const toggleNotifChannel = (key: NotifEventKey, channel: 'line' | 'email') => {
    if (!form) return;
    const next = { ...form.notifications };
    next[key] = { ...next[key], [channel]: !next[key][channel] };
    updateForm({ notifications: next });
  };

  const addUom = () => {
    setUomUnits([
      ...uomUnits,
      createUomUnit('หน่วยใหม่', { code: 'NEW' }),
    ]);
    showToast('เพิ่มหน่วยนับแล้ว', 'info');
  };

  const removeUom = (id: string) => {
    if (uomUnits.length <= 1) {
      showToast('ต้องมีอย่างน้อย 1 ชื่อหน่วย', 'warn');
      return;
    }
    setUomUnits(uomUnits.filter((x) => x.id !== id));
  };

  const updateUom = (id: string, patch: Partial<UomUnit>) => {
    setUomUnits(uomUnits.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  };

  const formDirty = isDirty() || isUomDirty();
  const formSaving = saving || uomSaving;

  useEffect(() => {
    setDirty(formDirty);
  }, [setDirty, formDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  if (loading || !form) {
    return (
      <div className="stg-page">
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>กำลังโหลด...</div>
      </div>
    );
  }

  const isAdmin = user?.role === 'admin';

  return (
    <div className="stg-page">
      <div className="stg-body">
        <div className="stg-main">
          {/* ── ข้อมูลสาขา ── */}
          {section === 'branch' ? (
            <>
              <div className="stg-section-title">ข้อมูลสาขา</div>
              <div className="stg-section-sub">ชื่อ ที่อยู่ เบอร์ติดต่อ และโลโก้ที่แสดงบนเอกสาร</div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-building-store" aria-hidden="true" /> ข้อมูลพื้นฐาน
                </div>
                <div className="stg-card-body">
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">ชื่อสาขา *</label>
                      <input className="stg-form-input" value={form.name} onChange={(e) => set('name', e.target.value)} />
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">รหัสสาขา</label>
                      <input className="stg-form-input stg-readonly" value={branchId ?? ''} readOnly />
                      <span className="stg-form-hint">สร้างโดยระบบ — ไม่สามารถแก้ไขได้</span>
                    </div>
                  </div>
                  <div className="stg-form-group">
                    <label className="stg-form-label">ที่อยู่สาขา</label>
                    <textarea className="stg-form-textarea" value={form.address} onChange={(e) => set('address', e.target.value)} />
                  </div>
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">เบอร์โทรศัพท์</label>
                      <input className="stg-form-input" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">อีเมล</label>
                      <input className="stg-form-input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
                    </div>
                  </div>
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">เลขประจำตัวผู้เสียภาษี</label>
                      <input className="stg-form-input" value={form.taxId} onChange={(e) => set('taxId', e.target.value)} placeholder="13 หลัก" />
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">เว็บไซต์</label>
                      <input className="stg-form-input" value={form.website} onChange={(e) => set('website', e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-photo" aria-hidden="true" /> โลโก้และรูปสาขา
                </div>
                <div className="stg-card-body">
                  <div className="stg-logo-row">
                    <div className="stg-logo-preview">
                      {form.logoUrl ? <img src={form.logoUrl} alt="" /> : '🐾'}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>โลโก้สาขา</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                        แนะนำ PNG/SVG ขนาด 200×200px ขึ้นไป — ใช้แสดงบนใบเสร็จและเอกสาร
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" onClick={() => branchLogoRef.current?.click()}>
                          <i className="ti ti-upload" aria-hidden="true" /> อัปโหลด
                        </button>
                        {form.logoUrl ? (
                          <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" style={{ color: 'var(--danger)' }} onClick={() => set('logoUrl', null)}>
                            ลบ
                          </button>
                        ) : null}
                      </div>
                      <input ref={branchLogoRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogoUpload(f, 'branch'); e.target.value = ''; }} />
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* ── VAT ── */}
          {section === 'vat' ? (
            <>
              <div className="stg-section-title">VAT &amp; ภาษี</div>
              <div className="stg-section-sub">กำหนดการจดภาษีและอัตราภาษีมูลค่าเพิ่มของสาขา</div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-receipt-tax" aria-hidden="true" /> การจด VAT
                </div>
                <div className="stg-card-body">
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info">
                      <div className="stg-toggle-label">สาขานี้จดทะเบียนภาษีมูลค่าเพิ่ม (VAT)</div>
                      <div className="stg-toggle-desc">เปิด = ออกใบกำกับภาษีได้, ปิด = ออกได้แค่ใบเสร็จรับเงิน</div>
                    </div>
                    <Toggle checked={form.vatRegistered} onChange={(v) => set('vatRegistered', v)} />
                  </div>
                  <div className="stg-form-row" style={{ opacity: form.vatRegistered ? 1 : 0.4, pointerEvents: form.vatRegistered ? 'auto' : 'none' }}>
                    <div className="stg-form-group">
                      <label className="stg-form-label">อัตราภาษี (%)</label>
                      <input className="stg-form-input" type="number" min={0} max={100} step={0.5} value={form.vatRate} onChange={(e) => set('vatRate', Number(e.target.value))} />
                      <span className="stg-form-hint">มาตรฐานประเทศไทย 7%</span>
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">ประเภทราคาสินค้า</label>
                      <select className="stg-form-select" value={form.priceIncludesVat ? 'incl' : 'excl'} onChange={(e) => set('priceIncludesVat', e.target.value === 'incl')}>
                        <option value="excl">ราคาไม่รวม VAT (บวกเพิ่มตอนคิดเงิน)</option>
                        <option value="incl">ราคารวม VAT แล้ว</option>
                      </select>
                    </div>
                  </div>
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info">
                      <div className="stg-toggle-label">แสดงแยก VAT บนใบเสร็จ</div>
                      <div className="stg-toggle-desc">แสดงบรรทัด &quot;ภาษีมูลค่าเพิ่ม 7%&quot; แยกในใบเสร็จ</div>
                    </div>
                    <Toggle checked={form.showVatOnReceipt} onChange={(v) => set('showVatOnReceipt', v)} />
                  </div>
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info">
                      <div className="stg-toggle-label">แสดงเลขประจำตัวผู้เสียภาษีของลูกค้าบนใบกำกับ</div>
                      <div className="stg-toggle-desc">ให้พนักงานกรอก Tax ID ลูกค้าตอนออกใบกำกับ</div>
                    </div>
                    <Toggle checked={form.showCustomerTaxId} onChange={(v) => set('showCustomerTaxId', v)} />
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* ── ระดับราคา ── */}
          {section === 'pricelevel' ? (
            <>
              <div className="stg-section-title">ระดับราคา (Price Level)</div>
              <div className="stg-section-sub">กำหนดระดับราคาที่ใช้ร่วมกันทุกสินค้า — สืบทอดไปยังทุกสาขา</div>
              <PriceLevelManager
                priceLevels={priceLevels}
                setPriceLevels={setPriceLevels}
                showToast={showToast}
              />
            </>
          ) : null}

          {/* ── UOM ── */}
          {section === 'uom' ? (
            <>
              <div className="stg-section-title">UOM &amp; หน่วยนับ</div>
              <div className="stg-section-sub">
                กำหนดชื่อหน่วยนับที่ใช้ในระบบ — ตัวคูณแปลงหน่วย (เช่น 1 กล่อง = 12 ชิ้น) ตั้งแยกในแต่ละสินค้า
              </div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-ruler" aria-hidden="true" /> ชื่อหน่วยทั้งหมด
                  <div className="stg-card-head-right">
                    <button type="button" className="stg-btn stg-btn-primary stg-btn-sm" onClick={addUom}>
                      <i className="ti ti-plus" aria-hidden="true" /> เพิ่มหน่วย
                    </button>
                  </div>
                </div>
                <div className="stg-card-body stg-card-body-flush">
                  <table className="stg-uom-table">
                    <thead>
                      <tr>
                        <th>ชื่อหน่วย</th>
                        <th>รหัสย่อ</th>
                        <th>สถานะ</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {uomUnits.map((u) => (
                        <tr key={u.id}>
                          <td>
                            <input className="stg-form-input stg-input-inline stg-input-w110" value={u.name} onChange={(e) => updateUom(u.id, { name: e.target.value })} />
                          </td>
                          <td>
                            <input className="stg-form-input stg-input-inline stg-input-w70 stg-code" value={u.code} onChange={(e) => updateUom(u.id, { code: e.target.value })} />
                          </td>
                          <td>
                            <Toggle small checked={u.isActive} onChange={(v) => updateUom(u.id, { isActive: v })} />
                          </td>
                          <td>
                            <button type="button" className="stg-icon-btn" onClick={() => removeUom(u.id)} disabled={uomUnits.length <= 1} style={{ opacity: uomUnits.length <= 1 ? 0.3 : 1 }}>
                              <i className="ti ti-trash" style={{ fontSize: 14, color: 'var(--danger)' }} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}

          {section === 'expiryPolicy' ? <ExpiryPolicySettings /> : null}

          {/* ── ช่องทางชำระเงิน ── */}
          {section === 'payment' ? (
            <>
              <div className="stg-section-title">ช่องทางชำระเงิน</div>
              <div className="stg-section-sub">เปิด/ปิดช่องทางที่แสดงบน Modal ชำระเงินของสาขานี้</div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-credit-card" aria-hidden="true" /> ช่องทางที่ใช้งาน
                </div>
                <div className="stg-card-body">
                  {PAY_METHOD_DEFS.map((p) => (
                    <div key={p.key} className="stg-pay-method-row">
                      <div className="stg-pay-icon" style={{ background: p.bg, color: p.color }}>
                        <i className={`ti ${p.icon}`} aria-hidden="true" />
                      </div>
                      <div className="stg-pay-info">
                        <div className="stg-pay-name">{p.label}</div>
                        <div className="stg-pay-desc">{p.desc}</div>
                      </div>
                      <Toggle
                        checked={form.paymentMethods[p.key]}
                        onChange={(v) => set('paymentMethods', { ...form.paymentMethods, [p.key]: v })}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-clock-dollar" aria-hidden="true" /> ตั้งค่าเครดิต (เชื่อ)
                </div>
                <div className="stg-card-body">
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">วงเงินเชื่อสูงสุด / ลูกค้า (฿)</label>
                      <input className="stg-form-input" type="number" min={0} step={100} value={form.defaultCreditLimit} onChange={(e) => set('defaultCreditLimit', Number(e.target.value))} />
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">ระยะเวลาชำระ (วัน)</label>
                      <input className="stg-form-input" type="number" min={1} value={form.defaultCreditDays} onChange={(e) => set('defaultCreditDays', Number(e.target.value))} />
                    </div>
                  </div>
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info">
                      <div className="stg-toggle-label">ต้องการ Admin อนุมัติก่อนให้เชื่อ</div>
                      <div className="stg-toggle-desc">พนักงานจะขอได้แต่ต้องรอ Manager/Admin กด approve</div>
                    </div>
                    <Toggle checked={form.creditRequireApproval} onChange={(v) => set('creditRequireApproval', v)} />
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* ── ใบเสร็จ ── */}
          {section === 'receipt' ? (
            <>
              <div className="stg-section-title">ใบเสร็จ &amp; Invoice</div>
              <div className="stg-section-sub">กำหนด template และข้อความที่แสดงบนใบเสร็จ/ใบกำกับภาษี</div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-printer" aria-hidden="true" /> ใบเสร็จ Thermal 80mm
                </div>
                <div className="stg-card-body">
                  <div className="stg-receipt-logo-row">
                    <div className="stg-receipt-logo-preview">
                      {form.receiptLogoUrl ? <img src={form.receiptLogoUrl} alt="" /> : '🐾'}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>โลโก้บนหัวใบเสร็จ</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>PNG/JPG สีขาว/โมโน แนะนำ — Thermal พิมพ์เป็นขาวดำ</div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" onClick={() => receiptLogoRef.current?.click()}>
                          <i className="ti ti-upload" aria-hidden="true" /> อัปโหลดโลโก้
                        </button>
                        {form.receiptLogoUrl ? (
                          <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" style={{ color: 'var(--danger)' }} onClick={() => set('receiptLogoUrl', null)}>
                            <i className="ti ti-trash" aria-hidden="true" /> ลบ
                          </button>
                        ) : null}
                      </div>
                      <input ref={receiptLogoRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogoUpload(f, 'receipt'); e.target.value = ''; }} />
                    </div>
                    <div className="stg-receipt-logo-toggle">
                      <div className="stg-toggle-row stg-toggle-row-compact">
                        <div className="stg-toggle-info"><div className="stg-toggle-label" style={{ fontSize: 12 }}>แสดงโลโก้บนใบเสร็จ</div></div>
                        <Toggle checked={form.showLogoOnReceipt} onChange={(v) => set('showLogoOnReceipt', v)} />
                      </div>
                    </div>
                  </div>
                  <div className="stg-form-row">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <div className="stg-form-group">
                        <label className="stg-form-label">ข้อความหัวใบเสร็จ</label>
                        <textarea className="stg-form-textarea" rows={2} value={form.receiptHeader} onChange={(e) => set('receiptHeader', e.target.value)} />
                      </div>
                      <div className="stg-form-group">
                        <label className="stg-form-label">ข้อความท้ายใบเสร็จ</label>
                        <textarea className="stg-form-textarea" rows={2} value={form.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} />
                      </div>
                      <div className="stg-toggle-row stg-toggle-row-compact">
                        <div className="stg-toggle-info"><div className="stg-toggle-label">แสดงบาร์โค้ดเลขบิล</div></div>
                        <Toggle checked={form.showBarcodeOnReceipt} onChange={(v) => set('showBarcodeOnReceipt', v)} />
                      </div>
                      <div className="stg-toggle-row stg-toggle-row-compact">
                        <div className="stg-toggle-info"><div className="stg-toggle-label">แสดง QR โปรโมชั่น</div></div>
                        <Toggle checked={form.showQrOnReceipt} onChange={(v) => set('showQrOnReceipt', v)} />
                      </div>
                    </div>
                    <div>
                      <div className="stg-form-label" style={{ marginBottom: 8 }}>ตัวอย่างใบเสร็จ</div>
                      <ReceiptPreview form={form} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-file-invoice" aria-hidden="true" /> ใบกำกับภาษี A4
                </div>
                <div className="stg-card-body">
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">ชื่อบริษัทบนหัวกระดาษ</label>
                      <input className="stg-form-input" value={form.companyName} onChange={(e) => set('companyName', e.target.value)} />
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">รูปแบบเลขเอกสาร</label>
                      <input className="stg-form-input" value={form.invoiceNumberFormat} onChange={(e) => set('invoiceNumberFormat', e.target.value)} />
                      <span className="stg-form-hint">ตัวอย่าง: INV-202605-001</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* ── การแจ้งเตือน ── */}
          {section === 'notification' ? (
            <>
              <div className="stg-section-title">การแจ้งเตือน</div>
              <div className="stg-section-sub">กำหนดเงื่อนไขและช่องทางแจ้งเตือนสำหรับสาขา</div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-bell" aria-hidden="true" /> เหตุการณ์และช่องทาง
                </div>
                <div className="stg-card-body">
                  {NOTIF_EVENTS.map((n) => (
                    <div key={n.key} className="stg-notif-row">
                      <div className="stg-notif-icon" style={{ background: n.bg, color: n.fc }}>
                        <i className={`ti ${n.icon}`} aria-hidden="true" />
                      </div>
                      <div className="stg-notif-info">
                        <div className="stg-notif-label">{n.label}</div>
                        <div className="stg-notif-channels">
                          {(['line', 'email'] as const).map((ch) => (
                            <button
                              key={ch}
                              type="button"
                              className={`stg-notif-chip${form.notifications[n.key][ch] ? ' on' : ''}`}
                              onClick={() => toggleNotifChannel(n.key, ch)}
                            >
                              {ch === 'line' ? 'LINE' : 'Email'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Toggle
                        checked={form.notifications[n.key].line || form.notifications[n.key].email}
                        onChange={(v) => {
                          const next = { ...form.notifications };
                          next[n.key] = { line: v, email: v ? next[n.key].email : false };
                          updateForm({ notifications: next });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-message" aria-hidden="true" /> ตั้งค่า LINE Notify / Webhook
                </div>
                <div className="stg-card-body">
                  <div className="stg-form-group">
                    <label className="stg-form-label">LINE Notify Token</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="stg-form-input" type="password" style={{ flex: 1 }} value={form.lineNotifyToken ?? ''} onChange={(e) => set('lineNotifyToken', e.target.value)} placeholder="xxxxxxxx" />
                      <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" onClick={() => showToast('ส่งข้อความทดสอบแล้ว', 'info')}>
                        ทดสอบ
                      </button>
                    </div>
                  </div>
                  <div className="stg-form-group">
                    <label className="stg-form-label">Webhook URL (Slack / Teams / อื่นๆ)</label>
                    <input className="stg-form-input" type="url" value={form.webhookUrl} onChange={(e) => set('webhookUrl', e.target.value)} placeholder="https://hooks.slack.com/..." />
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* ── เครื่อง POS ── */}
          {section === 'pos' ? (
            <>
              <div className="stg-section-title">เครื่อง POS</div>
              <div className="stg-section-sub">จัดการเครื่อง POS ที่เชื่อมต่อกับสาขานี้</div>
              <PosDevicesSettings branchId={branchId} userId={user?.id ?? null} onToast={showToast} />
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-device-desktop" aria-hidden="true" /> เครื่องที่ลงทะเบียน
                  <div className="stg-card-head-right">
                    <span className="stg-badge stg-badge-ok">{onlineCount} ออนไลน์</span>
                    <button type="button" className="stg-btn stg-btn-primary stg-btn-sm" onClick={() => setAddDeviceOpen(true)}>
                      <i className="ti ti-plus" aria-hidden="true" /> เพิ่มเครื่อง
                    </button>
                  </div>
                </div>
                <div className="stg-card-body">
                  {devices.map((d) => (
                    <div key={d.id} className="stg-device-row">
                      <div className={`stg-device-status ${d.isOnline ? 'stg-ds-online' : 'stg-ds-offline'}`} />
                      <div className="stg-device-info">
                        <div className="stg-device-name">
                          {d.name}{' '}
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>{deviceTypeLabel(d.type)}</span>
                        </div>
                        <div className="stg-device-meta">
                          Token: {d.token.slice(0, 8)}… · ใช้งานล่าสุด: {formatDeviceLastSeen(d)}
                          {d.currentUserId ? ` · User: ${d.currentUserId}` : ''}
                        </div>
                      </div>
                      <div className="stg-device-actions">
                        {d.isOnline ? (
                          <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" onClick={() => void forceLogoutDevice(d.id).then(() => showToast(`Force logout ${d.name} สำเร็จ`, 'info'))}>
                            <i className="ti ti-logout" aria-hidden="true" /> Logout
                          </button>
                        ) : null}
                        <button type="button" className="stg-btn stg-btn-danger-ghost stg-btn-sm" onClick={() => void removeDevice(d.id).then(() => showToast('ลบเครื่องแล้ว', 'info'))}>
                          <i className="ti ti-trash" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-printer" aria-hidden="true" /> เครื่องพิมพ์
                </div>
                <div className="stg-card-body">
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">เครื่องพิมพ์หลัก</label>
                      <select className="stg-form-select" value={form.posPrinter} onChange={(e) => set('posPrinter', e.target.value)}>
                        <option>Epson TM-T82X (USB)</option>
                        <option>Star TSP143III (LAN)</option>
                        <option>Bixolon SRP-350 (BT)</option>
                      </select>
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">ขนาดกระดาษ</label>
                      <select className="stg-form-select" value={form.posPaperSize} onChange={(e) => set('posPaperSize', e.target.value)}>
                        <option value="80mm">80mm (มาตรฐาน)</option>
                        <option value="58mm">58mm</option>
                      </select>
                    </div>
                  </div>
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info"><div className="stg-toggle-label">พิมพ์ใบเสร็จอัตโนมัติหลังชำระเงิน</div></div>
                    <Toggle checked={form.autoPrintReceipt} onChange={(v) => set('autoPrintReceipt', v)} />
                  </div>
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info">
                      <div className="stg-toggle-label">พิมพ์สำเนา (2 ใบ)</div>
                      <div className="stg-toggle-desc">ใบแรกสำหรับลูกค้า ใบที่สองสำหรับร้าน</div>
                    </div>
                    <Toggle checked={form.printReceiptCopy} onChange={(v) => set('printReceiptCopy', v)} />
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/* ── Admin ── */}
          {section === 'admin' ? (
            <>
              <div className="stg-section-title">Admin &amp; ความปลอดภัย</div>
              <div className="stg-section-sub">การตั้งค่าระดับระบบ — ต้องใช้สิทธิ์ Admin เท่านั้น</div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-lock" aria-hidden="true" /> นโยบาย PIN &amp; Session
                </div>
                <div className="stg-card-body">
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">หมดเวลา session (นาที)</label>
                      <input className="stg-form-input" type="number" min={5} max={480} value={form.sessionTimeoutMin} onChange={(e) => set('sessionTimeoutMin', Number(e.target.value))} disabled={!isAdmin} />
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">จำนวนครั้งพิมพ์ PIN ผิดสูงสุด</label>
                      <input className="stg-form-input" type="number" min={1} max={10} value={form.pinMaxAttempts} onChange={(e) => set('pinMaxAttempts', Number(e.target.value))} disabled={!isAdmin} />
                    </div>
                  </div>
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info">
                      <div className="stg-toggle-label">ล็อคจอหน้า POS เมื่อไม่มีการใช้งาน</div>
                      <div className="stg-toggle-desc">ต้องกด PIN อีกครั้งเพื่อใช้งานต่อ</div>
                    </div>
                    <Toggle checked={form.posLockOnIdle} onChange={(v) => set('posLockOnIdle', v)} disabled={!isAdmin} />
                  </div>
                  <div className="stg-toggle-row">
                    <div className="stg-toggle-info">
                      <div className="stg-toggle-label">บันทึก Activity Log ทุก action</div>
                      <div className="stg-toggle-desc">เก็บประวัติการกระทำทุกอย่างใน Audit Trail</div>
                    </div>
                    <Toggle checked={form.fullActivityLog} onChange={(v) => set('fullActivityLog', v)} disabled={!isAdmin} />
                  </div>
                </div>
              </div>
              <div className="stg-card">
                <div className="stg-card-head">
                  <i className="ti ti-database" aria-hidden="true" /> ข้อมูลและ Backup
                </div>
                <div className="stg-card-body">
                  <div className="stg-form-row">
                    <div className="stg-form-group">
                      <label className="stg-form-label">Backup อัตโนมัติ</label>
                      <select className="stg-form-select" value={form.backupSchedule} onChange={(e) => set('backupSchedule', e.target.value)} disabled={!isAdmin}>
                        <option value="daily">ทุกวัน 02:00 น.</option>
                        <option value="6h">ทุก 6 ชั่วโมง</option>
                        <option value="hourly">ทุกชั่วโมง</option>
                        <option value="off">ปิด</option>
                      </select>
                    </div>
                    <div className="stg-form-group">
                      <label className="stg-form-label">เก็บ Backup ไว้ (วัน)</label>
                      <input className="stg-form-input" type="number" min={7} value={form.backupRetentionDays} onChange={(e) => set('backupRetentionDays', Number(e.target.value))} disabled={!isAdmin} />
                    </div>
                  </div>
                </div>
              </div>
              {isAdmin ? (
                <div className="stg-danger-zone">
                  <div className="stg-danger-zone-title">
                    <i className="ti ti-alert-triangle" aria-hidden="true" /> Danger Zone
                  </div>
                  <div className="stg-danger-zone-desc">การกระทำต่อไปนี้ไม่สามารถย้อนกลับได้ กรุณาระวัง</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {['รีเซ็ตตัวเลข Running Number ทั้งหมด', 'ลบข้อมูล Demo/Test ทั้งหมด', 'ปิดใช้งานสาขานี้'].map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="stg-btn stg-btn-danger-ghost stg-btn-sm"
                        onClick={() => { setDangerAction(action); setDangerConfirm(''); setDangerOpen(true); }}
                      >
                        {action}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <div className="stg-footer">
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {lastSavedAt
            ? `บันทึกล่าสุด: ${lastSavedAt.toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}`
            : 'ยังไม่ได้บันทึก'}
        </span>
        <div className="stg-footer-spacer" />
        <button type="button" className="stg-btn stg-btn-ghost" onClick={handleCancel} disabled={!formDirty}>
          ยกเลิก
        </button>
        <button type="button" className="stg-btn stg-btn-primary" onClick={() => void handleSave()} disabled={formSaving}>
          <i className="ti ti-check" aria-hidden="true" /> บันทึกการตั้งค่า
        </button>
      </div>

      {/* Add Device Modal */}
      {addDeviceOpen ? (
        <div className="stg-modal-overlay open" role="dialog" aria-modal="true" onClick={() => setAddDeviceOpen(false)}>
          <div className="stg-modal" onClick={(e) => e.stopPropagation()}>
            <div className="stg-modal-header">
              <span className="stg-modal-title">เพิ่มเครื่อง POS</span>
              <button type="button" className="stg-icon-btn" onClick={() => setAddDeviceOpen(false)} aria-label="ปิด">
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
            <div className="stg-modal-body">
              <div className="stg-form-group">
                <label className="stg-form-label">ชื่อเครื่อง</label>
                <input className="stg-form-input" value={newDevice.name} onChange={(e) => setNewDevice({ ...newDevice, name: e.target.value })} placeholder="เช่น POS-03, เคาน์เตอร์หน้า" />
              </div>
              <div className="stg-form-group">
                <label className="stg-form-label">Device Token</label>
                <input className="stg-form-input" value={newDevice.token} onChange={(e) => setNewDevice({ ...newDevice, token: e.target.value })} placeholder="กรอก Token จาก App" />
              </div>
              <div className="stg-form-group">
                <label className="stg-form-label">ประเภทเครื่อง</label>
                <select className="stg-form-select" value={newDevice.type} onChange={(e) => setNewDevice({ ...newDevice, type: e.target.value as PosDeviceType })}>
                  <option value="desktop">Desktop / Tablet</option>
                  <option value="mobile">Mobile</option>
                </select>
              </div>
            </div>
            <div className="stg-modal-footer">
              <button type="button" className="stg-btn stg-btn-ghost" onClick={() => setAddDeviceOpen(false)}>ยกเลิก</button>
              <button
                type="button"
                className="stg-btn stg-btn-primary"
                onClick={() => {
                  void addDevice(newDevice.name, newDevice.token, newDevice.type).then(() => {
                    setAddDeviceOpen(false);
                    setNewDevice({ name: '', token: '', type: 'desktop' });
                    showToast('เพิ่มเครื่องสำเร็จ', 'success');
                  });
                }}
              >
                เพิ่มเครื่อง
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Danger Modal */}
      {dangerOpen ? (
        <div className="stg-modal-overlay open" role="dialog" aria-modal="true" onClick={() => setDangerOpen(false)}>
          <div className="stg-modal" onClick={(e) => e.stopPropagation()}>
            <div className="stg-modal-header">
              <span className="stg-modal-title" style={{ color: 'var(--danger)' }}>⚠️ ยืนยันการดำเนินการ</span>
              <button type="button" className="stg-icon-btn" onClick={() => setDangerOpen(false)} aria-label="ปิด">
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
            <div className="stg-modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                คุณกำลังจะ: {dangerAction}
                <br />
                การกระทำนี้ไม่สามารถย้อนกลับได้
              </p>
              <div className="stg-form-group" style={{ marginTop: 8 }}>
                <label className="stg-form-label">พิมพ์ &quot;ยืนยัน&quot; เพื่อดำเนินการต่อ</label>
                <input className="stg-form-input" value={dangerConfirm} onChange={(e) => setDangerConfirm(e.target.value)} placeholder="ยืนยัน" />
              </div>
            </div>
            <div className="stg-modal-footer">
              <button type="button" className="stg-btn stg-btn-ghost" onClick={() => setDangerOpen(false)}>ยกเลิก</button>
              <button
                type="button"
                className="stg-btn stg-btn-danger-ghost"
                onClick={() => {
                  if (dangerConfirm.trim() === 'ยืนยัน') {
                    setDangerOpen(false);
                    showToast(`${dangerAction} เสร็จสิ้น`, 'warn');
                  } else {
                    showToast('กรุณาพิมพ์ "ยืนยัน" ก่อน', 'warn');
                  }
                }}
              >
                ดำเนินการ
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="stg-toast-wrap">
          <div className={`stg-toast ${toast.type}`}>
            <i className={`ti ${toast.type === 'success' ? 'ti-circle-check' : toast.type === 'warn' ? 'ti-alert-triangle' : 'ti-info-circle'}`} aria-hidden="true" />
            {toast.msg}
          </div>
        </div>
      ) : null}
    </div>
  );
}
