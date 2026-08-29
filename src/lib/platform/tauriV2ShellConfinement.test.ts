/**
 * Phase C Tauri v2 desktop-shell confinement.
 *
 * Independent inventory of production src/, package JSON, and native scaffold.
 * Does not import or amend closed Row29 / Row32 owner tests.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = resolve(process.cwd());

const FROZEN_INDEXEDDB_OPEN_SITE_COUNT = 8;
const APP_SHELL = '/src/components/AppShell.tsx';
const APP = '/src/App.tsx';
const WRITER_CONFINEMENT = '/src/lib/pos/offline/saleSubmissionWriterConfinement.test.ts';
const SYNC_CENTER_CONFINEMENT = '/src/lib/pos/offline/syncCenterClosedGateConfinement.test.ts';

const FORBIDDEN_CAPABILITY_TOKENS = [
  'fs:',
  'shell:',
  'sql',
  'http:',
  'process:',
  'store:',
  'updater:',
  'dialog:',
  'clipboard:',
  'deep-link',
  'printer',
  'scanner',
] as const;

const FORBIDDEN_CARGO_TOKENS = [
  'tauri-plugin-',
  'tauri-plugin-sql',
  'tauri-plugin-fs',
  'tauri-plugin-shell',
  'tauri-plugin-http',
  'tauri-plugin-process',
  'tauri-plugin-updater',
  'tauri-plugin-store',
  'sqlx',
] as const;

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

function readRepoFile(posixPath: string): string {
  return readFileSync(resolve(ROOT, posixPath.slice(1)), 'utf8');
}

function parseJsonFile(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8'));
}

function extractQuotedArray(source: string, constName: string): string[] {
  const marker = `const ${constName} = [`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${constName}`);
  const open = source.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unclosed ${constName}`);
  const body = source.slice(open, end + 1);
  const values: string[] = [];
  const re = /'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) values.push(match[1]);
  return values;
}

function extractNumericConst(source: string, constName: string): number {
  const re = new RegExp(`const ${constName} = (\\d+);`);
  const match = source.match(re);
  if (!match) throw new Error(`missing numeric ${constName}`);
  return Number(match[1]);
}

function trackedNativeGenerated(): string[] {
  const out = execSync('git ls-files -- src-tauri/target src-tauri/gen', {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('Phase C Tauri v2 shell confinement', () => {
  test('production src has no Tauri/Electron/Capacitor import and no Tauri bridge', () => {
    for (const { file, text } of productionEntries()) {
      for (const spec of collectSpecifiers(text)) {
        expect(spec.startsWith('@tauri-apps'), `${file} ${spec}`).toBe(false);
        expect(spec === 'electron' || spec.startsWith('electron/'), `${file} ${spec}`).toBe(false);
        expect(spec.startsWith('@capacitor/') || spec.startsWith('@capacitor-community/'), `${file} ${spec}`).toBe(
          false,
        );
      }
      expect(text, file).not.toMatch(/from\s+['"]@tauri-apps/);
      expect(text, file).not.toMatch(/from\s+['"]electron['"]/);
      expect(text, file).not.toMatch(/from\s+['"]@capacitor/);
      if (!file.startsWith('/src/lib/platform/adapters/tauri/')) {
        expect(text, file).not.toContain('window.__TAURI__');
        expect(text, file).not.toContain('__TAURI__');
      }
      expect(text, file).not.toContain('__TAURI_INTERNALS__');
    }
  });

  test('package.json records exact CLI v2 as the only Tauri package, script exact', () => {
    const pkg = parseJsonFile('package.json') as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    const dev = pkg.devDependencies ?? {};
    expect(deps['@tauri-apps/cli']).toBeUndefined();
    expect(dev['@tauri-apps/cli']).toMatch(/^2\.\d+\.\d+$/);
    expect(dev['@tauri-apps/cli']).not.toMatch(/[\^~*]/);
    expect(deps['@tauri-apps/api']).toBeUndefined();
    expect(dev['@tauri-apps/api']).toBeUndefined();
    const tauriNames = [...Object.keys(deps), ...Object.keys(dev)].filter(
      (name) => name.startsWith('@tauri-apps/') || name === 'tauri',
    );
    expect(tauriNames).toEqual(['@tauri-apps/cli']);
    expect(tauriNames.some((name) => name.includes('plugin'))).toBe(false);
    expect(pkg.scripts?.tauri).toBe('tauri');
  });

  test('root tsconfig set is unchanged and Vite has no alias', () => {
    const names = readdirSync(ROOT)
      .filter((n) => n.startsWith('tsconfig') && n.endsWith('.json'))
      .sort();
    expect(names).toEqual(['tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json']);
    for (const name of names) {
      expect(readRepoFile(`/${name}`), name).not.toMatch(/"paths"\s*:/);
    }
    const viteText = readRepoFile('/vite.config.ts');
    expect(viteText).not.toMatch(/resolve\s*:\s*\{[^}]*alias/s);
    expect(viteText).not.toContain('alias:');
  });

  test('production indexedDB.open count remains the frozen 8 and bare specifiers stay frozen', () => {
    const opens: string[] = [];
    const bare = new Set<string>();
    for (const { file, text } of productionEntries()) {
      const matches = text.match(/indexedDB\.open\s*\(/g);
      if (matches) {
        for (let i = 0; i < matches.length; i += 1) opens.push(file);
      }
      for (const spec of collectSpecifiers(text)) {
        if (spec.startsWith('.') || spec.startsWith('/')) continue;
        bare.add(spec);
      }
    }
    const writer = readRepoFile(WRITER_CONFINEMENT);
    const syncCenter = readRepoFile(SYNC_CENTER_CONFINEMENT);
    expect(extractNumericConst(writer, 'PRODUCTION_INDEXEDDB_OPEN_SITE_COUNT')).toBe(
      FROZEN_INDEXEDDB_OPEN_SITE_COUNT,
    );
    expect(syncCenter).toContain('production indexedDB.open site count remains 8');
    expect(opens).toHaveLength(FROZEN_INDEXEDDB_OPEN_SITE_COUNT);

    const frozenBare = extractQuotedArray(writer, 'FROZEN_BARE_SPECIFIERS');
    expect(frozenBare).toEqual([
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
    expect(frozenBare.some((s) => s.startsWith('@tauri-apps'))).toBe(false);
    for (const spec of bare) {
      expect(frozenBare.includes(spec), spec).toBe(true);
    }
  });

  test('BrowserRouter and AppShell connectivity seam are retained', () => {
    const app = readRepoFile(APP);
    const shell = readRepoFile(APP_SHELL);
    expect(app).toMatch(/import\s*\{[^}]*BrowserRouter[^}]*\}\s*from\s*['"]react-router-dom['"]/);
    expect(app).toContain('<BrowserRouter>');
    expect(app).not.toContain('HashRouter');
    expect(shell).toContain('useSyncOrchestrator(createBrowserSyncOrchestratorDeps())');
    expect(shell).toContain("from '../lib/platform/adapters/browser/browserConnectivityPort'");
  });

  test('tauri.conf.json is the authorized compatibility shell with denial-first CSP', () => {
    const conf = parseJsonFile('src-tauri/tauri.conf.json') as {
      productName?: string;
      identifier?: string;
      version?: string;
      build?: {
        frontendDist?: string;
        devUrl?: string;
        beforeDevCommand?: string;
        beforeBuildCommand?: string;
      };
      app?: { security?: { csp?: unknown; dangerousDisableAssetCspModification?: unknown }; withGlobalTauri?: boolean };
    };
    expect(conf.productName).toBe('Twinpet POS');
    expect(conf.identifier).toBe('com.twinpet.pos');
    expect(conf.version).toBe('0.0.0');
    expect(conf.build?.devUrl).toBe('http://localhost:5173');
    expect(conf.build?.frontendDist).toBe('../dist');
    expect(conf.build?.beforeDevCommand).toBe('npm run dev:web');
    expect(conf.build?.beforeBuildCommand).toBe('npm run build');
    expect(typeof conf.app?.security?.csp).toBe('string');
    expect(conf.app?.security?.csp).not.toBe('');
    expect(conf.app?.security?.csp).not.toBeNull();
    const csp = String(conf.app?.security?.csp);
    expect(csp.includes('*')).toBe(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/connect-src\s+\*/);
    expect(csp).not.toContain('run.app');
    const connectSrcMatch = csp.match(/connect-src\s+([^;]+)/);
    expect(connectSrcMatch).not.toBeNull();
    const connectSrc = String(connectSrcMatch?.[1]);
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain('https://firestore.googleapis.com');
    expect(connectSrc).toContain('wss://firestore.googleapis.com');
    expect(connectSrc).toContain('https://identitytoolkit.googleapis.com');
    expect(connectSrc).toContain('https://securetoken.googleapis.com');
    expect(connectSrc).toContain('https://firebase.googleapis.com');
    expect(connectSrc).toContain('https://firebaseinstallations.googleapis.com');
    expect(connectSrc).toContain('https://firebasestorage.googleapis.com');
    expect(connectSrc).toContain('https://www.googleapis.com');
    expect(connectSrc).toContain('https://asia-southeast1-twinpet-pos-uat.cloudfunctions.net');
    expect(connectSrc).toContain('https://asia-southeast1-twinpet-pos.cloudfunctions.net');
    expect(connectSrc).not.toContain('https://*.cloudfunctions.net');
    expect(connectSrc.includes('*')).toBe(false);
    expect(conf.app?.security?.dangerousDisableAssetCspModification).toBeUndefined();
    expect(conf.app?.withGlobalTauri).toBe(true);
  });

  test('capabilities remain core plus exact 13 durable-store app permissions and Cargo has rusqlite without plugins', () => {
    const capDir = resolve(ROOT, 'src-tauri/capabilities');
    const capFiles = readdirSync(capDir).filter((n) => n.endsWith('.json')).sort();
    expect(capFiles).toEqual(['default.json']);
    const cap = parseJsonFile('src-tauri/capabilities/default.json') as {
      windows?: string[];
      permissions?: unknown[];
    };
    expect(cap.windows).toEqual(['main']);
    expect(cap.permissions).toEqual([
      'core:default',
      'allow-durable-kv-txn-begin',
      'allow-durable-kv-txn-get',
      'allow-durable-kv-txn-get-all',
      'allow-durable-kv-txn-get-all-keys',
      'allow-durable-kv-txn-put',
      'allow-durable-kv-txn-delete',
      'allow-durable-kv-txn-commit',
      'allow-durable-kv-txn-abort',
      'allow-durable-manifest-get',
      'allow-durable-manifest-put-epoch',
      'allow-durable-manifest-lease-acquire',
      'allow-durable-manifest-lease-heartbeat',
      'allow-durable-manifest-lease-release',
    ]);
    const capText = readRepoFile('/src-tauri/capabilities/default.json');
    for (const token of FORBIDDEN_CAPABILITY_TOKENS) {
      if (token === 'sql') {
        expect(capText.includes('sql')).toBe(false);
        continue;
      }
      expect(capText.includes(token), token).toBe(false);
    }

    const cargo = readRepoFile('/src-tauri/Cargo.toml');
    for (const token of FORBIDDEN_CARGO_TOKENS) {
      expect(cargo.includes(token), token).toBe(false);
    }
    expect(cargo).toContain('tauri =');
    expect(cargo).toContain('tauri-build');
    expect(cargo).toContain('rusqlite');
    expect(cargo).toContain('bundled');

    const mainRs = readRepoFile('/src-tauri/src/main.rs');
    const libRs = readRepoFile('/src-tauri/src/lib.rs');
    expect(mainRs).not.toContain('#[tauri::command]');
    expect(libRs).toContain('invoke_handler');
    expect(libRs).toContain('generate_handler');
  });

  test('generated target/gen output is ignored and not present as tracked source', () => {
    const rootIgnore = readRepoFile('/.gitignore');
    const nativeIgnore = readRepoFile('/src-tauri/.gitignore');
    expect(rootIgnore).toContain('src-tauri/target/');
    expect(rootIgnore).toContain('src-tauri/gen/');
    expect(nativeIgnore).toContain('/target/');
    expect(nativeIgnore).toContain('/gen/schemas');

    expect(trackedNativeGenerated()).toEqual([]);
  });
});
