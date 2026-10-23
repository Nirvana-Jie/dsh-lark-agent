import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';

/** How this host observes another process. Tests inject a deterministic probe. */
export interface LockProbe {
  /** Wall-clock time of the current boot, in milliseconds. */
  bootTime(): number;
  /** 'dead' only when the OS reports that no process has this PID. */
  liveness(pid: number): 'alive' | 'dead' | 'unknown';
  /** A start identity that changes when a PID is reused, or undefined when it cannot be read. */
  identity(pid: number): Promise<string | undefined>;
}

export interface LockOptions {
  /** Extra confirmation required before replacing a lock whose owner has exited. */
  takeover?: () => Promise<boolean>;
  probe?: LockProbe;
}

export class LockHeldError extends Error {
  constructor(readonly reason: 'running' | 'consumers', readonly pid?: number) {
    super(reason === 'consumers'
      ? 'Bot lease is locked: its previous owner exited, but the Lark CLI still reports active event consumers for this app.'
      : `Bot state directory is locked by ${pid ? `running process ${pid}` : 'another process'}. Stop that instance first; a lock left by an exited process is recovered automatically.`);
    this.name = 'LockHeldError';
  }
}

const OWNER_FILE = 'owner.json';
// Used only when an owner's identity cannot be verified: such a lock must predate this boot by a margin.
const UNVERIFIED_BOOT_MARGIN_MS = 10 * 60_000;
// Far longer than any contender can act on one stale view (a few bounded checks).
const TOMBSTONE_RETENTION_MS = 24 * 3_600_000;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 2 ** 31;

export const systemProbe: LockProbe = {
  bootTime: () => Date.now() - uptime() * 1000,
  liveness(pid) {
    try {process.kill(pid, 0); return 'alive';}
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ESRCH' ? 'dead' : code === 'EPERM' ? 'alive' : 'unknown';
    }
  },
  async identity(pid) {
    try {
      if (process.platform === 'linux') {
        // Boot ID plus start ticks: exact, and unaffected by wall-clock changes.
        const [boot, stat] = await Promise.all([readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
        const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        return start && /^\d+$/.test(start) ? `linux:${boot.trim()}:${start}` : undefined;
      }
      if (process.platform === 'win32') return undefined;
      // macOS keeps each process's start time fixed; pin locale and zone so both sides format it alike.
      const start = await new Promise<string>((resolve, reject) => execFile('ps', ['-o', 'lstart=', '-p', String(pid)],
        {env: {...process.env, LC_ALL: 'C', TZ: 'UTC'}, timeout: 5000, maxBuffer: 4096},
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      return start.trim() ? `ps:${start.trim().replace(/\s+/g, ' ')}` : undefined;
    } catch {return undefined;}
  },
};

interface Owner {pid?: number; identity?: string | null; createdAt?: number; token?: string}

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 4096) return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {return await handle.readFile('utf8');} finally {await handle.close();}
  } catch {return undefined;}
}

async function readOwner(lock: string): Promise<Owner> {
  const text = await readSmall(join(lock, OWNER_FILE));
  if (text !== undefined) {
    try {
      const value = JSON.parse(text) as Record<string, unknown> | null;
      if (value?.version === 1 && validPid(value.pid) && typeof value.token === 'string' && TOKEN.test(value.token) && Number.isSafeInteger(value.createdAt)
        && (value.identity === null || (typeof value.identity === 'string' && value.identity.length <= 512))) {
        return {pid: value.pid, identity: value.identity, createdAt: value.createdAt as number, token: value.token};
      }
    } catch { /* Fall back to the PID record. */ }
  }
  // Locks written before owner metadata existed record only a PID.
  const legacy = (await readSmall(join(lock, 'pid')))?.trim();
  return legacy && /^\d{1,10}$/.test(legacy) && validPid(Number(legacy)) ? {pid: Number(legacy)} : {};
}

interface Verdict {exited: boolean; pid?: number; ino: number; token?: string}

/**
 * Decide only from facts about the owner: its PID no longer exists, its PID now
 * belongs to another process, or (when identity is unverifiable) the lock predates
 * this boot. A live, unknown or unverifiable owner always keeps its lock.
 */
