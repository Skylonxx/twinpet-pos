import { useEffect, useState } from 'react';
import { fetchAllBranches } from '../../lib/admin/branchManagement';
import { seedBranchLabelCache } from '../../lib/branches';
import StockReportPage from '../StockReportPage';
import AllBranchesStockOverview from './AllBranchesStockOverview';
import type { Branch } from '../../lib/types';
import './AdminStockReportPage.css';

/** Sentinel for the consolidated cross-branch view. */
const ALL_BRANCHES = 'ALL';

/**
 * Admin wrapper around the (perfect, untouched) single-branch StockReportPage.
 *
 * The branch selector either picks ONE branch — feeding it to the report via
 * the `branchId` prop, leaving `useStockReport` exactly as-is — or "รวมทุกสาขา"
 * (ALL), which swaps in the separate {@link AllBranchesStockOverview} executive
 * rollup. The two paths never share state, so the branch-level report is
 * guaranteed unaffected.
 */
export default function AdminStockReportPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string>(ALL_BRANCHES);

  useEffect(() => {
    void fetchAllBranches().then((list) => {
      const active = list.filter((b) => b.isActive !== false);
      setBranches(active);
      seedBranchLabelCache(list);
    });
  }, []);

  const isAllBranches = selectedBranchId === ALL_BRANCHES;

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
          >
            <option value={ALL_BRANCHES}>รวมทุกสาขา</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name?.trim() || b.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="asr-report">
        {isAllBranches ? (
          <AllBranchesStockOverview />
        ) : (
          // Re-mount on branch change so the report's hook re-subscribes cleanly.
          <StockReportPage key={selectedBranchId} branchId={selectedBranchId} />
        )}
      </div>
    </div>
  );
}
