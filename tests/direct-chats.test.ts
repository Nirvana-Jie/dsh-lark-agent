import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DirectChatsStore} from '../src/direct-chats.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open)};
});
const directories: string[] = [];
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-direct-chats-')); directories.push(directory);
  return {directory, store: await DirectChatsStore.open(directory)};
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, {recursive: true, force: true})));
});

describe('trusted private chat address book', () => {
  it('keeps independent per-user addresses across reopen with private permissions', async () => {
    const {directory, store} = await fixture();
    expect(await store.get('ou_unknown')).toBeUndefined();
    await Promise.all([store.record('ou_alice', 'oc_alice'), store.record('ou_bob', 'oc_bob')]);
    const reopened = await DirectChatsStore.open(directory);
    expect(await reopened.get('ou_alice')).toBe('oc_alice');
    expect(await reopened.get('ou_bob')).toBe('oc_bob');
    expect(await reopened.get('ou_unknown')).toBeUndefined();
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, 'direct-chats.json'))).mode & 0o777).toBe(0o600);
  });

  it('serializes trusted updates and does not rewrite an unchanged address', async () => {
    const {directory, store} = await fixture();
    await Promise.all([store.record('ou_alice', 'oc_old'), store.record('ou_alice', 'oc_latest')]);
    expect(await store.get('ou_alice')).toBe('oc_latest');
    vi.mocked(fs.rename).mockClear();
    await store.record('ou_alice', 'oc_latest');
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await DirectChatsStore.open(directory).then(store => store.get('ou_alice'))).toBe('oc_latest');
  });

  it('never aliases another user to an existing private conversation', async () => {
    const {store} = await fixture();
    await store.record('ou_alice', 'oc_private');
    await expect(store.record('ou_bob', 'oc_private')).rejects.toMatchObject({code: 'CONFLICT'});
    expect(await store.get('ou_bob')).toBeUndefined();
    expect(await store.get('ou_alice')).toBe('oc_private');
  });

  it.each(['', 'on_union', 'ou_bad/id', 'ou_bad\n', `ou_${'x'.repeat(129)}`])('rejects invalid owner identifiers: %j', async owner => {
    const {store} = await fixture();
    await expect(store.record(owner, 'oc_private')).rejects.toMatchObject({code: 'INVALID_INPUT'});
    await expect(store.get(owner)).rejects.toMatchObject({code: 'INVALID_INPUT'});
  });

  it.each(['', 'om_message', 'oc_bad/id', 'oc_bad\n', `oc_${'x'.repeat(129)}`])('rejects invalid private chat identifiers: %j', async chat => {
    const {store} = await fixture();
    await expect(store.record('ou_alice', chat)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    expect(await store.get('ou_alice')).toBeUndefined();
  });

  it('rejects capacity pressure without evicting another user and allows an existing user update', async () => {
    const {directory} = await fixture();
    const entries = Array.from({length: 1000}, (_, index) => ({openId: `ou_${index}`, chatId: `oc_${index}`}));
    await fs.writeFile(join(directory, 'direct-chats.json'), JSON.stringify({version: 1, entries}));
    const store = await DirectChatsStore.open(directory);
    await expect(store.record('ou_overflow', 'oc_overflow')).rejects.toMatchObject({code: 'CAPACITY'});
    await store.record('ou_0', 'oc_changed');
    expect(await store.get('ou_0')).toBe('oc_changed');
    expect(await store.get('ou_999')).toBe('oc_999');
  });

  it.each([
    '{broken', '{"version":2,"entries":[]}', '{"version":1,"entries":{}}',
    JSON.stringify({version: 1, entries: [{openId: 'ou_alice', chatId: 'oc_a'}, {openId: 'ou_alice', chatId: 'oc_b'}]}),
    JSON.stringify({version: 1, entries: [{openId: 'ou_alice', chatId: 'oc_a'}, {openId: 'ou_bob', chatId: 'oc_a'}]}),
    JSON.stringify({version: 1, entries: [{openId: 'ou_alice', chatId: '../chat'}]}),
    JSON.stringify({version: 1, entries: [], secret: 'unexpected'}),
  ])('does not reset corrupt state: %s', async contents => {
    const {directory} = await fixture();
    await fs.writeFile(join(directory, 'direct-chats.json'), contents);
    await expect(DirectChatsStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
    expect(await fs.readFile(join(directory, 'direct-chats.json'), 'utf8')).toBe(contents);
  });

  it('rejects oversized files and symlinks before reading another location', async () => {
    const {directory} = await fixture(); const file = join(directory, 'direct-chats.json');
    await fs.writeFile(file, 'x'.repeat(512_001));
    await expect(DirectChatsStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
    const target = join(directory, 'other.json');
    await fs.writeFile(target, '{"version":1,"entries":[]}');
    await fs.unlink(file); await fs.symlink(target, file);
    await expect(DirectChatsStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
  });

  it('leaves committed state readable after a failure before rename and permits deliberate retry', async () => {
    const {directory, store} = await fixture(); await store.record('ou_alice', 'oc_old');
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('sensitive diagnostic'));
    await expect(store.record('ou_alice', 'oc_new')).rejects.toMatchObject({code: 'WRITE_FAILED'});
    expect(await store.get('ou_alice')).toBe('oc_old');
    expect(await DirectChatsStore.open(directory).then(store => store.get('ou_alice'))).toBe('oc_old');
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await store.record('ou_alice', 'oc_new');
    expect(await store.get('ou_alice')).toBe('oc_new');
  });

  it('poisons reads and writes after a post-rename durability failure until explicitly reopened', async () => {
    const {directory, store} = await fixture(); await store.record('ou_alice', 'oc_old');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(actual.open).mockRejectedValueOnce(new Error('directory sync failed'));
    await expect(store.record('ou_alice', 'oc_new')).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.get('ou_alice')).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.record('ou_bob', 'oc_bob')).rejects.toMatchObject({code: 'UNAVAILABLE'});
    expect(await DirectChatsStore.open(directory).then(store => store.get('ou_alice'))).toBe('oc_new');
  });
});
