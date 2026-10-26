import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BotBridge, type Runtime, type Transport} from '../src/bridge.js';
import {parseConfig} from '../src/config.js';
import type {AgentPolicy, RuntimeSession} from '../src/dsh-runtime.js';
import {MemoryStore} from '../src/memory-store.js';
import {SessionStore} from '../src/session-store.js';
import {TopicStore, type TopicReceipt, type TopicScope} from '../src/topic-store.js';
import {ownerKey, parseMessage, sessionKey} from '../src/message.js';
import {CardActions} from '../src/card-actions.js';
import {DirectChatsStore} from '../src/direct-chats.js';
import {PermissionPreferencesStore} from '../src/permission-preferences.js';
import {ModelPreferencesStore} from '../src/model-preferences.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-topic-bridge-'));
  cleanup.push(() => rm(directory, {recursive: true, force: true}));
  const config = parseConfig({profile: 'test-bot', botOpenId: 'ou_bot', cardInteractions: true, botMenu: true, users: [
    {openId: 'ou_alice', direct: true, directMode: 'harness', groupChats: ['oc_group'], cwd: '/tmp/alice', allowedTools: ['safe_a']},
    {openId: 'ou_bob', direct: true, groupChats: ['oc_group'], cwd: '/tmp/bob', allowedTools: ['safe_b']},
  ]});
  const state = {sessions: await SessionStore.open(directory), memories: await MemoryStore.open(directory),
    topics: await TopicStore.open(directory), actions: await CardActions.open(directory, 'topic-tests'), directChats: await DirectChatsStore.open(directory),
    permissionPreferences: await PermissionPreferencesStore.open(directory), modelPreferences: await ModelPreferencesStore.open(directory)};
  const handles: Array<RuntimeSession & {run: ReturnType<typeof vi.fn<RuntimeSession['run']>>}> = [];
  const create = vi.fn(async (_policy: AgentPolicy) => {
    const handle = {id: randomUUID() as string, run: vi.fn<RuntimeSession['run']>(async text => `answer:${text}`),
      cancel: vi.fn(), dispose: vi.fn(async () => undefined), checkpoint: vi.fn(async () => undefined)};
    handles.push(handle); return handle;
  });
  const resume = vi.fn(async (policy: AgentPolicy, id: string) => {const handle = await create(policy); handle.id = id; return handle;});
  let topicSequence = 0;
  const openTopic = vi.fn<NonNullable<Transport['openTopic']>>(async () => {
    const index = ++topicSequence;
    return {threadId: `omt_${index}`, messageId: `om_anchor_${index}`, link: `https://applink.feishu.cn/client/chat/open?openChatId=oc_example&position=${index}`};
  });
  const reply = vi.fn<Transport['reply']>(async () => undefined);
  const sendUser = vi.fn<NonNullable<Transport['sendUser']>>(async () => undefined);
  const updateFeedback = vi.fn<NonNullable<Transport['updateFeedback']>>(async () => undefined);
  const replyRich = vi.fn<NonNullable<Transport['replyRich']>>(async () => undefined);
  const transport: Transport = {reply, openTopic, sendUser, updateFeedback};
  const claims = new Set<string>();
  const ledger = {claim: vi.fn(async (key: string) => {if (claims.has(key)) return false; claims.add(key); return true;})};
  const audit = vi.fn();
  const runtime: Runtime = {create, resume};
  let bridge = new BotBridge(config, runtime, transport, ledger, state, audit);
  cleanup.push(async () => {await bridge.stop();});
  bridge.setCardActionsReady(true);
  let sequence = 0;
  const event = (content: string, extra: Record<string, unknown> = {}) => ({type: 'im.message.receive_v1', sender_type: 'user',
    sender_id: 'ou_alice', message_type: 'text', message_id: `om_event_${++sequence}`, chat_type: 'p2p', chat_id: 'oc_alice', content, ...extra});
  const group = (content: string, extra: Record<string, unknown> = {}) => event(`@_user_1 ${content}`, {chat_type: 'group', chat_id: 'oc_group',
    mentions: [{key: '@_user_1', id: 'ou_bot', name: 'Assistant'}], ...extra});
  const scope = (raw = event('scope')): TopicScope => {
    const message = parseMessage(raw, config.botOpenId)!;
    return {ownerKey: ownerKey(message, config), chatKey: createHash('sha256').update(JSON.stringify([
      config.profile, config.botOpenId, message.chatType, message.chatId,
    ])).digest('hex')};
  };
  const topics = async (raw?: ReturnType<typeof event>) => state.topics.list(scope(raw));
  const legacyContext = (raw = event('context')) => {
    const message = parseMessage(raw, config.botOpenId)!;
    return {ownerKey: ownerKey(message, config), conversationKey: sessionKey(message, config)};
  };
  const restart = async () => {
    await bridge.stop();
    state.sessions = await SessionStore.open(directory); state.topics = await TopicStore.open(directory);
    bridge = new BotBridge(config, runtime, transport, ledger, state, audit); bridge.setCardActionsReady(true);
  };
  return {config, state, runtime, get bridge() {return bridge;}, transport, create, resume, handles, openTopic, reply, replyRich, sendUser,
    updateFeedback, ledger, audit, event, group, topics, legacyContext, restart};
}

