// @vitest-environment jsdom
/**
 * TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002 — D-V8 SSA1
 * continuity. Branch selection clears the old branch-bound native staff
 * session FIRST, then (Quick PIN identity only) re-establishes it for the
 * selected branch via the existing PIN-less SSA1_REFRESH. Refresh failure
 * leaves privileged actions blocked; a password session is never refreshed
 * and is told to use Quick PIN; ordinary password use is unaffected.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getDoc } from 'firebase/firestore';
import { AuthProvider } from './AuthProvider';
import {
  __lastSubmittedNativeStaffSessionSeqForTests,
  __resetNativeStaffSessionCoordinatorForTests,
  runNativeStaffSessionEpisode,
} from './staffSessionNativeCoordinator';
import { ensureAnonymousFirebaseAuthForPin } from '../firebaseAuth';
import { AuthProviderDisposedError, isAuthOperationSupersededError } from './authOperationError';
import { EnrollmentIdentityError } from './enrollmentIdentityError';
import { loadSession } from './session';
import { useAuth, type AuthContextValue } from '../hooks/useAuth';
import { verifyPinLogin } from './verifyPinLogin';
import { NATIVE_DEVICE_SECURITY_READINESS_COMMAND } from './nativeDeviceReadiness';

const h = vi.hoisted(() => {
  const currentUser = {
    uid: 'anon-uid',
    isAnonymous: true,
    getIdToken: vi.fn(async () => 'token'),
    getIdTokenResult: vi.fn(async () => ({ claims: { staffId: 'staff-1' } as Record<string, unknown> })),
  };
  return {
    auth: { currentUser } as { currentUser: typeof currentUser | null },
    currentUser,
    callables: {} as Record<string, ReturnType<typeof vi.fn>>,
  };
});

vi.mock('../firebase', () => ({
  auth: h.auth,
  app: {},
  db: {},
  isFirebaseConfigured: true,
  collections: { users: 'users' },
  authEmailForUsername: (u: string) => `${u}@example.invalid`,
}));
vi.mock('../firebaseAuth', () => ({
  ensureFirebaseAuth: vi.fn(async () => undefined),
  ensureAnonymousFirebaseAuthForPin: vi.fn(async () => h.auth.currentUser),
}));
vi.mock('./verifyPinLogin', () => ({ verifyPinLogin: vi.fn() }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: null) => void) => {
    cb(null);
    return () => undefined;
  },
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('./devUsers', () => ({ findDevUserByPin: vi.fn(), findDevUserByUsernamePassword: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  updateDoc: vi.fn(async () => undefined),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_fns: unknown, name: string) => h.callables[name] ?? vi.fn()),
}));

const mockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true, configurable: true });

const TAURI_KEY = '__TAURI__';
const GLOBAL_ADMIN = {
  id: 'staff-1',
  username: 'admin',
  firstName: 'A',
  lastName: 'B',
  role: 'admin',
  branchIds: ['ALL'],
  isActive: true,
  deletedAt: null,
};

function nativeInvoke(overrides: Record<string, (args?: unknown) => unknown> = {}) {
  return vi.fn(async (cmd: string, args?: unknown) => {
    if (overrides[cmd]) return overrides[cmd]!(args);
    switch (cmd) {
      case NATIVE_DEVICE_SECURITY_READINESS_COMMAND:
        return { readiness: 'READY' };
      case 'native_prepare_staff_session_challenge':
        return { generation: 9, sscp1ProofBase64: 'c3NjcDE=' };
      case 'native_persist_staff_session_assertion':
      case 'native_clear_staff_session':
        return undefined;
      default:
        throw new Error(`unexpected native command ${cmd}`);
    }
  });
}

async function renderAuth(history?: string[]): Promise<() => AuthContextValue> {
  let latest: AuthContextValue | null = null;
  function Grab() {
    latest = useAuth();
    history?.push(`${latest.branchId}|${latest.staffSessionStatus}`);
    return null;
  }
  render(
    <AuthProvider>
      <Grab />
    </AuthProvider>,
  );
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  return () => latest!;
}

const cmds = (invoke: ReturnType<typeof vi.fn>) => invoke.mock.calls.map((c) => c[0] as string);

async function quickPinLoginAsGlobalAdmin(ctx: () => AuthContextValue) {
  vi.mocked(verifyPinLogin).mockResolvedValue(GLOBAL_ADMIN as never);
  const user = await ctx().loginWithPin('1234', 'LDP-001', 'admin');
  await act(async () => ctx().completeLogin(user, 'ALL'));
}

beforeEach(() => {
  __resetNativeStaffSessionCoordinatorForTests();
  localStorage.clear();
  vi.mocked(verifyPinLogin).mockReset();
  vi.mocked(signInWithEmailAndPassword).mockReset();
  vi.mocked(getDoc).mockReset();
  h.auth.currentUser = h.currentUser;
  h.currentUser.isAnonymous = true;
  h.currentUser.getIdTokenResult.mockReset();
  h.currentUser.getIdTokenResult.mockImplementation(async () => ({ claims: { staffId: 'staff-1' } }));
  h.callables.issueOfflineStaffSessionAssertion = vi.fn(async () => ({
    data: { ok: true, ssa1Base64: 'c3NhMQ==', srf1Base64: 'c3JmMQ==' },
  }));
  h.callables.refreshOfflineStaffSessionAssertion = vi.fn(async () => ({
    data: { ok: true, ssa1Base64: 'c3NhMg==', srf1Base64: 'c3JmMg==' },
  }));
  h.callables.getOacKeysetManifest = vi.fn(async () => ({ data: { ok: true, oks1Base64: 'b2tzMQ==' } }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)[TAURI_KEY];
  vi.restoreAllMocks();
});

describe('D-V8 SSA1 continuity on branch selection', () => {
  it('Quick PIN + branch select: old SSA1 cleared FIRST, then a selected-branch SSA1_REFRESH is persisted -> ready', async () => {
    const invoke = nativeInvoke();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const ctx = await renderAuth();
    await quickPinLoginAsGlobalAdmin(ctx);
    expect(ctx().staffSessionStatus).toBe('ready');
    invoke.mockClear();

    await act(async () => {
      await ctx().setBranchId('LDP-001');
    });

    expect(cmds(invoke)).toEqual([
      'native_clear_staff_session',
      'native_prepare_staff_session_challenge',
      'native_persist_staff_session_assertion',
    ]);
    expect(invoke.mock.calls[1]![1]).toEqual({ purpose: 'SSA1_REFRESH', branchId: 'LDP-001', intendedStaffId: 'staff-1' });
    expect(h.callables.refreshOfflineStaffSessionAssertion).toHaveBeenCalledTimes(1);
    expect(ctx().branchId).toBe('LDP-001');
    expect(ctx().staffSessionStatus).toBe('ready');

    invoke.mockClear();
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('ready');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refresh failure: the old SSA1 stays cleared (no persist), status missing, privileged preflight blocked', async () => {
    const invoke = nativeInvoke();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const ctx = await renderAuth();
    await quickPinLoginAsGlobalAdmin(ctx);
    h.callables.refreshOfflineStaffSessionAssertion = vi.fn(async () => ({ data: { ok: false, code: 'device_branch_mismatch' } }));
    invoke.mockClear();

    await act(async () => {
      await ctx().setBranchId('LDP-001');
    });

    expect(cmds(invoke)).toEqual(['native_clear_staff_session', 'native_prepare_staff_session_challenge']);
    expect(cmds(invoke)).not.toContain('native_persist_staff_session_assertion');
    expect(ctx().staffSessionStatus).toBe('missing');
    // Ordinary use continues: the branch switch itself succeeded.
    expect(ctx().branchId).toBe('LDP-001');
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('unavailable');
  });

  it('a primary token claim for a DIFFERENT staff never refreshes (no identity broadening)', async () => {
    const invoke = nativeInvoke();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const ctx = await renderAuth();
    await quickPinLoginAsGlobalAdmin(ctx);
    h.currentUser.getIdTokenResult.mockImplementation(async () => ({ claims: { staffId: 'someone-else' } }));
    invoke.mockClear();

    await act(async () => {
      await ctx().setBranchId('LDP-001');
    });

    expect(cmds(invoke)).toEqual(['native_clear_staff_session']);
    expect(h.callables.refreshOfflineStaffSessionAssertion).not.toHaveBeenCalled();
    expect(ctx().staffSessionStatus).toBe('missing');
  });

  it('switching to ALL clears the SSA1 and never refreshes (no B-HQ / ALL fallback)', async () => {
    const invoke = nativeInvoke();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const ctx = await renderAuth();
    await quickPinLoginAsGlobalAdmin(ctx);
    invoke.mockClear();

    await act(async () => {
      await ctx().setBranchId('ALL');
    });

    expect(cmds(invoke)).toEqual(['native_clear_staff_session']);
    expect(h.callables.refreshOfflineStaffSessionAssertion).not.toHaveBeenCalled();
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('unavailable');
  });

  it('invalidateStaffSession (native DENIED_STAFF_SESSION) makes the next preflight re-establish SSA1', async () => {
    const invoke = nativeInvoke();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const ctx = await renderAuth();
    await quickPinLoginAsGlobalAdmin(ctx);
    await act(async () => {
      await ctx().setBranchId('LDP-001');
    });
    act(() => ctx().invalidateStaffSession());
    expect(ctx().staffSessionStatus).toBe('missing');
    invoke.mockClear();

    let preflight: string | undefined;
    await act(async () => {
      preflight = await ctx().ensurePrivilegedStaffSession();
    });
    expect(preflight).toBe('ready');
    expect(cmds(invoke)).toEqual(['native_prepare_staff_session_challenge', 'native_persist_staff_session_assertion']);
  });
});

describe('D-V8 password login boundary', () => {
  it('password session: ordinary session OK, SSA1 cleared, never refreshed, privileged preflight requires Quick PIN', async () => {
    const invoke = nativeInvoke();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const passwordUser = { uid: 'staff-1', isAnonymous: false, getIdToken: vi.fn(async () => 't'), getIdTokenResult: vi.fn() };
    vi.mocked(signInWithEmailAndPassword).mockImplementation(async () => {
      h.auth.currentUser = passwordUser as never;
      return {} as never;
    });
    vi.mocked(getDoc).mockResolvedValue({ exists: () => true, data: () => ({ ...GLOBAL_ADMIN }), id: 'staff-1' } as never);
    const ctx = await renderAuth();

    const user = await ctx().loginWithUsername('admin', 'pw', 'LDP-001');
    await act(async () => ctx().completeLogin(user, 'ALL'));
    expect(ctx().isAuthenticated).toBe(true);
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(cmds(invoke)).toContain('native_clear_staff_session');

    invoke.mockClear();
    await act(async () => {
      await ctx().setBranchId('LDP-001');
    });
    expect(ctx().branchId).toBe('LDP-001');
    expect(cmds(invoke)).toEqual(['native_clear_staff_session']);
    expect(h.callables.refreshOfflineStaffSessionAssertion).not.toHaveBeenCalled();
    expect(passwordUser.getIdTokenResult).not.toHaveBeenCalled();

    expect(await ctx().ensurePrivilegedStaffSession()).toBe('quick_pin_required');
    expect(h.callables.refreshOfflineStaffSessionAssertion).not.toHaveBeenCalled();
  });
});

describe('D-V8 web runtime', () => {
  it('no native bridge: preflight is not_native (existing web behavior unchanged)', async () => {
    const ctx = await renderAuth();
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('not_native');
  });
});

/**
 * TPOS-USABLE-POS-VOID-SSA1-BRANCH-RACE-FIX-CLAUDE-001 — overlapping branch
 * switches. The native simulator below is deliberately PERMISSIVE: it never
 * rejects a stale-generation persist, and a clear/persist lands only when its
 * gate is released. So these tests prove the provider's own ordering
 * (operation fence + serialized native episodes), not native's challenge
 * generation guard. Invariant: the last branch selection wins.
 */
