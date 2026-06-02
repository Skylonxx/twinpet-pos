#!/usr/bin/env node
/**
 * gen-deploy-config — derive deployment config from firebase.json.
 *
 * firebase.json is the SINGLE SOURCE OF TRUTH for:
 *   - the named Firestore database id   (firestore.database)
 *   - the deployment region / DB location (firestore.location)
 *
 * This script reads those once and emits derived artifacts so NOTHING in the
 * app/backend hardcodes them:
 *   1. functions/src/deployConfig.ts  — constants imported by functions + scripts
 *      (baked into the bundle at build time; the cloud runtime never reads
 *       firebase.json, which isn't packaged with the function).
 *   2. .env (root)                    — VITE_* vars for the browser bundle
 *      (only the two managed keys are upserted; other lines are preserved).
 *
 * Runs from `prebuild`/`predev` (frontend) and `functions` build + predeploy.
 * Path resolution is anchored to this file, so it works from any CWD.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIREBASE_JSON = resolve(REPO_ROOT, 'firebase.json');
const BACKEND_OUT = resolve(REPO_ROOT, 'functions/src/deployConfig.ts');
const ENV_OUT = resolve(REPO_ROOT, '.env');

const MANAGED_KEYS = ['VITE_FIRESTORE_DATABASE_ID', 'VITE_FUNCTIONS_REGION'];

/** Pull { database, location } from firebase.json (handles object + array forms). */
function readFirestoreConfig() {
  if (!existsSync(FIREBASE_JSON)) {
    throw new Error(`firebase.json not found at ${FIREBASE_JSON}`);
  }
  const fb = JSON.parse(readFileSync(FIREBASE_JSON, 'utf8'));
  const fs = fb.firestore;
  if (!fs) throw new Error('firebase.json has no "firestore" block.');

  // Single-object form, or array (multi-database) form → first entry with a database.
  const entry = Array.isArray(fs) ? fs.find((e) => e && e.database) ?? fs[0] : fs;
  const database = entry?.database;
  const location = entry?.location;

  if (!database) {
    throw new Error('firebase.json: firestore.database is missing — cannot derive the database id.');
  }
  if (!location) {
    throw new Error('firebase.json: firestore.location is missing — cannot derive the region.');
  }
  return { database, location };
}

function writeBackendConfig({ database, location }) {
  const body = `// AUTO-GENERATED from firebase.json by scripts/gen-deploy-config.mjs.
// DO NOT EDIT — run \`node scripts/gen-deploy-config.mjs\` (or any build) to regenerate.

/** Named Firestore database id (firebase.json → firestore.database). */
export const FIRESTORE_DATABASE_ID = ${JSON.stringify(database)};

/** Deployment region / Firestore location (firebase.json → firestore.location). */
export const FUNCTIONS_REGION = ${JSON.stringify(location)};
`;
  writeFileSync(BACKEND_OUT, body, 'utf8');
}

/** Upsert only the managed VITE_* keys in root .env, preserving any other lines. */
function writeEnvConfig({ database, location }) {
  const managed = {
    VITE_FIRESTORE_DATABASE_ID: database,
    VITE_FUNCTIONS_REGION: location,
  };

  const existing = existsSync(ENV_OUT) ? readFileSync(ENV_OUT, 'utf8').split('\n') : [];
  const kept = existing.filter((line) => {
    const key = line.split('=')[0]?.trim();
    // Drop previous managed values and our generated banner; keep everything else.
    return !MANAGED_KEYS.includes(key) && !line.startsWith('# AUTO-GENERATED (deploy-config)');
  });

  // Trim leading/trailing blank lines from the preserved block for tidy output.
  while (kept.length && kept[0].trim() === '') kept.shift();
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();

  const banner = '# AUTO-GENERATED (deploy-config) — derived from firebase.json. Do not edit these two keys.';
  const managedLines = Object.entries(managed).map(([k, v]) => `${k}=${v}`);

  const out = [...kept, ...(kept.length ? [''] : []), banner, ...managedLines, ''].join('\n');
  writeFileSync(ENV_OUT, out, 'utf8');
}

function main() {
  const cfg = readFirestoreConfig();
  writeBackendConfig(cfg);
  writeEnvConfig(cfg);
  console.log(
    `[gen-deploy-config] database="${cfg.database}" region="${cfg.location}" → functions/src/deployConfig.ts, .env`,
  );
}

main();