async function inspect(lock: string, probe: LockProbe): Promise<Verdict | undefined> {
  let info;
  try {info = await lstat(lock);} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isDirectory()) return {exited: false, ino: info.ino};
  const owner = await readOwner(lock);
  const predatesBoot = (owner.createdAt ?? info.mtimeMs) < probe.bootTime() - UNVERIFIED_BOOT_MARGIN_MS;
  const verdict = (exited: boolean): Verdict => ({exited, ino: info.ino, ...(owner.pid ? {pid: owner.pid} : {}), ...(owner.token ? {token: owner.token} : {})});
  // No readable owner (an older version mid-creation, or a damaged record): abandoned only if from an earlier boot.
  if (!owner.pid) return verdict(predatesBoot);
  const liveness = probe.liveness(owner.pid);
  if (liveness !== 'alive') return verdict(liveness === 'dead');
  if (!owner.identity) return verdict(predatesBoot);
  const current = await probe.identity(owner.pid);
  return verdict(current !== undefined && current !== owner.identity);
}

/**
 * Move aside exactly the inspected stale lock. Its tombstone name is unique to that
 * lock and outlives the takeover, so a contender still acting on the same stale view
 * cannot move a newer lock there: the rename fails because the tombstone exists.
 */
async function retire(lock: string, stale: Verdict): Promise<boolean> {
  try {await rename(lock, `${lock}.stale-${stale.ino}-${stale.token ?? 'untracked'}`);} catch (error) {
    // Gone, or already retired by a contender with the same view: look again.
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
  return true;
}

/** Drop day-old tombstones and private directories abandoned by contenders that exited. */
async function sweep(stateDir: string): Promise<void> {
  for (const name of await readdir(stateDir).catch(() => [])) {
    if (!/^instance\.lock\.(?:stale|new)-/.test(name)) continue;
    const path = join(stateDir, name);
    // A rename refreshes ctime, so it dates the retirement rather than the original lock.
    const info = await lstat(path).catch(() => undefined);
    if (info?.isDirectory() && Date.now() - info.ctimeMs > TOMBSTONE_RETENTION_MS) await rm(path, {recursive: true, force: true}).catch(() => undefined);
  }
}

/** A private, complete lock directory; renaming it into place publishes owner and lock together. */
async function prepare(lock: string, probe: LockProbe): Promise<{directory: string; token: string}> {
  const directory = `${lock}.new-${randomBytes(6).toString('hex')}`;
  await mkdir(directory, {mode: 0o700});
  const token = randomUUID();
  try {
    const owner = {version: 1, pid: process.pid, identity: await probe.identity(process.pid) ?? null, createdAt: Date.now(), token};
    await writeFile(join(directory, OWNER_FILE), JSON.stringify(owner), {mode: 0o600, flag: 'wx'});
    await writeFile(join(directory, 'pid'), String(process.pid), {mode: 0o600, flag: 'wx'});
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
  return {directory, token};
}

/**
 * Exclusive ownership of a directory. A lock is replaced only when its owner has
 * provably exited (and `takeover`, if given, also confirms); never by age alone.
 */
export async function acquireLock(stateDir: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const probe = options.probe ?? systemProbe;
  await mkdir(stateDir, {recursive: true, mode: 0o700});
  const path = join(stateDir, 'instance.lock');
  const {directory, token} = await prepare(path, probe);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // A directory rename never replaces a non-empty lock, so exactly one contender publishes.
      try {await rename(directory, path);} catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const stale = await inspect(path, probe);
        if (!stale) continue;
        if (!stale.exited) throw new LockHeldError('running', stale.pid);
        if (options.takeover && !await options.takeover().catch(() => false)) throw new LockHeldError('consumers', stale.pid);
        if (await retire(path, stale)) console.warn(`[im-larkbot] recovering a lock left by exited process ${stale.pid ?? 'unknown'}.`);
        continue;
      }
      await sweep(stateDir);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        // Never remove a lock this process no longer owns.
        if ((await readOwner(path)).token === token) await rm(path, {recursive: true, force: true});
      };
    }
    throw new LockHeldError('running');
  } finally {
    // After a successful rename the private directory no longer exists.
    await rm(directory, {recursive: true, force: true}).catch(() => undefined);
  }
}
