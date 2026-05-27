import { useEffect, useMemo, useState } from 'react';
import '../../pages/CustomerPage.css';
import { POS_FEATURES } from '../../lib/config/features';
import { customerTierLabel, useCustomerTiers } from '../../lib/customers/customerTiers';
import CreditPaymentModal from './CreditPaymentModal';
import { DEV_TOP_PRODUCTS } from '../../lib/customers/devMock';
import { loadCreditTransactions, loadCustomerOrders } from '../../lib/customers/useCustomers';
import {
  CONTACT_TYPE_OPTIONS,
  creditUsagePct,
  customerFullName,
  customerInitials,
  customerToForm,
  contactTypeBadgeStyle,
  contactTypeLabel,
  customerTypeBadgeStyle,
  formatCustomerLastVisit,
  fmtBaht,
  fmtBahtDec,
  inferContactType,
  orderStatusLabel,
  payMethodLabel,
  type CustomerFormData,
  type CustomerTab,
  normalizeCustomerForm,
} from '../../lib/customers/types';
import { creditAvailable, resolveOutstandingBalance } from '../../lib/customers/creditService';
import type { CreditAccount, CreditTransaction, Customer, Order, PriceLevel } from '../../lib/types';
import type { ContactType } from '../../lib/types';
import { DEFAULT_CUSTOMER_TIER } from '../../lib/types';

type Props = {
  customer: Customer;
  creditAccount: CreditAccount | null;
  priceLevels: PriceLevel[];
  branchId: string;
  actorId: string;
  open: boolean;
  onClose: () => void;
  onSave: (form: CustomerFormData) => Promise<void>;
  onCreditPaid: () => void;
  onToast?: (msg: string, type?: 'success' | 'warn') => void;
};

const STATUS_MAP = {
  paid: ['cm-modal-status-paid', 'ชำระแล้ว'],
  pending: ['cm-modal-status-pending', 'รอชำระ'],
  cancel: ['cm-modal-status-cancel', 'ยกเลิก'],
} as const;

function parseDate(d: unknown): Date {
  if (d != null && typeof d === 'object' && 'toDate' in d && typeof (d as { toDate: unknown }).toDate === 'function') {
    return (d as { toDate: () => Date }).toDate();
  }
  if (d instanceof Date) return d;
  return new Date(d as string | number);
}