type Gate = { promise: Promise<void>; release: () => void };
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

function nativeSimulator() {
  const sim = {
    ssa1Branch: null as string | null,
    nextGeneration: 1,
    challengeBranch: new Map<number, string>(),
    log: [] as string[],
    gates: {} as Record<string, Gate[]>,
    hold(cmd: string): Gate {
      const g = gate();
      (sim.gates[cmd] ??= []).push(g);
      return g;
    },
  };
  const invoke = vi.fn(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const held = sim.gates[cmd]?.shift();
    switch (cmd) {
      case NATIVE_DEVICE_SECURITY_READINESS_COMMAND:
        return { readiness: 'READY' };
      case 'native_prepare_staff_session_challenge': {
        const generation = sim.nextGeneration++;
        sim.challengeBranch.set(generation, a.branchId as string);
        sim.log.push(`prepare:${a.branchId as string}`);
        if (held) await held.promise;
        return { generation, sscp1ProofBase64: btoa(a.branchId as string) };
      }
      case 'native_persist_staff_session_assertion': {
        if (held) await held.promise;
        const branch = sim.challengeBranch.get(a.generation as number) ?? null;
        sim.ssa1Branch = branch;
        sim.log.push(`persist:${branch}`);
        return undefined;
      }
      case 'native_clear_staff_session':
        sim.log.push('clear:start');
        if (held) await held.promise;
        sim.ssa1Branch = null;
        sim.log.push('clear:done');
        return undefined;
      default:
        throw new Error(`unexpected native command ${cmd}`);
    }
  });
  return { sim, invoke };
}

