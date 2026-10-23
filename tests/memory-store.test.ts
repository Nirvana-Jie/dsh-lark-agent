import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, type MemoryContext } from '../src/memory-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open)};
});

const alice: MemoryContext = {ownerKey: 'bot:alice', conversationKey: 'alice:private', privateChat: true};
const aliceGroup: MemoryContext = {...alice, conversationKey: 'alice:group:one', privateChat: false};
const aliceOtherGroup: MemoryContext = {...aliceGroup, conversationKey: 'alice:group:two'};
const bob: MemoryContext = {ownerKey: 'bot:bob', conversationKey: 'bob:private', privateChat: true};
const directories: string[] = [];
async function temporary() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-memory-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.open).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, {recursive: true, force: true})));
});

describe('personal and conversation memory boundaries', () => {
  it('restores personal and current-chat memories after reopening', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const personal = await store.add(alice, 'personal', '偏好中文回答');
    const chat = await store.add(alice, 'chat', '这次项目使用 Vitest');
    const reopened = await MemoryStore.open(directory);
    expect(await reopened.list(alice)).toEqual([chat, personal]);
    expect(await reopened.list(aliceGroup)).toEqual([]);
  });

  it('keeps personal memories private until explicitly shared by their owner in a private chat', async () => {
    const store = await MemoryStore.open(await temporary());
    const personal = await store.add(alice, 'personal', '喜欢简洁说明');
    expect(await store.list(alice)).toEqual([personal]);
    expect(personal.groupShared).toBe(false);
    expect(await store.list(aliceGroup)).toEqual([]);
    expect(await store.search(aliceOtherGroup, '简洁')).toEqual([]);
    const shared = await store.setGroupShared(alice, personal.id, true);
    expect(shared).toMatchObject({...personal, groupShared: true, updatedAt: expect.any(Number)});
    expect(await store.list(aliceGroup)).toEqual([shared]);
    expect(await store.search(aliceOtherGroup, '简洁')).toEqual([shared]);
    expect(await store.remove(aliceOtherGroup, personal.id)).toBe(false);
    expect(await store.remove(alice, personal.id)).toBe(true);
  });

  it('never lists, searches or removes another user’s personal or chat memory', async () => {
    const store = await MemoryStore.open(await temporary());
    const personal = await store.add(alice, 'personal', 'Alice secret');
    const chat = await store.add(aliceGroup, 'chat', 'Alice project');
    for (const other of [bob, {...bob, conversationKey: aliceGroup.conversationKey, privateChat: false}]) {
      expect(await store.list(other)).toEqual([]);
      expect(await store.search(other, 'Alice')).toEqual([]);
      expect(await store.remove(other, personal.id)).toBe(false);
      expect(await store.remove(other, chat.id)).toBe(false);
    }
    expect(await store.list(aliceGroup)).toEqual([chat]);
  });

  it('scopes chat memories to one exact conversation, including its topic', async () => {
    const store = await MemoryStore.open(await temporary());
    const chat = await store.add(aliceGroup, 'chat', '群内项目计划');
    for (const other of [alice, aliceOtherGroup, {...aliceGroup, conversationKey: 'alice:group:one:topic'}]) {
      expect(await store.list(other)).toEqual([]);
      expect(await store.remove(other, chat.id)).toBe(false);
    }
    expect(await store.list(aliceGroup)).toEqual([chat]);
  });

  it('isolates the same user identity in another bot/application namespace', async () => {
    const store = await MemoryStore.open(await temporary());
    await store.add(alice, 'personal', '本应用专用记忆');
    expect(await store.list({...alice, ownerKey: 'other-bot:alice'})).toEqual([]);
  });

  it('returns detached public records without revealing storage owner keys', async () => {
    const store = await MemoryStore.open(await temporary());
    const added = await store.add(alice, 'personal', 'Original');
    added.text = 'Mutated';
    const listed = await store.list(alice);
    expect(listed[0]?.text).toBe('Original');
    expect(listed[0]).not.toHaveProperty('ownerKey');
    expect(listed[0]).not.toHaveProperty('conversationKey');
    listed[0]!.text = 'Another mutation';
    expect((await store.list(alice))[0]?.text).toBe('Original');
  });

  it('keeps the latest twenty memories visible and searchable after restart, including timestamp ties', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const entries = [];
    for (let index = 0; index < 25; index++) {
      entries.push(await store.add(alice, 'personal', `Preference ${index}`));
    }
    const latestTwenty = entries.slice(5).reverse();
    for (const loaded of [store, await MemoryStore.open(directory)]) {
      expect((await loaded.list(alice)).slice(0, 20)).toEqual(latestTwenty);
      expect(await loaded.list(aliceGroup)).toEqual([]);
      expect(await loaded.search(aliceGroup, 'Preference')).toEqual([]);
      expect(await loaded.list(bob)).toEqual([]);
    }
  });
});