export default function CustomerDetailModal({
  customer,
  creditAccount,
  priceLevels,
  branchId,
  actorId,
  open,
  onClose,
  onSave,
  onCreditPaid,
  onToast,
}: Props) {
  const { tiers: customerTiers } = useCustomerTiers();
  const tierDisplay = (type: string) => customerTierLabel(customerTiers, type);
  const [tab, setTab] = useState<CustomerTab>('sales');
  const [form, setForm] = useState<CustomerFormData>(() => customerToForm(customer));
  const [orders, setOrders] = useState<Order[]>([]);
  const [creditTx, setCreditTx] = useState<CreditTransaction[]>([]);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orderSearch, setOrderSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(customerToForm(customer));
    setTab(inferContactType(customer) === 'supplier' ? 'info' : 'sales');
    setPaymentModalOpen(false);
    void loadCustomerOrders(customer.id).then(setOrders);
    void loadCreditTransactions(customer.id).then(setCreditTx);
  }, [open, customer]);

  const priceLevelName =
    priceLevels.find((p) => p.id === customer.priceLevelId)?.name ?? customer.priceLevelId;

  const activeCustomerType = form.customerType.trim() || DEFAULT_CUSTOMER_TIER;
  const tierIdSet = useMemo(() => new Set(customerTiers.map((t) => t.id)), [customerTiers]);
  const hasLegacyTier =
    !!activeCustomerType && !tierIdSet.has(activeCustomerType) && activeCustomerType !== DEFAULT_CUSTOMER_TIER;

  const currentBalance = resolveOutstandingBalance(customer, creditAccount);
  const creditLimit = creditAccount?.creditLimit ?? customer.creditLimit;
  const creditRemain = creditAvailable(creditLimit, currentBalance);

  const openPaymentModal = () => setPaymentModalOpen(true);

  const filteredOrders = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    return orders.filter((o) => !q || o.id.toLowerCase().includes(q));
  }, [orders, orderSearch]);

  const topProducts = DEV_TOP_PRODUCTS[customer.id] ?? [];

  if (!open) return null;

  const set = <K extends keyof CustomerFormData>(key: K, val: CustomerFormData[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(normalizeCustomerForm(form));
    } finally {
      setSaving(false);
    }
  };

  const handlePaymentSuccess = () => {
    void loadCreditTransactions(customer.id).then(setCreditTx);
    onCreditPaid();
  };

  const contactType = inferContactType(customer);
  const isSupplier = contactType === 'supplier';
  const typeStyle = contactTypeBadgeStyle(contactType);

  const navItems: { id: CustomerTab; icon: string; label: string }[] = isSupplier
    ? [{ id: 'info', icon: 'ti-user', label: 'ข้อมูลทั่วไป' }]
    : [
        { id: 'sales', icon: 'ti-receipt', label: 'ประวัติการซื้อ' },
        { id: 'credit', icon: 'ti-credit-card', label: 'ประวัติเชื่อ' },
        { id: 'products', icon: 'ti-package', label: 'สินค้าซื้อบ่อย' },
        { id: 'pricing', icon: 'ti-crown', label: 'ระดับราคา' },
        { id: 'info', icon: 'ti-user', label: 'ข้อมูลทั่วไป' },
      ];

  const setContactType = (type: ContactType) => {
    setForm((f) => {
      const next = { ...f, contactType: type };
      if (type === 'retail') next.priceLevelId = 'RETAIL';
      if (type === 'supplier') {
        next.creditLimit = 0;
        next.creditDays = 0;
      }
      return next;
    });
  };

  return (
    <div className="cm-modal-overlay" role="dialog" aria-modal="true">
      <div className="cm-modal">
        <div className="cm-modal-topbar">
          <span className="cm-modal-title">
            {isSupplier ? 'ข้อมูลผู้จำหน่าย' : 'ข้อมูลลูกค้า'}
          </span>
          <span className="cm-modal-customer-id">{customer.memberNo}</span>
          <button type="button" className="cm-modal-btn-cancel" onClick={onClose}>
            ยกเลิก
          </button>
          <button type="button" className="cm-modal-btn-save" disabled={saving} onClick={handleSave}>
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>

        <div className="cm-modal-body">
          <div className="cm-modal-sidebar">
            {navItems.map((n) => (
              <div
                key={n.id}
                className={`cm-modal-nav-item${tab === n.id ? ' active' : ''}`}
                onClick={() => setTab(n.id)}
                onKeyDown={(e) => e.key === 'Enter' && setTab(n.id)}
                role="button"
                tabIndex={0}
              >
                <i className={`ti ${n.icon}`} aria-hidden="true" />
                {n.label}
              </div>
            ))}
          </div>

          <div className="cm-modal-content">
            {/* TAB: Sales */}
            <div className={`cm-modal-tab-panel${tab === 'sales' ? ' active' : ''}`}>
              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-receipt" aria-hidden="true" />
                  ประวัติคำสั่งซื้อ
                </div>
                <div className="cm-modal-sec-body" style={{ padding: '10px 14px', paddingBottom: 0 }}>
                  <div className="cm-modal-filter-bar" style={{ marginBottom: 10 }}>
                    <input
                      placeholder="ค้นหาเลขออเดอร์..."
                      value={orderSearch}
                      onChange={(e) => setOrderSearch(e.target.value)}
                    />
                  </div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="cm-modal-order-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>วันที่</th>
                        <th className="r">ยอด</th>
                        <th>ช่องทาง</th>
                        <th>สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOrders.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--g400)' }}>
                            ไม่มีประวัติการซื้อ
                          </td>
                        </tr>
                      ) : (
                        filteredOrders.map((o) => {
                          const st = orderStatusLabel(o.status, o.creditAmt);
                          const [cls, lbl] = STATUS_MAP[st];
                          return (
                            <tr key={o.id}>
                              <td style={{ color: 'var(--p600)', fontWeight: 500 }}>{o.id}</td>
                              <td>
                                {parseDate(o.createdAt).toLocaleDateString('th-TH', {
                                  day: '2-digit',
                                  month: '2-digit',
                                  year: '2-digit',
                                })}
                              </td>
                              <td className="r">{fmtBahtDec(o.total)}</td>
                              <td style={{ fontSize: 11, color: 'var(--g400)' }}>{payMethodLabel(o)}</td>
                              <td>
                                <span className={`cm-modal-status-badge ${cls}`}>{lbl}</span>
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

            {/* TAB: Credit */}
            <div className={`cm-modal-tab-panel${tab === 'credit' ? ' active' : ''}`}>
              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-credit-card" aria-hidden="true" />
                  ภาพรวมวงเงิน
                </div>
                <div className="cm-modal-sec-body">
                  <div className="cm-modal-credit-grid">
                    <div className="cm-modal-credit-card">
                      <div className="cm-modal-credit-lbl">วงเงินเชื่อทั้งหมด</div>
                      <div className="cm-modal-credit-val" style={{ color: 'var(--p600)' }}>
                        {fmtBaht(creditLimit)}
                      </div>
                      <div className="cm-modal-credit-bar-wrap">
                        <div className="cm-modal-credit-bar">
                          <div
                            className="cm-modal-credit-bar-fill"
                            style={{
                              width: `${creditUsagePct(creditAccount, creditLimit)}%`,
                              background: 'var(--green)',
                            }}
                          />
                        </div>
                        <div className="cm-modal-credit-bar-lbl">
                          <span>ใช้ไป {creditUsagePct(creditAccount, creditLimit)}%</span>
                          <span>{fmtBaht(currentBalance)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="cm-modal-credit-card">
                      <div className="cm-modal-credit-lbl">วงเงินคงเหลือ</div>
                      <div className="cm-modal-credit-val" style={{ color: 'var(--green)' }}>
                        {fmtBaht(creditRemain)}
                      </div>
                    </div>
                    <div className="cm-modal-credit-card">
                      <div className="cm-modal-credit-lbl">หนี้ค้างชำระ</div>
                      <div className="cm-modal-credit-val" style={{ color: 'var(--red)' }}>
                        {fmtBaht(currentBalance)}
                      </div>
                      {currentBalance > 0 ? (
                        <button
                          type="button"
                          className="cm-modal-p-action-btn primary cm-credit-pay-btn"
                          onClick={openPaymentModal}
                        >
                          💰 รับชำระหนี้
                        </button>
                      ) : null}
                    </div>
                    <div className="cm-modal-credit-card">
                      <div className="cm-modal-credit-lbl">เกินกำหนดชำระ</div>
                      <div className="cm-modal-credit-val" style={{ color: 'var(--amber)' }}>
                        {fmtBaht(creditAccount?.overdueAmt ?? 0)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-history" aria-hidden="true" />
                  ประวัติการชำระหนี้ / ยอดเชื่อ
                </div>
                <div className="cm-modal-sec-body flush">
                  <table className="cm-modal-order-table">
                    <thead>
                      <tr>
                        <th>วันที่</th>
                        <th>รายการ</th>
                        <th className="r">จำนวน</th>
                        <th>ประเภท</th>
                        <th>สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {creditTx.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--g400)' }}>
                            ไม่มีรายการเชื่อ
                          </td>
                        </tr>
                      ) : (
                        creditTx.map((t) => (
                          <tr key={t.id}>
                            <td>
                              {parseDate(t.createdAt).toLocaleDateString('th-TH', {
                                day: '2-digit',
                                month: '2-digit',
                                year: '2-digit',
                              })}
                            </td>
                            <td>{t.note || (t.refOrderId ? `Order ${t.refOrderId}` : '—')}</td>
                            <td className="r">{fmtBahtDec(t.amount)}</td>
                            <td style={{ fontSize: 11 }}>
                              {t.type === 'charge' ? 'ตั้งหนี้' : t.type === 'payment' ? 'ชำระ' : 'ปรับ'}
                            </td>
                            <td>
                              <span
                                className={`cm-modal-status-badge ${t.type === 'payment' ? 'cm-modal-status-paid' : 'cm-modal-status-pending'}`}
                              >
                                {t.type === 'payment' ? 'ชำระแล้ว' : 'รอชำระ'}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* TAB: Products */}
            <div className={`cm-modal-tab-panel${tab === 'products' ? ' active' : ''}`}>
              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-package" aria-hidden="true" />
                  สินค้าที่ซื้อบ่อย
                </div>
                <div className="cm-modal-sec-body flush">
                  <table className="cm-modal-order-table">
                    <thead>
                      <tr>
                        <th>สินค้า</th>
                        <th>SKU</th>
                        <th className="r">Qty</th>
                        <th className="r">ยอดรวม</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topProducts.length === 0 ? (
                        <tr>
                          <td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--g400)' }}>
                            ยังไม่มีข้อมูล
                          </td>
                        </tr>
                      ) : (
                        topProducts.map((p) => (
                          <tr key={p.sku}>
                            <td>{p.name}</td>
                            <td style={{ color: 'var(--g400)' }}>{p.sku}</td>
                            <td className="r">{p.qty}</td>
                            <td className="r">{fmtBahtDec(p.revenue)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* TAB: Pricing */}
            <div className={`cm-modal-tab-panel${tab === 'pricing' ? ' active' : ''}`}>
              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-crown" aria-hidden="true" />
                  ระดับราคา / ส่วนลดพิเศษ
                </div>
                <div className="cm-modal-sec-body">
                  <div className="cm-modal-tier-grid">
                    {hasLegacyTier ? (
                      <div
                        className={`cm-modal-tier-card selected`}
                        role="button"
                        tabIndex={0}
                        onClick={() => set('customerType', activeCustomerType)}
                        onKeyDown={(e) => e.key === 'Enter' && set('customerType', activeCustomerType)}
                      >
                        <div className="cm-modal-tier-name">{activeCustomerType}</div>
                        <div className="cm-modal-tier-desc">(ไม่พบในระบบ)</div>
                      </div>
                    ) : null}
                    {customerTiers.map((tier) => {
                      const isActive =
                        activeCustomerType === tier.id ||
                        (!form.customerType.trim() && tier.id === DEFAULT_CUSTOMER_TIER);
                      return (
                        <div
                          key={tier.id}
                          className={`cm-modal-tier-card${isActive ? ' selected' : ''}`}
                          onClick={() => set('customerType', tier.id)}
                          onKeyDown={(e) => e.key === 'Enter' && set('customerType', tier.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="cm-modal-tier-name">{tier.name}</div>
                          <div className="cm-modal-tier-desc">{tier.id}</div>
                        </div>
                      );
                    })}
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--g400)', marginTop: 12 }}>
                    กลุ่มลูกค้าปัจจุบัน: <strong>{tierDisplay(activeCustomerType)}</strong> — ราคา POS
                    จะอ้างอิงจาก tierPrices ตามกลุ่มนี้
                  </p>
                </div>
              </div>
              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-chart-bar" aria-hidden="true" />
                  CRM — ข้อมูลลูกค้า
                </div>
                <div className="cm-modal-sec-body">
                  <div className="cm-modal-points-row">
                    <div className="cm-modal-points-card">
                      <span className="cm-modal-points-label">ประเภทลูกค้า</span>
                      <span
                        className="cm-modal-points-val"
                        style={{
                          fontSize: 16,
                          color: customerTypeBadgeStyle(customer.customerType).color,
                        }}
                      >
                        {tierDisplay(customer.customerType)}
                      </span>
                      <span className="cm-modal-points-sub">Customer Type</span>
                    </div>
                    <div className="cm-modal-points-card">
                      <span className="cm-modal-points-label">มูลค่าตลอดกาล (LTV)</span>
                      <span className="cm-modal-points-val">{fmtBaht(customer.lifetimeValue)}</span>
                      <span className="cm-modal-points-sub">Lifetime Value</span>
                    </div>
                    <div className="cm-modal-points-card">
                      <span className="cm-modal-points-label">มาใช้บริการล่าสุด</span>
                      <span className="cm-modal-points-val" style={{ fontSize: 15 }}>
                        {formatCustomerLastVisit(customer.lastVisitAt)}
                      </span>
                      <span className="cm-modal-points-sub">Last Visit</span>
                    </div>
                    {POS_FEATURES.enableLoyaltyPoints ? (
                      <div className="cm-modal-points-card">
                        <span className="cm-modal-points-label">แต้มคงเหลือ</span>
                        <span className="cm-modal-points-val" style={{ color: 'var(--p600)' }}>
                          {customer.points}
                        </span>
                        <span className="cm-modal-points-sub">แต้ม</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            {/* TAB: Info */}
            <div className={`cm-modal-tab-panel${tab === 'info' ? ' active' : ''}`}>
              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-category" aria-hidden="true" />
                  ประเภทผู้ติดต่อ
                </div>
                <div className="cm-modal-sec-body">
                  <div className="cm-contact-type-grid cm-contact-type-grid-compact">
                    {CONTACT_TYPE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`cm-contact-type-card${form.contactType === opt.id ? ' selected' : ''}`}
                        onClick={() => setContactType(opt.id)}
                      >
                        <span className="cm-contact-type-icon">{opt.icon}</span>
                        <span className="cm-contact-type-label">{opt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-id-badge" aria-hidden="true" />
                  ข้อมูลทั่วไป
                </div>
                <div className="cm-modal-sec-body">
                  <div className="cm-modal-form-grid">
                    <div className="cm-modal-field">
                      <label>ชื่อ *</label>
                      <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
                    </div>
                    <div className="cm-modal-field">
                      <label>{form.contactType === 'supplier' ? 'ชื่อย่อ / ผู้ติดต่อ *' : 'นามสกุล *'}</label>
                      <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
                    </div>
                    <div className="cm-modal-field">
                      <label>เบอร์โทรศัพท์ *</label>
                      <input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                    </div>
                    <div className="cm-modal-field">
                      <label>อีเมล</label>
                      <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="cm-modal-sec">
                <div className="cm-modal-sec-head">
                  <i className="ti ti-map-pin" aria-hidden="true" />
                  ข้อมูลที่อยู่ / ภาษี
                </div>
                <div className="cm-modal-sec-body">
                  <div className="cm-modal-form-grid">
                    <div className="cm-modal-field cm-modal-form-full">
                      <label>เลขประจำตัวผู้เสียภาษี</label>
                      <input
                        placeholder="13 หลัก"
                        value={form.taxId}
                        onChange={(e) => set('taxId', e.target.value)}
                      />
                    </div>
                    <div className="cm-modal-field cm-modal-form-full">
                      <label>ที่อยู่</label>
                      <textarea value={form.address} onChange={(e) => set('address', e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>

              {form.contactType === 'supplier' ? (
                <div className="cm-modal-sec">
                  <div className="cm-modal-sec-head">
                    <i className="ti ti-building-bank" aria-hidden="true" />
                    ข้อมูลบัญชีธนาคาร
                  </div>
                  <div className="cm-modal-sec-body">
                    <div className="cm-modal-form-grid">
                      <div className="cm-modal-field">
                        <label>ชื่อธนาคาร</label>
                        <input value={form.bankName} onChange={(e) => set('bankName', e.target.value)} />
                      </div>
                      <div className="cm-modal-field">
                        <label>เลขที่บัญชี</label>
                        <input value={form.bankAccount} onChange={(e) => set('bankAccount', e.target.value)} />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="cm-modal-sec">
                  <div className="cm-modal-sec-head">
                    <i className="ti ti-credit-card" aria-hidden="true" />
                    ข้อมูลบัญชี / เครดิต
                  </div>
                  <div className="cm-modal-sec-body">
                    <div className="cm-modal-form-grid">
                      <div className="cm-modal-field">
                        <label>วงเงินเชื่อ (฿)</label>
                        <input
                          type="number"
                          value={form.creditLimit}
                          onChange={(e) => set('creditLimit', Number(e.target.value))}
                        />
                      </div>
                      <div className="cm-modal-field">
                        <label>เครดิตเทอม (วัน)</label>
                        <input
                          type="number"
                          value={form.creditDays}
                          onChange={(e) => set('creditDays', Number(e.target.value))}
                        />
                      </div>
                      <div className="cm-modal-field">
                        <label>แท็ก</label>
                        <input
                          placeholder="VIP, ลูกค้าประจำ..."
                          value={form.tags}
                          onChange={(e) => set('tags', e.target.value)}
                        />
                      </div>
                      <div className="cm-modal-field">
                        <label>สถานะ</label>
                        <select
                          value={form.isActive ? 'active' : 'inactive'}
                          onChange={(e) => set('isActive', e.target.value === 'active')}
                        >
                          <option value="active">ใช้งานอยู่</option>
                          <option value="inactive">ระงับชั่วคราว</option>
                        </select>
                      </div>
                      <div className="cm-modal-field cm-modal-form-full">
                        <label>หมายเหตุ</label>
                        <textarea value={form.note} onChange={(e) => set('note', e.target.value)} />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {form.contactType === 'supplier' ? (
                <div className="cm-modal-sec">
                  <div className="cm-modal-sec-head">
                    <i className="ti ti-notes" aria-hidden="true" />
                    หมายเหตุ / สถานะ
                  </div>
                  <div className="cm-modal-sec-body">
                    <div className="cm-modal-form-grid">
                      <div className="cm-modal-field cm-modal-form-full">
                        <label>หมายเหตุ</label>
                        <textarea value={form.note} onChange={(e) => set('note', e.target.value)} />
                      </div>
                      <div className="cm-modal-field">
                        <label>สถานะ</label>
                        <select
                          value={form.isActive ? 'active' : 'inactive'}
                          onChange={(e) => set('isActive', e.target.value === 'active')}
                        >
                          <option value="active">ใช้งานอยู่</option>
                          <option value="inactive">ระงับชั่วคราว</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Profile panel */}
          <div className="cm-modal-profile-panel">
            <div className="cm-modal-profile-top">
              <div className="cm-modal-profile-photo">{customerInitials(customer)}</div>
              <div className="cm-modal-profile-name">{customerFullName(customer)}</div>
              <div className="cm-modal-profile-id">
                {customer.memberNo} · {customer.phone}
              </div>
              <div className="cm-modal-profile-badges">
                <span
                  className="cm-modal-p-badge"
                  style={{ background: typeStyle.bg, color: typeStyle.color }}
                >
                  {contactTypeLabel(contactType)}
                </span>
                <span className={`cm-modal-p-badge ${customer.isActive ? 'cm-modal-badge-active' : ''}`}>
                  <i className="ti ti-circle-check" style={{ fontSize: 10 }} aria-hidden="true" />
                  {customer.isActive ? 'ใช้งานอยู่' : 'ระงับ'}
                </span>
                <span className="cm-modal-p-badge cm-modal-badge-tier">
                  <i className="ti ti-star" style={{ fontSize: 10 }} aria-hidden="true" />
                  {priceLevelName}
                </span>
                {!isSupplier ? (
                  <span
                    className="cm-modal-p-badge"
                    style={{
                      background: customerTypeBadgeStyle(customer.customerType).bg,
                      color: customerTypeBadgeStyle(customer.customerType).color,
                    }}
                  >
                    {tierDisplay(customer.customerType)}
                  </span>
                ) : null}
                {creditLimit > 0 && !isSupplier ? (
                  <span className="cm-modal-p-badge cm-modal-badge-credit">
                    <i className="ti ti-credit-card" style={{ fontSize: 10 }} aria-hidden="true" />
                    มีวงเงินเชื่อ
                  </span>
                ) : null}
              </div>
            </div>
            <div className="cm-modal-profile-stats">
              <div className="cm-modal-stat-row">
                <span className="cm-modal-stat-label">
                  <i className="ti ti-calendar" aria-hidden="true" /> สมาชิกตั้งแต่
                </span>
                <span className="cm-modal-stat-val">
                  {parseDate(customer.createdAt).toLocaleDateString('th-TH', { month: 'short', year: 'numeric' })}
                </span>
              </div>
              <div className="cm-modal-stat-row">
                <span className="cm-modal-stat-label">
                  <i className="ti ti-receipt" aria-hidden="true" /> จำนวนออเดอร์
                </span>
                <span className="cm-modal-stat-val">{orders.length} ครั้ง</span>
              </div>
              <div className="cm-modal-stat-row">
                <span className="cm-modal-stat-label">
                  <i className="ti ti-coins" aria-hidden="true" /> มูลค่าตลอดกาล (LTV)
                </span>
                <span className="cm-modal-stat-val" style={{ color: 'var(--p600)' }}>
                  {fmtBaht(customer.lifetimeValue)}
                </span>
              </div>
              <div className="cm-modal-stat-row">
                <span className="cm-modal-stat-label">
                  <i className="ti ti-calendar-event" aria-hidden="true" /> มาใช้บริการล่าสุด
                </span>
                <span className="cm-modal-stat-val">{formatCustomerLastVisit(customer.lastVisitAt)}</span>
              </div>
              {POS_FEATURES.enableLoyaltyPoints ? (
                <div className="cm-modal-stat-row">
                  <span className="cm-modal-stat-label">
                    <i className="ti ti-gift" aria-hidden="true" /> แต้มสะสม
                  </span>
                  <span className="cm-modal-stat-val" style={{ color: 'var(--p600)' }}>
                    {customer.points} แต้ม
                  </span>
                </div>
              ) : null}
              <div className="cm-modal-stat-row">
                <span className="cm-modal-stat-label">
                  <i className="ti ti-credit-card" aria-hidden="true" /> วงเงินคงเหลือ
                </span>
                <span className="cm-modal-stat-val" style={{ color: 'var(--green)' }}>
                  {fmtBaht(creditRemain)}
                </span>
              </div>
              <div className="cm-modal-stat-row">
                <span className="cm-modal-stat-label">
                  <i className="ti ti-alert-triangle" aria-hidden="true" /> ค้างชำระ
                </span>
                <span className="cm-modal-stat-val" style={{ color: 'var(--red)' }}>
                  {fmtBaht(currentBalance)}
                </span>
              </div>
            </div>
            <div className="cm-modal-profile-actions">
              {!isSupplier ? (
                <>
                  <button
                    type="button"
                    className="cm-modal-p-action-btn primary"
                    disabled={currentBalance <= 0}
                    onClick={openPaymentModal}
                  >
                    <i className="ti ti-cash" aria-hidden="true" /> 💰 รับชำระหนี้
                  </button>
                  <button type="button" className="cm-modal-p-action-btn" onClick={() => setTab('sales')}>
                    <i className="ti ti-receipt" aria-hidden="true" /> ดูประวัติซื้อ
                  </button>
                </>
              ) : form.bankName || form.bankAccount ? (
                <div className="cm-supplier-bank-summary">
                  <div className="cm-supplier-bank-label">บัญชีธนาคาร</div>
                  <div className="cm-supplier-bank-val">{form.bankName || '—'}</div>
                  <div className="cm-supplier-bank-val mono">{form.bankAccount || '—'}</div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <CreditPaymentModal
        customer={customer}
        branchId={branchId}
        actorId={actorId}
        creditAccount={creditAccount}
        isOpen={paymentModalOpen}
        onClose={() => setPaymentModalOpen(false)}
        onSuccess={handlePaymentSuccess}
        onToast={onToast}
      />
    </div>
  );
}
