/**
 * Phase A platform-port-layer confinement.
 *
 * Narrow contract for src/lib/platform only. Does not copy or rewrite the
 * closed Row29 / AIC frozen sets. Uses a filesystem inventory (same family as
 * stockTruthGuard.static) so this file does not eager-glob the entire /src tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript'; // test-only; production inventory skips `*.test.*`
import { describe, expect, test } from 'vitest';
import appShellSource from '../../components/AppShell.tsx?raw';
import orchestratorSource from '../pos/offline/syncOrchestrator.ts?raw';

const ROOT = resolve(process.cwd());

const PLATFORM_PREFIX = '/src/lib/platform/';
const APP_SHELL = '/src/components/AppShell.tsx';
const ORCHESTRATOR = '/src/lib/pos/offline/syncOrchestrator.ts';
const CONNECTIVITY_ADAPTER = '/src/lib/platform/adapters/browser/browserConnectivityPort.ts';

const ROW29_OWNER_FILES = [
  '/src/lib/pos/offline/activeCartSnapshotStore.ts',
  '/src/lib/pos/offline/saleSubmissionEvidenceStore.ts',
  '/src/lib/pos/offline/saleSubmissionEvidenceTypes.ts',
  '/src/lib/pos/offline/trustedOrchestrationOwner.ts',
] as const;

const ROW29_SPEC_TOKENS = [
  'activeCartSnapshotStore',
  'saleSubmissionEvidenceStore',
  'saleSubmissionEvidenceTypes',
  'trustedOrchestrationOwner',
] as const;

const FORBIDDEN_BARE_PREFIXES = [
  '@tauri-apps/',
  '@capacitor/',
  '@capacitor-community/',
  'electron',
  'sql.js',
  'better-sqlite3',
  '@tauri-apps',
];

function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

function toSrcKey(absPath: string): string {
  const rel = posix(relative(ROOT, absPath));
  return rel.startsWith('/') ? rel : `/${rel}`;
}

function isTestPath(path: string): boolean {
  return path.includes('.test.') || path.includes('.spec.');
}

function isPlatformPath(path: string): boolean {
  return posix(path).startsWith(PLATFORM_PREFIX);
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

function collectSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkTsFiles(abs, out);
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(abs);
  }
}

function productionEntries(): Array<{ file: string; text: string }> {
  const files: string[] = [];
  walkTsFiles(resolve(ROOT, 'src'), files);
  const out: Array<{ file: string; text: string }> = [];
  for (const abs of files) {
    const file = toSrcKey(abs);
    if (isTestPath(file)) continue;
    out.push({ file, text: readFileSync(abs, 'utf8') });
  }
  return out;
}

function platformProduction(): Array<{ file: string; text: string }> {
  return productionEntries().filter((e) => isPlatformPath(e.file));
}

function readRepoFile(posixPath: string): string {
  return readFileSync(resolve(ROOT, posixPath.slice(1)), 'utf8');
}

const CONNECTIVITY_IMPORT_SPEC = '../lib/platform/adapters/browser/browserConnectivityPort';
const CONNECTIVITY_BINDING = 'createBrowserSyncOrchestratorDeps';
const SYNC_HOOK = 'useSyncOrchestrator';

function parseTsx(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

function hasNamedValueImport(sf: ts.SourceFile, binding: string, specifier: string): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (stmt.importClause?.isTypeOnly) continue;
    const spec = stmt.moduleSpecifier;
    if (!(ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) continue;
    if (spec.text !== specifier) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      const importedName = el.propertyName?.text ?? el.name.text;
      if (importedName === binding && el.name.text === binding) return true;
    }
  }
  return false;
}

function isZeroArgIdentCall(node: ts.Expression, name: string): boolean {
  const expr = unwrapParens(node);
  return (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === name &&
    expr.arguments.length === 0
  );
}

function hasUseSyncOrchestratorConnectivityCall(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SYNC_HOOK &&
      node.arguments.length === 1 &&
      isZeroArgIdentCall(node.arguments[0], CONNECTIVITY_BINDING)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function inspectAppShellWiring(
  text: string,
  filePath = 'fixture.tsx',
): { hasNamedConnectivityImport: boolean; hasSyncOrchestratorCall: boolean } {
  const sf = parseTsx(filePath, text);
  return {
    hasNamedConnectivityImport: hasNamedValueImport(sf, CONNECTIVITY_BINDING, CONNECTIVITY_IMPORT_SPEC),
    hasSyncOrchestratorCall: hasUseSyncOrchestratorConnectivityCall(sf),
  };
}

describe('Phase A platform port layer confinement', () => {
  test('zero bare package specifiers under src/lib/platform/', () => {
    const bare: string[] = [];
    for (const { file, text } of platformProduction()) {
      for (const spec of collectSpecifiers(text)) {
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        bare.push(`${file}:${spec}`);
      }
    }
    expect(bare).toEqual([]);
  });

  test('zero indexedDB.open under src/lib/platform/', () => {
    for (const { file, text } of platformProduction()) {
      expect(text, file).not.toContain('indexedDB.open');
      expect(text, file).not.toContain('indexedDB.open(');
    }
  });

  test('zero Tauri/Capacitor/Electron/native package imports in the platform layer', () => {
    for (const { file, text } of platformProduction()) {
      for (const spec of collectSpecifiers(text)) {
        expect(spec.startsWith('.') || spec.startsWith('/'), `${file} ${spec}`).toBe(true);
        for (const prefix of FORBIDDEN_BARE_PREFIXES) {
          expect(spec === prefix || spec.startsWith(`${prefix}/`) || spec.startsWith(prefix), `${file} ${spec}`).toBe(
            false,
          );
        }
      }
      expect(text, file).not.toMatch(/from\s+['"]@tauri-apps/);
      expect(text, file).not.toMatch(/from\s+['"]@capacitor/);
      expect(text, file).not.toMatch(/from\s+['"]electron['"]/);
    }
  });

  test('platform layer does not import frozen Row29 owner modules', () => {
    for (const { file, text } of platformProduction()) {
      for (const spec of collectSpecifiers(text)) {
        if (!(spec.startsWith('.') || spec.startsWith('/'))) continue;
        const resolved = spec.startsWith('/') ? spec : posixResolve(file, spec);
        const resolvedFile = resolved.endsWith('.ts') || resolved.endsWith('.tsx') ? resolved : `${resolved}.ts`;
        expect(
          ROW29_OWNER_FILES.includes(resolvedFile as (typeof ROW29_OWNER_FILES)[number]),
          `${file} -> ${resolvedFile}`,
        ).toBe(false);
      }
      for (const token of ROW29_SPEC_TOKENS) {
        expect(text, `${file} ${token}`).not.toContain(token);
      }
    }
  });

  test('platform layer uses relative imports only (no Vite/TS path alias requirement)', () => {
    for (const { file, text } of platformProduction()) {
      for (const spec of collectSpecifiers(text)) {
        expect(spec.startsWith('.'), `${file} ${spec}`).toBe(true);
      }
    }
  });

  test('root tsconfig set is unchanged and compilerOptions.paths are absent', () => {
    const names = readdirSync(ROOT)
      .filter((n) => n.startsWith('tsconfig') && n.endsWith('.json'))
      .sort();
    expect(names).toEqual(['tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json']);
    for (const name of names) {
      const text = readFileSync(resolve(ROOT, name), 'utf8');
      expect(text, name).not.toMatch(/"paths"\s*:/);
    }
  });

  test('vite config has no resolve.alias', () => {
    const viteText = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(viteText).not.toMatch(/resolve\s*:\s*\{[^}]*alias/s);
    expect(viteText).not.toContain('alias:');
  });

  test('only AppShell among existing production sources wires the platform layer', () => {
    const importers: string[] = [];
    for (const { file, text } of productionEntries()) {
      if (isPlatformPath(file)) continue;
      const hitsPlatform = collectSpecifiers(text).some((spec) => {
        if (!(spec.startsWith('.') || spec.startsWith('/'))) return false;
        const resolved = spec.startsWith('/') ? spec : posixResolve(file, spec);
        return (
          resolved.startsWith(PLATFORM_PREFIX) ||
          spec.includes('/lib/platform/') ||
          spec.includes('platform/adapters') ||
          spec.includes('platform/ports')
        );
      });
      if (hitsPlatform) importers.push(file);
    }
    expect(importers).toEqual([APP_SHELL]);
    const appShellWiring = inspectAppShellWiring(appShellSource, APP_SHELL);
    expect(appShellWiring.hasNamedConnectivityImport).toBe(true);
    expect(appShellWiring.hasSyncOrchestratorCall).toBe(true);
    expect(appShellSource).not.toContain('browserDurableStorePort');
    expect(appShellSource).not.toContain('browserSecureSecretPort');
    expect(appShellSource).not.toContain('browserPrintPort');
    expect(appShellSource).not.toContain('browserFilePort');
    expect(appShellSource).not.toContain('browserLifecyclePort');
    expect(appShellSource).not.toContain('durableStorePort');
    expect(appShellSource).not.toContain('secureSecretPort');
  });

  test('AppShell wiring helper rejects comment/string false positives and accepts a real import+call', () => {
    expect(isTestPath('/src/lib/platform/platformPortLayerConfinement.test.ts')).toBe(true);
    expect(platformProduction().some((e) => e.file.includes('platformPortLayerConfinement'))).toBe(false);

    const valid = [
      `import { ${CONNECTIVITY_BINDING} } from '${CONNECTIVITY_IMPORT_SPEC}';`,
      `${SYNC_HOOK}(${CONNECTIVITY_BINDING}());`,
    ].join('\n');
    expect(inspectAppShellWiring(valid)).toEqual({
      hasNamedConnectivityImport: true,
      hasSyncOrchestratorCall: true,
    });

    expect(inspectAppShellWiring('// useSyncOrchestrator() composition seam')).toEqual({
      hasNamedConnectivityImport: false,
      hasSyncOrchestratorCall: false,
    });

    const fullExpr = `${SYNC_HOOK}(${CONNECTIVITY_BINDING}())`;
    expect(inspectAppShellWiring(`// ${fullExpr}`).hasSyncOrchestratorCall).toBe(false);
    expect(inspectAppShellWiring(`/* ${fullExpr} */`).hasSyncOrchestratorCall).toBe(false);
    expect(inspectAppShellWiring(`const s = '${fullExpr}';`).hasSyncOrchestratorCall).toBe(false);
    expect(inspectAppShellWiring(`const s = "${fullExpr}";`).hasSyncOrchestratorCall).toBe(false);
    expect(inspectAppShellWiring(`const s = \`${fullExpr}\`;`).hasSyncOrchestratorCall).toBe(false);

    const importOnlyComment = [
      `import { ${CONNECTIVITY_BINDING} } from '${CONNECTIVITY_IMPORT_SPEC}';`,
      '// useSyncOrchestrator() composition seam',
    ].join('\n');
    expect(inspectAppShellWiring(importOnlyComment)).toEqual({
      hasNamedConnectivityImport: true,
      hasSyncOrchestratorCall: false,
    });

    const importLine = `import { ${CONNECTIVITY_BINDING} } from '${CONNECTIVITY_IMPORT_SPEC}'`;
    expect(inspectAppShellWiring(`// ${importLine}`).hasNamedConnectivityImport).toBe(false);
    expect(inspectAppShellWiring(`const s = ${JSON.stringify(importLine)};`).hasNamedConnectivityImport).toBe(false);
    expect(inspectAppShellWiring(`const s = \`${importLine}\`;`).hasNamedConnectivityImport).toBe(false);
  });

  test('AppShell is the only production importer of the browser connectivity adapter', () => {
    const importers: string[] = [];
    for (const { file, text } of productionEntries()) {
      if (file === CONNECTIVITY_ADAPTER) continue;
      for (const spec of collectSpecifiers(text)) {
        if (!(spec.startsWith('.') || spec.startsWith('/'))) continue;
        const resolved = spec.startsWith('/') ? spec : posixResolve(file, spec);
        const resolvedFile = resolved.endsWith('.ts') || resolved.endsWith('.tsx') ? resolved : `${resolved}.ts`;
        if (resolvedFile === CONNECTIVITY_ADAPTER || spec.includes('browserConnectivityPort')) {
          importers.push(file);
        }
      }
    }
    expect(importers).toEqual([APP_SHELL]);
  });

  test('syncOrchestrator.ts does not import the platform layer', () => {
    expect(orchestratorSource).not.toContain('lib/platform');
    expect(orchestratorSource).not.toContain('platform/ports');
    expect(orchestratorSource).not.toContain('platform/adapters');
    expect(orchestratorSource).not.toContain('ConnectivityPort');
    expect(orchestratorSource).toContain('export type SyncOrchestratorDeps');
    expect(orchestratorSource).toContain('navigatorRef?: Navigator | undefined');
    expect(orchestratorSource).toContain("addEventListener?: (type: 'online' | 'offline', fn: () => void) => void");
    expect(readRepoFile(ORCHESTRATOR)).toBe(orchestratorSource);
  });
});
