import {afterEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelPreferencesError, ModelPreferencesStore, type ModelPreferenceContext} from '../src/model-preferences.js';
import type {ModelSelection} from '../src/dsh-runtime.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename)};
});

const alice: ModelPreferenceContext = {ownerKey: 'bot:alice', conversationKey: 'private'};
const bob: ModelPreferenceContext = {ownerKey: 'bot:bob', conversationKey: 'private'};
const group: ModelPreferenceContext = {...alice, conversationKey: 'group'};
const thread: ModelPreferenceContext = {...alice, conversationKey: 'group:thread'};
const initial: ModelSelection = {provider: 'provider-a', model: 'model-a', reasoningEffort: 'high'};
const other: ModelSelection = {provider: 'provider-b', model: 'model-b', reasoningEffort: 'max'};
const directories: string[] = [];
const filename = (directory: string) => join(directory, 'model-preferences.json');

async function directory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'lark-model-preferences-'));
  directories.push(path);
  return path;
}
async function fixture() {const path = await directory(); return {directory: path, store: await ModelPreferencesStore.open(path)};}
const row = (context: ModelPreferenceContext = alice, selection: ModelSelection = initial) => ({
  ...context, selection: {...selection}, revision: randomUUID(),
});
async function seed(directory: string, entries: unknown[]) {
  await fs.writeFile(filename(directory), JSON.stringify({version: 1, entries}));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => fs.rm(path, {recursive: true, force: true})));
});

describe('conversation model preferences', () => {
  it('starts unset and restores exact model selection and revision after restart', async () => {
    const {directory, store} = await fixture();
    expect(await store.get(alice)).toBeUndefined();
    const saved = await store.set(alice, initial, {expectedRevision: null});
    expect(saved).toEqual({selection: initial, revision: expect.any(String)});
    expect(saved).not.toHaveProperty('ownerKey');
    expect(saved).not.toHaveProperty('conversationKey');
    expect(await ModelPreferencesStore.open(directory).then(reopened => reopened.get(alice))).toEqual(saved);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(filename(directory))).mode & 0o777).toBe(0o600);
  });

  it('isolates the same conversation name by owner, and each chat/thread by exact context', async () => {
    const {directory, store} = await fixture();
    const contexts = [alice, bob, group, thread, {...alice, ownerKey: 'other-bot:alice'}];
    const records = [];
    for (const [index, context] of contexts.entries()) records.push(await store.set(context, {...initial, model: `model-${index}`}));
    const reopened = await ModelPreferencesStore.open(directory);
    for (const [index, context] of contexts.entries()) {
      expect(await store.get(context)).toEqual(records[index]);
      expect(await reopened.get(context)).toEqual(records[index]);
    }
    expect(await store.get({...alice, conversationKey: 'another-chat'})).toBeUndefined();
    await expect(store.set(bob, other, {expectedRevision: records[0]!.revision})).rejects.toMatchObject({code: 'CONFLICT'});
    expect(await store.get(bob)).toEqual(records[1]);
  });

  it('does not alias contexts whose keys contain a delimiter', async () => {
    const {store} = await fixture();
    const left = {ownerKey: 'a:b', conversationKey: 'c'};
    const right = {ownerKey: 'a', conversationKey: 'b:c'};
    await store.set(left, initial); await store.set(right, other);
    expect((await store.get(left))?.selection).toEqual(initial);
    expect((await store.get(right))?.selection).toEqual(other);
  });

  it('serializes competing compare-and-set writes and rejects stale cards', async () => {
    const {directory, store} = await fixture();
    const old = await store.set(alice, initial);
    const results = await Promise.allSettled([
      store.set(alice, other, {expectedRevision: old.revision}),
      store.set(alice, {provider: 'provider-c', model: 'model-c'}, {expectedRevision: old.revision}),
    ]);
    expect(results[0]).toMatchObject({status: 'fulfilled', value: {selection: other}});
    expect(results[1]).toMatchObject({status: 'rejected', reason: {code: 'CONFLICT'}});
    const current = await store.get(alice);
    expect(await ModelPreferencesStore.open(directory).then(reopened => reopened.get(alice))).toEqual(current);
    await expect(store.set(alice, initial, {expectedRevision: null})).rejects.toMatchObject({code: 'CONFLICT'});
  });

  it('changes the revision for identical values and for A to B to A transitions', async () => {
    const {store} = await fixture();
    const a1 = await store.set(alice, initial);
    const b = await store.set(alice, other, {expectedRevision: a1.revision});
    const a2 = await store.set(alice, initial, {expectedRevision: b.revision});
    const a3 = await store.set(alice, initial, {expectedRevision: a2.revision});
    expect(new Set([a1.revision, b.revision, a2.revision, a3.revision]).size).toBe(4);
    await expect(store.set(alice, other, {expectedRevision: a1.revision})).rejects.toMatchObject({code: 'CONFLICT'});
  });

  it('snapshots all input and returns detached copies', async () => {
    const {store} = await fixture();
    const context = {...alice}, selected = {...initial}, options: {expectedRevision: string | null} = {expectedRevision: null};
    const writing = store.set(context, selected, options);
    context.ownerKey = 'changed'; selected.model = 'changed'; options.expectedRevision = randomUUID();
    const result = await writing;
    result.selection.model = 'changed'; result.revision = randomUUID();
    const read = await store.get(alice);
    expect(read?.selection).toEqual(initial);
    read!.selection.reasoningEffort = 'changed';
    expect((await store.get(alice))?.selection).toEqual(initial);
    expect(await store.get(context)).toBeUndefined();
  });

  it('waits for pending durable writes while retaining the original read identity', async () => {
    const {store} = await fixture();
    await store.set(alice, initial);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let began!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => {began = resolve;});
    const release = new Promise<void>(resolve => {finish = resolve;});
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {began(); await release; await actual.rename(from, to);});
    const writing = store.set(alice, other);
    await started;
    const context = {...alice};
    let finished = false;
    const reading = store.get(context).then(value => {finished = true; return value;});
    context.ownerKey = bob.ownerKey;
    await Promise.resolve();
    expect(finished).toBe(false);
    finish();
    expect(await reading).toEqual(await writing);
  });

  it('keeps omitted reasoning absent instead of inventing a host default', async () => {
    const {directory, store} = await fixture();
    const saved = await store.set(alice, {provider: initial.provider, model: initial.model});
    expect(saved.selection).not.toHaveProperty('reasoningEffort');
    expect(await ModelPreferencesStore.open(directory).then(reopened => reopened.get(alice))).toEqual(saved);
  });
});

