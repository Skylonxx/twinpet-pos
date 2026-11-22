# MP1 Candidate N-002 — GUARD-AUDIT-001 Initial Prompt Unreadable / Partial Findings (Historical)

**Later resolution:** A new Codex retry at 16:49+07 **successfully read the exact OneDrive Prompt and completed the requested read-only Guardian evidence audit**, with verdict `ROOT_CAUSE_INCONCLUSIVE`. See [successful full audit](planning/MP1-CAND-N-002-GUARD-AUDIT-001-RETRY-COMPLETE-ROOT-CAUSE-INCONCLUSIVE.md). The read failure described below applies to the previous 16:17 attempt only; do not use it as a current blocker.



**Date:** 2026-11-22 (Asia/Bangkok)  
**Evidence:** Owner-uploaded `TPOS-MP1-CAND-N-002-GUARDIAN-MONITOR-GAP-READONLY-AUDIT-CODEX-REPORT.md`, timestamp `2026-11-22T16:17:48.5874593+07:00`.  
**Status:** `BLOCKED_PROMPT_UNREADABLE / PARTIAL_EVIDENCE_REVIEW` — **NOT audit PASS**, Guardian fix, npm permission, or Build permission.

## Prompt access blocker

- Codex could enumerate the canonical OneDrive Prompt file and its size (**14,076 bytes**) but reading it with `Get-Content -LiteralPath ... -Raw -Encoding UTF8` failed exit 1: **`The cloud operation was unsuccessful` / `GetContentReaderIOError`**. Thus Codex could not read/follow the exact GUARD-AUDIT-001 instructions, and rightly did not claim full compliance.
- Windows reported file attributes decimal **525344** (hex **0x80420** = `FILE_ATTRIBUTE_PINNED` 0x80000 + `FILE_ATTRIBUTE_REPARSE_POINT` 0x400 + `FILE_ATTRIBUTE_ARCHIVE` 0x20). **Pinned means intended local retention, not proof content is hydrated/readable.** Together with error, inspect OneDrive sync/hydration first; do **not** falsely classify as online-only or claim OneDrive's precise root cause established. Reparse-point status does not imply unauthorized Git clone/source junction.
- Canonical OneDrive Prompt/Report paths remain unchanged. No automatic Prompt path switch to D. A user-controlled Windows/File Explorer read/open test and OneDrive sync status check are reasonable next steps; do not create/copy/delete/replace user OneDrive files without Owner approval. No network/provisioning retry is needed just to address Prompt read.

## Evidence Codex did directly inspect (report-derived, not full audit certification)

- `evidence/npm-result.txt`: `reason=MONITOR_GAP;rootpid=41084;exit=125;cmin=5829320704;dmin=998724304896;max_gap_ms=736`, start `15:31:20.1239342` and end `15:32:07.3733369` +07.
- `evidence/npm-disk.csv`: **291 rows**; exactly **one gap >500ms**, final row at elapsed **47,099ms** with **736ms**; second-largest gap **304ms**. Sampled min bytes C: `5,829,320,704`, D: `998,724,304,896`. Nothing establishes lower values between samples.
- `Guardian.cs` flow: monotonic `Stopwatch` clock read at loop entry; query free bytes; write+flush CSV; test thresholds/gap; sleep 150ms. The recorded `gap_ms` is **between successive loop entry clocks**. UTC timestamp in the row is captured later, after volume queries. In final rows, UTC differences ~740ms then ~150ms while loop-entry gaps 155ms then 736ms; this is **consistent with delay within the preceding iteration**, but cannot identify disk query, logging flush, OS scheduling, runtime pause or a single root cause.
- Current logic calls `TerminateJobObject(job,125)` **after a delayed loop iteration resumes**, so it can stop on a discovered >500ms gap but cannot provide a hard real-time guarantee at the instant 500ms elapses. This is a design limitation, not proof a harmful delayed stop or data corruption happened. Prior synthetic evidence has PIDs 45996/33292, 27 samples, max gap 158ms, not sufficient to guarantee cadence during npm load; no independent full descendant termination history for real npm.
- The report gives SHA256 identities: Guardian.cs `85B21458F708E30A3126F68A66F9F2ADDC9C46F2324D82C3D10FC121B79FF1E9`; run-npm.ps1 `79D006ACD1CE6A16B6B4434390C225407CA1FFF7C5609AD32E52F9A86DE5956B`; npm-result.txt `3E3C4FC4C971F7465D5A32A57CD1010C4F9F9022DAD55866FDFA487194B99F60`; npm-disk.csv `30C01D76D91F95791EE016F96F99A9240EF95A01EF7E6950BF345B2D272F3B3F`; synthetic-disk.csv `3FE28E3A4AA53971D52F73FE3DB8BDA0E4CF7B906C3185ED955DFE59825087F7`.
- **Only the new report was written**, according to Codex; no Guardian, npm/Cargo, Build, Test, GUI or synthetic runtime executed and no scratch evidence altered. Existing D: partial npm-stage/cache preserved, no cleanup, Cargo fetch still NOT_RUN.

## Narrow next decision (not execution authority)

1. Resolve the OneDrive Prompt read/hydration issue using native file inspection: check sync client/account status and whether the exact Prompt opens and `Get-Content` can read it. If OneDrive displays `Always keep on this device`, note `PINNED` flag may already indicate that intent; hydration success must be verified independently. **Do not change canonical OneDrive path.**
2. After local Prompt read is verified, request Owner permission to **repeat the read-only GUARD-AUDIT-001 evidence review only**, or alternatively accept these partial findings and authorize a separate guardian *design-only* proposal. **No npm/fetch/Build retry** and no lowering <=500ms rule by assumption.
3. Future design candidate (proposal only): separate monotonic clock sampling/stop decisions from synchronous disk queries and CSV Flush; measure component durations individually, use buffered/background logging and bounded queue with failure policy, plus a watchdog that can act if the sampling worker stops. This is **hypothesis-level architecture**, not a proven fix; any implementation/test/threshold change requires Owner approval. A normal Windows user-mode loop is not hard real-time, so avoid claiming strict deadlines without evidence.

**Authority:** Prior DEPS-PROV-001 one-shot ended `BLOCKED_GUARDIAN`; its incomplete stage must not be silently reused/cleaned. Current read-only Guardian audit ended `BLOCKED_PROMPT_UNREADABLE`; no further execution approved merely by this record. **F-01/F-02 OPEN; M1 NOT_PASS; MERGE/RELEASE NOT_AUTHORIZED.** Original main, isolated candidate source, UAT023, real AppData, Cloud/Production and Offline First/Gate-OFF remain protected.
