import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, open, rename, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';

/** Both keys must be derived by the bridge from the verified sender and chat. */
export interface PermissionPreferenceContext {ownerKey: string; conversationKey: string}
interface StoredPermission extends PermissionPreferenceContext {preset: string}
interface PermissionDocument {version: 1; entries: StoredPermission[]}

/** Safe for chat replies: no identity keys, paths or I/O details. */
export class PermissionPreferencesError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'CAPACITY' | 'CORRUPT' | 'WRITE_FAILED' | 'UNAVAILABLE') {
    super({
      INVALID_INPUT: '权限设置参数无效，请重新打开权限模式后选择。',
      CAPACITY: '权限设置数量已达到上限，已有设置会保留。',
      CORRUPT: '权限设置无法安全读取，请管理员检查本地状态文件；已有记录未被清空。',
      WRITE_FAILED: '权限设置未能保存，请稍后重试。',
      UNAVAILABLE: '权限设置的保存结果未能确认，请管理员检查后重新启动。',
    }[code]);
    this.name = 'PermissionPreferencesError';
  }
}

const FILE_NAME = 'permission-preferences.json';
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const PRESET = /^[a-z][a-z0-9-]{0,39}$/;
const KEY = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\u0000-\u001f\u007f]/.test(value);

function snapshot(context: PermissionPreferenceContext): PermissionPreferenceContext {
  if (!context || typeof context !== 'object' || !KEY(context.ownerKey) || !KEY(context.conversationKey)) {
    throw new PermissionPreferencesError('INVALID_INPUT');
  }
  return {ownerKey: context.ownerKey, conversationKey: context.conversationKey};
}

function parse(value: unknown): PermissionDocument {
  const input = value as {version?: unknown; entries?: unknown} | undefined;
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'version' && key !== 'entries')
    || input.version !== 1 || !Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) throw new Error();
  const seen = new Set<string>();
  const entries = input.entries.map((raw): StoredPermission => {
    const row = raw as Record<string, unknown> | undefined;
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['ownerKey', 'conversationKey', 'preset'].includes(key))
      || typeof row.preset !== 'string' || !PRESET.test(row.preset)) throw new Error();
    const context = snapshot(row as unknown as PermissionPreferenceContext);
    const identity = JSON.stringify([context.ownerKey, context.conversationKey]);
    if (seen.has(identity)) throw new Error();
    seen.add(identity);
    return {...context, preset: row.preset};
  });
  return {version: 1, entries};
}

/**
 * The permission preset a private chat chose in Feishu. It applies to that
 * chat's sessions only; the host's own default for other sessions is untouched.
 * One bot process owns this store under its state-directory lock.
 */
export class PermissionPreferencesStore {
  private document: PermissionDocument = {version: 1, entries: []};
  private tail: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<PermissionPreferencesStore> {
    if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw new PermissionPreferencesError('INVALID_INPUT');
    const store = new PermissionPreferencesStore(resolve(directory));
    try {
      await mkdir(store.directory, {recursive: true, mode: 0o700});
      const info = await lstat(store.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      await chmod(store.directory, 0o700);
      const path = join(store.directory, FILE_NAME);
      let file;
      try {file = await lstat(path);}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store; throw error;}
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_FILE_BYTES) throw new Error();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.dev !== file.dev || actual.ino !== file.ino || actual.size > MAX_FILE_BYTES) throw new Error();
        const text = new TextDecoder('utf-8', {fatal: true}).decode(await handle.readFile());
        if (Buffer.byteLength(text) !== actual.size) throw new Error();
        store.document = parse(JSON.parse(text));
        await handle.chmod(0o600);
      } finally {await handle.close();}
      return store;
    } catch {throw new PermissionPreferencesError('CORRUPT');}
  }

  async get(context: PermissionPreferenceContext): Promise<string | undefined> {
    const identity = snapshot(context);
    await this.tail;
    if (this.uncertain) throw new PermissionPreferencesError('UNAVAILABLE');
    return this.document.entries.find(entry => entry.ownerKey === identity.ownerKey && entry.conversationKey === identity.conversationKey)?.preset;
  }

  async set(context: PermissionPreferenceContext, preset: string): Promise<void> {
    const identity = snapshot(context);
    if (typeof preset !== 'string' || !PRESET.test(preset)) throw new PermissionPreferencesError('INVALID_INPUT');
    const job = this.tail.then(async () => {
      if (this.uncertain) throw new PermissionPreferencesError('UNAVAILABLE');
      const previous = this.document.entries.find(entry => entry.ownerKey === identity.ownerKey && entry.conversationKey === identity.conversationKey);
      if (previous?.preset === preset) return;
      if (!previous && this.document.entries.length >= MAX_ENTRIES) throw new PermissionPreferencesError('CAPACITY');
      const value = {...identity, preset};
      const entries = previous ? this.document.entries.map(entry => entry === previous ? value : entry) : [...this.document.entries, value];
      const draft: PermissionDocument = {version: 1, entries};
      await this.persist(draft);
      this.document = draft;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  private async persist(document: PermissionDocument): Promise<void> {
    const content = JSON.stringify(document) + '\n';
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new PermissionPreferencesError('CAPACITY');
    const temporary = join(this.directory, `permission-preferences.${randomUUID()}.tmp`);
    let publicationAttempted = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {await handle.writeFile(content, 'utf8'); await handle.sync();}
      finally {await handle.close();}
      // A rejected rename may leave publication uncertain; never overwrite from stale memory afterwards.
      publicationAttempted = true;
      await rename(temporary, join(this.directory, FILE_NAME));
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {await directory.sync();} finally {await directory.close();}
    } catch {
      if (publicationAttempted) this.uncertain = true;
      await unlink(temporary).catch(() => undefined);
      throw new PermissionPreferencesError(publicationAttempted ? 'UNAVAILABLE' : 'WRITE_FAILED');
    }
  }
}
