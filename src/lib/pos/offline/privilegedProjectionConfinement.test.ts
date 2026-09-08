/**
 * SEC-001 Packet D / D-3 — privileged-projection confinement.
 *
 * Static, non-vacuous importer / import-specifier gate over production
 * source (`import.meta.glob`, eager, test files excluded). Mirrors the
 * `applicationIntegrationConfinement.test.ts` pattern used for the D-3-1
 * (Application Integration) seam.
 *
 * GD-D3-001 OPTION A requires exactly one production owner of the
 * attest -> verify -> ingest sequence: the D-3 adapter,
 * `projectPrivilegedOfflineAction.ts`. GD-D3-004 forbids an orchestrator
 * nudge. Section 13 forbids any Packet E / UI / native reach from D-3.
 *
 * RC-D3-005 — the importer-uniqueness gate (PPC-1/PPC-2) is TypeScript-AST
 * based (`typescript` compiler API, already used elsewhere in the repo's
 * confinement tests), not regex, and covers the four concrete bypass forms
 * Codex identified: named import, namespace import, (named or star)
 * re-export, and dynamic `import()`. A namespace import, star re-export, or
 * dynamic import of the WHOLE definer module is flagged for every tracked
 * identifier that module defines — renaming the locally-bound name cannot
 * hide it. PPC-AST negative-control tests below prove the inventory
 * function actually detects each of the four forms, using small synthetic
 * source strings (not eager glob over real repo source).
 */
import { describe, expect, test } from 'vitest';
import * as ts from 'typescript';
import adapterSourceRaw from './projectPrivilegedOfflineAction.ts?raw';

const SRC_RAW = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const ADAPTER_FILE = '/src/lib/pos/offline/projectPrivilegedOfflineAction.ts';
const ATTESTATION_DEFINER_FILE = '/src/lib/auth/privilegedAction/offlineAttestation.ts';
const INGEST_DEFINER_FILE = '/src/lib/pos/offline/privilegedEvidenceStore.ts';

const ATTESTATION_IDENTIFIER = 'requestOfflineAttestation';
const INGEST_IDENTIFIER = 'ingestAttestedPrivilegedAction';
const ORCHESTRATOR_NUDGE_IDENTIFIER = 'requestSyncOrchestratorCycle';

const FORBIDDEN_ADAPTER_IMPORT_SPECIFIERS = [
  'firebase/firestore',
  'offlineAdjudicationTransport',
  'syncOrchestrator',
  'voidPendingOrder',
] as const;

/** Named export forbidden even though it shares a module file the adapter legitimately imports from. */
const FORBIDDEN_ADAPTER_IDENTIFIERS = ['applyPrivilegedEvidenceDisposition'] as const;