describe('one native Lark topic per session', () => {
  it.each(['p2p', 'group'] as const)('binds the first turn and immediate follow-ups to one %s session', async type => {
    const h = await fixture();
    const make = type === 'group' ? h.group : h.event;
    const opening = deferred<TopicReceipt>();
    h.openTopic.mockImplementationOnce(async () => opening.promise);
    const firstEvent = make('first');
    const first = h.bridge.accept(firstEvent);
    await vi.waitFor(() => expect(h.openTopic).toHaveBeenCalledOnce());
    const second = h.bridge.accept(make('second', {thread_id: 'omt_first'}));
    expect(h.create).not.toHaveBeenCalled();
    const running = deferred<string>();
    h.create.mockImplementationOnce(async () => {
      const handle = {id: randomUUID(), run: vi.fn<RuntimeSession['run']>().mockImplementationOnce(async () => running.promise).mockResolvedValue('second answer'),
        cancel: vi.fn(), dispose: vi.fn(async () => undefined), checkpoint: vi.fn(async () => undefined)};
      h.handles.push(handle); return handle;
    });
    opening.resolve({threadId: 'omt_first', messageId: 'om_anchor_first'});
    await vi.waitFor(() => expect(h.handles[0]?.run).toHaveBeenCalledOnce());
    expect(h.create).toHaveBeenCalledOnce();
    running.resolve('first answer');
    await Promise.all([first, second]);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.handles[0]!.run.mock.calls.map(call => call[0])).toEqual(['first', 'second']);
    expect((await h.topics(firstEvent))[0]?.sessionId).toMatch(/^[a-f0-9]{12}$/);
    expect(h.openTopic).toHaveBeenCalledWith({chatId: firstEvent.chat_id, messageId: firstEvent.message_id}, 'first', expect.any(Object));
    expect(h.reply.mock.calls.map(call => [call[0], call[2].inThread])).toEqual([['om_anchor_first', true], [expect.any(String), true]]);
    if (type === 'group') {
      expect(h.create.mock.calls[0]?.[0]).toMatchObject({mode: 'restricted', allowedTools: ['safe_a']});
      expect(h.handles[0]!.run.mock.calls[0]).toHaveLength(3);
    }
  });

  it('creates independent topics for main-chat requests and keeps /stop within its topic', async () => {
    const h = await fixture();
    await h.bridge.accept(h.event('one'));
    await h.bridge.accept(h.event('two'));
    const topics = await h.topics();
    expect(topics).toHaveLength(2);
    expect(h.create).toHaveBeenCalledTimes(2);
    await h.bridge.accept(h.event('follow one', {thread_id: topics[0]!.threadId}));
    expect(h.handles[0]!.run.mock.calls.map(call => call[0])).toEqual(['one', 'follow one']);
    await h.bridge.accept(h.event('/stop', {thread_id: topics[0]!.threadId}));
    expect(h.handles[0]!.cancel).toHaveBeenCalledOnce();
    expect(h.handles[1]!.cancel).not.toHaveBeenCalled();
    expect(h.openTopic).toHaveBeenCalledTimes(2);
  });

  it('makes /new a sibling placeholder while the original topic stays usable', async () => {
    const h = await fixture();
    await h.bridge.accept(h.event('original'));
    const original = (await h.topics())[0]!;
    await h.bridge.accept(h.event('/new', {thread_id: original.threadId}));
    const next = (await h.topics()).find(topic => topic.threadId !== original.threadId)!;
    expect(next.sessionId).toBeUndefined();
    expect(h.openTopic.mock.calls[1]?.[0]).toEqual({chatId: 'oc_alice'});
    expect(h.handles[0]!.dispose).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
    await h.bridge.accept(h.event('new question', {thread_id: next.threadId}));
    await h.bridge.accept(h.event('old question', {thread_id: original.threadId}));
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.handles[0]!.run.mock.calls.map(call => call[0])).toEqual(['original', 'old question']);
  });

  it('restores the exact binding after restart, including legacy sessions selected independently', async () => {
    const h = await fixture();
    const context = h.legacyContext();
    const older = await h.state.sessions.add(context, randomUUID(), '旧会话 A');
    const newer = await h.state.sessions.add(context, randomUUID(), '旧会话 B');
    await h.bridge.accept(h.event(`/resume ${older.id}`));
    await h.bridge.accept(h.event(`/resume ${newer.id}`));
    const topics = await h.topics();
    expect(topics.map(topic => topic.sessionId).sort()).toEqual([older.id, newer.id].sort());
    expect(h.create).not.toHaveBeenCalled();
    await h.bridge.accept(h.event('continue A', {thread_id: topics.find(topic => topic.sessionId === older.id)!.threadId}));
    expect(h.resume.mock.calls[0]?.[1]).toBe(older.nativeId);
    expect(await h.state.sessions.current(context)).toEqual(newer);
    await h.restart();
    await h.bridge.accept(h.event('continue B', {thread_id: topics.find(topic => topic.sessionId === newer.id)!.threadId}));
    expect(h.resume.mock.calls.at(-1)?.[1]).toBe(newer.nativeId);
    expect(h.openTopic).toHaveBeenCalledTimes(2);
    await h.bridge.accept(h.event(`/resume ${older.id}`));
    expect(h.openTopic).toHaveBeenCalledTimes(2);
    expect(h.reply.mock.calls.at(-1)?.[1]).toContain('打开话题继续');
  });

  it('restores a newly created topic without creating a replacement native session', async () => {
    const h = await fixture();
    await h.bridge.accept(h.event('durable'));
    const topic = (await h.topics())[0]!;
    const nativeId = h.handles[0]!.id;
    await h.restart();
    await h.bridge.accept(h.event('again', {thread_id: topic.threadId}));
    expect(h.resume).toHaveBeenCalledWith(expect.any(Object), nativeId);
    expect(h.openTopic).toHaveBeenCalledOnce();
  });

  it('keeps a private chat permission choice and App changes across native topics', async () => {
    const h = await fixture();
    const modes: Array<{current: string}> = [];
    h.create.mockImplementation(async () => {
      const mode = {current: 'workspace'}; modes.push(mode);
      const handle = {id: randomUUID() as string, run: vi.fn<RuntimeSession['run']>(async () => 'answer'),
        cancel: vi.fn(), dispose: vi.fn(async () => undefined), checkpoint: vi.fn(async () => undefined),
        permissionState: () => ({current: mode.current, defaultPreset: 'workspace', options: [
          {id: 'workspace', name: '工作区'}, {id: 'read-only', name: '只读'}, {id: 'full', name: '完全权限'},
        ]}), setPermission: (value: string) => {mode.current = value;}};
      h.handles.push(handle); return handle;
    });
    await h.state.permissionPreferences.set(h.legacyContext(), 'read-only');
    await h.bridge.accept(h.event('one'));
    expect(modes[0]?.current).toBe('read-only');
    modes[0]!.current = 'full'; // The App changed the first native session.
    await h.bridge.accept(h.event('two'));
    expect(modes[1]?.current).toBe('full');
    expect(await h.state.permissionPreferences.get(h.legacyContext())).toBe('full');
    const first = (await h.topics())[0]!;
    await h.bridge.accept(h.event('/permission use workspace', {thread_id: first.threadId}));
    await h.bridge.accept(h.event('three'));
    expect(modes[2]?.current).toBe('workspace');
    const second = (await h.topics())[1]!;
    await h.bridge.accept(h.event('back to two', {thread_id: second.threadId}));
    expect(modes[1]?.current).toBe('workspace');
  });

  it.each(['p2p', 'group'] as const)('inherits a %s model choice into each fresh topic without changing existing topics', async type => {
    const h = await fixture();
    const make = type === 'p2p' ? h.event : h.group;
    const source = make('one');
    const legacy = h.legacyContext(source);
    const initial = {provider: 'offline', model: 'chosen', reasoningEffort: 'deep'};
    await h.state.modelPreferences.set(legacy, initial);
    await h.bridge.accept(source);
    expect(h.create.mock.calls[0]?.[0]).toMatchObject(initial);
    const first = (await h.topics(source))[0]!;
    const perTopic = {provider: 'offline', model: 'another', reasoningEffort: 'quick'};
    await h.state.modelPreferences.set({ownerKey: first.ownerKey, conversationKey: first.conversationKey}, perTopic);
    await h.bridge.accept(make('/new', {thread_id: first.threadId}));
    const next = (await h.topics(source))[1]!;
    await h.bridge.accept(make('two', {thread_id: next.threadId}));
    expect(h.create.mock.calls[1]?.[0]).toMatchObject(perTopic);
    const entry = {...legacy, conversationKey: createHash('sha256').update(JSON.stringify([legacy.conversationKey, 'lark-entry-v1'])).digest('hex')};
    await h.state.modelPreferences.set(entry, {provider: 'offline', model: 'new-main-choice'});
    await h.bridge.accept(make('three'));
    expect(h.create.mock.calls[2]?.[0]).toMatchObject({provider: 'offline', model: 'new-main-choice'});
    expect((await h.state.modelPreferences.get({ownerKey: first.ownerKey, conversationKey: first.conversationKey}))?.selection).toEqual(perTopic);
  });

  it('keeps App model sharing on the host default for new topics', async () => {
    const h = await fixture();
    h.runtime.sharesModelSelection = () => true;
    await h.state.modelPreferences.set(h.legacyContext(), {provider: 'stale', model: 'old-copy'});
    await h.bridge.accept(h.event('new App topic'));
    expect(h.create.mock.calls[0]?.[0]).toMatchObject({mode: 'harness', provider: undefined, model: undefined});
    const topic = (await h.topics())[0]!;
    expect(await h.state.modelPreferences.get({ownerKey: topic.ownerKey, conversationKey: topic.conversationKey})).toBeUndefined();
  });

  it('coalesces concurrent legacy navigation from independent topic queues', async () => {
    const h = await fixture();
    const saved = await h.state.sessions.add(h.legacyContext(), randomUUID(), 'legacy');
    await h.bridge.accept(h.event('one')); await h.bridge.accept(h.event('two'));
    const [one, two] = await h.topics();
    const opening = deferred<TopicReceipt>();
    h.openTopic.mockImplementationOnce(async () => opening.promise);
    const first = h.bridge.accept(h.event(`/resume ${saved.id}`, {thread_id: one!.threadId}));
    const second = h.bridge.accept(h.event(`/resume ${saved.id}`, {thread_id: two!.threadId}));
    await vi.waitFor(() => expect(h.openTopic).toHaveBeenCalledTimes(3));
    opening.resolve({threadId: 'omt_legacy', messageId: 'om_legacy'});
    await Promise.all([first, second]);
    expect(h.openTopic).toHaveBeenCalledTimes(3);
    expect((await h.topics()).filter(topic => topic.sessionId === saved.id)).toHaveLength(1);
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('does not hold unrelated topic intake behind a queued /new command', async () => {
    const h = await fixture();
    await h.bridge.accept(h.event('one'));
    const firstTopic = (await h.topics())[0]!;
    const running = deferred<string>();
    h.handles[0]!.run.mockImplementationOnce(async () => running.promise);
    const turn = h.bridge.accept(h.event('long task', {thread_id: firstTopic.threadId}));
    await vi.waitFor(() => expect(h.handles[0]!.run).toHaveBeenCalledTimes(2));
    const next = h.bridge.accept(h.event('/new', {thread_id: firstTopic.threadId}));
    await h.bridge.accept(h.event('unrelated task', {thread_id: 'omt_external'}));
    expect(h.create).toHaveBeenCalledTimes(2);
    await h.bridge.accept(h.event('/stop', {thread_id: firstTopic.threadId}));
    running.resolve('stopped');
    await Promise.all([turn, next]);
    // /stop also cancels the queued /new and cannot affect the external topic.
    expect(h.openTopic).toHaveBeenCalledOnce();
    expect(h.handles[1]!.cancel).not.toHaveBeenCalled();
  });

  it('never creates a topic before queue admission or runs a model after binding publication fails', async () => {
    const h = await fixture();
    h.config.maxSessions = 1;
    await h.bridge.accept(h.event('one'));
    await h.bridge.accept(h.event('two'));
    expect(h.openTopic).toHaveBeenCalledOnce();
    expect(h.reply.mock.calls.at(-1)?.[1]).toContain('会话数量已达到上限');
    const failed = await fixture();
    vi.spyOn(failed.state.topics, 'record').mockRejectedValueOnce(new Error('publication is unknown'));
    const source = failed.event('publication failure');
    await failed.bridge.accept(source); await failed.bridge.accept(source);
    expect(failed.openTopic).toHaveBeenCalledOnce();
    expect(failed.create).not.toHaveBeenCalled(); expect(failed.reply).not.toHaveBeenCalled();
  });

  it('drains a confirmed opening during shutdown without starting a native session afterward', async () => {
    const h = await fixture();
    const opening = deferred<TopicReceipt>();
    h.openTopic.mockImplementationOnce(async () => opening.promise);
    const accepted = h.bridge.accept(h.event('pending opening'));
    await vi.waitFor(() => expect(h.openTopic).toHaveBeenCalledOnce());
    const stopped = h.bridge.stop();
    opening.resolve({threadId: 'omt_pending', messageId: 'om_pending'});
    await Promise.all([accepted, stopped]);
    expect(h.create).not.toHaveBeenCalled(); expect(h.reply).not.toHaveBeenCalled();
    expect((await h.topics())[0]?.threadId).toBe('omt_pending');
    expect((await h.topics())[0]?.sessionId).toBeUndefined();
  });

  it('honors group mentions, separates owners, and hides private topics from the group picker', async () => {
    const h = await fixture();
    await h.bridge.accept(h.event('private secret'));
    await h.bridge.accept(h.event('no mention', {chat_type: 'group', chat_id: 'oc_group'}));
    expect(h.create).toHaveBeenCalledOnce();
    const groupEvent = h.group('group task');
    await h.bridge.accept(groupEvent);
    const aliceTopic = (await h.topics(groupEvent))[0]!;
    await h.bridge.accept(h.group('bob enters', {sender_id: 'ou_bob', thread_id: aliceTopic.threadId}));
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.reply.mock.calls.at(-1)?.[1]).toContain('开始你自己的话题');
    const bobEvent = h.group('bob task', {sender_id: 'ou_bob'});
    await h.bridge.accept(bobEvent);
    expect((await h.topics(bobEvent))).toHaveLength(1);
    await h.bridge.accept(h.group('/sessions detail'));
    const text = h.reply.mock.calls.at(-1)?.[1];
    expect(text).toContain('group task'); expect(text).not.toContain('private secret'); expect(text).not.toContain('bob task');
  });

  it('invalidates old group topics after a disclosure change and creates a fresh sibling', async () => {
    const h = await fixture();
    const privateContext = {...h.legacyContext(), privateChat: true};
    const memory = await h.state.memories.add(privateContext, 'personal', 'private background');
    await h.state.memories.setGroupShared(privateContext, memory.id, true);
    const first = h.group('with shared context');
    await h.bridge.accept(first);
    const old = (await h.topics(first))[0]!;
    await h.state.memories.setGroupShared(privateContext, memory.id, false);
    await h.bridge.accept(h.group('try old context', {thread_id: old.threadId}));
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.reply.mock.calls.at(-1)?.[1]).toContain('旧上下文已停用');
    await h.bridge.accept(h.group('/sessions detail'));
    expect(h.reply.mock.calls.at(-1)?.[1]).not.toContain('with shared context');
    await h.bridge.accept(h.group('/new', {thread_id: old.threadId}));
    const next = (await h.topics(first)).find(topic => topic.threadId !== old.threadId)!;
    await h.bridge.accept(h.group('fresh', {thread_id: next.threadId}));
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('does not infer a topic from quoted replies and never starts work after unknown creation', async () => {
    const h = await fixture();
    h.openTopic.mockRejectedValueOnce(new Error('unknown outcome'));
    const first = h.event('unknown');
    await h.bridge.accept(first); await h.bridge.accept(first);
    expect(h.openTopic).toHaveBeenCalledOnce(); expect(h.create).not.toHaveBeenCalled(); expect(h.reply).not.toHaveBeenCalled();
    await h.bridge.accept(h.event('a quoted main-chat request', {root_id: 'om_other', reply_to: 'om_other'}));
    expect(h.openTopic).toHaveBeenCalledTimes(2);
    expect(h.openTopic.mock.calls[1]?.[0]).toHaveProperty('messageId');
  });

  it('derives topic ownership and session selection from the server rather than extra receipt fields', async () => {
    const h = await fixture();
    const receipt = {threadId: 'omt_confirmed', messageId: 'om_confirmed', ownerKey: 'f'.repeat(64),
      chatKey: 'e'.repeat(64), sessionId: 'deadbeef0001'};
    h.openTopic.mockResolvedValueOnce(receipt);
    await h.bridge.accept(h.event('verified owner'));
    const binding = (await h.topics())[0]!;
    expect(binding.ownerKey).not.toBe(receipt.ownerKey); expect(binding.chatKey).not.toBe(receipt.chatKey);
    expect(binding.sessionId).not.toBe(receipt.sessionId);
    expect(h.handles[0]!.run).toHaveBeenCalledOnce();
  });

  it('supports the private menu without replying to a fabricated message ID', async () => {
    const h = await fixture();
    h.config.maxSessions = 1; h.config.maxSessionsPerUser = 1;
    await h.state.directChats.record('ou_alice', 'oc_alice');
    await h.bridge.accept({type: 'application.bot.menu_v6', operator_open_id: 'ou_alice', event_id: 'evt_new',
      app_id: 'cli_example', event_key: 'dsh.new'});
    expect(h.openTopic).toHaveBeenCalledWith({chatId: 'oc_alice'}, '新话题', expect.any(Object));
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.sendUser).toHaveBeenCalledOnce();
    expect(h.create).not.toHaveBeenCalled();
    const topic = (await h.topics())[0]!;
    await h.bridge.accept(h.event('question in the new topic', {thread_id: topic.threadId}));
    expect(h.create).toHaveBeenCalledOnce();
  });

  it('updates the clicked history card when creating a topic for a legacy session', async () => {
    const h = await fixture(); h.transport.replyRich = h.replyRich;
    const saved = await h.state.sessions.add(h.legacyContext(), randomUUID(), 'legacy');
    const token = h.state.actions.issue({ownerId: 'ou_alice', chatId: 'oc_alice', chatType: 'p2p', threadId: '',
      sourceMessageId: 'om_history', command: `/resume ${saved.id}`, expectedSessionId: null});
    await h.bridge.accept({type: 'card.action.trigger', action_tag: 'button', event_id: 'evt_resume', operator_id: 'ou_alice',
      chat_id: 'oc_alice', message_id: 'om_history', action_value: JSON.stringify({token})});
    expect(h.openTopic.mock.calls[0]?.[0]).toEqual({chatId: 'oc_alice'});
    expect(h.reply).not.toHaveBeenCalled(); expect(h.replyRich).not.toHaveBeenCalled();
    expect(h.updateFeedback).toHaveBeenCalledWith('om_history', expect.objectContaining({kind: 'card', fallbackText: expect.stringContaining('打开话题继续')}));
    expect(h.resume).not.toHaveBeenCalled();
  });
});
