import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ConnectionManager} from '../src/onboarding/manager.js';
import {ConnectionStore, type ConnectionRecord} from '../src/onboarding/store.js';
import type {OnboardingDependencies} from '../src/onboarding/controller.js';
import {defaultAgentSettings} from '../src/onboarding/agents.js';
import {BOT_SCOPES, type Inspection} from '../src/onboarding/lark-platform.js';
import {SessionStore} from '../src/session-store.js';
import {createHash} from 'node:crypto';

const paths: string[] = [], managers: ConnectionManager[] = [];
const profiles = [{name: 'bot-first', appId: 'cli_first', brand: 'feishu' as const, active: false},
  {name: 'bot-second', appId: 'cli_second', brand: 'feishu' as const, active: false},
  {name: 'bot-first-alias', appId: 'cli_first', brand: 'feishu' as const, active: false}];
const legacy: ConnectionRecord = {schema: 1, profile: 'bot-first', appId: 'cli_first', botOpenId: 'ou_first', brand: 'feishu',
  creatorOpenId: 'ou_owner', ownerOpenId: 'ou_owner', ownerChatId: 'oc_owner', enabled: false, verified: true, publishAttempted: true, cards: false, loading: false};
const catalog = {presets: [], presetsAvailable: false, imagesAvailable: false, voiceAvailable: false, model: 'Offline'};
async function fixture(directory?: string) {
  const path = directory ?? await mkdtemp(join(tmpdir(), 'lark-manager-'));
  if (!directory) {paths.push(path); await new ConnectionStore(path).write(legacy);}
  const starts = new Map<string, {stop: ReturnType<typeof vi.fn>; config: unknown}>();
  const inspect = vi.fn(async (name: string): Promise<Inspection> => {
    const profile = profiles.find(row => row.name === name)!;
    return {profile: name, appId: profile.appId, brand: 'feishu', botOpenId: profile.appId === 'cli_first' ? 'ou_first' : 'ou_second',
      creatorOpenId: 'ou_owner', grantedScopes: [...BOT_SCOPES, 'im:message:readonly'], scopeStatus: 'verified', appStatus: 1, publicationStatus: 'approved', problems: []};
  });
  const dependencies = (): Omit<OnboardingDependencies, 'store'> => ({platform: {listProfiles: async () => profiles,
    inspect, registerNew: vi.fn(), saveNewProfile: vi.fn(), configureAndPublish: vi.fn()}, checkRuntime: () => {}, preflight: async () => {},
    start: async config => {const stop = vi.fn(async () => true); starts.set(config.profile, {stop, config}); return {start() {}, stop, ready: () => true};},
    pair: async () => ({messageId: 'om_pair', senderId: 'ou_owner', chatId: 'oc_owner', chatType: 'p2p', threadId: '', text: 'DSH-fixture'}), acknowledge: async () => {}});
  const manager = new ConnectionManager(path, dependencies, async () => catalog); managers.push(manager);
  await manager.initialize();
  await vi.waitFor(() => expect(inspect).toHaveBeenCalled());
  return {path, manager, starts, dependencies};
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  await Promise.all(paths.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

describe('independent robot controllers', () => {
  it('keeps the legacy connection in place and restores additional connections from their own directories', async () => {
    const f = await fixture();
    expect(f.manager.list().connections).toMatchObject([{id: 'default', phase: 'paused'}]);
    const added = await f.manager.add();
    const id = added.selectedId;
    await f.manager.command('update-agent', {...defaultAgentSettings, label: '研究助手', agentPreset: 'research'}, id);
    await f.manager.command('use-profile', {name: 'bot-second'}, id);
    await vi.waitFor(() => expect(f.manager.snapshot(id).phase).toBe('connected'));
    expect(f.manager.snapshot().phase).toBe('paused');
    expect(f.starts.get('bot-second')?.config).toMatchObject({users: [{agentPreset: 'research', directMode: 'harness', groupChats: []}]});
    expect(JSON.parse(await readFile(join(f.path, 'connection.json'), 'utf8'))).toEqual(legacy);
    expect(JSON.parse(await readFile(join(f.path, 'connections', id, 'connection.json'), 'utf8')).appId).toBe('cli_second');
    await f.manager.dispose();
    const restored = await fixture(f.path);
    await vi.waitFor(() => expect(restored.manager.snapshot(id).phase).toBe('connected'));
    expect(restored.manager.list().connections[1]).toMatchObject({id, label: '研究助手', agentPreset: 'research'});
    expect(restored.manager.snapshot().phase).toBe('paused');
  });
  it('pauses one robot independently and rejects changing settings until it drains', async () => {
    const f = await fixture();
    const {selectedId} = await f.manager.add();
    await f.manager.command('resume', {});
    await f.manager.command('use-profile', {name: 'bot-second'}, selectedId);
    await vi.waitFor(() => expect(f.manager.list().connections.map(row => row.phase)).toEqual(['connected', 'connected']));
    await expect(f.manager.command('update-agent', defaultAgentSettings, selectedId)).rejects.toThrow('先暂停');
    await f.manager.command('pause', {}, selectedId);
    expect(f.manager.snapshot().phase).toBe('connected');
    expect(f.starts.get('bot-first')?.stop).not.toHaveBeenCalled();
    expect(f.starts.get('bot-second')?.stop).toHaveBeenCalledOnce();
  });
  it('rejects the same bot identity even when it is offered through another CLI profile', async () => {
    const f = await fixture(); const {selectedId} = await f.manager.add();
    await f.manager.command('use-profile', {name: 'bot-first-alias'}, selectedId);
    await vi.waitFor(() => expect(f.manager.snapshot(selectedId).phase).toBe('error'));
    expect(f.manager.snapshot(selectedId).message).toContain('已在列表');
    expect(f.starts.size).toBe(0);
  });
  it('releases the former bot after an entry durably switches to another app', async () => {
    const f = await fixture();
    await f.manager.command('disconnect', {});
    await f.manager.command('use-profile', {name: 'bot-second'});
    await vi.waitFor(() => expect(f.manager.snapshot().phase).toBe('connected'));
    const {selectedId} = await f.manager.add();
    await f.manager.command('use-profile', {name: 'bot-first-alias'}, selectedId);
    await vi.waitFor(() => expect(f.manager.snapshot(selectedId).phase).toBe('connected'));
    expect(f.manager.snapshot().bot?.appId).toBe('cli_second');
    expect(f.manager.snapshot(selectedId).bot?.appId).toBe('cli_first');
  });
  it('retains both identity claims when a replacement record cannot be saved', async () => {
    const f = await fixture(), original = ConnectionStore.prototype.write;
    const write = vi.spyOn(ConnectionStore.prototype, 'write').mockImplementation(function(this: ConnectionStore, record) {
      return record.appId === 'cli_second' ? Promise.reject(new Error('uncertain publication')) : original.call(this, record);
    });
    try {
      await f.manager.command('use-profile', {name: 'bot-second'});
      await vi.waitFor(() => expect(f.manager.snapshot().phase).toBe('error'));
      const {selectedId} = await f.manager.add();
      for (const name of ['bot-first-alias', 'bot-second']) {
        await f.manager.command('use-profile', {name}, selectedId);
        await vi.waitFor(() => expect(f.manager.snapshot(selectedId).phase).toBe('error'));
        expect(f.manager.snapshot(selectedId).message).toContain('已在列表');
      }
    } finally {write.mockRestore();}
  });
  it('serializes additions at the limit and refuses caller-controlled directory paths', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({length: 12}, () => f.manager.add()));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(9);
    expect(f.manager.list().connections).toHaveLength(10);
    expect(() => f.manager.snapshot('../outside')).toThrow('入口不可用');
    expect(() => f.manager.snapshot('a'.repeat(32))).toThrow('没有找到');
  });
  it('removes an inactive extra robot from the roster while retaining its recoverable local settings', async () => {
    const f = await fixture(); const {selectedId} = await f.manager.add();
    await f.manager.command('update-agent', {...defaultAgentSettings, label: '可恢复助手'}, selectedId);
    const result = await f.manager.remove(selectedId);
    expect(result.connections).toHaveLength(1); expect(result.selectedId).toBe('default');
    expect(JSON.parse(await readFile(join(f.path, 'connections', selectedId, 'agent.json'), 'utf8')).label).toBe('可恢复助手');
    expect(JSON.parse(await readFile(join(f.path, 'connections.json'), 'utf8')).ids).toEqual(['default']);
    await expect(f.manager.remove('default')).rejects.toThrow('首个');
  });
  it('pins legacy workspaces before changing the default for future topics', async () => {
    const f = await fixture();
    const identity = createHash('sha256').update(JSON.stringify(['cli_first', 'ou_owner'])).digest('hex').slice(0, 24);
    const state = await SessionStore.open(join(f.path, 'bots', identity, 'state'));
    const context = {ownerKey: 'owner', conversationKey: 'topic'};
    await state.add(context, '00000000-0000-4000-8000-000000000000', '旧话题');
    await f.manager.command('update-agent', {...defaultAgentSettings, workspace: '/tmp/new-workspace'});
    const saved = await (await SessionStore.open(join(f.path, 'bots', identity, 'state'))).current(context);
    expect(saved?.cwd).toBe(join(f.path, 'bots', identity, 'workspace'));
  });
  it('does not claim a successful manager shutdown when a child cannot stop', async () => {
    const f = await fixture(); await f.manager.command('resume', {});
    await vi.waitFor(() => expect(f.manager.snapshot().phase).toBe('connected'));
    f.starts.get('bot-first')!.stop.mockResolvedValue(false);
    expect(await f.manager.dispose()).toBe(false);
  });
  it('serializes removal with a concurrent attempt to start the same robot', async () => {
    const f = await fixture(); const {selectedId} = await f.manager.add();
    const removed = f.manager.remove(selectedId);
    const started = f.manager.command('use-profile', {name: 'bot-second'}, selectedId);
    const rejected = expect(started).rejects.toThrow('没有找到');
    await removed; await rejected;
    expect(f.starts.size).toBe(0);
  });
  it('refreshes capability metadata without resuming a paused bot', async () => {
    const f = await fixture();
    await f.manager.command('recheck', {});
    expect(f.manager.snapshot().phase).toBe('paused'); expect(f.starts.size).toBe(0);
  });
  it('fails closed on a corrupt registry instead of presenting an empty connection list', async () => {
    const f = await fixture(); await f.manager.dispose();
    await writeFile(join(f.path, 'connections.json'), '{"version":1,"ids":["../escape"]}');
    const manager = new ConnectionManager(f.path, f.dependencies, async () => catalog); managers.push(manager);
    await expect(manager.initialize()).rejects.toThrow('Invalid connection registry');
  });
});
