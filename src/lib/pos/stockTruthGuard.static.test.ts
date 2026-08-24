import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(process.cwd());

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

const PROTECTED = [
  'src/pages/POSPage.tsx',
  'src/hooks/pos/useCart.ts',
  'src/components/products/ProductPickerDialog.tsx',
  'src/components/products/productPickerTypes.ts',
] as const;

const PINNED_STOCK_TOKEN_COUNTS: Record<(typeof PROTECTED)[number], number> = {
  'src/pages/POSPage.tsx': 3,
  'src/hooks/pos/useCart.ts': 4,
  'src/components/products/ProductPickerDialog.tsx': 3,
  'src/components/products/productPickerTypes.ts': 4,
};

function rawStockTokens(src: string): number {
  return (src.match(/\.stock\b/g) ?? []).length;
}

describe('stockTruthGuard.static', () => {
  test('T17 protected human surfaces call formatStockTruth and pin .stock token counts', () => {
    for (const file of PROTECTED) {
      const src = read(file);
      expect(src, file).toContain('formatStockTruth(');
      expect(rawStockTokens(src), file).toBe(PINNED_STOCK_TOKEN_COUNTS[file]);
    }
    const pos = read('src/pages/POSPage.tsx');
    expect(pos).toContain('product.stock < neededBase');
  });

  test('T17 synthetic bypass fixture fails the pinned-count predicate', () => {
    const src = read('src/components/products/ProductPickerDialog.tsx');
    const bypass = `${src}\n<span>{p.stock}</span>`;
    expect(bypass).toContain('formatStockTruth(');
    expect(rawStockTokens(bypass)).toBeGreaterThan(PINNED_STOCK_TOKEN_COUNTS['src/components/products/ProductPickerDialog.tsx']);
  });

  test('T48 reversalStockOverlay.ts is unchanged by PK-5 (no stockTruth writes)', () => {
    const src = read('src/lib/pos/offline/reversalStockOverlay.ts');
    expect(src.includes('stockTruth')).toBe(false);
    expect(src.includes('formatStockTruth')).toBe(false);
  });

  test('T49 PK-4 Sync Center has no stockTruth coupling', () => {
    const files = [
      'src/lib/pos/offline/syncCenterModel.ts',
      'src/lib/pos/offline/syncCenterReader.ts',
      'src/lib/pos/offline/syncCenterAuthority.ts',
      'src/lib/pos/offline/syncCenterActions.ts',
      'src/pages/SyncCenterPage.tsx',
    ];
    for (const file of files) {
      const src = read(file);
      expect(src.includes('stockTruth')).toBe(false);
      expect(src.includes('formatStockTruth')).toBe(false);
    }
  });

  test('T50 PaymentModal and useCheckout are untouched', () => {
    for (const file of ['src/components/PaymentModal.tsx', 'src/hooks/pos/useCheckout.ts']) {
      const src = read(file);
      expect(src.includes('stockTruth')).toBe(false);
      expect(src.includes('formatStockTruth')).toBe(false);
    }
  });

  test('T51 no new indexedDB.open in the PK-5 production allowlist; repo production count stays 8', () => {
    const pk5 = [
      'src/lib/pos/types.ts',
      'src/lib/pos/posProductMapper.ts',
      'src/lib/pos/inventoryRepository.ts',
      'src/lib/pos/usePosProducts.ts',
      'src/lib/pos/devProducts.ts',
      'src/lib/receiving/types.ts',
      'src/lib/pos/stockTruthDisplay.ts',
      'src/pages/POSPage.tsx',
      'src/hooks/pos/useCart.ts',
      'src/components/products/productPickerTypes.ts',
      'src/components/products/ProductPickerDialog.tsx',
      'src/lib/pos/localSalesDelta.ts',
      'src/lib/hooks/useLocalSalesDelta.ts',
      'src/hooks/pos/usePosInventory.ts',
      'src/lib/salesHistory/useOrderItemsLive.ts',
      'src/pages/SalesHistoryPage.tsx',
    ];
    for (const file of pk5) {
      expect(read(file).includes('indexedDB.open(')).toBe(false);
    }
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`;
        const st = statSync(full);
        if (st.isDirectory()) {
          if (name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (/\.test\.(ts|tsx)$/.test(name)) continue;
        const src = readFileSync(full, 'utf8');
        const n = (src.match(/indexedDB\.open\(/g) ?? []).length;
        if (n) hits.push(`${full}:${n}`);
      }
    };
    walk(resolve(root, 'src'));
    const total = hits.reduce((sum, h) => sum + Number(h.split(':').pop()), 0);
    expect(total).toBe(8);
  });

  test('T40 useSalesHistory.loadItems remains present; T41 print uses fetchOrderReceipt only', () => {
    const history = read('src/lib/salesHistory/useSalesHistory.ts');
    expect(history).toContain('const loadItems = useCallback');
    const page = read('src/pages/SalesHistoryPage.tsx');
    expect(page).toContain('fetchOrderReceipt(selected.order.id)');
    expect(page.includes('loadItems(')).toBe(false);
  });

  test('T47 stock sorting helpers are not rewritten by PK-5 display gating', () => {
    const pos = read('src/pages/POSPage.tsx');
    expect(pos).toContain('sortProductsByCustomOrder');
    expect(pos).toContain('formatStockTruth(');
  });
});
