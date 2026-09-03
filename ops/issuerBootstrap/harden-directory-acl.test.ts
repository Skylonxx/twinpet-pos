import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, 'harden-directory-acl.ps1');

interface HardenRule {
  identity: string;
  fileSystemRights: string;
  inheritanceFlags: string;
  propagationFlags: string;
  accessControlType: string;
  isInherited: boolean;
}

interface HardenResult {
  success: boolean;
  targetDirectory: string;
  owner?: string;
  areAccessRulesProtected?: boolean;
  rules?: HardenRule[];
  error?: string;
}

const createdDirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `twinpet-acl-${prefix}-`));
  createdDirs.push(dir);
  return dir;
}

function runHardenScript(targetDirectory: string): HardenResult {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-TargetDirectory', targetDirectory],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout.trim()) as HardenResult;
}

function runPs(command: string): void {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('harden-directory-acl.ps1', () => {
  it('fixture 1: plain new directory ends up protected with exactly one FullControl rule', () => {
    const dir = freshDir('plain');
    const result = runHardenScript(dir);
    expect(result.success).toBe(true);
    expect(result.areAccessRulesProtected).toBe(true);
    expect(result.rules).toHaveLength(1);
    expect(result.rules![0]!.fileSystemRights).toBe('FullControl');
    expect(result.rules![0]!.isInherited).toBe(false);
  });

  it('fixture 2: PropagationFlags is exactly None (this-folder-subfolders-and-files semantics)', () => {
    const dir = freshDir('propagation');
    const result = runHardenScript(dir);
    expect(result.rules![0]!.propagationFlags).toBe('None');
  });

  it('fixture 3: InheritanceFlags grants both ContainerInherit and ObjectInherit', () => {
    const dir = freshDir('inheritance');
    const result = runHardenScript(dir);
    const flags = result.rules![0]!.inheritanceFlags;
    expect(flags).toContain('ContainerInherit');
    expect(flags).toContain('ObjectInherit');
  });

  it('fixture 4: existing files inside the directory are preserved (ACL-only change)', () => {
    const dir = freshDir('withfile');
    const filePath = join(dir, 'evidence.txt');
    writeFileSync(filePath, 'do-not-delete');
    const result = runHardenScript(dir);
    expect(result.success).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('do-not-delete');
  });

  it('fixture 5: nested subdirectories are preserved', () => {
    const dir = freshDir('withsubdir');
    const subDir = join(dir, 'nested');
    mkdirSync(subDir);
    const result = runHardenScript(dir);
    expect(result.success).toBe(true);
    expect(existsSync(subDir)).toBe(true);
  });

  it('fixture 6: a pre-existing broad "Everyone" grant is stripped after hardening', () => {
    const dir = freshDir('everyone');
    runPs(
      `$acl = Get-Acl -LiteralPath '${dir}'; ` +
        `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule('Everyone','FullControl','ContainerInherit,ObjectInherit','None','Allow'); ` +
        `$acl.AddAccessRule($rule); Set-Acl -LiteralPath '${dir}' -AclObject $acl`,
    );
    const result = runHardenScript(dir);
    expect(result.success).toBe(true);
    const identities = result.rules!.map((r) => r.identity);
    expect(identities.some((id) => id.includes('Everyone'))).toBe(false);
    expect(result.rules).toHaveLength(1);
  });

  it('fixture 7: multiple pre-existing explicit ACEs collapse to exactly one canonical rule', () => {
    const dir = freshDir('multi-ace');
    runPs(
      `$acl = Get-Acl -LiteralPath '${dir}'; ` +
        `$r1 = New-Object System.Security.AccessControl.FileSystemAccessRule('Users','Modify','ContainerInherit,ObjectInherit','None','Allow'); ` +
        `$r2 = New-Object System.Security.AccessControl.FileSystemAccessRule('Authenticated Users','ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'); ` +
        `$acl.AddAccessRule($r1); $acl.AddAccessRule($r2); Set-Acl -LiteralPath '${dir}' -AclObject $acl`,
    );
    const result = runHardenScript(dir);
    expect(result.success).toBe(true);
    expect(result.rules).toHaveLength(1);
  });

  it('fixture 8: idempotent — running twice yields the same single-rule outcome', () => {
    const dir = freshDir('idempotent');
    const first = runHardenScript(dir);
    const second = runHardenScript(dir);
    expect(second.success).toBe(true);
    expect(second.rules).toHaveLength(1);
    expect(second.rules![0]!.identity).toBe(first.rules![0]!.identity);
    expect(second.rules![0]!.propagationFlags).toBe(first.rules![0]!.propagationFlags);
  });

  it('fixture 9: a directory whose inheritance was already disabled is still normalized', () => {
    const dir = freshDir('already-protected');
    runPs(
      `$acl = Get-Acl -LiteralPath '${dir}'; ` +
        `$acl.SetAccessRuleProtection($true, $true); Set-Acl -LiteralPath '${dir}' -AclObject $acl`,
    );
    const result = runHardenScript(dir);
    expect(result.success).toBe(true);
    expect(result.areAccessRulesProtected).toBe(true);
    expect(result.rules).toHaveLength(1);
  });

  it('fixture 10: a nonexistent directory fails closed with a structured error, not an exception dump', () => {
    const missing = join(tmpdir(), `twinpet-acl-missing-${Date.now()}`);
    let result: HardenResult | null = null;
    let threw = false;
    try {
      const stdout = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-TargetDirectory', missing],
        { encoding: 'utf8' },
      );
      result = JSON.parse(stdout.trim()) as HardenResult;
    } catch (err) {
      // Non-zero exit still carries stdout on the error object.
      threw = true;
      const stdout = (err as { stdout?: string }).stdout ?? '';
      result = JSON.parse(stdout.trim()) as HardenResult;
    }
    expect(threw).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toBe('target_directory_not_found');
  });
});
