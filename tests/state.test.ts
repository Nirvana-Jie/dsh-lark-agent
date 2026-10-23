import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskLedger } from '../src/ledger.js';
import { acquireLock, type LockProbe } from '../src/lock.js';

const directories: string[] = [];
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'dsh-larkbot-')); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive: true, force: true}))); });

describe('durable message ledger', () => {
  it('claims once for concurrent deliveries and persists across restart', async () => {
    const dir = await temporary();
    const ledger = await DiskLedger.open(dir);
    expect(await Promise.all([ledger.claim('one'), ledger.claim('one'), ledger.claim('two')])).toEqual([true, false, true]);
    const restarted = await DiskLedger.open(dir);
    expect(await restarted.claim('one')).toBe(false);
    expect(await restarted.claim('two')).toBe(false);
  });
  it('preserves all distinct concurrent claims', async () => {
    const dir = await temporary();
    const ledger = await DiskLedger.open(dir);
    await Promise.all(Array.from({length: 20}, (_, index) => ledger.claim(String(index))));
    expect(JSON.parse(await readFile(join(dir, 'messages.json'), 'utf8'))).toHaveLength(20);
  });
  it('does not silently reset corrupt state and repeat tools', async () => {
    const dir = await temporary();
    await writeFile(join(dir, 'messages.json'), 'corrupt');
    await expect(DiskLedger.open(dir)).rejects.toThrow();
  });
  it('rejects a structurally corrupt ledger', async () => {
    const dir = await temporary();
    await writeFile(join(dir, 'messages.json'), JSON.stringify([['one', 'yesterday']]));
    await expect(DiskLedger.open(dir)).rejects.toThrow('Invalid message ledger entry');
  });
  it('expires old claims after the documented seven-day retention', async () => {
    const dir = await temporary();
    await writeFile(join(dir, 'messages.json'), JSON.stringify([['old', Date.now() - 8 * 86_400_000]]));
    const ledger = await DiskLedger.open(dir);
    expect(await ledger.claim('old')).toBe(true);
  });
});

describe('instance ownership', () => {
  it('rejects simultaneous owners and allows acquisition after release', async () => {
    const dir = await temporary();
    const release = await acquireLock(dir);
    await expect(acquireLock(dir)).rejects.toThrow('locked');
    await release();
    const releaseSecond = await acquireLock(dir);
    // Repeating an old disposer must not remove the new owner's lock.
    await release();
    await expect(acquireLock(dir)).rejects.toThrow('locked');
    await releaseSecond();
  });
  it('records a PID for operator recovery without exposing secrets', async () => {
    const dir = await temporary();
    const release = await acquireLock(dir);
    expect(await readFile(join(dir, 'instance.lock', 'pid'), 'utf8')).toBe(String(process.pid));
    await release();
  });
});