/** Server refresh keyed by the branch encoded in the (simulated) challenge. */
function serverRefresh(opts: { hold?: Record<string, Gate>; failBranches?: string[] } = {}) {
  const fn = vi.fn(async (req: { sscp1Base64: string }) => {
    const branch = atob(req.sscp1Base64);
    const held = opts.hold?.[branch];
    if (held) await held.promise;
    if (opts.failBranches?.includes(branch)) return { data: { ok: false, code: 'device_branch_mismatch' } };
    return { data: { ok: true, ssa1Base64: 'c3NhMg==', srf1Base64: 'c3JmMg==' } };
  });
  h.callables.refreshOfflineStaffSessionAssertion = fn;
  return fn;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
const count = (log: string[], entry: string) => log.filter((l) => l === entry).length;

/** Quick PIN login, then a completed sequential switch to BR-0 (ready). */
async function readyOnBranch0(history: string[]) {
  const { sim, invoke } = nativeSimulator();
  (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
  const ctx = await renderAuth(history);
  await quickPinLoginAsGlobalAdmin(ctx);
  serverRefresh();
  await act(async () => {
    await ctx().setBranchId('BR-0');
  });
  expect(ctx().branchId).toBe('BR-0');
  expect(ctx().staffSessionStatus).toBe('ready');
  expect(sim.ssa1Branch).toBe('BR-0');
  sim.log.length = 0;
  history.length = 0;
  return { sim, invoke, ctx };
}

describe('SSA1 branch-switch race: last selection wins', () => {
  it("1. delayed first clear: B waits for A's clear; A never writes/refreshes; final branch/SSA1/ready = B", async () => {
    const history: string[] = [];
    const { sim, invoke, ctx } = await readyOnBranch0(history);
    const clearA = sim.hold('native_clear_staff_session');

    let pA!: Promise<void>;
    let pB!: Promise<void>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await settle();
    expect(sim.log).toEqual(['clear:start']);
    await act(async () => {
      pB = ctx().setBranchId('BR-B') as Promise<void>;
    });
    await settle();
    // B's native clear is ordered AFTER A's (still pending) clear.
    expect(count(sim.log, 'clear:start')).toBe(1);
    expect(ctx().staffSessionStatus).toBe('missing');
    // A branch switch owns the staff session: privileged preflight is blocked
    // and touches nothing native.
    const before = invoke.mock.calls.length;
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('unavailable');
    expect(invoke.mock.calls.length).toBe(before);

    // Adversarial: the stale A clear lands only now.
    await act(async () => {
      clearA.release();
      await pA;
      await pB;
    });

    expect(sim.log).toEqual(['clear:start', 'clear:done', 'clear:start', 'clear:done', 'prepare:BR-B', 'persist:BR-B']);
    expect(ctx().branchId).toBe('BR-B');
    expect(ctx().session?.branchId).toBe('BR-B');
    expect(ctx().staffSessionStatus).toBe('ready');
    expect(sim.ssa1Branch).toBe('BR-B');
    expect(history.some((e) => e.startsWith('BR-A|'))).toBe(false);
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('ready');
  });

  it('2. delayed first refresh: A resolves last, never persists, never marks ready; B wins', async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    const refreshA = gate();
    const refresh = serverRefresh({ hold: { 'BR-A': refreshA } });

    let pA!: Promise<void>;
    let pB!: Promise<void>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(ctx().staffSessionStatus).toBe('refreshing');
    await act(async () => {
      pB = ctx().setBranchId('BR-B') as Promise<void>;
    });
    await settle();
    expect(ctx().staffSessionStatus).toBe('missing');
    // B's clear waits for A's in-flight episode.
    expect(count(sim.log, 'clear:start')).toBe(1);

    await act(async () => {
      refreshA.release();
      await pA;
      await pB;
    });

    expect(sim.log).toEqual([
      'clear:start', 'clear:done', 'prepare:BR-A',
      'clear:start', 'clear:done', 'prepare:BR-B', 'persist:BR-B',
    ]);
    expect(ctx().branchId).toBe('BR-B');
    expect(ctx().staffSessionStatus).toBe('ready');
    expect(sim.ssa1Branch).toBe('BR-B');
    expect(history).not.toContain('BR-A|ready');
  });

  it("2b. A's persist already in flight when B arrives: B's clear lands after it, so A's SSA1 cannot survive", async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    serverRefresh();
    const persistA = sim.hold('native_persist_staff_session_assertion');

    let pA!: Promise<void>;
    let pB!: Promise<void>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await waitFor(() => expect(sim.log).toContain('prepare:BR-A'));
    await settle();
    await act(async () => {
      pB = ctx().setBranchId('BR-B') as Promise<void>;
    });
    await settle();
    expect(count(sim.log, 'clear:start')).toBe(1);

    await act(async () => {
      persistA.release();
      await pA;
      await pB;
    });

    // A's late persist lands, and B's clear is strictly after it.
    expect(sim.log).toEqual([
      'clear:start', 'clear:done', 'prepare:BR-A', 'persist:BR-A',
      'clear:start', 'clear:done', 'prepare:BR-B', 'persist:BR-B',
    ]);
    expect(sim.ssa1Branch).toBe('BR-B');
    expect(ctx().branchId).toBe('BR-B');
    expect(ctx().staffSessionStatus).toBe('ready');
    expect(history).not.toContain('BR-A|ready');
  });

  it('3. rapid A/B/C: superseded B never touches native; final branch/SSA1/ready = C only', async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    const clearA = sim.hold('native_clear_staff_session');

    const pending: Promise<void>[] = [];
    await act(async () => {
      pending.push(ctx().setBranchId('BR-A') as Promise<void>);
    });
    await settle();
    await act(async () => {
      pending.push(ctx().setBranchId('BR-B') as Promise<void>);
    });
    await act(async () => {
      pending.push(ctx().setBranchId('BR-C') as Promise<void>);
    });
    await settle();
    expect(count(sim.log, 'clear:start')).toBe(1);

    await act(async () => {
      clearA.release();
      await Promise.all(pending);
    });

    expect(sim.log).toEqual(['clear:start', 'clear:done', 'clear:start', 'clear:done', 'prepare:BR-C', 'persist:BR-C']);
    expect(ctx().branchId).toBe('BR-C');
    expect(ctx().staffSessionStatus).toBe('ready');
    expect(sim.ssa1Branch).toBe('BR-C');
    expect(history.some((e) => e.startsWith('BR-A|') || e.startsWith('BR-B|'))).toBe(false);
  });

  it('4. winning refresh failure: branch stays the newest, status missing, older request cannot restore ready', async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    const refreshA = gate();
    const refresh = serverRefresh({ hold: { 'BR-A': refreshA }, failBranches: ['BR-B'] });

    let pA!: Promise<void>;
    let pB!: Promise<void>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await act(async () => {
      pB = ctx().setBranchId('BR-B') as Promise<void>;
    });
    await settle();
    // A's refresh succeeds on the server, but only after B took over.
    await act(async () => {
      refreshA.release();
      await pA;
      await pB;
    });

    expect(sim.log).not.toContain('persist:BR-A');
    expect(sim.log).not.toContain('persist:BR-B');
    expect(sim.ssa1Branch).toBeNull();
    expect(ctx().branchId).toBe('BR-B');
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(history.some((e) => e.endsWith('|ready'))).toBe(false);
    // The next preflight retries for B only and stays blocked.
    let preflight: string | undefined;
    await act(async () => {
      preflight = await ctx().ensurePrivilegedStaffSession();
    });
    expect(preflight).toBe('unavailable');
    expect(ctx().branchId).toBe('BR-B');
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(sim.log.filter((l) => l.startsWith('prepare:'))).toEqual(['prepare:BR-A', 'prepare:BR-B', 'prepare:BR-B']);
  });

  it('logout during an in-flight switch: the switch never persists, writes or marks ready', async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    const refreshA = gate();
    const refresh = serverRefresh({ hold: { 'BR-A': refreshA } });

    let pA!: Promise<void>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // SSA1-LIFECYCLE-ORDER: logout's native clear is queued in the one
    // ordering domain, strictly after the in-flight switch episode.
    let pLogout!: Promise<void>;
    await act(async () => {
      pLogout = ctx().logout();
    });
    await settle();
    expect(count(sim.log, 'clear:start')).toBe(1);
    await act(async () => {
      refreshA.release();
      await pA;
      await pLogout;
    });

    expect(sim.log).not.toContain('persist:BR-A');
    expect(sim.log).toEqual(['clear:start', 'clear:done', 'prepare:BR-A', 'clear:start', 'clear:done']);
    expect(sim.ssa1Branch).toBeNull();
    expect(ctx().session).toBeNull();
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(history).not.toContain('BR-A|ready');
  });

  it('5. password session: overlapping switches end on the newest branch, no SSA1 refresh, Quick PIN still required', async () => {
    const { sim, invoke } = nativeSimulator();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const refresh = serverRefresh();
    const passwordUser = { uid: 'staff-1', isAnonymous: false, getIdToken: vi.fn(async () => 't'), getIdTokenResult: vi.fn() };
    vi.mocked(signInWithEmailAndPassword).mockImplementation(async () => {
      h.auth.currentUser = passwordUser as never;
      return {} as never;
    });
    vi.mocked(getDoc).mockResolvedValue({ exists: () => true, data: () => ({ ...GLOBAL_ADMIN }), id: 'staff-1' } as never);
    const history: string[] = [];
    const ctx = await renderAuth(history);
    const user = await ctx().loginWithUsername('admin', 'pw', 'LDP-001');
    await act(async () => ctx().completeLogin(user, 'ALL'));
    sim.log.length = 0;
    const clearA = sim.hold('native_clear_staff_session');

    let pA!: Promise<void>;
    let pB!: Promise<void>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await settle();
    await act(async () => {
      pB = ctx().setBranchId('BR-B') as Promise<void>;
    });
    await act(async () => {
      clearA.release();
      await pA;
      await pB;
    });

    expect(ctx().isAuthenticated).toBe(true);
    expect(ctx().branchId).toBe('BR-B');
    expect(sim.log).toEqual(['clear:start', 'clear:done', 'clear:start', 'clear:done']);
    expect(refresh).not.toHaveBeenCalled();
    expect(passwordUser.getIdTokenResult).not.toHaveBeenCalled();
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('quick_pin_required');
    expect(history.some((e) => e.endsWith('|ready'))).toBe(false);
  });
});

