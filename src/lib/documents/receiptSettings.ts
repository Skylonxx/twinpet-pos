import { getDocFromServer, doc } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import type { Branch, Settings } from '../types';
import type { BranchDocumentSettings } from './types';
import type { ReceiptAuthority } from './receiptAuthority';

export const MERGED_RECEIPT_FIELDS = [
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
] as const;

export type ReceiptSettingsResult =
  | { ok: true; settings: BranchDocumentSettings }
  | { ok: false; reason: 'missing_branch' | 'missing_settings' | 'read_failure' };

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function mergeAuthoritativeSettings(
  branch: Record<string, unknown>,
  settings: Record<string, unknown>,
  authority: ReceiptAuthority,
  isHistoricalReprint: boolean,
): BranchDocumentSettings {
  const companyName = asString(settings.companyName) ?? '';
  const showLogo = asBool(settings.showLogoOnReceipt);
  const forceStaffSigOff = authority === 'AUTHORITATIVE' && isHistoricalReprint;
  return {
    companyName,
    branchName: asString(branch.name) ?? '',
    branchAddress: asString(branch.address) ?? '',
    branchPhone: asString(branch.phone) ?? '',
    branchEmail: asString(branch.email) ?? '',
    taxId: asString(branch.taxId) ?? '',
    logoUrl: asString(settings.receiptLogoUrl) ?? asString(branch.logoUrl),
    receiptHeader: asString(settings.receiptHeader) ?? '',
    receiptFooter: asString(settings.receiptFooter) ?? '',
    vatRegistered: asBool(settings.vatRegistered) ?? false,
    vatRate: asNum(settings.vatRate) ?? 0,
    priceIncludesVat: asBool(settings.priceIncludesVat) ?? true,
    showBarcodeOnReceipt: asBool(settings.showBarcodeOnReceipt) ?? false,
    showQrOnReceipt: asBool(settings.showQrOnReceipt) ?? false,
    showLogoOnReceipt: showLogo === true,
    showStaffOnReceipt: forceStaffSigOff ? false : (asBool(settings.showStaffOnReceipt) ?? false),
    showSignatureOnReceipt: forceStaffSigOff ? false : (asBool(settings.showSignatureOnReceipt) ?? false),
    showVatOnThermal: asBool(settings.showVatOnThermal) ?? (asBool(settings.vatRegistered) ?? false),
  };
}

export async function loadReceiptSettingsForOrderBranch(
  orderBranchId: string,
  authority: ReceiptAuthority,
  isHistoricalReprint: boolean,
): Promise<ReceiptSettingsResult> {
  if (!isFirebaseConfigured || !db) {
    return { ok: false, reason: 'read_failure' };
  }
  try {
    const [branchSnap, settingsSnap] = await Promise.all([
      getDocFromServer(doc(db, 'branches', orderBranchId)),
      getDocFromServer(doc(db, 'settings', orderBranchId)),
    ]);
    if (!branchSnap.exists()) return { ok: false, reason: 'missing_branch' };
    if (!settingsSnap.exists()) return { ok: false, reason: 'missing_settings' };
    return {
      ok: true,
      settings: mergeAuthoritativeSettings(
        branchSnap.data() as Branch as unknown as Record<string, unknown>,
        settingsSnap.data() as Settings as unknown as Record<string, unknown>,
        authority,
        isHistoricalReprint,
      ),
    };
  } catch {
    return { ok: false, reason: 'read_failure' };
  }
}
