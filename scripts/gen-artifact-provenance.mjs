#!/usr/bin/env node
/**
 * Twinpet artifact provenance — PREPARE / VERIFY owners for the accepted
 * PREPARE -> BUILD -> VERIFY release pipeline (SELECT/DEPLOY remain Owner gates).
 *
 * Modes:
 *   prepare  — write .artifact-provenance.json only (no dist/ touch)
 *   verify   — hash dist/**, write dist/twinpet-artifact-manifest.json
 *
 * Canonical hashing (R6 §18.2):
 *   enumerate regular files under dist/; exclude the manifest from its own hash;
 *   normalize paths to "/"; sort by UTF-8 bytes; length-prefixed (path, digest)
 *   framing; reject symlink / non-regular / empty / NUL / newline; SHA-256 hex.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const SCHEMA_VERSION = 1;
export const COMPAT_FLOOR = 'OBS-B0';
export const PREP_FILE_NAME = '.artifact-provenance.json';
export const MANIFEST_FILE_NAME = 'twinpet-artifact-manifest.json';
export const MANIFEST_RELATIVE_PATH = `dist/${MANIFEST_FILE_NAME}`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveRepoRoot(root = REPO_ROOT) {
  return resolve(root);
}

export function prepPath(root = REPO_ROOT) {
  return join(resolveRepoRoot(root), PREP_FILE_NAME);
}

export function distPath(root = REPO_ROOT) {
  return join(resolveRepoRoot(root), 'dist');
}

export function manifestPath(root = REPO_ROOT) {
  return join(distPath(root), MANIFEST_FILE_NAME);
}

export function fail(message) {
  const err = new Error(message);
  err.code = 'PROVENANCE_FAIL_CLOSED';
  throw err;
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

export function assertNoForbiddenPathChars(relativePath) {
  if (typeof relativePath !== 'string') {
    fail('artifact path must be a string');
  }
  if (relativePath.includes('\u0000')) {
    fail('artifact path contains NUL');
  }
  if (relativePath.includes('\n') || relativePath.includes('\r')) {
    fail('artifact path contains newline');
  }
}

export function normalizeArtifactPath(relativePath) {
  assertNoForbiddenPathChars(relativePath);
  const normalized = relativePath.split(sep).join('/');
  assertNoForbiddenPathChars(normalized);
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.includes('//')) {
    fail(`invalid normalized artifact path: ${JSON.stringify(normalized)}`);
  }
  return normalized;
}

/** Length-prefixed framing for one (path, digest) pair — uint32 BE lengths + UTF-8 bytes. */
export function framePathDigestPair(relativePath, digestHex) {
  const path = normalizeArtifactPath(relativePath);
  if (typeof digestHex !== 'string' || !/^[0-9a-f]{64}$/.test(digestHex)) {
    fail('digest must be lowercase sha256 hex');
  }
  const pathBytes = Buffer.from(path, 'utf8');
  const digestBytes = Buffer.from(digestHex, 'utf8');
  const framed = Buffer.alloc(4 + pathBytes.length + 4 + digestBytes.length);
  framed.writeUInt32BE(pathBytes.length, 0);
  pathBytes.copy(framed, 4);
  framed.writeUInt32BE(digestBytes.length, 4 + pathBytes.length);
  digestBytes.copy(framed, 4 + pathBytes.length + 4);
  return framed;
}

export function sha256HexOfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256HexOfFile(absPath) {
  return sha256HexOfBuffer(readFileSync(absPath));
}

export function assertRegularFileStat(stat, label = 'path') {
  if (!stat || typeof stat !== 'object') {
    fail(`${label}: missing stat`);
  }
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
    fail(`${label}: symlink rejected`);
  }
  if (typeof stat.isFile !== 'function' || !stat.isFile()) {
    fail(`${label}: non-regular file rejected`);
  }
}

