import { useMemo } from 'react';
import {
  barcodeSVG,
  cashReceived,
  customerDisplayName,
  extractVatFromInclusive,
  fmtBahtSymbol,
  formatThaiDate,
  primaryPayLabel,
} from '../../lib/documents/formatters';
import type { ThermalReceiptProps } from '../../lib/documents/types';
import './ThermalReceipt.css';

const PICK_CHECKBOX = (
  <svg
    width="4mm"
    height="4mm"
    viewBox="0 0 12 12"
    style={{ verticalAlign: 'middle', flexShrink: 0 }}
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="none" stroke="#333" strokeWidth="1.2" />
  </svg>
);

function HeaderBlock({
  branchSettings,
  showLogo,
}: {
  branchSettings: ThermalReceiptProps['branchSettings'];
  showLogo: boolean;
}) {
  const headerLines = branchSettings.receiptHeader.split('\n');
  const addrLines = `${branchSettings.branchAddress}\nโทร: ${branchSettings.branchPhone}`.split('\n');

  return (
    <>
      {showLogo ? (
        branchSettings.logoUrl ? (
          <div className="logo-area">
            <img src={branchSettings.logoUrl} alt="" />
          </div>
        ) : (
          <div className="logo-area">🐾</div>
        )
      ) : null}
      {headerLines.map((line, i) => (
        <div key={`h-${i}`} className={`t-center${i === 0 ? ' t-bold t-lg' : ''}`}>
          {line}
        </div>
      ))}
      {addrLines.map((line, i) => (
        <div key={`a-${i}`} className="t-center t-sm">
          {line}
        </div>
      ))}
    </>
  );
}

function PickListContent({
  order,
  orderItems,
  customer,
  branchSettings,
}: Omit<ThermalReceiptProps, 'mode' | 'isCopy'>) {
  const custName = customerDisplayName(customer, order);
  const totalQty = orderItems.reduce((s, it) => s + it.qty, 0);

  return (
    <>
      <HeaderBlock branchSettings={branchSettings} showLogo={branchSettings.showLogoOnReceipt} />

      <div className="t-dash" />

      <div className="t-center t-bold" style={{ fontSize: '10pt', letterSpacing: '0.05em' }}>
        ใบจัดของ / PICK LIST
      </div>
      <div className="t-dash" />

      <div className="t-row">
        <span>บิลเลขที่</span>
        <span className="t-bold">{order.id}</span>
      </div>
      <div className="t-row">
        <span>วันที่</span>
        <span>{formatThaiDate(order.createdAt, true)}</span>
      </div>
      {custName ? (
        <div className="t-row">
          <span>ลูกค้า</span>
          <span>{custName}</span>
        </div>
      ) : null}
      {branchSettings.showStaffOnReceipt ? (
        <div className="t-row">
          <span>ผู้จัด</span>
          <span>{order.staffName}</span>
        </div>
      ) : null}

      <div className="t-solid" />

      <div className="t-row" style={{ fontWeight: 700, fontSize: '8pt' }}>
        <span style={{ width: '5mm', flexShrink: 0, textAlign: 'center' }}>✓</span>
        <span style={{ flex: 1, paddingLeft: '2mm' }}>รายการ</span>
        <span style={{ width: '14mm', textAlign: 'right' }}>จำนวน</span>
      </div>
      <div className="t-solid" style={{ marginTop: 0 }} />

      {orderItems.map((it, i) => (
        <div key={it.id} className={`pick-row${i % 2 === 1 ? ' alt' : ''}`}>
          <div className="pick-chk">{PICK_CHECKBOX}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '8pt', fontWeight: 500, lineHeight: 1.4 }}>{it.productSnap.name}</div>
            <div style={{ fontSize: '7pt', color: '#777' }}>
              SKU: {it.productSnap.sku} · {it.unit}
            </div>
          </div>
          <div style={{ width: '14mm', textAlign: 'right', fontWeight: 700, fontSize: '9pt' }}>{it.qty}</div>
        </div>
      ))}

      <div className="t-solid" />
      <div className="t-row t-bold">
        <span>รวมทั้งหมด</span>
        <span>{totalQty} ชิ้น</span>
      </div>

      <div className="t-dash" />
      <div className="pick-sig-grid">
        <div className="pick-sig-cell">ผู้จัดสินค้า</div>
        <div className="pick-sig-cell">ผู้รับสินค้า</div>
      </div>

      {branchSettings.showBarcodeOnReceipt ? (
        <>
          <div className="t-dash" />
          <div className="barcode-block" dangerouslySetInnerHTML={{ __html: barcodeSVG(order.id) }} />
        </>
      ) : null}

      <div className="t-center t-sm t-muted" style={{ marginTop: '2mm' }}>
        TwinPet POS v2.4.1
      </div>
    </>
  );
}