/**
 * TPOS-USABLE-POS-VOID-SSA1-LIFECYCLE-ORDER-FIX-CLAUDE-002 — one ordering
 * domain for ALL native staff-session mutations (branch switch, logout, Quick
 * PIN issuance, password-login completion, provider replacement). Same
 * permissive simulator: native never rejects a stale clear/persist, and each
 * held command lands only when released — so only the provider's global
 * ordering can make these pass.
 */
const NEW_STAFF = {
  ...GLOBAL_ADMIN,
  id: 'staff-2',
  username: 'cashier2',
  role: 'manager',
  branchIds: ['BR-N'],
};

/** Start (not await) a Quick PIN login for NEW_STAFF on BR-N. */
function startNewQuickPinLogin(ctx: () => AuthContextValue): Promise<unknown> {
  h.currentUser.getIdTokenResult.mockImplementation(async () => ({ claims: { staffId: NEW_STAFF.id } }));
  vi.mocked(verifyPinLogin).mockResolvedValue(NEW_STAFF as never);
  return ctx().loginWithPin('5678', 'BR-N', NEW_STAFF.username);
}

async function expectNewLoginNativeReady(ctx: () => AuthContextValue, sim: ReturnType<typeof nativeSimulator>['sim']) {
  expect(sim.ssa1Branch).toBe('BR-N');
  expect(ctx().session?.user.id).toBe(NEW_STAFF.id);
  expect(ctx().branchId).toBe('BR-N');
  expect(ctx().staffSessionStatus).toBe('ready');
  const before = sim.log.length;
  let preflight: string | undefined;
  await act(async () => {
    preflight = await ctx().ensurePrivilegedStaffSession();
  });
  expect(preflight).toBe('ready');
  // `ready` was trusted as-is: no further native mutation was needed.
  expect(sim.log.length).toBe(before);
}

