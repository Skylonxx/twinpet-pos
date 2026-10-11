/**
 * TPOS-USABLE-POS-VOID-SSA1-LIFECYCLE-ORDER-FIX-CLAUDE-002 — the ONE ordering
 * domain for native staff-session (SSA1) mutations in this JS runtime.
 *
 * Every production caller of `native_clear_staff_session`,
 * `native_prepare_staff_session_challenge` and
 * `native_persist_staff_session_assertion` (branch switch, logout, Quick PIN
 * login issuance, login completion, PIN-identity departure, enrollment
 * preparation, privileged on-demand refresh) runs its whole mutation episode
 * through `runNativeStaffSessionEpisode`.
 *
 * Guarantees:
 *   - Queue order is reserved SYNCHRONOUSLY at submission (the sequence
 *     number and the chain position are taken before the caller's first await).
 *   - Episodes run strictly FIFO, one at a time. An episode awaits each of its
 *     native invokes, so every command it dispatched has completed before the
 *     next episode starts — ordering never depends on Tauri IPC request
 *     arrival order.
 *   - A rejected episode never poisons the queue; its submitter still sees the
 *     rejection.
 *   - Module scope: shared by every AuthProvider instance, so it also orders a
 *     torn-down provider's late episode before a newer provider's episodes.
 *
 * Holds only promises and a counter — never SSA1/SRF1/OKS1 bytes, PINs,
 * tokens or any other session payload.
 */

let tail: Promise<void> = Promise.resolve();
let lastSubmittedSeq = 0;

/**
 * Submit a complete native staff-session mutation episode. `seq` is this
 * episode's position in the global order; an SSA1 persisted by it may be
 * reported ready only while `seq` is still the latest submitted episode
 * (see `isLatestNativeStaffSessionEpisode`).
 */
export function runNativeStaffSessionEpisode<T>(episode: (seq: number) => Promise<T>): Promise<T> {
  lastSubmittedSeq += 1;
  const seq = lastSubmittedSeq;
  const run = tail.then(() => episode(seq));
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * True when no native staff-session episode was submitted after `seq`. Any
 * later episode (from any owner) may clear or replace the SSA1 that `seq`
 * persisted, so readiness bound to an older `seq` is no longer trusted.
 */
export function isLatestNativeStaffSessionEpisode(seq: number): boolean {
  return seq === lastSubmittedSeq;
}

/** Test-only: the sequence of the newest submitted episode (0 = none). Read-only. */
export function __lastSubmittedNativeStaffSessionSeqForTests(): number {
  return lastSubmittedSeq;
}

/** Test-only: resolves once every episode submitted so far has settled. */
export function __drainNativeStaffSessionCoordinatorForTests(): Promise<void> {
  return tail;
}

/**
 * Test-only isolation between test cases (a test that deliberately leaves a
 * gated native call unreleased must not block the next test). Never called by
 * production code.
 */
export function __resetNativeStaffSessionCoordinatorForTests(): void {
  tail = Promise.resolve();
  lastSubmittedSeq = 0;
}
