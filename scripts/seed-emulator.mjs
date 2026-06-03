import { execSync } from "child_process";

const env = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  GCLOUD_PROJECT: "twinpet-pos",
};

const opts = { stdio: "inherit", env };

console.log("[seed] Building functions...");
execSync("npm --prefix functions run build", opts);

console.log("[seed] Seeding branch data...");
execSync("node functions/lib/scripts/seed-branch.js", opts);

console.log("[seed] Seeding admin user...");
execSync("node functions/lib/scripts/seed-admin.js", opts);

console.log("[seed] Done! ✅");
