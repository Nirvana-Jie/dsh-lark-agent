import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export interface ActionBinding {
  ownerId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId: string;
  sourceMessageId: string;
  command: string;
  expectedSessionId?: string | null;
  expectedModelRevision?: string | null;
}

interface ActionPayload {
  version: 1;
  namespace: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  binding: ActionBinding;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 3000;
const HEX_ID = /^[a-f0-9]{12}$/;
const COMMAND = /^(?:\/(?:help|status|sessions|memory|new|model|thinking|results)|\/(?:model|thinking) (?:use [a-f0-9]{16}|page [0-9]{1,4})|\/memory (?:global|chat|show [a-f0-9]{12})|\/(?:resume|forget|result|publish|answer) [a-f0-9]{12})$/;
const PAYLOAD_KEYS = ['version', 'namespace', 'issuedAt', 'expiresAt', 'nonce', 'binding'];
const BINDING_KEYS = ['ownerId', 'chatId', 'chatType', 'threadId', 'sourceMessageId', 'command', 'expectedSessionId', 'expectedModelRevision'];

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => Object.hasOwn(value, key));
}

function validId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.length <= 128 && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value)
    && !/[\r\n]/.test(value);
}

/** Return a detached, fixed-order value; extra fields cannot become signed capabilities. */
function binding(value: unknown): ActionBinding | undefined {
  if (!record(value) || !onlyKeys(value, BINDING_KEYS) || !hasKeys(value, BINDING_KEYS.slice(0, 6))
    || !validId(value.ownerId, 'ou') || !validId(value.chatId, 'oc')
    || (value.chatType !== 'p2p' && value.chatType !== 'group')
    || !(value.threadId === '' || validId(value.threadId, 'om') || validId(value.threadId, 'omt'))
    || !(validId(value.sourceMessageId, 'om') || (typeof value.sourceMessageId === 'string' && /^menu:[a-zA-Z0-9_-]{1,128}$/.test(value.sourceMessageId)))
    || typeof value.command !== 'string' || /[\u0000-\u001f\u007f]/.test(value.command) || !COMMAND.test(value.command)
    || !(value.expectedSessionId === undefined || value.expectedSessionId === null
      || (typeof value.expectedSessionId === 'string' && value.expectedSessionId.length === 12 && HEX_ID.test(value.expectedSessionId)))
    || !(value.expectedModelRevision === undefined || value.expectedModelRevision === null
      || (typeof value.expectedModelRevision === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.expectedModelRevision)))) return undefined;
  return {
    ownerId: value.ownerId,
    chatId: value.chatId,
    chatType: value.chatType,
    threadId: value.threadId,
    sourceMessageId: value.sourceMessageId,
    command: value.command,
    ...(value.expectedSessionId === undefined ? {} : {expectedSessionId: value.expectedSessionId}),
    ...(value.expectedModelRevision === undefined ? {} : {expectedModelRevision: value.expectedModelRevision}),
  };
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - TTL_MS;
}

function payload(value: unknown, namespace: string, now: number): ActionPayload | undefined {
  if (!record(value) || !onlyKeys(value, PAYLOAD_KEYS) || !hasKeys(value, PAYLOAD_KEYS) || value.version !== 1 || value.namespace !== namespace
    || !timestamp(value.issuedAt) || !timestamp(value.expiresAt) || value.expiresAt !== value.issuedAt + TTL_MS
    || value.issuedAt > now || value.expiresAt <= now
    || typeof value.nonce !== 'string' || value.nonce.length !== 32 || !/^[a-f0-9]{32}$/.test(value.nonce)) return undefined;
  const bound = binding(value.binding);
  if (!bound) return undefined;
  return {version: 1, namespace, issuedAt: value.issuedAt, expiresAt: value.expiresAt, nonce: value.nonce, binding: bound};
}

async function persistentKey(directory: string): Promise<Buffer> {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid card action state directory.');
  await chmod(directory, 0o700);
  const path = join(directory, 'card-actions.key');
  try {
    // Exclusive creation never replaces an existing or partially written key.
    const handle = await open(path, 'wx', 0o600);
    try {
      const key = randomBytes(32);
      await handle.writeFile(key);
      await handle.sync();
    } finally { await handle.close(); }
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error('Invalid card action signing key.');
  // NOFOLLOW also rejects a symlink substituted between lstat and open.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== 32 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('Invalid card action signing key.');
    }
    const key = await handle.readFile();
    if (key.length !== 32) throw new Error('Invalid card action signing key.');
    await handle.chmod(0o600);
    return key;
  } finally { await handle.close(); }
}

/** Signed UI actions remain usable after restart; callers still verify actor, chat and authorization. */
export class CardActions {
  private constructor(private readonly key: Buffer, private readonly namespace: string) {}

  static async open(directory: string, namespace: string): Promise<CardActions> {
    if (typeof namespace !== 'string' || !namespace.trim() || Buffer.byteLength(namespace) > 512
      || /[\u0000-\u001f\u007f]/.test(namespace)) throw new Error('Invalid card action namespace.');
    try { return new CardActions(await persistentKey(directory), namespace); }
    catch { throw new Error('Card action signing state could not be opened safely.'); }
  }

  issue(value: ActionBinding): string {
    const bound = binding(value);
    const now = Date.now();
    if (!bound || !timestamp(now)) throw new Error('Invalid card action binding.');
    const document: ActionPayload = {
      version: 1, namespace: this.namespace, issuedAt: now, expiresAt: now + TTL_MS,
      nonce: randomBytes(16).toString('hex'), binding: bound,
    };
    const canonical = JSON.stringify(document);
    const token = `${Buffer.from(canonical).toString('base64url')}.${createHmac('sha256', this.key).update(canonical).digest('base64url')}`;
    if (token.length > MAX_TOKEN_LENGTH) throw new Error('Card action exceeds the size limit.');
    return token;
  }

  verify(token: string): (ActionBinding & {nonce: string; expiresAt: number}) | undefined {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return undefined;
      const parts = token.split('.');
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return undefined;
      const bytes = Buffer.from(parts[0]!, 'base64url');
      const signature = Buffer.from(parts[1]!, 'base64url');
      if (bytes.toString('base64url') !== parts[0] || signature.toString('base64url') !== parts[1]) return undefined;
      const serialized = bytes.toString('utf8');
      const expected = createHmac('sha256', this.key).update(serialized).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined;
      const now = Date.now();
      if (!timestamp(now)) return undefined;
      const validated = payload(JSON.parse(serialized), this.namespace, now);
      // Reject alternate encodings, duplicate JSON keys and noncanonical values.
      if (!validated || JSON.stringify(validated) !== serialized) return undefined;
      return {...validated.binding, nonce: validated.nonce, expiresAt: validated.expiresAt};
    } catch { return undefined; }
  }
}