const FORBIDDEN_ADAPTER_IMPORT_PATH_FRAGMENTS = [
  '/pages/',
  '/components/',
  '/hooks/',
  '../../platform/durableStore/',
  '../../../platform/durableStore/',
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

// ─── RC-D3-005 — TypeScript-AST importer inventory ─────────────────────────

type ImportForm = 'named-import' | 'namespace-import' | 'named-re-export' | 'star-re-export' | 'dynamic-import';

type ImportHit = { file: string; definerFile: string; identifier: string; form: ImportForm };

function parseSource(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function literalString(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function namedSpecifierSourceSymbol(el: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return el.propertyName?.text ?? el.name.text;
}

function posixDirname(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i <= 0 ? '/' : filePath.slice(0, i);
}

function posixResolve(fromFile: string, specifier: string): string {
  const fromDir = posixDirname(fromFile);
  const parts: string[] = [];
  for (const seg of [...fromDir.split('/'), ...specifier.split('/')]) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/** Resolves a relative/absolute specifier against the known `/src/...` file inventory. A bare (package) specifier never resolves — it can never be one of our definer files. */
function resolveSpecifier(fromFile: string, specifier: string, inventory: Set<string>): string | undefined {
  const spec = specifier.split('?')[0]!;
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
  const absolute = spec.startsWith('/') ? spec : posixResolve(fromFile, spec);
  const candidates = [absolute, `${absolute}.ts`, `${absolute}.tsx`, `${absolute}/index.ts`, `${absolute}/index.tsx`];
  return candidates.find((c) => inventory.has(c));
}

/**
 * Inventories every route by which `file` could obtain a tracked identifier
 * from one of `definerIdentifiers`' keys (definer file -> tracked identifier
 * names), covering exactly the four RC-D3-005 bypass forms.
 */
function collectImportHits(
  file: string,
  text: string,
  inventory: Set<string>,
  definerIdentifiers: Map<string, string[]>,
): ImportHit[] {
  const hits: ImportHit[] = [];
  const sf = parseSource(file, text);

  const flagAll = (definerFile: string, form: ImportForm): void => {
    for (const identifier of definerIdentifiers.get(definerFile) ?? []) {
      hits.push({ file, definerFile, identifier, form });
    }
  };
  const flagOne = (definerFile: string, identifier: string, form: ImportForm): void => {
    if ((definerIdentifiers.get(definerFile) ?? []).includes(identifier)) {
      hits.push({ file, definerFile, identifier, form });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalString(node.moduleSpecifier);
      if (specifier !== undefined) {
        const resolved = resolveSpecifier(file, specifier, inventory);
        if (resolved && definerIdentifiers.has(resolved)) {
          const named = node.importClause?.namedBindings;
          if (named && ts.isNamespaceImport(named)) {
            flagAll(resolved, 'namespace-import');
          } else if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
              flagOne(resolved, namedSpecifierSourceSymbol(el), 'named-import');
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalString(node.moduleSpecifier);
      if (specifier !== undefined) {
        const resolved = resolveSpecifier(file, specifier, inventory);
        if (resolved && definerIdentifiers.has(resolved)) {
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              flagOne(resolved, namedSpecifierSourceSymbol(el), 'named-re-export');
            }
          } else {
            // `export * from '...'` (no exportClause) or `export * as ns from '...'`.
            flagAll(resolved, 'star-re-export');
          }
        }
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalString(node.arguments[0]);
      if (specifier !== undefined) {
        const resolved = resolveSpecifier(file, specifier, inventory);
        if (resolved && definerIdentifiers.has(resolved)) {
          flagAll(resolved, 'dynamic-import');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const DEFINER_IDENTIFIERS = new Map<string, string[]>([
  [ATTESTATION_DEFINER_FILE, [ATTESTATION_IDENTIFIER]],
  [INGEST_DEFINER_FILE, [INGEST_IDENTIFIER]],
]);

function allSourceFiles(): Set<string> {
  return new Set(Object.keys(SRC_RAW).map(posix));
}

function importersOf(identifier: string): string[] {
  const inventory = allSourceFiles();
  const hits: ImportHit[] = [];
  for (const { file, text } of productionSources()) {
    if (file === ATTESTATION_DEFINER_FILE || file === INGEST_DEFINER_FILE) continue;
    hits.push(...collectImportHits(file, text, inventory, DEFINER_IDENTIFIERS));
  }
  return [...new Set(hits.filter((h) => h.identifier === identifier).map((h) => h.file))].sort();
}

describe('PPC — D-3 privileged-projection confinement', () => {
  test('PPC-1 the only production importer of requestOfflineAttestation is the D-3 adapter (AST: named/namespace import + re-export + dynamic import)', () => {
    expect(importersOf(ATTESTATION_IDENTIFIER)).toEqual([ADAPTER_FILE]);
  });

  test('PPC-2 the only production importer of ingestAttestedPrivilegedAction is the D-3 adapter (AST: named/namespace import + re-export + dynamic import)', () => {
    expect(importersOf(INGEST_IDENTIFIER)).toEqual([ADAPTER_FILE]);
  });

  test('PPC-3 the adapter source is non-vacuous: it actually names both seam identifiers', () => {
    expect(typeof adapterSourceRaw).toBe('string');
    expect(adapterSourceRaw).toMatch(new RegExp(`\\b${ATTESTATION_IDENTIFIER}\\b`));
    expect(adapterSourceRaw).toMatch(new RegExp(`\\b${INGEST_IDENTIFIER}\\b`));
  });

  test('PPC-4 the adapter imports none of the forbidden modules or identifiers', () => {
    for (const specifier of FORBIDDEN_ADAPTER_IMPORT_SPECIFIERS) {
      expect(adapterSourceRaw, specifier).not.toMatch(new RegExp(`from\\s+['"][^'"]*${specifier}['"]`));
    }
    for (const fragment of FORBIDDEN_ADAPTER_IMPORT_PATH_FRAGMENTS) {
      expect(adapterSourceRaw, fragment).not.toContain(fragment);
    }
    for (const identifier of FORBIDDEN_ADAPTER_IDENTIFIERS) {
      expect(adapterSourceRaw, identifier).not.toMatch(new RegExp(`\\b${identifier}\\b`));
    }
  });

  test('PPC-5 no orchestrator nudge: the adapter never imports or calls requestSyncOrchestratorCycle', () => {
    expect(adapterSourceRaw).not.toMatch(new RegExp(`\\b${ORCHESTRATOR_NUDGE_IDENTIFIER}\\b`));
  });

  test('PPC-6 no UI dependency: the adapter imports nothing from pages/components/hooks', () => {
    expect(adapterSourceRaw).not.toMatch(/from\s+['"][^'"]*\/(pages|components|hooks)\//);
    expect(adapterSourceRaw).not.toContain("from 'react'");
    expect(adapterSourceRaw).not.toContain('from "react"');
  });

  test('PPC-7 the adapter reaches durable storage only through the ReversalLocalStore abstraction', () => {
    expect(adapterSourceRaw).toMatch(/from\s+['"]\.\/reversalLocalStore['"]/);
    expect(adapterSourceRaw).not.toContain('indexedDB.open');
  });

  test('PPC facade identifiers are present so the importer gates are non-vacuous', () => {
    expect(ATTESTATION_IDENTIFIER).toBe('requestOfflineAttestation');
    expect(INGEST_IDENTIFIER).toBe('ingestAttestedPrivilegedAction');
    const emptyIfAdapterDeleted = productionSources()
      .filter((entry) => entry.file !== ADAPTER_FILE)
      .filter((entry) => entry.file !== ATTESTATION_DEFINER_FILE && entry.file !== INGEST_DEFINER_FILE)
      .filter(
        (entry) =>
          collectImportHits(entry.file, entry.text, allSourceFiles(), DEFINER_IDENTIFIERS).length > 0,
      );
    expect(emptyIfAdapterDeleted).toEqual([]);
  });

  test('RC-D3-001 confinement: the public adapter has no runtime dependency override surface', () => {
    expect(adapterSourceRaw).not.toMatch(/export\s+(interface|type)\s+\w*Deps\b/);
    expect(adapterSourceRaw).not.toMatch(/\bdeps\s*[:?]/);
    expect(adapterSourceRaw).toMatch(
      /export async function projectPrivilegedOfflineAction\(\s*input: ProjectPrivilegedOfflineActionInput,?\s*\): Promise</,
    );
  });
});

describe('PPC-AST negative controls — the inventory function actually detects each bypass form', () => {
  const PROBE_FILE = '/src/lib/pos/offline/__ppcProbe.ts';
  const inventory = new Set([ATTESTATION_DEFINER_FILE, INGEST_DEFINER_FILE, PROBE_FILE]);

  test('detects a named import of the tracked identifier', () => {
    const src = `import { ${INGEST_IDENTIFIER} } from './privilegedEvidenceStore';\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, DEFINER_IDENTIFIERS);
    expect(hits).toContainEqual({
      file: PROBE_FILE,
      definerFile: INGEST_DEFINER_FILE,
      identifier: INGEST_IDENTIFIER,
      form: 'named-import',
    });
  });

  test('detects a namespace import that grants access to the tracked identifier', () => {
    const src = `import * as PrivilegedEvidenceStore from './privilegedEvidenceStore';\nvoid PrivilegedEvidenceStore;\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, DEFINER_IDENTIFIERS);
    expect(hits).toContainEqual({
      file: PROBE_FILE,
      definerFile: INGEST_DEFINER_FILE,
      identifier: INGEST_IDENTIFIER,
      form: 'namespace-import',
    });
  });

  test('detects a named re-export of the tracked identifier', () => {
    const src = `export { ${ATTESTATION_IDENTIFIER} } from '../../auth/privilegedAction/offlineAttestation';\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, DEFINER_IDENTIFIERS);
    expect(hits).toContainEqual({
      file: PROBE_FILE,
      definerFile: ATTESTATION_DEFINER_FILE,
      identifier: ATTESTATION_IDENTIFIER,
      form: 'named-re-export',
    });
  });

  test('detects a star re-export that grants access to the tracked identifier', () => {
    const src = `export * from '../../auth/privilegedAction/offlineAttestation';\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, DEFINER_IDENTIFIERS);
    expect(hits).toContainEqual({
      file: PROBE_FILE,
      definerFile: ATTESTATION_DEFINER_FILE,
      identifier: ATTESTATION_IDENTIFIER,
      form: 'star-re-export',
    });
  });

  test('detects a dynamic import() that grants access to the tracked identifier', () => {
    const src = `async function bypass() {\n  const mod = await import('./privilegedEvidenceStore');\n  return mod.${INGEST_IDENTIFIER};\n}\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, DEFINER_IDENTIFIERS);
    expect(hits).toContainEqual({
      file: PROBE_FILE,
      definerFile: INGEST_DEFINER_FILE,
      identifier: INGEST_IDENTIFIER,
      form: 'dynamic-import',
    });
  });

  test('a named import of an UNTRACKED identifier from the same definer file is not flagged', () => {
    const src = `import { listPrivilegedEvidence } from './privilegedEvidenceStore';\nvoid listPrivilegedEvidence;\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, DEFINER_IDENTIFIERS);
    expect(hits).toEqual([]);
  });

  test('an import from an unrelated module is not flagged', () => {
    const src = `import { requestOfflineAttestation } from './someOtherModule';\nvoid requestOfflineAttestation;\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, DEFINER_IDENTIFIERS);
    expect(hits).toEqual([]);
  });
});
