import { readFileSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

// Read the configured emulator ports from firebase.json so this stays in sync
// if ports ever change. Returns a de-duplicated list of port numbers.
export function getEmulatorPorts() {
  const cfg = JSON.parse(readFileSync(resolve("./firebase.json"), "utf8"));
  const emu = cfg.emulators ?? {};
  const ports = new Set();
  for (const key of Object.keys(emu)) {
    const p = emu[key]?.port;
    if (typeof p === "number") ports.add(p);
  }
  // UI / hub / logging ports the CLI also binds but that aren't in firebase.json
  for (const p of [4000, 4400, 4500]) ports.add(p);
  // Firestore websocket port (8080 + websocket); harmless if not present
  ports.add(9150);
  return [...ports];
}

function pidsOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // e.g. "  TCP    127.0.0.1:8080   0.0.0.0:0   LISTENING   37628"
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) pids.add(m[2]);
      }
      return [...pids];
    } else {
      const out = execSync(`lsof -ti tcp:${port} -s TCP:LISTEN`, {
        encoding: "utf8",
      });
      return out.split(/\s+/).filter(Boolean);
    }
  } catch {
    return []; // no process on this port
  }
}

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

export function freeEmulatorPorts() {
  let freed = 0;
  for (const port of getEmulatorPorts()) {
    for (const pid of pidsOnPort(port)) {
      if (killPid(pid)) {
        freed++;
        console.log(`[emulator] พอร์ต ${port} ถูกใช้งานอยู่ (PID ${pid}) → ปิดให้แล้ว`);
      }
    }
  }
  if (freed === 0) console.log("[emulator] พอร์ตทั้งหมดว่าง พร้อมเริ่มงาน");
}

// Allow running standalone: `node scripts/free-emulator-ports.mjs`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("free-emulator-ports.mjs")) {
  freeEmulatorPorts();
}
