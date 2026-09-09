import { describe, expect, it } from 'vitest';
import appShellSource from '../../../components/AppShell.tsx?raw';
import posPageSource from '../../../pages/POSPage.tsx?raw';
import salePanelSource from '../../../components/pos/SaleIntentSyncPanel.tsx?raw';
import sweepBootSource from './saleIntentSweepBoot.ts?raw';
import reconcileBootSource from './deviceSeqReconcileBoot.ts?raw';
import manualSource from '../../../pages/ManualReviewOpsPage.tsx?raw';

const SRC_RAW = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const PK4_PRODUCTION = [
  '/src/lib/pos/offline/syncCenterModel.ts',
  '/src/lib/pos/offline/syncCenterReader.ts',
  '/src/lib/pos/offline/syncCenterAuthority.ts',
  '/src/lib/pos/offline/syncCenterActions.ts',
  '/src/hooks/pos/useSyncCenterState.ts',
  '/src/components/SyncStatusBar.tsx',
  '/src/pages/SyncCenterPage.tsx',
  '/src/lib/pos/offline/canonicalSyncContext.ts',
  '/src/components/AppShell.tsx',
  '/src/App.tsx',
  '/src/config/navigation.ts',
  '/src/lib/pos/offline/voidIntentStore.ts',
  '/src/lib/pos/offline/syncOrchestrator.ts',
] as const;

const TWELVE_GOVERNED_IDENTIFIERS = [
  'acquireSaleSubmissionResumeFence',
  'beginActiveCartGeneration',
  'initializeActiveCartSaleSubmission',
  'isAuthenticAcquiredResumeFenceAuthorization',
  'readActiveCartDurableDump',
  'readActiveCartSnapshot',
  'releaseSaleSubmissionResumeFence',
  'commitSaleSubmissionAbsenceSeal',
  'isAuthenticProvenEvidenceAbsence',
  'commitSaleSubmissionEvidenceEntry',
  'proveSaleSubmissionEvidencePresence',
  'isAuthenticProvenEvidencePresence',
] as const;

const FROZEN_BARE_SPECIFIERS = new Set([
  'bcryptjs',
  'chart.js',
  'firebase/app',
  'firebase/auth',
  'firebase/firestore',
  'firebase/functions',
  'firebase/storage',
  'flowbite-react',
  'react',
  'react-chartjs-2',
  'react-dom',
  'react-dom/client',
  'react-firebase-hooks/firestore',
  'react-router-dom',
]);

const NEW_PK4 = [
  '/src/lib/pos/offline/syncCenterModel.ts',
  '/src/lib/pos/offline/syncCenterReader.ts',
  '/src/lib/pos/offline/syncCenterAuthority.ts',
  '/src/lib/pos/offline/syncCenterActions.ts',
  '/src/hooks/pos/useSyncCenterState.ts',
  '/src/components/SyncStatusBar.tsx',
  '/src/pages/SyncCenterPage.tsx',
  '/src/lib/pos/offline/canonicalSyncContext.ts',
] as const;

function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

function isTestPath(path: string): boolean {
  return path.includes('.test.') || path.includes('.spec.');
}

function productionSources(): Array<{ file: string; text: string }> {
  return Object.entries(SRC_RAW)
    .map(([k, v]) => ({ file: posix(k), text: v as string }))
    .filter((e) => !isTestPath(e.file));
}

function pk4Text(file: string): string {
  const text = SRC_RAW[file] as string | undefined;
  if (typeof text !== 'string') throw new Error(`missing ${file}`);
  return text;
}

