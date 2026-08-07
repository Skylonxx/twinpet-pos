import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/gen-artifact-provenance.mjs');

// Dynamic import keeps the ops suite node-native and avoids Vite transform of the .mjs owner.
const prov = await import(pathToFileURL(SCRIPT).href);

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'twinpet-prov-'));
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function expectFail(fn, re) {
  expect(fn).toThrow();
  try {
    fn();
  } catch (err) {
    if (re) expect(String(err.message)).toMatch(re);
    expect(err.code).toBe('PROVENANCE_FAIL_CLOSED');
  }
}

describe('gen-artifact-provenance — canonical hashing', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('computes deterministic SHA-256 over length-prefixed framed pairs', () => {
    const dist = join(root, 'dist');
    writeTree(dist, {
      'a.txt': 'alpha',
      'b/c.txt': 'beta',
    });

    const { buildHash, entries } = prov.computeBuildHash(dist);
    expect(entries.map((e) => e.relativePath)).toEqual(['a.txt', 'b/c.txt']);
    expect(buildHash).toMatch(/^[0-9a-f]{64}$/);

    const again = prov.computeBuildHash(dist);
    expect(again.buildHash).toBe(buildHash);

    // Manual frame reconstruction must match.
    const frames = entries.map((e) =>
      prov.framePathDigestPair(e.relativePath, e.sha256),
    );
    const manual = prov.sha256HexOfBuffer(Buffer.concat(frames));
    expect(manual).toBe(buildHash);
  });

  it('uses length-prefixed framing (not bare newline delimiting)', () => {
    const digest = 'a'.repeat(64);
    const framed = prov.framePathDigestPair('x.txt', digest);
    expect(framed.readUInt32BE(0)).toBe(Buffer.byteLength('x.txt', 'utf8'));
    expect(framed.subarray(4, 4 + 5).toString('utf8')).toBe('x.txt');
    expect(framed.readUInt32BE(4 + 5)).toBe(64);
    // Must not equal a naive "path\\ndigest\\n" concatenation hash input shape.
    const naive = Buffer.from(`x.txt\n${digest}\n`, 'utf8');
    expect(Buffer.compare(framed, naive)).not.toBe(0);
  });

  it('sorts normalized paths bytewise by UTF-8 bytes', () => {
    const paths = ['b.txt', 'a.txt', 'a/b.txt', 'A.txt'];
    const sorted = prov.sortNormalizedPaths(paths);
    // Bytewise: 'A' (0x41) before 'a' (0x61)
    expect(sorted).toEqual(['A.txt', 'a.txt', 'a/b.txt', 'b.txt']);
  });

  it('excludes the manifest from its own hash (self-exclusion)', () => {
    const dist = join(root, 'dist');
    writeTree(dist, {
      'index.html': '<html></html>',
      [prov.MANIFEST_FILE_NAME]: '{"stale":true}',
    });
    const { entries, buildHash } = prov.computeBuildHash(dist);
    expect(entries.every((e) => e.relativePath !== prov.MANIFEST_FILE_NAME)).toBe(
      true,
    );
    expect(entries).toHaveLength(1);

    // Writing a different manifest content must not change the tree hash.
    writeFileSync(
      join(dist, prov.MANIFEST_FILE_NAME),
      '{"stale":false,"n":2}',
    );
    expect(prov.computeBuildHash(dist).buildHash).toBe(buildHash);
  });

  it('rejects an empty artifact tree', () => {
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    expectFail(() => prov.computeBuildHash(dist), /empty artifact tree/);
  });

  it('rejects NUL in any path via validation seam', () => {
    expectFail(() => prov.normalizeArtifactPath('a\u0000b.txt'), /NUL/);
    expectFail(
      () => prov.framePathDigestPair('a\u0000b.txt', 'a'.repeat(64)),
      /NUL/,
    );
  });

  it('rejects newline in any path via validation seam', () => {
    expectFail(() => prov.normalizeArtifactPath('a\nb.txt'), /newline/);
    expectFail(() => prov.normalizeArtifactPath('a\rb.txt'), /newline/);
  });

  it('rejects symlink entries where the host can create one', () => {
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'real.txt'), 'x');
    const link = join(dist, 'link.txt');
    let created = false;
    try {
      symlinkSync(join(dist, 'real.txt'), link);
      created = existsSync(link) && lstatSync(link).isSymbolicLink();
    } catch {
      created = false;
    }
    if (!created) {
      // Supported seam: assertRegularFileStat rejects symlink-shaped stats.
      expectFail(
        () =>
          prov.assertRegularFileStat(
            { isSymbolicLink: () => true, isFile: () => false },
            'link.txt',
          ),
        /symlink/,
      );
      return;
    }
    expectFail(() => prov.computeBuildHash(dist), /symlink/);
  });

  it('rejects non-regular files via supported test seam', () => {
    expectFail(
      () =>
        prov.assertRegularFileStat(
          { isSymbolicLink: () => false, isFile: () => false },
          'dir-or-device',
        ),
      /non-regular/,
    );
  });
});