export function compareUtf8Bytewise(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

export function sortNormalizedPaths(paths) {
  return [...paths].sort(compareUtf8Bytewise);
}

/**
 * Walk distDir recursively. Returns [{ relativePath, absPath, sha256, byteLength }].
 * Excludes the manifest file from the hash set.
 */
export function enumerateArtifactFiles(distDir) {
  const root = resolve(distDir);
  if (!existsSync(root)) {
    fail('artifact tree missing');
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory()) {
    fail('artifact tree root must be a directory');
  }

  const out = [];

  function walk(absDir) {
    const names = readdirSync(absDir);
    for (const name of names) {
      assertNoForbiddenPathChars(name);
      const abs = join(absDir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        fail(`symlink rejected: ${normalizeArtifactPath(relative(root, abs))}`);
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      assertRegularFileStat(st, abs);
      const rel = normalizeArtifactPath(relative(root, abs));
      if (rel === MANIFEST_FILE_NAME) {
        continue; // self-exclusion
      }
      const bytes = readFileSync(abs);
      out.push({
        relativePath: rel,
        absPath: abs,
        sha256: sha256HexOfBuffer(bytes),
        byteLength: bytes.length,
      });
    }
  }

  walk(root);

  if (out.length === 0) {
    fail('empty artifact tree rejected');
  }

  const sortedPaths = sortNormalizedPaths(out.map((e) => e.relativePath));
  const byPath = new Map(out.map((e) => [e.relativePath, e]));
  return sortedPaths.map((p) => byPath.get(p));
}

export function computeBuildHashFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('empty artifact tree rejected');
  }
  const sorted = sortNormalizedPaths(entries.map((e) => e.relativePath));
  const byPath = new Map(entries.map((e) => [e.relativePath, e]));
  const frames = [];
  for (const p of sorted) {
    const entry = byPath.get(p);
    if (!entry) fail(`missing entry for ${p}`);
    frames.push(framePathDigestPair(entry.relativePath, entry.sha256));
  }
  return sha256HexOfBuffer(Buffer.concat(frames));
}

export function computeBuildHash(distDir) {
  const entries = enumerateArtifactFiles(distDir);
  return {
    buildHash: computeBuildHashFromEntries(entries),
    entries,
  };
}

export function readCurrentSourceCommit(root = REPO_ROOT) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolveRepoRoot(root),
      encoding: 'utf8',
    }).trim();
  } catch {
    fail('unable to resolve current sourceCommit');
  }
}

export function validatePreparationRecord(prep, { currentSourceCommit, requireMatch = true } = {}) {
  if (!prep || typeof prep !== 'object' || Array.isArray(prep)) {
    fail('malformed preparation: not an object');
  }
  if (prep.schemaVersion !== SCHEMA_VERSION) {
    fail('malformed preparation: schemaVersion');
  }
  if (!isNonEmptyString(prep.preparedSourceCommit)) {
    fail('malformed preparation: preparedSourceCommit');
  }
  if (!isNonEmptyString(prep.preparedBuildId)) {
    fail('malformed preparation: preparedBuildId');
  }
  if (!isNonEmptyString(prep.preparedAt)) {
    fail('malformed preparation: preparedAt');
  }
  if (!isNonEmptyString(prep.compatFloor)) {
    fail('malformed preparation: compatFloor');
  }
  if (Object.prototype.hasOwnProperty.call(prep, 'buildHash')) {
    fail('malformed preparation: buildHash must not be present');
  }
  if (requireMatch) {
    if (!isNonEmptyString(currentSourceCommit)) {
      fail('current sourceCommit required for stale check');
    }
    if (prep.preparedSourceCommit !== currentSourceCommit) {
      fail('stale preparation: preparedSourceCommit mismatch');
    }
  }
  return {
    schemaVersion: prep.schemaVersion,
    preparedSourceCommit: prep.preparedSourceCommit,
    preparedBuildId: prep.preparedBuildId,
    preparedAt: prep.preparedAt,
    compatFloor: prep.compatFloor,
  };
}

export function readPreparation(root = REPO_ROOT, options = {}) {
  const path = prepPath(root);
  if (!existsSync(path)) {
    fail('missing preparation: .artifact-provenance.json');
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('malformed preparation: invalid JSON');
  }
  const currentSourceCommit =
    options.currentSourceCommit ?? readCurrentSourceCommit(root);
  return validatePreparationRecord(raw, {
    currentSourceCommit,
    requireMatch: options.requireMatch !== false,
  });
}

export function buildRuntimeMarker(prep) {
  const validated = validatePreparationRecord(prep, { requireMatch: false });
  return {
    sourceCommit: validated.preparedSourceCommit,
    buildId: validated.preparedBuildId,
    compatFloor: validated.compatFloor,
  };
}

export function assertRuntimeMarkerContract(marker) {
  if (!marker || typeof marker !== 'object') {
    fail('runtime marker missing');
  }
  if (!isNonEmptyString(marker.sourceCommit)) {
    fail('runtime marker missing sourceCommit');
  }
  if (!isNonEmptyString(marker.buildId)) {
    fail('runtime marker missing buildId');
  }
  if (!isNonEmptyString(marker.compatFloor)) {
    fail('runtime marker missing compatFloor');
  }
  if (Object.prototype.hasOwnProperty.call(marker, 'buildHash')) {
    fail('runtime marker must not contain buildHash');
  }
  return marker;
}

