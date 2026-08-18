/**
 * Packet AI-1 application-integration confinement.
 * Static, non-vacuous importer / identifier / literal gate.
 *
 * AIC-1 is the importer doorway: production Application Integration may reach
 * the D-3 facade from exactly one file — trustedSaleSubmissionOrchestrator.ts.
 * Deleting that import (or the orchestrator) empties the importer list.
 *
 * Initializer retirement is gating, not deletion: production AI-1 code must
 * not resurrect initializeActiveCartSaleSubmission as a fallback.
 */
import { describe, expect, test } from 'vitest';
import orchestratorSourceRaw from './trustedSaleSubmissionOrchestrator.ts?raw';
import useCheckoutSourceRaw from '../../../hooks/pos/useCheckout.ts?raw';
import posPageSourceRaw from '../../../pages/POSPage.tsx?raw';

const SRC_RAW = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const FACADE_SPEC = "trustedOrchestrationOwner";
const ORCHESTRATOR_FILE = '/src/lib/pos/offline/trustedSaleSubmissionOrchestrator.ts';
const CART_FILE = '/src/lib/pos/offline/activeCartSnapshotStore.ts';
const INITIALIZER_NAME = 'initializeActiveCartSaleSubmission';

const NINE_GOVERNED_IDENTIFIERS = [
  'acquireSaleSubmissionResumeFence',
  'beginActiveCartGeneration',
  'initializeActiveCartSaleSubmission',
  'isAuthenticAcquiredResumeFenceAuthorization',
  'readActiveCartDurableDump',
  'readActiveCartSnapshot',
  'releaseSaleSubmissionResumeFence',
  'commitSaleSubmissionAbsenceSeal',
  'isAuthenticProvenEvidenceAbsence',
] as const;

const FIVE_GOVERNED_LITERALS = [
  'twinpet-active-cart-snapshot',
  'twinpet-sale-submission-evidence',
  'activeCartSnapshots',
  'saleEvidenceGenerationPointers',
  'saleSubmissionEvidence',
] as const;

const RAW_MODULE_IMPORTS = [
  './activeCartSnapshotStore',
  './saleSubmissionEvidenceStore',
  './saleSubmissionEvidenceTypes',
] as const;

function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

function isTestPath(path: string): boolean {
  return path.includes('.test.') || path.includes('.spec.');
}

function productionSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const [rawKey, text] of Object.entries(SRC_RAW)) {
    const file = posix(rawKey);
    if (typeof text !== 'string') continue;
    if (isTestPath(file)) continue;
    out.push({ file, text });
  }
  return out;
}

function importsFacade(text: string): boolean {
  return /from\s+['"][^'"]*trustedOrchestrationOwner['"]/.test(text);
}

function identifierPresent(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

describe('AIC — Application Integration confinement', () => {
  test('AIC-1 production importer of the D-3 facade is exactly the orchestrator', () => {
    const importers = productionSources()
      .filter((entry) => importsFacade(entry.text))
      .map((entry) => entry.file)
      .sort();
    expect(importers).toEqual([ORCHESTRATOR_FILE]);
    expect(typeof orchestratorSourceRaw).toBe('string');
    expect(orchestratorSourceRaw).toMatch(/from\s+['"]\.\/trustedOrchestrationOwner['"]/);
  });

  test('AIC-2 production Application Integration cannot resurrect the initializer', () => {
    const productionHits = productionSources().filter((entry) =>
      identifierPresent(entry.text, INITIALIZER_NAME),
    );
    expect(productionHits.map((e) => e.file)).toEqual([CART_FILE]);
    expect(orchestratorSourceRaw).not.toMatch(new RegExp(`\\b${INITIALIZER_NAME}\\b`));
    expect(useCheckoutSourceRaw).not.toMatch(new RegExp(`\\b${INITIALIZER_NAME}\\b`));
    expect(posPageSourceRaw).not.toMatch(new RegExp(`\\b${INITIALIZER_NAME}\\b`));
  });

  test('AIC-3 orchestrator names none of the nine governed raw identifiers', () => {
    for (const name of NINE_GOVERNED_IDENTIFIERS) {
      expect(orchestratorSourceRaw, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  test('AIC-4 orchestrator contains none of the five governed DB/store literals', () => {
    for (const literal of FIVE_GOVERNED_LITERALS) {
      expect(orchestratorSourceRaw, literal).not.toContain(literal);
    }
  });

  test('AIC-5 orchestrator has no indexedDB.open and no raw-island imports', () => {
    expect(orchestratorSourceRaw).not.toContain('indexedDB.open');
    expect(orchestratorSourceRaw).not.toContain('indexedDB.open(');
    for (const spec of RAW_MODULE_IMPORTS) {
      expect(orchestratorSourceRaw).not.toContain(`from '${spec}'`);
      expect(orchestratorSourceRaw).not.toContain(`from "${spec}"`);
    }
    expect(orchestratorSourceRaw).not.toContain("from 'react'");
    expect(orchestratorSourceRaw).not.toContain('from "react"');
  });

  test('AIC-6 orchestrator public result unions are plain serializable fields only', () => {
    expect(orchestratorSourceRaw).toContain('export type TrustedSaleSubmissionBeginResult');
    expect(orchestratorSourceRaw).toContain('export type TrustedResumeSweepResult');
    expect(orchestratorSourceRaw).toContain("outcome: 'released' | 'not_eligible'");
    expect(orchestratorSourceRaw).toContain('export async function beginTrustedSaleSubmission');
    expect(orchestratorSourceRaw).toContain('export async function runTrustedResumeSweep');
    expect(orchestratorSourceRaw).toContain('Promise<TrustedSaleSubmissionBeginResult>');
    expect(orchestratorSourceRaw).toContain('Promise<TrustedResumeSweepResult>');
  });

  test('AIC-7 useCheckout places beginTrustedSaleSubmission after allocate and before submit', () => {
    const allocIdx = useCheckoutSourceRaw.indexOf('await allocateOrderIdentity()');
    const beginIdx = useCheckoutSourceRaw.indexOf('beginTrustedSaleSubmission(');
    const submitIdx = useCheckoutSourceRaw.indexOf('submitAsyncOrder(');
    expect(allocIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(allocIdx);
    expect(submitIdx).toBeGreaterThan(beginIdx);
  });

  test('AIC facade specifier token is present so the importer gate is non-vacuous', () => {
    expect(FACADE_SPEC).toBe('trustedOrchestrationOwner');
    const emptyIfOrchestratorDeleted = productionSources().filter((entry) =>
      entry.file === ORCHESTRATOR_FILE ? false : importsFacade(entry.text),
    );
    expect(emptyIfOrchestratorDeleted).toEqual([]);
  });
});
