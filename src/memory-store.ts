import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface MemoryContext {
  /** Trusted host-derived principal, including the bot/application namespace. */
  ownerKey: string;
  /** Trusted host-derived user/chat/topic namespace. Never read from model arguments. */
  conversationKey: string;
  /** Trusted audience boundary: only private chats may manage personal records. */
  privateChat: boolean;
}

export interface MemoryEntry {
  id: string;
  scope: 'personal' | 'chat';
  /** Personal content may enter group contexts only after explicit private-chat consent. */
  groupShared: boolean;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredMemory extends MemoryEntry {
  ownerKey: string;
  conversationKey?: string;
}
interface GroupEpoch { ownerKey: string; epoch: string }
interface MemoryDocument { version: 2; entries: StoredMemory[]; groupEpochs: GroupEpoch[] }
type MemoryErrorCode = 'INVALID_INPUT' | 'FORBIDDEN_SCOPE' | 'PRIVATE_ONLY' | 'CAPACITY' | 'CORRUPT' | 'WRITE_FAILED' | 'UNAVAILABLE';

/** Messages contain no saved content, filesystem paths, or underlying I/O diagnostics. */
export class MemoryStoreError extends Error {
  constructor(public readonly code: MemoryErrorCode) {
    const messages: Record<MemoryErrorCode, string> = {
      INVALID_INPUT: '记忆内容或标识无效。内容必须为 1–2000 个字符。',
      FORBIDDEN_SCOPE: '无效的记忆范围。',
      PRIVATE_ONLY: '个人记忆只能由本人在机器人私聊中保存或管理。',
      CAPACITY: '记忆数量已达到上限，请先删除不需要的记忆。',
      CORRUPT: '记忆存储无法安全读取，请管理员检查本地状态文件。',
      WRITE_FAILED: '记忆未能确认保存，请稍后检查记忆列表再重试。',
      UNAVAILABLE: '记忆存储状态不确定，请管理员检查后重新启动。',
    };
    super(messages[code]);
    this.name = 'MemoryStoreError';
  }
}

const MAX_TEXT_POINTS = 2000;
const MAX_OWNER_ENTRIES = 200;
const MAX_BUCKET_ENTRIES = 100;
const MAX_TOTAL_ENTRIES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ID_PATTERN = /^[a-f0-9]{12}$/;
const EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INITIAL_GROUP_EPOCH = 'private-memory-v2';

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function contextSnapshot(context: MemoryContext): MemoryContext {
  if (!context || !validKey(context.ownerKey) || !validKey(context.conversationKey) || typeof context.privateChat !== 'boolean') {
    throw new MemoryStoreError('INVALID_INPUT');
  }
  return {ownerKey: context.ownerKey, conversationKey: context.conversationKey, privateChat: context.privateChat};
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') throw new MemoryStoreError('INVALID_INPUT');
  const text = value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
  const points = Array.from(text);
  if (points.length === 0 || points.length > MAX_TEXT_POINTS || points.some(point => {
    const code = point.codePointAt(0)!;
    return (code < 32 && code !== 9 && code !== 10) || code === 127 || (code >= 0xd800 && code <= 0xdfff);
  })) throw new MemoryStoreError('INVALID_INPUT');
  return text;
}

function publicEntry(entry: StoredMemory): MemoryEntry {
  return {id: entry.id, scope: entry.scope, groupShared: entry.groupShared, text: entry.text, createdAt: entry.createdAt, updatedAt: entry.updatedAt};
}

function visible(entry: StoredMemory, context: MemoryContext): boolean {
  return entry.ownerKey === context.ownerKey && (entry.scope === 'personal'
    ? context.privateChat || entry.groupShared
    : entry.conversationKey === context.conversationKey);
}

function sameBucket(entry: StoredMemory, context: MemoryContext, scope: MemoryEntry['scope']): boolean {
  return entry.ownerKey === context.ownerKey && entry.scope === scope && (scope === 'personal' || entry.conversationKey === context.conversationKey);
}

function validateDocument(value: unknown): {entries: StoredMemory[]; groupEpochs: Map<string, string>} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryStoreError('CORRUPT');
  const document = value as Record<string, unknown>;
  if ((document.version !== 1 && document.version !== 2) || !Array.isArray(document.entries) || document.entries.length > MAX_TOTAL_ENTRIES) {
    throw new MemoryStoreError('CORRUPT');
  }
  const ids = new Set<string>();
  const ownerCounts = new Map<string, number>();
  const bucketCounts = new Map<string, number>();
  const entries: StoredMemory[] = [];
  const groupEpochs = new Map<string, string>();
  try {
    if (document.version === 2) {
      if (!Array.isArray(document.groupEpochs) || document.groupEpochs.length > MAX_TOTAL_ENTRIES) throw new Error('Invalid epochs');
      for (const raw of document.groupEpochs) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid epoch');
        const row = raw as Record<string, unknown>;
        if (!validKey(row.ownerKey) || typeof row.epoch !== 'string' || !EPOCH_PATTERN.test(row.epoch)
          || groupEpochs.has(row.ownerKey)) throw new Error('Invalid epoch');
        groupEpochs.set(row.ownerKey, row.epoch);
      }
    }
    for (const raw of document.entries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid record');
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== 'string' || !ID_PATTERN.test(row.id) || ids.has(row.id) || !validKey(row.ownerKey)
        || (row.scope !== 'personal' && row.scope !== 'chat')
        || (document.version === 2 && (typeof row.groupShared !== 'boolean'
          || (row.scope === 'chat' && row.groupShared) || (row.groupShared && !groupEpochs.has(row.ownerKey))))
        || (row.scope === 'chat' ? !validKey(row.conversationKey) : row.conversationKey !== undefined)
        || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0
        || typeof row.updatedAt !== 'number' || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.createdAt
        || normalizeText(row.text) !== row.text) throw new Error('Invalid record');
      const bucketKey = JSON.stringify([row.ownerKey, row.scope, row.conversationKey]);
      const ownerCount = (ownerCounts.get(row.ownerKey) ?? 0) + 1;
      const bucketCount = (bucketCounts.get(bucketKey) ?? 0) + 1;
      if (ownerCount > MAX_OWNER_ENTRIES || bucketCount > MAX_BUCKET_ENTRIES) throw new Error('Capacity exceeded');
      ids.add(row.id);
      ownerCounts.set(row.ownerKey, ownerCount);
      bucketCounts.set(bucketKey, bucketCount);
      entries.push({
        id: row.id, ownerKey: row.ownerKey, scope: row.scope, text: row.text as string,
        // Older records did not record explicit consent to disclose in groups.
        groupShared: document.version === 2 && row.groupShared === true,
        ...(row.scope === 'chat' ? {conversationKey: row.conversationKey as string} : {}),
        createdAt: row.createdAt, updatedAt: row.updatedAt,
      });
    }
  } catch {
    throw new MemoryStoreError('CORRUPT');
  }
  return {entries, groupEpochs};
}

