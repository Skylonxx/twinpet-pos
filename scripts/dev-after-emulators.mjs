/**
 * Runs INSIDE `firebase emulators:exec` (see start-emulator.mjs), so the
 * emulators are guaranteed up and this process inherits FIRESTORE_EMULATOR_HOST.
 *
 * Boot:
 *   1. Restore the named `pos-db` database from our custom snapshot (the native
 *      emulator export can't persist named databases — see pos-db-snapshot.mjs).
 *   2. Auto-seed failsafe — if Firestore still has no users/branches (no snapshot
 *      yet, or an empty/corrupt one), seed the essential Admin + Branch + role
 *      settings so you're never locked out of an empty app.
 *   3. Hand off to Vite.
 *
 * Persist:
 *   - Autosave the snapshot every 5s while running, AND a final best-effort dump
 *     on exit. Both are GUARDED: they never overwrite a product-bearing snapshot
 *     with a seed-only/empty dump (see dumpPosDb guard). Periodic saves mean even
 *     a hard window-close keeps near-latest data — no clean Ctrl+C required.
 *
 * Auth + Storage keep persisting via the native `--export-on-exit`; this only
 * covers the `pos-db` Firestore data that export misses.
 */
import { execSync, spawn } from "child_process";
import {
  dumpPosDb,
  restorePosDb,
  collectionHasDocs,
  snapshotDocCount,
  DEFAULT_SNAPSHOT_PATH,
} from "./pos-db-snapshot.mjs";

// Short interval: the snapshot lives outside emulator-data and survives shutdown,
// so the autosave (not the racy final dump) is the real persistence guarantee.
// Worst-case data loss on a hard exit is one interval.
const AUTOSAVE_MS = 5_000;
let autosaveTimer;
let dumping = false;
let finalized = false;

async function firestoreIsSeeded() {
  // Empty if EITHER essential collection is missing.
  const [hasUsers, hasBranches] = await Promise.all([
    collectionHasDocs("users"),
    collectionHasDocs("branches"),
  ]);
  return hasUsers && hasBranches;
}

function runSeed() {
  console.log("");
  console.log("════════════════════════════════════════════════════════════");
  console.log("[auto-seed] 🌱 ไม่มีข้อมูลใน Firestore (ไม่มี users/branches)");
  console.log("[auto-seed] 🌱 กำลัง seed: Admin + สาขา + role settings…");
  console.log("════════════════════════════════════════════════════════════");
  execSync("node scripts/seed-emulator.mjs", { stdio: "inherit", env: process.env });
  console.log("[auto-seed] ✅ seed สำเร็จ — username: admin / PIN: 1234");
  console.log("");
}

/**
 * Dump pos-db, guarded against overlapping runs AND against clobbering an
 * established product snapshot with a seed-only/empty state. Never throws.
 */
async function snapshot(label) {
  if (dumping) return;
  dumping = true;
  try {
    const n = await dumpPosDb(DEFAULT_SNAPSHOT_PATH, { guard: true });
    if (n === -1) {
      console.warn(
        "[snapshot] 🛡️  pos-db ไม่มีสินค้าแต่ snapshot เดิมมี → งดเขียนทับ (กันข้อมูลหาย)",
      );
    } else if (label) {
      console.log(`[snapshot] 💾 ${label}: บันทึก ${n} เอกสาร → pos-db-snapshot.json`);
    }
  } catch (err) {
    console.warn(`[snapshot] ⚠️  บันทึกไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
  } finally {
    dumping = false;
  }
}

/** Final dump on the way out — runs once, with the emulator still alive. */
async function finalize() {
  if (finalized) return;
  finalized = true;
  clearInterval(autosaveTimer);
  console.log("\n[snapshot] 💾 กำลังบันทึก pos-db ครั้งสุดท้ายก่อนปิด…");
  await snapshot("final");
}

async function boot() {
  // How much real data is on disk? Used to decide retry-vs-seed below.
  const onDiskDocs = snapshotDocCount();

  // 1. Restore named-db snapshot (no-op if absent/empty).
  let restored = 0;
  try {
    restored = await restorePosDb();
    if (restored > 0) {
      console.log(`[snapshot] ♻️  กู้คืน pos-db จาก snapshot: ${restored} เอกสาร`);
    } else {
      console.log("[snapshot] ไม่พบ snapshot เดิม (หรือว่างเปล่า)");
    }
  } catch (err) {
    console.warn(`[snapshot] ⚠️  กู้คืนไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
  }

  // 1b. If the snapshot HAS data but restore left Firestore empty, that's a
  // transient restore miss — retry once before falling back to seeding. (The
  // dump guard already prevents a seed-only autosave from clobbering the
  // snapshot, but retrying avoids an unnecessarily empty session.)
  if (onDiskDocs > 0 && !(await firestoreIsSeeded())) {
    console.warn("[snapshot] ⚠️  restore ไม่ครบทั้งที่มี snapshot — ลองกู้คืนอีกครั้ง");
    try {
      restored = await restorePosDb();
      console.log(`[snapshot] ♻️  กู้คืนรอบสอง: ${restored} เอกสาร`);
    } catch (err) {
      console.warn(`[snapshot] ⚠️  กู้คืนรอบสองไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 2. Failsafe seed if essentials are still missing. Safe even when a real
  // snapshot exists: the dump guard refuses to overwrite it with seed-only data.
  let seeded = false;
  try {
    if (!(await firestoreIsSeeded())) {
      runSeed();
      seeded = true;
    } else {
      console.log("[auto-seed] ✓ พบ users/branches แล้ว — ข้ามการ seed");
    }
  } catch (err) {
    console.warn(`[auto-seed] ⚠️  ตรวจสอบ/seed ไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
  }

  // Capture a snapshot immediately after a fresh restore+seed, so even an instant
  // hard-kill leaves a valid snapshot on disk.
  if (seeded || restored === 0) await snapshot("initial");

  // 3. Periodic autosave.
  autosaveTimer = setInterval(() => void snapshot(), AUTOSAVE_MS);
  autosaveTimer.unref?.();
  console.log(`[snapshot] ⏱️  autosave ทุก ${AUTOSAVE_MS / 1000}s → ${DEFAULT_SNAPSHOT_PATH}`);
}

function startVite() {
  const args = ["run", "dev:web"];
  if (process.argv.length > 2) {
    args.push("--", ...process.argv.slice(2));
  }
  const proc = spawn("npm", args, { stdio: "inherit", shell: true });
  proc.on("exit", async (code) => {
    await finalize();
    process.exit(code ?? 0);
  });
}

// Final dump on termination signals (emulators:exec keeps the emulator alive
// until this process exits, so the dump runs against a live Firestore).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, async () => {
    await finalize();
    process.exit(0);
  });
}

boot()
  .then(startVite)
  .catch((err) => {
    console.error("[orchestrator] ✗", err instanceof Error ? err.message : err);
    startVite(); // still bring the dev server up
  });
