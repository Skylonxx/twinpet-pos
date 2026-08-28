import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SOURCE_PATH = resolve(__dirname, '../index.ts');
const src = readFileSync(SOURCE_PATH, 'utf8');

const TAURI_WINDOWS_PRODUCTION_ORIGIN = 'http://tauri.localhost';

function extractVerifyPinLoginOnCallBlock(source: string): string {
  const marker = 'export const verifyPinLogin = onCall(';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('verifyPinLogin onCall export missing');
  const open = source.indexOf('(', start + 'export const verifyPinLogin = onCall'.length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unclosed verifyPinLogin onCall');
}

function extractCorsArrayLiteral(onCallBlock: string): string {
  const corsKey = onCallBlock.indexOf('cors:');
  if (corsKey < 0) throw new Error('verifyPinLogin cors option missing');
  const open = onCallBlock.indexOf('[', corsKey);
  if (open < 0) throw new Error('verifyPinLogin cors is not an array');
  let depth = 0;
  for (let i = open; i < onCallBlock.length; i += 1) {
    const ch = onCallBlock[i];
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return onCallBlock.slice(open, i + 1);
    }
  }
  throw new Error('unclosed verifyPinLogin cors array');
}

function parseCorsAllowlist(arrayLiteral: string): Array<string | RegExp> {
  const body = arrayLiteral.slice(1, -1);
  const entries: Array<string | RegExp> = [];
  const tokenRe = /\/((?:\\\/|[^/])+?)\/([a-z]*)|'([^']*)'|"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(body)) !== null) {
    if (match[1] !== undefined) {
      entries.push(new RegExp(match[1], match[2] ?? ''));
      continue;
    }
    entries.push(match[3] ?? match[4] ?? '');
  }
  if (entries.length === 0) throw new Error('verifyPinLogin cors allowlist empty');
  return entries;
}

function isOriginAllowed(origin: string, allowlist: Array<string | RegExp>): boolean {
  for (const entry of allowlist) {
    if (typeof entry === 'string') {
      if (origin === entry) return true;
      continue;
    }
    if (entry.test(origin)) return true;
  }
  return false;
}

const onCallBlock = extractVerifyPinLoginOnCallBlock(src);
const corsLiteral = extractCorsArrayLiteral(onCallBlock);
const allowlist = parseCorsAllowlist(corsLiteral);

describe('verifyPinLogin CORS owner', () => {
  test('cors policy is local to verifyPinLogin and is not a wildcard', () => {
    expect(src).toContain('export const verifyPinLogin = onCall(');
    expect(onCallBlock).toContain('cors:');
    expect(allowlist.some((entry) => entry === '*')).toBe(false);
    expect(corsLiteral.trim().startsWith('[')).toBe(true);
    expect(onCallBlock).not.toMatch(/cors:\s*true/);
    expect(onCallBlock).not.toMatch(/cors:\s*'\*'/);
    expect(onCallBlock).not.toMatch(/cors:\s*"\*"/);
    const sharedHelperImport = src.match(/from ['"]\.\/[^'"]*cors[^'"]*['"]/);
    expect(sharedHelperImport).toBeNull();
  });

  test('existing browser origins remain accepted and Tauri Windows production origin is accepted', () => {
    expect(isOriginAllowed('http://localhost:5173', allowlist)).toBe(true);
    expect(isOriginAllowed('https://localhost:4173', allowlist)).toBe(true);
    expect(isOriginAllowed('https://twinpet-pos-uat.firebaseapp.com', allowlist)).toBe(true);
    expect(isOriginAllowed('https://twinpet-pos.web.app', allowlist)).toBe(true);
    expect(isOriginAllowed(TAURI_WINDOWS_PRODUCTION_ORIGIN, allowlist)).toBe(true);
  });

  test('arbitrary foreign origins are not allowed', () => {
    expect(isOriginAllowed('https://evil.example.com', allowlist)).toBe(false);
    expect(isOriginAllowed('https://tauri.localhost', allowlist)).toBe(false);
    expect(isOriginAllowed('tauri://localhost', allowlist)).toBe(false);
    expect(isOriginAllowed('http://tauri.localhost:443', allowlist)).toBe(false);
    expect(isOriginAllowed('https://attacker.firebaseapp.com.evil.example', allowlist)).toBe(false);
  });

  test('PIN/auth callable behavior source is unchanged outside the cors allowlist', () => {
    expect(onCallBlock).toContain("throw new HttpsError('unauthenticated'");
    expect(onCallBlock).toContain("PIN ต้องเป็นตัวเลข 4 หลัก");
    expect(onCallBlock).toContain('resolvePinLoginIdentity');
    expect(onCallBlock).toContain('setCustomUserClaims');
    expect(onCallBlock).toContain('GENERIC_LOGIN_DENIED');
    expect(onCallBlock).toContain('authVersion');
    expect(onCallBlock).toContain('lastLoginAt');
    expect(src).toContain('async function verifyCanonicalPin(');
    expect(src).toContain('isPrivilegedRole(role) && cred.credentialState !== \'rotated_authoritative\'');
  });
});
