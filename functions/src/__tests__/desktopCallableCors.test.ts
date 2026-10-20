import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  DESKTOP_CALLABLE_CORS,
  FIREBASE_APP_ORIGIN_PATTERN,
  FIREBASE_WEB_APP_ORIGIN_PATTERN,
  LOCALHOST_DEV_ORIGIN_PATTERN,
  TAURI_WINDOWS_PRODUCTION_ORIGIN,
} from '../callableCors';
import { adjudicateOfflinePrivilegedAction } from '../adjudicateOfflinePrivilegedAction';
import { getShiftCloseCaseFigures } from '../getShiftCloseCaseFigures';
import { requestManagerApproval } from '../requestManagerApproval';
import { resolveReversal } from '../resolveReversal';
import { resolveShiftCloseAlert } from '../resolveShiftCloseAlert';
import { resolveTransferDiscrepancy } from '../resolveTransferDiscrepancy';
import { retryReconcile } from '../retryReconcile';
import { setUserAccount } from '../setUserAccount';
import { submitPrivilegedVoid } from '../submitPrivilegedVoid';
import { getAdminSecurityOverview } from '../getAdminSecurityOverview';
import { issuePrivilegedLockoutClear } from '../issuePrivilegedLockoutClear';
import { getSaleReturnContext, submitSaleReturn } from '../submitSaleReturn';
import { closeShiftAuthoritative } from '../closeShiftAuthoritative';
import { verifyPinLogin } from '../index';

/**
 * D-CORS1 — every desktop/browser callable that supplies an explicit CORS
 * allowlist must permit the exact installed Tauri origin, and nothing broader.
 *
 * The probes below are real HTTP `OPTIONS` preflights against the exported
 * callable handlers (the same `cors` middleware path Cloud Functions runs),
 * served from an ephemeral local port. They send no body and no credentials.
 */

type CallableHandler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

/** The 9 callables fixed by D-CORS1 (explicit allowlist, now shared) plus later callables born on it. */
const FIXED_CALLABLES: Record<string, CallableHandler> = {
  setUserAccount: setUserAccount as unknown as CallableHandler,
  adjudicateOfflinePrivilegedAction: adjudicateOfflinePrivilegedAction as unknown as CallableHandler,
  getShiftCloseCaseFigures: getShiftCloseCaseFigures as unknown as CallableHandler,
  requestManagerApproval: requestManagerApproval as unknown as CallableHandler,
  resolveReversal: resolveReversal as unknown as CallableHandler,
  resolveShiftCloseAlert: resolveShiftCloseAlert as unknown as CallableHandler,
  resolveTransferDiscrepancy: resolveTransferDiscrepancy as unknown as CallableHandler,
  retryReconcile: retryReconcile as unknown as CallableHandler,
  submitPrivilegedVoid: submitPrivilegedVoid as unknown as CallableHandler,
  // Return/Refund V1 — born on the shared policy.
  getSaleReturnContext: getSaleReturnContext as unknown as CallableHandler,
  submitSaleReturn: submitSaleReturn as unknown as CallableHandler,
  // Return/Refund V1 packet 012 — server-authoritative close, born on the shared policy.
  closeShiftAuthoritative: closeShiftAuthoritative as unknown as CallableHandler,
};

/** Compatibility set: already allowed Tauri before this fix. */
const COMPATIBLE_CALLABLES: Record<string, CallableHandler> = {
  verifyPinLogin: verifyPinLogin as unknown as CallableHandler,
  getAdminSecurityOverview: getAdminSecurityOverview as unknown as CallableHandler,
  issuePrivilegedLockoutClear: issuePrivilegedLockoutClear as unknown as CallableHandler,
};

const servers: http.Server[] = [];

async function preflight(handler: CallableHandler, origin: string): Promise<{ status: number; acao: string | undefined }> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return new Promise((done, fail) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'OPTIONS',
        path: '/',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const acao = res.headers['access-control-allow-origin'];
          server.close();
          done({ status: res.statusCode ?? 0, acao: Array.isArray(acao) ? acao[0] : acao });
        });
      },
    );
    req.on('error', fail);
    req.end();
  });
}

afterAll(() => {
  for (const s of servers) s.close();
});

const ALLOWED_ORIGINS = [
  'http://tauri.localhost',
  'http://localhost:5173',
  'https://localhost:4173',
  'https://twinpet-pos-uat.firebaseapp.com',
  'https://twinpet-pos.web.app',
];

const REJECTED_ORIGINS = [
  'http://evil.example',
  'http://tauri.localhost.evil.example',
  'https://evil.firebaseapp.com.attacker.example',
  'https://tauri.localhost',
  'tauri://localhost',
  'http://tauri.localhost:443',
  'http://other.localhost',
];

