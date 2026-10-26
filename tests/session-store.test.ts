import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore, SessionStoreError, type SessionContext } from '../src/session-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open)};
});

const directories: string[] = [];
const alice: SessionContext = {ownerKey: 'alice', conversationKey: 'private-main'};
const bob: SessionContext = {ownerKey: 'bob', conversationKey: 'private-main'};
const group: SessionContext = {ownerKey: 'alice', conversationKey: 'group-one'};
const thread: SessionContext = {ownerKey: 'alice', conversationKey: 'group-one-thread-two'};

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-session-store-'));
  directories.push(directory);
  return {directory, store: await SessionStore.open(directory)};
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, {recursive: true, force: true})));
});

describe('persistent session catalog', () => {
  it('selects a historical session for a topic without moving the catalog active selection', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID(), '旧话题');
    const current = await store.add(alice, randomUUID(), '另一个话题');
    const selected = {...alice, sessionId: old.id};
    expect(await store.current(selected)).toEqual(old);
    await store.rename(selected, '话题独立命名');
    await store.archive(selected);
    expect(await store.current(alice)).toEqual(current);
    await expect((await SessionStore.open(directory)).current(selected)).resolves.toMatchObject({id: old.id, title: '话题独立命名'});
    await expect(store.current({...bob, sessionId: old.id})).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(store.current({...alice, sessionId: '000000000000'})).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(store.add(selected, randomUUID())).rejects.toMatchObject({code: 'INVALID_INPUT'});
  });

  it('keeps the active native session across restart with private file permissions', async () => {
    const {directory, store} = await fixture();
    const session = await store.add(alice, randomUUID(), '项目讨论');
    expect(session.id).toMatch(/^[0-9a-f]{12}$/);
    expect(session.createdAt).toBe(session.updatedAt);
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual(session);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, 'sessions.json'))).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent adds without losing history or the last active selection', async () => {
    const {directory, store} = await fixture();
    const sessions = await Promise.all(Array.from({length: 12}, (_, index) => store.add(alice, randomUUID(), `会话 ${index}`)));
    expect(new Set(sessions.map(session => session.id)).size).toBe(12);
    expect(await store.list(alice)).toEqual([...sessions].reverse());
    expect(await store.current(alice)).toEqual(sessions.at(-1));
    const reopened = await SessionStore.open(directory);
    expect(await reopened.list(alice)).toEqual([...sessions].reverse());
    expect(await reopened.current(alice)).toEqual(sessions.at(-1));
  });

  it('archives without deleting history and restores an older conversation selection', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID(), '旧会话');
    await store.archive(alice);
    expect(await store.current(alice)).toBeUndefined();
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toBeUndefined();
    const recent = await store.add(alice, randomUUID());
    expect(recent.title).toBe('新会话');
    expect(await store.list(alice)).toHaveLength(2);
    const resumed = await store.activate(alice, old.id);
    expect(resumed.nativeId).toBe(old.nativeId);
    expect((await store.list(alice))[0]?.id).toBe(old.id);
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual(resumed);
  });

  it('isolates lists and active sessions by both owner and exact conversation', async () => {
    const {store} = await fixture();
    const a = await store.add(alice, randomUUID(), 'Alice 私聊秘密');
    const b = await store.add(bob, randomUUID(), 'Bob 私聊秘密');
    const g = await store.add(group, randomUUID(), 'Alice 群会话');
    const t = await store.add(thread, randomUUID(), 'Alice 话题');
    for (const [context, expected] of [[alice, a], [bob, b], [group, g], [thread, t]] as const) {
      expect(await store.list(context)).toEqual([expected]);
      expect(await store.current(context)).toEqual(expected);
    }
    expect(await store.list({ownerKey: 'nobody', conversationKey: 'private-main'})).toEqual([]);
  });

  it('rejects cross-user and cross-conversation activation and touch without disclosing existence', async () => {
    const {store} = await fixture();
    const session = await store.add(alice, randomUUID(), 'private');
    for (const context of [bob, group, thread]) {
      await expect(store.activate(context, session.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
      await expect(store.touch(context, session.id)).rejects.toMatchObject({code: 'NOT_FOUND'});
      await expect(store.activate(context, '000000000000')).rejects.toMatchObject({message: '未找到当前聊天中属于你的这条会话。'});
    }
    expect(await store.current(alice)).toEqual(session);
  });

  it('renames only the current owned session and retains that title after restart', async () => {
    const {directory, store} = await fixture();
    const session = await store.add(alice, randomUUID());
    const renamed = await store.rename(alice, '  研发计划 📚  ');
    expect(renamed.id).toBe(session.id);
    expect(renamed.title).toBe('研发计划 📚');
    expect(renamed.updatedAt).toBeGreaterThan(session.updatedAt);
    await expect(store.rename(bob, '改名')).rejects.toMatchObject({code: 'NO_CURRENT'});
    await expect(store.rename(group, '改名')).rejects.toMatchObject({code: 'NO_CURRENT'});
    expect((await SessionStore.open(directory).then(reopened => reopened.current(alice)))?.title).toBe('研发计划 📚');
  });

  it('counts title limits in code points and refuses control characters', async () => {
    const {store} = await fixture();
    const session = await store.add(alice, randomUUID(), '📚'.repeat(80));
    expect(Array.from(session.title)).toHaveLength(80);
    for (const title of ['', '   ', 'a'.repeat(81), 'a\nb', 'a\0b', '\u202ehidden']) {
      await expect(store.rename(alice, title)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    }
    expect(await store.current(alice)).toEqual(session);
  });

  it('requires a native UUID and never aliases native history across owners', async () => {
    const {store} = await fixture();
    await expect(store.add(alice, '../native-history')).rejects.toMatchObject({code: 'INVALID_INPUT'});
    const nativeId = randomUUID();
    const session = await store.add(alice, nativeId);
    await expect(store.add(bob, nativeId.toUpperCase())).rejects.toMatchObject({code: 'INVALID_INPUT'});
    await expect(store.add(group, nativeId)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    expect(await store.current(alice)).toEqual(session);
  });

  it('returns detached copies and snapshots context before queued I/O', async () => {
    const {store} = await fixture();
    const context = {...alice};
    const saving = store.add(context, randomUUID(), '原始标题');
    context.ownerKey = 'bob';
    const returned = await saving;
    returned.title = '外部改写';
    const list = await store.list(alice);
    list[0]!.title = '列表改写';
    list.length = 0;
    expect((await store.current(alice))?.title).toBe('原始标题');
    expect(await store.list(bob)).toEqual([]);
  });

  it('updates history order on touch without changing the selected active session', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID());
    const current = await store.add(alice, randomUUID());
    await store.touch(alice, old.id);
    expect((await store.list(alice))[0]?.id).toBe(old.id);
    expect((await store.current(alice))?.id).toBe(current.id);
    expect((await SessionStore.open(directory).then(reopened => reopened.list(alice)))[0]?.id).toBe(old.id);
  });

  it('keeps committed in-memory and on-disk state unchanged on a failed pre-publication write', async () => {
    const {directory, store} = await fixture();
    const session = await store.add(alice, randomUUID(), '已经保存');
    vi.mocked(fs.open).mockRejectedValueOnce(new Error('sensitive path must not reach a chat'));
    await expect(store.rename(alice, '没有保存')).rejects.toEqual(new SessionStoreError('WRITE_FAILED'));
    expect(await store.current(alice)).toEqual(session);
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual(session);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect((await store.rename(alice, '重试成功')).title).toBe('重试成功');
  });

  it('fails closed after post-rename durability becomes uncertain', async () => {
    const {directory, store} = await fixture();
    await store.add(alice, randomUUID(), 'before');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(actual.open).mockRejectedValueOnce(new Error('directory sync unavailable'));
    await expect(store.rename(alice, 'after')).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.current(alice)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.add(alice, randomUUID())).rejects.toMatchObject({code: 'UNAVAILABLE'});
    // A reopen validates the document that actually became visible on disk.
    expect((await SessionStore.open(directory).then(reopened => reopened.current(alice)))?.title).toBe('after');
  });

  it('rejects the per-conversation capacity without discarding any session', async () => {
    const {store} = await fixture();
    const sessions = await Promise.all(Array.from({length: 100}, () => store.add(alice, randomUUID())));
    await expect(store.add(alice, randomUUID())).rejects.toMatchObject({code: 'CAPACITY'});
    expect(await store.list(alice)).toHaveLength(100);
    expect((await store.current(alice))?.id).toBe(sessions.at(-1)?.id);
  });

  it('enforces owner capacity across conversations without affecting other owners', async () => {
    const {directory} = await fixture();
    const contexts = Array.from({length: 10}, (_, conversation) => ({
      ownerKey: 'alice', conversationKey: `conversation-${conversation}`, activeId: null,
      sessions: Array.from({length: 100}, (_, session) => ({
        id: (conversation * 100 + session).toString(16).padStart(12, '0'),
        nativeId: randomUUID(), title: 'saved', createdAt: 1, updatedAt: 1,
      })),
    }));
    await fs.writeFile(join(directory, 'sessions.json'), JSON.stringify({version: 1, contexts}));
    const store = await SessionStore.open(directory);
    await expect(store.add(alice, randomUUID())).rejects.toMatchObject({code: 'CAPACITY'});
    await expect(store.add(bob, randomUUID())).resolves.toHaveProperty('id');
    expect(await store.list({ownerKey: 'alice', conversationKey: 'conversation-0'})).toHaveLength(100);
  });

  it.each(['{broken', '{"version":2,"contexts":[]}', '{"version":1,"contexts":{}}'])('does not reset corrupt or unsupported state: %s', async contents => {
    const {directory} = await fixture();
    await fs.writeFile(join(directory, 'sessions.json'), contents);
    await expect(SessionStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
    expect(await fs.readFile(join(directory, 'sessions.json'), 'utf8')).toBe(contents);
  });

  it('rejects corrupted active references, duplicate scopes and shared native identities', async () => {
    const {directory, store} = await fixture();
    await store.add(alice, randomUUID());
    const original = JSON.parse(await fs.readFile(join(directory, 'sessions.json'), 'utf8'));
    const variants = [
      {...original, contexts: [{...original.contexts[0], activeId: 'ffffffffffff'}]},
      {...original, contexts: [original.contexts[0], original.contexts[0]]},
      {...original, contexts: [original.contexts[0], {...original.contexts[0], ownerKey: 'bob'}]},
    ];
    for (const variant of variants) {
      await fs.writeFile(join(directory, 'sessions.json'), JSON.stringify(variant));
      await expect(SessionStore.open(directory)).rejects.toMatchObject({code: 'CORRUPT'});
    }
  });
});

