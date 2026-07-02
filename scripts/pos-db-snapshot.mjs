/**
 * Custom persistence for the NAMED Firestore database `pos-db`.
 *
 * Why this exists: the Firebase emulator's built-in `--export-on-exit` only
 * captures the `(default)` database. This project runs on a named database
 * (firebase.json → firestore.database = "pos-db"), so the native export always
 * comes out empty and local data never survives a restart. This module dumps /
 * restores `pos-db` over the emulator REST API to close that gap, keeping dev in
 * strict parity with prod (no `(default)` vs `pos-db` divergence).
 *
 * Auth + Storage still persist via the native export — this only handles the
 * named Firestore database the native export misses.
 *
 * CLI:  node scripts/pos-db-snapshot.mjs dump|restore [path]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const PROJECT_ID =
  process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "twinpet-pos";

// IMPORTANT: must live OUTSIDE ./emulator-data. Firebase's `--export-on-exit`
// wipes & recreates that directory on shutdown, which would delete our snapshot.
// `.local-persist` is a separate gitignored dir firebase never touches.
export const DEFAULT_SNAPSHOT_PATH = resolve("./.local-persist/pos-db-snapshot.json");

export function emulatorHost() {
  return process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
}

export function databaseId() {
  try {
    const cfg = JSON.parse(readFileSync(resolve("./firebase.json"), "utf8"));
    const fs = cfg.firestore;
    const entry = Array.isArray(fs) ? fs.find((e) => e && e.database) ?? fs[0] : fs;
    return entry?.database ?? "(default)";
  } catch {
    return "(default)";
  }
}

/** fetch with a hard timeout so a dying emulator can never hang shutdown. */
async function jsonFetch(url, { method = "GET", body, timeoutMs = 4000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
    return res.status === 204 ? {} : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function v1(host, suffix) {
  return `http://${host}/v1/${suffix}`;
}

/** All collection ids directly under a parent ("" = database root, else a doc resource name). */
async function listCollectionIds(host, dbId, parentName) {
  const base = parentName
    ? v1(host, `${parentName}:listCollectionIds`)
    : v1(host, `projects/${PROJECT_ID}/databases/${dbId}/documents:listCollectionIds`);
  const ids = [];
  let pageToken;
  do {
    const body = await jsonFetch(base, { method: "POST", body: { pageSize: 300, pageToken } });
    if (Array.isArray(body.collectionIds)) ids.push(...body.collectionIds);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return ids;
}

/** List every document resource under parent/collectionId (handles pagination). */
async function listDocuments(host, dbId, parentName, collectionId) {
  const parent = parentName ?? `projects/${PROJECT_ID}/databases/${dbId}/documents`;
  const docs = [];
  let pageToken;
  do {
    const url = v1(host, `${parent}/${collectionId}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    const body = await jsonFetch(url);
    if (Array.isArray(body.documents)) docs.push(...body.documents);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return docs;
}

/** Recursively collect { name, fields } for every doc under the database root. */
async function collectAll(host, dbId, parentName) {
  const out = [];
  const collectionIds = await listCollectionIds(host, dbId, parentName);
  for (const collectionId of collectionIds) {
    const docs = await listDocuments(host, dbId, parentName, collectionId);
    for (const doc of docs) {
      // `fields` is absent for docs that exist only as parents of subcollections.
      out.push({ name: doc.name, fields: doc.fields ?? {} });
      const children = await collectAll(host, dbId, doc.name);
      out.push(...children);
    }
  }
  return out;
}

/** Count top-level product docs (products/<id>, not subcollections) in an entries array. */
function countProducts(entries) {
  return entries.filter((e) => /^products\/[^/]+$/.test(e.path)).length;
}

/** Total doc count currently stored in the snapshot file (0 if absent/corrupt). */
export function snapshotDocCount(inPath = DEFAULT_SNAPSHOT_PATH) {
  try {
    if (!existsSync(inPath)) return 0;
    const snap = JSON.parse(readFileSync(inPath, "utf8"));
    return Array.isArray(snap.docs) ? snap.docs.length : 0;
  } catch {
    return 0;
  }
}

/** Product doc count currently stored in the snapshot file. */
function snapshotProductCount(inPath) {
  try {
    if (!existsSync(inPath)) return 0;
    const snap = JSON.parse(readFileSync(inPath, "utf8"));
    return Array.isArray(snap.docs) ? countProducts(snap.docs) : 0;
  } catch {
    return 0;
  }
}

/**
 * Dump pos-db to `outPath`. Returns the number of documents written, or -1 when a
 * guarded write was REFUSED to protect established data.
 *
 * `guard` (used by the automated autosave/final dump): never overwrite a
 * product-bearing snapshot with a product-empty dump. This defuses the data-loss
 * loop where a boot whose restore yielded nothing seeds admin/branch only, and a
 * 5s autosave then clobbers the real snapshot with that seed-only state. Manual
 * dumps (CLI / `npm run snapshot:dump`) default to guard:false = authoritative.
 */
export async function dumpPosDb(outPath = DEFAULT_SNAPSHOT_PATH, { guard = false } = {}) {
  const host = emulatorHost();
  const dbId = databaseId();
  const docs = await collectAll(host, dbId, null);
  // Store paths relative to `.../documents/` so restore is project/db agnostic.
  const entries = docs.map((d) => ({
    path: d.name.split("/documents/")[1],
    fields: d.fields,
  }));

  if (guard && snapshotProductCount(outPath) > 0 && countProducts(entries) === 0) {
    return -1; // refuse to clobber an established product snapshot with an empty one
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ database: dbId, docs: entries }, null, 2), "utf8");
  return entries.length;
}

/**
 * Skip settled offline orders on restore — they already live in `orders` and
 * only spam the reconcileOrder trigger on every boot.
 */
export function shouldRestoreEntry(entry) {
  if (!entry.path.startsWith("asyncOrders/")) return true;
  const fields = entry.fields ?? {};
  if (fields.voidRequested?.booleanValue === true) return true;
  const status = fields.reconcileStatus?.stringValue;
  return status === "pending_reconcile" || status === "exception";
}

/** Restore pos-db from `inPath` via batched commits. Returns docs restored. */
export async function restorePosDb(inPath = DEFAULT_SNAPSHOT_PATH) {
  if (!existsSync(inPath)) return 0;
  const snap = JSON.parse(readFileSync(inPath, "utf8"));
  const entries = Array.isArray(snap.docs) ? snap.docs : [];
  if (entries.length === 0) return 0;

  const toRestore = entries.filter(shouldRestoreEntry);
  const skipped = entries.length - toRestore.length;
  if (skipped > 0) {
    console.log(
      `[snapshot] ข้าม settled asyncOrders ${skipped} รายการ (ลด trigger reconcileOrder ตอน boot)`,
    );
  }

  const host = emulatorHost();
  const dbId = databaseId();
  const prefix = `projects/${PROJECT_ID}/databases/${dbId}/documents`;
  const commitUrl = v1(host, `${prefix}:commit`);

  const BATCH = 200;
  let restored = 0;
  for (let i = 0; i < toRestore.length; i += BATCH) {
    const writes = toRestore.slice(i, i + BATCH).map((e) => ({
      update: { name: `${prefix}/${e.path}`, fields: e.fields ?? {} },
    }));
    await jsonFetch(commitUrl, { method: "POST", body: { writes }, timeoutMs: 15000 });
    restored += writes.length;
  }
  return restored;
}

/** Count docs in a single root collection (cheap emptiness probe). */
export async function collectionHasDocs(collection) {
  const host = emulatorHost();
  const dbId = databaseId();
  const docs = await listDocuments(host, dbId, null, collection);
  return docs.length > 0;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("pos-db-snapshot.mjs")) {
  const cmd = process.argv[2];
  const path = process.argv[3] ? resolve(process.argv[3]) : DEFAULT_SNAPSHOT_PATH;
  const run =
    cmd === "dump"
      ? dumpPosDb(path).then((n) => console.log(`[snapshot] dumped ${n} doc(s) → ${path}`))
      : cmd === "restore"
        ? restorePosDb(path).then((n) => console.log(`[snapshot] restored ${n} doc(s) ← ${path}`))
        : Promise.reject(new Error("usage: node scripts/pos-db-snapshot.mjs dump|restore [path]"));
  run.catch((err) => {
    console.error("[snapshot] ✗", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
