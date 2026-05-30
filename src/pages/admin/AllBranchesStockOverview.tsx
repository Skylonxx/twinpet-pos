import { useMemo, useState } from 'react';
import { fmtBaht, fmtNum } from '../../lib/stockReport/types';
import { useAllBranchesStock } from '../../lib/stockReport/useAllBranchesStock';
import './AllBranchesStockOverview.css';

/**
 * Executive, cross-branch stock overview rendered when the Admin picks
 * "รวมทุกสาขา" (ALL) in {@link AdminStockReportPage}. Self-contained: it owns
 * its data via {@link useAllBranchesStock} and never touches the single-branch
 * report, so the branch-level view is guaranteed unchanged.
 */
export default function AllBranchesStockOverview() {
  const { rows, totalQty, totalValue, productCount, loading, error } = useAllBranchesStock();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.sku.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q),
    );
  }, [rows, search]);

  return (
    <div className="abs-wrap">
      <div className="abs-summary">
        <div className="abs-stat">
          <div className="abs-stat-label">จำนวนสินค้า</div>
          <div className="abs-stat-value">{loading ? '…' : fmtNum(productCount)}</div>
        </div>
        <div className="abs-stat">
          <div className="abs-stat-label">จำนวนรวม (ทุกสาขา)</div>
          <div className="abs-stat-value">{loading ? '…' : fmtNum(totalQty)}</div>
        </div>
        <div className="abs-stat abs-stat-accent">
          <div className="abs-stat-label">มูลค่าสต็อกรวม</div>
          <div className="abs-stat-value">{loading ? '…' : fmtBaht(totalValue)}</div>
        </div>
      </div>

      <div className="abs-card">
        <div className="abs-card-head">
          <i className="ti ti-building-warehouse" aria-hidden="true" />
          <span>ภาพรวมสต็อกรวมทุกสาขา</span>
          <span className="abs-count">
            {loading ? '…' : `${fmtNum(filtered.length)} รายการ`}
          </span>
          <div className="abs-search">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              placeholder="ค้นหาสินค้า, SKU, หมวดหมู่..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="abs-table-wrap">
          {error ? (
            <div className="abs-msg abs-msg-error">
              <i className="ti ti-alert-circle" aria-hidden="true" /> {error}
            </div>
          ) : loading ? (
            <div className="abs-msg">กำลังโหลดข้อมูลสต็อกทุกสาขา...</div>
          ) : (
            <table className="abs-table">
              <thead>
                <tr>
                  <th>สินค้า</th>
                  <th className="abs-num">จำนวนรวม (ทุกสาขา)</th>
                  <th className="abs-num">ต้นทุน/หน่วย</th>
                  <th className="abs-num">มูลค่ารวม</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="abs-empty-cell">
                      ไม่พบสินค้า
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="abs-prod-name">{r.name}</div>
                        <div className="abs-prod-sub">
                          {r.sku}
                          {r.branchCount > 0 ? ` · ${r.branchCount} สาขา` : ''}
                        </div>
                      </td>
                      <td className="abs-num">{fmtNum(r.totalQty)}</td>
                      <td className="abs-num">{fmtBaht(r.avgCost)}</td>
                      <td className="abs-num abs-num-strong">{fmtBaht(r.totalValue)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              {filtered.length > 0 ? (
                <tfoot>
                  <tr>
                    <td>รวมทั้งสิ้น ({fmtNum(filtered.length)} รายการ)</td>
                    <td className="abs-num">
                      {fmtNum(filtered.reduce((s, r) => s + r.totalQty, 0))}
                    </td>
                    <td className="abs-num">—</td>
                    <td className="abs-num abs-num-strong">
                      {fmtBaht(filtered.reduce((s, r) => s + r.totalValue, 0))}
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
