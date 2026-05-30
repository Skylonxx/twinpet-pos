import { useCallback, useMemo, useState } from 'react';
import StockOverviewTab from '../components/stockReport/StockOverviewTab';
import StockProductsTab from '../components/stockReport/StockProductsTab';
import StockFifoTab from '../components/stockReport/StockFifoTab';
import StockMovementTab from '../components/stockReport/StockMovementTab';
import { downloadCsv } from '../lib/stockReport/exportCsv';
import { applyCogsRange, useStockReport } from '../lib/stockReport/useStockReport';
import {
  monthStartIso,
  stockStatus,
  todayIso,
  type StockTab,
} from '../lib/stockReport/types';
import { useAuth } from '../lib/hooks/useAuth';
import './StockReportPage.css';

export default function StockReportPage({ branchId: branchIdProp }: { branchId?: string } = {}) {
  // When embedded (e.g. Admin), a branchId prop overrides the auth branch.
  // This is the ONLY change to source — the core useStockReport logic is untouched.
  const { branchId: authBranchId } = useAuth();
  const branchId = branchIdProp ?? authBranchId;
  const { products, movements, categories, loading } = useStockReport(branchId);

  const [tab, setTab] = useState<StockTab>('overview');
  const [toast, setToast] = useState<string | null>(null);

  // Overview COGS window is fixed to the current month (the picker was removed for a cleaner UI).
  const ovFrom = monthStartIso();
  const ovTo = todayIso();

  const productsWithCogs = useMemo(
    () => applyCogsRange(products, movements, ovFrom, ovTo),
    [products, movements, ovFrom, ovTo],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const exportStockCsv = useCallback(() => {
    const rows = [
      ['SKU', 'ชื่อสินค้า', 'หมวดหมู่', 'คงเหลือ', 'Avg Cost', 'COGS', 'มูลค่าสต็อก', 'สถานะ'],
      ...productsWithCogs.map((p) => [
        p.sku,
        p.name,
        p.category,
        String(p.qty),
        String(p.avgCost),
        String(p.cogsMonth),
        String(p.stockValue),
        stockStatus(p.qty, p.reorderPoint),
      ]),
    ];
    downloadCsv(rows, 'stock_report');
    showToast('Export Stock Report เรียบร้อย');
  }, [productsWithCogs, showToast]);

  if (loading) {
    return <div className="sr-page sr-loading">กำลังโหลดรายงานสต็อก...</div>;
  }

  return (
    <div className="sr-page">
      <header className="sr-topbar">
        <div className="sr-topbar-icon">
          <i className="ti ti-package" aria-hidden="true" />
        </div>
        <div className="sr-topbar-center">
          <div className="sr-topbar-title">รายงานสต็อก &amp; FIFO</div>
          <div className="sr-topbar-sub">Stock Report &amp; FIFO Costing</div>
        </div>
        <button type="button" className="sr-btn sr-btn-ghost sr-btn-sm" onClick={exportStockCsv}>
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
      </header>

      <nav className="sr-tabs-bar">
        {(
          [
            ['overview', 'ti-layout-dashboard', 'ภาพรวม', null],
            ['products', 'ti-list', 'รายสินค้า', products.length],
            ['fifo', 'ti-stack', 'FIFO Queue', null],
            ['movement', 'ti-arrow-left-right', 'Stock Movement', movements.length],
          ] as const
        ).map(([key, icon, label, badge]) => (
          <button
            key={key}
            type="button"
            className={`sr-tab-btn${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            <i className={`ti ${icon}`} aria-hidden="true" />
            {label}
            {badge != null && <span className="sr-tab-badge">{badge}</span>}
          </button>
        ))}
      </nav>

      <div className="sr-content">
        {tab === 'overview' && <StockOverviewTab productsWithCogs={productsWithCogs} />}
        {tab === 'products' && (
          <StockProductsTab
            productsWithCogs={productsWithCogs}
            categories={categories}
            branchId={branchId}
            onToast={showToast}
            onExportStock={exportStockCsv}
          />
        )}
        {tab === 'fifo' && (
          <StockFifoTab
            productsWithCogs={productsWithCogs}
            categories={categories}
            branchId={branchId}
            onToast={showToast}
          />
        )}
        {tab === 'movement' && (
          <StockMovementTab
            products={products}
            movements={movements}
            categories={categories}
            onToast={showToast}
          />
        )}
      </div>

      {toast && <div className="sr-toast">{toast}</div>}
    </div>
  );
}
