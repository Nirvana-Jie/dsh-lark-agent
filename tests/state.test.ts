import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskLedger } from '../src/ledger.js';
import { acquireLock } from '../src/lock.js';

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
