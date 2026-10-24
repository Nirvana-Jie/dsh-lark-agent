import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';

export interface UserPolicy {
  openId: string;
  direct: boolean;
  groupChats: string[];
  cwd: string;
  allowedTools: string[];
  /**
   * 'harness': this user's private chat is a channel into an ordinary Harness
   * session, with the host's prompt, tools and approvals. Group chats always
   * use the restricted assistant and allowedTools.
   */
  directMode: 'harness' | 'restricted';
}

export interface BotConfig {
  profile: string;
  botOpenId: string;
  executable: string;
  stateDir: string;
  provider?: string;
  model?: string;
  users: UserPolicy[];
  turnTimeoutMs: number;
  idleTimeoutMs: number;
  maxSessions: number;
  maxSessionsPerUser: number;
  maxPending: number;
  maxPendingPerSession: number;
  maxInputChars: number;
  maxOutputChars: number;
  chunkBytes: number;
  responseMode: 'auto' | 'text';
  cardInteractions: boolean;
  loadingReaction: boolean;
  botMenu: boolean;
  /** Stream harness-mode private replies into a CardKit card (needs cardkit:card:write). */
  streamingCards: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function id(value: unknown, prefix: string, label: string): string {
  const result = string(value, label);
  if (!new RegExp(`^${prefix}_[a-zA-Z0-9_-]+$`).test(result)) throw new Error(`${label} must be a ${prefix}_ ID`);
  return result;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array (max 100)`);
  return [...new Set(value.map(v => string(v, label)))];
}
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}
export function parseConfig(value: unknown, baseDir = process.cwd()): BotConfig {
  const data = record(value, 'config');
  const profile = string(data.profile, 'profile');
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('profile must contain only letters, digits, _ and -');
  if (!Array.isArray(data.users) || data.users.length === 0 || data.users.length > 1000) throw new Error('users must be a nonempty explicit allowlist (max 1000)');
  const users = data.users.map((entry): UserPolicy => {
    const user = record(entry, 'user');
    const cwd = string(user.cwd, 'user.cwd');
    if (!isAbsolute(cwd)) throw new Error('user.cwd must be absolute');
    if (user.direct !== undefined && typeof user.direct !== 'boolean') throw new Error('user.direct must be boolean');
    const allowedTools = strings(user.allowedTools ?? [], 'user.allowedTools');
    if (allowedTools.some(t => !/^[a-zA-Z0-9_.:-]+$/.test(t) || t === 'run_code')) throw new Error('allowedTools requires exact tool names; run_code and wildcards are forbidden');
    if (user.directMode !== undefined && user.directMode !== 'harness' && user.directMode !== 'restricted') throw new Error('user.directMode must be harness or restricted');
    return {
      openId: id(user.openId, 'ou', 'user.openId'),
      direct: user.direct === true,
      groupChats: strings(user.groupChats ?? [], 'user.groupChats').map(v => id(v, 'oc', 'group chat')),
      cwd: resolve(cwd), allowedTools, directMode: user.directMode ?? 'restricted',
    };
  });
  if (new Set(users.map(u => u.openId)).size !== users.length) throw new Error('Duplicate user.openId');
  if (data.responseMode !== undefined && data.responseMode !== 'auto' && data.responseMode !== 'text') throw new Error('responseMode must be auto or text');
  if (data.cardInteractions !== undefined && typeof data.cardInteractions !== 'boolean') throw new Error('cardInteractions must be boolean');
  if (data.loadingReaction !== undefined && typeof data.loadingReaction !== 'boolean') throw new Error('loadingReaction must be boolean');
  if (data.botMenu !== undefined && typeof data.botMenu !== 'boolean') throw new Error('botMenu must be boolean');
  if (data.streamingCards !== undefined && typeof data.streamingCards !== 'boolean') throw new Error('streamingCards must be boolean');
  return {
    profile, botOpenId: id(data.botOpenId, 'ou', 'botOpenId'),
    executable: string(data.executable ?? 'lark-cli', 'executable'),
    stateDir: resolve(baseDir, string(data.stateDir ?? '.state', 'stateDir')),
    provider: data.provider === undefined ? undefined : string(data.provider, 'provider'),
    model: data.model === undefined ? undefined : string(data.model, 'model'),
    users,
    // A harness-mode chat does research and tool work, and may wait minutes for an approval.
    turnTimeoutMs: integer(data.turnTimeoutMs, users.some(user => user.directMode === 'harness') ? 900_000 : 120_000, 1000, 1_800_000, 'turnTimeoutMs'),
    idleTimeoutMs: integer(data.idleTimeoutMs, 1_800_000, 1000, 86_400_000, 'idleTimeoutMs'),
    maxSessions: integer(data.maxSessions, 100, 1, 1000, 'maxSessions'),
    maxSessionsPerUser: integer(data.maxSessionsPerUser, 10, 1, 100, 'maxSessionsPerUser'),
    maxPending: integer(data.maxPending, 100, 1, 1000, 'maxPending'),
    maxPendingPerSession: integer(data.maxPendingPerSession, 5, 1, 100, 'maxPendingPerSession'),
    maxInputChars: integer(data.maxInputChars, 16_000, 1, 100_000, 'maxInputChars'),
    maxOutputChars: integer(data.maxOutputChars, 32_000, 100, 64_000, 'maxOutputChars'),
    chunkBytes: integer(data.chunkBytes, 4000, 100, 12_000, 'chunkBytes'),
    responseMode: data.responseMode ?? 'auto',
    cardInteractions: data.cardInteractions === true,
    loadingReaction: data.loadingReaction === true,
    botMenu: data.botMenu === true,
    streamingCards: data.streamingCards === true,
  };
}
export async function loadConfig(path: string): Promise<BotConfig> {
  const absolute = resolve(path);
  return parseConfig(JSON.parse(await readFile(absolute, 'utf8')), dirname(absolute));
}
