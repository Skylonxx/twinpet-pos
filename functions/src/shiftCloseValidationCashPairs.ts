// Packet 5 / P5-B pure core — cash-pair classification (P5-A R4-D6, R5
// preserved unchanged). Pure, deterministic: compares the immutable
// cash-entry snapshot side against the observed `cashTransactions` audit
// side, by id, using canonical satang-amount comparison. No Firestore reads
// occur here — both sides are supplied by the caller.

import { toPositiveEntryMinor } from './shiftCloseValidationCore';
import type { CashEntryType, CashPairClassificationEntry, CashPairMismatchField } from './shiftCloseValidationTypes';

export interface CashPairEntrySide {
  id: string;
  type: CashEntryType;
  amount: number; // raw Baht number, verbatim from the immutable cashEntriesSnapshot
}

export interface CashPairAuditSide {
  id: string;
  type: unknown; // observed cashTransactions doc — may be malformed
  amount: unknown; // observed cashTransactions doc — may be malformed
}

/**
 * Classifies one same-id pair. Only called for entries that already passed
 * Class-A validation on the snapshot side (`foldBlockingCount == 0` upstream,
 * P5-A R1 §7.5) — the snapshot side here is always well-formed by
 * construction. The audit side is untrusted and independently validated.
 */
export function classifyCashPairEntry(
  entrySide: CashPairEntrySide | undefined,
  auditSide: CashPairAuditSide | undefined,
): CashPairClassificationEntry {
  if (entrySide && !auditSide) {
    return { id: entrySide.id, class: 'missing_cashTransaction' };
  }
  if (!entrySide && auditSide) {
    return { id: auditSide.id, class: 'missing_cashEntry' };
  }
  if (!entrySide || !auditSide) {
    throw new Error('classifyCashPairEntry requires at least one side to be present');
  }

  const id = entrySide.id;
  const mismatchFields: CashPairMismatchField[] = [];

  const typeMatches = auditSide.type === entrySide.type;
  if (!typeMatches) mismatchFields.push('type');

  const auditAmountValid = typeof auditSide.amount === 'number' && toPositiveEntryMinor(auditSide.amount).ok;
  let amountMatches = false;
  if (auditAmountValid) {
    const entryConverted = toPositiveEntryMinor(entrySide.amount);
    const auditConverted = toPositiveEntryMinor(auditSide.amount as number);
    amountMatches = entryConverted.ok && auditConverted.ok && entryConverted.minor === auditConverted.minor;
  }
  if (!amountMatches) mismatchFields.push('amount');

  if (mismatchFields.length === 0) {
    return { id, class: 'paired_equal' };
  }

  // Canonical mismatchFields order: 'type' before 'amount' when both differ
  // (P5-A R4 non-blocking determinism note) — already guaranteed by push order above.
  return { id, class: 'paired_value_mismatch', mismatchFields };
}

/**
 * Builds the full classification array for a shift: every snapshot entry id
 * paired against its audit-side counterpart (if any), plus any audit-side
 * doc with no snapshot counterpart (`missing_cashEntry`). Deterministic order:
 * by `id` ASC (UTF-8 byte order) — P5-A R4 non-blocking determinism note.
 */
export function classifyCashPairs(
  entrySides: readonly CashPairEntrySide[],
  auditSides: readonly CashPairAuditSide[],
): CashPairClassificationEntry[] {
  const auditById = new Map<string, CashPairAuditSide>();
  for (const audit of auditSides) auditById.set(audit.id, audit);

  const entryIds = new Set<string>();
  const results: CashPairClassificationEntry[] = [];

  for (const entry of entrySides) {
    entryIds.add(entry.id);
    results.push(classifyCashPairEntry(entry, auditById.get(entry.id)));
  }

  for (const audit of auditSides) {
    if (!entryIds.has(audit.id)) {
      results.push(classifyCashPairEntry(undefined, audit));
    }
  }

  return results.sort((a, b) => Buffer.compare(Buffer.from(a.id, 'utf8'), Buffer.from(b.id, 'utf8')));
}