describe('SSA1 lifecycle order: branch / logout / login share one native ordering domain', () => {
  it('F1 (exact Codex blocker): held old branch clear -> logout -> new Quick PIN login; old clear released last cannot erase the new SSA1', async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    const clearA = sim.hold('native_clear_staff_session');

    let pA!: Promise<void>;
    let pLogout!: Promise<void>;
    let pLogin!: Promise<unknown>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await settle();
    expect(sim.log).toEqual(['clear:start']);
    await act(async () => {
      pLogout = ctx().logout();
    });
    await act(async () => {
      pLogin = startNewQuickPinLogin(ctx);
    });
    await settle();
    // Nothing behind A's held clear has reached native yet.
    expect(sim.log).toEqual(['clear:start']);
    expect(ctx().staffSessionStatus).toBe('missing');

    // Adversarial: the OLD clear lands only now.
    let user: unknown;
    await act(async () => {
      clearA.release();
      await pA;
      await pLogout;
      user = await pLogin;
    });
    await act(async () => ctx().completeLogin(user as never, 'BR-N'));

    // old branch clear -> logout clear -> new login prepare/persist.
    expect(sim.log).toEqual(['clear:start', 'clear:done', 'clear:start', 'clear:done', 'prepare:BR-N', 'persist:BR-N']);
    await expectNewLoginNativeReady(ctx, sim);
    expect(history).not.toContain('BR-A|ready');
  });

  it('F2: old branch clear + logout clear + new login, gates released in reverse: old clear never executes after the new persist', async () => {
    const { sim, ctx } = await readyOnBranch0([]);
    const clearA = sim.hold('native_clear_staff_session');
    const clearLogout = sim.hold('native_clear_staff_session');

    let pA!: Promise<void>;
    let pLogout!: Promise<void>;
    let pLogin!: Promise<unknown>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await settle();
    await act(async () => {
      pLogout = ctx().logout();
      pLogin = startNewQuickPinLogin(ctx);
    });
    // Release the LOGOUT gate first: logout's clear is not even dispatched
    // while the older branch episode is still pending.
    await act(async () => {
      clearLogout.release();
    });
    await settle();
    expect(sim.log).toEqual(['clear:start']);
    expect(sim.log).not.toContain('persist:BR-N');

    let user: unknown;
    await act(async () => {
      clearA.release();
      await pA;
      await pLogout;
      user = await pLogin;
    });
    await act(async () => ctx().completeLogin(user as never, 'BR-N'));

    const persistAt = sim.log.indexOf('persist:BR-N');
    expect(persistAt).toBeGreaterThan(-1);
    // Every clear started and finished before the new persist.
    expect(sim.log.slice(persistAt + 1)).toEqual([]);
    expect(count(sim.log, 'clear:done')).toBe(2);
    await expectNewLoginNativeReady(ctx, sim);
  });

  it('F3: old refresh persist already in flight + logout + new login: the new login still finishes last and owns SSA1', async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    serverRefresh();
    const persistA = sim.hold('native_persist_staff_session_assertion');

    let pA!: Promise<void>;
    let pLogout!: Promise<void>;
    let pLogin!: Promise<unknown>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await waitFor(() => expect(sim.log).toContain('prepare:BR-A'));
    await settle();
    await act(async () => {
      pLogout = ctx().logout();
      pLogin = startNewQuickPinLogin(ctx);
    });
    await settle();
    expect(sim.log).toEqual(['clear:start', 'clear:done', 'prepare:BR-A']);

    let user: unknown;
    await act(async () => {
      persistA.release();
      await pA;
      await pLogout;
      user = await pLogin;
    });
    await act(async () => ctx().completeLogin(user as never, 'BR-N'));

    expect(sim.log).toEqual([
      'clear:start', 'clear:done', 'prepare:BR-A', 'persist:BR-A',
      'clear:start', 'clear:done',
      'prepare:BR-N', 'persist:BR-N',
    ]);
    await expectNewLoginNativeReady(ctx, sim);
    expect(history).not.toContain('BR-A|ready');
  });

  it('F4: password-login replacement: an old in-flight branch persist cannot revive SSA1; Quick PIN still required', async () => {
    const history: string[] = [];
    const { sim, ctx } = await readyOnBranch0(history);
    serverRefresh();
    const persistA = sim.hold('native_persist_staff_session_assertion');

    let pA!: Promise<void>;
    await act(async () => {
      pA = ctx().setBranchId('BR-A') as Promise<void>;
    });
    await waitFor(() => expect(sim.log).toContain('prepare:BR-A'));
    await settle();

    const passwordUser = { uid: 'pw-uid', isAnonymous: false, getIdToken: vi.fn(async () => 't'), getIdTokenResult: vi.fn() };
    vi.mocked(signInWithEmailAndPassword).mockImplementation(async () => {
      h.auth.currentUser = passwordUser as never;
      return {} as never;
    });
    const PW_USER = { ...GLOBAL_ADMIN, id: 'pw-uid', username: 'pw' };
    vi.mocked(getDoc).mockResolvedValue({ exists: () => true, data: () => ({ ...PW_USER }), id: 'pw-uid' } as never);

    let pLogout!: Promise<void>;
    await act(async () => {
      pLogout = ctx().logout();
    });
    const pwUser = await ctx().loginWithUsername('pw', 'secret', 'BR-P');
    let pComplete!: Promise<void>;
    await act(async () => {
      pComplete = ctx().completeLogin(pwUser, 'BR-P');
    });
    await settle();
    // The password completion clear is queued behind the old persist.
    expect(ctx().session?.user.id).not.toBe('pw-uid');

    await act(async () => {
      persistA.release();
      await pA;
      await pLogout;
      await pComplete;
    });

    expect(sim.log).toEqual([
      'clear:start', 'clear:done', 'prepare:BR-A', 'persist:BR-A',
      'clear:start', 'clear:done',
      'clear:start', 'clear:done',
    ]);
    expect(sim.ssa1Branch).toBeNull();
    expect(ctx().session?.user.id).toBe('pw-uid');
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(passwordUser.getIdTokenResult).not.toHaveBeenCalled();
    expect(await ctx().ensurePrivilegedStaffSession()).toBe('quick_pin_required');
    expect(history.some((e) => e.endsWith('|ready'))).toBe(false);
  });

  it('F5: provider replacement: a torn-down provider\'s held clear cannot erase the newer provider\'s login SSA1', async () => {
    const { sim, invoke } = nativeSimulator();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    serverRefresh();

    // Old owner: Quick PIN, ready on BR-0, then a branch switch whose clear is held.
    let oldLatest: AuthContextValue | null = null;
    function GrabOld() {
      oldLatest = useAuth();
      return null;
    }
    const oldTree = render(
      <AuthProvider>
        <GrabOld />
      </AuthProvider>,
    );
    await waitFor(() => expect(oldLatest?.isLoading).toBe(false));
    const oldCtx = () => oldLatest!;
    await quickPinLoginAsGlobalAdmin(oldCtx);
    await act(async () => {
      await oldCtx().setBranchId('BR-0');
    });
    sim.log.length = 0;
    const clearOld = sim.hold('native_clear_staff_session');
    let pOld!: Promise<void>;
    await act(async () => {
      pOld = oldCtx().setBranchId('BR-A') as Promise<void>;
    });
    await settle();
    expect(sim.log).toEqual(['clear:start']);

    // The old provider is torn down; a new provider and login take over.
    oldTree.unmount();
    const ctx = await renderAuth();
    let pLogin!: Promise<unknown>;
    await act(async () => {
      pLogin = startNewQuickPinLogin(ctx);
    });
    await settle();
    expect(sim.log).toEqual(['clear:start']);

    let user: unknown;
    await act(async () => {
      clearOld.release();
      await pOld;
      user = await pLogin;
    });
    await act(async () => ctx().completeLogin(user as never, 'BR-N'));

    // The old owner stopped after its clear (no refresh); the new login is last.
    expect(sim.log).toEqual(['clear:start', 'clear:done', 'prepare:BR-N', 'persist:BR-N']);
    await expectNewLoginNativeReady(ctx, sim);
  });

  it('F6: a failing native episode (logout clear rejects) does not poison the next login episode', async () => {
    const { sim, invoke, ctx } = await readyOnBranch0([]);
    const base = invoke.getMockImplementation()!;
    let failedOnce = false;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'native_clear_staff_session' && !failedOnce) {
        failedOnce = true;
        throw new Error('NATIVE_CLEAR_FAILURE');
      }
      return base(cmd, args);
    });

    let logoutError: unknown;
    await act(async () => {
      await ctx().logout().catch((e: unknown) => {
        logoutError = e;
      });
    });
    expect((logoutError as Error).message).toBe('NATIVE_CLEAR_FAILURE');
    // Existing fail-closed contract: the session stays, status is missing.
    expect(ctx().session?.user.id).toBe('staff-1');
    expect(ctx().staffSessionStatus).toBe('missing');

    let user: unknown;
    await act(async () => {
      user = await startNewQuickPinLogin(ctx);
    });
    await act(async () => ctx().completeLogin(user as never, 'BR-N'));
    expect(sim.log).toEqual(['prepare:BR-N', 'persist:BR-N']);
    await expectNewLoginNativeReady(ctx, sim);
  });

  it('ready is invalidated by any later-queued native episode, and the next preflight re-establishes it for the current session', async () => {
    const { sim, ctx } = await readyOnBranch0([]);
    serverRefresh();
    // A later episode queued by another owner (e.g. a torn-down provider).
    await act(async () => {
      await runNativeStaffSessionEpisode(async () => undefined);
    });
    let preflight: string | undefined;
    await act(async () => {
      preflight = await ctx().ensurePrivilegedStaffSession();
    });
    expect(preflight).toBe('ready');
    // It did not trust the stale marker: it refreshed SSA1 for BR-0.
    expect(sim.log).toEqual(['prepare:BR-0', 'persist:BR-0']);
    expect(sim.ssa1Branch).toBe('BR-0');
  });
});