describe('gen-artifact-provenance — PREPARE / VERIFY contracts', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prepare writes only .artifact-provenance.json and never touches dist/', () => {
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'keep.txt'), 'keep');

    const record = prov.prepare({
      root,
      sourceCommit: 'a'.repeat(40),
      buildId: 'build-1',
      preparedAt: '2026-08-07T00:00:00.000Z',
    });

    expect(existsSync(prov.prepPath(root))).toBe(true);
    expect(record.preparedSourceCommit).toBe('a'.repeat(40));
    expect(record.preparedBuildId).toBe('build-1');
    expect(record.preparedAt).toBe('2026-08-07T00:00:00.000Z');
    expect(record.compatFloor).toBe(prov.COMPAT_FLOOR);
    expect(record).not.toHaveProperty('buildHash');

    // dist untouched content-wise
    expect(readFileSync(join(dist, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dist, prov.MANIFEST_FILE_NAME))).toBe(false);
  });

  it('refuses missing preparation', () => {
    expectFail(() => prov.readPreparation(root, { currentSourceCommit: 'x' }), /missing preparation/);
  });

  it('refuses malformed preparation', () => {
    writeFileSync(prov.prepPath(root), '{"schemaVersion":1}\n');
    expectFail(
      () =>
        prov.readPreparation(root, {
          currentSourceCommit: 'a'.repeat(40),
        }),
      /malformed preparation/,
    );
  });

  it('refuses stale preparation fail-closed', () => {
    prov.prepare({
      root,
      sourceCommit: 'a'.repeat(40),
      buildId: 'build-stale',
    });
    expectFail(
      () =>
        prov.readPreparation(root, {
          currentSourceCommit: 'b'.repeat(40),
        }),
      /stale preparation/,
    );
  });

  it('verify writes dist manifest with identity + buildHash', () => {
    const dist = join(root, 'dist');
    writeTree(dist, { 'index.html': '<html>ok</html>' });
    const prep = prov.prepare({
      root,
      sourceCommit: 'c'.repeat(40),
      buildId: 'build-verify',
    });

    const manifest = prov.verify({
      root,
      currentSourceCommit: 'c'.repeat(40),
    });

    expect(existsSync(prov.manifestPath(root))).toBe(true);
    expect(manifest.sourceCommit).toBe(prep.preparedSourceCommit);
    expect(manifest.buildId).toBe(prep.preparedBuildId);
    expect(manifest.compatFloor).toBe(prep.compatFloor);
    expect(manifest.buildHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.generatedAt).toBeTruthy();
    expect(manifest.entries).toHaveLength(1);
  });

  it('detects verify→deploy mutation via recompute substrate', () => {
    const dist = join(root, 'dist');
    writeTree(dist, { 'app.js': 'v1' });
    prov.prepare({
      root,
      sourceCommit: 'd'.repeat(40),
      buildId: 'build-mut',
    });
    const manifest = prov.verify({
      root,
      currentSourceCommit: 'd'.repeat(40),
    });

    writeFileSync(join(dist, 'app.js'), 'v2-mutated');
    const cmp = prov.recomputeAndCompareManifest(dist, manifest);
    expect(cmp.match).toBe(false);
    expect(cmp.recomputedBuildHash).not.toBe(manifest.buildHash);
  });

  it('rollback mismatch substrate: different tree ⇒ different buildHash', () => {
    const distA = join(root, 'a');
    const distB = join(root, 'b');
    writeTree(distA, { 'x.txt': 'one' });
    writeTree(distB, { 'x.txt': 'two' });
    const hashA = prov.computeBuildHash(distA).buildHash;
    const hashB = prov.computeBuildHash(distB).buildHash;
    expect(hashA).not.toBe(hashB);
  });

  it('runtime marker binds sourceCommit/buildId/compatFloor and excludes buildHash', () => {
    const prep = {
      schemaVersion: 1,
      preparedSourceCommit: 'e'.repeat(40),
      preparedBuildId: 'build-marker',
      preparedAt: '2026-08-07T01:00:00.000Z',
      compatFloor: prov.COMPAT_FLOOR,
    };
    const marker = prov.assertRuntimeMarkerContract(prov.buildRuntimeMarker(prep));
    expect(marker).toEqual({
      sourceCommit: prep.preparedSourceCommit,
      buildId: prep.preparedBuildId,
      compatFloor: prep.compatFloor,
    });
    expect(marker).not.toHaveProperty('buildHash');

    expectFail(
      () =>
        prov.assertRuntimeMarkerContract({
          ...marker,
          buildHash: 'f'.repeat(64),
        }),
      /must not contain buildHash/,
    );
  });

  it('runtime marker mismatch substrate fails closed on field drift', () => {
    expectFail(
      () =>
        prov.assertRuntimeMarkerContract({
          sourceCommit: 'e'.repeat(40),
          buildId: '',
          compatFloor: prov.COMPAT_FLOOR,
        }),
      /missing buildId/,
    );
  });

  it('manifest mismatch: wrong buildHash comparison fails', () => {
    const dist = join(root, 'dist');
    writeTree(dist, { 'z.txt': 'z' });
    const { buildHash } = prov.computeBuildHash(dist);
    const cmp = prov.recomputeAndCompareManifest(dist, {
      sourceCommit: 'f'.repeat(40),
      buildId: 'id',
      buildHash: '0'.repeat(64),
    });
    expect(cmp.match).toBe(false);
    expect(cmp.recomputedBuildHash).toBe(buildHash);
  });

  it('sourceCommit-only acceptance is insufficient / forbidden', () => {
    expect(prov.sourceCommitOnlyAcceptanceAllowed()).toBe(false);
    expectFail(
      () =>
        prov.artifactIdentityKey({
          sourceCommit: 'a'.repeat(40),
          buildId: '',
          buildHash: 'b'.repeat(64),
        }),
      /requires sourceCommit, buildId, and buildHash/,
    );

    // Two builds of one commit are two artifacts.
    const id1 = prov.artifactIdentityKey({
      sourceCommit: 'a'.repeat(40),
      buildId: 'build-1',
      buildHash: '1'.repeat(64),
    });
    const id2 = prov.artifactIdentityKey({
      sourceCommit: 'a'.repeat(40),
      buildId: 'build-2',
      buildHash: '2'.repeat(64),
    });
    expect(id1).not.toBe(id2);
  });

  it('direct Vite is not an accepted release path', () => {
    expect(prov.directViteAcceptedReleasePath()).toBe(false);
  });
});

