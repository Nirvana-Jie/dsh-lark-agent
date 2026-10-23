import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, open, rename, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import type {ModelSelection} from './dsh-runtime.js';

/** Both keys must be derived by the bridge from the verified sender and chat. */
export interface ModelPreferenceContext {ownerKey: string; conversationKey: string}
export interface ModelPreferenceRecord {selection: ModelSelection; revision: string}
export interface ModelPreferenceWriteOptions {expectedRevision?: string | null}
interface StoredPreference extends ModelPreferenceContext, ModelPreferenceRecord {}
interface PreferenceDocument {version: 1; entries: StoredPreference[]}

export type ModelPreferencesErrorCode = 'INVALID_INPUT' | 'CONFLICT' | 'CAPACITY' | 'CORRUPT' | 'WRITE_FAILED' | 'UNAVAILABLE';

/** Safe for chat replies: no model values, identity keys, paths or I/O details. */
export class ModelPreferencesError extends Error {
  constructor(public readonly code: ModelPreferencesErrorCode) {
    const messages: Record<ModelPreferencesErrorCode, string> = {
      INVALID_INPUT: '模型设置参数无效，请重新打开设置后选择。',
      CONFLICT: '模型设置已经改变，请重新打开设置后选择。',
      CAPACITY: '模型设置数量已达到上限，请联系管理员处理；已有设置会保留。',
      CORRUPT: '模型设置无法安全读取，请管理员检查本地状态文件；已有记录未被清空。',
      WRITE_FAILED: '模型设置未能保存，请稍后重试。',
      UNAVAILABLE: '模型设置的保存结果未能确认，请管理员检查后重新启动。',
    };
    super(messages[code]);
    this.name = 'ModelPreferencesError';
  }
}

const FILE_NAME = 'model-preferences.json';
const MAX_OWNER_ENTRIES = 1000;
const MAX_TOTAL_ENTRIES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  // State values are plain data, not executable accessors supplied by callers.
  if (Reflect.ownKeys(value).some(key => !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return;
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
}
function validString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && value === value.trim()
    && !CONTROLS.test(value) && !Array.from(value).some(point => {
      const code = point.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    });
}
function contextSnapshot(value: ModelPreferenceContext): ModelPreferenceContext {
  const input = object(value);
  if (!input || !validString(input.ownerKey, 512) || !validString(input.conversationKey, 512)) {
    throw new ModelPreferencesError('INVALID_INPUT');
  }
  return {ownerKey: input.ownerKey, conversationKey: input.conversationKey};
}
function selectionSnapshot(value: unknown): ModelSelection {
  const input = object(value);
  if (!input || !onlyKeys(input, ['provider', 'model', 'reasoningEffort'])
    || !validString(input.provider, 256) || !validString(input.model, 256)
    || (input.reasoningEffort !== undefined && !validString(input.reasoningEffort, 128))) {
    throw new ModelPreferencesError('INVALID_INPUT');
  }
  return {provider: input.provider, model: input.model,
    ...(input.reasoningEffort !== undefined ? {reasoningEffort: input.reasoningEffort} : {})};
}
function publicRecord(value: StoredPreference): ModelPreferenceRecord {
  return {selection: {...value.selection}, revision: value.revision};
}
function identityKey(context: ModelPreferenceContext): string {
  return JSON.stringify([context.ownerKey, context.conversationKey]);
}
function parseDocument(value: unknown): PreferenceDocument {
  try {
    const input = object(value);
    if (!input || !onlyKeys(input, ['version', 'entries']) || input.version !== 1
      || !Array.isArray(input.entries) || input.entries.length > MAX_TOTAL_ENTRIES) throw new Error();
    const identities = new Set<string>();
    const owners = new Map<string, number>();
    const entries = input.entries.map((raw): StoredPreference => {
      const row = object(raw);
      if (!row || !onlyKeys(row, ['ownerKey', 'conversationKey', 'selection', 'revision'])
        || typeof row.revision !== 'string' || !REVISION.test(row.revision)) throw new Error();
      const context = contextSnapshot(row as unknown as ModelPreferenceContext);
      const key = identityKey(context);
      if (identities.has(key)) throw new Error();
      identities.add(key);
      const count = (owners.get(context.ownerKey) ?? 0) + 1;
      if (count > MAX_OWNER_ENTRIES) throw new Error();
      owners.set(context.ownerKey, count);
      return {...context, selection: selectionSnapshot(row.selection), revision: row.revision};
    });
    return {version: 1, entries};
  } catch {throw new ModelPreferencesError('CORRUPT');}
}

