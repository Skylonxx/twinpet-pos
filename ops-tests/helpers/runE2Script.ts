import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync, accessSync, readFileSync, constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const E2_SCRIPT_PATH = path.resolve(
  process.cwd(),
  'scripts/ops/e2-shift-close-document-lookup.sh',
);

// ---------------------------------------------------------------------------
// D1-F2 (test-harness half) — fixed-root test-bash resolver. The harness
// launches bash from one compiled absolute candidate, never from an ambient
// `bash` PATH lookup, and never the WSL/Windows-Store `bash.exe` shims that
// resolve to a completely different (WSL) interpreter. Candidates are
// Node-visible absolute Windows paths (the real launch boundary here is
// Node's child_process, not the MSYS/POSIX view), so this list is
// necessarily host-shaped rather than a POSIX `/usr/bin`-style table; the
// production script's own resolver (scripts/ops/e2-shift-close-document-
// lookup.sh) is the one that must not depend on PATH at runtime, which is a
// separate, POSIX-shaped concern addressed there.
// ---------------------------------------------------------------------------
const BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  '/usr/bin/bash',
  '/bin/bash',
];

let cachedBashPath: string | null | undefined;

/** Resolves the one fixed-root bash candidate that exists. Never a PATH search. */
export function resolveBashPath(): string | null {
  if (cachedBashPath !== undefined) {
    return cachedBashPath;
  }
  cachedBashPath = BASH_CANDIDATES.find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  }) ?? null;
  return cachedBashPath;
}

export interface RunE2ScriptOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /**
   * Sole PATH entry for the child (e.g. a poison-gcloud bin dir), harness-
   * owned. Omit/null for an empty PATH. This is the ONLY input that may
   * influence the child's PATH — see the R4-F4 comment on spawnE2Script.
   */
  poisonBinDir?: string | null;
  /**
   * Additional raw env to merge in (non-PATH keys only — see R4-F4 below).
   * Kept for callers that already hold a `buildCanonicalTestEnv`-constructed
   * object (e.g. `buildPoisonedGcloudEnv`'s output); any PATH key inside is
   * never trusted, regardless of how it got there.
   */
  isolatedEnv?: NodeJS.ProcessEnv;
}

export interface RunE2ScriptResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true when bash itself could not be spawned (spawn error, e.g. ENOENT) */
  bashUnavailable: boolean;
}

let cachedBashAvailable: boolean | null = null;

/**
 * Resolves whether the one fixed-root bash candidate is invokable at all on
 * this host. Never falls back to a shell string ("bash -c ...") — always
 * argv-only, non-shell-interpolating, so untrusted content can never be
 * concatenated into a shell command line.
 */
