import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface SessionContext {
  ownerKey: string;
  conversationKey: string;
  /** A topic may point at one historical session without changing its siblings' active selection. */
  sessionId?: string;
}

export interface SavedSession {
  id: string;
  nativeId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface SavedContext extends SessionContext {
  activeId: string | null;
  sessions: SavedSession[];
}

interface StoreDocument {
  version: 1;
  contexts: SavedContext[];
}

export type SessionStoreErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'NO_CURRENT' | 'CONFLICT' | 'CAPACITY' | 'CORRUPT' | 'WRITE_FAILED' | 'UNAVAILABLE';

/** Messages contain no titles, user identifiers, native session IDs, or filesystem details. */
export class SessionStoreError extends Error {
  constructor(public readonly code: SessionStoreErrorCode) {
    const messages: Record<SessionStoreErrorCode, string> = {
      INVALID_INPUT: '会话参数无效。标题请使用 1–80 个字符，不要包含换行或控制字符。',
      NOT_FOUND: '未找到当前聊天中属于你的这条会话。',
      NO_CURRENT: '当前聊天尚未选择会话。',
      CONFLICT: '会话状态已变化，请重新打开历史对话后重试。',
      CAPACITY: '已达到历史会话数量上限，请联系管理员处理。已有会话仍会保留。',
      CORRUPT: '会话目录损坏或版本不兼容，请管理员检查备份；已有记录未被清空。',
      WRITE_FAILED: '会话目录保存失败，请稍后重试。',
      UNAVAILABLE: '会话目录的保存结果未能确认，请管理员检查后重新启动。',
    };
    super(messages[code]);
    this.name = 'SessionStoreError';
  }
}

const SESSION_ID = /^[0-9a-f]{12}$/;
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const MAX_CONTEXT_SESSIONS = 100;
const MAX_OWNER_SESSIONS = 1000;

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !CONTROLS.test(value);
}

function validateContext(value: SessionContext): void {
  if (!value || !validKey(value.ownerKey) || !validKey(value.conversationKey)
    || (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)))) throw new SessionStoreError('INVALID_INPUT');
}

function titleText(value: unknown): string {
  if (typeof value !== 'string' || CONTROLS.test(value)) throw new SessionStoreError('INVALID_INPUT');
  const result = value.trim();
  if (!result || Array.from(result).length > 80) throw new SessionStoreError('INVALID_INPUT');
  return result;
}

function contextKey(context: SessionContext): string {
  return JSON.stringify([context.ownerKey, context.conversationKey]);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1000;
}

/** Parse into fresh objects; never retain unknown properties from disk. */
function parseDocument(value: unknown): StoreDocument {
  try {
    const input = object(value);
    if (input?.version !== 1 || !Array.isArray(input.contexts)) throw new Error();
    const contextIds = new Set<string>();
    const sessionIds = new Set<string>();
    const nativeIds = new Set<string>();
    const ownerCounts = new Map<string, number>();
    const contexts: SavedContext[] = input.contexts.map((raw): SavedContext => {
      const entry = object(raw);
      if (!entry || !validKey(entry.ownerKey) || !validKey(entry.conversationKey)
        || !Array.isArray(entry.sessions) || entry.sessions.length > MAX_CONTEXT_SESSIONS) throw new Error();
      const identity = {ownerKey: entry.ownerKey, conversationKey: entry.conversationKey};
      const key = contextKey(identity);
      if (contextIds.has(key)) throw new Error();
      contextIds.add(key);
      const sessions: SavedSession[] = entry.sessions.map((rawSession): SavedSession => {
        const session = object(rawSession);
        if (!session || typeof session.id !== 'string' || !SESSION_ID.test(session.id)
          || typeof session.nativeId !== 'string' || !NATIVE_ID.test(session.nativeId)
          || !timestamp(session.createdAt) || !timestamp(session.updatedAt)
          || session.updatedAt < session.createdAt) throw new Error();
        const title = titleText(session.title);
        if (title !== session.title || sessionIds.has(session.id) || nativeIds.has(session.nativeId.toLowerCase())) throw new Error();
        sessionIds.add(session.id);
        nativeIds.add(session.nativeId.toLowerCase());
        return {id: session.id, nativeId: session.nativeId, title, createdAt: session.createdAt, updatedAt: session.updatedAt};
      });
      if (entry.activeId !== null && (typeof entry.activeId !== 'string' || !sessions.some(session => session.id === entry.activeId))) throw new Error();
      const ownerCount = (ownerCounts.get(entry.ownerKey) ?? 0) + sessions.length;
      if (ownerCount > MAX_OWNER_SESSIONS) throw new Error();
      ownerCounts.set(entry.ownerKey, ownerCount);
      return {...identity, activeId: entry.activeId as string | null, sessions};
    });
    return {version: 1, contexts};
  } catch {
    throw new SessionStoreError('CORRUPT');
  }
}

