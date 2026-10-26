import {constants} from 'node:fs';
import {chmod, mkdir, open, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

export interface TopicScope {ownerKey: string; chatKey: string}
export interface TopicReceipt {threadId: string; messageId: string; link?: string}
/** Keys come exclusively from verified events and confirmed bot receipts. No message text is stored. */
export interface TopicBinding extends TopicScope, TopicReceipt {
  laneKey: string;
  conversationKey: string;
  sessionId?: string;
  groupAccessKey?: string;
}

type ErrorCode = 'INVALID_INPUT' | 'CORRUPT' | 'CONFLICT' | 'CAPACITY' | 'WRITE_FAILED' | 'UNAVAILABLE';
export class TopicStoreError extends Error {
  constructor(public readonly code: ErrorCode) {
    super({INVALID_INPUT: '话题参数无效。', CORRUPT: '话题目录损坏，请管理员检查备份；已有记录未被清空。',
      CONFLICT: '话题绑定已变化，请重新打开历史对话。', CAPACITY: '话题数量已达到上限，已有话题会保留。',
      WRITE_FAILED: '话题目录保存失败，请稍后重试。', UNAVAILABLE: '话题目录的保存结果未能确认，请管理员检查后重新启动。'}[code]);
    this.name = 'TopicStoreError';
  }
}

const KEY = /^[a-f0-9]{64}$/;
const MESSAGE = /^om_[A-Za-z0-9_-]{1,256}$/;
const THREAD = /^(?:om|omt)_[A-Za-z0-9_-]{1,256}$/;
const MAX_TOPICS = 10_000;
const MAX_OWNER_TOPICS = 1000;
const MAX_BYTES = 8 * 1024 * 1024;

/** Use only links returned by Lark's read API/CLI enrichment; never synthesize a deep link. */
export function topicLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['applink.feishu.cn', 'applink.larksuite.com'].includes(url.hostname)
      && /^\/client\/(?:thread\/open|chat\/open|message\/link\/open)$/.test(url.pathname)) return url.href;
  } catch { /* An unavailable link does not invalidate a confirmed topic. */ }
}

function validScope(scope: TopicScope): boolean {
  return Boolean(scope && typeof scope.ownerKey === 'string' && KEY.test(scope.ownerKey)
    && typeof scope.chatKey === 'string' && KEY.test(scope.chatKey));
}
function parseBinding(value: unknown): TopicBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TopicStoreError('INVALID_INPUT');
  const item = value as TopicBinding;
  if (!validScope(item) || typeof item.laneKey !== 'string' || !KEY.test(item.laneKey)
    || typeof item.conversationKey !== 'string' || !KEY.test(item.conversationKey)
    || typeof item.threadId !== 'string' || !THREAD.test(item.threadId)
    || typeof item.messageId !== 'string' || !MESSAGE.test(item.messageId)
    || (item.sessionId !== undefined && (typeof item.sessionId !== 'string' || !/^[a-f0-9]{12}$/.test(item.sessionId)))
    || (item.groupAccessKey !== undefined && (typeof item.groupAccessKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.groupAccessKey)))
    || (item.link !== undefined && topicLink(item.link) !== item.link)) throw new TopicStoreError('INVALID_INPUT');
  return {ownerKey: item.ownerKey, chatKey: item.chatKey, laneKey: item.laneKey, conversationKey: item.conversationKey,
    threadId: item.threadId, messageId: item.messageId,
    ...(item.sessionId === undefined ? {} : {sessionId: item.sessionId}),
    ...(item.groupAccessKey === undefined ? {} : {groupAccessKey: item.groupAccessKey}),
    ...(item.link === undefined ? {} : {link: item.link})};
}
function sameScope(a: TopicScope, b: TopicScope): boolean {return a.ownerKey === b.ownerKey && a.chatKey === b.chatKey;}