export async function isBashAvailable(): Promise<boolean> {
  if (cachedBashAvailable !== null) {
    return cachedBashAvailable;
  }
  const bashPath = resolveBashPath();
  if (!bashPath) {
    cachedBashAvailable = false;
    return false;
  }
  cachedBashAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn(bashPath, ['--noprofile', '--norc', '--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: buildCanonicalTestEnv(null),
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  return cachedBashAvailable;
}

// ---------------------------------------------------------------------------
// D1-F2 (test-harness half) — canonical, non-inherited child environment.
// Once every external tool in the production script is invoked only through
// its own canonical absolute-path resolver (never a bare name), the script
// itself has no runtime dependency on PATH at all. The test child env
// reflects that: PATH carries only an (optional) poison-bin directory —
// never a filtered/deduplicated copy of this process's ambient PATH tail —
// and PATHEXT plus every other hostile/ambient-resolution-adjacent variable
// (BASH_ENV, ENV, CDPATH, BASH_FUNC_*, NODE_OPTIONS/NODE_PATH/
// NODE_EXTRA_CA_CERTS, LD_*/DYLD_*, GOOGLE_APPLICATION_CREDENTIALS,
// CLOUDSDK_*) is dropped rather than copied. A short carry-over list keeps
// Windows/MSYS/Node functional (SystemRoot, TEMP/TMP, HOME, etc.) — none of
// those affect executable *resolution* inside the production script.
//
// R2-F1 removed the two Windows-shaped compiled root-table entries
// (`/mingw64/bin`, the Windows Node install dir) that a prior manifest used
// to steer `curl`/`node` toward on this dev host — a manifest may now only
// select an index that exists in the *current OSTYPE-selected* platform
// table, and this host's OSTYPE (`msys`) selects no table at all (R2-F2).
// There is no longer any manifest shape that makes the production resolver
// find tools on this host; the harness no longer pretends otherwise by
// supplying a rootIndex override by default.
// ---------------------------------------------------------------------------
const ENV_CARRY_OVER_KEYS = [
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ComSpec',
  'HOMEDRIVE',
  'HOMEPATH',
];

/** Env keys this harness must never forward into the child, under any path. */
export const HOSTILE_ENV_KEYS = [
  'BASH_ENV',
  'ENV',
  'CDPATH',
  'SHELLOPTS',
  'BASHOPTS',
  'PATHEXT',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_CONFIG',
];

// Approved E2_* / TWINPET_E2_* test-control keys — every other E2_*-shaped
// or TWINPET_E2_*-shaped key is stripped (R2-F7).
const APPROVED_TEST_CONTROL_KEYS = new Set([
  'E2_TEST_MODE',
  'E2_TEST_DIAGNOSTICS',
  'E2_TEST_HOST_FACTS_V1',
  'E2_TEST_TOKEN',
  'E2_TEST_CLASSIFY_ONLY',
  'E2_TEST_MANIFEST_DIAG',
  'E2_TEST_RESOLVE_PROBE',
  'E2_TEST_EXPOSE_STATE',
  'E2_TEST_FORCE_KILL_FAIL',
  'E2_TEST_CURL_MAX_TIME',
  'E2_TEST_FORCE_PLATFORM',
  'E2_TEST_FORCE_KERNEL_RELEASE',
  'E2_TEST_PROC_VERSION_PATH',
  'E2_TOOL_MANIFEST',
  // R4-F1 (Remediation-5) — the sanitizer-owned test-only tool bundle
  // directory for the host-independent diagnostics loopback seam. See
  // buildE2TestToolBundle below and the script's own
  // e2_resolve_test_bundle_tool comment.
  'E2_TEST_TOOL_BUNDLE_DIR',
  // R5R2-F1/F6 (Remediation-5 Retry-2) — the harness-generated nonce proving
  // a given E2_TEST_TOOL_BUNDLE_DIR was actually constructed by
  // buildE2TestToolBundle for this run, not an arbitrary caller-supplied
  // directory. See e2_verify_test_bundle_provenance in the script.
  'E2_TEST_TOOL_BUNDLE_NONCE',
  // R4-F3 (Remediation-5) — diagnostics-gated token-result control feeding
  // the same production token status/mapping owner without resolving or
  // invoking real gcloud. See the script's e2_get_access_token comment.
  'E2_TEST_TOKEN_RESULT',
  // R5R4-F2 (Remediation-5 Retry-4) — dedicated opt-in for the diagnostics-
  // only token-owner invocation marker (see e2_get_access_token's
  // comment); kept separate from E2_TEST_DIAGNOSTICS so only tests that
  // deliberately request this marker see it, leaving every other test's
  // exact stderr-content assertions unaffected.
  'E2_TEST_TOKEN_OWNER_DIAG',
  'TWINPET_E2_ENDPOINT_BASE_URL',
  'TWINPET_E2_DOCUMENT_PATH',
]);

/**
 * R2-F7 — applied unconditionally, after every other key (including
 * caller-supplied `extra`/`isolatedEnv`) has already been merged in, so a
 * protected key cannot be reintroduced no matter where in the call chain it
 * was supplied. Deletes PATHEXT, every HOSTILE_ENV_KEYS entry, every
 * CLOUDSDK_*-shaped or BASH_FUNC_*-shaped key, and every E2_*-shaped or
 * TWINPET_E2_*-shaped key that is not on the approved test-control
 * allowlist; then reasserts the one controlled PATH value.
 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv, controlledPath: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (HOSTILE_ENV_KEYS.includes(key)) {
      delete out[key];
      continue;
    }
    if (key.startsWith('BASH_FUNC_') || key.startsWith('CLOUDSDK_')) {
      delete out[key];
      continue;
    }
    if ((key.startsWith('E2_') || key.startsWith('TWINPET_E2_')) && !APPROVED_TEST_CONTROL_KEYS.has(key)) {
      delete out[key];
      continue;
    }
  }
  out.PATH = controlledPath;
  return out;
}

/**
 * Builds the canonical, non-inherited child environment. `poisonBinDir`
 * (when supplied) is the only PATH entry — never prepended to an inherited
 * tail. `extra` is applied on top so tests can still set approved E2_TEST_*
 * / TWINPET_E2_* variables, but `sanitizeChildEnv` runs *after* that merge,
 * so `extra` cannot reintroduce PATH/PATHEXT or any other protected key
 * (see the `HOSTILE_ENV_KEYS` static assertion test).
 */
export function buildCanonicalTestEnv(
  poisonBinDir: string | null,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of ENV_CARRY_OVER_KEYS) {
    const v = process.env[key];
    if (v !== undefined) base[key] = v;
  }
  const merged: NodeJS.ProcessEnv = {
    ...base,
    PATH: poisonBinDir ?? '',
    ...extra,
  };
  return sanitizeChildEnv(merged, poisonBinDir ?? '');
}

/**
 * Spawns the production script directly (argv boundary — the resolved
 * fixed-root bash path, `--noprofile --norc`, then the fixed script path,
 * then whatever fixed `args` the test supplies; never a concatenated shell
 * string). Returns the live ChildProcess plus a promise for its terminal
 * result, so signal tests can call `child.kill(...)` at a precise moment
 * before awaiting completion.
 */
/**
 * R4-F4 (Remediation-5) — the harness, not any caller input, owns the
 * complete child PATH. The prior design read `rawEnv.PATH` off of whatever
 * `isolatedEnv` the caller supplied and then trusted THAT value as the
 * sanitizer's `controlledPath`; a raw `{...process.env}` or any other
 * non-`buildCanonicalTestEnv`-built `isolatedEnv` could therefore
 * reintroduce an inherited/arbitrary PATH tail (R4-F4 finding). The
 * controlled PATH now comes from exactly one place: `options.poisonBinDir`
 * (via `buildCanonicalTestEnv`). `options.isolatedEnv`/`options.env` may
 * still contribute non-PATH keys, but whatever PATH value either one
 * carries is discarded — `sanitizeChildEnv`'s own final `out.PATH =
 * controlledPath` line (unconditional, always the last write) guarantees
 * that no matter which option a hostile PATH arrives through, only the
 * harness-derived value ever reaches the child. Exported separately from
 * `spawnE2Script` so tests can assert on the constructed env directly,
 * without needing to spawn a real process to observe it.
 */
export function resolveSpawnEnv(options: RunE2ScriptOptions = {}): NodeJS.ProcessEnv {
  const controlledPath = options.poisonBinDir ?? null;
  const merged: NodeJS.ProcessEnv = {
    ...buildCanonicalTestEnv(controlledPath, options.env ?? {}),
    ...(options.isolatedEnv ?? {}),
  };
  return sanitizeChildEnv(merged, controlledPath ?? '');
}

export function spawnE2Script(options: RunE2ScriptOptions = {}): {
  child: ReturnType<typeof spawn> | null;
  bashUnavailable: Promise<boolean>;
  result: Promise<RunE2ScriptResult>;
} {
  const bashPath = resolveBashPath();
  // Every spawn path (this one, `isBashAvailable`, and the source-refusal
  // spawn in the spec) goes through the same resolveSpawnEnv construction.
  const env = resolveSpawnEnv(options);
  // R5R4-F1 (Remediation-5 Retry-4), rebound to exact minted state R5R5-F1
  // (Remediation-5 Retry-5) — see the header comment above `mintedBundles`:
  // the script file actually launched is decided by whether this exact
  // nonce AND this exact directory (AND its current on-disk bytes) are what
  // `buildE2TestToolBundle` really minted in this process, never by trusting
  // `options`/`env` directly.
  const requestedNonce = env.E2_TEST_TOOL_BUNDLE_NONCE;
  const requestedDir = env.E2_TEST_TOOL_BUNDLE_DIR;
  const scriptForSpawn =
    (requestedNonce && resolveMintedCapabilityScript(requestedNonce, requestedDir)) || E2_SCRIPT_PATH;
  const args = ['--noprofile', '--norc', scriptForSpawn, ...(options.args ?? [])];

  let bashUnavailableResolve!: (v: boolean) => void;
  const bashUnavailable = new Promise<boolean>((r) => {
    bashUnavailableResolve = r;
  });

  if (!bashPath) {
    bashUnavailableResolve(true);
    return {
      child: null,
      bashUnavailable,
      result: Promise.resolve({ stdout: '', stderr: '', code: null, signal: null, bashUnavailable: true }),
    };
  }

  const child = spawn(bashPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  let spawnFailed = false;

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  // R2-F2/R2-F3: the script can now legitimately exit (resolver bootstrap
  // failure) before ever reading stdin, so a write against an
  // already-closed pipe is an expected condition here, not a bug — swallow
  // it rather than letting it surface as an unhandled stream error.
  child.stdin?.on('error', () => {});
  if (options.input !== undefined) {
    child.stdin?.end(options.input);
  } else {
    child.stdin?.end();
  }

  const result = new Promise<RunE2ScriptResult>((resolve) => {
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, options.timeoutMs)
      : null;

    child.on('error', () => {
      spawnFailed = true;
      bashUnavailableResolve(true);
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, code: null, signal: null, bashUnavailable: true });
      }
    });

    child.on('close', (code, signal) => {
      bashUnavailableResolve(spawnFailed);
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, code, signal, bashUnavailable: spawnFailed });
      }
    });
  });

  return { child, bashUnavailable, result };
}