describe('atomic native session rebinding', () => {
  it('rebinds the current topic durably while preserving every other field and returning detached data', async () => {
    const {directory, store} = await fixture();
    const before = await store.add(alice, randomUUID(), '保留的话题');
    const native = randomUUID();
    const updated = await store.rebindNative(alice, before.id, before.nativeId, native);
    expect(updated).toEqual({...before, nativeId: native});
    expect(await store.current(alice)).toEqual(updated);
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual(updated);
    updated.nativeId = randomUUID(); updated.title = '外部改写';
    expect(await store.current(alice)).toEqual({...before, nativeId: native});
  });

  it('rebinds an archived topic without activating it or changing history ordering', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID(), '旧话题');
    const current = await store.add(alice, randomUUID(), '当前话题');
    const native = randomUUID();
    await store.rebindNative(alice, old.id, old.nativeId, native);
    const reopened = await SessionStore.open(directory);
    expect(await reopened.current(alice)).toEqual(current);
    expect(await reopened.list(alice)).toEqual([current, {...old, nativeId: native}]);
    await store.archive(alice);
    await store.rebindNative(alice, old.id, native, randomUUID());
    expect(await store.current(alice)).toBeUndefined();
    expect(await SessionStore.open(directory).then(other => other.current(alice))).toBeUndefined();
  });

  it('treats the same native identity as a no-op and preserves its original representation', async () => {
    const {store} = await fixture();
    const old = await store.add(alice, 'abcdefab-abcd-4abc-8abc-abcdefabcdef');
    const calls = vi.mocked(fs.rename).mock.calls.length;
    expect(await store.rebindNative(alice, old.id, old.nativeId, old.nativeId.toUpperCase())).toEqual(old);
    expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(calls);
    expect(await store.current(alice)).toEqual(old);
  });

  it('rejects cross-owner, chat, thread and missing topic lookups without disclosing existence', async () => {
    const {store} = await fixture();
    const old = await store.add(alice, randomUUID());
    for (const context of [bob, group, thread]) {
      await expect(store.rebindNative(context, old.id, old.nativeId, randomUUID())).rejects.toEqual(new SessionStoreError('NOT_FOUND'));
    }
    await expect(store.rebindNative(alice, '000000000000', old.nativeId, randomUUID())).rejects.toEqual(new SessionStoreError('NOT_FOUND'));
    expect(await store.current(alice)).toEqual(old);
  });

  it('requires an exact expected binding and never overwrites a newer rebinding', async () => {
    const {store} = await fixture();
    const old = await store.add(alice, 'abcdefab-abcd-4abc-8abc-abcdefabcdef');
    for (const expected of [randomUUID(), old.nativeId.toUpperCase()]) {
      await expect(store.rebindNative(alice, old.id, expected, randomUUID())).rejects.toEqual(new SessionStoreError('CONFLICT'));
    }
    const winner = randomUUID(), loser = randomUUID();
    const outcomes = await Promise.allSettled([
      store.rebindNative(alice, old.id, old.nativeId, winner),
      store.rebindNative(alice, old.id, old.nativeId, loser),
    ]);
    expect(outcomes[0]).toMatchObject({status: 'fulfilled', value: {...old, nativeId: winner}});
    expect(outcomes[1]).toMatchObject({status: 'rejected', reason: {code: 'CONFLICT'}});
    expect(await store.current(alice)).toEqual({...old, nativeId: winner});
  });

  it('snapshots the caller identity before queued persistence can run', async () => {
    const {store} = await fixture();
    const old = await store.add(alice, randomUUID()), context = {...alice}, native = randomUUID();
    const rebinding = store.rebindNative(context, old.id, old.nativeId, native);
    context.ownerKey = bob.ownerKey; context.conversationKey = group.conversationKey;
    await rebinding;
    expect(await store.current(alice)).toEqual({...old, nativeId: native});
    expect(await store.list(context)).toEqual([]);
  });

  it('strictly validates topic and native identifiers without coercing caller objects', async () => {
    const {store} = await fixture();
    const old = await store.add(alice, randomUUID()), stringify = vi.fn(() => old.nativeId);
    const invalid: unknown[] = [undefined, null, 42, {}, {toString: stringify}, Symbol('invalid'), '../native', 'bad\nvalue', ` ${old.nativeId}`];
    for (const value of invalid) {
      await expect(store.rebindNative(alice, old.id, old.nativeId, value as string)).rejects.toEqual(new SessionStoreError('INVALID_INPUT'));
      await expect(store.rebindNative(alice, old.id, value as string, randomUUID())).rejects.toEqual(new SessionStoreError('INVALID_INPUT'));
      await expect(store.rebindNative(alice, value as string, old.nativeId, randomUUID())).rejects.toEqual(new SessionStoreError('INVALID_INPUT'));
    }
    await expect(store.rebindNative({...alice, ownerKey: ''}, old.id, old.nativeId, randomUUID())).rejects.toEqual(new SessionStoreError('INVALID_INPUT'));
    expect(stringify).not.toHaveBeenCalled();
    expect(await store.current(alice)).toEqual(old);
  });

  it.each([alice, bob, group, thread])('refuses an existing native identity from any stored scope', async context => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID());
    const occupied = await store.add(context, randomUUID());
    const before = await fs.readFile(join(directory, 'sessions.json'), 'utf8');
    await expect(store.rebindNative(alice, old.id, old.nativeId, occupied.nativeId.toUpperCase())).rejects.toEqual(new SessionStoreError('INVALID_INPUT'));
    expect(await fs.readFile(join(directory, 'sessions.json'), 'utf8')).toBe(before);
  });

  it('keeps the old binding on a confirmed pre-publication failure and permits a later retry', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID()), native = randomUUID();
    vi.mocked(fs.open).mockRejectedValueOnce(new Error('private storage diagnostics'));
    await expect(store.rebindNative(alice, old.id, old.nativeId, native)).rejects.toEqual(new SessionStoreError('WRITE_FAILED'));
    expect(await store.current(alice)).toEqual(old);
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual(old);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(await store.rebindNative(alice, old.id, old.nativeId, native)).toEqual({...old, nativeId: native});
  });

  it('fails closed when rename rejects because non-publication cannot be proven', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID());
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('rename response unavailable'));
    await expect(store.rebindNative(alice, old.id, old.nativeId, randomUUID())).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    await expect(store.current(alice)).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    await expect(store.archive(alice)).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual(old);
  });

  it('never publishes stale in-memory state after rename committed but its confirmation was lost', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID()), native = randomUUID();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {await actual.rename(...args); throw new Error('private commit confirmation lost');});
    const outcomes = await Promise.allSettled([
      store.rebindNative(alice, old.id, old.nativeId, native),
      store.rebindNative(alice, old.id, native, randomUUID()),
    ]);
    expect(outcomes).toMatchObject([
      {status: 'rejected', reason: {code: 'UNAVAILABLE'}},
      {status: 'rejected', reason: {code: 'UNAVAILABLE'}},
    ]);
    await expect(store.list(alice)).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    await expect(store.touch(alice, old.id)).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual({...old, nativeId: native});
  });

  it('requires reopen after directory durability fails, without hiding the committed replacement', async () => {
    const {directory, store} = await fixture();
    const old = await store.add(alice, randomUUID()), native = randomUUID();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(actual.open).mockRejectedValueOnce(new Error('directory sync unavailable'));
    await expect(store.rebindNative(alice, old.id, old.nativeId, native)).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    await expect(store.current(alice)).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    await expect(store.rebindNative(alice, old.id, native, randomUUID())).rejects.toEqual(new SessionStoreError('UNAVAILABLE'));
    expect(await SessionStore.open(directory).then(reopened => reopened.current(alice))).toEqual({...old, nativeId: native});
  });
});
