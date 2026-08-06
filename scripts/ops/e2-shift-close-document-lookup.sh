#!/bin/bash
# P-OBS-1 Remediation-3: pure-policy trust-facts evaluator
# (--evaluate-trust-facts-v1) and POSIX/WSL-aware production E-2 shift-close
# document lookup (no-argument mode).
#
# Two closed invocation modes only. Evaluator mode never performs a lookup
# and never emits a production result. Production mode never emits
# POLICY_* / INPUT_REJECT. Sole executable owner of this contract — see
# docs/ops/packet-5-monitoring-runbook.md section 9 for the summary; this
# file is not duplicated elsewhere.
#
# Fixed, non-searching shebang (R2-F3/R2-F6): no `/usr/bin/env bash`, no
# PATH-based interpreter lookup. A host whose Bash does not live at
# /bin/bash must be invoked explicitly through its own already-resolved
# canonical Bash (`<canonical-bash> --noprofile --norc <script> ...`); see
# the runbook for the operator contract.

# -----------------------------------------------------------------------
# RC-3 — source refusal. This is the very first thing the interpreter can
# execute: before `set`, before `umask`, before traps, before any temporary
# artifact, before token acquisition. A `source`/`.` attempt must never
# mutate caller state.
# -----------------------------------------------------------------------
if [ "${BASH_SOURCE[0]:-}" != "${0:-}" ]; then
  printf 'E2_ERROR must_not_be_sourced\n' >&2
  return 2 2>/dev/null
  exit 2
fi

set -euo pipefail
umask 077
\unalias -a 2>/dev/null || true
set +h
hash -r 2>/dev/null || true
unset -f stat od uname findmnt mount curl gcloud node bash realpath \
  mktemp rm head grep xxd iconv cat base64 chmod cd pwd dirname basename \
  2>/dev/null || true

# ---------------------------------------------------------------------------
# Fixed constants
# ---------------------------------------------------------------------------
readonly E2_PROTO_HEADER='TWINPET_E2_TRUST_FACTS_V1'
readonly E2_PROTO_TERMINATOR='END'
readonly E2_MAX_RECORDS=64
readonly E2_MAX_STDIN_BYTES=65536
readonly E2_TRUSTED_PATHS=('/' '/usr' '/usr/bin' '/usr/bin/stat' '/usr/bin/od')

readonly E2_PRODUCTION_ORIGIN='https://firestore.googleapis.com'
readonly E2_PROJECT_ID='twinpet-pos'
readonly E2_DATABASE_ID='pos-db'

# Sorted literal state allowlists, populated from
# functions/src/shiftCloseValidationTypes.ts (PROCESSING_STATES /
# SETTLEMENT_STATES / ALERT_STATES) — membership only; order here is
# alphabetical for readability and does not affect matching.
readonly E2_PROCESSING_STATES=(
  awaiting_dependencies
  permanently_unverifiable
  queued
  requires_operator_review
  retryable_error
  validated
  validating
)
readonly E2_SETTLEMENT_STATES=(
  manual_review_required
  manually_resolved
  provisional_match
  unsettled
)
readonly E2_ALERT_STATES=(
  acknowledged
  none
  open
  resolved
)

# ---------------------------------------------------------------------------
# R2-F1 — exact, platform-specific, compiled fixed-root tables. There is no
# cross-platform flat array and no Windows root anywhere in this file.
# FIXED_ROOTS_OTHER has no entries: a host whose $OSTYPE is neither
# `linux-gnu*` nor `darwin*` gets an empty E2_FIXED_ROOTS, so every resolver
# call structurally fails closed (see e2_resolve_attested_candidate) without
# ever touching an external tool — see R2-F2 below for the selection order.
#
# Removed as production trusted roots (Codex Remediation-2 finding
# R2-F1-ROOT-TABLE): /opt/google-cloud-sdk/bin,
# /usr/local/google-cloud-sdk/bin, /snap/google-cloud-sdk/current/bin,
# /mingw64/bin, /c/Program Files/nodejs. None of those may become
# selectable again via E2_TOOL_MANIFEST — a manifest may only choose an
# index that already exists in the *current platform's* compiled table
# (see e2_parse_tool_manifest); it can never add a root or supply a path.
#
# R3-F3 (Remediation-4, binding Gemini ruling) — /sbin is restored as a
# Darwin-only root at index 5, holding Darwin's real `mount` binary
# (traditionally /sbin/mount; `mount` is not installed under /usr/bin on a
# stock macOS host). /sbin is Darwin-only: it does not exist in
# E2_FIXED_ROOTS_LINUX or E2_FIXED_ROOTS_OTHER, so Linux/Other can never
# select it — see the Darwin-only rootIndex bootstrap override below and
# e2_parse_tool_manifest's platform-local bounds check.
# ---------------------------------------------------------------------------
readonly -a E2_FIXED_ROOTS_LINUX=(
  '/usr/bin'                        # 0
  '/bin'                             # 1
  '/usr/local/bin'                   # 2
  '/usr/lib/google-cloud-sdk/bin'    # 3
)
readonly -a E2_FIXED_ROOTS_DARWIN=(
  '/usr/bin'                              # 0
  '/bin'                                   # 1
  '/usr/local/bin'                         # 2
  '/opt/homebrew/bin'                      # 3
  '/usr/local/share/google-cloud-sdk/bin'  # 4
  '/sbin'                                  # 5 (Darwin-only, R3-F3)
)
readonly -a E2_FIXED_ROOTS_OTHER=()

# Fixed basenames — the complete retained-external-tool inventory. `realpath`
# is newly retained here (R2-F4): the full-path canonicalizer now prefers a
# validated `realpath -e`, falling back to a validated Node `realpathSync`
# only when `realpath` itself cannot be resolved/attested (e.g. BSD/Darwin
# realpath, which has no `-e` flag). `wc`/`tr` remain eliminated (bash
# parameter expansion / `stat -c`/`-f` size queries cover their uses).
# `bash` is newly retained here (R3-F7, Remediation-4): the running
# interpreter's own identity is now resolved/attested/canonicalized exactly
# like every other retained tool, so it can be compared against the actual
# running `$BASH` — see e2_verify_running_bash_identity.
readonly -A E2_FIXED_BASENAME=(
  [stat]='stat' [od]='od' [uname]='uname' [findmnt]='findmnt' [mount]='mount'
  [curl]='curl' [mktemp]='mktemp' [rm]='rm' [node]='node' [gcloud]='gcloud'
  [head]='head' [grep]='grep' [xxd]='xxd' [iconv]='iconv' [cat]='cat'
  [base64]='base64' [chmod]='chmod' [realpath]='realpath' [bash]='bash'
)

# Compiled default rootIndex per tool (manifest-overridable within the
# selected platform's table only; see e2_parse_tool_manifest). `gcloud`'s
# default is platform-specific (set once OSTYPE selects a table, below —
# index 3 on Linux, index 4 on Darwin, both the real Cloud SDK bin
# directory for that platform). `mount`'s compiled default is index 0
# (/usr/bin) but is overridden to Darwin's index 5 (/sbin) once OSTYPE
# selects the Darwin table (R3-F3) — Linux/Other never override it, so
# `mount` stays at index 0 there (Linux `mount` really is under
# /usr/bin on every accepted distribution; Other never resolves anything).
# `bash` defaults to index 1 (/bin), matching this file's own fixed
# `#!/bin/bash` shebang (R3-F7). Everything else defaults to index 0
# (/usr/bin, present in both compiled tables).
declare -A E2_DEFAULT_ROOT_INDEX=(
  [stat]=0 [od]=0 [uname]=0 [findmnt]=0 [mount]=0
  [curl]=0 [mktemp]=0 [rm]=0 [node]=0 [gcloud]=0
  [head]=0 [grep]=0 [xxd]=0 [iconv]=0 [cat]=0 [base64]=0 [chmod]=0
  [realpath]=0 [bash]=1
)

# Populated once OSTYPE selects a platform table — see the R2-F2 bootstrap
# block near the bottom of this file (top-level statements run in source
# order; every function below is only ever *called* after that block runs).
E2_FIXED_ROOTS=()
E2_PLATFORM_TABLE=""
E2_CONFIRMED_PLATFORM=""
declare -A E2_ACTIVE_ROOT_INDEX=()
E2_MANIFEST_HOME=""
E2_MANIFEST_TMPDIR=""
E2_STAT_BIN=""
E2_STAT_DIALECT=""
E2_CANON_BIN=""
E2_CANON_KIND=""
E2_CANON_TOOL_NAME=""

# ---------------------------------------------------------------------------
# Direct-child signal model state (G2). At most one direct external child.
# ---------------------------------------------------------------------------
child_pid=""
signal_exit_code=""
cleanup_done=0
child_reaped=0
child_wait_status=""
e2_tmpfiles=()
e2_tmpdir=""

e2_test_mode_active=0
e2_test_diagnostics_active=0
# R4-F1 (Remediation-5) — internal dispatch state only, never read from the
# environment (so it cannot be set by any caller-supplied env, sanitized or
# not): set to 1 exclusively by the host-independent lookup-seam dispatch
# block below, right before it calls e2_run_lookup_seam, when a sanitizer-
# owned test tool bundle directory was supplied. See e2_resolve_lookup_tool.
e2_lookup_use_test_bundle=0

# R5R4-F1 (Remediation-5 Retry-4) — non-forgeable bundle-provenance trust
# root. Fixed empty in every checked-in copy of this file and never
# assigned from the environment, a bundle-directory file, or any other
# caller-suppliable input — the only thing that can ever change this value
# is text substitution performed by ops-tests/helpers/runE2Script.ts's
# buildE2TestToolBundle, which writes a *private temporary copy* of this
# script (never this repository file) with a freshly Node-crypto-generated
# token baked directly into that copy's own source text before it is ever
# spawned. Invoking this committed file directly — which is exactly what
# real production dispatch does, and what any hand-written test that
# merely sets E2_TEST_TOOL_BUNDLE_DIR/E2_TEST_TOOL_BUNDLE_NONCE and
# self-authors a directory/marker/manifest/wrappers also does — always
# observes this constant empty, so e2_verify_test_bundle_provenance below
# fails closed regardless of how internally self-consistent that caller's
# forged directory is. See e2_verify_test_bundle_provenance's own comment.
readonly E2_TEST_BUNDLE_CAPABILITY=""

cleanup_once() {
  if [ "$cleanup_done" -eq 1 ]; then
    return 0
  fi
  cleanup_done=1
  # Reached from trap/signal handlers as well as the normal exit path, so it
  # must not depend on cleanup-time resolution: E2_RM_BIN is resolved once,
  # early, before any temp file can exist (see the mode-dispatch section at
  # the bottom of this file). If that early resolution ever failed, the
  # script would already have died via e2_die before any tmpfile existed.
  local f
  for f in "${e2_tmpfiles[@]:-}"; do
    [ -n "$f" ] && [ -e "$f" ] && "${E2_RM_BIN:-/bin/false}" -f "$f" 2>/dev/null
  done
  if [ -n "$e2_tmpdir" ] && [ -d "$e2_tmpdir" ]; then
    "${E2_RM_BIN:-/bin/false}" -rf "$e2_tmpdir" 2>/dev/null
  fi
  return 0
}

# Idempotent: safe to call multiple times (e.g. once from the normal
# post-spawn path and again from a racing signal handler) while guaranteeing
# the underlying `wait "$child_pid"` builtin executes at most once.
reap_child_once() {
  if [ "$child_reaped" -eq 1 ]; then
    return 0
  fi
  if [ -n "$child_pid" ]; then
    # R4-F1 follow-up disclosure (Remediation-5): under `set -e`, a bare
    # `wait "$pid"` whose reaped child exited/was-signaled nonzero is
    # itself a "failing command" and previously aborted the whole script
    # right here — silently, before curl_exit could ever be inspected by
    # its caller. This was unreachable (and thus undetected) on this dev
    # host prior to R4-F1 making a real curl failure (e.g. connection
    # refused) reachable for the first time; the same `|| rc=$?` pattern
    # already used for token-status capture elsewhere in this file (R3-F11)
    # applies here for the identical reason.
    local wait_rc=0
    wait "$child_pid" 2>/dev/null || wait_rc=$?
    child_wait_status=$wait_rc
  fi
  child_reaped=1
  return 0
}

emit_test_state() {
  if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ] \
     && [ "${E2_TEST_EXPOSE_STATE:-}" = "1" ]; then
    printf 'test_state child_reaped=%s cleanup_done=%s\n' "$child_reaped" "$cleanup_done" >&2
  fi
  return 0
}

on_signal() {
  local code="$1"
  trap - HUP INT TERM
  signal_exit_code="$code"
  if [ -n "$child_pid" ]; then
    local kill_target="$child_pid"
    if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ] \
       && [ "${E2_TEST_FORCE_KILL_FAIL:-}" = "1" ]; then
      kill_target="999999"
    fi
    if ! kill -TERM "$kill_target" 2>/dev/null; then
      printf 'child_kill_failed\n' >&2
    fi
  fi
  reap_child_once
  cleanup_once
  emit_test_state
  trap - EXIT
  exit "$code"
}

trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'cleanup_once; emit_test_state' EXIT

# ---------------------------------------------------------------------------
# Output helpers — RC-1 exact grammar
# ---------------------------------------------------------------------------
e2_die() {
  # $1: reason token (closed vocabulary). $2: exit code (2/3/4/5).
  printf 'E2_ERROR %s\n' "$1" >&2
  exit "$2"
}

e2_emit_result() {
  # $1: RESULT token. Remaining args, if any, are already-formatted
  # additional lines (used for EXISTS payloads).
  printf 'RESULT %s\n' "$1"
  shift
  local line
  for line in "$@"; do
    printf '%s\n' "$line"
  done
}

e2_emit_result_reason() {
  printf 'RESULT %s\n' "$1"
  printf 'REASON %s\n' "$2"
}

input_reject() { printf '%s\n' 'INPUT_REJECT'; exit 2; }
policy_reject() { printf '%s\n' 'POLICY_REJECT'; exit 0; }
policy_accept() { printf '%s\n' 'POLICY_ACCEPT'; exit 0; }
policy_not_run() { printf '%s\n' 'POLICY_NOT_RUN'; exit 0; }

