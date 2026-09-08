/**
 * SEC-001 Packet E / E-1 — privileged-void production confinement (PVC).
 *
 * Static, non-vacuous importer / import-specifier gate over production
 * source (`import.meta.glob`, eager, test files excluded). Mirrors the
 * TypeScript-AST `privilegedProjectionConfinement.test.ts` (D-3) pattern —
 * same `typescript` compiler API walker, covering the same four concrete
 * bypass forms: named import, namespace import, (named or star) re-export,
 * and dynamic `import()`. Does NOT modify the landed D-3 confinement test.
 *
 * GD-E-001/GD-E-003/GD-E-008 require:
 *   - PVC-1: `src/hooks/pos/usePrivilegedVoidFlow.ts` is the SOLE production
 *     caller of `projectPrivilegedOfflineAction`;
 *   - PVC-2: the old unfenced `enqueueVoidIntent` has zero production
 *     importers;
 *   - PVC-3: no Packet E flow source imports/calls `requestPendingVoid`,
 *     `voidOrderSafe`, or `enqueueVoidIntentWithPrivilegedFence` — no
 *     production fallback to any legacy void path;
 *   - PVC-4: no production `src/` client caller/reference to
 *     `submitPrivilegedVoid` (client-side, it does not exist at all — this
 *     guards against one ever being added outside Functions).
 */
import { describe, expect, test } from 'vitest';
import * as ts from 'typescript';

const SRC_RAW = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const HOOK_FILE = '/src/hooks/pos/usePrivilegedVoidFlow.ts';
const D3_ADAPTER_FILE = '/src/lib/pos/offline/projectPrivilegedOfflineAction.ts';
const VOID_INTENT_STORE_FILE = '/src/lib/pos/offline/voidIntentStore.ts';
const VOID_PENDING_ORDER_FILE = '/src/lib/pos/voidPendingOrder.ts';
const VOID_ORDER_FILE = '/src/lib/voidOrder.ts';

const D3_IDENTIFIER = 'projectPrivilegedOfflineAction';
const UNFENCED_ENQUEUE_IDENTIFIER = 'enqueueVoidIntent';
const FENCED_ENQUEUE_IDENTIFIER = 'enqueueVoidIntentWithPrivilegedFence';
const REQUEST_PENDING_VOID_IDENTIFIER = 'requestPendingVoid';
const VOID_ORDER_SAFE_IDENTIFIER = 'voidOrderSafe';

