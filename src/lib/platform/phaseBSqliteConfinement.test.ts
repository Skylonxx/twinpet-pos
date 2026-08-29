import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = resolve(process.cwd());
const PHASE_B_COMMANDS = [
  'durable_kv_txn_begin',
  'durable_kv_txn_get',
  'durable_kv_txn_get_all',
  'durable_kv_txn_get_all_keys',
  'durable_kv_txn_put',
  'durable_kv_txn_delete',
  'durable_kv_txn_commit',
  'durable_kv_txn_abort',
  'durable_manifest_get',
  'durable_manifest_put_epoch',
  'durable_manifest_lease_acquire',
  'durable_manifest_lease_heartbeat',
  'durable_manifest_lease_release',
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
  return files
    .map((abs) => ({ file: toSrcKey(abs), text: readFileSync(abs, 'utf8') }))
    .filter((e) => !isTestPath(e.file));
}

describe('Phase B SQLite confinement', () => {
  test('D6-2: production window.__TAURI__ is confined to the Tauri adapter', () => {
    const hits = productionEntries().filter((e) => e.text.includes('window.__TAURI__') || e.text.includes('__TAURI__'));
    expect(hits.every((h) => h.file.startsWith('/src/lib/platform/adapters/tauri/'))).toBe(true);
    expect(hits.some((h) => h.file === '/src/lib/platform/adapters/tauri/tauriDurableStorePort.ts')).toBe(true);
  });

  test('D6-2: exactly 13 custom commands, rusqlite bundled, no plugin-sql', () => {
    const cargo = readFileSync(resolve(ROOT, 'src-tauri/Cargo.toml'), 'utf8');
    expect(cargo).toContain('rusqlite');
    expect(cargo).toContain('bundled');
    expect(cargo).not.toContain('tauri-plugin-');
    const lib = readFileSync(resolve(ROOT, 'src-tauri/src/lib.rs'), 'utf8');
    for (const cmd of PHASE_B_COMMANDS) {
      expect(lib).toContain(`durable_kv::${cmd}`);
    }
    expect(lib.match(/durable_kv::durable_/g)?.length).toBe(13);
    const cap = JSON.parse(readFileSync(resolve(ROOT, 'src-tauri/capabilities/default.json'), 'utf8')) as {
      permissions: string[];
    };
    expect(cap.permissions[0]).toBe('core:default');
    expect(cap.permissions).toHaveLength(14);
    expect(cap.permissions.some((p) => p.includes('sql'))).toBe(false);
    expect(cap.permissions.some((p) => p.startsWith('fs:'))).toBe(false);
    expect(cap.permissions.some((p) => p.startsWith('shell:'))).toBe(false);
  });

  test('D6-1: native committed path does not open Twinpet-domain IndexedDB', () => {
    const boot = readFileSync(resolve(ROOT, 'src/lib/platform/durableStore/bootDurableStore.ts'), 'utf8');
    expect(boot).not.toContain('indexedDB.open');
    expect(boot).toContain('isDurableStartupBlocked');
    expect(boot).toContain('bootFatal');
    const reversal = readFileSync(resolve(ROOT, 'src/lib/pos/offline/reversalLocalStore.ts'), 'utf8');
    expect(reversal).toContain("getCommittedDurableStore('twinpet-offline-reversal')");
    expect(reversal).toContain('indexedDB.open');
    const device = readFileSync(resolve(ROOT, 'src/lib/pos/deviceId.ts'), 'utf8');
    expect(device).toContain("getCommittedDurableStore('twinpet-device')");
    expect(device).toContain('isNativeCommittedDurableStore()');
    const main = readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8');
    expect(main).toContain('isDurableStartupBlocked');
    expect(main).toContain('renderStartupFailure');
    expect(main).not.toContain('.finally(renderApp)');
  });

  test('withGlobalTauri is enabled and no generic SQL surface is exposed', () => {
    const conf = JSON.parse(readFileSync(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')) as {
      app?: { withGlobalTauri?: boolean };
    };
    expect(conf.app?.withGlobalTauri).toBe(true);
    const adapter = readFileSync(
      resolve(ROOT, 'src/lib/platform/adapters/tauri/tauriDurableStorePort.ts'),
      'utf8',
    );
    expect(adapter).not.toContain('execute(');
    expect(adapter).not.toContain('SELECT ');
  });
});
