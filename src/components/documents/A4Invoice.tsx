import { useMemo } from 'react';
import {
  buildDocNumber,
  customerDisplayName,
  customerPhone,
  customerTaxId,
  fmtBaht,
  formatThaiDate,
  orderStamp,
  PAY_METHOD_LABELS,
} from '../../lib/documents/formatters';
import { A4_DOC_TYPES, type A4InvoiceProps } from '../../lib/documents/types';
import './A4Invoice.css';

const DEFAULT_NOTES = [
  '— ขอบคุณที่ใช้บริการ TwinPet',
  '— สินค้าเปิดกล่องแล้วไม่รับเปลี่ยนคืน',
  '— กรุณาตรวจสอบสินค้าก่อนรับทุกครั้ง',
];

export default function A4Invoice({
  order,
  orderItems,
  customer,
  branchSettings,
  docType,
  payments = [],
  docNumber,
  dueDate,
  printedAt = new Date(),
}: A4InvoiceProps) {
  const cfg = A4_DOC_TYPES[docType];
  const showVatRow = cfg.showVat && branchSettings.vatRegistered;
  const showCustomerTaxId = docType === 'full' && branchSettings.vatRegistered;
  const hidePrices = cfg.hidePrices ?? false;
  const stamp = orderStamp(order, docType);
  const number = docNumber ?? buildDocNumber(docType, order);

  const custName = customerDisplayName(customer, order) || 'ลูกค้าทั่วไป';
  const custPhone = customerPhone(customer, order);
  const custTax = customerTaxId(customer, order);

  const itemDiscountTotal = useMemo(
    () => orderItems.reduce((s, it) => s + it.discountAmt, 0),
    [orderItems],
  );

  const subtotalBeforeTax = order.subtotal - order.discountAmt - order.billDiscount;
  const paidTotal = payments.length > 0 ? payments.reduce((s, p) => s + p.amount, 0) : order.paidAmt;
  const remaining = Math.max(0, order.total - paidTotal);

  const dueDisplay = dueDate
    ? formatThaiDate(dueDate)
    : formatThaiDate(order.createdAt);

  const noteLines = order.note
    ? order.note.split('\n').map((l) => `— ${l}`)
    : DEFAULT_NOTES;

  return (
    <div className="a4-print-root" aria-hidden="true">
      <div className="a4">
        <div className="stamp" style={{ color: stamp.color, borderColor: stamp.color }}>
          {stamp.text}
        </div>

        <div className="doc-header">
          <div className="doc-brand">
            {branchSettings.logoUrl ? (
              <div className="doc-logo">
                <img src={branchSettings.logoUrl} alt="" />
              </div>
            ) : (
              <div className="doc-logo">🐾 TwinPet</div>
            )}
            <div className="doc-brand-name">{branchSettings.companyName}</div>
            <div className="doc-brand-sub">เลขประจำตัวผู้เสียภาษี: {branchSettings.taxId}</div>
            <div className="doc-brand-addr">
              {branchSettings.branchAddress.split('\n').map((line, i) => (
                <span key={i}>
                  {line}
                  {i < branchSettings.branchAddress.split('\n').length - 1 ? <br /> : null}
                </span>
              ))}
              <br />
              โทร: {branchSettings.branchPhone} · {branchSettings.branchEmail}
            </div>
          </div>
          <div className="doc-title-block">
            <div className="doc-type-badge" style={{ background: cfg.badgeColor }}>
              {cfg.label}
            </div>
            <table className="doc-ref-table">
              <tbody>
                <tr>
                  <td>เลขที่:</td>
                  <td>{number}</td>
                </tr>
                <tr>
                  <td>วันที่ออก:</td>
                  <td>{formatThaiDate(order.createdAt)}</td>
                </tr>
                {cfg.showDue ? (
                  <tr>
                    <td>ครบกำหนด:</td>
                    <td>{dueDisplay}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>อ้างอิงบิล:</td>
                  <td>{order.id}</td>
                </tr>
                <tr>
                  <td>พนักงาน:</td>
                  <td>{order.staffName}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="hline-accent" />

        <div className="parties">
          <div className="party-box">
            <div className="party-label">ผู้ขาย / Seller</div>
            <div className="party-name">{branchSettings.branchName}</div>
            <div className="party-detail">
              {branchSettings.branchAddress}
              <br />
              เลขภาษี: {branchSettings.taxId}
            </div>
          </div>
          <div className="party-box">
            <div className="party-label">ผู้ซื้อ / Bill To</div>
            <div className="party-name">{custName}</div>
            <div className="party-detail">
              {customer?.memberNo ? (
                <>
                  สมาชิก #{customer.memberNo}
                  <br />
                </>
              ) : null}
              {custPhone ? (
                <>
                  โทร: {custPhone}
                  <br />
                </>
              ) : null}
              {showCustomerTaxId && custTax ? <>เลขภาษี: {custTax}</> : null}
            </div>
          </div>
        </div>

        <table className="items-table">
          <thead>
            <tr>
              <th className="c" style={{ width: '6mm' }}>
                #
              </th>
              <th>รายการสินค้า</th>
              <th className="c" style={{ width: '14mm' }}>
                หน่วย
              </th>
              <th className="r" style={{ width: '12mm' }}>
                จำนวน
              </th>
              {!hidePrices ? (
                <>
                  <th className="r" style={{ width: '18mm' }}>
                    ราคา/หน่วย
                  </th>
                  <th className="r" style={{ width: '14mm' }}>
                    ส่วนลด
                  </th>
                  <th className="r" style={{ width: '20mm' }}>
                    จำนวนเงิน
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {orderItems.map((it, idx) => (
              <tr key={it.id}>
                <td className="c">{idx + 1}</td>
                <td>
                  <div className="prod-name">{it.productSnap.name}</div>
                  <div className="prod-sku">
                    SKU: {it.productSnap.sku}
                    {it.productSnap.category ? ` · ${it.productSnap.category}` : ''}
                  </div>
                </td>
                <td className="c">{it.unit}</td>
                <td className="r">{it.qty}</td>
                {!hidePrices ? (
                  <>
                    <td className="r">{fmtBaht(it.unitPrice)}</td>
                    <td className="r">{it.discountAmt > 0 ? fmtBaht(it.discountAmt) : '—'}</td>
                    <td className="r">{fmtBaht(it.lineTotal)}</td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
          {!hidePrices ? (
            <tfoot>
              <tr>
                <td colSpan={6} className="r text-muted" style={{ fontSize: '8pt' }}>
                  รวมก่อนภาษี
                </td>
                <td className="r">{fmtBaht(subtotalBeforeTax)}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>

        {!hidePrices ? (
          <div className="summary-layout">
            <div>
              {payments.length > 0 ? (
                <div className="pay-box" style={{ marginBottom: '4mm' }}>
                  <div className="pay-label">ช่องทางชำระเงิน</div>
                  {payments.map((p) => (
                    <div key={p.id} className="pay-row">
                      <div className={`pay-dot${p.method === 'cash' ? ' success' : ''}`} />
                      <span>
                        {PAY_METHOD_LABELS[p.method]} · ฿{fmtBaht(p.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : order.paidAmt > 0 ? (
                <div className="pay-box" style={{ marginBottom: '4mm' }}>
                  <div className="pay-label">ช่องทางชำระเงิน</div>
                  <div className="pay-row">
                    <div className="pay-dot success" />
                    <span>ชำระแล้ว · ฿{fmtBaht(order.paidAmt)}</span>
                  </div>
                </div>
              ) : null}

              <div className="note-box">
                <div className="note-label">หมายเหตุ / Notes</div>
                <div className="note-text">
                  {noteLines.map((line, i) => (
                    <span key={i}>
                      {line}
                      {i < noteLines.length - 1 ? <br /> : null}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="summary-box">
              <div className="summary-row">
                <span>ยอดรวม</span>
                <span className="summary-right">{fmtBaht(order.subtotal)}</span>
              </div>
              {itemDiscountTotal > 0 ? (
                <div className="summary-row">
                  <span>ส่วนลดรายการ</span>
                  <span className="summary-right text-danger">-{fmtBaht(itemDiscountTotal)}</span>
                </div>
              ) : null}
              {order.billDiscount > 0 ? (
                <div className="summary-row">
                  <span>ส่วนลดบิล</span>
                  <span className="summary-right text-danger">-{fmtBaht(order.billDiscount)}</span>
                </div>
              ) : null}
              <div className="summary-row">
                <span>ยอดก่อนภาษี</span>
                <span className="summary-right">{fmtBaht(subtotalBeforeTax)}</span>
              </div>
              {showVatRow ? (
                <div className="summary-row">
                  <span>ภาษีมูลค่าเพิ่ม ({branchSettings.vatRate}%)</span>
                  <span className="summary-right">{fmtBaht(order.vatAmt)}</span>
                </div>
              ) : null}
              {order.surcharge > 0 ? (
                <div className="summary-row">
                  <span>ค่าธรรมเนียม</span>
                  <span className="summary-right">{fmtBaht(order.surcharge)}</span>
                </div>
              ) : null}
              <div className="summary-row total">
                <span>ยอดสุทธิ</span>
                <span className="summary-right">{fmtBaht(order.total)}</span>
              </div>
              <div className="summary-row text-muted" style={{ fontSize: '8pt', marginTop: '1mm' }}>
                <span>ชำระแล้ว</span>
                <span className="summary-right">{fmtBaht(paidTotal)}</span>
              </div>
              <div className="summary-row text-success">
                <span>คงเหลือ</span>
                <span className="summary-right">{fmtBaht(remaining)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="note-box">
            <div className="note-label">หมายเหตุ / Notes</div>
            <div className="note-text">
              {noteLines.map((line, i) => (
                <span key={i}>
                  {line}
                  {i < noteLines.length - 1 ? <br /> : null}
                </span>
              ))}
            </div>
          </div>
        )}

        {cfg.showSig ? (
          <div className="sig-grid">
            <div className="sig-box">
              <div className="sig-label">ผู้รับสินค้า / Received by</div>
              <div className="sig-name">.....................................</div>
            </div>
            <div className="sig-box">
              <div className="sig-label">ผู้จัดส่ง / Delivered by</div>
              <div className="sig-name">{order.staffName}</div>
            </div>
            <div className="sig-box">
              <div className="sig-label">ผู้มีอำนาจอนุมัติ / Authorized</div>
              <div className="sig-name">.....................................</div>
            </div>
          </div>
        ) : null}

        <div className="doc-footer">
          <div className="doc-footer-left">
            พิมพ์เมื่อ: {formatThaiDate(printedAt, true)} · TwinPet POS v2.4.1
          </div>
          <div className="doc-footer-right">หน้า 1/1 · {number}</div>
        </div>
      </div>
    </div>
  );
}