function ReceiptContent({
  order,
  orderItems,
  customer,
  branchSettings,
  isCopy,
}: ThermalReceiptProps) {
  const custName = customerDisplayName(customer, order);
  const payLabel = primaryPayLabel(order);
  const showVat = branchSettings.showVatOnThermal && branchSettings.vatRegistered;

  const { subtotal, totalDisc, total } = useMemo(() => {
    let sub = 0;
    let disc = 0;
    for (const it of orderItems) {
      sub += it.unitPrice * it.qty;
      disc += it.discountAmt;
    }
    disc += order.billDiscount;
    return { subtotal: sub, totalDisc: disc, total: order.total };
  }, [orderItems, order.billDiscount, order.total]);

  const vatInfo = showVat ? extractVatFromInclusive(total - order.surcharge, branchSettings.vatRate) : null;
  const isCash = payLabel === 'เงินสด';
  const cash = isCash ? cashReceived(order) : total;
  const change = isCash ? order.changeAmt || cash - total : 0;

  const footerLines = branchSettings.receiptFooter.split('\n');

  return (
    <>
      <HeaderBlock branchSettings={branchSettings} showLogo={branchSettings.showLogoOnReceipt} />

      {isCopy ? (
        <div className="t-center t-bold" style={{ marginTop: '1mm', fontSize: '8pt' }}>
          (สำเนา / COPY)
        </div>
      ) : null}

      <div className="t-dash" />

      <div className="t-row">
        <span>บิลเลขที่</span>
        <span className="t-bold">{order.id}</span>
      </div>
      <div className="t-row">
        <span>วันที่/เวลา</span>
        <span>{formatThaiDate(order.createdAt, true)}</span>
      </div>
      {custName ? (
        <div className="t-row">
          <span>ลูกค้า</span>
          <span>{custName}</span>
        </div>
      ) : null}
      {branchSettings.showStaffOnReceipt ? (
        <div className="t-row">
          <span>พนักงาน</span>
          <span>{order.staffName}</span>
        </div>
      ) : null}

      <div className="t-dash" />
      <div className="t-row">
        <span className="t-bold">รายการสินค้า</span>
        <span className="t-bold">฿</span>
      </div>
      <div className="t-solid" style={{ marginTop: 0 }} />

      {orderItems.map((it) => {
        const lineTotal = it.unitPrice * it.qty - it.discountAmt;
        return (
          <div key={it.id}>
            <div className="t-row">
              <span>{it.productSnap.name}</span>
            </div>
            <div className="t-indent t-row t-sm">
              <span>
                {it.qty} {it.unit} × {fmtBahtSymbol(it.unitPrice)}
                {it.discountAmt > 0 ? (
                  <span style={{ color: '#A32D2D' }}> (-{fmtBahtSymbol(it.discountAmt)})</span>
                ) : null}
              </span>
              <span>{fmtBahtSymbol(lineTotal)}</span>
            </div>
          </div>
        );
      })}

      <div className="t-solid" />

      {totalDisc > 0 ? (
        <>
          <div className="t-row">
            <span>รวมก่อนส่วนลด</span>
            <span>{fmtBahtSymbol(subtotal)}</span>
          </div>
          <div className="t-row" style={{ color: '#A32D2D' }}>
            <span>ส่วนลดรวม</span>
            <span>-{fmtBahtSymbol(totalDisc)}</span>
          </div>
        </>
      ) : null}

      {showVat && vatInfo ? (
        <>
          <div className="t-row">
            <span>ราคาสินค้า (excl.VAT)</span>
            <span>{fmtBahtSymbol(vatInfo.base)}</span>
          </div>
          <div className="t-row">
            <span>VAT {branchSettings.vatRate}%</span>
            <span>{fmtBahtSymbol(vatInfo.vat)}</span>
          </div>
        </>
      ) : null}

      {order.surcharge > 0 ? (
        <div className="t-row">
          <span>ค่าธรรมเนียม</span>
          <span>{fmtBahtSymbol(order.surcharge)}</span>
        </div>
      ) : null}

      <div className="t-double" />
      <div className="t-row t-bold t-lg">
        <span>ยอดสุทธิ</span>
        <span>{fmtBahtSymbol(total)}</span>
      </div>
      <div className="t-dash" />

      <div className="t-row">
        <span>ช่องทาง</span>
        <span>{payLabel}</span>
      </div>
      {isCash ? (
        <>
          <div className="t-row">
            <span>รับเงิน</span>
            <span>{fmtBahtSymbol(cash)}</span>
          </div>
          <div className="t-row t-bold">
            <span>เงินทอน</span>
            <span>{fmtBahtSymbol(change)}</span>
          </div>
        </>
      ) : (
        <div className="t-row t-bold">
          <span>ชำระ</span>
          <span>{fmtBahtSymbol(total)}</span>
        </div>
      )}

      {branchSettings.showSignatureOnReceipt ? (
        <>
          <div className="t-dash" />
          <div className="t-center t-sm" style={{ marginBottom: '8mm' }}>
            ลายเซ็นลูกค้า .....................................
          </div>
        </>
      ) : null}

      {branchSettings.showBarcodeOnReceipt ? (
        <>
          <div className="t-dash" />
          <div className="barcode-block" dangerouslySetInnerHTML={{ __html: barcodeSVG(order.id) }} />
        </>
      ) : null}

      {branchSettings.showQrOnReceipt ? (
        <>
          <div className="t-dash" />
          <div className="t-center t-sm">QR โปรโมชั่น / สะสมแต้ม</div>
          <div className="qr-block">
            <div className="qr-placeholder" />
          </div>
          <div className="t-center t-sm">scan เพื่อรับส่วนลดครั้งต่อไป</div>
        </>
      ) : null}

      <div className="t-dash" />
      {footerLines.map((line, i) => (
        <div key={`f-${i}`} className="t-center t-sm">
          {line}
        </div>
      ))}
      <div className="t-center t-sm t-muted" style={{ marginTop: '1mm' }}>
        TwinPet POS v2.4.1
      </div>
    </>
  );
}

export default function ThermalReceipt({
  order,
  orderItems,
  customer,
  branchSettings,
  mode = 'receipt',
  isCopy = false,
}: ThermalReceiptProps) {
  return (
    <div className="thermal-print-root" aria-hidden="true">
      <div className="thermal">
        {mode === 'picklist' ? (
          <PickListContent
            order={order}
            orderItems={orderItems}
            customer={customer}
            branchSettings={branchSettings}
          />
        ) : (
          <ReceiptContent
            order={order}
            orderItems={orderItems}
            customer={customer}
            branchSettings={branchSettings}
            isCopy={isCopy}
          />
        )}
      </div>
    </div>
  );
}
