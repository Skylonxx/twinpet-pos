import { describe, expect, it, vi } from 'vitest';
import { refreshStaffSession } from './refreshStaffSession';

vi.mock('../firebase', () => ({
  auth: {
    currentUser: {
      getIdTokenResult: async () => ({
        claims: { staffId: 'STAFF-1' },
      }),
    },
  },
  app: {},
  isFirebaseConfigured: true,
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: (_fn: unknown, name: string) => {
    if (name === 'refreshOfflineStaffSessionAssertion') {
      return async () => ({
        data: {
          ok: true,
          ssa1Base64: 'mock-ssa1',
          srf1Base64: 'mock-srf1',
        },
      });
    }
    if (name === 'getOacKeysetManifest') {
      return async () => ({
        data: {
          ok: true,
          oks1Base64: 'mock-oks1',
        },
      });
    }
    return async () => ({ data: { ok: false } });
  },
}));

describe('refreshStaffSession', () => {
  it('fails closed when native bridge is unavailable', async () => {
    const res = await refreshStaffSession('B-HQ');
    expect(res).toEqual({ ok: false, code: 'native_bridge_unavailable' });
  });

  it('orchestrates challenge, cloud callable, keyset fetch, and persist on native desktop with sscp1ProofBase64 DTO', async () => {
    const invoked: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const mockInvoke = async (cmd: string, args?: Record<string, unknown>) => {
      invoked.push({ cmd, args });
      if (cmd === 'native_prepare_staff_session_challenge') {
        // Exact shape serialized by Rust #[serde(rename_all = "camelCase")]
        return {
          challengeNonceBase64: 'mock-nonce',
          sscp1ProofBase64: 'mock-sscp1',
          generation: 42,
        };
      }
      if (cmd === 'native_persist_staff_session_assertion') {
        return undefined;
      }
      throw new Error(`unexpected command ${cmd}`);
    };

    const res = await refreshStaffSession('B-HQ', mockInvoke);
    expect(res).toEqual({ ok: true });
    expect(invoked).toHaveLength(2);
    expect(invoked[0]?.cmd).toBe('native_prepare_staff_session_challenge');
    expect(invoked[0]?.args?.purpose).toBe('SSA1_REFRESH');
    expect(invoked[0]?.args?.intendedStaffId).toBe('STAFF-1');
    expect(invoked[1]?.cmd).toBe('native_persist_staff_session_assertion');
    expect(invoked[1]?.args?.generation).toBe(42);
    expect(invoked[1]?.args?.ssa1Base64).toBe('mock-ssa1');
    expect(invoked[1]?.args?.srf1Base64).toBe('mock-srf1');
    expect(invoked[1]?.args?.oks1Base64).toBe('mock-oks1');
  });

  it('rejects missing or old sscp1_base64 field in challenge DTO', async () => {
    const mockInvoke = async (cmd: string) => {
      if (cmd === 'native_prepare_staff_session_challenge') {
        return { generation: 42, sscp1_base64: 'legacy-wrong-key' };
      }
      return undefined;
    };
    const res = await refreshStaffSession('B-HQ', mockInvoke);
    expect(res).toEqual({ ok: false, code: 'challenge_preparation_failed' });
  });

  it('rejects malformed or empty sscp1ProofBase64 in challenge DTO', async () => {
    const mockInvoke = async (cmd: string) => {
      if (cmd === 'native_prepare_staff_session_challenge') {
        return { generation: 42, sscp1ProofBase64: '' };
      }
      return undefined;
    };
    const res = await refreshStaffSession('B-HQ', mockInvoke);
    expect(res).toEqual({ ok: false, code: 'challenge_preparation_failed' });
  });

  it('fails closed when native_persist_staff_session_assertion fails', async () => {
    const mockInvoke = async (cmd: string) => {
      if (cmd === 'native_prepare_staff_session_challenge') {
        return { generation: 42, sscp1ProofBase64: 'mock-sscp1' };
      }
      if (cmd === 'native_persist_staff_session_assertion') {
        throw new Error('DPAPI encryption failed');
      }
      return undefined;
    };
    const res = await refreshStaffSession('B-HQ', mockInvoke);
    expect(res.ok).toBe(false);
    expect((res as any).code).toContain('DPAPI encryption failed');
  });
});
