# MP1 Candidate N-002 — Owner Authorized One-Shot Drive D Build (Real C dist)

**Date:** 2026-11-22 (Asia/Bangkok)  
**Status:** `OWNER_APPROVED_NEW_ONE_SHOT / WINDOWS_EXECUTION_NOT_RUN_IN_CHAT / REPORT_PENDING`  
**Decision:** Following reports at 13:53 and 13:57 (wrong D Prompt directory, anticipated dist junction/provenance check incompatibility, and untested guardian), Product Owner said **“ครับดำเนินการต่อครับ”** to proposed four-part correction in the immediately preceding ChatGPT answer. This authorizes this **new narrowly bounded** execution packet only, not an automatic repeat of earlier packets.

## Execution boundary

- **Pinned source clone:** existing `C:\Users\Narachat\TPOS-MP1-CAND-N-ISO-20261121` detached at `f034301c46dd9e08190f869cc85dbb140ac28a3c`, preserve only prior two uncommitted `src-tauri/src/epoch_floor.rs` and `src-tauri/src/durable_kv.rs` modifications with same SHA-256. Original `C:\Users\Narachat\twinpet-pos` `main` stays read-only/tracked clean. No new clone, source edits, reset, cleanup, UAT023, Cloud/Production or real POS AppData.
- **External scratch only:** `D:\Twinpet-POS\Twinpet-N002-Build-20261122` for npm stage/cache, Cargo home/target, temporary files, disposable synthetic profiles and guardian scripts; **do not store Prompt/Report on D:**. D WD My Passport NTFS was observed Healthy/OK with 999,109,189,632 bytes free at last read-only precheck, but current capacity and stability must be freshly verified by Windows.
- **Frontend dist correction:** `clone\dist` is a **real directory on C:**, not junction or symbolic link, to respect `scripts/gen-artifact-provenance.mjs` postbuild `lstatSync(dist).isDirectory()`. Only `clone\node_modules` may junction to verified D npm-stage; both paths must be absent/safe before creation.
- **Guardian before operations:** Demonstrate experiment-only Windows child-process containment and terminating a harmless synthetic child; actively measure C/D free bytes every <=500ms during npm fetch/install/frontend/native/test. STOP experiment processes proactively if C <=2.25 GiB, mandatory C <=2.0 GiB, D <=10 GiB, D disconnect, unsafe writes/network risk. No unrelated-process termination and no permanent threshold/policy changes. New **single-use exception** to standard C >=10GiB preflight for this approved attempt only.
- **Network bounds:** one official npm registry lockfile-verified install on D with lifecycle scripts disabled; one crates.io-only Cargo fetch on D. Do not contact Firebase/Cloud, Production, ZORT or other endpoints. No universal claim of network isolation without proof; if actual allowed fetch destinations cannot be constrained/verified or scripts risk external connections, STOP. Never run POS GUI, dev server or emulator in this packet.
- **One-step build chain:** one guarded npm ci staging, one Cargo target fetch, one normal `npm run build` with protected generated `.env`, `functions/src/deployConfig.ts`, `.artifact-provenance.json`, real clone `dist` and provenance manifest; if PASS one frozen offline Cargo dev `cargo build --frozen --bin app --jobs 1`; if PASS at most one reviewed synthetic Rust `cargo test --frozen --lib checked_domain_probe --jobs 1 -- --test-threads=1` under disposable D profile. No alternate flags, retries, install scripts or Source patch. Record full command/exit and real disk minimum observed; zero matched tests not PASS.
- All previous Startup Integrity F-01 dangling ancestor and F-02 startup manifest race findings remain open; Policy A acceptance narrow; Offline First and Gate-OFF permanent. **M1 NOT_PASS; MERGE/RELEASE not authorized** even on build/test PASS.

## Owner handoff

- **Full prompt file (provided as a downloadable ChatGPT artifact, Owner to save):** `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Prompt\TPOS-MP1-CAND-N-002-DRIVE-D-REAL-DIST-GUARDED-BUILD-CODEX-PROMPT.md`
- **Short inline Launcher only (NO Launcher file):** Codex is told to read the above OneDrive Prompt and write the below report. No extra body instructions in Launcher.
- **Single report:** `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\TPOS-MP1-CAND-N-002-DRIVE-D-REAL-DIST-GUARDED-BUILD-REPORT.md` (timestamp suffix if existing).
- **Execution status:** ChatGPT does not have a connected shell on the user's Windows host. No Windows npm, Cargo, Build, Test or guardian exercise was run in this chat; Owner manually dispatches the Prompt to Codex CLI after saving file. Results must not be claimed until its report is received. No further subapproval for expressly scoped steps.

**Related decision:** [earlier precheck blockers](MP1-CAND-N-002-DRIVE-D-PRECHECK-JUNCTION-GUARDIAN-ADJUDICATION.md) and the proposed MP0 Master Plan.