/** Identity for SELECT/DEPLOY: sourceCommit alone is never sufficient. */
export function artifactIdentityKey({ sourceCommit, buildId, buildHash }) {
  if (!isNonEmptyString(sourceCommit) || !isNonEmptyString(buildId) || !isNonEmptyString(buildHash)) {
    fail('artifact identity requires sourceCommit, buildId, and buildHash');
  }
  return `${sourceCommit}:${buildId}:${buildHash}`;
}

export function sourceCommitOnlyAcceptanceAllowed() {
  return false;
}

export function directViteAcceptedReleasePath() {
  return false;
}

/**
 * Recompute hash over a directory and compare to a previously verified manifest.
 * Substrate for verify→deploy mutation detection and rollback mismatch.
 */
export function recomputeAndCompareManifest(distDir, manifest) {
  if (!manifest || typeof manifest !== 'object') {
    fail('manifest missing');
  }
  if (!isNonEmptyString(manifest.buildHash)) {
    fail('manifest missing buildHash');
  }
  if (!isNonEmptyString(manifest.sourceCommit) || !isNonEmptyString(manifest.buildId)) {
    fail('manifest missing identity fields');
  }
  const { buildHash } = computeBuildHash(distDir);
  const match = buildHash === manifest.buildHash;
  return {
    match,
    expectedBuildHash: manifest.buildHash,
    recomputedBuildHash: buildHash,
    sourceCommit: manifest.sourceCommit,
    buildId: manifest.buildId,
  };
}

export function prepare(options = {}) {
  const root = resolveRepoRoot(options.root ?? REPO_ROOT);
  const dist = distPath(root);
  // PREPARE must not touch dist/**
  if (options.assertDistUntouched !== false && existsSync(dist)) {
    // Presence of dist is fine; we simply must not write into it.
  }

  const preparedSourceCommit =
    options.sourceCommit ?? readCurrentSourceCommit(root);
  if (!isNonEmptyString(preparedSourceCommit)) {
    fail('prepare: sourceCommit unavailable');
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    preparedSourceCommit,
    preparedBuildId: options.buildId ?? randomUUID(),
    preparedAt: options.preparedAt ?? new Date().toISOString(),
    compatFloor: options.compatFloor ?? COMPAT_FLOOR,
  };

  validatePreparationRecord(record, {
    currentSourceCommit: preparedSourceCommit,
    requireMatch: true,
  });

  const out = prepPath(root);
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function verify(options = {}) {
  const root = resolveRepoRoot(options.root ?? REPO_ROOT);
  const dist = options.distDir ?? distPath(root);
  const prep = options.preparation ?? readPreparation(root, {
    currentSourceCommit: options.currentSourceCommit,
    requireMatch: options.requireMatch !== false,
  });

  const { buildHash, entries } = computeBuildHash(dist);
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    sourceCommit: prep.preparedSourceCommit,
    buildId: prep.preparedBuildId,
    buildHash,
    compatFloor: prep.compatFloor,
    generatedAt,
    preparedAt: prep.preparedAt,
    entries: entries.map((e) => ({
      relativePath: e.relativePath,
      byteLength: e.byteLength,
      sha256: e.sha256,
    })),
  };

  // Identity must not collapse to sourceCommit alone.
  artifactIdentityKey(manifest);

  if (!existsSync(dist)) {
    fail('verify: dist missing');
  }
  mkdirSync(dist, { recursive: true });
  const out = options.manifestOut ?? manifestPath(root);
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function printUsageAndFail() {
  fail('usage: node scripts/gen-artifact-provenance.mjs <prepare|verify>');
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if (mode === 'prepare') {
    const record = prepare();
    process.stdout.write(
      `provenance prepare ok buildId=${record.preparedBuildId} sourceCommit=${record.preparedSourceCommit}\n`,
    );
    return;
  }
  if (mode === 'verify') {
    const manifest = verify();
    process.stdout.write(
      `provenance verify ok buildId=${manifest.buildId} buildHash=${manifest.buildHash}\n`,
    );
    return;
  }
  printUsageAndFail();
}

const invokedDirectly =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    const msg = err && err.message ? err.message : 'provenance failed';
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}