/** The new/modified Packet E production flow sources (E-1 allowlist, tests excluded). */
const PACKET_E_FLOW_FILES = [
  '/src/lib/pos/privilegedVoid/privilegedVoidFlowMachine.ts',
  '/src/lib/pos/privilegedVoid/privilegedVoidActiveRow.ts',
  '/src/lib/pos/privilegedVoid/privilegedVoidCopy.ts',
  HOOK_FILE,
  '/src/components/pos/PrivilegedVoidModal.tsx',
  '/src/pages/SalesHistoryPage.tsx',
  '/src/components/AppShell.tsx',
  '/src/pages/SyncCenterPage.tsx',
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

// ─── TypeScript-AST importer inventory (mirrors privilegedProjectionConfinement.test.ts) ──

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

function resolveSpecifier(fromFile: string, specifier: string, inventory: Set<string>): string | undefined {
  const spec = specifier.split('?')[0]!;
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
  const absolute = spec.startsWith('/') ? spec : posixResolve(fromFile, spec);
  const candidates = [absolute, `${absolute}.ts`, `${absolute}.tsx`, `${absolute}/index.ts`, `${absolute}/index.tsx`];
  return candidates.find((c) => inventory.has(c));
}

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

function allSourceFiles(): Set<string> {
  return new Set(Object.keys(SRC_RAW).map(posix));
}

function importersOf(
  identifier: string,
  definerIdentifiers: Map<string, string[]>,
  excludeDefinerFiles: readonly string[],
  scope?: readonly string[],
): string[] {
  const inventory = allSourceFiles();
  const hits: ImportHit[] = [];
  const candidateFiles = scope
    ? productionSources().filter((e) => scope.includes(e.file))
    : productionSources();
  for (const { file, text } of candidateFiles) {
    if (excludeDefinerFiles.includes(file)) continue;
    hits.push(...collectImportHits(file, text, inventory, definerIdentifiers));
  }
  return [...new Set(hits.filter((h) => h.identifier === identifier).map((h) => h.file))].sort();
}

describe('PVC — Packet E / E-1 privileged-void confinement', () => {
  test('PVC-1 the only production importer of projectPrivilegedOfflineAction is the E-1 hook (AST: named/namespace import + re-export + dynamic import)', () => {
    const definer = new Map([[D3_ADAPTER_FILE, [D3_IDENTIFIER]]]);
    expect(importersOf(D3_IDENTIFIER, definer, [D3_ADAPTER_FILE])).toEqual([HOOK_FILE]);
  });

  test('PVC-1b the hook source is non-vacuous: it actually names the D-3 identifier', () => {
    const text = productionSources().find((e) => e.file === HOOK_FILE)?.text;
    expect(typeof text).toBe('string');
    expect(text).toMatch(new RegExp(`\\b${D3_IDENTIFIER}\\b`));
  });

  test('PVC-2 the old unfenced enqueueVoidIntent has zero production importers repo-wide (AST)', () => {
    const definer = new Map([[VOID_INTENT_STORE_FILE, [UNFENCED_ENQUEUE_IDENTIFIER]]]);
    expect(importersOf(UNFENCED_ENQUEUE_IDENTIFIER, definer, [VOID_INTENT_STORE_FILE])).toEqual([]);
  });

  test('PVC-2b the unfenced identifier is genuinely distinct from the fenced one (non-vacuous control)', () => {
    expect(UNFENCED_ENQUEUE_IDENTIFIER).not.toBe(FENCED_ENQUEUE_IDENTIFIER);
    const text = productionSources().find((e) => e.file === VOID_INTENT_STORE_FILE)?.text ?? '';
    expect(text).toMatch(new RegExp(`\\bexport async function ${UNFENCED_ENQUEUE_IDENTIFIER}\\b`));
  });

  test('PVC-3 no PURE Packet E flow source (excluding the dev/mock-preserving SalesHistoryPage host) imports/calls requestPendingVoid, voidOrderSafe, or enqueueVoidIntentWithPrivilegedFence (AST)', () => {
    const definer = new Map([
      [VOID_PENDING_ORDER_FILE, [REQUEST_PENDING_VOID_IDENTIFIER]],
      [VOID_ORDER_FILE, [VOID_ORDER_SAFE_IDENTIFIER]],
      [VOID_INTENT_STORE_FILE, [FENCED_ENQUEUE_IDENTIFIER]],
    ]);
    const pureFlowFiles = PACKET_E_FLOW_FILES.filter((f) => f !== '/src/pages/SalesHistoryPage.tsx');
    for (const identifier of [REQUEST_PENDING_VOID_IDENTIFIER, VOID_ORDER_SAFE_IDENTIFIER, FENCED_ENQUEUE_IDENTIFIER]) {
      expect(
        importersOf(identifier, definer, [VOID_PENDING_ORDER_FILE, VOID_ORDER_FILE, VOID_INTENT_STORE_FILE], pureFlowFiles),
        identifier,
      ).toEqual([]);
    }
  });

  test('PVC-3c SalesHistoryPage.tsx (the CTA host) never imports requestPendingVoid or enqueueVoidIntentWithPrivilegedFence — its ONLY legacy identifier is voidOrderSafe, and only for the dev/mock (non-Firebase) path proven by SalesHistoryPage.test.tsx', () => {
    const definer = new Map([
      [VOID_PENDING_ORDER_FILE, [REQUEST_PENDING_VOID_IDENTIFIER]],
      [VOID_INTENT_STORE_FILE, [FENCED_ENQUEUE_IDENTIFIER]],
    ]);
    for (const identifier of [REQUEST_PENDING_VOID_IDENTIFIER, FENCED_ENQUEUE_IDENTIFIER]) {
      expect(
        importersOf(identifier, definer, [VOID_PENDING_ORDER_FILE, VOID_INTENT_STORE_FILE], ['/src/pages/SalesHistoryPage.tsx']),
        identifier,
      ).toEqual([]);
    }
  });

  test('PVC-3b non-vacuous control: SalesHistoryPage legitimately still names voidOrderSafe (dev/mock path only) — proving the scan actually inspects that file\'s text', () => {
    const text = productionSources().find((e) => e.file === '/src/pages/SalesHistoryPage.tsx')?.text ?? '';
    expect(text).toMatch(new RegExp(`\\b${VOID_ORDER_SAFE_IDENTIFIER}\\b`));
  });

  test('PVC-4 no production src/ caller/reference to submitPrivilegedVoid (client-side; does not exist outside Functions)', () => {
    for (const { file, text } of productionSources()) {
      expect(text, file).not.toMatch(/\bsubmitPrivilegedVoid\b/);
      expect(text, file).not.toMatch(/httpsCallable\([^)]*['"]submitPrivilegedVoid['"]/);
    }
  });
});

describe('PVC-AST negative controls — the inventory function actually detects each bypass form', () => {
  const PROBE_FILE = '/src/lib/pos/offline/__pvcProbe.ts';
  const inventory = new Set([D3_ADAPTER_FILE, VOID_INTENT_STORE_FILE, PROBE_FILE]);
  const definer = new Map([
    [D3_ADAPTER_FILE, [D3_IDENTIFIER]],
    [VOID_INTENT_STORE_FILE, [UNFENCED_ENQUEUE_IDENTIFIER]],
  ]);

  test('detects a named import of the tracked identifier', () => {
    const src = `import { ${D3_IDENTIFIER} } from './projectPrivilegedOfflineAction';\nvoid ${D3_IDENTIFIER};\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, definer);
    expect(hits).toContainEqual({ file: PROBE_FILE, definerFile: D3_ADAPTER_FILE, identifier: D3_IDENTIFIER, form: 'named-import' });
  });

  test('detects a namespace import that grants access to the tracked identifier', () => {
    const src = `import * as D3 from './projectPrivilegedOfflineAction';\nvoid D3;\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, definer);
    expect(hits).toContainEqual({ file: PROBE_FILE, definerFile: D3_ADAPTER_FILE, identifier: D3_IDENTIFIER, form: 'namespace-import' });
  });

  test('detects a named re-export of the tracked identifier', () => {
    const src = `export { ${UNFENCED_ENQUEUE_IDENTIFIER} } from './voidIntentStore';\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, definer);
    expect(hits).toContainEqual({
      file: PROBE_FILE,
      definerFile: VOID_INTENT_STORE_FILE,
      identifier: UNFENCED_ENQUEUE_IDENTIFIER,
      form: 'named-re-export',
    });
  });

  test('detects a star re-export that grants access to the tracked identifier', () => {
    const src = `export * from './voidIntentStore';\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, definer);
    expect(hits).toContainEqual({
      file: PROBE_FILE,
      definerFile: VOID_INTENT_STORE_FILE,
      identifier: UNFENCED_ENQUEUE_IDENTIFIER,
      form: 'star-re-export',
    });
  });

  test('detects a dynamic import() that grants access to the tracked identifier', () => {
    const src = `async function bypass() {\n  const mod = await import('./projectPrivilegedOfflineAction');\n  return mod.${D3_IDENTIFIER};\n}\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, definer);
    expect(hits).toContainEqual({ file: PROBE_FILE, definerFile: D3_ADAPTER_FILE, identifier: D3_IDENTIFIER, form: 'dynamic-import' });
  });

  test('a named import of an UNTRACKED identifier from the same definer file is not flagged', () => {
    const src = `import { listPrivilegedEvidence } from './voidIntentStore';\nvoid listPrivilegedEvidence;\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, definer);
    expect(hits).toEqual([]);
  });

  test('an import from an unrelated module is not flagged', () => {
    const src = `import { ${D3_IDENTIFIER} } from './someOtherModule';\nvoid ${D3_IDENTIFIER};\n`;
    const hits = collectImportHits(PROBE_FILE, src, inventory, definer);
    expect(hits).toEqual([]);
  });
});