describe('syncCenterClosedGateConfinement', () => {
  it('N-F1 AppShell hook window and root className remain protected; SyncStatusBar is not between them', () => {
    const orch = appShellSource.indexOf('useSyncOrchestrator()');
    const sweep = appShellSource.indexOf('useSaleIntentSweepBoot()');
    const recon = appShellSource.indexOf('useDeviceSeqReconcileBoot()');
    expect(orch).toBeGreaterThan(-1);
    expect(orch).toBeLessThan(sweep);
    expect(sweep).toBeLessThan(recon);
    const between = appShellSource.slice(sweep, recon);
    expect(between.split('\n').length).toBeLessThanOrEqual(4);
    expect(between).not.toMatch(/<SyncStatusBar/);
    expect(appShellSource).not.toMatch(/\buseSyncCenterState\b/);
    expect(appShellSource).toMatch(
      /className="flex w-full h-screen overflow-hidden bg-\[var\(--g50\)\] font-sans"/,
    );
    expect(appShellSource).toMatch(/<SyncStatusBar\s*\/>/);
  });

  it('N-F2 POSPage and SaleIntentSyncPanel do not reference Sync Center', () => {
    expect(posPageSource).not.toMatch(/SyncCenter|SyncStatusBar/);
    expect(salePanelSource).not.toMatch(/SyncCenter|SyncStatusBar/);
  });

  it('N-F3 closed boot seams still contain their consumed-once gates', () => {
    expect(sweepBootSource).toContain('bootAttemptConsumed');
    expect(reconcileBootSource).toContain('useDeviceSeqReconcileBoot');
    expect(reconcileBootSource).toContain('maybeStartDeviceSeqReconcile');
  });

  it('N-F4 none of the twelve governed identifiers appear in PK-4 production files', () => {
    for (const file of PK4_PRODUCTION) {
      const text = pk4Text(file);
      for (const name of TWELVE_GOVERNED_IDENTIFIERS) {
        expect(text, `${file} ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it('N-F5 production indexedDB.open site count remains 8', () => {
    const opens: string[] = [];
    for (const entry of productionSources()) {
      const matches = entry.text.match(/indexedDB\.open\s*\(/g);
      if (matches) {
        for (let i = 0; i < matches.length; i += 1) opens.push(entry.file);
      }
    }
    expect(opens).toHaveLength(8);
  });

  it('N-F6 ManualReviewOpsPage keep-alive markers remain', () => {
    expect(manualSource).toContain("listQueue(store, ['manual_review_required'])");
    expect(manualSource).toContain('resolveManualReview(store');
    expect(manualSource).toContain('buildManualReviewResolvePayload');
    expect(manualSource).toContain('Phase 7B-H7-G');
  });

  it('N-F7 PK-4 sources do not import checkout/cart closed files', () => {
    for (const file of NEW_PK4) {
      const text = pk4Text(file);
      expect(text).not.toMatch(/PaymentModal/);
      expect(text).not.toMatch(/useCheckout/);
      expect(text).not.toMatch(/asyncCheckout/);
      expect(text).not.toMatch(/useCart/);
      expect(text).not.toMatch(/from\s+['"][^'"]*activeCartSnapshotStore['"]/);
      expect(text).not.toMatch(/from\s+['"][^'"]*saleSubmissionEvidenceStore['"]/);
      expect(text).not.toMatch(/from\s+['"][^'"]*saleSubmissionEvidenceTypes['"]/);
    }
  });

  it('N-F8 PK-4 new sources do not import firestore/functions and introduce no unknown bare specifiers', () => {
    const bare = /from\s+['"]([^./][^'"]*)['"]/g;
    for (const file of NEW_PK4) {
      const text = pk4Text(file);
      expect(text).not.toMatch(/from\s+['"]firebase\/firestore['"]/);
      expect(text).not.toMatch(/from\s+['"]firebase\/functions['"]/);
      expect(text).not.toMatch(/indexedDB\.open\s*\(/);
      let match: RegExpExecArray | null;
      const local = new RegExp(bare.source, 'g');
      while ((match = local.exec(text))) {
        const spec = match[1] ?? '';
        expect(FROZEN_BARE_SPECIFIERS.has(spec), `${file} bare ${spec}`).toBe(true);
      }
    }
  });

  it('T-LIFE-5 exactly one production mount call site; test-only seams stay out of production', () => {
    // SEC-001 Packet E / GD-E-005 — relocated from SyncCenterPage to AppShell.
    const callers = productionSources()
      .filter((e) => e.file !== '/src/lib/pos/offline/canonicalSyncContext.ts')
      .filter((e) => /\buseMountCanonicalSyncContext\s*\(/.test(e.text))
      .map((e) => e.file)
      .sort();
    expect(callers).toEqual(['/src/components/AppShell.tsx']);
    const hits = productionSources().filter(
      (e) =>
        e.file !== '/src/lib/pos/offline/canonicalSyncContext.ts' &&
        (/\b__setCanonicalSyncContextForTests\b/.test(e.text) ||
          /\b__resetCanonicalSyncContextForTests\b/.test(e.text)),
    );
    expect(hits.map((e) => e.file)).toEqual([]);
  });

  it('N-U2 PK-4 sources contain no false-success Thai copy', () => {
    for (const file of PK4_PRODUCTION) {
      const text = pk4Text(file);
      expect(text, file).not.toContain('ซิงก์แล้ว');
      expect(text, file).not.toContain('ซิงก์สำเร็จ');
      expect(text, file).not.toContain('ส่งข้อมูลเรียบร้อย');
    }
  });
});

// ─── SEC-001 Packet E / E-2 — additional confinement over the exact 12-path
// privileged Sync Center presentation. ─────────────────────────────────────

const E2_PRODUCTION_FILES = [
  '/src/lib/pos/offline/syncCenterPrivilegedProjection.ts',
  '/src/lib/pos/offline/syncCenterModel.ts',
  '/src/lib/pos/offline/syncCenterReader.ts',
  '/src/hooks/pos/useSyncCenterState.ts',
  '/src/pages/SyncCenterPage.tsx',
] as const;

const E2_FORBIDDEN_D3_D2_WRITE_IDENTIFIERS = [
  'requestOfflineAttestation',
  'ingestAttestedPrivilegedAction',
  'claimPrivilegedEvidenceRow',
  'applyPrivilegedEvidenceDisposition',
  'applyPrivilegedEvidenceDeferredCycleCounts',
  'clearPrivilegedEvidenceBackoff',
  'allocatePrivilegedSweepGeneration',
] as const;

const E2_FORBIDDEN_MANUAL_RESOLUTION_IDENTIFIERS = [
  'resolveManualReview',
  'resolvePrivileged',
  'retryPrivileged',
  'forcePrivileged',
  'approvePrivileged',
  'overridePrivileged',
  'discardPrivileged',
  'resubmitPrivileged',
] as const;

const E2_FORBIDDEN_RAW_EVIDENCE_FIELDS = [
  'paa1Base64',
  'ssa1Base64',
  'oacEnvelopeBytesBase64',
  'evidenceBindingDigest',
  'approvalProofDigest',
  'approvingManagerStaffId',
  'ingestDeviceId',
] as const;

const E2_FORBIDDEN_NATIVE_FUNCTIONS_TOKENS = ['firebase/functions', 'httpsCallable', '@tauri-apps', "invoke('", 'invoke("'] as const;

describe('syncCenterClosedGateConfinement — SEC-001 Packet E / E-2', () => {
  it('E2-CG-1 packet E-2 files add zero new production D-3 caller and zero D-2 write invocation', () => {
    for (const file of E2_PRODUCTION_FILES) {
      const text = pk4Text(file);
      for (const name of E2_FORBIDDEN_D3_D2_WRITE_IDENTIFIERS) {
        expect(text, `${file} ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it('E2-CG-2 packet E-2 files add zero privileged manual-resolution action', () => {
    for (const file of E2_PRODUCTION_FILES) {
      const text = pk4Text(file);
      for (const name of E2_FORBIDDEN_MANUAL_RESOLUTION_IDENTIFIERS) {
        expect(text, `${file} ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it('E2-CG-3 CHANNEL_ORDER / SYNC_CENTER_CHANNEL_ORDER remain unchanged; privileged evidence is not a channel', () => {
    const modelText = pk4Text('/src/lib/pos/offline/syncCenterModel.ts');
    expect(modelText).toContain(
      "export const SYNC_CENTER_CHANNEL_ORDER = [\n  'offline_reversal',\n  'void_intent',\n  'shift_intent',\n  'sale_intent',\n  'trusted_resume',\n] as const satisfies readonly SyncChannelId[];",
    );
    expect(modelText).not.toMatch(/'privileged_void'/);
    expect(modelText).not.toMatch(/'privileged'\s*,?\s*\n?\s*\] as const satisfies readonly SyncChannelId/);
  });

  it('E2-CG-4 privileged projection output is non-channel and the page never touches raw journal fields', () => {
    const projectionSource = pk4Text('/src/lib/pos/offline/syncCenterPrivilegedProjection.ts');
    expect(projectionSource).not.toMatch(/\bchannel\s*:/);
    const pageText = pk4Text('/src/pages/SyncCenterPage.tsx');
    for (const field of E2_FORBIDDEN_RAW_EVIDENCE_FIELDS) {
      expect(pageText, field).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(pageText).not.toMatch(/\bPrivilegedEvidenceJournalRecordV1\b/);
  });

  it('E2-CG-5 packet E-2 files reach no Functions/Rules/native privileged writer path', () => {
    for (const file of E2_PRODUCTION_FILES) {
      const text = pk4Text(file);
      for (const token of E2_FORBIDDEN_NATIVE_FUNCTIONS_TOKENS) {
        expect(text, `${file} ${token}`).not.toContain(token);
      }
      expect(text, file).not.toMatch(/from\s+['"]firebase\/firestore['"]/);
    }
  });

  it('E2-CG-6 negative control: the forbidden-identifier regex actually flags a planted violation', () => {
    const synthetic = "import { ingestAttestedPrivilegedAction } from './privilegedEvidenceStore';\nfunction resolvePrivileged() {}\n";
    for (const name of ['ingestAttestedPrivilegedAction', 'resolvePrivileged']) {
      expect(synthetic).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('E2-CG-7 the page defines a distinct privileged section component and never passes it a mutation callback', () => {
    const pageText = pk4Text('/src/pages/SyncCenterPage.tsx');
    expect(pageText).toMatch(/PrivilegedEvidenceSection/);
    expect(pageText).not.toMatch(/<PrivilegedEvidenceSection[^>]*onRetry/);
    expect(pageText).not.toMatch(/<PrivilegedEvidenceSection[^>]*onResolve/);
  });
});
