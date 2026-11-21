# Twinpet POS — MP1-CAND-N Native Custody Implementation Packet

**Owner authorization:** 2026-11-21. Product Owner explicitly approved **Candidate N Implementation** with limited scope and synthetic isolated tests. This is a **scoped execution authorization**, not approval of MP1.3 integration, Git commit/push to main, release, real UAT, production data, Cloud, Candidate I, or change to official Gate-OFF.

**Packet ID:** `TPOS-MP1-CAND-N-001`  
**State:** `OWNER_APPROVED_FOR_ISOLATED_IMPLEMENTATION / EXECUTOR_NOT_YET_RUN`  
**Repo baseline:** `Skylonxx/twinpet-pos` `main@f034301c46dd9e08190f869cc85dbb140ac28a3c` (verify local before execution; stop on mismatch)  
**Design contract:** [MP1-P01](MP1-P01-NATIVE-CUSTODY-IDENTITY-SAFETY-PLAN.md) · evidence MP1-R01 `MP1_R01_REVIEW_COMPLETE_WITH_BLOCKERS`  
**Authority:** Product Owner final; Gemini legacy formal phase and commit gate still recorded in `AUTHORITY_MATRIX.md`; do not silently modify workflow trio on main. This bounded packet does not represent acceptance of M0 or M1.

## 1. Business-facing reason / goal

Prevent silent data loss/unsafe virgin-state classification in the native SQLite durable store while preserving legitimate existing-device restart. Do not sacrifice Offline First or cashier availability by adding unjustified fail-closed conditions; fail closed only for **provably inconsistent/unverifiable prior committed state** and report ambiguous conditions for explicit Owner decision. Work should be no more than the minimum necessary to satisfy N1–N3.

## 2. Critical legacy compatibility nuance — never override blindly

`src-tauri/src/durable_kv.rs` on the official baseline has `prior_phase_b_state_exists` using epoch floor OR durable-domain presence plus `manifest_path_state`. The existing `assert_startup_integrity` comments explicitly document a **legitimate privileged-auth-only floor (epoch 2) with no Phase-B manifest**. Thus **floor-only is NOT automatically a corrupted Phase-B durable state**. An earlier design draft's conservative "floor-only → fail-closed" default is a *proposal, not an unconditional code mandate*: for authenticated floor-only with no Phase-B committed evidence, preserve the prior accepted compatibility behavior. If safe classification of floor-only partial loss is impossible without new trusted metadata, document `BLOCKED_DESIGN_CONFLICT` and propose Owner options; do not introduce a breaking blanket rejection.

Similarly do not copy `candidate-overlay-058.diff` whole: it removes epoch-floor from the prior-state predicate and changes UAT-only close gate/trust anchor. The desired minimal native-custody correction, if necessary, must be independent of UAT gates and authorization changes. Preserve symlink-aware `manifest_path_state` and existing committed version/inventory validation.

## 3. Exact execution guardrails / mutation boundary

**Authorised implementation ONLY in a new isolated local clone** created from the *local tracked Git baseline* at the above pinned commit. Suggested fresh non-synced path (must be ABSENT; no overwrite): `C:\Users\Narachat\TPOS-MP1-CAND-N-ISO-20261121`. Never run mutating commands from the original `C:\Users\Narachat\twinpet-pos` or protected UAT directories. A local clone in a new path is allowed; a Git worktree attached to the original repo, checkout/reset/clean of original repo, touching `stash@{0}` or `ops/lib` is NOT. No network to fetch/change remote.

**Source-code allowlist IN CLONE ONLY:** 
- `src-tauri/src/durable_kv.rs`
- `src-tauri/src/epoch_floor.rs`

Existing inline Rust unit tests in these files may be added/modified if possible; no other source/test, manifest, lockfile, generated artifact or repo file edits. If tests cannot be implemented without additional files, stop and propose additional file allowlist; do NOT unilaterally expand. Working-copy Cargo test outputs and compiler caches restricted to isolated clone/`target`; no install, no app launch, no profile access.

**Only output/report outside isolated clone:** `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Claude\TPOS-MP1-CAND-N-001-NATIVE-CUSTODY-IMPLEMENTATION-CLAUDE-REPORT.md` (create directory only as necessary). No source files, temporary files or transcripts in OneDrive. Do not include secrets in report.

**Explicitly NOT authorised:** edits to `main`, branch push, commit, PR, merge, Firebase/Rules/Functions/network, PROD, native exe/app start, NSIS, real AppData, data migration of existing profile, Stage056/058/061–065 artifacts, Gate-ON, deviceId.ts / Candidate I, sale journal, privileged action, stock or UAT patch replay. Official `SERVER_AUTHORITATIVE_CLOSE_ENABLED=false` must remain unchanged. No agent may self-authorize subsequent packets.

## 4. Deterministic preflight