describe('memory input and capacity rules', () => {
  it('normalizes surrounding whitespace, line endings and canonical Unicode', async () => {
    const store = await MemoryStore.open(await temporary());
    const entry = await store.add(alice, 'personal', '  Cafe\u0301\r\n中文  ');
    expect(entry.text).toBe('Café\n中文');
    expect(await store.search(alice, 'CAFÉ')).toEqual([entry]);
    expect(await store.search(alice, '中文')).toEqual([entry]);
  });

  it('counts Unicode code points without splitting emoji', async () => {
    const store = await MemoryStore.open(await temporary());
    expect((await store.add(alice, 'personal', '😀'.repeat(2000))).text).toBe('😀'.repeat(2000));
    await expect(store.add(alice, 'personal', '😀'.repeat(2001))).rejects.toMatchObject({code: 'INVALID_INPUT'});
  });

  it.each([' ', '\n\t', 'has\u0000nul', 'has\u0007bell', '\ud800'])('rejects invalid memory text %j', async (text) => {
    const store = await MemoryStore.open(await temporary());
    await expect(store.add(alice, 'personal', text)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    expect(await store.list(alice)).toEqual([]);
  });

  it('deduplicates normalized identical additions only inside the same owner and scope', async () => {
    const store = await MemoryStore.open(await temporary());
    const personal = await store.add(alice, 'personal', '  Remember this  ');
    expect(await store.add(alice, 'personal', 'Remember this')).toEqual(personal);
    await expect(store.add(aliceGroup, 'personal', 'Remember this')).rejects.toMatchObject({code: 'PRIVATE_ONLY'});
    const chat = await store.add(aliceGroup, 'chat', 'Remember this');
    const otherOwner = await store.add(bob, 'personal', 'Remember this');
    expect(new Set([personal.id, chat.id, otherOwner.id]).size).toBe(3);
  });

  it('enforces per-bucket capacity while allowing idempotent repeats', async () => {
    const store = await MemoryStore.open(await temporary());
    for (let index = 0; index < 100; index++) await store.add(alice, 'personal', `entry ${index}`);
    expect((await store.add(alice, 'personal', 'entry 0')).text).toBe('entry 0');
    await expect(store.add(alice, 'personal', 'entry overflow')).rejects.toMatchObject({code: 'CAPACITY'});
    expect((await store.add(aliceGroup, 'chat', 'another bucket')).text).toBe('another bucket');
  });

  it('rejects malformed context instead of treating it as shared memory', async () => {
    const store = await MemoryStore.open(await temporary());
    await expect(store.list({...alice, ownerKey: ''})).rejects.toMatchObject({code: 'INVALID_INPUT'});
    await expect(store.add({...alice, conversationKey: '\u0000'}, 'personal', 'hello')).rejects.toMatchObject({code: 'INVALID_INPUT'});
  });

  it('bounds the total for one owner across multiple conversation buckets', async () => {
    const directory = await temporary();
    const entries = Array.from({length: 200}, (_, index) => ({
      id: index.toString(16).padStart(12, '0'), ownerKey: alice.ownerKey, scope: 'chat',
      conversationKey: `conversation-${Math.floor(index / 100)}`, text: `item ${index}`, createdAt: 1, updatedAt: 1,
    }));
    await fs.writeFile(join(directory, 'memory.json'), JSON.stringify({version: 1, entries}));
    const store = await MemoryStore.open(directory);
    await expect(store.add(alice, 'personal', 'owner limit')).rejects.toMatchObject({code: 'CAPACITY'});
    expect((await store.add(bob, 'personal', 'another owner')).text).toBe('another owner');
  });
});

describe('explicit group disclosure and revocation', () => {
  it('migrates v1 records as private without losing IDs, text or timestamps', async () => {
    const directory = await temporary();
    const previous = {id: 'abcdefabcdef', ownerKey: alice.ownerKey, scope: 'personal',
      text: 'Legacy private canary', createdAt: 11, updatedAt: 12, groupShared: true};
    const oldChat = {id: '123456abcdef', ownerKey: alice.ownerKey, scope: 'chat',
      conversationKey: aliceGroup.conversationKey, text: 'Group plan', createdAt: 13, updatedAt: 14};
    await fs.writeFile(join(directory, 'memory.json'), JSON.stringify({version: 1, entries: [previous, oldChat]}));
    const store = await MemoryStore.open(directory);
    const initial = await store.groupAccessKey(aliceGroup);
    expect(await store.list(alice)).toEqual([{id: previous.id, scope: 'personal', groupShared: false,
      text: previous.text, createdAt: previous.createdAt, updatedAt: previous.updatedAt}]);
    expect(await store.search(aliceGroup, 'Legacy')).toEqual([]);
    expect(await store.list(aliceGroup)).toEqual([{id: oldChat.id, scope: 'chat', groupShared: false,
      text: oldChat.text, createdAt: oldChat.createdAt, updatedAt: oldChat.updatedAt}]);
    await store.add(alice, 'personal', 'New private fact');
    const document = JSON.parse(await fs.readFile(join(directory, 'memory.json'), 'utf8'));
    expect(document.version).toBe(2);
    expect(document.entries).toHaveLength(3);
    expect(document.entries.every((entry: {groupShared: boolean}) => entry.groupShared === false)).toBe(true);
    const reopened = await MemoryStore.open(directory);
    expect(await reopened.groupAccessKey(aliceGroup)).toBe(initial);
    expect(await reopened.search(alice, 'Legacy')).toHaveLength(1);
    expect(await reopened.search(aliceGroup, 'Legacy')).toEqual([]);
  });

  it('persists owner-specific epochs for sharing and revocation while keeping no-ops stable', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const initial = await store.groupAccessKey(aliceGroup);
    const bobInitial = await store.groupAccessKey(bob);
    const entry = await store.add(alice, 'personal', 'Shareable preference');
    await store.setGroupShared(alice, entry.id, false);
    expect(await store.groupAccessKey(aliceGroup)).toBe(initial);
    const shared = await store.setGroupShared(alice, entry.id, true);
    const sharedKey = await store.groupAccessKey(aliceGroup);
    expect(sharedKey).not.toBe(initial);
    expect(shared?.updatedAt).toBeGreaterThan(entry.updatedAt);
    expect(await store.groupAccessKey(aliceOtherGroup)).toBe(sharedKey);
    expect(await store.setGroupShared(alice, entry.id, true)).toEqual(shared);
    expect(await store.groupAccessKey(aliceGroup)).toBe(sharedKey);
    const reopened = await MemoryStore.open(directory);
    expect(await reopened.groupAccessKey(aliceGroup)).toBe(sharedKey);
    expect(await reopened.list(aliceOtherGroup)).toEqual([shared]);
    const revoked = await reopened.setGroupShared(alice, entry.id, false);
    const revokedKey = await reopened.groupAccessKey(aliceGroup);
    expect(revokedKey).not.toBe(sharedKey);
    expect(await reopened.list(aliceGroup)).toEqual([]);
    expect(await reopened.search(aliceOtherGroup, 'preference')).toEqual([]);
    expect(await reopened.list(alice)).toEqual([revoked]);
    expect(await reopened.groupAccessKey(bob)).toBe(bobInitial);
    const afterRevoke = await MemoryStore.open(directory);
    expect(await afterRevoke.groupAccessKey(aliceGroup)).toBe(revokedKey);
  });

  it('never grants another user access to shared memories or lets groups manage personal entries', async () => {
    const store = await MemoryStore.open(await temporary());
    const entry = await store.add(alice, 'personal', 'Owner-only group fact');
    const chat = await store.add(alice, 'chat', 'Private conversation detail');
    const initial = await store.groupAccessKey(aliceGroup);
    expect(await store.setGroupShared(bob, entry.id, true)).toBeUndefined();
    expect(await store.setGroupShared(alice, chat.id, true)).toBeUndefined();
    expect(await store.setGroupShared(alice, '000000000000', true)).toBeUndefined();
    expect(await store.groupAccessKey(aliceGroup)).toBe(initial);
    for (const shared of [true, false]) {
      await expect(store.setGroupShared(aliceGroup, entry.id, shared)).rejects.toMatchObject({code: 'PRIVATE_ONLY'});
      await expect(store.setGroupShared(aliceGroup, '000000000000', shared)).rejects.toMatchObject({code: 'PRIVATE_ONLY'});
    }
    await store.setGroupShared(alice, entry.id, true);
    expect(await store.list(bob)).toEqual([]);
    expect(await store.list({...bob, conversationKey: aliceGroup.conversationKey, privateChat: false})).toEqual([]);
    expect(await store.search(bob, 'Owner-only')).toEqual([]);
    expect(await store.setGroupShared(bob, entry.id, false)).toBeUndefined();
    expect(await store.remove(bob, entry.id)).toBe(false);
    expect(await store.remove(aliceGroup, entry.id)).toBe(false);
    expect((await store.list(aliceGroup))[0]?.groupShared).toBe(true);
  });

  it('denies personal additions in groups before duplicate lookup for private and shared entries', async () => {
    const store = await MemoryStore.open(await temporary());
    const entry = await store.add(alice, 'personal', 'Exact private text');
    for (const shared of [false, true]) {
      await store.setGroupShared(alice, entry.id, shared);
      for (const text of [entry.text, 'Unknown private text']) {
        await expect(store.add(aliceGroup, 'personal', text)).rejects.toMatchObject({code: 'PRIVATE_ONLY'});
      }
      expect(await store.list(alice)).toHaveLength(1);
    }
    const chat = await store.add(aliceGroup, 'chat', 'This group only');
    expect(chat.groupShared).toBe(false);
    expect(await store.remove(aliceGroup, chat.id)).toBe(true);
  });

  it('rotates the epoch on shared deletion and retains it after the owner has no records', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const initial = await store.groupAccessKey(aliceGroup);
    const unshared = await store.add(alice, 'personal', 'Unshared');
    expect(await store.remove(alice, unshared.id)).toBe(true);
    expect(await store.groupAccessKey(aliceGroup)).toBe(initial);
    const shared = await store.add(alice, 'personal', 'Shared');
    await store.setGroupShared(alice, shared.id, true);
    const beforeDelete = await store.groupAccessKey(aliceGroup);
    expect(await store.remove(alice, shared.id)).toBe(true);
    const afterDelete = await store.groupAccessKey(aliceGroup);
    expect(afterDelete).not.toBe(beforeDelete);
    expect(afterDelete).not.toBe(initial);
    expect(await store.remove(alice, shared.id)).toBe(false);
    expect(await store.groupAccessKey(aliceGroup)).toBe(afterDelete);
    const reopened = await MemoryStore.open(directory);
    expect(await reopened.groupAccessKey(aliceGroup)).toBe(afterDelete);
    expect(await reopened.list(alice)).toEqual([]);
  });

  it('keeps revocation behind an active guarded send and rejects every later stale send', async () => {
    const store = await MemoryStore.open(await temporary());
    const entry = await store.add(alice, 'personal', 'Previously shared');
    await store.setGroupShared(alice, entry.id, true);
    const key = await store.groupAccessKey(aliceGroup);
    let finishSend!: () => void;
    const waiting = new Promise<void>(resolve => { finishSend = resolve; });
    const order: string[] = [];
    const send = store.withGroupAccess(aliceGroup, key, async () => {
      order.push('send-start');
      await waiting;
      order.push('send-end');
    });
    const revoke = store.setGroupShared(alice, entry.id, false).then(() => { order.push('revoked'); });
    try { await vi.waitFor(() => expect(order).toEqual(['send-start'])); }
    finally { finishSend(); }
    expect(await send).toBe(true);
    await revoke;
    expect(order).toEqual(['send-start', 'send-end', 'revoked']);
    const staleSend = vi.fn(async () => undefined);
    expect(await store.withGroupAccess(aliceGroup, key, staleSend)).toBe(false);
    expect(staleSend).not.toHaveBeenCalled();
    const freshSend = vi.fn(async () => undefined);
    expect(await store.withGroupAccess(aliceGroup, await store.groupAccessKey(aliceGroup), freshSend)).toBe(true);
    expect(freshSend).toHaveBeenCalledOnce();
  });

  it('releases the disclosure queue when a send fails without allowing stale access afterward', async () => {
    const store = await MemoryStore.open(await temporary());
    const entry = await store.add(alice, 'personal', 'Shareable');
    await store.setGroupShared(alice, entry.id, true);
    const key = await store.groupAccessKey(aliceGroup);
    await expect(store.withGroupAccess(aliceGroup, key, async () => { throw new Error('Delivery failed'); })).rejects.toThrow('Delivery failed');
    await store.setGroupShared(alice, entry.id, false);
    expect(await store.withGroupAccess(aliceGroup, key, async () => { throw new Error('Must not run'); })).toBe(false);
  });

  it('keeps the disclosure flag and epoch unchanged if the atomic update fails', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const entry = await store.add(alice, 'personal', 'Private canary');
    const key = await store.groupAccessKey(aliceGroup);
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('write failed'), {code: 'EIO'}));
    await expect(store.setGroupShared(alice, entry.id, true)).rejects.toMatchObject({code: 'WRITE_FAILED'});
    expect(await store.groupAccessKey(aliceGroup)).toBe(key);
    expect(await store.list(aliceGroup)).toEqual([]);
    const reopened = await MemoryStore.open(directory);
    expect(await reopened.groupAccessKey(aliceGroup)).toBe(key);
    expect(await reopened.list(alice)).toEqual([entry]);
  });
});