# Every path component (including the final path itself) must not be a
# symlink. Builtin `-L` test only.
e2_path_no_symlink_components() {
  local p="$1"
  [[ "$p" == /* ]] || return 1
  local IFS='/'
  local -a parts=($p)
  local cur="" part
  for part in "${parts[@]}"; do
    [ -z "$part" ] && continue
    cur="$cur/$part"
    [ -L "$cur" ] && return 1
  done
  return 0
}

# ---------------------------------------------------------------------------
# R2-F3 — stat-first, attest-all resolver. There is no utility tier: every
# retained tool (including curl/mktemp/rm/node/head/grep/xxd/iconv/cat/
# base64/chmod — not just the five-path trust anchor) is uid==0 / non-
# writable-mode attested via the already-bootstrapped `stat`, then fully
# re-canonicalized via the already-bootstrapped `realpath`/Node
# canonicalizer, with every predicate replayed on the canonical result
# (R2-F4). `stat` itself, and the canonicalizer tool's own candidate during
# its own bootstrap, are the only two exemptions — both are structural
# (attesting a tool with itself is circular), not a policy exemption; see
# e2_bootstrap_stat / e2_bootstrap_canonicalizer.
# ---------------------------------------------------------------------------

# Phase 1: fixed-root + fixed-basename candidate construction, no ambient
# PATH, no symlink component anywhere, regular + executable, and (unless
# explicitly skipped for stat's own bootstrap) uid==0 / mode-attested via
# the already-bootstrapped stat. Returns the *candidate* path — callers
# needing the full R2-F4 canonicalization-and-replay run phase 2 themselves
# (see e2_resolve_canonical); e2_bootstrap_canonicalizer calls this phase
# alone, deliberately stopping short of phase 2, since the canonicalizer
# cannot canonicalize itself before it exists.
e2_resolve_attested_candidate() {
  local tool="$1" skip_stat_check="${2:-0}"
  local idx="${E2_ACTIVE_ROOT_INDEX[$tool]:-}"
  [[ "$idx" =~ ^[0-9]+$ ]] || return 1
  (( idx < ${#E2_FIXED_ROOTS[@]} )) || return 1
  local root="${E2_FIXED_ROOTS[$idx]}"
  local base="${E2_FIXED_BASENAME[$tool]:-}"
  [ -n "$base" ] || return 1
  local candidate="${root}/${base}"

  e2_path_no_symlink_components "$candidate" || return 1
  [ -f "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1

  if [ "$skip_stat_check" -ne 1 ]; then
    [ -n "${E2_STAT_BIN:-}" ] || return 1
    [ -n "${E2_CONFIRMED_PLATFORM:-}" ] || return 1
    local triplet
    triplet=$(e2_stat_triplet_for "$candidate") || return 1
    e2_verify_stat_triplet "$triplet" "$E2_CONFIRMED_PLATFORM" file || return 1
  fi

  printf '%s' "$candidate"
  return 0
}

# Phase 2: full-path canonicalization via the bootstrapped realpath/Node
# canonicalizer, with the complete predicate set re-run on the canonical
# result (R2-F4). A fixed compiled candidate (`root + "/" + basename`, both
# hardcoded, no `.`/`..`/`//`) is already syntactically canonical once every
# component has been proven non-symlink; canonicalization here is a defense-
# in-depth re-check, so the canonical result must equal the original
# candidate exactly — any divergence is treated as untrusted.
e2_canonicalize_full() {
  local candidate="$1" out
  if [ "$E2_CANON_KIND" = "realpath" ]; then
    out=$("$E2_CANON_BIN" -e -- "$candidate" 2>/dev/null) || return 1
  else
    out=$(E2_CANON_TARGET="$candidate" "$E2_CANON_BIN" --input-type=module -e '
      import { realpathSync } from "node:fs";
      try {
        process.stdout.write(realpathSync(process.env.E2_CANON_TARGET));
      } catch {
        process.exit(1);
      }
    ' 2>/dev/null) || return 1
  fi
  [ -n "$out" ] || return 1
  printf '%s' "$out"
  return 0
}

e2_resolve_canonical() {
  # R3-F5/R3-F6 (Remediation-4): the previous unconditional `[ "$tool" =
  # 'stat' ]` early-return here permanently exempted stat from full-path
  # canonicalization and post-canonical predicate replay on every call, not
  # just its own first-anchor bootstrap call. That exemption is removed.
  # `e2_bootstrap_stat` now calls `e2_resolve_attested_candidate 'stat' 1`
  # directly (phase 1 only) for its own one-time structural first-anchor
  # resolution — the only place stat truly cannot attest itself. Every
  # subsequent call to `e2_resolve_canonical stat` (including the deferred
  # finalization below) goes through the exact same phase-1 + phase-2 path
  # as every other tool: attested-candidate resolution (now genuinely
  # self-consistency-checked against the already-bootstrapped E2_STAT_BIN,
  # since skip_stat_check defaults to 0), then full-path canonicalization
  # and complete predicate replay, gated only by whether the canonicalizer
  # is bootstrapped yet (`-n "${E2_CANON_BIN:-}"`) — identical to every
  # other tool's bootstrap-ordering constraint, not a stat-specific one.
  local tool="$1"
  local candidate

  candidate=$(e2_resolve_attested_candidate "$tool") || return 1

  local canon="$candidate"
  if [ "$tool" != "${E2_CANON_TOOL_NAME:-}" ] && [ -n "${E2_CANON_BIN:-}" ]; then
    canon=$(e2_canonicalize_full "$candidate") || return 1
    [ "$canon" = "$candidate" ] || return 1
    e2_path_no_symlink_components "$canon" || return 1
    [ -f "$canon" ] || return 1
    [ -x "$canon" ] || return 1
    local triplet2
    triplet2=$(e2_stat_triplet_for "$canon") || return 1
    e2_verify_stat_triplet "$triplet2" "$E2_CONFIRMED_PLATFORM" file || return 1
  fi

  local canon_dir="${canon%/*}"
  local root_ok=0 r
  for r in "${E2_FIXED_ROOTS[@]}"; do
    if [ "$canon_dir" = "$r" ]; then
      root_ok=1
      break
    fi
  done
  [ "$root_ok" -eq 1 ] || return 1

  printf '%s' "$canon"
  return 0
}

# ---------------------------------------------------------------------------
# R4-F1 (Remediation-5) — sanitizer-owned test-only tool bundle resolver.
# Reachable ONLY through e2_resolve_lookup_tool, itself reachable ONLY from
# inside run_e2_lookup when the host-independent lookup-seam dispatch block
# (near the bottom of this file) has set e2_lookup_use_test_bundle=1 — never
# from production dispatch. Resolves one of the closed E2_FIXED_BASENAME
# tool names (no arbitrary command string) from exactly one absolute
# directory supplied via E2_TEST_TOOL_BUNDLE_DIR: no ambient PATH search, no
# symlink component anywhere in the candidate, regular file, executable.
# Deliberately does NOT run the uid==0/mode-attested stat chain
# e2_resolve_attested_candidate requires: that chain is a claim about
# *system* trust (this file was placed by root, not by an unprivileged
# writer), which is meaningless for a directory the test harness itself
# just created, populated, and will remove for this one process invocation
# (see ops-tests/helpers/runE2Script.ts: buildE2TestToolBundle). It carries
# no production root, is never reachable when e2_lookup_use_test_bundle is
# unset (the default), and never participates in E2_FIXED_ROOTS/rootIndex
# manifest resolution.
# ---------------------------------------------------------------------------
# R5R2-F1/F6 (Remediation-5 Retry-2), extended R5R2-M1 (Remediation-5
# Retry-3) — sanitizer-owned bundle provenance gate. The harness
# (ops-tests/helpers/runE2Script.ts: buildE2TestToolBundle) generates one
# unpredictable nonce via Node crypto for the bundle directory it itself
# creates and populates, writes that nonce into a fixed marker file inside
# that same directory, and supplies the identical nonce via the approved
# E2_TEST_TOOL_BUNDLE_NONCE control (delivered through the same sanitized
# child environment as every other test control). This function reads the
# marker using only the `read` builtin — never cat, never any external
# tool: cat is itself one of the tools whose trust this gate establishes, so
# it cannot be a dependency of establishing that trust — and requires an
# exact match before a single tool candidate in the bundle is ever
# inspected. An arbitrary directory supplied as E2_TEST_TOOL_BUNDLE_DIR
# without the matching harness-written marker (missing marker, stale
# marker, no nonce supplied) fails closed here, before
# e2_resolve_test_bundle_tool below resolves anything.
#
# R5R2-M1 follow-up: the nonce/marker match alone only proves a caller wrote
# a value into a file it fully controls — trivially reproducible by anyone
# who can read this source and knows the marker filename, so it cannot by
# itself bind wrapper *content*. e2_verify_test_bundle_wrapper_content below
# adds the actual binding: a harness-written manifest recording the exact
# bytes of every wrapper this function's caller is about to trust, compared
# byte-for-byte against each wrapper's current on-disk content immediately
# before that wrapper is resolved. Copying/reusing a marker into a directory
# without a matching manifest, forging a manifest that does not describe the
# directory's real wrapper bytes, or editing a wrapper after the bundle was
# built all fail there, not here.
#
# R5R4-F1 (Remediation-5 Retry-4) follow-up: none of the checks above —
# directory, nonce, marker, manifest, wrapper bytes — originate from
# anywhere but the caller-controlled environment and filesystem, so a
# caller able to set approved E2_TEST_* env vars and write files can, by
# construction, reproduce all of them self-consistently. The
# E2_TEST_BUNDLE_CAPABILITY check immediately below is what actually
# closes that gap: it can only be non-empty in a private temporary script
# copy the harness itself wrote (never this checked-in file, never
# anything a caller's own env/fs access can produce), so a fully
# self-consistent forged directory/marker/manifest/wrapper set is still
# rejected here whenever this file is the one actually running.
e2_verify_test_bundle_provenance() {
  local dir="${E2_TEST_TOOL_BUNDLE_DIR:-}" nonce="${E2_TEST_TOOL_BUNDLE_NONCE:-}"
  [ -n "$dir" ] || return 1
  [[ "$dir" == /* ]] || return 1
  [ -n "$nonce" ] || return 1
  [ -n "$E2_TEST_BUNDLE_CAPABILITY" ] || return 1
  [ "$E2_TEST_BUNDLE_CAPABILITY" = "$nonce" ] || return 1
  local marker_path="${dir}/.e2-owner-marker"
  e2_path_no_symlink_components "$marker_path" || return 1
  [ -f "$marker_path" ] || return 1
  local marker=""
  IFS= read -r marker < "$marker_path" 2>/dev/null || return 1
  [ "$marker" = "$nonce" ] || return 1
  return 0
}

# R5R2-M1 (Remediation-5 Retry-3) — content-integrity revalidation. Reads
# the harness-written manifest `.e2-owner-manifest` inside the already
# nonce-gated bundle directory: one line per bundle tool,
# `<tool><TAB><hex-encoded-exact-wrapper-bytes-the-harness-wrote>`. Decodes
# the entry for the requested `tool` (via the existing best-effort
# `e2_pure_hex_decode_raw` — safe here because wrapper content is always
# plain ASCII the harness itself composed, never externally supplied text)
# and requires it to equal `actual_content` — the wrapper's real, freshly
# read, current on-disk bytes — exactly. This is a real content comparison
# against a value the caller cannot derive without already knowing what the
# harness actually wrote for that exact bundle, not a second copy of the
# same nonce check. Bounded: manifest content capped at 8192 bytes (7 short
# lines), hex fields validated as even-length lowercase hex, tool names
# restricted to the closed E2_FIXED_BASENAME vocabulary, no duplicate tool
# entries.
e2_verify_test_bundle_wrapper_content() {
  local tool="$1" actual_content="$2"
  local dir="${E2_TEST_TOOL_BUNDLE_DIR:-}"
  local manifest_path="${dir}/.e2-owner-manifest"
  e2_path_no_symlink_components "$manifest_path" || return 1
  [ -f "$manifest_path" ] || return 1
  local manifest=""
  IFS= read -r -d '' manifest < "$manifest_path" 2>/dev/null || true
  (( ${#manifest} <= 8192 )) || return 1
  local -A seen=()
  local rest="$manifest" line found=0
  while [[ "$rest" == *$'\n'* ]]; do
    line="${rest%%$'\n'*}"
    rest="${rest#*$'\n'}"
    [ -n "$line" ] || continue
    [[ "$line" == *$'\t'* ]] || return 1
    local mtool="${line%%$'\t'*}" mhex="${line#*$'\t'}"
    [ -n "${E2_FIXED_BASENAME[$mtool]:-}" ] || return 1
    [ -z "${seen[$mtool]:-}" ] || return 1
    seen["$mtool"]=1
    [[ "$mhex" =~ ^[0-9a-f]+$ ]] || return 1
    (( ${#mhex} % 2 == 0 )) || return 1
    (( ${#mhex} <= 2048 )) || return 1
    if [ "$mtool" = "$tool" ]; then
      # R5R2-M1 — plain `expected=$(e2_pure_hex_decode_raw "$mhex")` would
      # silently strip a real trailing newline from `expected` (command
      # substitution always strips trailing newlines, independent of the
      # decoder itself) even though the wrapper's actual on-disk content
      # legitimately ends in one — exactly the trailing-LF sentinel-guard
      # problem `e2_classify_host_facts` already documents and fixes for
      # proc_version decoding (R5R2-F3). Applying the identical guard here.
      #
      # R5R5-F3 (Remediation-5 Retry-5) — `|| true` for the same reason as
      # the identical guard on `ft_decoded_guarded` in the canonical
      # fileType check: `e2_pure_hex_decode_raw` can now fail closed
      # (return 1) on an embedded NUL, and this assignment is not inside an
      # `&&`/`||`/`if` context that would otherwise suppress this script's
      # `set -e`. `|| true` leaves `expected` empty on a decode failure,
      # which the very next line already treats as a mismatch (`return 1`)
      # — a real wrapper's content is never empty, so this cannot produce a
      # false accept.
      local expected_guarded expected
      expected_guarded=$(e2_pure_hex_decode_raw "$mhex" && printf 'X') || true
      expected="${expected_guarded%X}"
      [ "$expected" = "$actual_content" ] || return 1
      found=1
    fi
  done
  [ "$found" -eq 1 ] || return 1
  return 0
}

e2_resolve_test_bundle_tool() {
  local tool="$1"
  e2_verify_test_bundle_provenance || return 1
  local dir="${E2_TEST_TOOL_BUNDLE_DIR:-}"
  [ -n "$dir" ] || return 1
  [[ "$dir" == /* ]] || return 1
  local base="${E2_FIXED_BASENAME[$tool]:-}"
  [ -n "$base" ] || return 1
  local candidate="${dir}/${base}"
  e2_path_no_symlink_components "$candidate" || return 1
  [ -f "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1
  # R5R2-M1 (Remediation-5 Retry-3) — revalidate this exact wrapper's
  # content immediately before it is trusted, every time it is resolved.
  local actual_content=""
  IFS= read -r -d '' actual_content < "$candidate" 2>/dev/null || true
  (( ${#actual_content} <= 4096 )) || return 1
  e2_verify_test_bundle_wrapper_content "$tool" "$actual_content" || return 1
  printf '%s' "$candidate"
  return 0
}

# Single tool-resolution seam for run_e2_lookup's own tool needs
# (node/curl/mktemp/rm/chmod/stat). Dispatches to the sanitizer-owned test
# bundle only when e2_lookup_use_test_bundle was explicitly set by the
# host-independent dispatch block; every other caller (real production
# Linux/Darwin dispatch calling run_e2_lookup directly) is completely
# unaffected and keeps using the full production e2_resolve_canonical chain.
e2_resolve_lookup_tool() {
  local tool="$1"
  if [ "$e2_lookup_use_test_bundle" -eq 1 ]; then
    e2_resolve_test_bundle_tool "$tool"
  else
    e2_resolve_canonical "$tool"
  fi
}

# Resolves and attests `realpath` (preferred) or falls back to `node`,
# using only e2_resolve_attested_candidate (phase 1 — component check +
# stat attestation), never e2_resolve_canonical (phase 2 would require the
# canonicalizer to already exist). Must run after e2_bootstrap_stat and
# before any other tool is resolved via e2_resolve_canonical.
e2_bootstrap_canonicalizer() {
  local candidate
  if candidate=$(e2_resolve_attested_candidate realpath); then
    if "$candidate" -e -- "$candidate" >/dev/null 2>&1; then
      E2_CANON_BIN="$candidate"
      E2_CANON_KIND="realpath"
      E2_CANON_TOOL_NAME="realpath"
      return 0
    fi
  fi
  if candidate=$(e2_resolve_attested_candidate node); then
    if "$candidate" -e 'process.exit(0)' >/dev/null 2>&1; then
      E2_CANON_BIN="$candidate"
      E2_CANON_KIND="node"
      E2_CANON_TOOL_NAME="node"
      return 0
    fi
  fi
  return 1
}

# R3-F5/R3-F6 (Remediation-4) — closes the only two structural first-anchor
# exemptions left after e2_bootstrap_stat and e2_bootstrap_canonicalizer
# both succeed: stat could not canonicalize/re-attest itself (no
# canonicalizer existed yet), and the canonicalizer could not canonicalize
# itself before it existed either. Both facts are now resolved: the
# canonicalizer exists and is callable, and stat is bootstrapped and
# self-attesting. This function performs the deferred full-path
# canonicalization for both tools' own fixed candidates through the
# now-available canonicalizer, requires the canonical result to equal the
# original fixed candidate exactly (any divergence is untrusted, same
# defense-in-depth rule every other tool already applies), and replays the
# complete component/regular/executable/uid/mode/type/root predicate set on
# the canonical result via the now-bootstrapped stat. Must be called after
# both e2_bootstrap_stat and e2_bootstrap_canonicalizer succeed, and before
# any production/lookup external work. Not required by (and not called for)
# the pure evaluator/classifier paths, which never bootstrap stat or the
# canonicalizer at all — see the R3-F1 dispatch block near the bottom of
# this file.
e2_finalize_bootstrap_canonical_identity() {
  local tool candidate canon canon_dir root_ok r triplet
  for tool in 'stat' "${E2_CANON_TOOL_NAME}"; do
    case "$tool" in
      stat) candidate="$E2_STAT_BIN" ;;
      *)    candidate="$E2_CANON_BIN" ;;
    esac
    [ -n "$candidate" ] || return 1

    canon=$(e2_canonicalize_full "$candidate") || return 1
    [ "$canon" = "$candidate" ] || return 1
    e2_path_no_symlink_components "$canon" || return 1
    [ -f "$canon" ] || return 1
    [ -x "$canon" ] || return 1

    triplet=$(e2_stat_triplet_for "$canon") || return 1
    e2_verify_stat_triplet "$triplet" "$E2_CONFIRMED_PLATFORM" file || return 1

    canon_dir="${canon%/*}"
    root_ok=0
    for r in "${E2_FIXED_ROOTS[@]}"; do
      if [ "$canon_dir" = "$r" ]; then
        root_ok=1
        break
      fi
    done
    [ "$root_ok" -eq 1 ] || return 1
  done
  return 0
}

# ---------------------------------------------------------------------------
# R2-F1 — closed, bounded, builtin-only rootIndex manifest parser.
#
# Grammar (max 4096 bytes, ASCII-printable + tab/CR/LF only):
#   {"schemaVersion":1,"rootIndex":{"<tool>":<int>,...},"home":"<abs>","tmpdir":"<abs>"}
# `home`/`tmpdir` are accepted syntactically (reserved for future use) but
# not currently consumed by any code path. No arrays, no floats/exponents,
# no unicode escapes, no unknown/duplicate keys, no `trustedRoots`/`tools`
# key, no escape sequences of any kind inside a string (a bare `\` anywhere
# in a quoted string is rejected outright) — the grammar is closed, not a
# general JSON parser. A rootIndex value must be an integer strictly less
# than the *currently selected platform table's* length; there is no
# mechanism by which a manifest can select another platform's table, add a
# root, or supply a path directly. `[[ =~ ]]`/glob matching are bash
# keyword/builtin constructs, not an external regex engine; no external
# JSON parser is used.
# ---------------------------------------------------------------------------
e2_manifest_ascii_safe() {
  local s="$1" i ch n
  n=${#s}
  for ((i = 0; i < n; i++)); do
    ch="${s:i:1}"
    case "$ch" in
      ' '|$'\t'|$'\r'|$'\n') continue ;;
      *) [[ "$ch" == [[:print:]] ]] || return 1 ;;
    esac
  done
  return 0
}

e2_manifest_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Splits object-content (the substring strictly between the outermost `{`
# and `}`) into top-level comma-separated members, tracking quoted-string
# state and nesting depth. Rejects any `[`/`]` (arrays are not part of this
# grammar) and any bare backslash inside a string (no escape sequences
# supported). Echoes one member per line; returns 1 on any structural
# violation.
e2_manifest_split_members() {
  local content="$1"
  local n=${#content} i=0 ch depth=0 in_str=0 start=0
  local -a members=()
  if [ "$n" -eq 0 ]; then
    return 0
  fi
  while (( i < n )); do
    ch="${content:i:1}"
    if [ "$in_str" -eq 1 ]; then
      case "$ch" in
        '\') return 1 ;;
        '"') in_str=0 ;;
      esac
      i=$((i + 1))
      continue
    fi
    case "$ch" in
      '"') in_str=1 ;;
      '[' | ']') return 1 ;;
      '{') depth=$((depth + 1)) ;;
      '}')
        depth=$((depth - 1))
        (( depth < 0 )) && return 1
        ;;
      ',')
        if [ "$depth" -eq 0 ]; then
          members+=("${content:start:i-start}")
          start=$((i + 1))
        fi
        ;;
    esac
    i=$((i + 1))
  done
  [ "$in_str" -eq 0 ] || return 1
  [ "$depth" -eq 0 ] || return 1
  members+=("${content:start:n-start}")
  local m
  for m in "${members[@]}"; do
    printf '%s\n' "$m"
  done
  return 0
}

# $1: one trimmed "key":value member. Prints "key<TAB>value" (value not
# trimmed of surrounding whitespace by this function; caller trims).
e2_manifest_parse_member() {
  local m
  m=$(e2_manifest_trim "$1")
  [ -n "$m" ] || return 1
  [ "${m:0:1}" = '"' ] || return 1
  local rest="${m:1}" key=""
  while :; do
    [ -n "$rest" ] || return 1
    case "${rest:0:1}" in
      '"') rest="${rest:1}"; break ;;
      '\') return 1 ;;
      *) key+="${rest:0:1}"; rest="${rest:1}" ;;
    esac
  done
  rest=$(e2_manifest_trim "$rest")
  [ "${rest:0:1}" = ':' ] || return 1
  rest="${rest:1}"
  printf '%s\t%s' "$key" "$rest"
  return 0
}

e2_manifest_value_is_object() {
  local v
  v=$(e2_manifest_trim "$1")
  [ "${v:0:1}" = '{' ] && [ "${v: -1}" = '}' ]
}

e2_manifest_value_is_string() {
  local v
  v=$(e2_manifest_trim "$1")
  local n=${#v}
  (( n >= 2 )) || return 1
  [ "${v:0:1}" = '"' ] || return 1
  [ "${v:n-1:1}" = '"' ] || return 1
  local inner="${v:1:n-2}"
  [[ "$inner" != *'\'* ]] || return 1
  [[ "$inner" != *'"'* ]] || return 1
  printf '%s' "$inner"
  return 0
}

e2_manifest_value_is_int() {
  local v
  v=$(e2_manifest_trim "$1")
  [[ "$v" =~ ^(0|[1-9][0-9]{0,3})$ ]]
}

# Parses `E2_TOOL_MANIFEST` (if set) into `E2_ACTIVE_ROOT_INDEX`. Returns 0
# and leaves the compiled defaults untouched when the variable is unset or
# empty. Returns 1 on any grammar violation; callers treat that as
# `tool_resolution_failed` (production) or a diagnostic REJECT (test-mode
# resolver diagnostic below) — never a partial/best-effort apply.
e2_parse_tool_manifest() {
  local raw="${E2_TOOL_MANIFEST:-}"
  [ -n "$raw" ] || return 0
  (( ${#raw} <= 4096 )) || return 1
  e2_manifest_ascii_safe "$raw" || return 1
  local trimmed
  trimmed=$(e2_manifest_trim "$raw")
  [ "${trimmed:0:1}" = '{' ] || return 1
  [ "${trimmed: -1}" = '}' ] || return 1
  local content="${trimmed:1:${#trimmed}-2}"

  local -a top_members=()
  local line
  while IFS= read -r line; do
    top_members+=("$line")
  done < <(e2_manifest_split_members "$content") || true
  # Detect split failure: re-run and check exit code directly (process
  # substitution above discards it).
  e2_manifest_split_members "$content" >/dev/null || return 1

  local saw_schema=0 saw_root_index=0 saw_home=0 saw_tmpdir=0
  local -A new_index=()
  for e2_tool_name in "${!E2_DEFAULT_ROOT_INDEX[@]}"; do
    new_index["$e2_tool_name"]="${E2_DEFAULT_ROOT_INDEX[$e2_tool_name]}"
  done
  unset e2_tool_name

  local member kv key value
  for member in "${top_members[@]}"; do
    [ -n "$(e2_manifest_trim "$member")" ] || return 1
    kv=$(e2_manifest_parse_member "$member") || return 1
    key="${kv%%$'\t'*}"
    value="${kv#*$'\t'}"
    case "$key" in
      schemaVersion)
        [ "$saw_schema" -eq 0 ] || return 1
        saw_schema=1
        e2_manifest_value_is_int "$value" || return 1
        [ "$(e2_manifest_trim "$value")" = "1" ] || return 1
        ;;
      rootIndex)
        [ "$saw_root_index" -eq 0 ] || return 1
        saw_root_index=1
        e2_manifest_value_is_object "$value" || return 1
        local ri_trimmed ri_content
        ri_trimmed=$(e2_manifest_trim "$value")
        ri_content="${ri_trimmed:1:${#ri_trimmed}-2}"
        local -a ri_members=()
        e2_manifest_split_members "$ri_content" >/dev/null || return 1
        while IFS= read -r line; do
          ri_members+=("$line")
        done < <(e2_manifest_split_members "$ri_content")
        local -A seen_tools=()
        local ri_member ri_kv ri_key ri_value
        for ri_member in "${ri_members[@]}"; do
          [ -n "$(e2_manifest_trim "$ri_member")" ] || continue
          ri_kv=$(e2_manifest_parse_member "$ri_member") || return 1
          ri_key="${ri_kv%%$'\t'*}"
          ri_value="${ri_kv#*$'\t'}"
          [ -n "${E2_FIXED_BASENAME[$ri_key]:-}" ] || return 1
          [ -z "${seen_tools[$ri_key]:-}" ] || return 1
          seen_tools["$ri_key"]=1
          e2_manifest_value_is_int "$ri_value" || return 1
          local idx
          idx=$(e2_manifest_trim "$ri_value")
          (( idx < ${#E2_FIXED_ROOTS[@]} )) || return 1
          new_index["$ri_key"]="$idx"
        done
        ;;
      home)
        [ "$saw_home" -eq 0 ] || return 1
        saw_home=1
        local home_val
        home_val=$(e2_manifest_value_is_string "$value") || return 1
        [[ "$home_val" == /* ]] || return 1
        E2_MANIFEST_HOME="$home_val"
        ;;
      tmpdir)
        [ "$saw_tmpdir" -eq 0 ] || return 1
        saw_tmpdir=1
        local tmpdir_val
        tmpdir_val=$(e2_manifest_value_is_string "$value") || return 1
        [[ "$tmpdir_val" == /* ]] || return 1
        E2_MANIFEST_TMPDIR="$tmpdir_val"
        ;;
      *) return 1 ;;
    esac
  done
  [ "$saw_schema" -eq 1 ] || return 1

  for e2_tool_name in "${!new_index[@]}"; do
    E2_ACTIVE_ROOT_INDEX["$e2_tool_name"]="${new_index[$e2_tool_name]}"
  done
  unset e2_tool_name
  return 0
}

# ---------------------------------------------------------------------------
# R3-F1 (Remediation-4) — pure Bash-builtin byte/text helpers. The trust-
# facts evaluator (G1) and the pure host-facts classifier (RC-4 classifier
# seam, below) are dispatched before the production platform/tool resolver
# (see the R3-F1 dispatch block near the bottom of this file) and therefore
# must not resolve, invoke, or depend on any external tool — not even the
# stat/canonicalizer trust anchor. Hex-decoding, UTF-8 validation, and
# base64-decoding — previously delegated to `xxd`/`iconv`/`grep`/`base64` —
# are reimplemented here as pure Bash: arithmetic hex-literal expansion
# (`$(( 16#xx ))`) and `printf '%b'` (a Bash builtin, not an external
# process) for byte reconstruction. No external tool is spawned by any
# function in this section, on any host, supported or not.
# ---------------------------------------------------------------------------

# $1: lowercase hex string, even length. Prints the decoded bytes as a Bash
# string and returns 0, or returns 1 (without printing) if any decoded byte
# is NUL (0x00, which cannot be represented in a Bash string and would
# silently truncate output) or CR (0x0d), or if the decoded byte sequence is
# not well-formed UTF-8 (RFC 3629: rejects overlong encodings, UTF-16
# surrogates 0xD800-0xDFFF, and code points above 0x10FFFF).
e2_pure_hex_decode_utf8() {
  # A single `local x="$1" y=${#x}` statement does NOT let y see x's new
  # value: Bash expands every word on the `local` command line (parameter
  # expansion included) before the builtin performs any assignment, so
  # `${#x}` there would read the pre-call (unset) `x` and abort under
  # `set -u`. Each dependent assignment must be its own statement.
  local hex="$1"
  local n=${#hex} i=0 b
  local -a bytes=()
  for ((i = 0; i < n; i += 2)); do
    bytes+=("$(( 16#${hex:i:2} ))")
  done
  local len=${#bytes[@]}
  for b in "${bytes[@]}"; do
    if [ "$b" -eq 0 ] || [ "$b" -eq 13 ]; then
      return 1
    fi
  done
  i=0
  while (( i < len )); do
    b=${bytes[i]}
    if (( b <= 0x7F )); then
      i=$((i + 1))
    elif (( (b & 0xE0) == 0xC0 )); then
      (( b >= 0xC2 )) || return 1
      (( i + 1 < len )) || return 1
      (( (${bytes[i+1]} & 0xC0) == 0x80 )) || return 1
      i=$((i + 2))
    elif (( (b & 0xF0) == 0xE0 )); then
      (( i + 2 < len )) || return 1
      local b1=${bytes[i+1]} b2=${bytes[i+2]}
      (( (b1 & 0xC0) == 0x80 )) || return 1
      (( (b2 & 0xC0) == 0x80 )) || return 1
      local cp=$(( ((b & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F) ))
      (( cp >= 0x800 )) || return 1
      (( cp < 0xD800 || cp > 0xDFFF )) || return 1
      i=$((i + 3))
    elif (( (b & 0xF8) == 0xF0 )); then
      (( i + 3 < len )) || return 1
      local b1=${bytes[i+1]} b2=${bytes[i+2]} b3=${bytes[i+3]}
      (( (b1 & 0xC0) == 0x80 )) || return 1
      (( (b2 & 0xC0) == 0x80 )) || return 1
      (( (b3 & 0xC0) == 0x80 )) || return 1
      local cp4=$(( ((b & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F) ))
      (( cp4 >= 0x10000 && cp4 <= 0x10FFFF )) || return 1
      i=$((i + 4))
    else
      return 1
    fi
  done
  # R5R2-M1 (Remediation-5 Retry-3) — `esc+=$(printf ...)` (one subshell per
  # byte) was found, while building the manifest content-integrity check
  # below, to silently drop a trailing 0x0a byte from the reconstructed
  # string on this host's Bash/printf build whenever that byte lands as the
  # final iteration's own captured output (`$( )` command substitution
  # strips trailing newlines from EACH capture it performs, and this
  # build's printf apparently emits a real trailing newline byte alongside
  # the literal `\xHH` text for that one case) — silent, undetected byte
  # loss for exactly the class of defect this file's decoders are supposed
  # to reject, not reproduce. `printf -v` writes directly into a variable
  # with no command substitution and no such stripping (already the fix
  # applied to `e2_pure_b64_decode_or_dash`'s per-byte loop for performance;
  # here it is required for correctness).
  local esc="" out hexbyte
  for b in "${bytes[@]}"; do
    printf -v hexbyte '\\x%02x' "$b"
    esc+="$hexbyte"
  done
  printf -v out '%b' "$esc"
  printf '%s' "$out"
  return 0
}

# $1: hex string (validated even-length hex by the caller). Best-effort raw
# decode with no UTF-8/CR rejection — used only where the decoded value is
# subsequently compared against a small closed set of known ASCII literals
# (a non-matching result simply fails that comparison; there is no
# injection/interpretation risk at that call site).
#
# R5R5-F3 (Remediation-5 Retry-5) — NUL rejected before Bash string loss.
# Codex's Retry-4 review (R5R4-F3-RAW-HEX-NUL-LOSS) found this function
# still performed no NUL rejection: a Bash string cannot represent an
# embedded NUL byte, so a decoded 0x00 would silently vanish at the
# `printf -v out '%b' "$esc"` reconstruction below, turning e.g. the bytes
# for `directory\0` into the shorter accepted literal `directory` — exactly
# the class of silent byte loss this file's decoders exist to reject, not
# reproduce (the same defect `e2_pure_b64_decode_or_dash` already closed for
# its own decoded bytes — R5R2-M3). Each decoded byte is now checked before
# it is ever appended to `esc`, so a NUL anywhere in the input fails the
# whole decode closed (return 1) exactly like an odd-length/invalid-hex
# input, rather than being silently dropped in the reconstructed string.
# Both live callers (the manifest wrapper-content comparison, the canonical
# fileType check) already treat a decode failure as "does not equal the
# expected/literal value" — no caller here needs to change.
e2_pure_hex_decode_raw() {
  local hex="$1"
  local n=${#hex} i esc="" out hexbyte byteval
  for ((i = 0; i < n; i += 2)); do
    byteval=$(( 16#${hex:i:2} ))
    (( byteval != 0 )) || return 1
    # R5R2-M1 — see e2_pure_hex_decode_utf8's header comment on this exact
    # subshell-per-byte trailing-newline-loss defect; fixed identically here.
    printf -v hexbyte '\\x%02x' "$byteval"
    esc+="$hexbyte"
  done
  printf -v out '%b' "$esc"
  printf '%s' "$out"
  return 0
}

# $1: standard base64 (RFC 4648, '+/' alphabet, '=' padding), or the literal
# "-" for "absent" (prints empty, returns 0). Pure Bash builtin decode — no
# `base64` binary. Rejects non-alphabet characters, wrong padding, and
# non-multiple-of-4 length.
#
# R5R2-M3 (Remediation-5 Retry-3) — a decoded NUL byte (0x00) can never be
# represented inside a Bash string (Bash strings are NUL-terminated at the
# interpreter level), so appending one via `printf -v out '%b' "$esc"` would
# silently truncate the reconstructed string at that byte, turning invalid
# input into a different, shorter accepted string with no signal to the
# caller. This is now detected and rejected explicitly, byte-by-byte, during
# decoding — before any byte is appended to `esc` — so a payload containing
# an embedded NUL fails closed (return 1) exactly like an invalid-alphabet or
# wrong-padding payload, rather than being silently accepted in truncated
# form. Both pure classifier callers below already treat a nonzero return
# from this function as a typed failure (see e2_classify_host_facts: the
# kernel-release/filesystem-lines call sites propagate `return 5`
# internal_parser_error; the proc-version call site already degrades any
# decode failure to an empty proc_version — a pre-existing, documented
# behavior this NUL check now also participates in, not a new failure mode).
e2_pure_b64_decode_or_dash() {
  local b64="$1"
  if [ "$b64" = "-" ]; then
    printf ''
    return 0
  fi
  (( ${#b64} <= 65536 )) || return 1
  [[ "$b64" =~ ^[A-Za-z0-9+/]*(=|==)?$ ]] || return 1
  (( ${#b64} % 4 == 0 )) || return 1
  local input="$b64"
  if [[ "$input" == *== ]]; then
    input="${input%==}"
  elif [[ "$input" == *= ]]; then
    input="${input%=}"
  fi
  local -A val=()
  local alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  local i
  for ((i = 0; i < 64; i++)); do
    val["${alphabet:i:1}"]=$i
  done
  # R5R2-F3 (Remediation-5 Retry-2) — `printf -v` (a Bash builtin) writes
  # each byte's hex escape directly into `hexbyte`, no `$( )` command
  # substitution. The prior `esc+=$(printf ...)` forked one subshell per
  # decoded byte, which is what made a real ~4096-byte payload take on the
  # order of a minute on this host (see the now-removed fork-cost
  # disclosure in the spec) — this loop is now pure builtin arithmetic and
  # string append, linear in input length with no process creation at all.
  local n=${#input} c v bits=0 nbits=0 byteval esc="" out hexbyte
  for ((i = 0; i < n; i++)); do
    c="${input:i:1}"
    v="${val[$c]:-}"
    [ -n "$v" ] || [ "$c" = "A" ] || return 1
    v="${val[$c]}"
    bits=$(( (bits << 6) | v ))
    nbits=$((nbits + 6))
    if (( nbits >= 8 )); then
      nbits=$((nbits - 8))
      byteval=$(( (bits >> nbits) & 0xFF ))
      # R5R2-M3 — reject an embedded NUL before it can ever reach the
      # `printf -v out '%b' "$esc"` reconstruction below (see header
      # comment): detection happens here, one decoded byte at a time, so no
      # partial/truncated `esc` is ever turned into a partial `out`.
      (( byteval != 0 )) || return 1
      printf -v hexbyte '\\x%02x' "$byteval"
      esc+="$hexbyte"
    fi
  done
  printf -v out '%b' "$esc"
  printf '%s' "$out"
  return 0
}

# Bounds/validates an already-decoded (in-memory, no file) text blob against
# the same rules `e2_read_proc_version_bounded` applies to a real file: the
# raw decoded byte length must not exceed 4096 (R5R2-F3, Remediation-5
# Retry-2 — matching `e2_read_proc_version_bounded`'s own `size -ge 4097 ->
# reject` bound exactly, applied *before* any trailing-LF strip, not after;
# the prior `<= 4097` check here was one byte too permissive and applied to
# the wrong quantity, letting a 4097-byte non-LF-terminated payload through
# and letting a 4097-byte payload whose only excess byte was a trailing LF
# escape the bound entirely via the strip below — a 4097-byte decoded input
# is now rejected outright, with or without a trailing LF), no CR, non-empty
# after stripping one optional trailing LF. (No separate NUL check here:
# `content` was itself produced by `e2_pure_b64_decode_or_dash`, which now
# explicitly detects and rejects any embedded NUL byte during decoding
# — R5R2-M3, see that function's header comment — so a NUL-bearing payload
# never reaches this function as decoded content at all; the caller's own
# `pv_rc`/`bound_rc` handling already treats that upstream decode failure the
# same as any other decode failure.)
# Pure Bash — used only by the pure classifier seam (RC-4), which never
# reads a real `/proc/version` file; real production G2 WSL detection
# continues to use `e2_read_proc_version_bounded` unchanged.
e2_pure_bound_text() {
  local content="$1"
  (( ${#content} <= 4096 )) || return 1
  [[ "$content" != *$'\r'* ]] || return 1
  local stripped="$content"
  if [ -n "$content" ] && [ "${content: -1}" = $'\n' ]; then
    stripped="${content%$'\n'}"
  fi
  [ -n "$stripped" ] || return 1
  printf '%s' "$stripped"
  return 0
}

e2_mktemp_file() {
  local mktemp_bin t
  mktemp_bin=$(e2_resolve_canonical mktemp) || e2_die tool_resolution_failed 4
  t=$("$mktemp_bin")
  e2_tmpfiles+=("$t")
  printf '%s' "$t"
}

# Bounded-file byte-size query. Prefers the resolved `stat` (GNU `-c %s`,
# then BSD `-f %z`) over `wc -c`, eliminating `wc` (and the `tr -d ' '` that
# used to strip its whitespace) entirely — one fewer external tool to
# resolve/attest.
e2_file_size() {
  local stat_bin sz
  stat_bin=$(e2_resolve_canonical stat) || e2_die tool_resolution_failed 4
  sz=$("$stat_bin" -c '%s' "$1" 2>/dev/null) || true
  if [ -z "$sz" ]; then
    sz=$("$stat_bin" -f '%z' "$1" 2>/dev/null) || true
  fi
  [ -n "$sz" ] || return 1
  printf '%s' "$sz"
  return 0
}

# Reads the whole (already NUL-free — callers check this first) file into a
# variable using the `read -d ''` builtin and reports whether its last byte
# is a LF. Eliminates `tail -c1 | od -An -tx1 | tr -d ' '` for this specific
# purpose (both call sites below only ever needed this one bit).
e2_file_ends_with_lf() {
  local content
  IFS= read -r -d '' content < "$1" || true
  [ -n "$content" ] || return 1
  [ "${content: -1}" = $'\n' ]
}

run_evaluator() {
  # Pure Bash slurp-all-of-stdin (no external tool). `read -r -d ''` reads
  # until EOF (there is no NUL delimiter in this text protocol) — the
  # standard, reliable idiom; a bounded `read -N` variant was tried first
  # but proved unreliable reading piped stdin on this host's Bash build, so
  # the length bound below is enforced after the full read completes rather
  # than by capping the read itself.
  local content=""
  LC_ALL=C IFS= read -r -d '' content <&0 || true

  local total_bytes=${#content}
  if [ "$total_bytes" -gt "$E2_MAX_STDIN_BYTES" ]; then
    input_reject
  fi

  if [[ "$content" == *$'\r'* ]]; then
    input_reject
  fi

  local ends_with_lf=0
  if [ -n "$content" ] && [ "${content: -1}" = $'\n' ]; then
    ends_with_lf=1
  fi

  local -a lines=()
  # Manual pure-Bash split on LF (no mapfile/process-substitution/here-
  # string): matches the prior file-based `mapfile -t lines < file` exactly
  # — a final LF produces no phantom empty trailing element, and no final
  # LF still yields the trailing partial line as the last element.
  local e2_lines_remaining="$content"
  while [[ "$e2_lines_remaining" == *$'\n'* ]]; do
    lines+=("${e2_lines_remaining%%$'\n'*}")
    e2_lines_remaining="${e2_lines_remaining#*$'\n'}"
  done
  if [ -n "$e2_lines_remaining" ]; then
    lines+=("$e2_lines_remaining")
  fi

  local n=${#lines[@]}
  if [ "$n" -eq 0 ] || [ "${lines[0]}" != "$E2_PROTO_HEADER" ]; then
    input_reject
  fi

  local end_idx=-1 i
  for ((i = 1; i < n; i++)); do
    if [ "${lines[$i]}" = "$E2_PROTO_TERMINATOR" ]; then
      end_idx=$i
      break
    fi
  done

  if [ "$end_idx" -lt 0 ]; then
    input_reject
  fi

  if [ "$end_idx" -ne $((n - 1)) ] || [ "$ends_with_lf" -ne 1 ]; then
    input_reject
  fi

  local record_count=$((end_idx - 1))
  if [ "$record_count" -gt "$E2_MAX_RECORDS" ]; then
    input_reject
  fi

  local -A seen_paths=()
  local -A seen_canonical=()
  local any_record_seen=0
  local verdict_reject=0
  local common_platform=""

  for ((i = 1; i < end_idx; i++)); do
    local line="${lines[$i]}"
    if [ -z "$line" ]; then
      input_reject
    fi

    # Manual tab-split (not `read -a`, which silently drops a trailing empty
    # field because tab is treated as IFS whitespace for trimming purposes
    # even when IFS is narrowed to just the tab character).
    local -a f=()
    local remaining="$line" fidx field
    for ((fidx = 0; fidx < 9; fidx++)); do
      if [ "$fidx" -lt 8 ]; then
        if [[ "$remaining" != *$'\t'* ]]; then
          f=()
          break
        fi
        field="${remaining%%$'\t'*}"
        remaining="${remaining#*$'\t'}"
        f+=("$field")
      else
        if [[ "$remaining" == *$'\t'* ]]; then
          f=()
          break
        fi
        f+=("$remaining")
      fi
    done
    if [ "${#f[@]}" -ne 9 ]; then
      input_reject
    fi

    local platform="${f[0]}" pathHex="${f[1]}" exists="${f[2]}" kind="${f[3]}" \
          isSymlink="${f[4]}" uid="${f[5]}" fmode="${f[6]}" fileTypeHex="${f[7]}" toolVersionHex="${f[8]}"

    [[ "$platform" == "Linux" || "$platform" == "Darwin" ]] || input_reject
    if [ -z "$common_platform" ]; then
      common_platform="$platform"
    elif [ "$platform" != "$common_platform" ]; then
      verdict_reject=1
    fi

    [[ "$pathHex" =~ ^[0-9a-f]+$ ]] || input_reject
    (( ${#pathHex} % 2 == 0 )) || input_reject
    (( ${#pathHex} >= 2 && ${#pathHex} <= 8192 )) || input_reject
    [[ "$exists" == "0" || "$exists" == "1" ]] || input_reject
    [[ "$kind" == "file" || "$kind" == "dir" || "$kind" == "other" || "$kind" == "missing" ]] || input_reject
    [[ "$isSymlink" == "0" || "$isSymlink" == "1" ]] || input_reject

    if [ "$uid" != "-" ]; then
      [[ "$uid" =~ ^[0-9]+$ ]] || input_reject
      (( ${#uid} <= 10 )) || input_reject
      if (( 10#$uid > 4294967295 )); then input_reject; fi
    fi

    if [ "$fmode" != "-" ]; then
      [[ "$fmode" =~ ^[0-7]{4}$ ]] || input_reject
    fi

    if [ "$fileTypeHex" != "-" ]; then
      [[ "$fileTypeHex" =~ ^[0-9a-f]*$ ]] || input_reject
      (( ${#fileTypeHex} % 2 == 0 )) || input_reject
      (( ${#fileTypeHex} <= 512 )) || input_reject
    fi

    [[ "$toolVersionHex" =~ ^[0-9a-f]*$ ]] || input_reject
    (( ${#toolVersionHex} % 2 == 0 )) || input_reject
    (( ${#toolVersionHex} <= 1024 )) || input_reject

    # R5R4-F3 (Remediation-5 Retry-4) — plain `decoded_path=$(e2_pure_hex_decode_utf8
    # "$pathHex")` would silently strip a real trailing 0x0a byte from
    # decoded_path (command substitution always strips trailing newlines,
    # independent of the decoder itself), so a caller-supplied hex path like
    # `/usr\n` could collapse to the accepted canonical fact `/usr` — the
    # exact sentinel-guard fix already applied to
    # e2_verify_test_bundle_wrapper_content's manifest decode.
    local decoded_path_guarded decoded_path
    decoded_path_guarded=$(e2_pure_hex_decode_utf8 "$pathHex" && printf 'X') || input_reject
    decoded_path="${decoded_path_guarded%X}"

    if [ -n "${seen_paths[$decoded_path]:-}" ]; then
      input_reject
    fi
    seen_paths["$decoded_path"]=1
    any_record_seen=1

    local is_canonical=0
    local p
    for p in "${E2_TRUSTED_PATHS[@]}"; do
      if [ "$decoded_path" = "$p" ]; then
        is_canonical=1
        break
      fi
    done

    if [ "$is_canonical" -eq 1 ]; then
      seen_canonical["$decoded_path"]=1
      local expect_kind="dir"
      case "$decoded_path" in
        "/usr/bin/stat"|"/usr/bin/od") expect_kind="file" ;;
      esac

      local fmode_ok=1
      if [ "$fmode" != "-" ]; then
        (( (8#$fmode & 8#0022) == 0 )) || fmode_ok=0
        if [ "$expect_kind" = "file" ]; then
          (( (8#$fmode & 8#0111) != 0 )) || fmode_ok=0
        fi
      else
        fmode_ok=0
      fi

      local filetype_ok=1
      if [ "$fileTypeHex" != "-" ] && [ -n "$fileTypeHex" ]; then
        # R5R4-F3 (Remediation-5 Retry-4) — same sentinel-guard fix as
        # decoded_path above: a plain `$(e2_pure_hex_decode_raw ...)` capture
        # would silently strip a real trailing 0x0a byte, so hex encoding
        # "directory\n" could otherwise collapse to the accepted literal
        # "directory".
        #
        # R5R5-F3 (Remediation-5 Retry-5) — `e2_pure_hex_decode_raw` can now
        # itself fail closed (return 1) on an embedded NUL byte (see its own
        # header comment). Under this script's `set -euo pipefail`, a plain
        # `var=$(cmd)` assignment whose command substitution exits nonzero
        # aborts the whole script here, since this statement sits in
        # ordinary sequential flow, not inside an `&&`/`||`/`if` context that
        # would suppress errexit — exactly the failure this NUL-rejecting
        # decoder never needed guarding against before it could ever return
        # nonzero. `|| true` keeps that failure local: `ft_decoded_guarded`
        # is left empty (nothing was printed before the decoder returned),
        # `ft_decoded` becomes empty, and the `case` below already treats
        # any non-matching value — decode failure included — as
        # `filetype_ok=0`, the same closed-fail outcome a decode success
        # that simply didn't match would produce.
        local ft_decoded_guarded ft_decoded
        ft_decoded_guarded=$(e2_pure_hex_decode_raw "$fileTypeHex" && printf 'X') || true
        ft_decoded="${ft_decoded_guarded%X}"
        case "$platform:$expect_kind:$ft_decoded" in
          "Linux:dir:directory") filetype_ok=1 ;;
          "Linux:file:regular file"|"Linux:file:regular empty file") filetype_ok=1 ;;
          "Darwin:dir:Directory") filetype_ok=1 ;;
          "Darwin:file:Regular File") filetype_ok=1 ;;
          *) filetype_ok=0 ;;
        esac
      else
        filetype_ok=0
      fi

      local toolversion_ok=1
      if [ "$expect_kind" = "file" ]; then
        [ -n "$toolVersionHex" ] || toolversion_ok=0
      fi

      if [ "$exists" != "1" ] || [ "$kind" != "$expect_kind" ] || [ "$isSymlink" != "0" ] \
         || { [ "$uid" != "-" ] && [ "$uid" != "0" ]; } \
         || [ "$fmode_ok" -ne 1 ] || [ "$filetype_ok" -ne 1 ] || [ "$toolversion_ok" -ne 1 ]; then
        verdict_reject=1
      fi
    else
      # "No unexpected sixth path in an accept profile" — any record whose
      # decoded path is not one of the five canonical members forces
      # rejection rather than being silently ignored.
      verdict_reject=1
    fi
  done

  if [ "$any_record_seen" -eq 0 ]; then
    policy_not_run
  fi

  # Complete canonical set required for an accept profile: no missing member.
  local p
  for p in "${E2_TRUSTED_PATHS[@]}"; do
    if [ -z "${seen_canonical[$p]:-}" ]; then
      verdict_reject=1
      break
    fi
  done

  if [ "$verdict_reject" -eq 1 ]; then
    policy_reject
  fi
  policy_accept
}

# ---------------------------------------------------------------------------
# RC-2 — live production trust anchor. `stat` (resolved via the
# fixed-root table above — never a hardcoded ambient path, never
# `type -P`) is the first external trust anchor after builtin-only checks;
# it re-attests itself (via dual-dialect self-probing — see
# e2_bootstrap_stat below, which needs no prior platform knowledge beyond
# the OSTYPE-selected platform); only after stat attests `od` may `od` be
# considered trustworthy. Establishes that the fixed G1 canonical paths are
# legitimate before any of them is relied upon by real (non-fixture)
# production host classification. `uname` is resolved and attested by this
# same chain and is not invoked until after it — see run_production for the
# OSTYPE-vs-`uname -s` cross-check.
# ---------------------------------------------------------------------------
e2_stat_triplet_linux() {
  LC_ALL=C "$1" -c '%u:%a:%F' "$2" 2>/dev/null
}
e2_stat_triplet_darwin() {
  LC_ALL=C "$1" -f '%u:%Lp:%HT' "$2" 2>/dev/null
}

e2_verify_stat_triplet() {
  # $1: "uid:mode:fileType" ; $2: platform ; $3: expected kind (dir|file)
  local triplet="$1" platform="$2" expect_kind="$3"
  [ -n "$triplet" ] || return 1
  local uid mode ftype
  uid="${triplet%%:*}"
  local rest="${triplet#*:}"
  mode="${rest%%:*}"
  ftype="${rest#*:}"
  [[ "$uid" =~ ^[0-9]+$ ]] || return 1
  [ "$uid" = "0" ] || return 1
  [[ "$mode" =~ ^[0-7]+$ ]] || return 1
  (( (8#$mode & 8#0022) == 0 )) || return 1
  if [ "$expect_kind" = "file" ]; then
    (( (8#$mode & 8#0111) != 0 )) || return 1
  fi
  case "$platform:$expect_kind:$ftype" in
    "Linux:dir:directory") return 0 ;;
    "Linux:file:regular file"|"Linux:file:regular empty file") return 0 ;;
    "Darwin:dir:Directory") return 0 ;;
    "Darwin:file:Regular File") return 0 ;;
    *) return 1 ;;
  esac
}

# Stat-first non-circular bootstrap (R2-F2). `$E2_CONFIRMED_PLATFORM` was
# already set from the builtin OSTYPE selection before this runs (see the
# bootstrap block near the bottom of this file), so — unlike the prior
# Remediation-2 design — this no longer probes both dialects to *discover*
# the platform; it tries only the dialect the OSTYPE-selected platform
# implies, and self-attestation success is a *confirmation* of that
# platform, not the mechanism that selects it (`STAT_DIALECT_PLATFORM_
# SELECTION_ACTIVE: NO`).
e2_bootstrap_stat() {
  # R3-F5/R3-F6 (Remediation-4): the one true structural first-anchor call —
  # stat cannot yet be canonicalized (no canonicalizer exists) or
  # self-attested via itself (it IS the attestor). Phase 1 only
  # (fixed-root/basename + component-symlink + regular/executable), via
  # skip_stat_check=1. Full canonicalization and post-canonical predicate
  # replay for this exact candidate happen later, once, in
  # e2_finalize_bootstrap_canonical_identity — see its header comment.
  local candidate
  candidate=$(e2_resolve_attested_candidate 'stat' 1) || return 1

  local triplet
  case "$E2_CONFIRMED_PLATFORM" in
    Linux)
      triplet=$(e2_stat_triplet_linux "$candidate" "$candidate")
      e2_verify_stat_triplet "$triplet" Linux file || return 1
      E2_STAT_BIN="$candidate"
      E2_STAT_DIALECT="gnu"
      return 0
      ;;
    Darwin)
      triplet=$(e2_stat_triplet_darwin "$candidate" "$candidate")
      e2_verify_stat_triplet "$triplet" Darwin file || return 1
      E2_STAT_BIN="$candidate"
      E2_STAT_DIALECT="bsd"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

e2_stat_triplet_for() {
  # $1: path. Uses the already-bootstrapped stat binary/dialect.
  if [ "$E2_STAT_DIALECT" = "gnu" ]; then
    e2_stat_triplet_linux "$E2_STAT_BIN" "$1"
  else
    e2_stat_triplet_darwin "$E2_STAT_BIN" "$1"
  fi
}

e2_verify_trust_anchor() {
  # $1: platform (Linux|Darwin), as confirmed by attested `uname -s` after
  # this function's caller has already run e2_bootstrap_stat successfully.
  local platform="$1"

  local p
  for p in '/' '/usr' '/usr/bin'; do
    [ ! -L "$p" ] || return 1
    local out
    out=$(e2_stat_triplet_for "$p") || return 1
    e2_verify_stat_triplet "$out" "$platform" dir || return 1
  done

  local od_candidate
  od_candidate=$(e2_resolve_canonical od) || return 1
  [ ! -L "$od_candidate" ] || return 1
  local odout
  odout=$(e2_stat_triplet_for "$od_candidate") || return 1
  e2_verify_stat_triplet "$odout" "$platform" file || return 1
  E2_OD_BIN="$od_candidate"

  return 0
}

# R3-F7 (Remediation-4) — running-interpreter identity. `$BASH` (a Bash
# builtin variable set at interpreter startup to the pathname it was
# invoked with) is used only as an *observed* identity to compare, never as
# a supplied trusted path in its own right (a caller could in principle
# reassign it, same as any other shell variable — this function never
# trusts its value directly). The accepted identity is the fixed-root
# `bash` candidate (index 1, i.e. `/bin/bash` on both platforms — matching
# this file's own fixed `#!/bin/bash` shebang), resolved and attested
# through the exact same e2_resolve_canonical path every other retained
# tool uses (full trust predicate: fixed root, no symlink components,
# regular+executable, uid 0, mode 0022 clear, canonicalized, replayed).
# `$BASH` is independently canonicalized through the already-bootstrapped
# canonicalizer and required to equal that attested candidate exactly — an
# explicit canonical launch (`/bin/bash --noprofile --norc script ...`)
# passes; anything else (a different real bash, a symlink, a PATH-relative
# invocation, a test-harness-owned bash candidate on a non-accepted host)
# fails closed. Must run after e2_finalize_bootstrap_canonical_identity and
# before any production/lookup external work; never called for pure
# evaluator/classifier dispatch, which performs no production external work
# at all.
e2_verify_running_bash_identity() {
  local accepted
  accepted=$(e2_resolve_canonical bash) || return 1

  local running="${BASH:-}"
  [ -n "$running" ] || return 1
  [[ "$running" == /* ]] || return 1

  local running_canon
  running_canon=$(e2_canonicalize_full "$running") || return 1
  [ "$running_canon" = "$accepted" ] || return 1
  return 0
}

# gcloud (production only) gets the same full uid/mode/canonical attestation
# as every other retained tool (R2-F3 removed the lighter utility-tier
# check that used to apply here): a real production host is expected to
# install it via an OS package (root-owned, non-symlink) — see the
# E2_FIXED_ROOTS header comment. A per-user/Homebrew-cask install is
# deliberately NOT trusted by this resolver.
e2_resolve_gcloud_trusted() {
  local platform="$1"
  e2_resolve_canonical gcloud
}

# ---------------------------------------------------------------------------
# G2 — POSIX /proc/version bounded reader (Linux only)
# ---------------------------------------------------------------------------
e2_read_proc_version_bounded() {
  # $1: source path. Never taken from an environment override — the real
  # production caller always passes the fixed literal "/proc/version"; the
  # bounded G2 test-fixture seam passes a script-internal tmp path it wrote
  # itself from decoded fixture bytes (see run_host_facts_fixture).
  local src="$1"
  if [ ! -e "$src" ]; then
    printf 'proc_version_open_failed\n' >&2
    return 1
  fi

  local head_bin grep_bin
  head_bin=$(e2_resolve_canonical head) || { printf 'proc_version_read_failed\n' >&2; return 1; }
  grep_bin=$(e2_resolve_canonical grep) || { printf 'proc_version_read_failed\n' >&2; return 1; }

  local tmp
  tmp=$(e2_mktemp_file)
  if ! "$head_bin" -c 4097 "$src" > "$tmp" 2>/dev/null; then
    printf 'proc_version_read_failed\n' >&2
    return 1
  fi

  local size
  size=$(e2_file_size "$tmp") || { printf 'proc_version_read_failed\n' >&2; return 1; }
  if [ "$size" -ge 4097 ]; then
    printf 'proc_version_too_long\n' >&2
    return 1
  fi

  if "$grep_bin" -aUqP '\x00' "$tmp"; then
    printf 'proc_version_nul\n' >&2
    return 1
  fi

  if "$grep_bin" -aUqP '\r' "$tmp"; then
    printf 'proc_version_cr\n' >&2
    return 1
  fi

  local strip_len="$size"
  if [ "$size" -gt 0 ]; then
    if e2_file_ends_with_lf "$tmp"; then
      strip_len=$((size - 1))
    fi
  fi

  if [ "$strip_len" -eq 0 ]; then
    printf 'proc_version_empty\n' >&2
    return 1
  fi

  "$head_bin" -c "$strip_len" "$tmp"
  return 0
}

read_proc_version() {
  e2_read_proc_version_bounded /proc/version
}

# ---------------------------------------------------------------------------
# G2 — WSL classification (pure function; production and the bounded G2
# fixture seam both call this identical body).
# ---------------------------------------------------------------------------
classify_wsl() {
  local kernel_release_lc="$1" proc_version_lc="$2"
  if [[ "$kernel_release_lc" == *"-microsoft-standard-wsl2"* ]] || [[ "$proc_version_lc" == *"microsoft-standard-wsl2"* ]]; then
    printf 'linux_wsl2'
    return 0
  fi
  if [[ "$kernel_release_lc" == *"microsoft"* ]] || [[ "$proc_version_lc" == *"microsoft"* ]]; then
    printf 'linux_wsl1'
    return 0
  fi
  printf 'native_linux'
  return 0
}

# Builtin lowercasing (`${var,,}`) — eliminates `tr '[:upper:]' '[:lower:]'`.
lc() { printf '%s' "${1,,}"; }

# ---------------------------------------------------------------------------
# G2 — findmnt -P parser (Linux)
# ---------------------------------------------------------------------------
unescape_findmnt_value() {
  # Decodes util-linux -P VALUE escaping. Echoes decoded value on stdout;
  # returns 1 on malformed escape sequence.
  local raw="$1" out="" i=0 ch next
  local len=${#raw}
  while (( i < len )); do
    ch="${raw:i:1}"
    if [ "$ch" = '\' ]; then
      next="${raw:i+1:1}"
      case "$next" in
        '\\') out+='\'; i=$((i+2)) ;;
        '"') out+='"'; i=$((i+2)) ;;
        'a') out+=$'\a'; i=$((i+2)) ;;
        'b') out+=$'\b'; i=$((i+2)) ;;
        'f') out+=$'\f'; i=$((i+2)) ;;
        'n') out+=$'\n'; i=$((i+2)) ;;
        'r') out+=$'\r'; i=$((i+2)) ;;
        't') out+=$'\t'; i=$((i+2)) ;;
        'v') out+=$'\v'; i=$((i+2)) ;;
        [0-7])
          local o="${raw:i+1:3}"
          if [[ "$o" =~ ^[0-7]{1,3}$ ]]; then
            local blen=${#o}
            out+=$(printf "\\$(printf '%03o' "$((8#$o))")")
            i=$((i+1+blen))
          else
            return 1
          fi
          ;;
        *) return 1 ;;
      esac
    else
      out+="$ch"
      i=$((i+1))
    fi
  done
  printf '%s' "$out"
  return 0
}

parse_findmnt_line() {
  # Input: one raw findmnt -P line: TARGET="..." FSTYPE="..."
  # Echoes "target<TAB>fstype" on success; returns 1 on malformed line.
  local raw_line="$1"
  local target_raw="" fstype_raw="" saw_target=0 saw_fstype=0
  local rest="$raw_line"
  while [[ -n "$rest" ]]; do
    rest="${rest#"${rest%%[![:space:]]*}"}"
    [[ -z "$rest" ]] && break
    if [[ "$rest" == TARGET=\"* ]]; then
      rest="${rest#TARGET=\"}"
      local val=""
      while [[ "$rest" != \"* ]]; do
        if [[ "$rest" == \\* ]]; then
          val+="${rest:0:2}"
          rest="${rest:2}"
        else
          val+="${rest:0:1}"
          rest="${rest:1}"
        fi
        [[ -z "$rest" ]] && return 1
      done
      rest="${rest#\"}"
      target_raw="$val"
      saw_target=1
    elif [[ "$rest" == FSTYPE=\"* ]]; then
      rest="${rest#FSTYPE=\"}"
      local val=""
      while [[ "$rest" != \"* ]]; do
        if [[ "$rest" == \\* ]]; then
          val+="${rest:0:2}"
          rest="${rest:2}"
        else
          val+="${rest:0:1}"
          rest="${rest:1}"
        fi
        [[ -z "$rest" ]] && return 1
      done
      rest="${rest#\"}"
      fstype_raw="$val"
      saw_fstype=1
    else
      return 1
    fi
  done

  if [ "$saw_target" -ne 1 ] || [ "$saw_fstype" -ne 1 ]; then
    return 1
  fi

  local target fstype
  target=$(unescape_findmnt_value "$target_raw") || return 1
  fstype=$(unescape_findmnt_value "$fstype_raw") || return 1

  # Pure Bash (R3-F1, Remediation-4): a NUL byte can never appear inside a
  # Bash string variable (Bash strings are NUL-terminated at the interpreter
  # level), so only the newline case is reachable/meaningful here; this
  # function is shared by the pure classifier seam (which must resolve no
  # external tool) and real production filesystem classification.
  [[ "$target" != *$'\n'* ]] || return 1
  [[ "$fstype" != *$'\n'* ]] || return 1

  printf '%s\t%s' "$target" "$fstype"
  return 0
}

# ---------------------------------------------------------------------------
# G2 — Darwin mount parser
# ---------------------------------------------------------------------------
parse_mount_line() {
  # <device> on <target> (<fstype>[, options...])
  local raw_line="$1"
  if [[ "$raw_line" != *' on '*' ('*')' ]]; then
    return 1
  fi
  local after_on="${raw_line#* on }"
  local last_paren="${after_on##* \(}"
  if [ "$last_paren" = "$after_on" ]; then
    return 1
  fi
  local target="${after_on% \(*}"
  local fstype_and_opts="${after_on##* \(}"
  fstype_and_opts="${fstype_and_opts%)}"
  if [[ "$after_on" != *")" ]]; then
    return 1
  fi
  if [ -z "$target" ] || [ -z "$fstype_and_opts" ]; then
    return 1
  fi
  local fstype="${fstype_and_opts%%,*}"
  fstype="${fstype# }"
  fstype="${fstype% }"
  if [[ "$target" == *'('* ]] || [[ "$target" == *')'* ]]; then
    return 1
  fi
  # Pure Bash (R3-F1, Remediation-4): a NUL byte can never appear inside a
  # Bash string variable (Bash strings are NUL-terminated at the interpreter
  # level), so only the newline case is reachable/meaningful here; this
  # function is shared by the pure classifier seam (which must resolve no
  # external tool) and real production filesystem classification.
  [[ "$target" != *$'\n'* ]] || return 1
  [[ "$fstype" != *$'\n'* ]] || return 1
  printf '%s\t%s' "$target" "$fstype"
  return 0
}

# ---------------------------------------------------------------------------
# RC-5 — filesystem-type acceptance table. Pure classifier shared by the
# real findmnt/mount path and the bounded G2 fixture seam. Exactly six
# Linux-accepted, two Darwin-accepted, and ten always-rejected members —
# unchanged from Remediation-1 (Codex confirmed this set exact; see
# REJECTED_FS_MEMBER_COUNT in the diagnostic report).
# fs_ok | fs_rejected | fs_unsupported_type | fs_unrecognized_type | fs_unavailable | fs_parse_error
# ---------------------------------------------------------------------------
classify_filesystem_lines() {
  local platform="$1"
  shift
  local -a lines=("$@")
  local root_fstype="" line parsed target fstype

  for line in "${lines[@]}"; do
    [ -z "$line" ] && continue
    if [ "$platform" = "Linux" ]; then
      parsed=$(parse_findmnt_line "$line") || { printf 'fs_parse_error'; return 0; }
    else
      parsed=$(parse_mount_line "$line") || { printf 'fs_parse_error'; return 0; }
    fi
    target="${parsed%%$'\t'*}"
    fstype="${parsed#*$'\t'}"
    if [ "$target" = "/" ]; then
      root_fstype="$fstype"
    fi
  done

  if [ -z "$root_fstype" ]; then
    printf 'fs_unavailable'
    return 0
  fi

  if [ "$platform" = "Linux" ]; then
    case "$root_fstype" in
      ext2|ext3|ext4|xfs|btrfs|f2fs) printf 'fs_ok' ;;
      overlay|tmpfs) printf 'fs_unsupported_type' ;;
      9p|drvfs|cifs|smbfs|ntfs|ntfs3|fuseblk|vfat|msdos|exfat) printf 'fs_rejected' ;;
      *) printf 'fs_unrecognized_type' ;;
    esac
  else
    case "$root_fstype" in
      apfs|hfs) printf 'fs_ok' ;;
      *) printf 'fs_unrecognized_type' ;;
    esac
  fi
  return 0
}

# ---------------------------------------------------------------------------
# D1-F3 — RC-4 split seams.
#
# Pure classifier seam (e2_run_pure_classifier): requires only
# E2_TEST_MODE=1 + E2_TEST_DIAGNOSTICS=1 + E2_TEST_HOST_FACTS_V1. Shares the
# identical classify_wsl/classify_filesystem_lines/bounded-proc-version-
# reader logic production uses, but stops at a closed classification token
# and NEVER falls through to lookup — no token acquisition, no gcloud/node
# resolution, no temp lookup body, no socket, no stub request, no RESULT
# output of any kind.
#
# Lookup seam (e2_run_lookup_seam): before any synthetic fact can lead to a
# lookup, requires all four of: test mode, diagnostics, an exact loopback
# origin with a syntactically valid port, and a non-empty E2_TEST_TOKEN —
# checked by this function itself, before it does anything else (not left
# for run_e2_lookup's own downstream RC-6/RC-7 checks to catch after the
# fact, which was Remediation-1's design and is exactly what Codex's
# D1-F3-RC4-SEAM finding required changing). Only once all four hold does it
# classify the fixture and, on an eligible verdict, fall through to the real
# run_e2_lookup.
# ---------------------------------------------------------------------------
e2_host_facts_present() {
  [ -n "${E2_TEST_HOST_FACTS_V1:-}" ]
}

# Splits the closed 5-field host-facts fixture. Prints a 5-line array via
# global E2_HF_PLATFORM/E2_HF_KR_B64/E2_HF_PV_B64/E2_HF_FSKIND/E2_HF_FS_B64,
# or returns 1 (internal_parser_error) on a malformed fixture.
e2_parse_host_facts_fixture() {
  local raw="$1"
  local -a f=()
  local remaining="$raw" fidx field
  for ((fidx = 0; fidx < 5; fidx++)); do
    if [ "$fidx" -lt 4 ]; then
      if [[ "$remaining" != *$'\t'* ]]; then
        f=()
        break
      fi
      field="${remaining%%$'\t'*}"
      remaining="${remaining#*$'\t'}"
      f+=("$field")
    else
      if [[ "$remaining" == *$'\t'* ]]; then
        f=()
        break
      fi
      f+=("$remaining")
    fi
  done
  [ "${#f[@]}" -eq 5 ] || return 1
  E2_HF_PLATFORM="${f[0]}"
  E2_HF_KR_B64="${f[1]}"
  E2_HF_PV_B64="${f[2]}"
  E2_HF_FSKIND="${f[3]}"
  E2_HF_FS_B64="${f[4]}"
  [[ "$E2_HF_PLATFORM" == "Linux" || "$E2_HF_PLATFORM" == "Darwin" ]] || return 1
  [[ "$E2_HF_FSKIND" == "findmnt" || "$E2_HF_FSKIND" == "mount" || "$E2_HF_FSKIND" == "none" ]] || return 1
  return 0
}

# Shared classification core: given a parsed fixture, returns one of
# NOT_RUN_WSL1_UNSUPPORTED / NOT_RUN_FILESYSTEM_TYPE_* / "ELIGIBLE" via
# stdout, or calls e2_die internal_parser_error on a structural fault. Never
# touches a token, a socket, or emits a RESULT line — used by both seams.
# Never calls e2_die directly (same reasoning as e2_get_access_token_
# production / e2_get_access_token above): every caller invokes this via
# `verdict=$(...)` command substitution, so an `exit` inside it would only
# terminate that subshell, not the real script. Failures are signaled by
# return code only: 5 = internal_parser_error (R3-F1, Remediation-4: this
# function is now pure Bash end to end — base64 decode and proc-version
# bounding use `e2_pure_b64_decode_or_dash`/`e2_pure_bound_text`, not
# `base64`/`mktemp`/`head`/`grep` — so tool_resolution_failed can no longer
# occur here; the pure classifier seam that calls this is reachable and
# fully substantive on any host, including one with no resolvable external
# tools at all).  The caller, at the true top level, is responsible for
# calling e2_die.
e2_classify_host_facts() {
  local kernel_release proc_version
  kernel_release=$(e2_pure_b64_decode_or_dash "$E2_HF_KR_B64") || return 5

  proc_version=""
  if [ "$E2_HF_PV_B64" != "-" ]; then
    # R5R2-F3 (Remediation-5 Retry-2) — `$( )` command substitution strips
    # ALL trailing newlines from whatever it captures, unconditionally.
    # Without the trailing `X` sentinel guard, a decoded payload ending in
    # LF (or LFs) silently loses them right here, before e2_pure_bound_text
    # ever sees the true decoded length — which was masking the exact
    # 4096/4097 boundary for any LF-terminated payload (a 4097-byte decoded
    # blob ending in LF was captured as only 4096 bytes and wrongly
    # accepted). Appending a non-newline sentinel after the real decode
    # output, then stripping exactly that sentinel back off, guarantees the
    # captured string's last byte is never a newline, so nothing the
    # decoder actually produced is silently dropped here.
    local pv_decoded_guarded pv_decoded pv_rc=0
    pv_decoded_guarded=$(e2_pure_b64_decode_or_dash "$E2_HF_PV_B64" && printf 'X') || pv_rc=1
    if [ "$pv_rc" -eq 0 ]; then
      pv_decoded="${pv_decoded_guarded%X}"
      local bound_rc=0
      proc_version=$(e2_pure_bound_text "$pv_decoded" && printf 'X') || bound_rc=1
      proc_version="${proc_version%X}"
      if [ "$bound_rc" -ne 0 ]; then
        proc_version=""
      fi
      # R5R2-F3 (Remediation-5 Retry-2) — diagnostics-only, test-mode-gated
      # observation of the pure bound's own accept/reject verdict. Every
      # fixture in this describe block reaches the identical final
      # NOT_RUN_FILESYSTEM_TYPE_UNAVAILABLE classification regardless of
      # this outcome (fsKind is 'none'), so without this marker a 4096-byte
      # (accepted) and 4097-byte (rejected) payload would be indistinguishable
      # from the final token alone; this makes the exact boundary test
      # substantive rather than merely "did not crash". Gated behind the
      # same E2_TEST_EXPOSE_STATE control already used for
      # test_state/test_body_created — no new approved test-control key.
      if [ "$e2_test_diagnostics_active" -eq 1 ] && [ "${E2_TEST_EXPOSE_STATE:-}" = "1" ]; then
        printf 'test_proc_version_bound_rc=%s\n' "$bound_rc" >&2
      fi
    else
      # R5R2-M3 (Remediation-5 Retry-3) — diagnostics-only marker for the
      # decode-failed branch (pv_rc != 0), the same category of observation
      # `test_proc_version_bound_rc` already provides for the decode-
      # succeeded branch above. Without this, a decode failure (e.g. an
      # embedded NUL byte, now rejected by e2_pure_b64_decode_or_dash) and a
      # decode success would be indistinguishable from stderr alone — both
      # degrade proc_version to "" and reach the identical final
      # NOT_RUN_FILESYSTEM_TYPE_UNAVAILABLE token in this fsKind:'none'
      # describe block. Gated behind the same E2_TEST_EXPOSE_STATE control;
      # no new approved test-control key.
      if [ "$e2_test_diagnostics_active" -eq 1 ] && [ "${E2_TEST_EXPOSE_STATE:-}" = "1" ]; then
        printf 'test_proc_version_decode_rc=%s\n' "$pv_rc" >&2
      fi
    fi
  fi

  local kernel_release_lc proc_version_lc wsl_class
  kernel_release_lc=$(lc "$kernel_release")
  proc_version_lc=$(lc "$proc_version")
  wsl_class=$(classify_wsl "$kernel_release_lc" "$proc_version_lc")

  if [ "$E2_HF_PLATFORM" = "Linux" ] && [ "$wsl_class" = "linux_wsl1" ]; then
    printf 'NOT_RUN_WSL1_UNSUPPORTED'
    return 0
  fi

  local -a fslines=()
  if [ "$E2_HF_FSKIND" != "none" ]; then
    local decoded
    decoded=$(e2_pure_b64_decode_or_dash "$E2_HF_FS_B64") || return 5
    mapfile -t fslines < <(printf '%s' "$decoded")
  fi

  local fs_class
  fs_class=$(classify_filesystem_lines "$E2_HF_PLATFORM" "${fslines[@]:-}")
  case "$fs_class" in
    fs_ok) printf 'ELIGIBLE'; return 0 ;;
    fs_unavailable) printf 'NOT_RUN_FILESYSTEM_TYPE_UNAVAILABLE'; return 0 ;;
    fs_unrecognized_type) printf 'NOT_RUN_FILESYSTEM_TYPE_UNRECOGNIZED'; return 0 ;;
    fs_unsupported_type|fs_rejected) printf 'NOT_RUN_FILESYSTEM_TYPE_UNSUPPORTED'; return 0 ;;
    fs_parse_error) return 5 ;;
    *) return 5 ;;
  esac
}

# Pure classifier seam (R3-F1, Remediation-4: fully pure Bash, resolves no
# external tool on any host). Requires only test mode + diagnostics +
# fixture presence. Never resolves gcloud/node, never opens a temp lookup
# body, never creates a socket, never emits RESULT/REASON — prints exactly
# one closed classification token and exits.
e2_run_pure_classifier() {
  e2_parse_host_facts_fixture "$E2_TEST_HOST_FACTS_V1" || e2_die internal_parser_error 5
  local verdict rc=0
  verdict=$(e2_classify_host_facts) || rc=$?
  if [ "$rc" -ne 0 ]; then e2_die internal_parser_error 5; fi
  printf '%s\n' "$verdict"
  exit 0
}

# Lookup seam. Before touching the fixture at all, requires: test mode,
# diagnostics, an exact loopback origin (127.0.0.1|localhost with a
# syntactically valid port) on TWINPET_E2_ENDPOINT_BASE_URL, and a non-empty
# E2_TEST_TOKEN. Any missing condition is a hard e2_die — the very refusal
# reasons a real invocation would produce — before any synthetic fact can
# reach classification or lookup.
e2_run_lookup_seam() {
  [ "$e2_test_mode_active" -eq 1 ] || return 1
  [ "$e2_test_diagnostics_active" -eq 1 ] || return 1
  local base_url="${TWINPET_E2_ENDPOINT_BASE_URL:-}"
  if [ "$base_url" = "$E2_PRODUCTION_ORIGIN" ]; then
    e2_die production_host_forbidden_in_test_mode 2
  fi
  e2_host_allowed_test_only "$base_url" || e2_die host_not_allowlisted_for_mode 2
  [ -n "${E2_TEST_TOKEN:-}" ] || e2_die test_token_missing 3

  e2_parse_host_facts_fixture "$E2_TEST_HOST_FACTS_V1" || e2_die internal_parser_error 5
  local verdict rc=0
  verdict=$(e2_classify_host_facts) || rc=$?
  if [ "$rc" -eq 4 ]; then e2_die tool_resolution_failed 4; fi
  if [ "$rc" -ne 0 ]; then e2_die internal_parser_error 5; fi
  case "$verdict" in
    ELIGIBLE)
      run_e2_lookup
      exit $?
      ;;
    *)
      printf '%s\n' "$verdict"
      exit 0
      ;;
  esac
}

# ---------------------------------------------------------------------------
# RC-6 — exact host / origin allowlist.
# ---------------------------------------------------------------------------
e2_valid_loopback_port() {
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  (( 10#$1 >= 1 && 10#$1 <= 65535 )) || return 1
  return 0
}

e2_host_allowed_test_only() {
  local url="$1"
  local host port
  if [[ "$url" =~ ^http://127\.0\.0\.1:([0-9]+)$ ]]; then
    port="${BASH_REMATCH[1]}"
    e2_valid_loopback_port "$port" || return 1
    return 0
  fi
  if [[ "$url" =~ ^http://localhost:([0-9]+)$ ]]; then
    port="${BASH_REMATCH[1]}"
    e2_valid_loopback_port "$port" || return 1
    return 0
  fi
  return 1
}

e2_check_host_allowlist() {
  # $1: mode ("production"|"test") ; $2: url. Exits via e2_die on refusal.
  local mode="$1" url="$2"
  if [ "$mode" = "production" ]; then
    if [ "$url" = "$E2_PRODUCTION_ORIGIN" ]; then
      return 0
    fi
    e2_die host_not_allowlisted_for_mode 2
  else
    if [ "$url" = "$E2_PRODUCTION_ORIGIN" ]; then
      e2_die production_host_forbidden_in_test_mode 2
    fi
    if e2_host_allowed_test_only "$url"; then
      return 0
    fi
    e2_die host_not_allowlisted_for_mode 2
  fi
}

# ---------------------------------------------------------------------------
# RC-7 — token acquisition. Production: fixed-root/rootIndex/canonical
# `gcloud`, fully uid/mode/canonical attested like every other retained
# tool (R2-F3), never ambient `type -P`/PATH. Test: nonempty
# E2_TEST_TOKEN only; gcloud call site is structurally unreachable in test
# mode (the branch below is only reached when mode != "test").
# ---------------------------------------------------------------------------
e2_get_access_token_production() {
  # Never calls e2_die directly: this function (and e2_get_access_token
  # below) is invoked via `var=$(...)` command substitution by run_e2_lookup,
  # and `exit` inside a subshell only terminates that subshell — it cannot
  # terminate the real script. Failures are signaled by return code only;
  # the caller at the true top level (never itself inside a command
  # substitution) is responsible for calling e2_die with the right reason.
  local gcloud_bin
  gcloud_bin=$(e2_resolve_gcloud_trusted "$E2_CONFIRMED_PLATFORM") || return 4
  # R3-F11 (Remediation-4): `tok=$(cmd) || true` made the compound
  # statement always succeed, so a subsequent `$?` read would always be 0 —
  # the real gcloud exit status was unconditionally swallowed. `|| rc=$?`
  # still prevents `set -e` from terminating the script here (the compound
  # command as a whole still "succeeds"), while `$?` inside the `||` branch
  # correctly still refers to the failed command's real exit status.
  local tok rc=0
  tok=$("$gcloud_bin" auth print-access-token 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$tok" ]; then
    tok=""
    return 3
  fi
  printf '%s' "$tok"
  return 0
}

e2_get_access_token() {
  # $1: mode. On success, prints the token to stdout and returns 0.
  #
  # R5R2-F5 (Remediation-5 Retry-2) — return-code contract. This function is
  # always invoked by its caller via `token=$(...)`, i.e. inside a command
  # substitution subshell: any variable this function set would be local to
  # that subshell and invisible to run_e2_lookup once the substitution
  # returns, so the specific failure class cannot be smuggled out via a
  # global. It is instead encoded directly in the return code, which DOES
  # survive the subshell boundary:
  #   0 = success (token on stdout)
  #   3 = test_token_missing — test mode only; no E2_TEST_TOKEN was supplied
  #       at all (an operator/harness setup gap, distinct from a simulated
  #       acquisition failure below)
  #   4 = tool_resolution_failed
  #   6 = token_acquisition_failed — a token command (real gcloud, or its
  #       diagnostic stand-in) ran but failed or returned empty output
  # run_e2_lookup maps 3 and 6 to the same process exit code (3); only the
  # REASON token text differs (see run_e2_lookup's token_rc handling) — no
  # new REASON token is introduced, both are already-established vocabulary.
  #
  # R5R4-F2 (Remediation-5 Retry-4) — diagnostics-only token-owner
  # invocation marker. Emitted unconditionally on entry, to stderr (never
  # stdout — this function's stdout is the token itself, captured by
  # `token=$(...)`), gated on a dedicated opt-in control
  # (E2_TEST_TOKEN_OWNER_DIAG, on top of test mode + diagnostics) rather
  # than on diagnostics alone, so every other existing test's exact
  # stderr-content assertions are completely unaffected — only a test that
  # deliberately asks for this marker ever sees it. Carries no production
  # behavior change. Codex Retry-3 M2 found that the invalid-classifier-value
  # tests observed zero tool/request/body/RESULT but never actually
  # instrumented this function itself, so "zero token acquisition" for those
  # values rested on static source order alone (true here because e2_die at
  # the classifier grammar gate above always exits before this function
  # could ever be called, but not previously provable at runtime).
  #
  # R5R5-F2 (Remediation-5 Retry-5) — production-unreachability closed.
  # Codex's Retry-4 review (R5R4-F2-TOKEN-MARKER-PRODUCTION-EXPOSURE) found
  # the prior gate read raw `${E2_TEST_DIAGNOSTICS}`/`${E2_TEST_TOKEN_OWNER_DIAG}`
  # directly, never requiring the validated internal
  # `e2_test_mode_active`/`e2_test_diagnostics_active` state those two
  # globals only ever reach through the exact-value grammar near the bottom
  # of this file (`case "${E2_TEST_MODE:-0}"` ... `e2_test_diagnostics_active=1`).
  # This function is shared by both the test and production call paths
  # (`$1` distinguishes them below), so a production invocation whose
  # environment happened to still carry
  # `E2_TEST_DIAGNOSTICS=1`/`E2_TEST_TOKEN_OWNER_DIAG=1` — without ever
  # setting `E2_TEST_MODE=1` — previously reached this `printf` and
  # disclosed the marker on stderr during real production token
  # acquisition. The condition now reads the same validated internal
  # booleans every other diagnostics-only marker in this file already
  # requires (`emit_test_state`, the `E2_TEST_EXPOSE_STATE`-gated markers
  # below), so it can only ever be true once `E2_TEST_MODE` was
  # independently validated as the exact literal `1` and
  # `e2_test_diagnostics_active` was derived from that — no combination of
  # `E2_TEST_DIAGNOSTICS`/`E2_TEST_TOKEN_OWNER_DIAG` alone, without a valid
  # `E2_TEST_MODE=1` also present, can make this marker fire.
  # ops-tests/helpers/runE2Script.ts's countTokenOwnerInvocations parses
  # this marker.
  if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ] \
     && [ "${E2_TEST_TOKEN_OWNER_DIAG:-}" = "1" ]; then
    printf 'test_token_owner_invoked\n' >&2
  fi
  if [ "$1" = "test" ]; then
    # R4-F3 (Remediation-5): diagnostics-gated token-result control. Feeds
    # the exact same rc mapping the production branch below uses into the
    # identical downstream caller (run_e2_lookup's token_rc handling)
    # without resolving or invoking real gcloud — only reachable when
    # diagnostics are active, and only for this exact closed value set. A
    # plain E2_TEST_TOKEN with no E2_TEST_TOKEN_RESULT keeps the original
    # direct-token path unchanged.
    if [ "$e2_test_diagnostics_active" -eq 1 ] && [ -n "${E2_TEST_TOKEN_RESULT:-}" ]; then
      case "${E2_TEST_TOKEN_RESULT}" in
        resolver_fail)
          return 4
          ;;
        command_nonzero|empty_output)
          return 6
          ;;
        success)
          [ -n "${E2_TEST_TOKEN:-}" ] || return 3
          printf '%s' "$E2_TEST_TOKEN"
          return 0
          ;;
        *)
          return 3
          ;;
      esac
    fi
    if [ -z "${E2_TEST_TOKEN:-}" ]; then
      return 3
    fi
    printf '%s' "$E2_TEST_TOKEN"
    return 0
  fi
  # R3-F11 (Remediation-4): same `|| rc=$?` fix as e2_get_access_token_
  # production — the prior `|| true` made `rc` always read 0, so the
  # `[ "$rc" -eq 4 ]` tool_resolution_failed branch below was structurally
  # unreachable and every production resolver failure misreported as
  # token_acquisition_failed.
  local tok rc=0
  tok=$(e2_get_access_token_production) || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$tok" ]; then
    tok=""
    [ "$rc" -eq 4 ] && return 4
    return 6
  fi
  printf '%s' "$tok"
  return 0
}

# ---------------------------------------------------------------------------
# RC-8 — resource-specific Firestore document validators.
# ---------------------------------------------------------------------------
e2_parse_document_path() {
  # $1: raw TWINPET_E2_DOCUMENT_PATH value. Sets E2_PARSED_COLLECTION /
  # E2_PARSED_DOC_ID globals on success; exits via e2_die otherwise.
  local raw="$1"
  if [ -z "$raw" ] || [[ "$raw" != */* ]]; then
    e2_die invalid_document_identifier 2
  fi
  local collection="${raw%%/*}"
  local doc_id="${raw#*/}"
  if [[ "$doc_id" == */* ]]; then
    e2_die invalid_document_identifier 2
  fi
  case "$collection" in
    shifts|shiftCloseCases) : ;;
    *) e2_die collection_not_allowlisted 2 ;;
  esac
  # A literal {1,1500} interval trips "invalid repetition count(s)" on some
  # bash/regex builds (observed on this host); enforce the length bound
  # separately instead of relying on a large brace-interval quantifier.
  if ! [[ "$doc_id" =~ ^[A-Za-z0-9_-]+$ ]] || [ "${#doc_id}" -gt 1500 ]; then
    e2_die invalid_document_identifier 2
  fi
  E2_PARSED_COLLECTION="$collection"
  E2_PARSED_DOC_ID="$doc_id"
}

# Validates the private body file against the exact resource-specific
# contract for the resolved collection, and prints exactly one internal
# (never user-facing) tab-separated line to stdout:
#   EXISTS_SHIFTS\t<CORRELATION_REF>
#   EXISTS_CASE\t<PROCESSING_STATE>\t<SETTLEMENT_STATE>\t<ALERT_STATE>\t<CASE_VERSION>\t<EVID_PRESENT>\t<HASH_PRESENT>
#   FAIL\t<reason_token>
e2_validate_document_body() {
  local body_file="$1" collection="$2" expected_name="$3" node_bin="$4"
  E2_VALIDATE_BODY_FILE="$body_file" \
  E2_VALIDATE_COLLECTION="$collection" \
  E2_VALIDATE_EXPECTED_NAME="S${expected_name}" \
  E2_VALIDATE_PROC_STATES="${E2_PROCESSING_STATES[*]}" \
  E2_VALIDATE_SETTLE_STATES="${E2_SETTLEMENT_STATES[*]}" \
  E2_VALIDATE_ALERT_STATES="${E2_ALERT_STATES[*]}" \
  "$node_bin" --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    const bodyPath = process.env.E2_VALIDATE_BODY_FILE;
    const collection = process.env.E2_VALIDATE_COLLECTION;
    const expectedName = process.env.E2_VALIDATE_EXPECTED_NAME.slice(1);
    const procStates = new Set(process.env.E2_VALIDATE_PROC_STATES.split(" "));
    const settleStates = new Set(process.env.E2_VALIDATE_SETTLE_STATES.split(" "));
    const alertStates = new Set(process.env.E2_VALIDATE_ALERT_STATES.split(" "));

    function fail(reason) { process.stdout.write("FAIL\t" + reason); }

    const ALLOWED_VALUE_KEYS = new Set([
      "nullValue","booleanValue","integerValue","doubleValue","timestampValue",
      "stringValue","bytesValue","referenceValue","geoPointValue","arrayValue","mapValue",
    ]);

    function isPlainObject(v) {
      return v !== null && typeof v === "object" && !Array.isArray(v);
    }

    // Exactly one recognized Value key; own enumerable key count exactly 1.
    function wrapperKind(wrapper) {
      if (!isPlainObject(wrapper)) return null;
      const keys = Object.keys(wrapper);
      if (keys.length !== 1) return null;
      const key = keys[0];
      if (!ALLOWED_VALUE_KEYS.has(key)) return null;
      return key;
    }

    function readStringField(fields, name) {
      const wrapper = fields[name];
      if (wrapper === undefined) return { state: "absent" };
      const kind = wrapperKind(wrapper);
      if (kind !== "stringValue") return { state: "malformed" };
      if (typeof wrapper.stringValue !== "string") return { state: "malformed" };
      return { state: "ok", value: wrapper.stringValue };
    }

    function fieldPresentValid(fields, name) {
      const wrapper = fields[name];
      if (wrapper === undefined) return false;
      return wrapperKind(wrapper) !== null;
    }

    function run() {
      let raw;
      try { raw = readFileSync(bodyPath, "utf8"); } catch { return fail("malformed_200_body"); }
      let doc;
      try { doc = JSON.parse(raw); } catch { return fail("malformed_200_body"); }
      if (!isPlainObject(doc)) return fail("malformed_200_body");
      if (typeof doc.name !== "string") return fail("malformed_200_body");
      if (doc.name !== expectedName) return fail("document_name_mismatch");
      if (!isPlainObject(doc.fields)) return fail("malformed_200_body");
      const fields = doc.fields;

      if (collection === "shifts") {
        const r = readStringField(fields, "closeCorrelationId");
        if (r.state === "absent") {
          process.stdout.write("EXISTS_SHIFTS\tNULL");
          return;
        }
        if (r.state === "malformed") {
          process.stdout.write("EXISTS_SHIFTS\tINVALID");
          return;
        }
        const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        if (!UUID_V4.test(r.value)) {
          process.stdout.write("EXISTS_SHIFTS\tINVALID");
          return;
        }
        const digest = createHash("sha256").update(r.value, "utf8").digest("hex");
        process.stdout.write("EXISTS_SHIFTS\t" + digest.slice(0, 12));
        return;
      }

      // shiftCloseCases
      function stateOf(name, allowlist) {
        const r = readStringField(fields, name);
        if (r.state === "absent") return "ABSENT";
        if (r.state === "malformed") return "MALFORMED";
        if (!allowlist.has(r.value)) return "UNRECOGNIZED";
        return r.value;
      }
      const processingState = stateOf("processingState", procStates);
      const settlementState = stateOf("settlementState", settleStates);
      const alertState = stateOf("alertState", alertStates);

      let caseVersion = "MALFORMED";
      const cvWrapper = fields.caseVersion;
      if (cvWrapper !== undefined) {
        const kind = wrapperKind(cvWrapper);
        if (kind === "integerValue" && typeof cvWrapper.integerValue === "string") {
          const s = cvWrapper.integerValue;
          if (/^(0|[1-9][0-9]{0,15})$/.test(s)) {
            const n = Number(s);
            if (Number.isSafeInteger(n) && n >= 0 && n <= 9007199254740991) {
              caseVersion = String(n);
            }
          }
        }
      } else {
        caseVersion = "MALFORMED";
      }

      const evidPresent = fieldPresentValid(fields, "latestEvidenceId") ? "TRUE" : "FALSE";
      const hashPresent = fieldPresentValid(fields, "latestCloseHash") ? "TRUE" : "FALSE";

      process.stdout.write(
        ["EXISTS_CASE", processingState, settlementState, alertState, caseVersion, evidPresent, hashPresent].join("\t"),
      );
    }

    run();
  ' 2>/dev/null
}

# ---------------------------------------------------------------------------
# E-2 lookup: direct-child GET, exact host allowlist, resource-specific
# validation, body deleted before any result is emitted.
# ---------------------------------------------------------------------------
run_e2_lookup() {
  local mode="test"
  [ "$e2_test_mode_active" -eq 0 ] && mode="production"

  e2_parse_document_path "${TWINPET_E2_DOCUMENT_PATH:-}"

  local base_url="${TWINPET_E2_ENDPOINT_BASE_URL:-$E2_PRODUCTION_ORIGIN}"
  e2_check_host_allowlist "$mode" "$base_url"

  # R3-F11 (Remediation-4): same `|| rc=$?` fix — the prior `|| true` made
  # `token_rc` always read 0 regardless of the real resolver/token failure,
  # so a failed resolution could fall through toward curl construction
  # instead of stopping here. Also now explicitly requires a nonempty token
  # even when the exit status alone was somehow 0.
  # R5R2-F5 (Remediation-5 Retry-2) — see e2_get_access_token's own header
  # comment for the full return-code contract (3/4/6). No token/tool/temp
  # artifact of any kind has been created yet at this point in either
  # failure branch: this is still strictly before mktemp/chmod/curl below.
  local token token_rc=0
  token=$(e2_get_access_token "$mode") || token_rc=$?
  if [ "$token_rc" -ne 0 ] || [ -z "$token" ]; then
    token=""
    case "$token_rc" in
      4) e2_die tool_resolution_failed 4 ;;
      3) e2_die test_token_missing 3 ;;
      *) e2_die token_acquisition_failed 3 ;;
    esac
  fi

  # R4-F1 (Remediation-5): resolves through e2_resolve_lookup_tool, which
  # dispatches to the sanitizer-owned test bundle only when the
  # host-independent dispatch block set e2_lookup_use_test_bundle=1;
  # otherwise this is the unmodified production e2_resolve_canonical chain
  # (real Linux/Darwin dispatch calling run_e2_lookup directly is completely
  # unaffected). When the test bundle is in use, E2_RM_BIN (normally set
  # once by the production bootstrap tail, which this dispatch path never
  # reaches) is also populated here so the EXIT trap's cleanup_once can
  # still remove e2_tmpdir on a later signal.
  local node_bin curl_bin mktemp_bin rm_bin stat_bin cat_bin
  node_bin=$(e2_resolve_lookup_tool node) || e2_die tool_resolution_failed 4
  curl_bin=$(e2_resolve_lookup_tool curl) || e2_die tool_resolution_failed 4
  mktemp_bin=$(e2_resolve_lookup_tool mktemp) || e2_die tool_resolution_failed 4
  rm_bin=$(e2_resolve_lookup_tool rm) || e2_die tool_resolution_failed 4
  stat_bin=$(e2_resolve_lookup_tool stat) || e2_die tool_resolution_failed 4
  cat_bin=$(e2_resolve_lookup_tool cat) || e2_die tool_resolution_failed 4
  if [ "$e2_lookup_use_test_bundle" -eq 1 ]; then
    E2_RM_BIN="$rm_bin"
  fi

  # R4-F5 (Remediation-5): exact, closed, collection-specific Firestore
  # field masks — the same deterministic URL owner serves production and
  # the loopback seam. `shifts` requests only `closeCorrelationId`;
  # `shiftCloseCases` requests exactly the six approved case fields, in this
  # fixed order. e2_parse_document_path above already restricted
  # E2_PARSED_COLLECTION to one of these two literals; the `*)` branch is an
  # unreachable defensive backstop, not a live third case.
  local mask_query
  case "$E2_PARSED_COLLECTION" in
    shifts)
      mask_query='mask.fieldPaths=closeCorrelationId'
      ;;
    shiftCloseCases)
      mask_query='mask.fieldPaths=processingState&mask.fieldPaths=settlementState&mask.fieldPaths=alertState&mask.fieldPaths=caseVersion&mask.fieldPaths=latestEvidenceId&mask.fieldPaths=latestCloseHash'
      ;;
    *)
      e2_die collection_not_allowlisted 2
      ;;
  esac

  local document_path="${E2_PARSED_COLLECTION}/${E2_PARSED_DOC_ID}"
  local url="${base_url}/v1/projects/${E2_PROJECT_ID}/databases/${E2_DATABASE_ID}/documents/${document_path}?${mask_query}"
  local expected_name="projects/${E2_PROJECT_ID}/databases/${E2_DATABASE_ID}/documents/${document_path}"

  e2_tmpdir=$("$mktemp_bin" -d)
  local chmod_bin
  chmod_bin=$(e2_resolve_lookup_tool chmod) || e2_die tool_resolution_failed 4
  "$chmod_bin" 700 "$e2_tmpdir" 2>/dev/null || true
  local body_file="$e2_tmpdir/body"
  local status_file="$e2_tmpdir/status"
  : > "$body_file"
  "$chmod_bin" 600 "$body_file" 2>/dev/null || true
  # R5R2-F5 (Remediation-5 Retry-2) — diagnostics-only, test-mode-gated
  # observation that the one shared lookup body owner actually created a
  # body artifact on this call. Combined with the token-failure branch
  # above (which e2_die's out before this line is ever reached), this lets
  # a test assert zero body creation on every token failure path and
  # exactly one on a real lookup — reuses the existing E2_TEST_EXPOSE_STATE
  # gate already used for test_state; no new approved test-control key.
  if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ] \
     && [ "${E2_TEST_EXPOSE_STATE:-}" = "1" ]; then
    printf 'test_body_created\n' >&2
  fi

  if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ]; then
    local tmp_mode body_mode
    tmp_mode=$("$stat_bin" -c '%a' "$e2_tmpdir" 2>/dev/null || printf '')
    body_mode=$("$stat_bin" -c '%a' "$body_file" 2>/dev/null || printf '')
    [ -n "$tmp_mode" ] && printf 'E2_TMP_MODE=%s\n' "$tmp_mode" >&2
    [ -n "$body_mode" ] && printf 'E2_BODY_MODE=%s\n' "$body_mode" >&2
  fi

  "$curl_bin" -sS --max-time "${E2_TEST_CURL_MAX_TIME:-10}" \
    -H "Authorization: Bearer ${token}" \
    -o "$body_file" \
    -w '%{http_code}' \
    "$url" > "$status_file" 2>/dev/null &
  child_pid=$!
  reap_child_once
  local curl_exit="$child_wait_status"
  token=""
  unset token

  if [ "$curl_exit" -ne 0 ]; then
    "$rm_bin" -f "$body_file" "$status_file" 2>/dev/null || true
    e2_emit_result_reason INACCESSIBLE transport_failure
    return 0
  fi

  local status
  status=$("$cat_bin" "$status_file" 2>/dev/null)
  "$rm_bin" -f "$status_file" 2>/dev/null || true

  case "$status" in
    200)
      local verdict
      verdict=$(e2_validate_document_body "$body_file" "$E2_PARSED_COLLECTION" "$expected_name" "$node_bin")
      local node_rc=$?
      "$rm_bin" -f "$body_file" 2>/dev/null || true
      if [ "$node_rc" -ne 0 ] || [ -z "$verdict" ]; then
        e2_emit_result_reason INSUFFICIENT_EVIDENCE json_validator_unavailable
        return 0
      fi
      local -a parts=()
      IFS=$'\t' read -r -a parts <<< "$verdict"
      case "${parts[0]:-}" in
        EXISTS_SHIFTS)
          e2_emit_result EXISTS "CORRELATION_REF ${parts[1]:-INVALID}"
          ;;
        EXISTS_CASE)
          e2_emit_result EXISTS \
            "PROCESSING_STATE ${parts[1]:-MALFORMED}" \
            "SETTLEMENT_STATE ${parts[2]:-MALFORMED}" \
            "ALERT_STATE ${parts[3]:-MALFORMED}" \
            "CASE_VERSION ${parts[4]:-MALFORMED}" \
            "LATEST_EVIDENCE_ID_PRESENT ${parts[5]:-FALSE}" \
            "LATEST_CLOSE_HASH_PRESENT ${parts[6]:-FALSE}"
          ;;
        FAIL)
          case "${parts[1]:-}" in
            document_name_mismatch) e2_emit_result_reason INSUFFICIENT_EVIDENCE document_name_mismatch ;;
            *) e2_emit_result_reason INSUFFICIENT_EVIDENCE malformed_200_body ;;
          esac
          ;;
        *)
          e2_emit_result_reason INSUFFICIENT_EVIDENCE malformed_200_body
          ;;
      esac
      return 0
      ;;
    404)
      "$rm_bin" -f "$body_file" 2>/dev/null || true
      e2_emit_result_reason ABSENT document_absent
      return 0
      ;;
    400)
      "$rm_bin" -f "$body_file" 2>/dev/null || true
      e2_emit_result_reason REQUEST_ERROR invalid_document_identifier
      return 0
      ;;
    401|403)
      "$rm_bin" -f "$body_file" 2>/dev/null || true
      e2_emit_result_reason INACCESSIBLE token_acquisition_failed
      return 0
      ;;
    429|5??)
      "$rm_bin" -f "$body_file" 2>/dev/null || true
      e2_emit_result_reason TRANSIENT_INACCESSIBLE transport_failure
      return 0
      ;;
    *)
      "$rm_bin" -f "$body_file" 2>/dev/null || true
      e2_emit_result_reason INSUFFICIENT_EVIDENCE transport_failure
      return 0
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Production (no-argument) mode
# ---------------------------------------------------------------------------
run_production() {
  if [ "$e2_test_mode_active" -eq 1 ]; then
    if [ -n "${E2_TEST_MANIFEST_DIAG:-}" ] && [ "$e2_test_diagnostics_active" -eq 1 ]; then
      e2_run_resolver_diagnostic
      return $?
    fi
    # R3-F1 (Remediation-4): the E2_TEST_CLASSIFY_ONLY pure-classifier branch
    # that used to live here has moved to the top-level builtin pure-mode
    # dispatch (see the bottom of this file) — it is fully pure Bash and
    # must not wait on / depend on the production resolver bootstrap that
    # already ran before run_production was ever called.
    if [ "$e2_test_diagnostics_active" -eq 1 ] && e2_host_facts_present; then
      e2_run_lookup_seam
      return $?
    fi
  fi

  # R2-F2 — by this point E2_CONFIRMED_PLATFORM was already set from the
  # builtin OSTYPE selection (see the bootstrap block below), and stat/the
  # canonicalizer were already bootstrapped before run_production was ever
  # called. `uname` is resolved and attested exactly like every other
  # retained tool; its live output is then cross-checked against the
  # OSTYPE-selected platform — a mismatch fails closed rather than being
  # silently believed.
  local uname_candidate
  uname_candidate=$(e2_resolve_canonical uname) || e2_die tool_resolution_failed 4

  local platform_raw
  platform_raw=$("$uname_candidate" -s 2>/dev/null) || true
  if [ -z "$platform_raw" ] || [ "$platform_raw" != "$E2_CONFIRMED_PLATFORM" ]; then
    e2_die tool_resolution_failed 4
  fi

  case "$E2_CONFIRMED_PLATFORM" in
    Linux)
      e2_verify_trust_anchor Linux || e2_die tool_resolution_failed 4

      local findmnt_candidate
      findmnt_candidate=$(e2_resolve_canonical findmnt) || findmnt_candidate=""

      local kernel_release proc_version
      kernel_release=$(LC_ALL=C "$uname_candidate" -r 2>/dev/null) || true
      proc_version=$(read_proc_version 2>/dev/null) || proc_version=""

      local kernel_release_lc proc_version_lc wsl_class
      kernel_release_lc=$(lc "$kernel_release")
      proc_version_lc=$(lc "$proc_version")
      wsl_class=$(classify_wsl "$kernel_release_lc" "$proc_version_lc")

      if [ "$wsl_class" = "linux_wsl1" ]; then
        printf 'NOT_RUN_WSL1_UNSUPPORTED\n'
        return 0
      fi

      local -a fslines=()
      if [ -n "$findmnt_candidate" ] && [ -x "$findmnt_candidate" ]; then
        mapfile -t fslines < <(LC_ALL=C "$findmnt_candidate" -n -r -P -o TARGET,FSTYPE 2>/dev/null) || true
      fi
      local fs_class
      fs_class=$(classify_filesystem_lines Linux "${fslines[@]:-}")
      case "$fs_class" in
        fs_ok) : ;;
        fs_unavailable) printf 'NOT_RUN_FILESYSTEM_TYPE_UNAVAILABLE\n'; return 0 ;;
        fs_unrecognized_type) printf 'NOT_RUN_FILESYSTEM_TYPE_UNRECOGNIZED\n'; return 0 ;;
        fs_unsupported_type|fs_rejected) printf 'NOT_RUN_FILESYSTEM_TYPE_UNSUPPORTED\n'; return 0 ;;
        *) printf 'NOT_RUN_FILESYSTEM_TYPE_UNAVAILABLE\n'; return 0 ;;
      esac

      run_e2_lookup
      return $?
      ;;
    Darwin)
      e2_verify_trust_anchor Darwin || e2_die tool_resolution_failed 4

      local mount_candidate
      mount_candidate=$(e2_resolve_canonical mount) || mount_candidate=""

      local -a fslines=()
      if [ -n "$mount_candidate" ] && [ -x "$mount_candidate" ]; then
        mapfile -t fslines < <(LC_ALL=C "$mount_candidate" 2>/dev/null) || true
      fi
      local fs_class
      fs_class=$(classify_filesystem_lines Darwin "${fslines[@]:-}")
      case "$fs_class" in
        fs_ok) : ;;
        fs_unavailable) printf 'NOT_RUN_FILESYSTEM_TYPE_UNAVAILABLE\n'; return 0 ;;
        *) printf 'NOT_RUN_FILESYSTEM_TYPE_UNRECOGNIZED\n'; return 0 ;;
      esac

      run_e2_lookup
      return $?
      ;;
    *)
      printf 'NOT_RUN_HOST_CLASS_UNSUPPORTED\n'
      return 0
      ;;
  esac
}

# ---------------------------------------------------------------------------
# D1-F2 — resolver/manifest diagnostic. Gated behind E2_TEST_MODE=1 +
# E2_TEST_DIAGNOSTICS=1 + E2_TEST_MANIFEST_DIAG=1 (any non-empty value).
# Parses E2_TOOL_MANIFEST (if set) and prints a closed diagnostic token —
# never touches a token, a socket, or the lookup path. On a non-accepted
# (OSTYPE=OTHER) host this may be reached *without* a bootstrapped stat/
# canonicalizer (see the dispatch block below) — its own manifest-parsing
# logic is pure bash either way, and E2_TEST_RESOLVE_PROBE degrades
# honestly to RESOLVE_FAIL rather than crashing when stat/canon are absent.
# ---------------------------------------------------------------------------
e2_run_resolver_diagnostic() {
  if ! e2_parse_tool_manifest; then
    printf 'RESOLVER_MANIFEST_REJECT\n'
    exit 0
  fi
  printf 'RESOLVER_MANIFEST_ACCEPT'
  local t
  for t in "${!E2_FIXED_BASENAME[@]}"; do
    printf ' %s=%s' "$t" "${E2_ACTIVE_ROOT_INDEX[$t]:-}"
  done
  printf '\n'
  if [ -n "${E2_TEST_RESOLVE_PROBE:-}" ]; then
    local resolved
    if resolved=$(e2_resolve_canonical "$E2_TEST_RESOLVE_PROBE" 2>/dev/null); then
      printf 'RESOLVE_OK %s\n' "$resolved"
    else
      printf 'RESOLVE_FAIL\n'
    fi
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# R2-F2 — builtin OSTYPE/Bash-version platform selection. Only Bash
# builtins/parameter expansion run before this point (beyond the RC-3 guard
# and the fixed literal tables above) — no external tool has been invoked
# yet anywhere in this file.
# ---------------------------------------------------------------------------
case "${OSTYPE:-}" in
  linux-gnu*) E2_PLATFORM_TABLE=LINUX ;;
  darwin*)    E2_PLATFORM_TABLE=DARWIN ;;
  *)          E2_PLATFORM_TABLE=OTHER ;;
esac

if [ -z "${BASH_VERSINFO:-}" ] \
   || [ "${BASH_VERSINFO[0]:-0}" -lt 4 ] \
   || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -lt 4 ]; }; then
  E2_PLATFORM_TABLE=OTHER
fi

case "$E2_PLATFORM_TABLE" in
  LINUX)
    E2_FIXED_ROOTS=("${E2_FIXED_ROOTS_LINUX[@]}")
    E2_DEFAULT_ROOT_INDEX[gcloud]=3
    E2_CONFIRMED_PLATFORM="Linux"
    ;;
  DARWIN)
    E2_FIXED_ROOTS=("${E2_FIXED_ROOTS_DARWIN[@]}")
    E2_DEFAULT_ROOT_INDEX[gcloud]=4
    E2_DEFAULT_ROOT_INDEX[mount]=5
    E2_CONFIRMED_PLATFORM="Darwin"
    ;;
  *)
    E2_FIXED_ROOTS=("${E2_FIXED_ROOTS_OTHER[@]}")
    E2_CONFIRMED_PLATFORM=""
    ;;
esac

for e2_tool_name in "${!E2_DEFAULT_ROOT_INDEX[@]}"; do
  E2_ACTIVE_ROOT_INDEX["$e2_tool_name"]="${E2_DEFAULT_ROOT_INDEX[$e2_tool_name]}"
done
unset e2_tool_name

case "${E2_TEST_MODE:-0}" in
  0|'') e2_test_mode_active=0 ;;
  1) e2_test_mode_active=1 ;;
  *) e2_die invalid_mode 2 ;;
esac
if [ "$e2_test_mode_active" -eq 1 ] && [ "${E2_TEST_DIAGNOSTICS:-}" = "1" ]; then
  e2_test_diagnostics_active=1
fi

# Determine the closed invocation shape without resolving or bootstrapping
# anything yet, so a trivially-invalid invocation (bad flag, extra arg)
# never has to pay for — or wait on — tool attestation it will not use.
if [ "$#" -eq 0 ]; then
  e2_dispatch_shape=production
elif [ "$#" -eq 1 ] && [ "$1" = "--evaluate-trust-facts-v1" ]; then
  e2_dispatch_shape=evaluator
else
  e2_die invalid_mode 2
fi

# ---------------------------------------------------------------------------
# R3-F1 (Remediation-4, binding Gemini ruling) — required top-level order:
#   1. source refusal (already ran, top of file)
#   2. builtin-only recognition of exact pure modes (dispatch-shape/env
#      checks just above and immediately below — Bash builtins only)
#   3. pure evaluator/classifier dispatch (THIS block)
#   4. production platform/tool resolver, reserved for production/lookup
#      modes only (everything below this block)
#
# Both run_evaluator and e2_run_pure_classifier are now fully pure Bash —
# see their own header comments and the R3-F1 helper-function block above
# run_evaluator — so they resolve, invoke, and require no external
# production tool, no gcloud, no socket, no stub contact, and emit no
# production RESULT, on ANY host including one with an empty root table.
# Reaching them therefore no longer depends on (and no longer waits behind)
# manifest parsing or stat/canonicalizer bootstrap at all.
# ---------------------------------------------------------------------------
if [ "$e2_dispatch_shape" = evaluator ]; then
  run_evaluator
  exit $?
fi

# R5R2-F2 (Remediation-5 Retry-2) — closed presence/value grammar for
# E2_TEST_CLASSIFY_ONLY, checked before any classify-only dispatch, before
# the host-independent lookup seam, and therefore before any loopback/
# token/tool/network work. Unset or empty is simply "not classifier-only"
# (the rest of the closed dispatch grammar below is unaffected — normal
# lookup-seam dispatch continues exactly as before this fix). The exact
# literal "1" activates classifier-only mode (handled immediately below).
# Any other present, nonempty value (e.g. "0", arbitrary text, whitespace)
# is a typed closed rejection here — it can no longer fall through into the
# host-independent lookup seam and reach token/tool/network handling, which
# is exactly what R5R1-F2/R4-F6's "exact value only" contract already
# required for classifier *activation* but had not previously enforced for
# classifier *rejection*.
if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ]; then
  case "${E2_TEST_CLASSIFY_ONLY:-}" in
    ''|1) : ;;
    *) e2_die invalid_mode 2 ;;
  esac
fi

# R4-F6 (Remediation-5): exact-value recognition. Only the exact literal
# "1" activates classifier-only mode; unset/empty already passed the closed
# grammar check above and fall through unaffected to the host-independent
# lookup seam below.
if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ] \
   && [ "${E2_TEST_CLASSIFY_ONLY:-}" = "1" ] && e2_host_facts_present; then
  e2_run_pure_classifier
  exit $?
fi

# ---------------------------------------------------------------------------
# R4-F1 (Remediation-5) — host-independent diagnostics loopback seam.
# Dispatched here, before the production manifest/stat/canonicalizer/Bash
# resolver bootstrap below, so it is reachable on ANY host, including one
# whose $OSTYPE selects the empty "Other" root table (E2_FIXED_ROOTS_OTHER).
# e2_run_lookup_seam re-checks its own exact five-part gate (test mode,
# diagnostics, exact loopback origin+port, nonempty synthetic token, valid
# fixture) itself and dies with the same typed reasons a real invocation
# would produce; only an ELIGIBLE classification falls through to
# run_e2_lookup, which is reused completely unmodified (same HTTP mapping,
# validator, deletion, output-containment owners as production). The
# gate below is deliberately loose (test mode + diagnostics + fixture
# present) — it does not require a bundle directory, so it is reachable
# even without one: a non-ELIGIBLE fixture (e.g. WSL1) never needs a tool at
# all and reaches its real classification token here for the first time; an
# ELIGIBLE fixture without a bundle directory still fails closed with
# tool_resolution_failed once run_e2_lookup's own tool resolution runs (see
# e2_resolve_lookup_tool below) — same terminal behavior as before this
# finding closed, just reached via a different, now-substantive path. It
# can never resolve gcloud (e2_get_access_token's test branch never calls
# gcloud) and never accepts the production origin (the seam's own gate
# refuses that before any of this matters).
# ---------------------------------------------------------------------------
#
# R5R5-F4 (Remediation-5 Retry-5) — host-independent dispatch-decision
# markers. Codex's Retry-4 review (R5R4-F4-PRIOR-F-OBLIGATIONS-AND-ACCOUNTING)
# found three tests whose only proof that "the seam was skipped" (missing
# diagnostics) or "the bundle was not selected" (no bundle directory) was a
# `tool_resolution_failed` NOT_RUN reached via the production resolver
# below — a resolver-stage side effect that only fails on THIS dev host's
# empty "Other" root table, not a direct, host-independent observation of
# the dispatch decision itself (on a real Linux/Darwin host with a working
# production resolver, that same fallthrough could plausibly succeed
# instead, proving nothing about the dispatch logic being tested). These two
# markers observe the actual dispatch decision directly — whether this gate
# was entered, and, if so, whether the bundle was selected — independent of
# whatever the resolver does afterward, so a test no longer needs the
# production resolver to fail in order to prove the gate condition it
# actually cares about. Deliberately gated on `E2_TEST_EXPOSE_STATE` alone
# (not also requiring diagnostics, unlike `emit_test_state`) so the first
# marker can still fire on exactly the runs under test here — including the
# "diagnostics missing" case, where `e2_test_diagnostics_active` is by
# definition 0. Both remain unreachable in production (gated behind
# `e2_test_mode_active`, itself reachable only via the validated exact-value
# `E2_TEST_MODE=1` grammar) and carry no production behavior change.
if [ "$e2_test_mode_active" -eq 1 ] && [ "${E2_TEST_EXPOSE_STATE:-}" = "1" ]; then
  if [ "$e2_test_diagnostics_active" -eq 1 ] && e2_host_facts_present; then
    printf 'test_lookup_seam_gate=enter\n' >&2
  else
    printf 'test_lookup_seam_gate=skip\n' >&2
  fi
fi
if [ "$e2_test_mode_active" -eq 1 ] && [ "$e2_test_diagnostics_active" -eq 1 ] \
   && e2_host_facts_present; then
  # Only records that a bundle directory *may* be used; does not resolve
  # anything yet — resolving here (before e2_run_lookup_seam's own gate
  # runs) would let a bundle-dir-only failure shadow the seam's exact typed
  # gate-violation reasons (production_host_forbidden_in_test_mode /
  # host_not_allowlisted_for_mode / test_token_missing). Actual resolution
  # happens inside run_e2_lookup itself, only once the gate has already
  # passed and only for an ELIGIBLE classification.
  [ -n "${E2_TEST_TOOL_BUNDLE_DIR:-}" ] && e2_lookup_use_test_bundle=1
  if [ "${E2_TEST_EXPOSE_STATE:-}" = "1" ]; then
    printf 'test_lookup_seam_bundle_used=%s\n' "$e2_lookup_use_test_bundle" >&2
  fi
  e2_run_lookup_seam
  exit $?
fi

# From this point on, `e2_dispatch_shape` is guaranteed `production` (the
# only other shape, `evaluator`, already exited above) — everything below
# is the production platform/tool resolver, reserved for production and
# lookup-seam modes per the R3-F1 ordering above.

# R2-F2 — a non-accepted host resolves and invokes nothing for the plain
# production (no-argument, non-test-mode) invocation shape: this is the one
# path allowed to short-circuit before manifest parsing / tool resolution,
# preserving the pre-existing NOT_RUN_HOST_CLASS_UNSUPPORTED contract for
# that specific, most-common shape. Every other production-shape case on a
# non-accepted host (any remaining test-mode diagnostic, e.g. the lookup
# seam) falls through to the manifest parser and resolver below, where an
# empty E2_FIXED_ROOTS table fails every resolution attempt closed —
# "resolve no executable" holds by construction there too, just via
# tool_resolution_failed instead of a second bespoke token.
if [ "$E2_PLATFORM_TABLE" = OTHER ] && [ "$e2_test_mode_active" -eq 0 ]; then
  printf 'NOT_RUN_HOST_CLASS_UNSUPPORTED\n'
  exit 0
fi

# The manifest-resolver diagnostic is explicitly a pure-policy/production-
# inaccessible seam (see e2_run_resolver_diagnostic's header comment): on a
# non-accepted host it runs without requiring stat/canonicalizer bootstrap,
# since its own logic is pure bash and its optional resolve-probe already
# degrades to an honest RESOLVE_FAIL. On an accepted (Linux/Darwin) host it
# falls through to the normal path below instead, so the probe can
# genuinely succeed there.
if [ "$E2_PLATFORM_TABLE" = OTHER ] && [ "$e2_test_mode_active" -eq 1 ] \
   && [ "$e2_test_diagnostics_active" -eq 1 ] && [ -n "${E2_TEST_MANIFEST_DIAG:-}" ]; then
  # Matches the general path's ordering below: a structurally malformed
  # manifest dies tool_resolution_failed before any diagnostic runs, same
  # as every other invocation shape — only the stat/canonicalizer bootstrap
  # is skipped here, not manifest validation itself.
  if ! e2_parse_tool_manifest; then
    e2_die tool_resolution_failed 4
  fi
  e2_run_resolver_diagnostic
  exit $?
fi

if ! e2_parse_tool_manifest; then
  e2_die tool_resolution_failed 4
fi

if ! e2_bootstrap_stat; then
  e2_die tool_resolution_failed 4
fi

if ! e2_bootstrap_canonicalizer; then
  e2_die tool_resolution_failed 4
fi

# R3-F5/R3-F6 — closes the two structural first-anchor exemptions now that
# both stat and the canonicalizer exist (see the function's own header
# comment for exactly what this replays).
if ! e2_finalize_bootstrap_canonical_identity; then
  e2_die tool_resolution_failed 4
fi

# R3-F7 — the actual running interpreter must match the attested fixed-root
# canonical Bash identity before any further production external work
# (including the E2_TEST_MANIFEST_DIAG diagnostic above is explicitly
# exempt, matching its own pure-policy/production-inaccessible status; this
# check therefore sits after it, not before).
if ! e2_verify_running_bash_identity; then
  e2_die tool_resolution_failed 4
fi

E2_CAT_BIN=$(e2_resolve_canonical cat) || e2_die tool_resolution_failed 4
E2_RM_BIN=$(e2_resolve_canonical rm) || e2_die tool_resolution_failed 4

run_production
exit $?