/**
 * Single-instance durable catalog. The caller must hold the bot's process lock.
 * Every lookup includes both the owner and conversation; a visible ID grants no access.
 */
export class SessionStore {
  private document: StoreDocument = {version: 1, contexts: []};
  private tail: Promise<unknown> = Promise.resolve();
  private unavailable = false;

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<SessionStore> {
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
    const store = new SessionStore(directory);
    const file = join(directory, 'sessions.json');
    try {
      store.document = parseDocument(JSON.parse(await readFile(file, 'utf8')));
      await chmod(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw new SessionStoreError('CORRUPT');
    }
    return store;
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new SessionStoreError('UNAVAILABLE');
  }

  private locate(document: StoreDocument, context: SessionContext): SavedContext | undefined {
    return document.contexts.find(entry => entry.ownerKey === context.ownerKey && entry.conversationKey === context.conversationKey);
  }

  private nextTimestamp(document: StoreDocument): number {
    let time = Date.now();
    for (const context of document.contexts) for (const session of context.sessions) time = Math.max(time, session.updatedAt + 1);
    return time;
  }

  private async persist(document: StoreDocument): Promise<void> {
    const file = join(this.directory, 'sessions.json');
    const temporary = join(this.directory, `sessions.${randomUUID()}.tmp`);
    let publicationAttempted = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(document) + '\n', 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      publicationAttempted = true;
      await rename(temporary, file);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      // A rejected rename can still have reached disk before confirmation was
      // lost. Never allow stale memory to overwrite an uncertain publication.
      if (publicationAttempted) this.unavailable = true;
      await unlink(temporary).catch(() => undefined);
      throw new SessionStoreError(publicationAttempted ? 'UNAVAILABLE' : 'WRITE_FAILED');
    }
  }

