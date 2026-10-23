import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardActions, type ActionBinding } from '../src/card-actions.js';

const directories: string[] = [];
const namespace = JSON.stringify(['team-bot', 'ou_bot']);
const sample: ActionBinding = {
  ownerId: 'ou_alice', chatId: 'oc_team', chatType: 'group', threadId: 'omt_topic',
  sourceMessageId: 'om_source', command: '/status',
};
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-card-actions-'));
  directories.push(path);
  return path;
}
async function signed(directory: string, document: unknown): Promise<string> {
  const serialized = JSON.stringify(document);
  const signature = createHmac('sha256', await readFile(join(directory, 'card-actions.key'))).update(serialized).digest('base64url');
  return `${Buffer.from(serialized).toString('base64url')}.${signature}`;
}
function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('signed card actions', () => {
  it('accepts the same underscore and hyphen IDs as message routing', async () => {
    const actions = await CardActions.open(await temporary(), namespace);
    const bound = {...sample, ownerId: 'ou_alice_1', chatId: 'oc_team-1', threadId: 'omt_topic_1', sourceMessageId: 'om_source-1'};
    expect(actions.verify(actions.issue(bound))).toMatchObject(bound);
  });
  it('binds the exact user, chat, thread, message, command and current session', async () => {
    const actions = await CardActions.open(await temporary(), namespace);
    const bound = {...sample, command: '/resume 012345abcdef', expectedSessionId: 'abcdef012345'};
    const token = actions.issue(bound);
    expect(token.length).toBeLessThanOrEqual(3000);
    expect(actions.verify(token)).toMatchObject(bound);
    expect(actions.verify(token)?.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(actions.verify(token)?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('uses one durable key across reopen and preserves undefined versus null session preconditions', async () => {
    const directory = await temporary();
    const actions = await CardActions.open(directory, namespace);
    const noSession = actions.issue({...sample, expectedSessionId: null});
    const unbound = actions.issue(sample);
    const originalKey = await readFile(join(directory, 'card-actions.key'));
    const reopened = await CardActions.open(directory, namespace);
    expect(reopened.verify(noSession)?.expectedSessionId).toBeNull();
    expect(reopened.verify(unbound)).not.toHaveProperty('expectedSessionId');
    expect(await readFile(join(directory, 'card-actions.key'))).toEqual(originalKey);
  });

  it('issues unique nonces and copies binding values rather than retaining mutable input', async () => {
    const actions = await CardActions.open(await temporary(), namespace);
    const input = {...sample};
    const first = actions.issue(input);
    input.ownerId = 'ou_bob';
    const second = actions.issue(sample);
    expect(actions.verify(first)?.ownerId).toBe('ou_alice');
    expect(actions.verify(first)?.nonce).not.toBe(actions.verify(second)?.nonce);
    const verified = actions.verify(first)!;
    verified.command = '/new';
    expect(actions.verify(first)?.command).toBe('/status');
  });

  it('rejects payload and signature tampering, malformed encoding and oversized tokens', async () => {
    const actions = await CardActions.open(await temporary(), namespace);
    const token = actions.issue(sample);
    const [data, signature] = token.split('.');
    const changed = decode(token);
    changed.binding = {...sample, ownerId: 'ou_bob'};
    const tampered = `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`;
    for (const invalid of [tampered, `${data}.${'A'.repeat(43)}`, `${data}=.${signature}`, token + '.', '', 'x'.repeat(3001)]) {
      expect(actions.verify(invalid)).toBeUndefined();
    }
  });

  it('rejects another bot namespace or another signing key', async () => {
    const directory = await temporary();
    const actions = await CardActions.open(directory, namespace);
    const token = actions.issue(sample);
    expect((await CardActions.open(directory, JSON.stringify(['other-bot', 'ou_bot']))).verify(token)).toBeUndefined();
    expect((await CardActions.open(await temporary(), namespace)).verify(token)).toBeUndefined();
  });

  it('expires after exactly 24 hours and rejects future-issued actions', async () => {
    const actions = await CardActions.open(await temporary(), namespace);
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const token = actions.issue(sample);
    clock.mockReturnValue(now - 1);
    expect(actions.verify(token)).toBeUndefined();
    clock.mockReturnValue(now + 24 * 60 * 60 * 1000 - 1);
    expect(actions.verify(token)).toBeDefined();
    clock.mockReturnValue(now + 24 * 60 * 60 * 1000);
    expect(actions.verify(token)).toBeUndefined();
  });

  it.each(['/help', '/status', '/sessions', '/memory', '/memory global', '/memory chat', '/memory show 012345abcdef', '/new', '/resume 012345abcdef', '/forget 012345abcdef',
    '/approve 012345abcdef', '/deny 012345abcdef', '/reply 012345abcdef', '/choose 012345abcdef 0', '/choose 012345abcdef 12'])('accepts only supported command %s', async command => {
    const actions = await CardActions.open(await temporary(), namespace);
    expect(actions.verify(actions.issue({...sample, command}))?.command).toBe(command);
  });

  it.each(['/bash rm', '/remember secret', '/stop', '/memory search name', '/memory show OTHER', '/resume ../bad', '/new\n', '/status\n/new', '/help ', ' /help', '/help\t',
    '/approve 012345abcdeg', '/approve', '/choose 012345abcdef', '/choose 012345abcdef 123', '/reply 012345abcdef 1'])('rejects unsupported command %j at issuance', async command => {
    const actions = await CardActions.open(await temporary(), namespace);
    expect(() => actions.issue({...sample, command})).toThrow('Invalid card action binding');
  });

  it.each([
    {ownerId: 'oc_wrong'}, {chatId: 'ou_wrong'}, {chatType: 'private'}, {threadId: 'bad'},
    {sourceMessageId: 'oc_chat'}, {ownerId: 'ou_alice\n'}, {expectedSessionId: 'invalid'},
    {expectedSessionId: 7}, {expectedSessionId: '012345abcdef\n'}, {extra: 'untrusted'},
  ])('rejects invalid binding fields %j', async invalid => {
    const actions = await CardActions.open(await temporary(), namespace);
    expect(() => actions.issue({...sample, ...invalid} as ActionBinding)).toThrow('Invalid card action binding');
  });

  it('accepts an ordinary private chat without a thread', async () => {
    const actions = await CardActions.open(await temporary(), namespace);
    const bound = {...sample, chatType: 'p2p' as const, threadId: ''};
    expect(actions.verify(actions.issue(bound))).toMatchObject(bound);
  });

  it('rejects validly signed malformed schemas, unknown commands, missing fields and extended validity', async () => {
    const directory = await temporary();
    const actions = await CardActions.open(directory, namespace);
    const document = decode(actions.issue(sample));
    const malformed = [
      {...document, version: 2}, {...document, extra: true}, {...document, nonce: 'short'},
      {...document, binding: {...sample, extra: 'owner override'}},
      {...document, binding: {...sample, command: '/shell'}},
      {...document, binding: {...sample, ownerId: undefined}},
      {...document, expiresAt: Number(document.expiresAt) + 1},
      {...document, issuedAt: 'now'}, {...document, binding: []},
    ];
    for (const invalid of malformed) expect(actions.verify(await signed(directory, invalid))).toBeUndefined();
  });
});

describe('card action key storage', () => {
  it('creates a 32-byte key and tightens existing directory and file permissions', async () => {
    const directory = await temporary();
    await chmod(directory, 0o755);
    await CardActions.open(directory, namespace);
    const key = join(directory, 'card-actions.key');
    expect((await readFile(key)).length).toBe(32);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(key)).mode & 0o777).toBe(0o600);
    await chmod(key, 0o644);
    await CardActions.open(directory, namespace);
    expect((await lstat(key)).mode & 0o777).toBe(0o600);
  });

  it.each([0, 31, 33, 65])('does not replace a corrupt %i-byte key', async length => {
    const directory = await temporary();
    const key = join(directory, 'card-actions.key');
    const existing = Buffer.alloc(length, 7);
    await writeFile(key, existing, {mode: 0o600});
    await expect(CardActions.open(directory, namespace)).rejects.toThrow('could not be opened safely');
    expect(await readFile(key)).toEqual(existing);
  });

  it('rejects a signing-key symlink without changing its target', async () => {
    const directory = await temporary();
    const target = join(directory, 'other-key');
    const bytes = Buffer.alloc(32, 17);
    await writeFile(target, bytes, {mode: 0o644});
    await symlink(target, join(directory, 'card-actions.key'));
    await expect(CardActions.open(directory, namespace)).rejects.toThrow('could not be opened safely');
    expect(await readFile(target)).toEqual(bytes);
    expect((await lstat(target)).mode & 0o777).toBe(0o644);
  });

  it('rejects a symlink state directory', async () => {
    const parent = await temporary();
    const target = await temporary();
    const link = join(parent, 'linked-state');
    await symlink(target, link);
    await expect(CardActions.open(link, namespace)).rejects.toThrow('could not be opened safely');
    await expect(lstat(join(target, 'card-actions.key'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['', '  ', 'bad\nnamespace', 'x'.repeat(513)])('rejects invalid namespace %j before changing storage', async invalid => {
    const directory = await temporary();
    await expect(CardActions.open(directory, invalid)).rejects.toThrow('Invalid card action namespace');
    await expect(lstat(join(directory, 'card-actions.key'))).rejects.toMatchObject({code: 'ENOENT'});
  });
});
