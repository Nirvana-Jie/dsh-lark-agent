import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {TopicStore, topicLink, type TopicBinding} from '../src/topic-store.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open)};
});
const directories: string[] = [];
const binding: TopicBinding = {ownerKey: 'a'.repeat(64), chatKey: 'c'.repeat(64), laneKey: 'd'.repeat(64),
  conversationKey: 'e'.repeat(64), threadId: 'omt_first', messageId: 'om_anchor'};
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-topics-')); directories.push(directory);
  return {directory, store: await TopicStore.open(directory)};
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, {recursive: true, force: true})));
});

describe('native topic bindings', () => {
  it('publishes private durable bindings and adds the checkpointed session once', async () => {
    const {directory, store} = await fixture();
    await store.record(binding);
    const saved = {...binding, sessionId: '123456abcdef'};
    await store.record(saved);
    expect(await store.get(binding, binding.threadId)).toEqual(saved);
    expect(await (await TopicStore.open(directory)).list(binding)).toEqual([saved]);
    vi.mocked(fs.rename).mockClear();
    await store.record(saved);
    expect(fs.rename).not.toHaveBeenCalled();
    expect((await fs.stat(join(directory, 'topics.json'))).mode & 0o777).toBe(0o600);
    await expect(store.record({...saved, sessionId: 'abcdef123456'})).rejects.toMatchObject({code: 'CONFLICT'});
    await expect(store.record({...saved, threadId: 'omt_duplicate', laneKey: 'f'.repeat(64)})).rejects.toMatchObject({code: 'CONFLICT'});
  });

  it('isolates owners and chats and prevents another owner from adopting a native topic', async () => {
    const {store} = await fixture();
    await store.record(binding);
    expect(await store.list({...binding, ownerKey: 'b'.repeat(64)})).toEqual([]);
    expect(await store.list({...binding, chatKey: 'b'.repeat(64)})).toEqual([]);
    expect(await store.occupied(binding.chatKey, binding.threadId)).toBe(true);
    await expect(store.record({...binding, ownerKey: 'b'.repeat(64)})).rejects.toMatchObject({code: 'CONFLICT'});
    await expect(store.record({...binding, groupAccessKey: 'changed-epoch'})).rejects.toMatchObject({code: 'CONFLICT'});
  });

  it('rejects malformed or duplicate persisted bindings and symbolic links', async () => {
    const {directory} = await fixture();
    const path = join(directory, 'topics.json');
    for (const topics of [[{...binding, laneKey: 'bad'}], [binding, binding], [{...binding, link: 'https://evil.example/'}]]) {
      await fs.writeFile(path, JSON.stringify({version: 1, topics}));
      await expect(TopicStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
    }
    await fs.unlink(path);
    await fs.symlink(join(directory, 'missing.json'), path);
    // A dangling symlink must not be treated as an absent state file.
    await expect(TopicStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
  });

  it('fails closed when publication is uncertain, even if rename actually succeeded', async () => {
    const {directory, store} = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {await actual.rename(from, to); throw new Error('lost confirmation');});
    await expect(store.record(binding)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.list(binding)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.record(binding)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    expect(await (await TopicStore.open(directory)).get(binding, binding.threadId)).toEqual(binding);
  });

  it('serializes a caller snapshot and keeps the confirmed anchor stable', async () => {
    const {store} = await fixture();
    const input = {...binding};
    const pending = store.record(input); input.ownerKey = 'b'.repeat(64);
    await pending;
    await store.record({...binding, messageId: 'om_later', sessionId: '123456abcdef'});
    expect(await store.get(binding, binding.threadId)).toMatchObject({messageId: 'om_anchor', sessionId: '123456abcdef'});
  });

  it('rejects a write that would make its own directory unreadable without damaging existing topics', async () => {
    const {directory} = await fixture();
    const prefix = 'https://applink.feishu.cn/client/thread/open?token=';
    const link = prefix + 'x'.repeat(4096 - prefix.length);
    const topics: TopicBinding[] = [];
    const key = (value: string) => createHash('sha256').update(value).digest('hex');
    const limit = 8 * 1024 * 1024;
    let bytes = Buffer.byteLength(JSON.stringify({version: 1, topics})) + 1;
    let next: TopicBinding;
    for (let i = 0; ; i++) {
      next = {...binding, ownerKey: key(`owner-${Math.floor(i / 1000)}`), laneKey: key(`lane-${i}`),
        conversationKey: key(`context-${i}`), threadId: `omt_${i}`, link};
      const addition = Buffer.byteLength(JSON.stringify(next)) + (topics.length ? 1 : 0);
      if (bytes + addition > limit) break;
      topics.push(next); bytes += addition;
    }
    const file = join(directory, 'topics.json');
    const before = JSON.stringify({version: 1, topics}) + '\n';
    await fs.writeFile(file, before);
    const store = await TopicStore.open(directory);
    await expect(store.record(next!)).rejects.toMatchObject({code: 'CAPACITY'});
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await store.get(topics[0]!, topics[0]!.threadId)).toEqual(topics[0]);
  });

  it('accepts only official read-enriched topic/message links', () => {
    expect(topicLink('https://applink.feishu.cn/client/thread/open?threadId=omt_example')).toBeDefined();
    expect(topicLink('https://applink.larksuite.com/client/chat/open?openChatId=oc_example&position=1')).toBeDefined();
    for (const value of ['javascript:alert(1)', 'https://applink.feishu.cn.evil.example/client/thread/open',
      'https://user@applink.feishu.cn/client/thread/open', 'https://applink.feishu.cn/client/message/open?messageId=om_example']) expect(topicLink(value)).toBeUndefined();
  });
});