  private mutate<T>(context: SessionContext, update: (draft: StoreDocument) => {value: T; changed: boolean}): Promise<T> {
    // Snapshot caller-owned identity before an earlier queued mutation awaits I/O.
    const identity = {...context};
    const job = this.tail.then(async () => {
      this.assertAvailable();
      validateContext(identity);
      const draft = structuredClone(this.document);
      const {value, changed} = update(draft);
      if (changed) {
        await this.persist(draft);
        this.document = draft;
      }
      return structuredClone(value);
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  async current(context: SessionContext): Promise<SavedSession | undefined> {
    const identity = {...context};
    validateContext(identity);
    await this.tail;
    this.assertAvailable();
    const entry = this.locate(this.document, identity);
    const current = entry?.sessions.find(session => session.id === (identity.sessionId ?? entry.activeId));
    if (identity.sessionId && !current) throw new SessionStoreError('NOT_FOUND');
    return current && {...current};
  }

  async list(context: SessionContext): Promise<SavedSession[]> {
    const identity = {...context};
    validateContext(identity);
    await this.tail;
    this.assertAvailable();
    return (this.locate(this.document, identity)?.sessions ?? [])
      .map(session => ({...session})).sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  add(context: SessionContext, nativeId: string, title = '新会话'): Promise<SavedSession> {
    const identity = {...context};
    return this.mutate(identity, draft => {
      if (identity.sessionId !== undefined) throw new SessionStoreError('INVALID_INPUT');
      if (!NATIVE_ID.test(nativeId)) throw new SessionStoreError('INVALID_INPUT');
      const safeTitle = titleText(title);
      let entry = this.locate(draft, identity);
      const owned = draft.contexts.filter(candidate => candidate.ownerKey === identity.ownerKey);
      if ((entry?.sessions.length ?? 0) >= MAX_CONTEXT_SESSIONS || owned.reduce((count, candidate) => count + candidate.sessions.length, 0) >= MAX_OWNER_SESSIONS) throw new SessionStoreError('CAPACITY');
      const all = draft.contexts.flatMap(candidate => candidate.sessions);
      if (all.some(session => session.nativeId.toLowerCase() === nativeId.toLowerCase())) throw new SessionStoreError('INVALID_INPUT');
      const usedIds = new Set(all.map(session => session.id));
      let id: string;
      do { id = randomBytes(6).toString('hex'); } while (usedIds.has(id));
      const time = this.nextTimestamp(draft);
      const session: SavedSession = {id, nativeId, title: safeTitle, createdAt: time, updatedAt: time};
      if (!entry) { entry = {ownerKey: identity.ownerKey, conversationKey: identity.conversationKey, activeId: null, sessions: []}; draft.contexts.push(entry); }
      entry.sessions.push(session);
      entry.activeId = id;
      return {value: session, changed: true};
    });
  }

  activate(context: SessionContext, id: string): Promise<SavedSession> {
    const identity = {...context};
    return this.mutate(identity, draft => {
      const entry = this.locate(draft, identity);
      const session = entry?.sessions.find(candidate => candidate.id === id);
      if (!session || !entry) throw new SessionStoreError('NOT_FOUND');
      session.updatedAt = this.nextTimestamp(draft);
      entry.activeId = session.id;
      return {value: session, changed: true};
    });
  }

  /** Replace only a confirmed native binding, preserving the user's stable topic. */
  rebindNative(context: SessionContext, id: string, expectedNativeId: string, newNativeId: string): Promise<SavedSession> {
    const identity = {...context};
    return this.mutate(identity, draft => {
      if (typeof id !== 'string' || !SESSION_ID.test(id)
        || typeof expectedNativeId !== 'string' || !NATIVE_ID.test(expectedNativeId)
        || typeof newNativeId !== 'string' || !NATIVE_ID.test(newNativeId)) throw new SessionStoreError('INVALID_INPUT');
      const entry = this.locate(draft, identity);
      const session = entry?.sessions.find(candidate => candidate.id === id);
      if (!session) throw new SessionStoreError('NOT_FOUND');
      if (session.nativeId !== expectedNativeId) throw new SessionStoreError('CONFLICT');
      if (session.nativeId.toLowerCase() === newNativeId.toLowerCase()) return {value: session, changed: false};
      if (draft.contexts.some(candidate => candidate.sessions.some(saved => saved.nativeId.toLowerCase() === newNativeId.toLowerCase()))) {
        throw new SessionStoreError('INVALID_INPUT');
      }
      session.nativeId = newNativeId;
      return {value: session, changed: true};
    });
  }

  archive(context: SessionContext): Promise<void> {
    const identity = {...context};
    return this.mutate(identity, draft => {
      const entry = this.locate(draft, identity);
      const changed = Boolean(entry?.activeId && (!identity.sessionId || identity.sessionId === entry.activeId));
      if (entry && changed) entry.activeId = null;
      return {value: undefined, changed};
    });
  }

  rename(context: SessionContext, title: string): Promise<SavedSession> {
    const identity = {...context};
    return this.mutate(identity, draft => {
      const safeTitle = titleText(title);
      const entry = this.locate(draft, identity);
      const session = entry?.sessions.find(candidate => candidate.id === (identity.sessionId ?? entry.activeId));
      if (!session) throw new SessionStoreError('NO_CURRENT');
      session.title = safeTitle;
      session.updatedAt = this.nextTimestamp(draft);
      return {value: session, changed: true};
    });
  }

  touch(context: SessionContext, id: string): Promise<void> {
    const identity = {...context};
    return this.mutate(identity, draft => {
      const entry = this.locate(draft, identity);
      const session = entry?.sessions.find(candidate => candidate.id === id);
      if (!session) throw new SessionStoreError('NOT_FOUND');
      session.updatedAt = this.nextTimestamp(draft);
      return {value: undefined, changed: true};
    });
  }
}
