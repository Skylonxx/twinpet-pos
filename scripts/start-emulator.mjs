import { existsSync } from "fs";
import { spawn } from "child_process";
import { resolve } from "path";

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

args.push("vite");

const proc = spawn("firebase", args, { stdio: "inherit", shell: true });
proc.on("exit", (code) => process.exit(code ?? 0));
