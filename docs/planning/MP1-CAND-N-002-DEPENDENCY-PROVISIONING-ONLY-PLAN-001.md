# MP1 N-002 — Dependency Provisioning ONLY / Owner-approved planning packet

**Date:** 2026-11-22 · **Decision:** Owner authorizes creating a **plan + full Codex Prompt** for N-002 *dependency provisioning only*, split from Build, identifying official npm/crates.io sources, integrity, network scope and residual risk **before real execution**. **Not an authorization to download, npm install, Cargo fetch, compile or test yet.** Previous all-in-one N-002 attempt ended `BLOCKED_NETWORK_ISOLATION`; the prior temporary C: <10 GiB Build waiver is closed; standard >=10 GiB Build preflight unchanged.

**Current status:** `OWNER_APPROVED_READONLY_PLANNING / PROMPT_PREPARED / CODEX_PREFLIGHT_NOT_YET_RUN / NETWORK_FETCH_NOT_AUTHORIZED / BUILD_NOT_AUTHORIZED`.

## Source evidence and fixed boundaries
- Original `C:\Users\Narachat\twinpet-pos` main and detached independent clone `C:\Users\Narachat\TPOS-MP1-CAND-N-ISO-20261121`, baseline SHA `f034301c46dd9e08190f869cc85dbb140ac28a3c`; exact two previously modified source files remain protected. Source/Master Plan main/Cloud/Production/real POS AppData/UAT023/Gate-OFF/Offline First unchanged. No source modification, no new clone, no GUI, no cleanup, no external downloads, no deployment.
- Pinned Github `package-lock.json` read-only inspection: lockfile version 3 with **1,088 non-root package records**, and for every explicit resolved URL, HTTPS `registry.npmjs.org` with integrity fields; no links. This does **not** prove all entries must be installed, safety of packages, future redirects, effective registry config, or actual host usage.
- Pinned `src-tauri/Cargo.lock` contains only canonical `registry+https://github.com/rust-lang/crates.io-index` registry identity and no Git-sourced packages; use sparse registry transport in a future approved execution, not GitHub index automatically.
- Last Windows report 14:27+07 (prior packet) observed C: `5,870,264,320` bytes and D: `999,109,189,632` bytes free, NTFS Healthy; these were point samples only. No continuous watcher or long-term USB write reliability was proven. D: work root remained absent; no package fetch/Build occurred.
- Required future workspace under **`D:\Twinpet-POS\Twinpet-N002-Build-20261122`** only. Store Prompt in **`C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Prompt\`**, Report in **`C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\`**. Never redirect Prompt/Report to D:.

## Official sources proposed — NOT contacted or approved for fetch yet
| Tool / purpose | Planned official HTTPS endpoint | Condition |
|---|---|---|
| npm lockfile tarballs/metadata | `https://registry.npmjs.org/` | Pinned SHA/SRI, canonical exact host; `--ignore-scripts --no-audit --no-fund`; no unreviewed redirects, alternate mirrors or user credentials |
| Cargo sparse registry index | `https://index.crates.io/` | Process-local sparse Cargo protocol, source-overrides audited |
| Cargo crate archives | `https://static.crates.io/` | Locked packages, check downloaded artifact against Cargo.lock checksum |
| Other hosts, e.g. `github.com`, `crates.io` API, Firebase/Cloud/ZORT | **Not allowed by default** | Separate justification and explicit Owner decision, never implicit permission |

Official reference URLs (background only, not permission to fetch): [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [npm config](https://docs.npmjs.com/using-npm/config/), [Cargo configuration](https://doc.rust-lang.org/cargo/reference/config.html), [crates.io architecture](https://github.com/rust-lang/crates.io/blob/main/docs/ARCHITECTURE.md).

## Residual risk requiring explicit Product Owner decision
1. **Package compromise:** matching lockfile/SRI shows byte consistency, not benign or trusted code. npm `--ignore-scripts` suppresses package lifecycle scripts but is not a universal supply-chain sandbox; disabled postinstall may affect optional/native modules.
2. **Unverified network isolation:** lockfile URLs, `--registry`, sparse protocol and TLS alone do **not** enforce preventive allowlisting over every subprocess or follow all redirects safely. Without a separately proven process-specific transport sandbox, zero unexpected egress **cannot** be promised. Owner must knowingly accept the scoped official-registry residual risk or choose HOLD.
3. **Proxy/redirect/config override:** user/machine-level overrides may change actual destinations; read-only Codex inspection must report risk without disclosing tokens; new hosts require STOP and approval.
4. **Disk/USB guardian:** external D not yet proven stable under sustained writing, no verified <=500ms volume monitor / experiment-descendant termination; these must be independently tested **before future substantial package writes**, stopping at C: <=2.25 GiB proactive/hard <=2.00 GiB and D: <=10 GiB/disconnect.
5. **Source/real-data boundary:** package staging is isolated to D with no use of actual POS profile; no GUI, Firebase app or project build in provisioning. Any deviations require a new decision.

## Sequence, gates and deliverables
**Stage P0 (authorized in this turn; Codex read-only):** Owner saves full Prompt, runs short inline Launcher directing Codex to inspect pinned source/lockfiles and actual Windows C/D paths/config **without any network request or filesystem modifications**, and to write one sanitized decision-ready report. No guardian experiment, installing, fetching or D mkdir. Report should conclude `READY_FOR_OWNER_RISK_DECISION` or an honest `BLOCKED_*`, never `PROVISIONED`.

**Gate P1 (NOT YET AUTHORIZED):** Owner reviews Codex risk register and separately accepts a clearly limited provisioning-only execution scope and any inability to guarantee hard network egress control. If approved, a subsequent packet provisions pinned npm and Cargo packages in D using a tested experiment-owned child-process guardian and disk monitor; no Build. If not accepted, HOLD.

**Gate P2 (NOT YET AUTHORIZED):** Only after independently verified dependency staging and new Owner authorization, a future offline Build can use existing detached candidate with normal real C: `dist` (not junction), D: Cargo target/caches, and an independent single-use C <10 GiB exception if still below default gate. No M1/merge/release inferred from successful compilation; F-01/F-02 remain OPEN.

**Full Prompt artifact:** `TPOS-MP1-CAND-N-002-DEPENDENCY-PROVISIONING-ONLY-PLAN-CODEX-PROMPT.md`, to be placed by Owner under canonical OneDrive Prompt directory. **Only short inline Launcher; NO Launcher file.**

**Expected Codex Report:** `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\TPOS-MP1-CAND-N-002-DEPENDENCY-PROVISIONING-ONLY-PLAN-CODEX-REPORT.md`.

**Execution attestation:** ChatGPT has **not** run Codex CLI, touched Windows disk, contacted any registry, generated D scratch, provisioned a dependency or built software in this task. Planning-document changes happen on GitHub **planning branch only**, not Source/main. **M1 NOT_PASS; F01/F02 OPEN; Merge/Release not authorized.**