describe('stale instance lock recovery', () => {
  // Another owner (PID 4242) is dead unless a case says otherwise; this process is always alive.
  const probe = (overrides: Partial<LockProbe> = {}): LockProbe => ({
    bootTime: () => Date.now() - 3_600_000,
    liveness: pid => pid === process.pid ? 'alive' : 'dead',
    identity: async pid => pid === process.pid ? 'id-self' : 'id-other',
    ...overrides,
  });
  async function plant(dir: string, owner?: Record<string, unknown>, extra: {pid?: number; mtime?: number} = {}) {
    const lock = join(dir, 'instance.lock');
    await mkdir(lock, {recursive: true});
    if (owner) await writeFile(join(lock, 'owner.json'), JSON.stringify({version: 1, pid: 4242, identity: 'id-old', createdAt: Date.now(), token: randomUUID(), ...owner}));
    if (extra.pid) await writeFile(join(lock, 'pid'), String(extra.pid));
    if (extra.mtime) await utimes(lock, extra.mtime / 1000, extra.mtime / 1000);
  }
  const owner = async (dir: string) => JSON.parse(await readFile(join(dir, 'instance.lock', 'owner.json'), 'utf8'));
  const leftovers = async (dir: string) => (await readdir(dir)).filter(name => name.startsWith('instance.lock.new-'));
  const tombstones = async (dir: string) => (await readdir(dir)).filter(name => name.startsWith('instance.lock.stale-'));

  it('publishes a complete owner record and never releases a lock it no longer owns', async () => {
    const dir = await temporary();
    const release = await acquireLock(dir, {probe: probe()});
    expect(await owner(dir)).toMatchObject({version: 1, pid: process.pid, identity: 'id-self'});
    expect(await leftovers(dir)).toEqual([]);
    // Another owner now holds the directory: the old disposer must leave it alone.
    await writeFile(join(dir, 'instance.lock', 'owner.json'), JSON.stringify({...await owner(dir), token: randomUUID()}));
    await release();
    expect(await readdir(dir)).toEqual(['instance.lock']);
  });

  it('keeps a lock whose owner still runs or cannot be verified, without asking for takeover', async () => {
    for (const overrides of [
      {liveness: () => 'alive' as const, identity: async () => 'id-old'}, // the same process still runs
      {liveness: () => 'unknown' as const}, // the OS cannot tell
      {liveness: () => 'alive' as const, identity: async () => undefined}, // its identity cannot be read now
    ]) {
      const dir = await temporary(); await plant(dir, {});
      const takeover = vi.fn(async () => true);
      await expect(acquireLock(dir, {probe: probe(overrides), takeover})).rejects.toMatchObject({name: 'LockHeldError', reason: 'running', pid: 4242});
      expect((await owner(dir)).pid).toBe(4242);
      expect(takeover).not.toHaveBeenCalled();
      expect(await leftovers(dir)).toEqual([]); expect(await tombstones(dir)).toEqual([]);
    }
  });

  it('recovers a lock whose owner exited or whose PID now belongs to another process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const overrides of [{}, {liveness: () => 'alive' as const}]) {
        const dir = await temporary(); await plant(dir, {});
        const release = await acquireLock(dir, {probe: probe(overrides)});
        expect(await owner(dir)).toMatchObject({pid: process.pid, identity: 'id-self'});
        expect(await leftovers(dir)).toEqual([]);
        expect(await tombstones(dir)).toHaveLength(1);
        await release();
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exited process 4242'));
    } finally {warn.mockRestore();}
  });

  it('judges an owner without a verifiable identity only by whether its lock predates this boot', async () => {
    const boot = Date.now() - 3_600_000, before = boot - 3_600_000;
    const outcome = async (record: Record<string, unknown> | undefined, extra: {pid?: number; mtime?: number; junk?: boolean}) => {
      const dir = await temporary(); await plant(dir, record, {pid: extra.pid});
      if (extra.junk) await writeFile(join(dir, 'instance.lock', 'owner.json'), 'not an owner record');
      if (extra.mtime) await utimes(join(dir, 'instance.lock'), extra.mtime / 1000, extra.mtime / 1000);
      return acquireLock(dir, {probe: probe({bootTime: () => boot, liveness: () => 'alive'})})
        .then(async release => {await release(); return 'recovered';}, (error: Error) => error.name);
    };
    // Written before owner records existed: only a PID, which may now belong to anyone.
    expect(await outcome(undefined, {pid: 4242, mtime: before})).toBe('recovered');
    expect(await outcome(undefined, {pid: 4242})).toBe('LockHeldError');
    // An unreadable owner record.
    expect(await outcome(undefined, {junk: true, mtime: before})).toBe('recovered');
    expect(await outcome(undefined, {junk: true})).toBe('LockHeldError');
    // The owner could not read its own start identity.
    expect(await outcome({identity: null, createdAt: before}, {})).toBe('recovered');
    expect(await outcome({identity: null}, {})).toBe('LockHeldError');
    // An empty directory has no owner to protect; publishing simply replaces it.
    expect(await outcome(undefined, {})).toBe('recovered');
  });

  it('requires takeover confirmation before replacing an exited owner', async () => {
    for (const takeover of [async () => false, async () => {throw new Error('status unavailable');}]) {
      const dir = await temporary(); await plant(dir, {});
      await expect(acquireLock(dir, {probe: probe(), takeover})).rejects.toMatchObject({name: 'LockHeldError', reason: 'consumers', pid: 4242});
      expect((await owner(dir)).pid).toBe(4242);
    }
    const dir = await temporary(); await plant(dir, {});
    const release = await acquireLock(dir, {probe: probe(), takeover: async () => true});
    expect((await owner(dir)).pid).toBe(process.pid);
    await release();
  });

  it('lets exactly one of several concurrent contenders recover the same stale lock', async () => {
    for (let round = 0; round < 10; round++) {
      const dir = await temporary(); await plant(dir, {});
      const results = await Promise.allSettled([1, 2, 3].map(() => acquireLock(dir, {probe: probe()})));
      const won = results.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({name: 'LockHeldError', reason: 'running'});
      expect((await owner(dir)).pid).toBe(process.pid);
      expect(await leftovers(dir)).toEqual([]);
      expect(await tombstones(dir)).toHaveLength(1);
      await won[0]!.value();
    }
  });

  it('keeps a fresh tombstone that blocks a late contender, and sweeps it after a day', async () => {
    const dir = await temporary(); await plant(dir, {});
    const release = await acquireLock(dir, {probe: probe()});
    const [tombstone] = await tombstones(dir);
    // A contender still holding the old stale view would rename onto the existing tombstone and fail.
    await expect(rename(join(dir, 'instance.lock'), join(dir, tombstone!))).rejects.toMatchObject({code: expect.stringMatching(/ENOTEMPTY|EEXIST/)});
    await release();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3_600_000);
    try {
      const again = await acquireLock(dir, {probe: probe()});
      expect(await tombstones(dir)).toEqual([]);
      await again();
    } finally {clock.mockRestore();}
  });

  it('uses the real process table: a live owner keeps its lock, an exited or reused PID does not', async () => {
    const dir = await temporary();
    const release = await acquireLock(dir);
    const self = await owner(dir);
    if (process.platform !== 'win32') expect(self.identity).toEqual(expect.any(String));
    await expect(acquireLock(dir)).rejects.toMatchObject({name: 'LockHeldError', reason: 'running', pid: process.pid});
    await release();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const exited = spawnSync(process.execPath, ['-e', '']).pid!;
      for (const record of [{pid: exited, identity: self.identity}, ...(self.identity ? [{pid: process.pid, identity: `${self.identity}-reused`}] : [])]) {
        const stale = await temporary(); await plant(stale, record);
        const recovered = await acquireLock(stale);
        expect((await owner(stale)).pid).toBe(process.pid);
        await recovered();
      }
    } finally {warn.mockRestore();}
  });
});
