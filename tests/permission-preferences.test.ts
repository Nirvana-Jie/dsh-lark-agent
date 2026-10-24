import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionPreferencesStore } from '../src/permission-preferences.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true}))); });
async function directory() { const value = await mkdtemp(join(tmpdir(), 'dsh-permission-')); directories.push(value); return value; }
const alice = {ownerKey: 'owner-alice', conversationKey: 'chat-alice'};

describe('PermissionPreferencesStore', () => {
  it('keeps one private file per chat choice across restarts', async () => {
    const dir = await directory();
    const store = await PermissionPreferencesStore.open(dir);
    expect(await store.get(alice)).toBeUndefined();
    await store.set(alice, 'danger-full-access');
    await store.set({...alice, conversationKey: 'chat-other'}, 'read-only');
    const reopened = await PermissionPreferencesStore.open(dir);
    expect(await reopened.get(alice)).toBe('danger-full-access');
    expect(await reopened.get({...alice, conversationKey: 'chat-other'})).toBe('read-only');
    expect((await stat(join(dir, 'permission-preferences.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, 'permission-preferences.json'), 'utf8')).entries).toHaveLength(2);
  });

  it('rejects malformed presets and identities', async () => {
    const store = await PermissionPreferencesStore.open(await directory());
    for (const preset of ['', 'Danger', '../x', 'a'.repeat(41)]) await expect(store.set(alice, preset)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    await expect(store.set({ownerKey: '', conversationKey: 'x'}, 'read-only')).rejects.toMatchObject({code: 'INVALID_INPUT'});
  });

  it('fails closed on a corrupt file instead of treating it as empty', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'permission-preferences.json'), JSON.stringify({version: 1, entries: [{...alice, preset: 'Bad'}]}));
    await expect(PermissionPreferencesStore.open(dir)).rejects.toMatchObject({code: 'CORRUPT'});
  });
});
