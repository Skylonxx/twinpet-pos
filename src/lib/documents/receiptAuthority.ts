export type ReceiptAuthority = 'AUTHORITATIVE' | 'PROVISIONAL' | 'UNPROVEN' | 'REFUSED';
export type CopyStatus = 'ORIGINAL' | 'COPY';

export type ReceiptAuthorityReason =
  | 'all_conjuncts'
  | 'envelope_incomplete'
  | 'revision_malformed'
  | 'projection_unproven'
  | 'numeric_unproven'
  | 'payment_inconsistent'
  | 'order_voided'
  | 'void_intent_unreconciled'
  | 'void_anomaly'
  | 'settings_unresolved'
  | 'callable_failed'
  | 'offline_unqualified'
  | 'empty_payments';

export type AuthorityConjunct =
  | 'envelope'
  | 'historyRev'
  | 'projectionCompleteness'
  | 'numericDomain'
  | 'paymentConsistency'
  | 'notVoided'
  | 'branchSettings';

export type ReceiptAuthorityDecision = {
  authority: ReceiptAuthority;
  copyStatus: CopyStatus;
  reason: ReceiptAuthorityReason;
  failedConjunct?: AuthorityConjunct;
};

/**
 * An AUTHORITATIVE receipt means the sale data is the proven, coherent, current
 * server record. It does not mean branch/receipt presentation settings reflect
 * sale-time values, and it makes no statement about sale-time VAT.
 */
export const AUTHORITATIVE_RECEIPT_STATEMENT =
  'An AUTHORITATIVE receipt means the sale data is the proven, coherent, current server record. It does not mean branch/receipt presentation settings reflect sale-time values, and it makes no statement about sale-time VAT.';

export function decideReceiptAuthority(input: {
  envelopeOk: boolean;
  historyRevOk: boolean;
  projectionProven: boolean;
  numericOk: boolean;
  paymentOk: boolean;
  notVoided: boolean;
  noUnreconciledVoid: boolean;
  noVoidAnomaly: boolean;
  settingsResolved: boolean;
  copyStatus?: CopyStatus;
  gd2OfflineOption?: 'A' | 'B';
  online?: boolean;
}): ReceiptAuthorityDecision {
  const copyStatus = input.copyStatus ?? 'ORIGINAL';
  if (!input.notVoided) {
    return { authority: 'REFUSED', copyStatus, reason: 'order_voided', failedConjunct: 'notVoided' };
  }
  if (!input.noUnreconciledVoid) {
    return { authority: 'REFUSED', copyStatus, reason: 'void_intent_unreconciled', failedConjunct: 'notVoided' };
  }
  if (!input.noVoidAnomaly) {
    return { authority: 'REFUSED', copyStatus, reason: 'void_anomaly', failedConjunct: 'notVoided' };
  }
  if (!input.settingsResolved) {
    return { authority: 'REFUSED', copyStatus, reason: 'settings_unresolved', failedConjunct: 'branchSettings' };
  }
  if (!input.envelopeOk) {
    return { authority: 'UNPROVEN', copyStatus, reason: 'envelope_incomplete', failedConjunct: 'envelope' };
  }
  if (!input.historyRevOk) {
    return { authority: 'UNPROVEN', copyStatus, reason: 'revision_malformed', failedConjunct: 'historyRev' };
  }
  if (!input.projectionProven) {
    return { authority: 'UNPROVEN', copyStatus, reason: 'projection_unproven', failedConjunct: 'projectionCompleteness' };
  }
  if (!input.numericOk) {
    return { authority: 'UNPROVEN', copyStatus, reason: 'numeric_unproven', failedConjunct: 'numericDomain' };
  }
  if (!input.paymentOk) {
    return { authority: 'UNPROVEN', copyStatus, reason: 'payment_inconsistent', failedConjunct: 'paymentConsistency' };
  }
  return { authority: 'AUTHORITATIVE', copyStatus, reason: 'all_conjuncts' };
}

export function gd2ImmediateSlip(option: 'A' | 'B'): ReceiptAuthorityDecision {
  if (option === 'A') {
    return { authority: 'PROVISIONAL', copyStatus: 'ORIGINAL', reason: 'offline_unqualified' };
  }
  return { authority: 'REFUSED', copyStatus: 'ORIGINAL', reason: 'offline_unqualified' };
}
