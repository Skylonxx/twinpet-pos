/**
 * Row32 confinement-only contract.
 *
 * Why this file exists: enforce writer/importer/store confinement for the
 * Row29 cart/evidence island without application integration. Expected values
 * are frozen literals compared against AST-derived actuals. They are never
 * derived from live source and never auto-updated.
 *
 * W8 comparison is exact multiset/cardinality (sorted [TupleKey, count] pairs
 * + exact total + exact distinct). Uniqueness-only Set comparison is prohibited
 * because it stays green after a duplicate same-tuple mutation site.
 *
 * Epistemic boundary: this is direct/statically resolvable confinement only.
 * It does not claim impossibility against obfuscated runtime string construction.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as ts from 'typescript';
// Vite omits the glob host from its own eager import.meta.glob inventory.
// The accepted /src glob remains the repository source of truth; this ?raw
// import only registers the host into the TEST partition for self-exclusion.
import confinementContractRaw from './saleSubmissionWriterConfinement.test.ts?raw';
// C5 cart-first host: relative value-import order is load-bearing and must
// not be auto-sorted. Cart-store value imports MUST precede evidence-store
// value imports so this file enters the two-predicate cycle cart-first.
import {
  acquireSaleSubmissionResumeFence,
  initializeActiveCartSaleSubmission,
  readActiveCartDurableDump,
  readActiveCartSnapshot,
} from './activeCartSnapshotStore';
import * as cartRuntimeExports from './activeCartSnapshotStore';
import * as evidenceRuntimeExports from './saleSubmissionEvidenceStore';

const CART_FILE = '/src/lib/pos/offline/activeCartSnapshotStore.ts';
const EVIDENCE_FILE = '/src/lib/pos/offline/saleSubmissionEvidenceStore.ts';
const TYPES_FILE = '/src/lib/pos/offline/saleSubmissionEvidenceTypes.ts';
const CONTRACT_FILE = '/src/lib/pos/offline/saleSubmissionWriterConfinement.test.ts';

const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const CART_STORE = 'activeCartSnapshots';
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';

const ROW29_LITERAL_OWNERS: Record<string, string> = {
  [CART_DB_NAME]: CART_FILE,
  [EVIDENCE_DB_NAME]: EVIDENCE_FILE,
  [CART_STORE]: CART_FILE,
  [POINTER_STORE]: EVIDENCE_FILE,
  [ENTRY_STORE]: EVIDENCE_FILE,
};

const FROZEN_CART_RUNTIME_IMPORTERS = [EVIDENCE_FILE];
const FROZEN_CART_TYPE_ONLY_IMPORTERS: string[] = [];
const FROZEN_EVIDENCE_RUNTIME_IMPORTERS = [CART_FILE];
const FROZEN_EVIDENCE_TYPE_ONLY_IMPORTERS: string[] = [];
const FROZEN_TYPES_RUNTIME_IMPORTERS: string[] = [];
const FROZEN_TYPES_TYPE_ONLY_IMPORTERS = [CART_FILE, EVIDENCE_FILE];

const FROZEN_CART_RUNTIME_EXPORTS = [
  'acquireSaleSubmissionResumeFence',
  'beginActiveCartGeneration',
  'initializeActiveCartSaleSubmission',
  'isAuthenticAcquiredResumeFenceAuthorization',
  'readActiveCartDurableDump',
  'readActiveCartSnapshot',
  'releaseSaleSubmissionResumeFence',
];
const FROZEN_EVIDENCE_RUNTIME_EXPORTS = [
  'commitSaleSubmissionAbsenceSeal',
  'isAuthenticProvenEvidenceAbsence',
];
const FROZEN_ALL_NINE_RUNTIME_EXPORTS = [
  ...FROZEN_CART_RUNTIME_EXPORTS,
  ...FROZEN_EVIDENCE_RUNTIME_EXPORTS,
].sort();

const FROZEN_CART_TO_EVIDENCE_RUNTIME_SYMBOLS = ['isAuthenticProvenEvidenceAbsence'];
const FROZEN_EVIDENCE_TO_CART_RUNTIME_SYMBOLS = ['isAuthenticAcquiredResumeFenceAuthorization'];
const FROZEN_CART_TO_TYPES_SYMBOLS = [
  'AcquiredResumeFenceAuthorization',
  'ActiveCartSnapshotRecord',
  'ProvenEvidenceAbsence',
  'ReleaseSaleSubmissionResumeFenceResult',
];
const FROZEN_EVIDENCE_TO_TYPES_SYMBOLS = [
  'AbsenceSealAuthorityV1',
  'AcquiredResumeFenceAuthorization',
  'CommitSaleSubmissionAbsenceSealResult',
  'ProvenEvidenceAbsence',
];

const FROZEN_BARE_SPECIFIERS = [
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
];

const PRODUCTION_INDEXEDDB_OPEN_SITE_COUNT = 8;
const UNRESOLVED_PRODUCTION_INDEXEDDB_OPEN_NAME_COUNT = 0;
const EXPECTED_PRODUCTION_PARSE_DIAGNOSTIC_COUNT = 0;

const FROZEN_ROW29_DB_OPEN_PAIRS: ReadonlyArray<{
  dbName: string;
  ownerPath: string;
  count: number;
}> = [
  {
    dbName: 'twinpet-active-cart-snapshot',
    ownerPath: '/src/lib/pos/offline/activeCartSnapshotStore.ts',
    count: 1,
  },
  {
    dbName: 'twinpet-sale-submission-evidence',
    ownerPath: '/src/lib/pos/offline/saleSubmissionEvidenceStore.ts',
    count: 1,
  },
];
const ROW29_MUTATION_SITE_COUNT = 9;
const ROW29_TRANSACTION_SITE_COUNT = 2;
const POINTER_STORE_SEMANTIC_MUTATION_INVOCATION_COUNT = 1;
const ENTRY_STORE_SEMANTIC_MUTATION_INVOCATION_COUNT = 0;
const ENTRY_STORE_SEMANTIC_READ_INVOCATION_COUNT = 1;
const W8_CART_TOTAL_RETAINED_SITE_COUNT = 6;
const W8_CART_DISTINCT_TUPLE_COUNT = 6;
const W8_EVIDENCE_TOTAL_RETAINED_SITE_COUNT = 3;
const W8_EVIDENCE_DISTINCT_TUPLE_COUNT = 3;
const W8_DELETE_DATABASE_CART_COUNT = 0;
const W8_DELETE_DATABASE_EVIDENCE_COUNT = 0;

const MUTATION_METHODS = new Set([
  'put',
  'add',
  'delete',
  'clear',
  'update',
  'createObjectStore',
  'createIndex',
  'deleteObjectStore',
  'deleteDatabase',
]);

const ASSET_EXTENSIONS = new Set([
  '.css',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.woff',
  '.woff2',
  '.ico',
]);

const FROZEN_CART_W8_PAIRS: [string, number][] = [
  [`${CART_FILE}|acquireSaleSubmissionResumeFence|put|store:activeCartSnapshots|semantic`, 1],
  [`${CART_FILE}|beginActiveCartGeneration|put|store:activeCartSnapshots|semantic`, 1],
  [`${CART_FILE}|initializeActiveCartSaleSubmission|put|store:activeCartSnapshots|semantic`, 1],
  [`${CART_FILE}|openCartDb|createObjectStore|store:activeCartSnapshots|schema`, 1],
  [`${CART_FILE}|releaseSaleSubmissionResumeFence|put|store:activeCartSnapshots|semantic`, 1],
  [`${CART_FILE}|transactCart|put|store:activeCartSnapshots|raw_seam`, 1],
];

const FROZEN_EVIDENCE_W8_PAIRS: [string, number][] = [
  [`${EVIDENCE_FILE}|openEvidenceDb|createObjectStore|store:saleEvidenceGenerationPointers+store:saleSubmissionEvidence|schema`, 1],
  [`${EVIDENCE_FILE}|runAuthorizedSealTransaction|add|store:saleEvidenceGenerationPointers|semantic`, 1],
  [`${EVIDENCE_FILE}|transactEvidence|add|store:saleEvidenceGenerationPointers+store:saleSubmissionEvidence|raw_seam`, 1],
];

const SRC_RAW = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const TSCONFIG_RAW = import.meta.glob('/tsconfig*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const VITE_CONFIG_RAW = import.meta.glob('/vite.config.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type EdgeKind = 'runtime' | 'type-only' | 'asset' | 'bare';

type SourceEdge = {
  fromFile: string;
  specifier: string;
  resolved: string | undefined;
  kind: EdgeKind;
  typeOnly: boolean;
  symbols: string[];
  form: string;
};

type MutationClass = 'raw_seam' | 'semantic' | 'schema' | 'database_destructive';

type MutationSite = {
  file: string;
  owner: string;
  method: string;
  targetDomain: string;
  class: MutationClass;
};

type OpenSite = {
  file: string;
  resolved: string | undefined;
};

type TransactionSite = {
  file: string;
  resolved: string[] | undefined;
};

type SemanticAccess = {
  file: string;
  owner: string;
  method: string;
  store: string;
};

type ModuleEnv = {
  consts: Map<string, ts.Expression>;
  aliases: Map<string, ts.TypeNode>;
  interfaces: Map<string, ts.InterfaceDeclaration>;
  weakSets: Set<string>;
  contextualParams: Map<ts.Node, Map<string, string[]>>;
};

type ImporterSets = {
  runtime: string[];
  typeOnly: string[];
};

type Analysis = {
  productionFiles: string[];
  testFiles: string[];
  failures: string[];
  edgesByFrom: Map<string, SourceEdge[]>;
  importers: Record<string, ImporterSets>;
  cycleRuntime: { symbols: string[]; namespace: boolean };
  cycleEvidenceRuntime: { symbols: string[]; namespace: boolean };
  cartToTypes: string[];
  evidenceToTypes: string[];
  bareSpecifiers: string[];
  openSites: OpenSite[];
  ownerMutationSites: MutationSite[];
  unclassifiedMutationSites: string[];
  ownerTransactionSites: TransactionSite[];
  semanticGets: SemanticAccess[];
  semanticMutationStores: SemanticAccess[];
  identifierHitsOutsideIsland: { file: string; name: string }[];
  predicateCalls: { file: string; name: string; owner: string }[];
  productionParseDiagnosticCount: number;
  config: {
    globVerified: boolean;
    tsconfigPathsAbsent: boolean;
    viteResolveAliasAbsent: boolean;
    configFailures: string[];
  };
};

function sortedCopy(values: string[]): string[] {
  return [...values].sort();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function posixNormalize(key: string): string | undefined {
  const normalized = key.replace(/\\/g, '/');
  if (!normalized.startsWith('/src/') || normalized.includes('\\')) return undefined;
  return normalized;
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

function stripQuery(specifier: string): string {
  const q = specifier.indexOf('?');
  return q >= 0 ? specifier.slice(0, q) : specifier;
}

function extensionOf(specifier: string): string | undefined {
  const base = specifier.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return base.slice(dot).toLowerCase();
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parseSource(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
}

function sourceFileParseDiagnostics(sf: ts.SourceFile): readonly ts.Diagnostic[] | undefined {
  const raw = (sf as ts.SourceFile & { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(raw)) return undefined;
  return raw as readonly ts.Diagnostic[];
}

function namedSpecifierSourceSymbol(element: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return element.propertyName?.text ?? element.name.text;
}

function literalString(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function staticPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return literalString(unwrapExpr(name.expression));
  return undefined;
}

function typeRefName(node: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return node.typeName.text;
  if (ts.isParenthesizedTypeNode(node)) return typeRefName(node.type);
  return undefined;
}

function unwrapExpr(node: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return unwrapExpr(node.expression);
  }
  return node;
}

function isNewWeakSet(node: ts.Expression): boolean {
  const expr = unwrapExpr(node);
  return ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'WeakSet';
}

function isIndexedDbReceiver(expr: ts.Expression): boolean {
  const inner = unwrapExpr(expr);
  if (ts.isIdentifier(inner) && inner.text === 'indexedDB') return true;
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'indexedDB' && ts.isIdentifier(inner.expression)) {
    return inner.expression.text === 'window' || inner.expression.text === 'globalThis';
  }
  return false;
}

function callParts(node: ts.CallExpression): { receiver: ts.Expression; method: string } | undefined {
  const expr = node.expression;
  if (ts.isPropertyAccessExpression(expr)) return { receiver: expr.expression, method: expr.name.text };
  if (ts.isElementAccessExpression(expr)) {
    const method = literalString(expr.argumentExpression);
    if (!method) return undefined;
    return { receiver: expr.expression, method };
  }
  return undefined;
}

function isObjectStoreCall(expr: ts.Expression): ts.CallExpression | undefined {
  const inner = unwrapExpr(expr);
  if (!ts.isCallExpression(inner)) return undefined;
  const parts = callParts(inner);
  if (!parts || parts.method !== 'objectStore') return undefined;
  return inner;
}

function isImportMetaGlob(node: ts.CallExpression): boolean {
  const expr = node.expression;
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === 'glob' &&
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expr.expression.name.text === 'meta'
  );
}

function enclosingNamedFunction(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isFunctionExpression(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function canonicalizeDomain(kind: 'store' | 'db', names: string[]): string {
  return uniqueSorted(names).map((n) => `${kind}:${n}`).join('+');
}

function tupleKey(site: MutationSite): string {
  return [site.file, site.owner, site.method, site.targetDomain, site.class].join('|');
}

function sortedMultisetPairs(sites: MutationSite[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    const key = tupleKey(site);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp | undefined {
  if (pattern.startsWith('!') || pattern.includes('!(')) return undefined;
  let i = 0;
  let out = '^';
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '.*';
      i += 3;
      continue;
    }
    if (pattern.startsWith('**', i) && (i + 2 === pattern.length || pattern[i + 2] === '/')) {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = pattern[i];
    if (ch === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) return undefined;
      const alts = pattern.slice(i + 1, end).split(',').map(escapeRegex);
      out += `(?:${alts.join('|')})`;
      i = end + 1;
      continue;
    }
    out += escapeRegex(ch);
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

function resolveAgainstInventory(
  fromFile: string,
  specifier: string,
  inventory: Set<string>,
): { kind: 'source' | 'asset' | 'bare' | 'unresolved'; resolved?: string } {
  const spec = stripQuery(specifier);
  if (!spec.startsWith('.') && !spec.startsWith('/')) return { kind: 'bare' };
  if (spec.startsWith('/') && !spec.startsWith('/src/')) return { kind: 'unresolved' };

  const ext = extensionOf(spec);
  if (ext && ASSET_EXTENSIONS.has(ext)) return { kind: 'asset', resolved: spec };

  const absolute = spec.startsWith('/src/') ? spec : posixResolve(fromFile, spec);
  const candidates = [
    absolute,
    `${absolute}.ts`,
    `${absolute}.tsx`,
    `${absolute}/index.ts`,
    `${absolute}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (inventory.has(candidate)) return { kind: 'source', resolved: candidate };
  }
  if (ext && ext !== '.ts' && ext !== '.tsx') return { kind: 'asset', resolved: absolute };
  return { kind: 'unresolved' };
}

function buildModuleEnv(sf: ts.SourceFile): ModuleEnv {
  const env: ModuleEnv = {
    consts: new Map(),
    aliases: new Map(),
    interfaces: new Map(),
    weakSets: new Set(),
    contextualParams: new Map(),
  };
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        env.consts.set(decl.name.text, decl.initializer);
        if (isNewWeakSet(decl.initializer)) env.weakSets.add(decl.name.text);
      }
    }
    if (ts.isTypeAliasDeclaration(stmt)) env.aliases.set(stmt.name.text, stmt.type);
    if (ts.isInterfaceDeclaration(stmt)) env.interfaces.set(stmt.name.text, stmt);
  }
  return env;
}

function resolveTypeNode(node: ts.TypeNode, env: ModuleEnv, aliasHops: number): string[] | undefined {
  if (ts.isParenthesizedTypeNode(node)) return resolveTypeNode(node.type, env, aliasHops);
  if (ts.isLiteralTypeNode(node)) {
    const text = literalString(node.literal);
    return text === undefined ? undefined : [text];
  }
  if (ts.isUnionTypeNode(node)) {
    const out: string[] = [];
    for (const member of node.types) {
      const part = resolveTypeNode(member, env, aliasHops);
      if (!part) return undefined;
      out.push(...part);
    }
    return uniqueSorted(out);
  }
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) {
    return resolveFiniteDomain(node.exprName, env, new Map());
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    const index = node.indexType;
    const isNumberIndex =
      index.kind === ts.SyntaxKind.NumberKeyword ||
      (ts.isLiteralTypeNode(index) && index.literal.kind === ts.SyntaxKind.NumericLiteral) ||
      (ts.isTypeReferenceNode(index) && ts.isIdentifier(index.typeName) && index.typeName.text === 'number');
    if (!isNumberIndex) return undefined;
    let objectType = node.objectType;
    if (ts.isParenthesizedTypeNode(objectType)) objectType = objectType.type;
    if (ts.isTypeQueryNode(objectType) && ts.isIdentifier(objectType.exprName)) {
      return resolveFiniteDomain(objectType.exprName, env, new Map());
    }
    return undefined;
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    if (aliasHops >= 1) return undefined;
    const aliased = env.aliases.get(node.typeName.text);
    if (!aliased) return undefined;
    return resolveTypeNode(aliased, env, aliasHops + 1);
  }
  return undefined;
}

function resolveFiniteDomain(
  node: ts.Node,
  env: ModuleEnv,
  local: Map<string, string[]>,
  visiting = new Set<string>(),
): string[] | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
    return resolveFiniteDomain(node.expression, env, local, visiting);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isIdentifier(node)) {
    const localHit = local.get(node.text);
    if (localHit) return localHit;
    if (visiting.has(node.text)) return undefined;
    const initializer = env.consts.get(node.text);
    if (!initializer) return undefined;
    visiting.add(node.text);
    const resolved = resolveFiniteDomain(initializer, env, local, visiting);
    visiting.delete(node.text);
    return resolved;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const out: string[] = [];
    for (const element of node.elements) {
      if (ts.isOmittedExpression(element)) return undefined;
      if (ts.isSpreadElement(element)) {
        const part = resolveFiniteDomain(element.expression, env, local, visiting);
        if (!part) return undefined;
        out.push(...part);
      } else {
        const part = resolveFiniteDomain(element, env, local, visiting);
        if (!part) return undefined;
        out.push(...part);
      }
    }
    return uniqueSorted(out);
  }
  return undefined;
}

function interfaceMethodParamType(
  iface: ts.InterfaceDeclaration,
  methodName: string,
  paramIndex: number,
): ts.TypeNode | undefined {
  for (const member of iface.members) {
    if (!ts.isMethodSignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
    if (member.name.text !== methodName) continue;
    return member.parameters[paramIndex]?.type;
  }
  return undefined;
}

function collectContextualParams(sf: ts.SourceFile, env: ModuleEnv): void {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.type && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const ifaceName = typeRefName(node.type);
      const iface = ifaceName ? env.interfaces.get(ifaceName) : undefined;
      if (iface) {
        for (const prop of node.initializer.properties) {
          if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
          if (!ts.isPropertyAssignment(prop)) continue;
          const methodName = ts.isIdentifier(prop.name) ? prop.name.text : literalString(prop.name);
          if (!methodName) continue;
          if (!ts.isArrowFunction(prop.initializer) && !ts.isFunctionExpression(prop.initializer)) continue;
          const bindings = new Map<string, string[]>();
          prop.initializer.parameters.forEach((param, index) => {
            if (!ts.isIdentifier(param.name)) return;
            const typeNode = param.type ?? interfaceMethodParamType(iface, methodName, index);
            if (!typeNode) return;
            const domain = resolveTypeNode(typeNode, env, 0);
            if (domain) bindings.set(param.name.text, domain);
          });
          if (bindings.size > 0) env.contextualParams.set(prop.initializer, bindings);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function bindForOf(node: ts.ForOfStatement, env: ModuleEnv, local: Map<string, string[]>): Map<string, string[]> {
  const next = new Map(local);
  const domain = resolveFiniteDomain(node.expression, env, local);
  if (!domain) return next;
  const initializer = node.initializer;
  if (ts.isVariableDeclarationList(initializer) && initializer.declarations[0] && ts.isIdentifier(initializer.declarations[0].name)) {
    next.set(initializer.declarations[0].name.text, domain);
  }
  return next;
}

function pushFunctionLocals(fn: ts.Node, env: ModuleEnv, local: Map<string, string[]>): Map<string, string[]> {
  const contextual = env.contextualParams.get(fn);
  if (!contextual) return local;
  const next = new Map(local);
  for (const [name, domain] of contextual) next.set(name, domain);
  return next;
}

function recordFailure(failures: string[], code: string, detail: string): void {
  failures.push(`${code}: ${detail}`);
}

function addEdge(
  edges: SourceEdge[],
  failures: string[],
  fromFile: string,
  specifier: string,
  typeOnly: boolean,
  symbols: string[],
  form: string,
  inventory: Set<string>,
): void {
  const resolved = resolveAgainstInventory(fromFile, specifier, inventory);
  if (resolved.kind === 'unresolved') {
    recordFailure(failures, 'unresolved_specifier', `${fromFile} -> ${specifier} (${form})`);
    return;
  }
  if (resolved.kind === 'asset') {
    edges.push({ fromFile, specifier, resolved: resolved.resolved, kind: 'asset', typeOnly: false, symbols: [], form });
    return;
  }
  if (resolved.kind === 'bare') {
    edges.push({
      fromFile,
      specifier: stripQuery(specifier),
      resolved: undefined,
      kind: 'bare',
      typeOnly,
      symbols,
      form,
    });
    return;
  }
  edges.push({
    fromFile,
    specifier,
    resolved: resolved.resolved,
    kind: typeOnly ? 'type-only' : 'runtime',
    typeOnly,
    symbols,
    form,
  });
}

function extractImportTypeArgument(node: ts.ImportTypeNode): string | undefined {
  const arg = node.argument;
  if (ts.isLiteralTypeNode(arg)) return literalString(arg.literal);
  return undefined;
}

function collectEdgesFromSource(
  fromFile: string,
  sf: ts.SourceFile,
  inventory: Set<string>,
  row29Keys: string[],
  failures: string[],
): SourceEdge[] {
  const edges: SourceEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalString(node.moduleSpecifier);
      if (specifier === undefined) {
        recordFailure(failures, 'nonliteral_import', fromFile);
        ts.forEachChild(node, visit);
        return;
      }
      const clause = node.importClause;
      if (!clause) {
        addEdge(edges, failures, fromFile, specifier, false, [], 'side-effect-import', inventory);
        ts.forEachChild(node, visit);
        return;
      }
      const clauseTypeOnly = clause.isTypeOnly;
      if (clause.name) {
        addEdge(edges, failures, fromFile, specifier, clauseTypeOnly, ['default'], 'default-import', inventory);
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        addEdge(edges, failures, fromFile, specifier, clauseTypeOnly, ['*'], 'namespace-import', inventory);
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const typeOnly = clauseTypeOnly || element.isTypeOnly;
          addEdge(
            edges,
            failures,
            fromFile,
            specifier,
            typeOnly,
            [namedSpecifierSourceSymbol(element)],
            'named-import',
            inventory,
          );
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalString(node.moduleSpecifier);
      if (specifier === undefined) {
        recordFailure(failures, 'nonliteral_export_from', fromFile);
        ts.forEachChild(node, visit);
        return;
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const typeOnly = node.isTypeOnly || element.isTypeOnly;
          addEdge(
            edges,
            failures,
            fromFile,
            specifier,
            typeOnly,
            [namedSpecifierSourceSymbol(element)],
            'export-from',
            inventory,
          );
        }
      } else {
        addEdge(edges, failures, fromFile, specifier, node.isTypeOnly, ['*'], 'export-star-from', inventory);
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (!ts.isExternalModuleReference(ref)) {
        ts.forEachChild(node, visit);
        return;
      }
      const specifier = literalString(ref.expression);
      if (specifier === undefined) {
        recordFailure(failures, 'nonliteral_import_equals', fromFile);
        ts.forEachChild(node, visit);
        return;
      }
      const symbols = node.isTypeOnly ? [node.name.text] : ['*'];
      addEdge(edges, failures, fromFile, specifier, node.isTypeOnly, symbols, 'import-equals', inventory);
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isImportTypeNode(node)) {
      const specifier = extractImportTypeArgument(node);
      if (specifier === undefined) {
        recordFailure(failures, 'nonliteral_import_type', fromFile);
      } else {
        addEdge(edges, failures, fromFile, specifier, true, ['*'], 'import-type-node', inventory);
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      const specifier = literalString(arg);
      if (specifier === undefined) {
        recordFailure(failures, 'nonliteral_dynamic_import', `${fromFile}`);
      } else {
        addEdge(edges, failures, fromFile, specifier, false, ['*'], 'dynamic-import', inventory);
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isCallExpression(node) && isImportMetaGlob(node)) {
      const arg = node.arguments[0];
      if (!arg) {
        recordFailure(failures, 'unsupported_glob_form', `${fromFile} missing pattern`);
      } else if (ts.isArrayLiteralExpression(arg)) {
        recordFailure(failures, 'unsupported_glob_form', `${fromFile} array/negative glob`);
      } else {
        const pattern = literalString(arg);
        if (pattern === undefined) {
          recordFailure(failures, 'unsupported_glob_form', `${fromFile} computed glob`);
        } else {
          const re = globToRegExp(pattern);
          if (!re) {
            recordFailure(failures, 'unsupported_glob_form', `${fromFile} ${pattern}`);
          } else {
            for (const key of row29Keys) {
              if (re.test(key)) {
                addEdge(edges, failures, fromFile, key, false, ['*'], 'import-meta-glob', inventory);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edges;
}

function collectOwnerSites(
  file: string,
  sf: ts.SourceFile,
  env: ModuleEnv,
  failures: string[],
): {
  mutations: MutationSite[];
  unclassified: string[];
  transactions: TransactionSite[];
  opens: OpenSite[];
  semanticGets: SemanticAccess[];
  semanticMutations: SemanticAccess[];
  predicateCalls: { file: string; name: string; owner: string }[];
} {
  const mutations: MutationSite[] = [];
  const unclassified: string[] = [];
  const transactions: TransactionSite[] = [];
  const opens: OpenSite[] = [];
  const semanticGets: SemanticAccess[] = [];
  const semanticMutations: SemanticAccess[] = [];
  const predicateCalls: { file: string; name: string; owner: string }[] = [];

  const visit = (node: ts.Node, local: Map<string, string[]>): void => {
    if (ts.isForOfStatement(node)) {
      const inner = bindForOf(node, env, local);
      visit(node.expression, local);
      visit(node.initializer, local);
      visit(node.statement, inner);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const inner = pushFunctionLocals(node, env, local);
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }

    if (ts.isCallExpression(node)) {
      const parts = callParts(node);
      const owner = enclosingNamedFunction(node) ?? '<unknown>';
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'isAuthenticProvenEvidenceAbsence' ||
          node.expression.text === 'isAuthenticAcquiredResumeFenceAuthorization')
      ) {
        predicateCalls.push({ file, name: node.expression.text, owner });
      }

      if (parts) {
        if (parts.method === 'open' && isIndexedDbReceiver(parts.receiver)) {
          const resolved = resolveFiniteDomain(node.arguments[0], env, local);
          opens.push({ file, resolved: resolved && resolved.length === 1 ? resolved[0] : undefined });
          if (!resolved || resolved.length !== 1) {
            recordFailure(failures, 'unresolved_open_name', `${file} ${owner}`);
          }
        }

        if (parts.method === 'transaction') {
          const resolved = node.arguments[0] ? resolveFiniteDomain(node.arguments[0], env, local) : undefined;
          transactions.push({ file, resolved });
          if (!resolved) recordFailure(failures, 'unresolved_transaction_domain', `${file} ${owner}`);
        }

        if (MUTATION_METHODS.has(parts.method)) {
          const receiver = unwrapExpr(parts.receiver);
          const weakSetAdd =
            parts.method === 'add' && ts.isIdentifier(receiver) && env.weakSets.has(receiver.text);
          if (weakSetAdd) {
            // Excluded by WeakSet receiver shape, never by source line.
          } else if (parts.method === 'deleteDatabase') {
            if (!isIndexedDbReceiver(parts.receiver)) {
              unclassified.push(`${file}:${owner}:${parts.method}`);
            } else {
              const resolved = node.arguments[0] ? resolveFiniteDomain(node.arguments[0], env, local) : undefined;
              if (!resolved) {
                recordFailure(failures, 'unresolved_mutation_domain', `${file} ${owner} deleteDatabase`);
              } else {
                mutations.push({
                  file,
                  owner,
                  method: 'deleteDatabase',
                  targetDomain: canonicalizeDomain('db', resolved),
                  class: 'database_destructive',
                });
              }
            }
          } else if (parts.method === 'createObjectStore' || parts.method === 'deleteObjectStore') {
            const resolved = node.arguments[0] ? resolveFiniteDomain(node.arguments[0], env, local) : undefined;
            if (!resolved) {
              recordFailure(failures, 'unresolved_mutation_domain', `${file} ${owner} ${parts.method}`);
            } else {
              mutations.push({
                file,
                owner,
                method: parts.method,
                targetDomain: canonicalizeDomain('store', resolved),
                class: 'schema',
              });
            }
          } else if (parts.method === 'createIndex') {
            unclassified.push(`${file}:${owner}:createIndex`);
          } else {
            const objectStoreCall = isObjectStoreCall(parts.receiver);
            let domain: string[] | undefined;
            let mutationClass: MutationClass | undefined;
            if (objectStoreCall) {
              mutationClass = 'raw_seam';
              domain = objectStoreCall.arguments[0]
                ? resolveFiniteDomain(objectStoreCall.arguments[0], env, local)
                : undefined;
            } else if (ts.isIdentifier(unwrapExpr(parts.receiver))) {
              const receiverName = (unwrapExpr(parts.receiver) as ts.Identifier).text;
              if (env.weakSets.has(receiverName)) {
                mutationClass = undefined;
              } else {
                mutationClass = 'semantic';
                domain = node.arguments[0] ? resolveFiniteDomain(node.arguments[0], env, local) : undefined;
              }
            } else {
              unclassified.push(`${file}:${owner}:${parts.method}`);
            }
            if (mutationClass) {
              if (!domain) {
                recordFailure(failures, 'unresolved_mutation_domain', `${file} ${owner} ${parts.method}`);
              } else {
                const site: MutationSite = {
                  file,
                  owner,
                  method: parts.method,
                  targetDomain: canonicalizeDomain('store', domain),
                  class: mutationClass,
                };
                mutations.push(site);
                if (mutationClass === 'semantic') {
                  for (const store of domain) {
                    semanticMutations.push({ file, owner, method: parts.method, store });
                  }
                }
              }
            }
          }
        }

        if (parts.method === 'get' && ts.isIdentifier(unwrapExpr(parts.receiver))) {
          const receiverName = (unwrapExpr(parts.receiver) as ts.Identifier).text;
          if (!env.weakSets.has(receiverName)) {
            const domain = node.arguments[0] ? resolveFiniteDomain(node.arguments[0], env, local) : undefined;
            if (domain) {
              for (const store of domain) {
                semanticGets.push({ file, owner, method: 'get', store });
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, local));
  };

  visit(sf, new Map());
  return { mutations, unclassified, transactions, opens, semanticGets, semanticMutations, predicateCalls };
}

function collectProductionOpens(
  file: string,
  sf: ts.SourceFile,
  env: ModuleEnv,
  failures: string[],
): OpenSite[] {
  const opens: OpenSite[] = [];
  const visit = (node: ts.Node, local: Map<string, string[]>): void => {
    if (ts.isForOfStatement(node)) {
      const inner = bindForOf(node, env, local);
      visit(node.expression, local);
      visit(node.initializer, local);
      visit(node.statement, inner);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const inner = pushFunctionLocals(node, env, local);
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }
    if (ts.isCallExpression(node)) {
      const parts = callParts(node);
      if (parts && parts.method === 'open' && isIndexedDbReceiver(parts.receiver)) {
        const resolved = node.arguments[0] ? resolveFiniteDomain(node.arguments[0], env, local) : undefined;
        opens.push({ file, resolved: resolved && resolved.length === 1 ? resolved[0] : undefined });
        if (!resolved || resolved.length !== 1) {
          recordFailure(failures, 'unresolved_open_name', file);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, local));
  };
  visit(sf, new Map());
  return opens;
}

function collectLiteralConfinement(file: string, sf: ts.SourceFile, failures: string[]): void {
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const owner = ROW29_LITERAL_OWNERS[node.text];
      if (owner && owner !== file) {
        recordFailure(failures, 'literal_confinement', `${file} contains ${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function collectIdentifierHits(file: string, sf: ts.SourceFile, names: Set<string>): { file: string; name: string }[] {
  const hits: { file: string; name: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) hits.push({ file, name: node.text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function inspectViteConfig(text: string, failures: string[]): boolean {
  const sf = parseSource('/vite.config.ts', text);
  let exportedObject: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node, inDefaultCallback: boolean, inNestedFn: boolean): void => {
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isCallExpression(expr) && expr.arguments[0] && (ts.isArrowFunction(expr.arguments[0]) || ts.isFunctionExpression(expr.arguments[0]))) {
        visit(expr.arguments[0], true, false);
        return;
      }
      if (ts.isObjectLiteralExpression(expr)) exportedObject = expr;
    }
    const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
    if (isFn && inDefaultCallback && inNestedFn === false) {
      ts.forEachChild(node, (child) => visit(child, true, false));
      return;
    }
    if (isFn && inDefaultCallback) {
      ts.forEachChild(node, (child) => visit(child, true, true));
      return;
    }
    if (inDefaultCallback && !inNestedFn && ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      exportedObject = node.expression;
    }
    ts.forEachChild(node, (child) => visit(child, inDefaultCallback, inNestedFn || (isFn && !inDefaultCallback)));
  };
  visit(sf, false, false);
  if (!exportedObject) {
    recordFailure(failures, 'alias_config_unverifiable', 'exported vite config object not found');
    return false;
  }
  const inspectObjectBoundary = (
    obj: ts.ObjectLiteralExpression,
    role: 'exported' | 'resolve',
  ): boolean => {
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        recordFailure(
          failures,
          'alias_config_unverifiable',
          role === 'exported' ? 'exported vite config uses spread' : 'vite resolve uses spread',
        );
        return false;
      }
      if (!p.name) {
        recordFailure(failures, 'alias_config_unverifiable', `${role} vite config property name missing`);
        return false;
      }
      const name = staticPropertyNameText(p.name);
      if (name === undefined) {
        recordFailure(
          failures,
          'alias_config_unverifiable',
          role === 'exported'
            ? 'exported vite config has unresolvable computed property'
            : 'vite resolve has unresolvable computed property',
        );
        return false;
      }
      if (role === 'exported' && name === 'resolve') {
        if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) {
          recordFailure(failures, 'alias_config_introduced', 'vite resolve present but unverifiable');
          return false;
        }
        if (!inspectObjectBoundary(p.initializer, 'resolve')) return false;
      }
      if (role === 'resolve' && name === 'alias') {
        recordFailure(failures, 'alias_config_introduced', 'vite resolve.alias present');
        return false;
      }
    }
    return true;
  };

  return inspectObjectBoundary(exportedObject, 'exported');
}

function inspectTsconfigPaths(fileName: string, text: string, failures: string[]): boolean {
  const parsed = ts.parseConfigFileTextToJson(fileName, text);
  if (parsed.error) {
    recordFailure(failures, 'alias_config_unverifiable', `${fileName} parse error`);
    return false;
  }
  const config = parsed.config as { compilerOptions?: { paths?: unknown } } | undefined;
  if (!config || typeof config !== 'object') {
    recordFailure(failures, 'alias_config_unverifiable', `${fileName} missing config object`);
    return false;
  }
  if (config.compilerOptions && Object.prototype.hasOwnProperty.call(config.compilerOptions, 'paths')) {
    recordFailure(failures, 'alias_config_introduced', `${fileName} compilerOptions.paths`);
    return false;
  }
  return true;
}

let cachedAnalysis: Analysis | undefined;

function buildAnalysis(): Analysis {
  const failures: string[] = [];
  const production = new Map<string, string>();
  const test = new Map<string, string>();
  const srcRaw: Record<string, string> = { ...SRC_RAW };
  if (typeof confinementContractRaw === 'string' && srcRaw[CONTRACT_FILE] === undefined) {
    srcRaw[CONTRACT_FILE] = confinementContractRaw;
  }

  for (const [rawKey, text] of Object.entries(srcRaw)) {
    const key = posixNormalize(rawKey);
    if (!key || typeof text !== 'string') {
      recordFailure(failures, 'inventory_key_normalization', rawKey);
      continue;
    }
    if (key.includes('.test.') || key.includes('.spec.')) test.set(key, text);
    else production.set(key, text);
  }

  if (!production.has(CART_FILE) || !production.has(EVIDENCE_FILE) || !production.has(TYPES_FILE)) {
    recordFailure(failures, 'row29_not_in_production', 'missing owner/types module');
  }
  if (!test.has(CONTRACT_FILE)) {
    recordFailure(failures, 'contract_not_in_test', CONTRACT_FILE);
  }

  const inventory = new Set([...production.keys(), ...test.keys()]);
  const row29Keys = [CART_FILE, EVIDENCE_FILE, TYPES_FILE];
  const edgesByFrom = new Map<string, SourceEdge[]>();
  const importers: Record<string, ImporterSets> = {
    [CART_FILE]: { runtime: [], typeOnly: [] },
    [EVIDENCE_FILE]: { runtime: [], typeOnly: [] },
    [TYPES_FILE]: { runtime: [], typeOnly: [] },
  };
  const bareSpecifiers: string[] = [];
  const openSites: OpenSite[] = [];
  const ownerMutationSites: MutationSite[] = [];
  const unclassifiedMutationSites: string[] = [];
  const ownerTransactionSites: TransactionSite[] = [];
  const semanticGets: SemanticAccess[] = [];
  const semanticMutationStores: SemanticAccess[] = [];
  const identifierHitsOutsideIsland: { file: string; name: string }[] = [];
  const predicateCalls: { file: string; name: string; owner: string }[] = [];
  const runtimeExportNames = new Set(FROZEN_ALL_NINE_RUNTIME_EXPORTS);
  const island = new Set([CART_FILE, EVIDENCE_FILE]);

  let cycleRuntime: { symbols: string[]; namespace: boolean } = { symbols: [], namespace: false };
  let cycleEvidenceRuntime: { symbols: string[]; namespace: boolean } = { symbols: [], namespace: false };
  let cartToTypes: string[] = [];
  let evidenceToTypes: string[] = [];
  let productionParseDiagnosticCount = 0;

  for (const [file, text] of production) {
    const sf = parseSource(file, text);
    const parseDiags = sourceFileParseDiagnostics(sf);
    if (parseDiags === undefined) {
      recordFailure(failures, 'production_parse_diagnostic', `${file} parse diagnostics unverifiable`);
      productionParseDiagnosticCount += 1;
      continue;
    }
    productionParseDiagnosticCount += parseDiags.length;
    if (parseDiags.length > 0) {
      for (const d of parseDiags) {
        recordFailure(
          failures,
          'production_parse_diagnostic',
          `${file} code=${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
        );
      }
      continue;
    }
    const env = buildModuleEnv(sf);
    collectContextualParams(sf, env);
    const edges = collectEdgesFromSource(file, sf, inventory, row29Keys, failures);
    edgesByFrom.set(file, edges);
    for (const edge of edges) {
      if (edge.kind === 'bare') bareSpecifiers.push(edge.specifier);
      if ((edge.kind === 'runtime' || edge.kind === 'type-only') && edge.resolved && importers[edge.resolved]) {
        const bucket = edge.typeOnly ? importers[edge.resolved].typeOnly : importers[edge.resolved].runtime;
        if (!bucket.includes(file)) bucket.push(file);
      }
    }
    collectLiteralConfinement(file, sf, failures);
    openSites.push(...collectProductionOpens(file, sf, env, failures));
    if (!island.has(file)) {
      identifierHitsOutsideIsland.push(...collectIdentifierHits(file, sf, runtimeExportNames));
    }
    if (file === CART_FILE || file === EVIDENCE_FILE) {
      const owner = collectOwnerSites(file, sf, env, failures);
      ownerMutationSites.push(...owner.mutations);
      unclassifiedMutationSites.push(...owner.unclassified);
      ownerTransactionSites.push(...owner.transactions);
      semanticGets.push(...owner.semanticGets);
      semanticMutationStores.push(...owner.semanticMutations);
      predicateCalls.push(...owner.predicateCalls);
    }
    if (file === CART_FILE) {
      const runtime = edges.filter((e) => !e.typeOnly && e.resolved === EVIDENCE_FILE);
      cycleRuntime = {
        symbols: runtime.flatMap((e) => e.symbols),
        namespace: runtime.some(
          (e) => e.symbols.includes('*') || e.form === 'namespace-import' || e.form === 'import-equals',
        ),
      };
      cartToTypes = edges.filter((e) => e.typeOnly && e.resolved === TYPES_FILE).flatMap((e) => e.symbols);
    }
    if (file === EVIDENCE_FILE) {
      const runtime = edges.filter((e) => !e.typeOnly && e.resolved === CART_FILE);
      cycleEvidenceRuntime = {
        symbols: runtime.flatMap((e) => e.symbols),
        namespace: runtime.some(
          (e) => e.symbols.includes('*') || e.form === 'namespace-import' || e.form === 'import-equals',
        ),
      };
      evidenceToTypes = edges.filter((e) => e.typeOnly && e.resolved === TYPES_FILE).flatMap((e) => e.symbols);
    }
  }

  for (const key of Object.keys(importers)) {
    importers[key].runtime = uniqueSorted(importers[key].runtime);
    importers[key].typeOnly = uniqueSorted(importers[key].typeOnly);
  }

  for (const spec of uniqueSorted(bareSpecifiers)) {
    if (!FROZEN_BARE_SPECIFIERS.includes(spec)) {
      recordFailure(failures, 'unknown_bare_specifier', spec);
    }
  }

  const configFailures: string[] = [];
  const tsconfigKeys = ['/tsconfig.json', '/tsconfig.app.json', '/tsconfig.node.json'];
  const globVerified =
    tsconfigKeys.every((key) => typeof TSCONFIG_RAW[key] === 'string' && TSCONFIG_RAW[key].length > 0) &&
    typeof VITE_CONFIG_RAW['/vite.config.ts'] === 'string' &&
    VITE_CONFIG_RAW['/vite.config.ts'].length > 0;
  if (!globVerified) {
    recordFailure(configFailures, 'alias_config_unverifiable', 'root config glob empty or incomplete');
    recordFailure(failures, 'alias_config_unverifiable', 'root config glob empty or incomplete');
  }
  let tsconfigPathsAbsent = globVerified;
  if (globVerified) {
    for (const key of tsconfigKeys) {
      if (!inspectTsconfigPaths(key, TSCONFIG_RAW[key], configFailures)) tsconfigPathsAbsent = false;
    }
  }
  const viteResolveAliasAbsent = globVerified ? inspectViteConfig(VITE_CONFIG_RAW['/vite.config.ts'], configFailures) : false;
  failures.push(...configFailures);

  return {
    productionFiles: [...production.keys()].sort(),
    testFiles: [...test.keys()].sort(),
    failures,
    edgesByFrom,
    importers,
    cycleRuntime,
    cycleEvidenceRuntime,
    cartToTypes,
    evidenceToTypes,
    bareSpecifiers: uniqueSorted(bareSpecifiers),
    openSites,
    ownerMutationSites,
    unclassifiedMutationSites,
    ownerTransactionSites,
    semanticGets,
    semanticMutationStores,
    identifierHitsOutsideIsland,
    predicateCalls,
    productionParseDiagnosticCount,
    config: {
      globVerified,
      tsconfigPathsAbsent,
      viteResolveAliasAbsent,
      configFailures,
    },
  };
}

function analysis(): Analysis {
  if (!cachedAnalysis) cachedAnalysis = buildAnalysis();
  return cachedAnalysis;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    req.onblocked = () => resolve();
  });
}

describe('Row32 saleSubmissionWriterConfinement', () => {
  test('inventory partition is fail-closed and self-excluding', () => {
    const a = analysis();
    expect(a.failures.filter((f) => f.startsWith('inventory_key_normalization'))).toEqual([]);
    expect(a.productionFiles).toEqual(expect.arrayContaining([CART_FILE, EVIDENCE_FILE, TYPES_FILE]));
    expect(a.productionFiles.some((f) => f.includes('.test.') || f.includes('.spec.'))).toBe(false);
    expect(a.testFiles).toContain(CONTRACT_FILE);
  });

  test('production TypeScript parse diagnostics fail closed at zero', () => {
    const a = analysis();
    expect(a.productionParseDiagnosticCount).toBe(EXPECTED_PRODUCTION_PARSE_DIAGNOSTIC_COUNT);
    expect(a.failures.filter((f) => f.startsWith('production_parse_diagnostic'))).toEqual([]);
  });

  describe('T1 three-module importer allowlists', () => {
    test('active cart runtime/type-only importers match the frozen allowlists', () => {
      const a = analysis();
      expect(a.importers[CART_FILE].runtime).toEqual(sortedCopy(FROZEN_CART_RUNTIME_IMPORTERS));
      expect(a.importers[CART_FILE].typeOnly).toEqual(sortedCopy(FROZEN_CART_TYPE_ONLY_IMPORTERS));
    });

    test('evidence runtime/type-only importers match the frozen allowlists', () => {
      const a = analysis();
      expect(a.importers[EVIDENCE_FILE].runtime).toEqual(sortedCopy(FROZEN_EVIDENCE_RUNTIME_IMPORTERS));
      expect(a.importers[EVIDENCE_FILE].typeOnly).toEqual(sortedCopy(FROZEN_EVIDENCE_TYPE_ONLY_IMPORTERS));
    });

    test('types module has no runtime importers and only the two owner type-only importers', () => {
      const a = analysis();
      expect(a.importers[TYPES_FILE].runtime).toEqual(sortedCopy(FROZEN_TYPES_RUNTIME_IMPORTERS));
      expect(a.importers[TYPES_FILE].typeOnly).toEqual(sortedCopy(FROZEN_TYPES_TYPE_ONLY_IMPORTERS));
    });

    test('no application-side runtime or type-only importer reaches a Row29 module', () => {
      const a = analysis();
      const allowed = new Set([CART_FILE, EVIDENCE_FILE, TYPES_FILE]);
      for (const target of [CART_FILE, EVIDENCE_FILE, TYPES_FILE]) {
        for (const importer of [...a.importers[target].runtime, ...a.importers[target].typeOnly]) {
          expect(allowed.has(importer), `${importer} imports ${target}`).toBe(true);
        }
      }
    });
  });

  describe('alias / root-config glob policy', () => {
    test('root config glob is verifiable and compilerOptions.paths are absent', () => {
      const a = analysis();
      expect(a.config.globVerified).toBe(true);
      expect(a.config.tsconfigPathsAbsent).toBe(true);
      expect(Object.keys(TSCONFIG_RAW).sort()).toEqual(
        ['/tsconfig.app.json', '/tsconfig.json', '/tsconfig.node.json'].sort(),
      );
    });

    test('vite exported config has no resolve.alias (AST, not text)', () => {
      const a = analysis();
      expect(a.config.viteResolveAliasAbsent).toBe(true);
    });

    test('production bare specifiers equal the frozen allowlist', () => {
      const a = analysis();
      expect(a.bareSpecifiers).toEqual(FROZEN_BARE_SPECIFIERS);
      expect(a.failures.some((f) => f.startsWith('unknown_bare_specifier'))).toBe(false);
      const unknown = a.bareSpecifiers.filter((s) => !FROZEN_BARE_SPECIFIERS.includes(s));
      expect(unknown).toEqual([]);
    });
  });

  describe('T2 DB/store confinement', () => {
    test('repository-wide production indexedDB.open names resolve with the frozen counts', () => {
      const a = analysis();
      expect(a.openSites).toHaveLength(PRODUCTION_INDEXEDDB_OPEN_SITE_COUNT);
      expect(a.openSites.filter((s) => !s.resolved)).toHaveLength(UNRESOLVED_PRODUCTION_INDEXEDDB_OPEN_NAME_COUNT);
      for (const site of a.openSites) {
        if (site.resolved && ROW29_LITERAL_OWNERS[site.resolved]) {
          expect(site.file).toBe(ROW29_LITERAL_OWNERS[site.resolved]);
        }
      }
      for (const pair of FROZEN_ROW29_DB_OPEN_PAIRS) {
        const matching = a.openSites.filter((s) => s.resolved === pair.dbName);
        expect(matching, `required DB name absent or extra: ${pair.dbName}`).toHaveLength(pair.count);
        expect(
          matching.every((s) => s.file === pair.ownerPath),
          `required DB name ${pair.dbName} must be owned only by ${pair.ownerPath}`,
        ).toBe(true);
        expect(matching.filter((s) => s.file !== pair.ownerPath)).toEqual([]);
      }
    });

    test('Row29 owner mutation-site store domains resolve (9/0) and transaction domains resolve (2/0)', () => {
      const a = analysis();
      expect(a.unclassifiedMutationSites).toEqual([]);
      expect(a.ownerMutationSites).toHaveLength(ROW29_MUTATION_SITE_COUNT);
      expect(a.ownerMutationSites.every((s) => s.targetDomain.length > 0)).toBe(true);
      expect(a.ownerTransactionSites).toHaveLength(ROW29_TRANSACTION_SITE_COUNT);
      expect(a.ownerTransactionSites.every((s) => s.resolved && s.resolved.length > 0)).toBe(true);
      const cartTx = a.ownerTransactionSites.find((s) => s.file === CART_FILE);
      const evidenceTx = a.ownerTransactionSites.find((s) => s.file === EVIDENCE_FILE);
      expect(cartTx?.resolved).toEqual([CART_STORE]);
      expect(sortedCopy(evidenceTx?.resolved ?? [])).toEqual([POINTER_STORE, ENTRY_STORE].sort());
    });

    test('ENTRY_STORE raw-seam domain includes entry while semantic mutation count stays zero', () => {
      const a = analysis();
      const rawSeam = a.ownerMutationSites.find(
        (s) => s.file === EVIDENCE_FILE && s.owner === 'transactEvidence' && s.class === 'raw_seam',
      );
      expect(rawSeam?.method).toBe('add');
      expect(rawSeam?.targetDomain).toBe(
        canonicalizeDomain('store', [POINTER_STORE, ENTRY_STORE]),
      );
      const pointerSemantic = a.semanticMutationStores.filter(
        (s) => s.file === EVIDENCE_FILE && s.store === POINTER_STORE,
      );
      const entrySemantic = a.semanticMutationStores.filter(
        (s) => s.file === EVIDENCE_FILE && s.store === ENTRY_STORE,
      );
      const entryReads = a.semanticGets.filter((s) => s.file === EVIDENCE_FILE && s.store === ENTRY_STORE);
      expect(pointerSemantic).toHaveLength(POINTER_STORE_SEMANTIC_MUTATION_INVOCATION_COUNT);
      expect(entrySemantic).toHaveLength(ENTRY_STORE_SEMANTIC_MUTATION_INVOCATION_COUNT);
      expect(entryReads).toHaveLength(ENTRY_STORE_SEMANTIC_READ_INVOCATION_COUNT);
    });

    test('analysis did not fail-closed on specifier/glob/open resolution', () => {
      const a = analysis();
      const blocked = a.failures.filter(
        (f) =>
          f.startsWith('unresolved_') ||
          f.startsWith('unsupported_glob_form') ||
          f.startsWith('nonliteral_') ||
          f.startsWith('literal_confinement') ||
          f.startsWith('alias_config_') ||
          f.startsWith('production_parse_diagnostic'),
      );
      expect(blocked).toEqual([]);
    });
  });

  describe('T7 all-nine runtime-export reachability', () => {
    test('live owner namespaces equal the frozen nine-name set', () => {
      const live = [...Object.keys(cartRuntimeExports), ...Object.keys(evidenceRuntimeExports)].sort();
      expect(Object.keys(cartRuntimeExports).sort()).toEqual(FROZEN_CART_RUNTIME_EXPORTS);
      expect(Object.keys(evidenceRuntimeExports).sort()).toEqual(FROZEN_EVIDENCE_RUNTIME_EXPORTS);
      expect(live).toEqual(FROZEN_ALL_NINE_RUNTIME_EXPORTS);
    });

    test('T7-a: no production application import-graph reachability of the nine', () => {
      const a = analysis();
      expect(a.importers[CART_FILE].runtime).toEqual([EVIDENCE_FILE]);
      expect(a.importers[CART_FILE].typeOnly).toEqual([]);
      expect(a.importers[EVIDENCE_FILE].runtime).toEqual([CART_FILE]);
      expect(a.importers[EVIDENCE_FILE].typeOnly).toEqual([]);
    });

    test('T7-b: identifier-name sweep outside the island is empty (defense in depth only)', () => {
      const a = analysis();
      expect(a.identifierHitsOutsideIsland).toEqual([]);
    });

    test('authenticity predicates retain only the approved internal cycle callers', () => {
      const a = analysis();
      const proofCalls = a.predicateCalls.filter((c) => c.name === 'isAuthenticProvenEvidenceAbsence');
      const authCalls = a.predicateCalls.filter((c) => c.name === 'isAuthenticAcquiredResumeFenceAuthorization');
      expect(proofCalls).toEqual([
        { file: CART_FILE, name: 'isAuthenticProvenEvidenceAbsence', owner: 'releaseSaleSubmissionResumeFence' },
      ]);
      expect(authCalls).toEqual([
        {
          file: CART_FILE,
          name: 'isAuthenticAcquiredResumeFenceAuthorization',
          owner: 'releaseSaleSubmissionResumeFence',
        },
        {
          file: EVIDENCE_FILE,
          name: 'isAuthenticAcquiredResumeFenceAuthorization',
          owner: 'commitSaleSubmissionAbsenceSeal',
        },
      ]);
    });
  });

  describe('T-CYCLE exact runtime/type-only symbol edges', () => {
    test('cart runtime-imports exactly isAuthenticProvenEvidenceAbsence from evidence', () => {
      const a = analysis();
      expect(a.cycleRuntime.namespace).toBe(false);
      expect(sortedCopy(a.cycleRuntime.symbols)).toEqual(FROZEN_CART_TO_EVIDENCE_RUNTIME_SYMBOLS);
    });

    test('evidence runtime-imports exactly isAuthenticAcquiredResumeFenceAuthorization from cart', () => {
      const a = analysis();
      expect(a.cycleEvidenceRuntime.namespace).toBe(false);
      expect(sortedCopy(a.cycleEvidenceRuntime.symbols)).toEqual(FROZEN_EVIDENCE_TO_CART_RUNTIME_SYMBOLS);
    });

    test('type-only edges into saleSubmissionEvidenceTypes.ts match the frozen symbol sets', () => {
      const a = analysis();
      expect(sortedCopy(a.cartToTypes)).toEqual(FROZEN_CART_TO_TYPES_SYMBOLS);
      expect(sortedCopy(a.evidenceToTypes)).toEqual(FROZEN_EVIDENCE_TO_TYPES_SYMBOLS);
    });
  });

  describe('T-W8 exact multiset/cardinality mutation-site confinement', () => {
    test('cart retained sites match frozen sorted [TupleKey, count] pairs, total, and distinct', () => {
      const a = analysis();
      const cartSites = a.ownerMutationSites.filter((s) => s.file === CART_FILE);
      const pairs = sortedMultisetPairs(cartSites);
      expect(pairs).toEqual(FROZEN_CART_W8_PAIRS);
      expect(cartSites).toHaveLength(W8_CART_TOTAL_RETAINED_SITE_COUNT);
      expect(pairs).toHaveLength(W8_CART_DISTINCT_TUPLE_COUNT);
      expect(cartSites.filter((s) => s.method === 'deleteDatabase')).toHaveLength(W8_DELETE_DATABASE_CART_COUNT);
    });

    test('evidence retained sites match frozen sorted [TupleKey, count] pairs, total, and distinct', () => {
      const a = analysis();
      const evidenceSites = a.ownerMutationSites.filter((s) => s.file === EVIDENCE_FILE);
      const pairs = sortedMultisetPairs(evidenceSites);
      expect(pairs).toEqual(FROZEN_EVIDENCE_W8_PAIRS);
      expect(evidenceSites).toHaveLength(W8_EVIDENCE_TOTAL_RETAINED_SITE_COUNT);
      expect(pairs).toHaveLength(W8_EVIDENCE_DISTINCT_TUPLE_COUNT);
      expect(evidenceSites.filter((s) => s.method === 'deleteDatabase')).toHaveLength(
        W8_DELETE_DATABASE_EVIDENCE_COUNT,
      );
    });

    test('no unclassified mutation-shaped receiver remains in the two owners', () => {
      const a = analysis();
      expect(a.unclassifiedMutationSites).toEqual([]);
    });
  });

  describe('T-W5 bootstrap create-only behavioral proof', () => {
    const fixture = {
      branchId: 'BR-TW5',
      deviceId: 'DEV-TW5',
      generationId: 'GEN-TW5-A',
      generationSeq: 7,
      storeEpochId: 'EPOCH-TW5-A',
      asyncOrderId: 'ORD-TW5-A',
      billId: 'BILL-TW5-A',
    };

    beforeEach(async () => {
      await deleteDb(EVIDENCE_DB_NAME);
      await deleteDb(CART_DB_NAME);
    });

    afterEach(async () => {
      await deleteDb(EVIDENCE_DB_NAME);
      await deleteDb(CART_DB_NAME);
    });

    test('reinitialize after a held fence returns {ok:false} and leaves durable state unchanged', async () => {
      const init = await initializeActiveCartSaleSubmission({ ...fixture });
      expect(init).toEqual({ ok: true });

      const acquired = await acquireSaleSubmissionResumeFence({
        branchId: fixture.branchId,
        deviceId: fixture.deviceId,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) throw new Error('acquire failed');

      const heldRecord = await readActiveCartSnapshot(fixture.branchId, fixture.deviceId);
      expect(heldRecord?.resumeFence.held).toBe(true);

      const beforeDump = await readActiveCartDurableDump();
      const beforeRecord = await readActiveCartSnapshot(fixture.branchId, fixture.deviceId);
      const before = {
        dump: stableSerialize(beforeDump),
        record: stableSerialize(beforeRecord),
        keys: beforeDump.keys.slice(),
        held: beforeRecord?.resumeFence.held,
        fenceSeq: beforeRecord?.resumeFence.fenceSeq,
        fenceNonce: beforeRecord?.resumeFence.fenceNonce,
        resumeAttempts: beforeRecord?.resumeAttempts,
        branchId: beforeRecord?.branchId,
        deviceId: beforeRecord?.deviceId,
        generationId: beforeRecord?.generationId,
        generationSeq: beforeRecord?.generationSeq,
        storeEpochId: beforeRecord?.storeEpochId,
        asyncOrderId: beforeRecord?.asyncOrderId,
        billId: beforeRecord?.billId,
      };

      const again = await initializeActiveCartSaleSubmission({
        branchId: fixture.branchId,
        deviceId: fixture.deviceId,
        generationId: 'GEN-TW5-B',
        generationSeq: fixture.generationSeq + 1,
        storeEpochId: 'EPOCH-TW5-B',
        asyncOrderId: 'ORD-TW5-B',
        billId: 'BILL-TW5-B',
      });
      expect(again).toEqual({ ok: false });

      const afterDump = await readActiveCartDurableDump();
      const afterRecord = await readActiveCartSnapshot(fixture.branchId, fixture.deviceId);
      expect(stableSerialize(afterDump)).toBe(before.dump);
      expect(stableSerialize(afterRecord)).toBe(before.record);
      expect(afterDump.keys).toEqual(before.keys);
      expect(afterRecord?.resumeFence.held).toBe(true);
      expect(afterRecord?.resumeFence.held).toBe(before.held);
      expect(afterRecord?.resumeFence.fenceSeq).toBe(before.fenceSeq);
      expect(afterRecord?.resumeFence.fenceNonce).toBe(before.fenceNonce);
      expect(afterRecord?.resumeAttempts).toBe(before.resumeAttempts);
      expect(afterRecord?.branchId).toBe(before.branchId);
      expect(afterRecord?.deviceId).toBe(before.deviceId);
      expect(afterRecord?.generationId).toBe(before.generationId);
      expect(afterRecord?.generationSeq).toBe(before.generationSeq);
      expect(afterRecord?.storeEpochId).toBe(before.storeEpochId);
      expect(afterRecord?.asyncOrderId).toBe(before.asyncOrderId);
      expect(afterRecord?.billId).toBe(before.billId);
    });
  });
});