/**
 * TPOS-USABLE-POS-VOID-SSA1-DISPOSED-GUARD-FIX-CLAUDE-003 — once a provider is
 * unmounted, every public callback it handed out (still retained by closures
 * or pending handlers) is inert: it submits no coordinator episode, makes no
 * native/server call, writes no shared saved session, changes no Firebase
 * Auth state and marks nothing ready. The mounted provider is the sole owner.
 * Episodes the old provider submitted BEFORE teardown stay FIFO-ordered.
 */
function mountProvider(opts: { strict?: boolean } = {}) {
  let latest: AuthContextValue | null = null;
  function Grab() {
    latest = useAuth();
    return null;
  }
  const tree = (
    <AuthProvider>
      <Grab />
    </AuthProvider>
  );
  const rendered = render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return {
    ctx: () => latest!,
    loaded: () => waitFor(() => expect(latest?.isLoading).toBe(false)),
    unmount: () => rendered.unmount(),
  };
}

const seqNow = () => __lastSubmittedNativeStaffSessionSeqForTests();

/** Observe a promise's outcome at creation time (no late rejection handler). */
function outcomeOf<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/**
 * Provider A: Quick PIN, ready on BR-0; its public callbacks are retained,
 * then A is unmounted. Provider B: NEW_STAFF Quick PIN login on BR-N, ready.
 */
