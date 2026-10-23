import {constants} from 'node:fs';
import {chmod, lstat, mkdir, open, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

const MAX_ENTRIES = 1000;
const MAX_BYTES = 512_000;
type ErrorCode = 'INVALID_INPUT' | 'CONFLICT' | 'CAPACITY' | 'CORRUPT' | 'WRITE_FAILED' | 'UNAVAILABLE';
export class DirectChatsError extends Error {
  constructor(public readonly code: ErrorCode) {super(`Private chat mapping unavailable (${code}).`);}
}
function validId(value: unknown, prefix: 'ou' | 'oc'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,128}$`).test(value);
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function parse(value: unknown): Map<string, string> {
  const document = object(value);
  if (!document || document.version !== 1 || !Array.isArray(document.entries) || document.entries.length > MAX_ENTRIES
    || Object.keys(document).some(key => key !== 'version' && key !== 'entries')) throw new DirectChatsError('CORRUPT');
  const result = new Map<string, string>(), chats = new Set<string>();
  for (const raw of document.entries) {
    const entry = object(raw);
    if (!entry || !validId(entry.openId, 'ou') || !validId(entry.chatId, 'oc')
      || Object.keys(entry).some(key => key !== 'openId' && key !== 'chatId')
      || result.has(entry.openId) || chats.has(entry.chatId)) throw new DirectChatsError('CORRUPT');
    result.set(entry.openId, entry.chatId); chats.add(entry.chatId);
  }
  return result;
}

/**
 * Trusted private-chat address book. Caller holds the bot state lock and records
 * only authorized, admitted, real p2p events (or an already verified pairing).
 * A menu's display name, payload or user-supplied chat ID must never seed this map.
 */
export class DirectChatsStore {
  private entries = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private unavailable = false;
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<DirectChatsStore> {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new DirectChatsError('CORRUPT');
    await chmod(directory, 0o700);
    const store = new DirectChatsStore(directory);
    const file = join(directory, 'direct-chats.json');
    let found = false;
    try {
      const before = await lstat(file);
      found = true;
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new DirectChatsError('CORRUPT');
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) throw new DirectChatsError('CORRUPT');
        const contents = await handle.readFile();
        if (contents.byteLength > MAX_BYTES) throw new DirectChatsError('CORRUPT');
        store.entries = parse(JSON.parse(contents.toString('utf8')));
        await handle.chmod(0o600);
      } finally {await handle.close();}
    } catch (error) {
      if (!found && (error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw new DirectChatsError('CORRUPT');
    }
    return store;
  }

  private assertAvailable(): void {if (this.unavailable) throw new DirectChatsError('UNAVAILABLE');}

  async get(openId: string): Promise<string | undefined> {
    if (!validId(openId, 'ou')) throw new DirectChatsError('INVALID_INPUT');
    await this.tail; this.assertAvailable();
    return this.entries.get(openId);
  }

  record(openId: string, chatId: string): Promise<void> {
    const job = this.tail.then(async () => {
      this.assertAvailable();
      if (!validId(openId, 'ou') || !validId(chatId, 'oc')) throw new DirectChatsError('INVALID_INPUT');
      if (this.entries.get(openId) === chatId) return;
      if ([...this.entries].some(([owner, chat]) => owner !== openId && chat === chatId)) throw new DirectChatsError('CONFLICT');
      if (!this.entries.has(openId) && this.entries.size >= MAX_ENTRIES) throw new DirectChatsError('CAPACITY');
      const next = new Map(this.entries); next.set(openId, chatId);
      await this.persist(next); this.entries = next;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  private async persist(entries: Map<string, string>): Promise<void> {
    const temporary = join(this.directory, `direct-chats.${randomUUID()}.tmp`);
    let published = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({version: 1, entries: [...entries].map(([openId, chatId]) => ({openId, chatId}))}) + '\n');
        await handle.sync();
      } finally {await handle.close();}
      await rename(temporary, join(this.directory, 'direct-chats.json')); published = true;
      const directory = await open(this.directory, 'r');
      try {await directory.sync();} finally {await directory.close();}
    } catch {
      if (published) this.unavailable = true;
      await unlink(temporary).catch(() => undefined);
      throw new DirectChatsError(published ? 'UNAVAILABLE' : 'WRITE_FAILED');
    }
  }
}