1. Validate original repo path, HEAD `f034301...`, branch `main`, tracked status and protected untracked set; **read only** original repo. Original previously had `?? ops/lib/`; never inspect or alter it. If baseline wrong/dirty or ambiguous, STOP `BLOCKED_PREFLIGHT` with no clone/build.
2. Confirm isolated destination path is ABSENT. Local clone should not include untracked content; checkout **detached pinned commit** inside isolated destination only. Never copy `.env` files, AppData, stash or protected UAT trees.
3. Read `AGENTS.md`, `docs/skills/SKILL-OFFLINE-FIRST-POS.md`, `SKILL-GLOBAL-ARCHITECTURE.md`, `docs/agent-workflow/AUTHORITY_MATRIX.md` and relevant source. Record SHA and expected exact mutation allowlist.
4. Use a single local execution; do not run network-dependent commands. If Cargo dependencies unavailable offline, mark targeted tests `NOT_RUN_DEPENDENCY_BLOCKED`, no fetch.

## 5. Implementer sequence

1. **Inspect source conditions** for virgin/prior Phase-B predicate, manifest pathname validity, startup integrity, `open_or_create_manifest_if_virgin`, `DurableKvEngine::begin`, floor compatibility. Compare with 058 native hunk by *read-only observation*; no patch apply.
2. **Before code edits, write a brief design choice to report**: (a) minimal fix proven needed, (b) `NO_CODE_CHANGE_REQUIRED` if current main already meets N1–N3 and overlay is unsafe, or (c) `BLOCKED_DESIGN_CONFLICT` if floor-only state cannot be classified without a business/compatibility decision. Never force a code change just because packet says implementation.
3. If a needed correction is proven and fits two-file allowlist, change the smallest possible logic and add narrowly focused inline Rust tests. Preserve currently accepted security and legitimate auth-only floor compatibility.
4. **Synthetic tests only, optional if offline toolchain/deps available:** targeted Rust `cargo test --offline` with test filter(s), compile with offline mode if feasible. Synthetic tmp roots under the isolated clone or controlled OS temp that are positively verified as test-only; never use `%APPDATA%\com.twinpet...` or any real appdata. No global test suite, native GUI, power reset/VM, production, network, install, env reads. Skip/reason if no safe isolated root or long baseline test runs.
5. Verify changed tracked file list is subset of allowlist; unchanged original repo and untracked contents untouched. Produce hash/diff statistics and focused test assertions without adding a commit. Classify as `READY_FOR_INDEPENDENT_REVIEW`, `NO_CHANGE_REQUIRED`, `BLOCKED_PREFLIGHT`, `BLOCKED_DESIGN_CONFLICT`, or `FAILED_TARGETED_TESTS`. A `READY_FOR_INDEPENDENT_REVIEW` is **not M1 PASS or release approval**.
6. Do not call Codex or start Candidate I/MP1.3 automatically. Stop after one report. Owner/ChatGPT will arrange a **separate Codex reviewer session** with read-only file diff and independent acceptance review, including existing behavior/compatibility.

## 6. Acceptance matrix N1–N3 (no invented PASS)

| ID | Synthetic case/oracle | Special boundary |
|---|---|---|
| N1a | Truly clean root (no floor, manifest, domain and no prior auth state) may initialize virgin safely | Fresh fixture path only |
| N1b | Legitimate privilege-auth-only floor (epoch 2) with no Phase-B manifest remains compatible | **Do not blanket reject floor-only** |
| N1c | Floor-only after *possible* partial loss cannot be confidently called virgin without trusted evidence | If indistinguishable from N1b, **BLOCKED_DESIGN_CONFLICT**, not guess |
| N2a | Existing valid manifest/domain reopens same committed epoch | No new domain on reopening |
| N2b | Manifest corrupt/unsupported version/unreadable, path directory, dangling symlink or invalid inventory fails closed | No false absence, no unsafe fallback |
| N3a | Interrupted migration plus floor/schema compatibility cannot downgrade committed epoch or silently delete data | Preserve byte-for-byte evidence, isolated fixture |
| N3b | Missing-domain and symlink/data bearing artifacts do not cause false virgin reset | Does not inspect real profile |

## 7. Report / handoff contract

- First line `VERDICT: <exact value>`; summarize whether code changed, what and why. Evidence labels `SOURCE_VERIFIED / TEST_VERIFIED / REPORT_ONLY / UNKNOWN`.
- Original `main` pinned SHA and unchanged original tracked + `ops/lib` sentinel; isolated clone path and detached SHA.
- Decision table for N1–N3, including **legitimate floor-only privileged-auth case**; unproven risks not hidden.
- Exact changed file paths and small diff summary; total changes limited to allowlist; no .env/secrets.
- Targeted test commands, pass/fail/skipped and sanitized output; note if tests not run due to offline deps/time. No fabricated PASS.
- Concise next independent review checklist for Codex (NOT automatically executed); one Owner decision/recommendation. Do not request merge/release.

## 8. STOP

If anything deviates from safe path, baseline, no-network rule, two-file allowlist, auth-only floor compatibility or synthetic-test isolation, do **not** escalate into a fix loop. Write a `BLOCKED_*` report and stop. Candidate I, MP1.3, MP2, MP3 remain locked.

References: `docs/planning/MP1-P01-NATIVE-CUSTODY-IDENTITY-SAFETY-PLAN.md`, MP1-R01 report, and live workflow trio.