/** Convenience wrapper for tests that do not need to signal the child mid-flight. */
export async function runE2Script(options: RunE2ScriptOptions = {}): Promise<RunE2ScriptResult> {
  const available = await isBashAvailable();
  if (!available) {
    return { stdout: '', stderr: '', code: null, signal: null, bashUnavailable: true };
  }
  const { result } = spawnE2Script(options);
  return result;
}

/** Extracts `test_state child_reaped=<0|1> cleanup_done=<0|1>` from stderr, if present. */
export function parseTestState(stderr: string): { childReaped: boolean; cleanupDone: boolean } | null {
  const match = /test_state child_reaped=(\d) cleanup_done=(\d)/.exec(stderr);
  if (!match) {
    return null;
  }
  return { childReaped: match[1] === '1', cleanupDone: match[2] === '1' };
}

export function stderrHasChildKillFailed(stderr: string): boolean {
  return stderr.includes('child_kill_failed');
}

// ---------------------------------------------------------------------------
// RC-7 — poison-gcloud controlled environment. Builds a fully-controlled
// child env via `buildCanonicalTestEnv`: PATH is exactly the poison-bin
// directory (never poisonBin-plus-inherited-tail), so a real `gcloud` on
// this host's ambient PATH is structurally absent from the child's view
// regardless of where it is installed. BASH_ENV and every BASH_FUNC_* entry
// are dropped (never copied at all — see `buildCanonicalTestEnv`) so no
// shell function/alias contamination can survive into the child.
// ---------------------------------------------------------------------------
export async function createPoisonGcloudBin(): Promise<{ dir: string; markerPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2-poison-gcloud-'));
  const markerPath = path.join(dir, 'gcloud-invoked.marker');
  const markerPosix = markerPath.replace(/\\/g, '/');

  // R3-F8 (Remediation-4): `#!/usr/bin/env bash` requires `env` to find
  // `bash` via a PATH search, which structurally cannot succeed once the
  // child's PATH is poison-dir-only (see buildCanonicalTestEnv) — a
  // deliberate poison invocation would fail to exec at all and never reach
  // the marker write, making marker absence ambiguous (never-invoked vs.
  // invoked-but-unable-to-exec). Use the same fixed, non-searching shebang
  // the production script itself uses (`#!/bin/bash`) instead: it names an
  // absolute path resolved directly by the kernel/MSYS loader, not via a
  // PATH lookup, so it is unaffected by the child's poisoned PATH.
  const shShim = `#!/bin/bash\nprintf 'invoked' > "${markerPosix}"\nexit 1\n`;
  const cmdShim = `@echo off\r\necho invoked> "${markerPath}"\r\nexit /b 1\r\n`;

  const gcloudPath = path.join(dir, 'gcloud');
  const gcloudExePath = path.join(dir, 'gcloud.exe');
  const gcloudCmdPath = path.join(dir, 'gcloud.cmd');

  await writeFile(gcloudPath, shShim, { mode: 0o755 });
  await chmod(gcloudPath, 0o755).catch(() => {});
  // No native .exe compiled here (would require a toolchain); the .cmd shim
  // covers Windows-shell resolution and gcloud/gcloud.exe are covered by
  // the bash shim + the assertion that PATH contains nothing but the poison
  // directory itself (see buildCanonicalTestEnv).
  await writeFile(gcloudExePath, shShim, { mode: 0o755 });
  await writeFile(gcloudCmdPath, cmdShim, { mode: 0o755 });

  return { dir, markerPath };
}

