import { describe, expect, it } from 'vitest';
import appSource from '../App.tsx?raw';
import { ALL_NAV_ITEMS, isNavItemActive, NAV_CATEGORIES } from './navigation';

describe('PK-4 navigation', () => {
  it('N-N1 registers Sync Center once under sales', () => {
    const hits = ALL_NAV_ITEMS.filter((item) => item.path === '/sync-center');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe('ศูนย์ซิงก์');
    expect(NAV_CATEGORIES.find((c) => c.id === 'sales')?.items.some((i) => i.path === '/sync-center')).toBe(
      true,
    );
  });

  it('N-N2 Sync Center active matching is exact', () => {
    expect(isNavItemActive('/sync-center', '/sync-center')).toBe(true);
    expect(isNavItemActive('/sync-center', '/sync-center/x')).toBe(false);
    expect(isNavItemActive('/sales-history', '/sales-history')).toBe(true);
    expect(isNavItemActive('/settings', '/settings/general')).toBe(true);
  });

  it('N-N3 registers manual-review once under system', () => {
    const hits = ALL_NAV_ITEMS.filter((item) => item.path === '/manual-review');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe('ตรวจสอบด้วยตนเอง');
    expect(NAV_CATEGORIES.find((c) => c.id === 'system')?.items.some((i) => i.path === '/manual-review')).toBe(
      true,
    );
  });

  it('N-N4 does not add a permanent shift-close-review nav item (D2=A)', () => {
    expect(ALL_NAV_ITEMS.some((item) => item.path === '/shift-close-review')).toBe(false);
    expect(ALL_NAV_ITEMS.some((item) => item.path.startsWith('/shift-close-review'))).toBe(false);
  });

  it('N-N5 App.tsx registers /sync-center inside PosShellRoute and keeps prior routes', () => {
    expect(appSource).toMatch(/path="\/sync-center"/);
    expect(appSource).toMatch(/path="\/sales-history"/);
    expect(appSource).toMatch(/path="\/manual-review"/);
    expect(appSource).toMatch(/path="\/shift-close-review"/);
    expect(appSource).toMatch(/Route-only \(direct URL\); no nav entry by design — Packet 5 UI-A/);
  });
});
