# MP1 Candidate N-002 — GUARD-G1-001 Compile-Only PASS & G2 Safety Gate

**Date:** 2026-11-22 (Asia/Bangkok)
**Source:** Owner-uploaded `TPOS-MP1-CAND-N-002-GUARDIAN-G1-SOURCE-COMPILE-ONLY-CODEX-REPORT.md` (created 2026-11-22 17:59:38.6780659+07).
**Verdict:** `G1_COMPILE_PASS_ONLY` — the expressly scoped new C# source and ONE local DLL compile completed with exit 0. **Guardian not executed, not synthetic-proofed, not ready for npm or POS Build.**

## Source-of-truth results

- The unique G1 D root **NOW EXISTS**: `D:\Twinpet-POS\Twinpet-N002-Guardian-Synthetic-20261122-001`, created after confirming absent at preflight. D: My Passport NTFS serial `F02C88D4`, C: BOOTCAMP NTFS serial `0699EDE9`, both Healthy/OK. C free before `5,846,839,296`, last `5,843,185,664` bytes; D before `998,728,765,440`, last `998,728,720,384` bytes; point samples only, not continuous minima.
- Five new files reported: `src/GuardianNative.cs` 6,789 bytes SHA256 `625610A5402D735D7F23EDE2D506989AF66363715C7D7BE1B26BC9504D1EECCD`; `src/GuardianPrototype.cs` 10,386 bytes SHA256 `025C63D156C5B194BCD709CE745B98302C52B7A4A3D5D94EB080983DBAF770F7`; `G1-DESIGN.md` 3,049 bytes SHA256 `2908471FA82D04269CA819D35A7C387E5F35DEE9B04A8043A2B379DCB3D0B5D6`; `bin/GuardianPrototype.dll` 14,336 bytes SHA256 `991EAEB575817AB5ACBB293FA0BAAD8BC96EDF2699BD36409952B6D5DC6CDE0D`; `evidence/compiler-output.txt` 418 bytes SHA256 `43015720C887CFE71DB2C56284CC9F198D91D0524E12ED9259D43BFBB2E92AF2`.
- Compiler `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` .NET 4.8 / C#5, `/noconfig /target:library` with in-box System and System.Core references, project-local D outputs/temp; **one invocation exit 0**; no compiler errors. DLL was **not loaded, reflected, executed, or tested**. Compiler exit 0 is not functional or security proof. No independent containment of all transient external OS/antivirus side effects claimed.
- Prior OLD D root `D:\Twinpet-POS\Twinpet-N002-Build-20261122` frozen. Seven old Guardian/evidence/log file SHA256 matched before/after. Partial npm stage/cache not traversed or intentionally changed. Original main and candidate repo were **NOT independently rechecked** in G1; do not claim new source custody verification. No app/Cloud/GUI/provisioning activity reported.

## Static findings from Codex report (not independent source audit)

1. **PARTIAL — process ownership:** Job Object/suspended-assign/kill-on-close primitives exist but caller-supplied executable, path, environment and child ownership are not validated; termination and process tree behavior untested; lock during launch could delay stop.
2. **PARTIAL — independent watchdog:** separate sampler/watchdog/log-consumer threads are designed; watchdog itself has no independent death/liveness supervisor. Startup grace 500 ms. OS scheduling cannot guarantee hard real-time.
3. **PARTIAL — genuine disk sampling:** C and D freshness, identity strings and threshold checks exist, but real trusted volume identity/disconnect sensor adapter is **not implemented**; caller-provided strings are not proof.
4. **STATIC ONLY — <=500ms rule:** constant 500 and `>500` stop checks present; no observed sample or termination latency measurements. Do not change rule without Owner permission.
5. **PARTIAL — bounded logs and watcher:** queue/stall/fault path exists but durable local sink and measured enqueue/write/flush incomplete; actual watcher/overflow adapter, independent watchdog-death detector, termination acknowledgment and timestamps absent.
6. **STATIC ONLY — no intended Cloud/POS integration:** delegated probe/sink/process inputs could be unsafe unless explicitly bounded and independently reviewed.

## Subsequent Owner decision (2026-11-23)

Owner has **NOW APPROVED** creating the exact read-only G1.5 Prompt, with the work limited to independently reading existing D G1 sources, design and compiler evidence, hashing DLL and old evidence, and producing a single OneDrive Codex report. [G1.5 Owner authorization](planning/MP1-CAND-N-002-GUARD-G1-5-001-READONLY-SOURCE-AUDIT-OWNER-AUTHORIZATION.md). This replaces the earlier G1.5 decision-pending status **for the review only**. **G2 implementation and synthetic execution remain NOT_AUTHORIZED**; old partial npm/cache preserved.

## Next recommended gate — not approved for execution

**Recommend G1.5 independent READ-ONLY SOURCE REVIEW first**, using only the two NEW `.cs` files, `G1-DESIGN.md`, compiler evidence and hashes under the NOW-EXISTING G1 D root. Review P/Invoke signatures, handle ownership, cancellation/lock ordering, proposed independent watchdog, volume-sensor trust boundary, queue stall behavior, side-effect paths and child-process launch input validation. Do NOT execute/load/reflection-invoke the DLL, run synthetic processes, rewrite G1 files or touch old D cache. Produce one read-only review report in canonical OneDrive Codex location. This helps define a concrete minimum G2 implementation/proof packet without running known incomplete code.

**Future G2 (separate explicit Owner approval after G1.5):** bounded implementation of missing adapters and synthetic test harness in a separately approved writable experiment path (since G1 root **EXISTS**, cannot reuse an 'if absent' creation rule) with strict old-file preservation. Synthetic process parent/grandchild containment and unrelated sentinel survival, fake/real disk sensor boundary, injected delays/failures, independent job-stop watchdog and <=500ms disk sample freshness are required; no npm/Cargo/download/Build POS/GUI/Cloud, no real AppData or UAT023. Never claim Windows user-mode hard realtime. Any G2 PASS is still not permission to resume the old one-shot npm installation, nor a Build/M1 PASS.

**Preservation/authority:** Do not rerun G1's one-shot compile under old Prompt. No fresh npm/Cargo, Guardian runtime, Source/Main/UAT023, real AppData, Cleanup, deployment, merge or release authorized by this planning memo. The original interrupted npm-stage/cache is unverified and must not be overwritten/reused. F-01 and F-02 OPEN; Offline First and Gate-OFF fixed; C >=10 GiB POS Build gate unchanged; M1 NOT_PASS.

**Prompt conventions:** Full `.md` files under `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Prompt\`; short inline Launcher only, no Launcher file; reports under corresponding `...\Codex\`. Any next Prompt needs Owner authorization. This document is planning-branch bookkeeping, not a command to Windows Codex.