/**
 * One bot process owns this store under its state-directory lock. Settings span
 * topics only inside the exact owner/chat/thread namespace; revisions grant no
 * access by themselves. Availability of a model is checked by the runtime.
 */
export class ModelPreferencesStore {
  private document: PreferenceDocument = {version: 1, entries: []};
  private tail: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<ModelPreferencesStore> {
    if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw new ModelPreferencesError('INVALID_INPUT');
    const absolute = resolve(directory);
    const store = new ModelPreferencesStore(absolute);
    try {
      await mkdir(absolute, {recursive: true, mode: 0o700});
      const directoryInfo = await lstat(absolute);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error();
      await chmod(absolute, 0o700);
      const path = join(absolute, FILE_NAME);
      let info;
      try {info = await lstat(path);}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store; throw error;}
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino || actual.size > MAX_FILE_BYTES) throw new Error();
        // Bound the allocation even if a file grows after stat; changing files
        // are rejected rather than silently accepting a partial snapshot.
        const bytes = Buffer.allocUnsafe(actual.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== actual.size) throw new Error();
        const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, offset));
        store.document = parseDocument(JSON.parse(text));
        await handle.chmod(0o600);
      } finally {await handle.close();}
      return store;
    } catch {throw new ModelPreferencesError('CORRUPT');}
  }

  private assertAvailable(): void {if (this.uncertain) throw new ModelPreferencesError('UNAVAILABLE');}
  private locate(context: ModelPreferenceContext): StoredPreference | undefined {
    return this.document.entries.find(entry => entry.ownerKey === context.ownerKey && entry.conversationKey === context.conversationKey);
  }
  private async persist(document: PreferenceDocument): Promise<void> {
    const content = JSON.stringify(document) + '\n';
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new ModelPreferencesError('CAPACITY');
    const temporary = join(this.directory, `model-preferences.${randomUUID()}.tmp`);
    let publicationAttempted = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {await handle.writeFile(content, 'utf8'); await handle.sync();}
      finally {await handle.close();}
      // A rejected rename may leave publication uncertain on some filesystems.
      // Never overwrite from stale memory after any publication attempt fails.
      publicationAttempted = true;
      await rename(temporary, join(this.directory, FILE_NAME));
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {await directory.sync();} finally {await directory.close();}
    } catch {
      if (publicationAttempted) this.uncertain = true;
      await unlink(temporary).catch(() => undefined);
      throw new ModelPreferencesError(publicationAttempted ? 'UNAVAILABLE' : 'WRITE_FAILED');
    }
  }

  async get(context: ModelPreferenceContext): Promise<ModelPreferenceRecord | undefined> {
    const identity = contextSnapshot(context);
    await this.tail;
    this.assertAvailable();
    const entry = this.locate(identity);
    return entry && publicRecord(entry);
  }

  async set(context: ModelPreferenceContext, selection: ModelSelection,
    options: ModelPreferenceWriteOptions = {}): Promise<ModelPreferenceRecord> {
    // Snapshot all caller-owned input before waiting for an earlier disk write.
    const identity = contextSnapshot(context);
    const selected = selectionSnapshot(selection);
    const optionRecord = object(options);
    if (!optionRecord || !onlyKeys(optionRecord, ['expectedRevision'])) throw new ModelPreferencesError('INVALID_INPUT');
    const expected = optionRecord.expectedRevision;
    if (expected !== undefined && expected !== null && (typeof expected !== 'string' || !REVISION.test(expected))) {
      throw new ModelPreferencesError('INVALID_INPUT');
    }
    const job = this.tail.then(async () => {
      this.assertAvailable();
      const previous = this.locate(identity);
      if (expected !== undefined && (previous?.revision ?? null) !== expected) throw new ModelPreferencesError('CONFLICT');
      if (!previous && (this.document.entries.length >= MAX_TOTAL_ENTRIES
        || this.document.entries.filter(entry => entry.ownerKey === identity.ownerKey).length >= MAX_OWNER_ENTRIES)) {
        throw new ModelPreferencesError('CAPACITY');
      }
      const value: StoredPreference = {...identity, selection: selected, revision: randomUUID()};
      const entries = this.document.entries.map(entry => entry === previous ? value : entry);
      if (!previous) entries.push(value);
      const draft: PreferenceDocument = {version: 1, entries};
      await this.persist(draft);
      this.document = draft;
      return publicRecord(value);
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}
