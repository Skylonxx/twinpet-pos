import { describe, it, expect } from 'vitest';
import { settingsToForm, formToSettings, DEFAULT_NOTIFICATIONS } from './types';
import { DEFAULT_REQUIRES_PASSWORD_FOR_VOID } from '../hooks/useBranchSettings';
import type { Branch, Settings } from '../types';

// Timestamps are not read by settingsToForm/formToSettings — a null cast is fine.
const ts = null as unknown as Settings['updatedAt'];

const baseSettings = (over: Partial<Settings> = {}): Settings => ({
  branchId: 'LDP-001',
  vatRegistered: false,
  vatRate: 7,
  priceIncludesVat: true,
  paymentMethods: { cash: true, qr: true, kbank: true, card: true, credit: true },
  receiptHeader: '',
  receiptFooter: '',
  receiptLogoUrl: null,
  showBarcodeOnReceipt: true,
  showQrOnReceipt: false,
  pinMaxAttempts: 5,
  sessionTimeoutMin: 30,
  notifications: DEFAULT_NOTIFICATIONS,
  lineNotifyToken: null,
  allowNegativeStock: false,
  negativeStockWarning: true,
  parkedOrderExpiryHours: 4,
  updatedAt: ts,
  ...over,
});

const baseBranch: Branch = {
  id: 'LDP-001',
  name: 'Branch',
  address: '',
  phone: '',
  email: '',
  taxId: '',
  logoUrl: null,
  isActive: true,
  createdAt: ts as Branch['createdAt'],
  updatedAt: ts as Branch['updatedAt'],
};

describe('Phase 7B-3B — requiresPasswordForVoid default-on-read (security-first)', () => {
  it('defaults to TRUE when the field is missing from the settings doc', () => {
    const form = settingsToForm(baseSettings(), baseBranch);
    expect(form.requiresPasswordForVoid).toBe(true);
  });

  it('preserves an explicit false', () => {
    const form = settingsToForm(baseSettings({ requiresPasswordForVoid: false }), baseBranch);
    expect(form.requiresPasswordForVoid).toBe(false);
  });

  it('preserves an explicit true', () => {
    const form = settingsToForm(baseSettings({ requiresPasswordForVoid: true }), baseBranch);
    expect(form.requiresPasswordForVoid).toBe(true);
  });

  it('formToSettings round-trips the value, and a legacy form (no field) defaults to true', () => {
    const form = settingsToForm(baseSettings({ requiresPasswordForVoid: false }), baseBranch);
    expect(formToSettings(form, 'LDP-001').requiresPasswordForVoid).toBe(false);

    const legacy = { ...form };
    delete (legacy as Record<string, unknown>).requiresPasswordForVoid;
    expect(formToSettings(legacy, 'LDP-001').requiresPasswordForVoid).toBe(true);
  });

  it('the runtime default constant is security-first (true)', () => {
    expect(DEFAULT_REQUIRES_PASSWORD_FOR_VOID).toBe(true);
  });
});
