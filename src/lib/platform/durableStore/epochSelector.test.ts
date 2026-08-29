import { afterEach, describe, expect, test, vi } from 'vitest';
import { encodeDurableKey } from './kvKeyCodec';
import { DURABLE_DOMAINS, type DurableDomainId } from './migrationManifest';
import { P13MigrationError } from '../../pos/suspendedBills';
import { buildP13ManifestEvidence, runFirstEpochCutover, type DomainDumper } from './epochSelector';
import {
  bootNativeDurableStore,
  getCommittedDurableStore,
  isDurableStartupBlocked,
  isNativeCommittedDurableStore,
  __resetBootDurableStoreForTests,
} from './bootDurableStore';

type EpochRow = { epochId: string; status: string; inventoryJson: string };

function installInvoke(handler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(handler);
  (globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
    core: { invoke },
  };
  return invoke;
}

async function emptyP13(branchIds: string[] = []) {
  return buildP13ManifestEvidence({ branchIds, rows: [], identicalDuplicateCount: 0 });
}

async function allEightDumpers(
  overrides: Partial<Record<DurableDomainId, DomainDumper>> = {},
): Promise<Map<DurableDomainId, DomainDumper>> {
  const p13 = await emptyP13();
  const dumpers = new Map<DurableDomainId, DomainDumper>();
  for (const spec of DURABLE_DOMAINS) {
    if (overrides[spec.id]) {
      dumpers.set(spec.id, overrides[spec.id]!);
      continue;
    }
    if (spec.id === 'suspendedBills') {
      dumpers.set(spec.id, async () => ({ rows: [], p13 }));
    } else {
      dumpers.set(spec.id, async () => []);
    }
  }
  return dumpers;
}

