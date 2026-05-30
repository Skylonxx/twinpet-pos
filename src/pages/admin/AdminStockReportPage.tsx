import { useEffect, useState } from 'react';
import { fetchAllBranches } from '../../lib/admin/branchManagement';
import { seedBranchLabelCache } from '../../lib/branches';
import StockReportPage from '../StockReportPage';
import type { Branch } from '../../lib/types';
import './AdminStockReportPage.css';

/**
 * Admin wrapper around the (perfect, untouched) StockReportPage.
 *
 * A branch selector chooses ONE branch at a time and feeds it to the report via
 * the `branchId` prop. The core `useStockReport` aggregation is single-branch by
 * design, so this honours "do not modify the core logic" — there is no 'ALL'
 * rollup here (a true cross-branch aggregate would need a separate layer).
 */
export default function AdminStockReportPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState('');

  useEffect(() => {
    void fetchAllBranches().then((list) => {
      const active = list.filter((b) => b.isActive !== false);
      setBranches(active);
      seedBranchLabelCache(list);
      setSelectedBranchId((cur) => cur || active[0]?.id || '');
    });
  }, []);

  return (
    <div className="asr-wrap">
      <div className="asr-bar">
        <div className="asr-bar-title">
          <i className="ti ti-box" aria-hidden="true" />
          รายงานสต็อก (HQ)
        </div>
        <div className="asr-bar-field">
          <label htmlFor="asr-branch">สาขา</label>
          <select
            id="asr-branch"
            className="arv-branch-select"
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(e.target.value)}
            disabled={branches.length === 0}
          >
            {branches.length === 0 ? (
              <option value="">กำลังโหลดสาขา...</option>
            ) : (
              branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name?.trim() || b.id}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <div className="asr-report">
        {selectedBranchId ? (
          // Re-mount on branch change so the report's hook re-subscribes cleanly.
          <StockReportPage key={selectedBranchId} branchId={selectedBranchId} />
        ) : (
          <div className="asr-empty">เลือกสาขาเพื่อดูรายงานสต็อก</div>
        )}
      </div>
    </div>
  );
}