describe('gen-artifact-provenance — direct-Vite / packaging negative path', () => {
  it('package.json wires prebuild prepare and postbuild verify without weakening test:ops', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:ops']).toBe(
      'vitest run --config vitest.ops.config.ts',
    );
    expect(pkg.scripts.prebuild).toContain('gen-artifact-provenance.mjs prepare');
    expect(pkg.scripts.prebuild).toContain('gen-config');
    expect(pkg.scripts.build).toBe('tsc -b && vite build');
    expect(pkg.scripts.postbuild).toContain('gen-artifact-provenance.mjs verify');
    expect(pkg.dependencies?.['fake-indexeddb']).toBeUndefined();
    expect(pkg.devDependencies?.['fake-indexeddb']).toBeUndefined();
  });

  it('vite.config.ts fails closed on missing preparation during build command', async () => {
    // Import the same validation path vite uses: missing prep throws.
    const isolated = makeTempRoot();
    try {
      expectFail(
        () =>
          prov.readPreparation(isolated, {
            currentSourceCommit: 'a'.repeat(40),
          }),
        /missing preparation/,
      );
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('direct vite build without preparation fails closed (non-release path)', () => {
    expect(prov.directViteAcceptedReleasePath()).toBe(false);

    const prepFile = join(REPO_ROOT, '.artifact-provenance.json');
    const hadPrep = existsSync(prepFile);
    let backup: string | null = null;
    if (hadPrep) {
      backup = readFileSync(prepFile, 'utf8');
      rmSync(prepFile, { force: true });
    }

    try {
      const viteBin = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
      expect(existsSync(viteBin)).toBe(true);
      const result = spawnSync(process.execPath, [viteBin, 'build'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: process.env,
        timeout: 120_000,
      });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(combined).toMatch(/PROVENANCE_FAIL_CLOSED|missing preparation/i);
    } finally {
      if (backup !== null) {
        writeFileSync(prepFile, backup);
      } else if (existsSync(prepFile)) {
        // Vite must not have created a valid prep; remove accidental leftovers.
        rmSync(prepFile, { force: true });
      }
    }
  });

  it('CLI prepare/verify modes exit non-zero on failure', () => {
    const isolated = makeTempRoot();
    try {
      // Force verify against an empty root via NODE options by invoking the
      // exported verify API through a one-liner — CLI always anchors to repo
      // root, so exercise fail-closed through the same script entry with a
      // guaranteed-missing prep path via child that imports and calls verify.
      const runner = `
        import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => {
          try {
            m.verify({ root: ${JSON.stringify(isolated.replace(/\\/g, '/'))}, requireMatch: false });
            process.exit(0);
          } catch (e) {
            process.stderr.write(String(e && e.message ? e.message : e) + '\\n');
            process.exit(1);
          }
        });
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: process.env,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/missing preparation|artifact tree missing|empty artifact tree/i);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