async function retainedOldProviderAndReadyNewProvider() {
  const { sim, invoke } = nativeSimulator();
  (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
  serverRefresh();
  const a = mountProvider();
  await a.loaded();
  await quickPinLoginAsGlobalAdmin(a.ctx);
  await act(async () => {
    await a.ctx().setBranchId('BR-0');
  });
  expect(a.ctx().staffSessionStatus).toBe('ready');
  const retained = a.ctx();
  a.unmount();

  const ctx = await renderAuth();
  let user: unknown;
  await act(async () => {
    user = await startNewQuickPinLogin(ctx);
  });
  await act(async () => ctx().completeLogin(user as never, 'BR-N'));
  expect(sim.ssa1Branch).toBe('BR-N');
  expect(ctx().staffSessionStatus).toBe('ready');

  sim.log.length = 0;
  invoke.mockClear();
  vi.mocked(verifyPinLogin).mockClear();
  vi.mocked(ensureAnonymousFirebaseAuthForPin).mockClear();
  vi.mocked(signInWithEmailAndPassword).mockClear();
  vi.mocked(signOut).mockClear();
  h.callables.refreshOfflineStaffSessionAssertion!.mockClear();
  h.callables.issueOfflineStaffSessionAssertion!.mockClear();
  return { sim, invoke, ctx, retained, seq: seqNow() };
}

/** B's session, saved session, Firebase user, native SSA1 and `ready` are untouched. */
async function expectNewProviderUntouched(
  ctx: () => AuthContextValue,
  sim: ReturnType<typeof nativeSimulator>['sim'],
  invoke: ReturnType<typeof vi.fn>,
  seq: number,
) {
  expect(seqNow()).toBe(seq); // zero new coordinator episodes
  expect(invoke).not.toHaveBeenCalled(); // zero native calls of any kind
  expect(sim.log).toEqual([]);
  expect(loadSession()?.user.id).toBe(NEW_STAFF.id);
  expect(loadSession()?.branchId).toBe('BR-N');
  expect(h.auth.currentUser).toBe(h.currentUser);
  expect(signOut).not.toHaveBeenCalled();
  expect(h.callables.refreshOfflineStaffSessionAssertion).not.toHaveBeenCalled();
  expect(h.callables.issueOfflineStaffSessionAssertion).not.toHaveBeenCalled();
  // Preflight trusts B's binding as-is: its episode is still the newest.
  await expectNewLoginNativeReady(ctx, sim);
}

describe('SSA1 provider disposal: retained callbacks of an unmounted provider are inert', () => {
  it('G1: retained old setBranchId after remount: no episode, no native call; B session/SSA1/ready unchanged', async () => {
    const { sim, invoke, ctx, retained, seq } = await retainedOldProviderAndReadyNewProvider();
    let result: unknown = 'not-settled';
    await act(async () => {
      result = await retained.setBranchId('BR-A');
    });
    await settle();
    expect(result).toBeUndefined(); // silent no-op
    await expectNewProviderUntouched(ctx, sim, invoke, seq);
  });

  it('G2: retained old logout after remount: no native clear, no saved-session clear, no Firebase signOut', async () => {
    const { sim, invoke, ctx, retained, seq } = await retainedOldProviderAndReadyNewProvider();
    let result: unknown = 'not-settled';
    await act(async () => {
      result = await retained.logout();
    });
    await settle();
    expect(result).toBeUndefined(); // silent no-op
    expect(ctx().session?.user.id).toBe(NEW_STAFF.id);
    await expectNewProviderUntouched(ctx, sim, invoke, seq);
  });

  it('G3: retained old loginWithPin / loginWithUsername / completeLogin: rejected before any identity, PIN or native work', async () => {
    const { sim, invoke, ctx, retained, seq } = await retainedOldProviderAndReadyNewProvider();
    vi.mocked(verifyPinLogin).mockResolvedValue(GLOBAL_ADMIN as never);
    const pin = outcomeOf(retained.loginWithPin('1234', 'BR-0', 'admin'));
    const password = outcomeOf(retained.loginWithUsername('admin', 'secret', 'BR-0'));
    const complete = outcomeOf(retained.completeLogin(GLOBAL_ADMIN as never, 'BR-0'));
    await settle();
    for (const outcome of [await pin, await password, await complete]) {
      expect(outcome.ok).toBe(false);
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(AuthProviderDisposedError);
      // Existing superseded handling (fixed copy, never "wrong PIN") applies.
      expect(isAuthOperationSupersededError(error)).toBe(true);
    }
    expect(ensureAnonymousFirebaseAuthForPin).not.toHaveBeenCalled();
    expect(verifyPinLogin).not.toHaveBeenCalled();
    expect(signInWithEmailAndPassword).not.toHaveBeenCalled();
    await expectNewProviderUntouched(ctx, sim, invoke, seq);
  });

  it('G4: retained old preflight / enrollment prep / invalidate: fail closed with no native or server call', async () => {
    const { sim, invoke, ctx, retained, seq } = await retainedOldProviderAndReadyNewProvider();
    expect(await retained.ensurePrivilegedStaffSession()).toBe('unavailable');
    const enrollment = await outcomeOf(retained.prepareEnrollmentIdentity());
    expect(enrollment.ok).toBe(false);
    const enrollmentError = (enrollment as { error: unknown }).error;
    expect(enrollmentError).toBeInstanceOf(EnrollmentIdentityError);
    expect((enrollmentError as EnrollmentIdentityError).code).toBe('ENROLLMENT_IDENTITY_UNAVAILABLE');
    act(() => retained.invalidateStaffSession());
    await settle();
    expect(ensureAnonymousFirebaseAuthForPin).not.toHaveBeenCalled();
    await expectNewProviderUntouched(ctx, sim, invoke, seq);
  });

  it("G5: old provider's already-submitted episode stays ordered; after teardown it cannot submit another; B's SSA1 wins", async () => {
    const { sim, invoke } = nativeSimulator();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    serverRefresh();
    const a = mountProvider();
    await a.loaded();
    await quickPinLoginAsGlobalAdmin(a.ctx);
    await act(async () => {
      await a.ctx().setBranchId('BR-0');
    });
    sim.log.length = 0;
    const clearOld = sim.hold('native_clear_staff_session');
    let pOld!: Promise<void>;
    await act(async () => {
      pOld = a.ctx().setBranchId('BR-A') as Promise<void>;
    });
    await settle();
    expect(sim.log).toEqual(['clear:start']);
    const retained = a.ctx();
    a.unmount();

    const ctx = await renderAuth();
    let pLogin!: Promise<unknown>;
    await act(async () => {
      pLogin = startNewQuickPinLogin(ctx);
    });
    await settle();
    // Queued so far: A's login, BR-0 switch and held BR-A switch; B's login.
    const seqWithB = seqNow();
    expect(seqWithB).toBe(4);

    // The old provider's retained callbacks try to start NEW work while its
    // already-submitted clear is still draining.
    vi.mocked(signOut).mockClear();
    const retainedCalls = [
      outcomeOf(Promise.resolve(retained.setBranchId('BR-Z'))),
      outcomeOf(retained.logout()),
      outcomeOf(retained.ensurePrivilegedStaffSession()),
    ];
    // Checked synchronously: a submission would have taken a sequence already.
    expect(seqNow()).toBe(seqWithB); // no new episode from A
    await settle();
    expect(seqNow()).toBe(seqWithB);
    expect(sim.log).toEqual(['clear:start']);
    expect(await Promise.all(retainedCalls)).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
      { ok: true, value: 'unavailable' },
    ]);

    let user: unknown;
    await act(async () => {
      clearOld.release();
      await pOld;
      user = await pLogin;
    });
    await act(async () => ctx().completeLogin(user as never, 'BR-N'));
    // A's held clear landed first and A then stopped (no refresh); B is last.
    expect(sim.log).toEqual(['clear:start', 'clear:done', 'prepare:BR-N', 'persist:BR-N']);
    expect(signOut).not.toHaveBeenCalled();
    await expectNewLoginNativeReady(ctx, sim);
  });

  it('G6a: loginWithPin disposed before its first await returns: no Firebase identity change, no verify, no episode', async () => {
    const { sim, invoke } = nativeSimulator();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const a = mountProvider();
    await a.loaded();
    const base = invoke.getMockImplementation()!;
    const readiness = gate();
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === NATIVE_DEVICE_SECURITY_READINESS_COMMAND) await readiness.promise;
      return base(cmd, args);
    });
    vi.mocked(verifyPinLogin).mockResolvedValue(GLOBAL_ADMIN as never);
    vi.mocked(ensureAnonymousFirebaseAuthForPin).mockClear();
    const login = outcomeOf(a.ctx().loginWithPin('1234', 'LDP-001', 'admin'));
    await settle();
    a.unmount();
    await act(async () => {
      readiness.release();
      await login;
    });
    await settle();
    const outcome = await login;
    expect(outcome.ok).toBe(false);
    expect(isAuthOperationSupersededError((outcome as { error: unknown }).error)).toBe(true);
    expect(ensureAnonymousFirebaseAuthForPin).not.toHaveBeenCalled();
    expect(verifyPinLogin).not.toHaveBeenCalled();
    expect(seqNow()).toBe(0);
    expect(sim.log).toEqual([]);
    expect(loadSession()).toBeNull();
  });

  it('G6b: completeLogin disposed before its first await returns: no clear episode, no saved session, no ready', async () => {
    const { sim, invoke } = nativeSimulator();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    const a = mountProvider();
    await a.loaded();
    vi.mocked(verifyPinLogin).mockResolvedValue(GLOBAL_ADMIN as never);
    let user: unknown;
    await act(async () => {
      user = await a.ctx().loginWithPin('1234', 'LDP-001', 'admin');
    });
    expect(sim.log).toEqual(['prepare:LDP-001', 'persist:LDP-001']);
    const seqAfterLogin = seqNow();
    const base = invoke.getMockImplementation()!;
    const readiness = gate();
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === NATIVE_DEVICE_SECURITY_READINESS_COMMAND) await readiness.promise;
      return base(cmd, args);
    });
    const complete = outcomeOf(a.ctx().completeLogin(user as never, 'LDP-001'));
    await settle();
    a.unmount();
    await act(async () => {
      readiness.release();
      await complete;
    });
    await settle();
    const outcome = await complete;
    expect(outcome.ok).toBe(false);
    expect(isAuthOperationSupersededError((outcome as { error: unknown }).error)).toBe(true);
    expect(seqNow()).toBe(seqAfterLogin); // no clear episode queued
    expect(sim.log).toEqual(['prepare:LDP-001', 'persist:LDP-001']);
    expect(loadSession()).toBeNull(); // no shared session saved

    // A fresh provider starts with no session and nothing marked ready.
    invoke.mockImplementation(base);
    const history: string[] = [];
    const ctx = await renderAuth(history);
    expect(ctx().session).toBeNull();
    expect(ctx().staffSessionStatus).toBe('missing');
    expect(history.some((entry) => entry.endsWith('|ready'))).toBe(false);
  });

  it('G6c: preflight refresh queued, then provider disposed: the episode neither refreshes nor persists, returns unavailable', async () => {
    const { sim, invoke } = nativeSimulator();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    serverRefresh();
    const a = mountProvider();
    await a.loaded();
    await quickPinLoginAsGlobalAdmin(a.ctx);
    await act(async () => {
      await a.ctx().setBranchId('BR-0');
    });
    act(() => a.ctx().invalidateStaffSession()); // next preflight must refresh
    sim.log.length = 0;
    h.callables.refreshOfflineStaffSessionAssertion!.mockClear();

    // Another owner's episode is ahead in the queue.
    const ahead = gate();
    const pAhead = runNativeStaffSessionEpisode(() => ahead.promise);
    let pPreflight!: Promise<unknown>;
    await act(async () => {
      pPreflight = a.ctx().ensurePrivilegedStaffSession();
    });
    const seqQueued = seqNow();
    a.unmount();
    let preflight: unknown;
    await act(async () => {
      ahead.release();
      await pAhead;
      preflight = await pPreflight;
    });
    expect(preflight).toBe('unavailable');
    expect(sim.log).toEqual([]); // no prepare / persist
    expect(h.callables.refreshOfflineStaffSessionAssertion).not.toHaveBeenCalled();
    expect(seqNow()).toBe(seqQueued);
  });

  it('StrictMode: the simulated unmount/remount re-arms the provider (callbacks stay live while mounted)', async () => {
    const { sim, invoke } = nativeSimulator();
    (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
    serverRefresh();
    const a = mountProvider({ strict: true });
    await a.loaded();
    await quickPinLoginAsGlobalAdmin(a.ctx);
    await act(async () => {
      await a.ctx().setBranchId('BR-0');
    });
    expect(a.ctx().branchId).toBe('BR-0');
    expect(a.ctx().staffSessionStatus).toBe('ready');
    expect(sim.ssa1Branch).toBe('BR-0');
    let preflight: unknown;
    await act(async () => {
      preflight = await a.ctx().ensurePrivilegedStaffSession();
    });
    expect(preflight).toBe('ready');
    await act(async () => {
      await a.ctx().logout();
    });
    expect(a.ctx().session).toBeNull();
    expect(sim.ssa1Branch).toBeNull();
    expect(signOut).toHaveBeenCalled();
  });
});
