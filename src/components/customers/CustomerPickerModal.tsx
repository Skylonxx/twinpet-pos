import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { POS_FEATURES } from '../../lib/config/features';
import { priceLevelLabel, usePriceLevels } from '../../lib/pricing/priceLevels';
import { customerFullName, customerInitials, inferContactType } from '../../lib/customers/types';
import { useCustomers } from '../../lib/customers/useCustomers';
import './CustomerPickerModal.css';

export type PosCustomerPick = {
  id: string;
  name: string;
  phone: string;
  customerType: string;
  lifetimeValue: number;
  points: number;
  creditLimit: number;
  outstandingBalance: number;
};

type Props = {
  open: boolean;
  branchId: string | null;
  onClose: () => void;
  onSelect: (customer: PosCustomerPick) => void;
};

function toPick(c: {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  customerType: string;
  lifetimeValue: number;
  points: number;
  creditLimit: number;
  outstandingBalance?: number;
}): PosCustomerPick {
  return {
    id: c.id,
    name: customerFullName(c),
    phone: c.phone,
    customerType: c.customerType,
    lifetimeValue: c.lifetimeValue,
    points: c.points,
    creditLimit: c.creditLimit,
    outstandingBalance: c.outstandingBalance ?? 0,
  };
}

export default function CustomerPickerModal({ open, branchId, onClose, onSelect }: Props) {
  const { customers, loading } = useCustomers(branchId);
  const { priceLevels: customerTiers } = usePriceLevels(branchId);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const retailCustomers = useMemo(
    () =>
      customers.filter(
        (c) => c.isActive && !c.deletedAt && inferContactType(c) !== 'supplier',
      ),
    [customers],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return retailCustomers;
    return retailCustomers.filter(
      (c) =>
        customerFullName(c).toLowerCase().includes(q) ||
        c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')) ||
        c.phone.includes(q),
    );
  }, [retailCustomers, query]);

  if (!open) return null;

  return createPortal(
    <div className="cps-overlay" role="dialog" aria-modal="true" aria-labelledby="cps-title" onClick={onClose}>
      <div className="cps-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cps-head">
          <span id="cps-title" className="cps-title">
            เลือกลูกค้า
          </span>
          <button type="button" className="cps-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="cps-search">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            ref={searchRef}
            placeholder="ค้นหาชื่อหรือเบอร์โทร"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>

        <div className="cps-list">
          {loading ? (
            <p className="cps-loading">กำลังโหลดรายชื่อลูกค้า...</p>
          ) : filtered.length === 0 ? (
            <p className="cps-empty">
              {retailCustomers.length === 0
                ? 'ยังไม่มีลูกค้าในระบบ — เพิ่มได้ที่หน้าจัดการลูกค้า'
                : 'ไม่พบลูกค้าที่ตรงกับคำค้นหา'}
            </p>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                className="cps-row"
                onClick={() => onSelect(toPick(c))}
              >
                <span className="cps-avatar">{customerInitials(c)}</span>
                <span className="cps-info">
                  <span className="cps-name">{customerFullName(c)}</span>
                  <span className="cps-meta">
                    {c.memberNo} · {c.phone} · {priceLevelLabel(customerTiers, c.customerType)}
                    {POS_FEATURES.enableLoyaltyPoints ? ` · ${c.points} แต้ม` : ''}
                  </span>
                </span>
                <i className="ti ti-chevron-right cps-chevron" aria-hidden="true" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
