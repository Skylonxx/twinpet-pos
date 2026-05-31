import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePriceLevels } from '../../lib/pricing/priceLevels';
import { fmtBaht } from '../../lib/productCrud/types';
import type { PriceLevel } from '../../lib/types';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  basePrice: number;
  initialTierPrices: Record<string, number>;
  onSave: (newTierPrices: Record<string, number>) => void;
};

export default function TierPriceManagerDialog({
  isOpen,
  onClose,
  title,
  basePrice,
  initialTierPrices,
  onSave,
}: Props) {
  const { priceLevels: tiers, loading } = usePriceLevels();
  const [tierPrices, setTierPrices] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [adjustGroup, setAdjustGroup] = useState<PriceLevel | null>(null);
  const [priceMode, setPriceMode] = useState<'default' | 'custom'>('default');
  const [customPrice, setCustomPrice] = useState<number | ''>('');

  useEffect(() => {
    if (!isOpen) return;
    setTierPrices({ ...(initialTierPrices ?? {}) });
    setSearch('');
    setAdjustGroup(null);
  }, [isOpen, initialTierPrices]);

  const filteredTiers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tiers;
    return tiers.filter(
      (t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q),
    );
  }, [tiers, search]);

  const openAdjust = (tier: PriceLevel) => {
    const existing = tierPrices[tier.id];
    setAdjustGroup(tier);
    if (existing != null) {
      setPriceMode('custom');
      setCustomPrice(existing);
    } else {
      setPriceMode('default');
      setCustomPrice(basePrice);
    }
  };

  const saveAdjust = () => {
    if (!adjustGroup) return;

    if (priceMode === 'default') {
      setTierPrices((prev) => {
        const next = { ...prev };
        delete next[adjustGroup.id];
        return next;
      });
    } else {
      const price = Number(customPrice);
      if (!Number.isFinite(price) || price <= 0) return;
      setTierPrices((prev) => ({ ...prev, [adjustGroup.id]: price }));
    }

    setAdjustGroup(null);
  };

  const handleMainSave = () => {
    onSave({ ...tierPrices });
    onClose();
  };

  if (!isOpen) return null;

  return createPortal(
    <>
      <div
        className="tpmd-overlay pc-modal-overlay--stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tpmd-title"
        onClick={onClose}
      >
        <div className="tpmd-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="tpmd-header">
            <div>
              <div className="tpmd-title" id="tpmd-title">
                {title}
              </div>
              <div className="tpmd-subtitle">ราคาขายตั้งต้น : ฿{fmtBaht(basePrice)}</div>
            </div>
            <button type="button" className="tpmd-close" onClick={onClose} aria-label="ปิด">
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          </div>

          <div className="tpmd-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              type="text"
              placeholder="ค้นหากลุ่มลูกค้า..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="tpmd-table-wrap">
            <table className="tpmd-table">
              <thead>
                <tr>
                  <th>ชื่อกลุ่มลูกค้า</th>
                  <th>ประเภท</th>
                  <th className="r">ราคาขาย</th>
                  <th style={{ width: 72 }} />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="tpmd-empty">
                      กำลังโหลด...
                    </td>
                  </tr>
                ) : filteredTiers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="tpmd-empty">
                      ไม่พบกลุ่มลูกค้า
                    </td>
                  </tr>
                ) : (
                  filteredTiers.map((tier) => {
                    const custom = tierPrices[tier.id];
                    const hasCustom = custom != null;
                    const displayPrice = hasCustom ? custom : basePrice;

                    return (
                      <tr key={tier.id}>
                        <td>
                          <div className="tpmd-group-name">{tier.name}</div>
                          <div className="tpmd-group-id">{tier.id}</div>
                        </td>
                        <td>
                          {hasCustom ? (
                            <span className="tpmd-type-custom">ระบุราคาขาย</span>
                          ) : (
                            <span className="tpmd-type-default">(ราคาปกติ)</span>
                          )}
                        </td>
                        <td className="r tpmd-price">฿{fmtBaht(displayPrice)}</td>
                        <td className="r">
                          <button type="button" className="tpmd-adjust-btn" onClick={() => openAdjust(tier)}>
                            ปรับ
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="tpmd-footer">
            <button type="button" className="tpmd-btn-cancel" onClick={onClose}>
              ยกเลิก
            </button>
            <button type="button" className="tpmd-btn-save" onClick={handleMainSave}>
              บันทึก
            </button>
          </div>
        </div>
      </div>

      {adjustGroup ? (
        <div
          className="tpmd-adjust-overlay pc-modal-overlay--stack tpmd-adjust-overlay--stack"
          role="dialog"
          aria-modal="true"
          onClick={() => setAdjustGroup(null)}
        >
          <div className="tpmd-adjust-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tpmd-adjust-title">ปรับราคาตามกลุ่มลูกค้า</div>
            <div className="tpmd-adjust-meta">
              <div>
                <span className="tpmd-adjust-lbl">กลุ่มลูกค้า</span>
                <strong>{adjustGroup.name}</strong>
              </div>
              <div>
                <span className="tpmd-adjust-lbl">สินค้า / หน่วย</span>
                <strong>{title}</strong>
              </div>
            </div>

            <div className="tpmd-radio-group">
              <label className="tpmd-radio">
                <input
                  type="radio"
                  name="tier-price-mode"
                  checked={priceMode === 'default'}
                  onChange={() => setPriceMode('default')}
                />
                <span>ใช้ราคาตั้งต้น (Default) — ฿{fmtBaht(basePrice)}</span>
              </label>
              <label className="tpmd-radio">
                <input
                  type="radio"
                  name="tier-price-mode"
                  checked={priceMode === 'custom'}
                  onChange={() => setPriceMode('custom')}
                />
                <span>ระบุราคาขาย</span>
              </label>
            </div>

            {priceMode === 'custom' ? (
              <div className="tpmd-custom-price-field">
                <label>ราคาขาย (บาท)</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={customPrice}
                  onChange={(e) =>
                    setCustomPrice(e.target.value === '' ? '' : Number(e.target.value))
                  }
                />
              </div>
            ) : null}

            <div className="tpmd-adjust-footer">
              <button type="button" className="tpmd-btn-cancel" onClick={() => setAdjustGroup(null)}>
                ยกเลิก
              </button>
              <button type="button" className="tpmd-btn-save" onClick={saveAdjust}>
                ยืนยัน
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