describe('shared desktop callable CORS policy', () => {
  test('is an explicit allowlist containing exactly the Tauri origin plus the three existing patterns', () => {
    expect(TAURI_WINDOWS_PRODUCTION_ORIGIN).toBe('http://tauri.localhost');
    expect(DESKTOP_CALLABLE_CORS).toHaveLength(4);
    expect(DESKTOP_CALLABLE_CORS).toContain(LOCALHOST_DEV_ORIGIN_PATTERN);
    expect(DESKTOP_CALLABLE_CORS).toContain(FIREBASE_APP_ORIGIN_PATTERN);
    expect(DESKTOP_CALLABLE_CORS).toContain(FIREBASE_WEB_APP_ORIGIN_PATTERN);
    expect(DESKTOP_CALLABLE_CORS).toContain(TAURI_WINDOWS_PRODUCTION_ORIGIN);
    expect(DESKTOP_CALLABLE_CORS.some((e) => e === '*')).toBe(false);
  });

  test('existing patterns keep their exact source (localhost behavior preserved)', () => {
    expect(LOCALHOST_DEV_ORIGIN_PATTERN.source).toBe('^https?:\\/\\/localhost:\\d+$');
    expect(FIREBASE_APP_ORIGIN_PATTERN.source).toBe('^https:\\/\\/.*\\.firebaseapp\\.com$');
    expect(FIREBASE_WEB_APP_ORIGIN_PATTERN.source).toBe('^https:\\/\\/.*\\.web\\.app$');
  });
});

describe.each(Object.entries(FIXED_CALLABLES))('%s preflight', (name, handler) => {
  test.each(ALLOWED_ORIGINS)('allows %s with an exact-origin ACAO', async (origin) => {
    const { status, acao } = await preflight(handler, origin);
    expect(status).toBe(204);
    expect(acao, `${name} must echo ${origin}`).toBe(origin);
  });

  test.each(REJECTED_ORIGINS)('refuses %s (no ACAO)', async (origin) => {
    const { acao } = await preflight(handler, origin);
    expect(acao, `${name} must not allow ${origin}`).toBeUndefined();
  });
});

describe.each(Object.entries(COMPATIBLE_CALLABLES))('%s stays compatible', (_name, handler) => {
  test.each(ALLOWED_ORIGINS)('still allows %s', async (origin) => {
    const { acao } = await preflight(handler, origin);
    expect(acao).toBe(origin);
  });
});

describe('source invariants for explicit callable CORS options', () => {
  const SRC_DIR = resolve(__dirname, '..');
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  function onCallBlocks(source: string): Array<{ name: string; block: string }> {
    const out: Array<{ name: string; block: string }> = [];
    const re = /export const (\w+) = onCall\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '(') depth += 1;
        if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            out.push({ name: m[1]!, block: source.slice(open, i + 1) });
            break;
          }
        }
      }
    }
    return out;
  }

  const all = files.flatMap((f) => {
    const source = readFileSync(resolve(SRC_DIR, f), 'utf8');
    return onCallBlocks(source).map((b) => ({ file: f, source, ...b }));
  });

  test('finds the onCall exports (sanity: at least 26)', () => {
    expect(all.length).toBeGreaterThanOrEqual(26);
  });

  test('every explicit cors option is the shared policy (or verifyPinLogin\'s Tauri-inclusive literal) and never a wildcard', () => {
    const explicit = all.filter((c) => /\bcors\s*:/.test(c.block));
    expect(explicit.map((c) => c.name).sort()).toEqual([...Object.keys(FIXED_CALLABLES), 'verifyPinLogin'].sort());
    for (const c of explicit) {
      expect(c.block, `${c.name} must not use a wildcard`).not.toMatch(/cors:\s*(true|'\*'|"\*")/);
      if (c.name === 'verifyPinLogin') {
        expect(c.block).toContain("'http://tauri.localhost'");
        continue;
      }
      expect(c.block, `${c.name} must use the shared policy`).toMatch(/cors:\s*DESKTOP_CALLABLE_CORS\b/);
      expect(c.source, `${c.name} must import the shared policy`).toMatch(
        /import \{ DESKTOP_CALLABLE_CORS \} from '\.\/callableCors';/,
      );
    }
  });

  test('no callable keeps an inline restrictive allowlist that omits the Tauri origin', () => {
    for (const c of all) {
      if (!/\bcors\s*:\s*\[/.test(c.block)) continue;
      expect(c.block, `${c.name} inline cors array must include the Tauri origin`).toContain('http://tauri.localhost');
    }
  });
});