/**
 * One host process owns this store under the existing state-directory lock.
 * Personal memories are private unless explicitly shared by their owner. Chat
 * memories stay in one conversation. Reads, disclosure and revocations are ordered.
 */
export class MemoryStore {
  private entries: StoredMemory[] = [];
  private groupEpochs = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private uncertain = false;

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<MemoryStore> {
    const absolute = resolve(directory);
    const store = new MemoryStore(absolute);
    try {
      await mkdir(absolute, {recursive: true, mode: 0o700});
      const directoryInfo = await lstat(absolute);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new MemoryStoreError('CORRUPT');
      await chmod(absolute, 0o700);
      const file = join(absolute, 'memory.json');
      let info;
      try {
        info = await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return store;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new MemoryStoreError('CORRUPT');
      await chmod(file, 0o600);
      const handle = await open(file, 'r');
      try {
        const loaded = validateDocument(JSON.parse(await handle.readFile('utf8')));
        store.entries = loaded.entries;
        store.groupEpochs = loaded.groupEpochs;
      }
      finally { await handle.close(); }
      return store;
    } catch {
      throw new MemoryStoreError('CORRUPT');
    }
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const job = this.tail.then(() => {
      if (this.uncertain) throw new MemoryStoreError('UNAVAILABLE');
      return task();
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  private async persist(entries: StoredMemory[], groupEpochs = this.groupEpochs): Promise<void> {
    if (groupEpochs.size > MAX_TOTAL_ENTRIES) throw new MemoryStoreError('CAPACITY');
    const document: MemoryDocument = {version: 2, entries, groupEpochs: [...groupEpochs].map(([ownerKey, epoch]) => ({ownerKey, epoch}))};
    const content = JSON.stringify(document) + '\n';
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new MemoryStoreError('CAPACITY');
    const temporary = join(this.directory, `memory.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, join(this.directory, 'memory.json'));
      renamed = true;
      // macOS/Linux normally support directory fsync; tolerate only explicit
      // platform "unsupported" errors, never a genuine storage failure.
      try {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); }
        finally { await directory.close(); }
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    } catch {
      // A post-rename failure has an ambiguous durability outcome. Keep the
      // old in-memory snapshot and require recovery instead of overwriting it.
      if (renamed) this.uncertain = true;
      throw new MemoryStoreError('WRITE_FAILED');
    } finally {
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
    this.entries = entries;
    this.groupEpochs = groupEpochs;
  }

  async list(context: MemoryContext): Promise<MemoryEntry[]> {
    const snapshot = contextSnapshot(context);
    return this.enqueue(() => this.entries.filter(entry => visible(entry, snapshot))
      .reverse().sort((a, b) => b.updatedAt - a.updatedAt).map(publicEntry));
  }

  async search(context: MemoryContext, query: string): Promise<MemoryEntry[]> {
    const snapshot = contextSnapshot(context);
    if (typeof query !== 'string' || Array.from(query).length > MAX_TEXT_POINTS) throw new MemoryStoreError('INVALID_INPUT');
    const normalized = query.trim().normalize('NFKC').toLowerCase();
    return this.enqueue(() => this.entries.filter(entry => visible(entry, snapshot)
      && entry.text.normalize('NFKC').toLowerCase().includes(normalized))
      .reverse().sort((a, b) => b.updatedAt - a.updatedAt).map(publicEntry));
  }

  async add(context: MemoryContext, scope: MemoryEntry['scope'], text: string): Promise<MemoryEntry> {
    const snapshot = contextSnapshot(context);
    if (scope !== 'personal' && scope !== 'chat') throw new MemoryStoreError('FORBIDDEN_SCOPE');
    // Deny before deduplication: a group cannot probe or retrieve a private entry.
    if (scope === 'personal' && !snapshot.privateChat) throw new MemoryStoreError('PRIVATE_ONLY');
    const normalized = normalizeText(text);
    return this.enqueue(async () => {
      const bucket = this.entries.filter(entry => sameBucket(entry, snapshot, scope));
      const existing = bucket.find(entry => entry.text === normalized);
      if (existing) return publicEntry(existing);
      if (bucket.length >= MAX_BUCKET_ENTRIES || this.entries.filter(entry => entry.ownerKey === snapshot.ownerKey).length >= MAX_OWNER_ENTRIES
        || this.entries.length >= MAX_TOTAL_ENTRIES) throw new MemoryStoreError('CAPACITY');
      let id = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = randomUUID().replaceAll('-', '').slice(0, 12);
        if (!this.entries.some(entry => entry.id === candidate)) { id = candidate; break; }
      }
      if (!id) throw new MemoryStoreError('UNAVAILABLE');
      const now = Date.now();
      const entry: StoredMemory = {id, scope, groupShared: false, ownerKey: snapshot.ownerKey, text: normalized,
        ...(scope === 'chat' ? {conversationKey: snapshot.conversationKey} : {}), createdAt: now, updatedAt: now};
      await this.persist([...this.entries, entry]);
      return publicEntry(entry);
    });
  }

  async remove(context: MemoryContext, id: string): Promise<boolean> {
    const snapshot = contextSnapshot(context);
    return this.enqueue(async () => {
      const index = this.entries.findIndex(entry => entry.id === id && visible(entry, snapshot)
        && (snapshot.privateChat || entry.scope === 'chat'));
      if (index === -1) return false;
      const epochs = new Map(this.groupEpochs);
      if (this.entries[index]!.groupShared) epochs.set(snapshot.ownerKey, randomUUID());
      await this.persist(this.entries.filter((_, row) => row !== index), epochs);
      return true;
    });
  }

  async setGroupShared(context: MemoryContext, id: string, shared: boolean): Promise<MemoryEntry | undefined> {
    const snapshot = contextSnapshot(context);
    if (!snapshot.privateChat) throw new MemoryStoreError('PRIVATE_ONLY');
    if (typeof shared !== 'boolean') throw new MemoryStoreError('INVALID_INPUT');
    return this.enqueue(async () => {
      const index = this.entries.findIndex(entry => entry.id === id && entry.ownerKey === snapshot.ownerKey && entry.scope === 'personal');
      if (index === -1) return undefined;
      const previous = this.entries[index]!;
      if (previous.groupShared === shared) return publicEntry(previous);
      const entry = {...previous, groupShared: shared, updatedAt: Math.max(Date.now(), previous.updatedAt + 1)};
      const epochs = new Map(this.groupEpochs);
      epochs.set(snapshot.ownerKey, randomUUID());
      const entries = [...this.entries];
      entries[index] = entry;
      await this.persist(entries, epochs);
      return publicEntry(entry);
    });
  }

  async groupAccessKey(context: MemoryContext): Promise<string> {
    const snapshot = contextSnapshot(context);
    return this.enqueue(() => this.groupEpochs.get(snapshot.ownerKey) ?? INITIAL_GROUP_EPOCH);
  }

  /** The task must not re-enter this store. Hold the queue through the whole send. */
  async withGroupAccess(context: MemoryContext, expectedKey: string, task: () => Promise<void>): Promise<boolean> {
    const snapshot = contextSnapshot(context);
    if (typeof expectedKey !== 'string' || typeof task !== 'function') throw new MemoryStoreError('INVALID_INPUT');
    return this.enqueue(async () => {
      if ((this.groupEpochs.get(snapshot.ownerKey) ?? INITIAL_GROUP_EPOCH) !== expectedKey) return false;
      await task();
      return true;
    });
  }
}