describe('model preference validation and capacity', () => {
  it.each([
    {}, {provider: '', model: 'm'}, {provider: ' p', model: 'm'}, {provider: 'p', model: 'm\n'},
    {provider: 'p', model: '\ud800'}, {provider: 'p', model: 'm', reasoningEffort: ''},
    {provider: 'p', model: 'm', reasoningEffort: null}, {provider: 'p', model: 'm', reasoningEffort: 'high\0'},
    {provider: 'p', model: 'm', appSecret: 'must-not-store'}, {provider: 'p', model: 'm', reasoningEffort: 'x'.repeat(129)},
    {provider: 'p', model: 'x'.repeat(257)}, {provider: 'p', model: '\u202Ehidden'},
  ])('rejects malformed selection without persisting it: %j', async invalid => {
    const {directory, store} = await fixture();
    await expect(store.set(alice, invalid as ModelSelection)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    expect(await store.get(alice)).toBeUndefined();
    await expect(fs.stat(filename(directory))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects malformed contexts, revision values and option fields', async () => {
    const {store} = await fixture();
    for (const context of [{...alice, ownerKey: ''}, {...alice, conversationKey: '\0'}, {...alice, ownerKey: 'x'.repeat(513)}]) {
      await expect(store.get(context)).rejects.toMatchObject({code: 'INVALID_INPUT'});
      await expect(store.set(context, initial)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    }
    for (const expectedRevision of ['', 'old', 1, '00000000-0000-0000-0000-000000000000']) {
      await expect(store.set(alice, initial, {expectedRevision: expectedRevision as string})).rejects.toMatchObject({code: 'INVALID_INPUT'});
    }
    await expect(store.set(alice, initial, {ownerKey: 'other'} as never)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    await expect(ModelPreferencesStore.open('')).rejects.toMatchObject({code: 'INVALID_INPUT'});
  });

  it('rejects accessor input without invoking it or changing the identity', async () => {
    const {store} = await fixture();
    const getter = vi.fn(() => {throw new Error('private accessor data');});
    const context = {conversationKey: 'private'};
    Object.defineProperty(context, 'ownerKey', {get: getter, enumerable: true});
    await expect(store.get(context as ModelPreferenceContext)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    const selection = {provider: 'provider-a'};
    Object.defineProperty(selection, 'model', {get: getter, enumerable: true});
    await expect(store.set(alice, selection as ModelSelection)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    expect(getter).not.toHaveBeenCalled();
  });

  it('enforces per-owner capacity but allows updates and other owners', async () => {
    const path = await directory();
    await seed(path, Array.from({length: 1000}, (_, i) => row({...alice, conversationKey: `chat-${i}`})));
    const store = await ModelPreferencesStore.open(path);
    await expect(store.set(alice, initial)).rejects.toMatchObject({code: 'CAPACITY'});
    expect((await store.set({...alice, conversationKey: 'chat-0'}, other)).selection).toEqual(other);
    expect((await store.set(bob, initial)).selection).toEqual(initial);
  });

  it('enforces total capacity while preserving existing entries', async () => {
    const path = await directory();
    await seed(path, Array.from({length: 10_000}, (_, i) => row({ownerKey: `owner-${Math.floor(i / 1000)}`, conversationKey: `chat-${i}`})));
    const store = await ModelPreferencesStore.open(path);
    await expect(store.set(alice, initial)).rejects.toMatchObject({code: 'CAPACITY'});
    expect((await store.set({ownerKey: 'owner-0', conversationKey: 'chat-0'}, other)).selection).toEqual(other);
  });

  it.each([
    null, {version: 2, entries: []}, {version: 1, entries: [], secret: 'unexpected'},
    {version: 1, entries: [row(), row()]},
    {version: 1, entries: [{...row(), revision: 'invalid'}]},
    {version: 1, entries: [{...row(), unknown: true}]},
    {version: 1, entries: [{...row(), selection: {...initial, endpoint: 'unexpected'}}]},
    {version: 1, entries: [{...row(), ownerKey: ''}]},
  ])('fails closed on malformed disk schema: %j', async value => {
    const path = await directory();
    const text = JSON.stringify(value);
    await fs.writeFile(filename(path), text);
    await expect(ModelPreferencesStore.open(path)).rejects.toMatchObject({code: 'CORRUPT'});
    expect(await fs.readFile(filename(path), 'utf8')).toBe(text);
  });

  it('rejects corrupt JSON, disk capacity overflow, and oversized files without clearing them', async () => {
    const path = await directory();
    await fs.writeFile(filename(path), '{broken');
    await expect(ModelPreferencesStore.open(path)).rejects.toMatchObject({code: 'CORRUPT'});
    await seed(path, Array.from({length: 1001}, (_, i) => row({...alice, conversationKey: `chat-${i}`})));
    await expect(ModelPreferencesStore.open(path)).rejects.toMatchObject({code: 'CORRUPT'});
    await fs.truncate(filename(path), 16 * 1024 * 1024 + 1);
    await expect(ModelPreferencesStore.open(path)).rejects.toMatchObject({code: 'CORRUPT'});
    expect((await fs.stat(filename(path))).size).toBe(16 * 1024 * 1024 + 1);
  });

  it('rejects invalid UTF-8 instead of normalizing saved model identifiers', async () => {
    const path = await directory();
    const content = JSON.stringify({version: 1, entries: [row()]});
    const bytes = Buffer.from(content);
    bytes[content.indexOf('provider-a')] = 0xff;
    await fs.writeFile(filename(path), bytes);
    await expect(ModelPreferencesStore.open(path)).rejects.toMatchObject({code: 'CORRUPT'});
    expect(await fs.readFile(filename(path))).toEqual(bytes);
  });

  it('rejects files that grow after the checked stat without unbounded reads', async () => {
    const path = await directory();
    await seed(path, [row()]);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const nativeRead = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce((async (...readArgs: Parameters<typeof nativeRead>) => {
        await actual.appendFile(filename(path), ' ');
        return nativeRead(...readArgs);
      }) as typeof handle.read);
      return handle;
    });
    await expect(ModelPreferencesStore.open(path)).rejects.toMatchObject({code: 'CORRUPT'});
  });

  it('rejects symlink directories and files without modifying their targets', async () => {
    const base = await directory(), target = join(base, 'target'), alias = join(base, 'alias');
    await fs.mkdir(target, {mode: 0o755});
    await fs.symlink(target, alias);
    await expect(ModelPreferencesStore.open(alias)).rejects.toMatchObject({code: 'CORRUPT'});
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
    const outside = join(base, 'outside.json');
    await fs.writeFile(outside, JSON.stringify({version: 1, entries: []}), {mode: 0o644});
    await fs.symlink(outside, filename(target));
    await expect(ModelPreferencesStore.open(target)).rejects.toMatchObject({code: 'CORRUPT'});
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o644);
  });
});

describe('model preference durability failures', () => {
  it('preserves committed data and allows retry after a failure before publication', async () => {
    const {directory, store} = await fixture();
    const saved = await store.set(alice, initial);
    vi.mocked(fs.open).mockRejectedValueOnce(new Error('SECRET diagnostics and /private/path'));
    await expect(store.set(alice, other)).rejects.toEqual(new ModelPreferencesError('WRITE_FAILED'));
    expect(await store.get(alice)).toEqual(saved);
    expect(await ModelPreferencesStore.open(directory).then(reopened => reopened.get(alice))).toEqual(saved);
    expect((await store.set(alice, other, {expectedRevision: saved.revision})).selection).toEqual(other);
  });

  it('cleans a temporary file and does not publish after file fsync fails', async () => {
    const {directory, store} = await fixture();
    const saved = await store.set(alice, initial);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('SECRET fsync failure'));
      return handle;
    });
    await expect(store.set(alice, other)).rejects.toEqual(new ModelPreferencesError('WRITE_FAILED'));
    expect(await store.get(alice)).toEqual(saved);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('poisons reads and writes after a rejected publication attempt, until explicit reopen', async () => {
    const {directory, store} = await fixture();
    const saved = await store.set(alice, initial);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('SECRET rename diagnostic'));
    await expect(store.set(alice, other)).rejects.toEqual(new ModelPreferencesError('UNAVAILABLE'));
    await expect(store.get(alice)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.get(bob)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.set(alice, initial)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    expect(await ModelPreferencesStore.open(directory).then(reopened => reopened.get(alice))).toEqual(saved);
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not guess the result when rename commits but its completion is uncertain', async () => {
    const {directory, store} = await fixture();
    const previous = await store.set(alice, initial);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {await actual.rename(from, to); throw new Error('completion lost');});
    await expect(store.set(alice, other)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    await expect(store.get(alice)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    const recovered = await ModelPreferencesStore.open(directory).then(reopened => reopened.get(alice));
    expect(recovered?.selection).toEqual(other);
    expect(recovered?.revision).not.toBe(previous.revision);
  });

  it('poisons queued work if directory durability cannot be confirmed after publication', async () => {
    const {directory, store} = await fixture();
    await store.set(alice, initial);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(actual.open).mockRejectedValueOnce(new Error('SECRET directory durability error'));
    const results = await Promise.allSettled([store.set(alice, other), store.set(bob, initial)]);
    expect(results.map(result => result.status === 'rejected' && result.reason.code)).toEqual(['UNAVAILABLE', 'UNAVAILABLE']);
    await expect(store.get(alice)).rejects.toMatchObject({code: 'UNAVAILABLE'});
    const reopened = await ModelPreferencesStore.open(directory);
    expect((await reopened.get(alice))?.selection).toEqual(other);
    expect(await reopened.get(bob)).toBeUndefined();
  });
});