function memoryBridge(options?: { failCommittedPut?: boolean }) {
  const kv = new Map<string, unknown>();
  const epochs: EpochRow[] = [];
  let sessionDb = '';
  let sessionEpoch = '';
  const puts: string[] = [];
  const invoke = installInvoke(async (cmd, args) => {
    if (cmd === 'durable_manifest_get') {
      const committed = [...epochs].reverse().find((row) => row.status === 'COMMITTED');
      return {
        activeCommitted: committed ? { epochId: committed.epochId, status: committed.status, inventoryJson: committed.inventoryJson } : null,
        epochs,
      };
    }
    if (cmd === 'durable_manifest_lease_acquire') return true;
    if (cmd === 'durable_manifest_lease_heartbeat' || cmd === 'durable_manifest_lease_release') return undefined;
    if (cmd === 'durable_manifest_put_epoch') {
      const epochId = String(args?.epochId);
      const status = String(args?.status);
      const inventoryJson = String(args?.inventoryJson ?? '{}');
      puts.push(status);
      const existing = epochs.find((row) => row.epochId === epochId);
      if (existing?.status === 'COMMITTED' && status !== 'COMMITTED') {
        throw new Error('COMMITTED epoch cannot be demoted');
      }
      if (status === 'COMMITTED' && options?.failCommittedPut) {
        if (existing) {
          existing.status = 'COMMITTED';
          existing.inventoryJson = inventoryJson;
        } else {
          epochs.push({ epochId, status: 'COMMITTED', inventoryJson });
        }
        throw new Error('transport lost after native commit');
      }
      if (existing) {
        existing.status = status;
        existing.inventoryJson = inventoryJson;
      } else {
        epochs.push({ epochId, status, inventoryJson });
      }
      return undefined;
    }
    if (cmd === 'durable_kv_txn_begin') {
      sessionDb = String(args?.database);
      sessionEpoch = String(args?.epochId);
      return { sessionId: `${sessionDb}:${sessionEpoch}` };
    }
    if (cmd === 'durable_kv_txn_put') {
      kv.set(`${sessionDb}|${String(args?.store)}|${String(args?.encodedKey)}`, args?.value);
      return undefined;
    }
    if (cmd === 'durable_kv_txn_get') {
      return kv.get(`${sessionDb}|${String(args?.store)}|${String(args?.encodedKey)}`);
    }
    if (cmd === 'durable_kv_txn_get_all_keys') {
      const prefix = `${sessionDb}|${String(args?.store)}|`;
      return [...kv.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    }
    if (cmd === 'durable_kv_txn_get_all') {
      const prefix = `${sessionDb}|${String(args?.store)}|`;
      return [...kv.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value);
    }
    if (cmd === 'durable_kv_txn_commit' || cmd === 'durable_kv_txn_abort' || cmd === 'durable_kv_txn_delete') {
      return undefined;
    }
    return undefined;
  });
  return { invoke, puts, epochs };
}

afterEach(() => {
  __resetBootDurableStoreForTests();
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
});

describe('epochSelector', () => {
  test('does not commit when P-13 source is invalid', async () => {
    const { puts } = memoryBridge();
    const dumpers = await allEightDumpers({
      suspendedBills: async () => {
        throw new P13MigrationError('invalid_cartline', 'cartItems: [{}]');
      },
    });
    const result = await runFirstEpochCutover({ dumpers });
    expect(result.status).toBe('failed');
    expect(puts).toContain('FAILED');
    expect(puts).not.toContain('COMMITTED');
  });

  test('already-committed selector returns the active epoch without rewriting', async () => {
    const invoke = installInvoke(async (cmd) => {
      if (cmd === 'durable_manifest_get') {
        return { activeCommitted: { epochId: 'epoch-1', status: 'COMMITTED' }, epochs: [] };
      }
      return undefined;
    });
    const result = await runFirstEpochCutover({ dumpers: new Map() });
    expect(result).toEqual({ status: 'already-committed', epochId: 'epoch-1' });
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['durable_manifest_get']);
  });

  test.each(DURABLE_DOMAINS.map((spec) => spec.id))(
    'missing %s registration fails before M3 and leaves no committed epoch',
    async (missing) => {
      const { puts, epochs } = memoryBridge();
      const dumpers = await allEightDumpers();
      dumpers.delete(missing);
      const result = await runFirstEpochCutover({ dumpers });
      expect(result.status).toBe('failed');
      expect(String((result as { error: string }).error)).toContain(missing);
      expect(puts).not.toContain('COPYING');
      expect(puts).not.toContain('COMMITTED');
      expect(epochs.some((row) => row.status === 'COMMITTED')).toBe(false);
    },
  );

  test('all eight registered with one empty domain can commit', async () => {
    const { puts, epochs } = memoryBridge();
    const dumpers = await allEightDumpers();
    const result = await runFirstEpochCutover({ dumpers });
    expect(result.status).toBe('committed');
    expect(puts).toContain('COMMITTED');
    expect(epochs.some((row) => row.status === 'COMMITTED')).toBe(true);
  });

  test('valid empty P-13 branch survives M2 and committed manifest evidence', async () => {
    const { epochs } = memoryBridge();
    const emptyBranch = 'empty-branch';
    const localeBranch = 'สาขา-01';
    const bill = { id: 'b1', note: '', cartItems: [], createdAt: '2026-08-28T00:00:00.000Z' };
    const rows = [{ store: 'bills', key: [localeBranch, 'b1'] as string[], value: bill }];
    const p13 = await buildP13ManifestEvidence({
      branchIds: [emptyBranch, localeBranch],
      rows,
      identicalDuplicateCount: 0,
    });
    const dumpers = await allEightDumpers({
      suspendedBills: async () => ({ rows, p13 }),
    });
    const result = await runFirstEpochCutover({ dumpers });
    expect(result.status).toBe('committed');
    const committed = epochs.find((row) => row.status === 'COMMITTED');
    expect(committed).toBeTruthy();
    const inventory = JSON.parse(committed!.inventoryJson) as { p13: { branchIds: string[]; rowCount: number } };
    expect(inventory.p13.branchIds).toEqual([emptyBranch, localeBranch]);
    expect(inventory.p13.branchIds).toContain(emptyBranch);
    expect(inventory.p13.rowCount).toBe(1);
  });

  test('removing an empty branch from P-13 evidence fails M2', async () => {
    const { puts } = memoryBridge();
    const localeBranch = 'สาขา-01';
    const bill = { id: 'b1', note: '', cartItems: [], createdAt: '2026-08-28T00:00:00.000Z' };
    const rows = [{ store: 'bills', key: [localeBranch, 'b1'] as string[], value: bill }];
    const complete = await buildP13ManifestEvidence({
      branchIds: ['empty-branch', localeBranch],
      rows,
      identicalDuplicateCount: 0,
    });
    const stripped = await buildP13ManifestEvidence({
      branchIds: [localeBranch],
      rows,
      identicalDuplicateCount: 0,
    });
    expect(complete.digestSha256).not.toBe(stripped.digestSha256);
    const dumpers = await allEightDumpers({
      suspendedBills: async () => ({ rows, p13: { ...complete, branchIds: [localeBranch] } }),
    });
    const result = await runFirstEpochCutover({ dumpers });
    expect(result.status).toBe('failed');
    expect(puts).not.toContain('COMMITTED');
  });

  test('bill-row digest alone cannot mask a missing empty branch', async () => {
    const rows = [{ store: 'bills', key: ['billed', 'b1'] as string[], value: { id: 'b1' } }];
    const withEmpty = await buildP13ManifestEvidence({
      branchIds: ['empty-branch', 'billed'],
      rows,
      identicalDuplicateCount: 0,
    });
    const withoutEmpty = await buildP13ManifestEvidence({
      branchIds: ['billed'],
      rows,
      identicalDuplicateCount: 0,
    });
    expect(withEmpty.digestSha256).not.toBe(withoutEmpty.digestSha256);
    expect(encodeDurableKey('empty-branch')).toContain('B');
  });

  test('uncertain M3 acknowledgement with native COMMITTED readback does not demote', async () => {
    const { puts, epochs } = memoryBridge({ failCommittedPut: true });
    const dumpers = await allEightDumpers();
    const result = await runFirstEpochCutover({ dumpers });
    expect(result.status).toBe('committed');
    expect(puts.filter((status) => status === 'FAILED')).toEqual([]);
    expect(epochs.some((row) => row.status === 'COMMITTED')).toBe(true);
    expect(epochs.some((row) => row.status === 'FAILED')).toBe(false);
  });

  test('pre-M3 failure may still mark the candidate FAILED', async () => {
    const { puts } = memoryBridge();
    const dumpers = await allEightDumpers({
      device: async () => {
        throw new Error('device dump failed');
      },
    });
    const result = await runFirstEpochCutover({ dumpers });
    expect(result.status).toBe('failed');
    expect(puts).toContain('FAILED');
    expect(puts).not.toContain('COMMITTED');
  });
});

describe('bootDurableStore fail-closed', () => {
  test('manifest read failure after possible committed state blocks legacy factory selection', async () => {
    installInvoke(async () => {
      throw new Error('migration manifest is corrupt');
    });
    await bootNativeDurableStore();
    expect(isDurableStartupBlocked()).toBe(true);
    expect(isNativeCommittedDurableStore()).toBe(false);
    expect(getCommittedDurableStore('twinpet-device')).toBeNull();
    expect(getCommittedDurableStore('twinpet-suspended-bills')).toBeNull();
  });

  test('true virgin cutover failure does not block POS into a fatal native state', async () => {
    const dumpers = await allEightDumpers({
      suspendedBills: async () => {
        throw new P13MigrationError('invalid_cartline', 'bad');
      },
    });
    const { registerDomainDumper } = await import('./bootDurableStore');
    for (const [id, dump] of dumpers) registerDomainDumper(id, dump);
    memoryBridge();
    await bootNativeDurableStore();
    expect(isDurableStartupBlocked()).toBe(false);
    expect(isNativeCommittedDurableStore()).toBe(false);
    expect(getCommittedDurableStore('twinpet-device')).toBeNull();
  });
});