export function buildPoisonedGcloudEnv(poisonBinDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return buildCanonicalTestEnv(poisonBinDir, extra);
}

// ---------------------------------------------------------------------------
// R4-F2 (Remediation-5) — positive poison-invocation proof. The prior suite
// only ever asserted the marker was absent (deterministic-by-construction,
// but never proven able to fire at all). This deliberately launches the
// poison `gcloud` shim through the same fixed, non-searching Bash candidate
// every other spawn uses (an absolute path argv, never a PATH lookup),
// independent of the production script and its own PATH-less resolver, so a
// test can prove the tripwire genuinely writes its marker and exits nonzero
// before relying on marker-absence to prove the production script never
// reaches it.
// ---------------------------------------------------------------------------
export async function invokePoisonGcloudDirect(
  gcloudBinPath: string,
): Promise<{ code: number | null; bashUnavailable: boolean }> {
  const bashPath = resolveBashPath();
  if (!bashPath) {
    return { code: null, bashUnavailable: true };
  }
  return new Promise((resolve) => {
    const child = spawn(bashPath, ['--noprofile', '--norc', gcloudBinPath], {
      env: buildCanonicalTestEnv(null),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve({ code: null, bashUnavailable: true }));
    child.on('close', (code) => resolve({ code, bashUnavailable: false }));
  });
}

// ---------------------------------------------------------------------------
// R5R2-F1/F6 (Remediation-5 Retry-2) — sanitizer-owned test-only tool bundle
// for the host-independent diagnostics loopback seam (see the production
// script's `e2_resolve_test_bundle_tool`/`e2_verify_test_bundle_provenance`
// and the top-level lookup-seam dispatch block). Builds a fresh, private
// temp directory containing one fixed-Bash wrapper per closed tool basename
// `run_e2_lookup` needs (node/curl/mktemp/rm/chmod/stat/cat — no arbitrary
// command strings, no caller-suppliable name), each `exec`-ing this dev
// host's own real tool by an absolute path resolved from a closed, fixed
// platform-specific candidate table (see `resolveFixedTestRuntimeOwners`
// below) — never `command -v`, never an ambient PATH search, never a spawn
// carrying `process.env`. The bundle also carries a harness-generated
// nonce marker (`.e2-owner-marker`) so the script can refuse to trust any
// directory it did not itself construct via this function (see the
// script-side comment for why the bundle still carries no uid==0/mode
// attestation claim — that is a separate, deliberate non-goal, unrelated to
// this provenance check). `posixDir` is the `/x/...`-mount-form path to
// hand the production script (it requires a leading `/`); `dir` is the
// native path for Node-side fs calls. Deterministically removed by
// `cleanup()`.
// ---------------------------------------------------------------------------
export const BUNDLE_TOOL_NAMES = ['node', 'curl', 'mktemp', 'rm', 'chmod', 'stat', 'cat'] as const;
type BundleToolName = (typeof BUNDLE_TOOL_NAMES)[number];
type FixedToolName = Exclude<BundleToolName, 'node'>;

export interface E2TestToolBundle {
  dir: string;
  posixDir: string;
  nonce: string;
  cleanup(): Promise<void>;
}

function toForwardSlashes(winPath: string): string {
  return winPath.replace(/\\/g, '/');
}

/** `C:\Users\x` -> `/c/Users/x` (leading-`/` form the script's path validator requires). */
export function toMsysMountPath(winPath: string): string {
  const normalized = toForwardSlashes(winPath);
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (match) {
    return `/${match[1].toLowerCase()}/${match[2]}`;
  }
  return normalized;
}

/**
 * R5R2-M1 (Remediation-5 Retry-3) — validates that `candidate` is: an
 * absolute path (`path.isAbsolute`, closing the prior gap where a
 * relative/PATH-relative-looking string could pass the remaining checks by
 * accident), already-canonical (no symlink indirection — `realpathSync`
 * must echo the same path back), a regular file, and executable — on POSIX
 * via a real `fs.accessSync(candidate, X_OK)` mode check; on Windows, where
 * `X_OK` collapses to a plain existence check, via a closed executable-
 * extension allowlist matching how these candidates are always constructed
 * here (`.exe`/`.cmd`/`.bat`, never a caller-suppliable extension). Returns
 * the candidate on success, `null` otherwise. Never touches PATH, never
 * spawns a process.
 */
export function validateFixedCandidate(candidate: string): string | null {
  try {
    if (!path.isAbsolute(candidate)) return null;
    if (!existsSync(candidate)) return null;
    const real = realpathSync(candidate);
    if (real !== candidate) return null;
    const st = statSync(candidate);
    if (!st.isFile()) return null;
    if (process.platform === 'win32') {
      if (!/\.(exe|cmd|bat)$/i.test(candidate)) return null;
    } else {
      accessSync(candidate, fsConstants.X_OK);
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Derives the platform-fixed coreutils/curl root directories from the
 * already-resolved fixed Bash candidate (`resolveBashPath`, itself never an
 * ambient PATH search — see `BASH_CANDIDATES` above). This is *structural
 * parsing* of one already-fixed, already-validated absolute path, not a
 * fresh discovery step: on Git-for-Windows, `usr\bin` (coreutils/cat/stat/
 * etc.) and `mingw64\bin` (curl) both live at fixed offsets from the same
 * Git installation root that owns the resolved bash.exe; on a POSIX host,
 * `/usr/bin` and `/bin` are the two fixed roots `BASH_CANDIDATES` itself
 * already draws from. No root here is caller-suppliable or PATH-derived.
 */
function deriveFixedToolRoots(bashPath: string): string[] {
  const winMatch = /^(.*)\\(?:bin|usr\\bin)\\bash\.exe$/i.exec(bashPath);
  if (winMatch) {
    const gitRoot = winMatch[1];
    return [path.join(gitRoot, 'usr', 'bin'), path.join(gitRoot, 'mingw64', 'bin')];
  }
  if (bashPath === '/usr/bin/bash' || bashPath === '/bin/bash') {
    return ['/usr/bin', '/bin'];
  }
  return [];
}

// R5R2-M1 (Remediation-5 Retry-3) — closed, literal candidate table for the
// Node owner, matching the same pattern `BASH_CANDIDATES` above already
// uses for bash: a small fixed list of known install locations, not derived
// from any ambient/caller-controllable input. `process.execPath` (the
// executable that happens to be running this test process) is no longer
// trusted merely because it launched the parent — Codex Retry-2 M1 flagged
// this as an unbounded parent-runtime identity, the same category of
// concern the production script's own `e2_verify_running_bash_identity`
// already treats `$BASH` with: the *observed* running identity is compared
// against an independently *attested fixed candidate*, never trusted
// directly. `resolveBoundedNodeOwner` below applies the identical pattern —
// the running interpreter (`process.execPath`, canonicalized) must equal
// one of these bounded candidates, or resolution fails closed.
const NODE_CANDIDATES_WIN = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'];
const NODE_CANDIDATES_POSIX = ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'];

/**
 * R5R2-M1 — bounded Node owner resolution. Validates each closed candidate
 * (absolute, canonical, regular, executable — via `validateFixedCandidate`)
 * and accepts it only if it is also, independently, the exact interpreter
 * currently running this process (`process.execPath`, canonicalized via the
 * same `realpathSync` used everywhere else in this file). A Node binary
 * that is not one of the closed candidates can never be trusted here no
 * matter what launched the test process; a closed candidate that exists on
 * disk but is not the one actually running is likewise not trusted (it
 * would be an unrelated, unverified install, not this run's own runtime).
 */
export function resolveBoundedNodeOwner(): string {
  const candidates = process.platform === 'win32' ? NODE_CANDIDATES_WIN : NODE_CANDIDATES_POSIX;
  let execPathReal: string;
  try {
    execPathReal = realpathSync(process.execPath);
  } catch {
    throw new Error('E2 test tool bundle: running Node interpreter path could not be canonicalized');
  }
  for (const candidate of candidates) {
    const validated = validateFixedCandidate(candidate);
    if (validated && validated === execPathReal) {
      return validated;
    }
  }
  throw new Error('E2 test tool bundle: no bounded fixed Node candidate matches the running interpreter');
}

let cachedFixedOwners: Record<BundleToolName, string> | null = null;

/**
 * R5R2-F1/F6 (Remediation-5 Retry-2), bounded Node owner added R5R2-M1
 * (Remediation-5 Retry-3) — closed fixed-absolute-owner resolver. Replaces
 * the prior `command -v`-based `resolveRealToolPaths`: every candidate here
 * comes from a fixed, platform-derived root table (`resolveBoundedNodeOwner`
 * for node; `deriveFixedToolRoots` for the other six), validated via
 * `fs.existsSync`/`fs.realpathSync`/`fs.statSync`/`fs.accessSync` only. No
 * child process is spawned to perform this resolution at all, so there is
 * no unsanitized-spawn surface here either (R5R2-F6) — the prior
 * `env: process.env` spawn this function used to perform is simply gone,
 * not merely sanitized.
 */
function resolveFixedTestRuntimeOwners(): Record<BundleToolName, string> {
  if (cachedFixedOwners) {
    return cachedFixedOwners;
  }
  const nodeOwner = resolveBoundedNodeOwner();
  const bashPath = resolveBashPath();
  if (!bashPath) {
    throw new Error('E2 test tool bundle: bash unavailable on this host');
  }
  const roots = deriveFixedToolRoots(bashPath);
  if (roots.length === 0) {
    throw new Error('E2 test tool bundle: no fixed tool root derivable for this host');
  }
  const owners = { node: nodeOwner } as Record<BundleToolName, string>;
  const remaining: FixedToolName[] = ['curl', 'mktemp', 'rm', 'chmod', 'stat', 'cat'];
  for (const tool of remaining) {
    const basenames = process.platform === 'win32' ? [`${tool}.exe`] : [tool];
    let found: string | null = null;
    for (const root of roots) {
      for (const base of basenames) {
        found = validateFixedCandidate(path.join(root, base));
        if (found) break;
      }
      if (found) break;
    }
    if (!found) {
      throw new Error(`E2 test tool bundle: fixed owner not found for ${tool}`);
    }
    owners[tool] = found;
  }
  cachedFixedOwners = owners;
  return owners;
}

// ---------------------------------------------------------------------------
// R5R4-F1 (Remediation-5 Retry-4), rebound to exact minted state R5R5-F1
// (Remediation-5 Retry-5) — non-forgeable bundle-provenance trust root. The
// nonce/marker/manifest/wrapper checks above all compare values that live
// entirely inside the caller-controlled environment and bundle directory, so
// a caller with ordinary approved-env + filesystem access can reproduce all
// of them self-consistently without ever calling this function (see
// R5R3-F1-BUNDLE-INTEGRITY). The production script's own committed source
// text — never writable by a caller through env or bundle-directory content
// — is one trust root: `E2_TEST_BUNDLE_CAPABILITY` is non-empty only in a
// private temporary script copy this file itself wrote.
//
// R5R4-F1 left a second gap open: Retry-4's `bundleScriptPaths` mapped a
// nonce to only a script path, so `spawnE2Script` selected the capability-
// bearing copy on nonce equality alone, independent of which bundle
// *directory* the caller actually supplied via `E2_TEST_TOOL_BUNDLE_DIR`. A
// caller holding a real, harness-minted nonce could therefore build an
// entirely different, self-consistent directory (its own marker copy,
// manifest, and seven wrappers, all internally consistent with each other)
// and have the real capability-bearing script trust it — the nonce/marker/
// manifest/wrapper checks inside the script never had any way to know that
// directory was not the one this function actually built (Codex Retry-4
// R5R4-F1-MINTED-NONCE-REBINDING).
//
// `mintedBundles` now records the complete state this function itself wrote
// for each nonce — not just the script path, but the exact bundle directory
// (both native and posix-mount forms), the exact marker/manifest bytes, and
// the exact bytes of all seven wrappers (which, byte-for-byte, already fix
// each wrapper's exec target — R5R6-F1 (Remediation-6) removed the separate
// `canonicalTargets` field this state used to also carry: it was written at
// mint time but never read by anything, since `wrapperBytes` equality below
// is strictly stronger than comparing resolved targets alone (it also
// catches non-target byte tampering the target-only field could never have
// detected). `resolveMintedCapabilityScript` below is the only reader:
// given a nonce and the caller-supplied `E2_TEST_TOOL_BUNDLE_DIR`, it
// requires the directory to equal — by exact posix-path string — the one
// this function actually minted for that nonce, and then re-reads the
// marker/manifest/wrapper files currently on disk at that directory and
// requires every byte to still equal what was written at mint time. Any
// mismatch (wrong directory, or the right directory with content mutated
// since minting) falls back to the checked-in canonical script, whose
// `E2_TEST_BUNDLE_CAPABILITY` is always empty and can therefore never
// satisfy `e2_verify_test_bundle_provenance` no matter how internally
// self-consistent the caller's directory is. This requires zero changes to
// any existing legitimate bundle-using call site: they keep passing
// `E2_TEST_TOOL_BUNDLE_DIR`/`E2_TEST_TOOL_BUNDLE_NONCE` exactly as before,
// and the correct script file is selected automatically because both really
// did come from this function, unmodified since.
// ---------------------------------------------------------------------------
interface MintedBundleState {
  scriptPath: string;
  scriptDir: string;
  bundleDir: string;
  bundlePosixDir: string;
  markerBytes: string;
  manifestBytes: string;
  wrapperBytes: Record<BundleToolName, string>;
}

const mintedBundles = new Map<string, MintedBundleState>();

/**
 * Sync (not async) so it can run inline inside `spawnE2Script`, which itself
 * must stay synchronous — callers rely on getting a live `child` handle back
 * immediately (e.g. to `child.kill(...)` mid-flight before awaiting
 * `result`). Returns the capability-bearing script path only when `nonce`
 * names a bundle this process actually minted AND `requestedPosixDir`
 * exactly matches that bundle's directory AND every tracked file's current
 * on-disk bytes still match what was written at mint time; `null` (meaning:
 * fall back to the empty-capability canonical script) otherwise.
 */
function resolveMintedCapabilityScript(nonce: string, requestedPosixDir: string | undefined): string | null {
  const state = mintedBundles.get(nonce);
  if (!state) return null;
  if (!requestedPosixDir || requestedPosixDir !== state.bundlePosixDir) return null;
  try {
    const markerActual = readFileSync(path.join(state.bundleDir, '.e2-owner-marker'), 'utf8');
    if (markerActual !== state.markerBytes) return null;
    const manifestActual = readFileSync(path.join(state.bundleDir, '.e2-owner-manifest'), 'utf8');
    if (manifestActual !== state.manifestBytes) return null;
    for (const tool of BUNDLE_TOOL_NAMES) {
      const actual = readFileSync(path.join(state.bundleDir, tool), 'utf8');
      if (actual !== state.wrapperBytes[tool]) return null;
    }
  } catch {
    return null;
  }
  return state.scriptPath;
}

/** Internal: never exported — only `buildE2TestToolBundle` may mint a capability copy. */
const CAPABILITY_PLACEHOLDER = 'readonly E2_TEST_BUNDLE_CAPABILITY=""';

async function buildCapabilityScriptCopy(token: string): Promise<{ scriptPath: string; dir: string }> {
  const source = await readFile(E2_SCRIPT_PATH, 'utf8');
  if (!source.includes(CAPABILITY_PLACEHOLDER)) {
    throw new Error(
      'E2 test tool bundle: capability placeholder not found in canonical script — cannot mint a bundle-capable copy',
    );
  }
  const patched = source.replace(CAPABILITY_PLACEHOLDER, `readonly E2_TEST_BUNDLE_CAPABILITY="${token}"`);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2-test-bundle-script-'));
  const scriptPath = path.join(dir, 'e2-shift-close-document-lookup.sh');
  await writeFile(scriptPath, patched, { mode: 0o700 });
  await chmod(scriptPath, 0o700).catch(() => {});
  return { scriptPath, dir };
}

export async function buildE2TestToolBundle(): Promise<E2TestToolBundle> {
  const owners = resolveFixedTestRuntimeOwners();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2-test-tool-bundle-'));
  const manifestLines: string[] = [];
  const wrapperBytes = {} as Record<BundleToolName, string>;
  for (const tool of BUNDLE_TOOL_NAMES) {
    const target = path.join(dir, tool);
    const shim = `#!/bin/bash\nexec "${toForwardSlashes(owners[tool])}" "$@"\n`;
    await writeFile(target, shim, { mode: 0o755 });
    await chmod(target, 0o755).catch(() => {});
    // R5R2-M1 (Remediation-5 Retry-3) — record the exact bytes just
    // written for this basename, hex-encoded so a tab/newline-delimited
    // manifest line can carry them unambiguously (the shim content itself
    // legitimately contains newlines). The script's
    // e2_verify_test_bundle_wrapper_content decodes this with its existing
    // `e2_pure_hex_decode_raw` and compares it against the wrapper's real
    // current on-disk bytes immediately before every accepted resolution —
    // see that function's header comment for why this, not the nonce
    // marker alone, is the actual content-integrity binding.
    manifestLines.push(`${tool}\t${Buffer.from(shim, 'utf8').toString('hex')}`);
    // R5R5-F1 (Remediation-5 Retry-5) — the exact same bytes, kept in
    // memory (never re-derived from disk) so `resolveMintedCapabilityScript`
    // can compare them against whatever bytes are actually on disk at spawn
    // time, independent of any manifest file content a caller could forge.
    wrapperBytes[tool] = shim;
  }
  // R5R2-F1/F6 — harness-generated unpredictable nonce (Node crypto),
  // written into a fixed marker file inside the bundle directory this
  // function itself just created. The matching value must be supplied
  // separately via E2_TEST_TOOL_BUNDLE_NONCE for the script's
  // e2_verify_test_bundle_provenance gate to accept this bundle.
  const nonce = randomBytes(32).toString('hex');
  const markerBytes = `${nonce}\n`;
  const manifestBytes = `${manifestLines.join('\n')}\n`;
  await writeFile(path.join(dir, '.e2-owner-marker'), markerBytes, { mode: 0o600 });
  await writeFile(path.join(dir, '.e2-owner-manifest'), manifestBytes, { mode: 0o600 });
  // R5R4-F1 — mint the one private capability-bearing script copy for this
  // exact nonce and register it so spawnE2Script routes to it automatically.
  const { scriptPath, dir: scriptDir } = await buildCapabilityScriptCopy(nonce);
  const bundlePosixDir = toMsysMountPath(dir);
  mintedBundles.set(nonce, {
    scriptPath,
    scriptDir,
    bundleDir: dir,
    bundlePosixDir,
    markerBytes,
    manifestBytes,
    wrapperBytes,
  });
  return {
    dir,
    posixDir: bundlePosixDir,
    nonce,
    async cleanup() {
      mintedBundles.delete(nonce);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Extracts the count of `test_body_created` diagnostic markers from stderr (R5R2-F5). */
export function countBodyCreated(stderr: string): number {
  const matches = stderr.match(/^test_body_created$/gm);
  return matches ? matches.length : 0;
}

/** Extracts the count of `test_proc_version_bound_rc=<0|1>` markers, keyed by value (R5R2-F3). */
export function parseProcVersionBoundRc(stderr: string): number | null {
  const match = /test_proc_version_bound_rc=(\d)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/** Extracts the `test_proc_version_decode_rc=<n>` marker (R5R2-M3, Remediation-5 Retry-3). */
export function parseProcVersionDecodeRc(stderr: string): number | null {
  const match = /test_proc_version_decode_rc=(\d)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/**
 * Extracts the count of `test_token_owner_invoked` diagnostic markers from
 * stderr (R5R4-F2, Remediation-5 Retry-4) — proves how many times
 * e2_get_access_token was actually entered, not merely that its downstream
 * outcomes (request/body/RESULT) were absent.
 */
export function countTokenOwnerInvocations(stderr: string): number {
  const matches = stderr.match(/^test_token_owner_invoked$/gm);
  return matches ? matches.length : 0;
}

/**
 * Extracts the `test_lookup_seam_gate=enter|skip` marker (R5R5-F4,
 * Remediation-5 Retry-5) — proves, independent of whatever the production
 * resolver does afterward, whether the host-independent lookup seam's own
 * test-mode+diagnostics+host-facts gate was entered.
 */
export function parseLookupSeamGate(stderr: string): 'enter' | 'skip' | null {
  const match = /^test_lookup_seam_gate=(enter|skip)$/m.exec(stderr);
  return match ? (match[1] as 'enter' | 'skip') : null;
}

/**
 * Extracts the `test_lookup_seam_bundle_used=<0|1>` marker (R5R5-F4,
 * Remediation-5 Retry-5) — proves, independent of whatever the production
 * resolver does afterward, whether the seam's own dispatch selected the
 * sanitizer-owned test tool bundle.
 */
export function parseLookupSeamBundleUsed(stderr: string): 0 | 1 | null {
  const match = /^test_lookup_seam_bundle_used=(\d)$/m.exec(stderr);
  if (!match) return null;
  return Number(match[1]) === 1 ? 1 : 0;
}
