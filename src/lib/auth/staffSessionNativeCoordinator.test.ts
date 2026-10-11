/**
 * TPOS-USABLE-POS-VOID-SSA1-LIFECYCLE-ORDER-FIX-CLAUDE-002 — the module-scope
 * native staff-session coordinator: synchronous queue reservation, strict FIFO
 * independent of when individual native calls would complete, rejection
 * isolation, and ordering across logical owners (provider instances).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __drainNativeStaffSessionCoordinatorForTests,
  __resetNativeStaffSessionCoordinatorForTests,
  isLatestNativeStaffSessionEpisode,
  runNativeStaffSessionEpisode,
} from './staffSessionNativeCoordinator';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  __resetNativeStaffSessionCoordinatorForTests();
});

describe('runNativeStaffSessionEpisode', () => {
  it('reserves order and sequence synchronously at submission, before any await', async () => {
    const seen: number[] = [];
    const g = gate();
    const p1 = runNativeStaffSessionEpisode(async (seq) => {
      seen.push(seq);
      await g.promise;
    });
    const p2 = runNativeStaffSessionEpisode(async (seq) => {
      seen.push(seq);
    });
    // Both reserved synchronously: the newest is seq 2 already.
    expect(isLatestNativeStaffSessionEpisode(2)).toBe(true);
    expect(isLatestNativeStaffSessionEpisode(1)).toBe(false);
    await flush();
    expect(seen).toEqual([1]); // episode 2 has not started
    g.release();
    await Promise.all([p1, p2]);
    expect(seen).toEqual([1, 2]);
  });

  it('runs strictly FIFO even when later episodes\' native work would finish first', async () => {
    const gates = [gate(), gate(), gate()];
    const log: string[] = [];
    const runs = gates.map((g, i) =>
      runNativeStaffSessionEpisode(async () => {
        log.push(`start:${i}`);
        await g.promise;
        log.push(`end:${i}`);
      }),
    );
    // Adversarial release order: newest first.
    gates[2]!.release();
    gates[1]!.release();
    await flush();
    expect(log).toEqual(['start:0']);
    gates[0]!.release();
    await Promise.all(runs);
    expect(log).toEqual(['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('F6: a rejected episode reaches its submitter and never poisons later episodes', async () => {
    const failing = runNativeStaffSessionEpisode(async () => {
      throw new Error('NATIVE_FAILURE');
    });
    const next = runNativeStaffSessionEpisode(async () => 'ran');
    await expect(failing).rejects.toThrow('NATIVE_FAILURE');
    await expect(next).resolves.toBe('ran');
    const synchronousThrow = runNativeStaffSessionEpisode(() => {
      throw new Error('SYNC_FAILURE');
    });
    await expect(synchronousThrow).rejects.toThrow('SYNC_FAILURE');
    await expect(runNativeStaffSessionEpisode(async () => 'still-ran')).resolves.toBe('still-ran');
  });

  it('F5: two logical owners — an older owner\'s held clear cannot land after the newer owner\'s persist', async () => {
    let nativeSsa1: string | null = 'old-staff';
    const oldClear = gate();
    // Old owner (e.g. a torn-down provider) dispatched a clear that is slow.
    const oldOwner = runNativeStaffSessionEpisode(async () => {
      await oldClear.promise;
      nativeSsa1 = null;
    });
    // New owner (new provider/login) persists afterwards.
    let newSeq = 0;
    const newOwner = runNativeStaffSessionEpisode(async (seq) => {
      newSeq = seq;
      nativeSsa1 = 'new-staff';
    });
    await flush();
    expect(nativeSsa1).toBe('old-staff'); // new persist waits for the old clear
    oldClear.release();
    await Promise.all([oldOwner, newOwner]);
    expect(nativeSsa1).toBe('new-staff');
    expect(isLatestNativeStaffSessionEpisode(newSeq)).toBe(true);
  });

  it('drain resolves only after every submitted episode settled', async () => {
    const g = gate();
    let done = false;
    void runNativeStaffSessionEpisode(async () => {
      await g.promise;
      done = true;
    });
    const drained = __drainNativeStaffSessionCoordinatorForTests();
    await flush();
    expect(done).toBe(false);
    g.release();
    await drained;
    expect(done).toBe(true);
  });
});