describe('atomic memory persistence', () => {
  it('orders concurrent changes and reads without losing distinct writes', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const writes = Array.from({length: 12}, (_, index) => store.add(alice, 'personal', `concurrent ${index}`));
    const read = store.list(alice);
    const entries = await Promise.all(writes);
    expect(await read).toEqual([...entries].reverse());
    expect(await (await MemoryStore.open(directory)).list(alice)).toEqual([...entries].reverse());
  });

  it('deduplicates concurrent identical writes', async () => {
    const store = await MemoryStore.open(await temporary());
    const entries = await Promise.all([store.add(alice, 'personal', 'same'), store.add(alice, 'personal', 'same')]);
    expect(entries[0]).toEqual(entries[1]);
    expect(await store.list(alice)).toHaveLength(1);
  });

  it('persists deletion across a restart', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const entry = await store.add(alice, 'personal', 'temporary');
    expect(await store.remove(alice, entry.id)).toBe(true);
    expect(await store.remove(alice, entry.id)).toBe(false);
    expect(await (await MemoryStore.open(directory)).list(alice)).toEqual([]);
  });

  it('keeps the previous snapshot and cleans temporary files when rename fails', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const first = await store.add(alice, 'personal', 'saved');
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('private diagnostic'), {code: 'EIO'}));
    await expect(store.add(alice, 'personal', 'not committed')).rejects.toMatchObject({code: 'WRITE_FAILED'});
    expect(await store.list(alice)).toEqual([first]);
    expect(await (await MemoryStore.open(directory)).list(alice)).toEqual([first]);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await store.add(alice, 'personal', 'next succeeds');
    expect(await store.list(alice)).toHaveLength(2);
  });

  it('fails closed after a post-rename durability failure until reopened', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (args[0] === directory) throw Object.assign(new Error('directory sync failed'), {code: 'EIO'});
      return actual.open(...args);
    });
    await expect(store.add(alice, 'personal', 'possibly committed')).rejects.toMatchObject({code: 'WRITE_FAILED'});
    await expect(store.list(alice)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.groupAccessKey(aliceGroup)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    const disclosure = vi.fn(async () => undefined);
    await expect(store.withGroupAccess(aliceGroup, 'private-memory-v2', disclosure)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    expect(disclosure).not.toHaveBeenCalled();
    await expect(store.add(alice, 'personal', 'must not overwrite')).rejects.toMatchObject({code: 'UNAVAILABLE'});
    vi.mocked(fs.open).mockImplementation(actual.open);
    expect((await (await MemoryStore.open(directory)).list(alice))[0]?.text).toBe('possibly committed');
  });

  it('uses private directory and file modes', async () => {
    const directory = await temporary();
    const store = await MemoryStore.open(directory);
    await store.add(alice, 'personal', 'mode check');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, 'memory.json'))).mode & 0o777).toBe(0o600);
  });

  it.each([
    'not JSON',
    JSON.stringify({version: 2, entries: []}),
    JSON.stringify({version: 1, entries: [{id: 'bad'}]}),
    JSON.stringify({version: 1, entries: [{id: 'abcdefabcdef', ownerKey: 'bot:alice', scope: 'chat', text: 'missing conversation', createdAt: 1, updatedAt: 1}]}),
  ])('never silently replaces corrupt state: %s', async (contents) => {
    const directory = await temporary();
    await fs.writeFile(join(directory, 'memory.json'), contents);
    await expect(MemoryStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
    expect(await fs.readFile(join(directory, 'memory.json'), 'utf8')).toBe(contents);
  });

  it('rejects memory files linked outside the state directory', async () => {
    const directory = await temporary();
    const target = join(await temporary(), 'external.json');
    await fs.writeFile(target, JSON.stringify({version: 1, entries: []}));
    await fs.symlink(target, join(directory, 'memory.json'));
    await expect(MemoryStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
  });

  it.each(['missing consent', 'shared without epoch', 'chat sharing', 'duplicate epochs', 'invalid epoch'] as const)(
    'rejects corrupt v2 group authorization: %s', async kind => {
      const directory = await temporary();
      const entry: Record<string, unknown> = {id: 'abcdefabcdef', ownerKey: alice.ownerKey, scope: 'personal',
        groupShared: false, text: 'Private canary', createdAt: 1, updatedAt: 1};
      const epochs = [{ownerKey: alice.ownerKey, epoch: '12345678-1234-1234-1234-123456789abc'}];
      if (kind === 'missing consent') delete entry.groupShared;
      if (kind === 'shared without epoch') { entry.groupShared = true; epochs.length = 0; }
      if (kind === 'chat sharing') { entry.scope = 'chat'; entry.conversationKey = aliceGroup.conversationKey; entry.groupShared = true; }
      if (kind === 'duplicate epochs') epochs.push({...epochs[0]!});
      if (kind === 'invalid epoch') epochs[0]!.epoch = 'not-a-valid-epoch';
      const contents = JSON.stringify({version: 2, entries: [entry], groupEpochs: epochs});
      await fs.writeFile(join(directory, 'memory.json'), contents);
      await expect(MemoryStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
      expect(await fs.readFile(join(directory, 'memory.json'), 'utf8')).toBe(contents);
    });
});
