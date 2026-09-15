import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { spawn } from "child_process";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { freeEmulatorPorts } from "./free-emulator-ports.mjs";

// OPTION_A_OWNED_OS_TEMP containment: the Firebase CLI below is launched with
// its cwd set to a unique owned OS-temp directory (see ownedTempParent), so
// its own upstream `HubExport` staging directories
// (`fs.mkdtempSync("firebase-export-<epoch>")`, a relative-path mkdtemp with
// no cleanup on failure/interruption — see firebase-tools/lib/emulator/hubExport.js)
// land under OS temp instead of leaking into the repository root. Because the
// CLI's cwd is no longer the repository, every path it or its wrapped child
// needs must be explicit/absolute, derived from THIS script's own location
// rather than from process.cwd() (which the caller controls and which will
// shortly stop being the repo root for the CLI process).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

// freeEmulatorPorts() (and the firebase.json it reads) must see repo-root as
// cwd regardless of the caller's own working directory — resolve this BEFORE
// any cwd-relative preflight runs, not after.
process.chdir(repoRoot);

// Clear any orphaned emulator processes (e.g. a Firestore JVM left holding
// port 8080 after an unclean shutdown) so this run can bind its ports.
freeEmulatorPorts();

const dataDir = resolve(repoRoot, "emulator-data");
const metaFile = resolve(dataDir, "firebase-export-metadata.json");
const firebaseConfigPath = resolve(repoRoot, "firebase.json");

// SHELL_FREE_LOCAL_NODE_CLI: resolve the repo-local firebase-tools package's
// own declared CLI entry point (never an ambient PATH `firebase` shim, never
// an npx cache entry) and invoke it directly with `process.execPath`, so no
// shell is ever spawned to launch the Firebase CLI itself.
const firebaseToolsPkgDir = resolve(repoRoot, "node_modules", "firebase-tools");
const firebaseToolsPkg = JSON.parse(
  readFileSync(resolve(firebaseToolsPkgDir, "package.json"), "utf8"),
);
const firebaseCliRelEntry =
  typeof firebaseToolsPkg.bin === "string" ? firebaseToolsPkg.bin : firebaseToolsPkg.bin.firebase;
const firebaseCliJsEntry = resolve(firebaseToolsPkgDir, firebaseCliRelEntry);

const args = [
  // Global --config, resolved to an absolute path: detectProjectRoot() reads
  // this before ever consulting cwd, so it (and the .firebaserc project-alias
  // lookup beside it) resolves to the repo root regardless of the CLI's own
  // cwd. Pinned repo-local firebase-tools@13.31.0 — never an ambient PATH
  // `firebase` shim, never an npx cache entry.
  "--config",
  firebaseConfigPath,
  "emulators:exec",
  "--ui",
  `--export-on-exit=${dataDir}`,
];

if (existsSync(metaFile)) {
  args.push(`--import=${dataDir}`);
  console.log("[emulator] พบข้อมูลเก่า → import จาก", dataDir);
} else {
  console.log("[emulator] ไม่พบข้อมูลเก่า → เริ่มใหม่เปล่า");
}

// Hand the live emulators to the orchestrator: it auto-seeds an empty Firestore
// (Admin + branch + role settings) before starting Vite, so you're never locked
// out of an empty app. emulators:exec exports state when this command exits.
// This whole string is ONE argv element (shell:false + array argv below, so
// no shell join/re-splits it) — emulators:exec itself takes exactly one
// script argument and runs it through its own child shell.
const childArgs = process.argv.slice(2).join(" ");
// The wrapped script below is spawned by firebase-tools' own runScript() with
// no cwd override (lib/emulator/commandUtils.js), so it inherits the CLI
// process's cwd — the owned OS-temp parent, not the repo. Explicitly `cd`
// back to repoRoot first so dev-after-emulators.mjs / pos-db-snapshot.mjs
// (deliberately not edited by this containment change) keep resolving their
// own `./...`-relative paths (`.local-persist`, `firebase.json`, Vite) against
// the repository exactly as before. Quoted so a space in repoRoot stays one
// path argument for that inner shell.
const cdPrefix =
  process.platform === "win32"
    ? `cd /d "${repoRoot}" &&`
    : `cd "${repoRoot}" &&`;
args.push(`${cdPrefix} node scripts/dev-after-emulators.mjs ${childArgs}`);

// Unique Twinpet-owned per-run parent under OS temp. Only this exact
// directory is ever removed below — never a repo-root sweep, never anything
// matching `firebase-export-*`.
const ownedTempParent = mkdtempSync(join(tmpdir(), "twinpet-firebase-run-"));

const proc = spawn(process.execPath, [firebaseCliJsEntry, ...args], {
  stdio: "inherit",
  shell: false,
  cwd: ownedTempParent,
});

// Ctrl+C delivers SIGINT to every process sharing this console at once, so
// this wrapper and the spawned Firebase CLI child both receive it the same
// instant. Node's default disposition (no listener) would terminate THIS
// process immediately — racing ahead of the child's own graceful
// export-on-exit shutdown and skipping cleanupOwnedTempParent() below
// entirely. Absorb the signal here instead; the child's 'close' handler
// below is what actually decides when and how this wrapper exits.
function ignoreSignal() {}
process.on("SIGINT", ignoreSignal);
process.on("SIGTERM", ignoreSignal);

function cleanupOwnedTempParent() {
  try {
    rmSync(ownedTempParent, { recursive: true, force: true });
  } catch (err) {
    // Reported, never escalated: a cleanup failure must never widen deletion
    // scope beyond this exact owned-temp parent.
    console.warn(
      "[emulator] คำเตือน: ลบ temp parent ที่เป็นเจ้าของไม่สำเร็จ:",
      ownedTempParent,
      err?.message ?? err,
    );
  }
}

proc.on("error", (err) => {
  console.error("[emulator] ไม่สามารถเริ่ม Firebase CLI ได้:", err?.message ?? err);
  cleanupOwnedTempParent();
  process.exit(1);
});

// 'close' (not 'exit'): fires only once the child's stdio/descriptors have
// actually finished closing, so cleanup never races the Firebase CLI's own
// export-on-exit shutdown lifecycle.
proc.on("close", (code, signal) => {
  cleanupOwnedTempParent();
  if (signal) {
    // Restore default disposition before re-raising: our own ignoreSignal
    // listeners above must not swallow this self-directed signal too, or the
    // wrapper would never actually terminate. Signal termination must stay
    // visibly a signal death, never a silent `code ?? 0` success — re-raise
    // the same signal against ourselves so the wrapper's own exit
    // status/signal matches what actually killed the child.
    process.removeListener("SIGINT", ignoreSignal);
    process.removeListener("SIGTERM", ignoreSignal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
