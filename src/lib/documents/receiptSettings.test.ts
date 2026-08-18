import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MERGED_RECEIPT_FIELDS, mergeAuthoritativeSettings } from './receiptSettings';

const branch = { name: 'LDP', address: 'a', phone: 'p', email: 'e', taxId: 't', logoUrl: null };
const settings = {
  companyName: 'TwinPet',
  receiptHeader: 'h',
  receiptFooter: 'f',
  vatRegistered: true,
  vatRate: 7,
  priceIncludesVat: true,
  showVatOnThermal: true,
  showBarcodeOnReceipt: false,
  showQrOnReceipt: false,
  showLogoOnReceipt: true,
  showStaffOnReceipt: true,
  showSignatureOnReceipt: true,
};

const getDocFromServer = vi.fn();
vi.mock('firebase/firestore', () => ({
  getDocFromServer: (...args: unknown[]) => getDocFromServer(...args),
  doc: (_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` }),
}));
vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
}));

describe('I receipt settings', () => {
  beforeEach(() => {
    getDocFromServer.mockReset();
    vi.resetModules();
  });

  test('I01 settings resolve for order.branchId, not the active branch', async () => {
    getDocFromServer.mockImplementation(async (ref: { path: string }) => ({
      exists: () => true,
      data: () => (ref.path.startsWith('branches/') ? branch : settings),
    }));
    const { loadReceiptSettingsForOrderBranch } = await import('./receiptSettings');
    await loadReceiptSettingsForOrderBranch('brA', 'AUTHORITATIVE', true);
    const paths = getDocFromServer.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(paths).toEqual(expect.arrayContaining(['branches/brA', 'settings/brA']));
    expect(paths.some((p) => p.includes('active'))).toBe(false);
  });

  test('I02 cross-branch isolation', async () => {
    getDocFromServer.mockImplementation(async (ref: { path: string }) => ({
      exists: () => true,
      data: () => (ref.path.endsWith('brB') ? { ...settings, companyName: 'OTHER' } : ref.path.startsWith('branches/') ? branch : settings),
    }));
    const { loadReceiptSettingsForOrderBranch } = await import('./receiptSettings');
    const r = await loadReceiptSettingsForOrderBranch('brA', 'AUTHORITATIVE', false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settings.companyName).not.toBe('OTHER');
    const paths = getDocFromServer.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(paths.every((p) => p.endsWith('/brA'))).toBe(true);
  });

  test('I03 missing branches/{id} fail closed with stated reason', async () => {
    getDocFromServer.mockImplementation(async (ref: { path: string }) => ({
      exists: () => !ref.path.startsWith('branches/'),
      data: () => settings,
    }));
    const { loadReceiptSettingsForOrderBranch } = await import('./receiptSettings');
    const r = await loadReceiptSettingsForOrderBranch('brA', 'AUTHORITATIVE', false);
    expect(r).toEqual({ ok: false, reason: 'missing_branch' });
  });

  test('I04 missing settings/{id} fail closed with stated reason', async () => {
    getDocFromServer.mockImplementation(async (ref: { path: string }) => ({
      exists: () => ref.path.startsWith('branches/'),
      data: () => branch,
    }));
    const { loadReceiptSettingsForOrderBranch } = await import('./receiptSettings');
    const r = await loadReceiptSettingsForOrderBranch('brA', 'AUTHORITATIVE', false);
    expect(r).toEqual({ ok: false, reason: 'missing_settings' });
  });

  test('I05 read failure / offline / unavailable fail closed; no default substitution', async () => {
    getDocFromServer.mockRejectedValue(new Error('unavailable'));
    const { loadReceiptSettingsForOrderBranch } = await import('./receiptSettings');
    const r = await loadReceiptSettingsForOrderBranch('brA', 'AUTHORITATIVE', false);
    expect(r).toEqual({ ok: false, reason: 'read_failure' });
  });

  test('I06 DEFAULT_BRANCH_DOCUMENT_SETTINGS unreachable from authority path', async () => {
    const src = (await import('./receiptSettings.ts?raw')).default as string;
    expect(src.includes('DEFAULT_BRANCH_DOCUMENT_SETTINGS')).toBe(false);
  });

  test('I07 adapter uses getDocFromServer for both documents', async () => {
    const src = (await import('./receiptSettings.ts?raw')).default as string;
    const matches = src.match(/getDocFromServer/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(src.includes('getDoc(')).toBe(false);
  });

  test('I08 every one of the 18 merged fields classified; exact set', () => {
    expect([...MERGED_RECEIPT_FIELDS]).toEqual([
      'companyName',
      'branchName',
      'branchAddress',
      'branchPhone',
      'branchEmail',
      'taxId',
      'logoUrl',
      'receiptHeader',
      'receiptFooter',
      'vatRegistered',
      'vatRate',
      'priceIncludesVat',
      'showVatOnThermal',
      'showBarcodeOnReceipt',
      'showQrOnReceipt',
      'showLogoOnReceipt',
      'showStaffOnReceipt',
      'showSignatureOnReceipt',
    ]);
  });

  test('I09 showLogoOnReceipt from settings; absent → suppressed, not true', () => {
    const merged = mergeAuthoritativeSettings(branch, { ...settings, showLogoOnReceipt: undefined }, 'AUTHORITATIVE', false);
    expect(merged.showLogoOnReceipt).toBe(false);
  });

  test('I10 companyName from settings; absent → unset, not the code constant', () => {
    const merged = mergeAuthoritativeSettings(branch, { ...settings, companyName: undefined }, 'AUTHORITATIVE', false);
    expect(merged.companyName).toBe('');
    expect(merged.companyName).not.toBe('บริษัท ทวิน เพ็ท จำกัด');
  });

  test('I11 showStaffOnReceipt / showSignatureOnReceipt forced false on authority path', () => {
    const merged = mergeAuthoritativeSettings(branch, settings, 'AUTHORITATIVE', true);
    expect(merged.showStaffOnReceipt).toBe(false);
    expect(merged.showSignatureOnReceipt).toBe(false);
  });

  test('I12 no value from DEFAULT_EXTRAS reachable from the authority path', async () => {
    const src = (await import('./receiptSettings.ts?raw')).default as string;
    expect(src.includes('DEFAULT_EXTRAS')).toBe(false);
  });
});
