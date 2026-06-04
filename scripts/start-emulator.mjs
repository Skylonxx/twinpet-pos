import { existsSync } from "fs";
import { spawn } from "child_process";
import { resolve } from "path";
import { freeEmulatorPorts } from "./free-emulator-ports.mjs";

// Clear any orphaned emulator processes (e.g. a Firestore JVM left holding
// port 8080 after an unclean shutdown) so this run can bind its ports.
freeEmulatorPorts();

const dataDir = resolve("./emulator-data");
const metaFile = resolve(dataDir, "firebase-export-metadata.json");

const args = [
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
// Quote it: emulators:exec takes ONE script argument, and shell:true concatenates
// args unquoted, so the space in this command would otherwise be split into two.
args.push('"node scripts/dev-after-emulators.mjs"');

const proc = spawn("firebase", args, { stdio: "inherit", shell: true });
proc.on("exit", (code) => process.exit(code ?? 0));