/** The state lock owns this store. Ambiguous publication poisons it until restart. */
export class TopicStore {
  private entries: TopicBinding[] = [];
  private tail: Promise<void> = Promise.resolve();
  private unavailable = false;
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<TopicStore> {
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
    const store = new TopicStore(directory);
    let handle;
    try {
      handle = await open(join(directory, 'topics.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error();
      const bytes = await handle.readFile();
      if (bytes.length > MAX_BYTES) throw new Error();
      const data: unknown = JSON.parse(bytes.toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('version' in data) || data.version !== 1
        || !('topics' in data) || !Array.isArray(data.topics) || data.topics.length > MAX_TOPICS) throw new Error();
      store.entries = data.topics.map(parseBinding);
      store.validate(store.entries);
      await handle.chmod(0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TopicStoreError('CORRUPT');
    } finally {await handle?.close();}
    return store;
  }

  private validate(entries: TopicBinding[]): void {
    const threads = new Set<string>(), lanes = new Set<string>(), sessions = new Set<string>(), owners = new Map<string, number>();
    for (const item of entries) {
      const thread = JSON.stringify([item.chatKey, item.threadId]);
      if (threads.has(thread) || lanes.has(item.laneKey) || (item.sessionId && sessions.has(item.sessionId))) throw new TopicStoreError('CONFLICT');
      threads.add(thread); lanes.add(item.laneKey);
      if (item.sessionId) sessions.add(item.sessionId);
      const count = (owners.get(item.ownerKey) ?? 0) + 1; owners.set(item.ownerKey, count);
      if (count > MAX_OWNER_TOPICS || entries.length > MAX_TOPICS) throw new TopicStoreError('CAPACITY');
    }
  }
  private assertAvailable(): void {if (this.unavailable) throw new TopicStoreError('UNAVAILABLE');}

  async list(scope: TopicScope): Promise<TopicBinding[]> {
    if (!validScope(scope)) throw new TopicStoreError('INVALID_INPUT');
    const identity = {...scope};
    await this.tail; this.assertAvailable();
    return this.entries.filter(item => sameScope(identity, item)).map(item => ({...item}));
  }
  async get(scope: TopicScope, threadId: string): Promise<TopicBinding | undefined> {
    return (await this.list(scope)).find(item => item.threadId === threadId);
  }
  async occupied(chatKey: string, threadId: string): Promise<boolean> {
    if (!KEY.test(chatKey) || !THREAD.test(threadId)) throw new TopicStoreError('INVALID_INPUT');
    await this.tail; this.assertAvailable();
    return this.entries.some(item => item.chatKey === chatKey && item.threadId === threadId);
  }

  record(binding: TopicBinding): Promise<TopicBinding> {
    // Snapshot the caller before queued I/O, and retain only the schema's fields.
    const next = parseBinding(binding);
    const job = this.tail.then(async () => {
      this.assertAvailable();
      const existing = this.entries.find(item => item.chatKey === next.chatKey && item.threadId === next.threadId);
      if (existing) {
        if (!sameScope(existing, next) || existing.laneKey !== next.laneKey || existing.conversationKey !== next.conversationKey
          || existing.groupAccessKey !== next.groupAccessKey || (existing.sessionId && existing.sessionId !== next.sessionId)) throw new TopicStoreError('CONFLICT');
        // A later event must not move the topic's stable anchor or discard its selected session/link.
        next.messageId = existing.messageId;
        next.sessionId ??= existing.sessionId;
        next.link ??= existing.link;
        if (JSON.stringify(existing) === JSON.stringify(next)) return {...existing};
      }
      const entries = this.entries.filter(item => item !== existing).concat(next);
      this.validate(entries);
      await this.persist(entries);
      this.entries = entries;
      return {...next};
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }

  private async persist(topics: TopicBinding[]): Promise<void> {
    const contents = JSON.stringify({version: 1, topics}) + '\n';
    // Long read-enriched links count toward the same bound used when reopening.
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new TopicStoreError('CAPACITY');
    const temporary = join(this.directory, `topics.${randomUUID()}.tmp`);
    let publicationAttempted = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {await handle.writeFile(contents); await handle.sync();}
      finally {await handle.close();}
      publicationAttempted = true;
      await rename(temporary, join(this.directory, 'topics.json'));
      const directory = await open(this.directory, 'r');
      try {await directory.sync();} finally {await directory.close();}
    } catch {
      if (publicationAttempted) this.unavailable = true;
      await unlink(temporary).catch(() => undefined);
      throw new TopicStoreError(publicationAttempted ? 'UNAVAILABLE' : 'WRITE_FAILED');
    }
  }
}
