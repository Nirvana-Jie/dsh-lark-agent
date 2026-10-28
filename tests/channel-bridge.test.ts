import { createHash, randomUUID } from 'node:crypto';
import {ownerKey} from '../src/message.js';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotBridge } from '../src/bridge.js';
import { CardActions } from '../src/card-actions.js';
import { parseConfig } from '../src/config.js';
import type { AgentPolicy, ModelSelection, RuntimeContinuation, RuntimeSession, TurnObserver } from '../src/dsh-runtime.js';
import { DiskLedger } from '../src/ledger.js';
import { MemoryStore } from '../src/memory-store.js';
import type { ReplyPayload } from '../src/replies.js';
import { SessionStore } from '../src/session-store.js';
import { ModelPreferencesStore } from '../src/model-preferences.js';
import { modelChoiceKey, thinkingChoiceKey } from '../src/model-controls.js';
import { DshRuntimeError } from '../src/dsh-runtime.js';
import { PermissionPreferencesStore } from '../src/permission-preferences.js';
import { TopicStore } from '../src/topic-store.js';

const directories: string[] = [];
const LATER = 365 * 24 * 60 * 60_000;
const bridges = new Set<BotBridge>();
let sequence = 0;
type Run = RuntimeSession['run'];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...bridges].map(bridge => bridge.stop().catch(() => undefined)));
  bridges.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

function event(text: string, extra: Record<string, unknown> = {}) {
  return {type: 'im.message.receive_v1', message_id: `om_channel${++sequence}`, message_type: 'text',
    sender_id: 'ou_alice', sender_type: 'user', chat_id: 'oc_alice', chat_type: 'p2p', content: text, ...extra};
}

function group(text: string) {
  return event(`@DSH ${text}`, {chat_id: 'oc_group', chat_type: 'group', mentions: [{key: '@_user_1', id: 'ou_bot', name: 'DSH'}]});
}

function callback(token: string, extra: Record<string, unknown> = {}) {
  return {type: 'card.action.trigger', event_id: `ev_channel${++sequence}`, operator_id: 'ou_alice', message_id: 'om_card',
    chat_id: 'oc_alice', host: 'im_message', action_tag: 'button', action_value: JSON.stringify({token}), ...extra};
}

function tokens(payload: ReplyPayload | undefined): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.type === 'callback' && object.value && typeof object.value === 'object' && 'token' in object.value
      && typeof object.value.token === 'string') found.push(object.value.token);
    Object.values(object).forEach(visit);
  };
  if (payload?.kind === 'card') visit(payload.card);
  return found;
}

// Both models offer the same thinking levels, so a stale card's level would apply to either.
const EFFORTS = [{id: 'low', name: '低'}, {id: 'high', name: '高'}];
const PERMISSIONS = [{id: 'read-only', name: '仅可查看'}, {id: 'workspace-write', name: '工作区内修改'}, {id: 'danger-full-access', name: '完全权限'}];

async function setup(options: {run?: Run; streaming?: boolean; cards?: boolean; createCardEntity?: () => Promise<string>; permissions?: boolean; models?: boolean; defaultPreset?: string; initialPermission?: string; shared?: boolean; turnTimeoutMs?: number; topics?: boolean; menus?: boolean; maxPendingPerSession?: number} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-channel-bridge-'));
  directories.push(directory);
  const workspace = join(directory, 'alice');
  await mkdir(workspace, {recursive: true});
  const config = parseConfig({profile: 'channel-test', botOpenId: 'ou_bot', stateDir: join(directory, 'state'),
    cardInteractions: options.cards ?? true, streamingCards: options.streaming ?? true, loadingReaction: true, botMenu: options.menus ?? false,
    ...(options.turnTimeoutMs ? {turnTimeoutMs: options.turnTimeoutMs} : {}),
    ...(options.maxPendingPerSession ? {maxPendingPerSession: options.maxPendingPerSession} : {}),
    users: [{openId: 'ou_alice', direct: true, directMode: 'harness', groupChats: ['oc_group'], cwd: workspace}]});
  const sessions = await SessionStore.open(config.stateDir);
  const memories = await MemoryStore.open(config.stateDir);
  const actions = await CardActions.open(config.stateDir, 'channel-test:ou_bot');
  const ledger = await DiskLedger.open(config.stateDir);
  const run = vi.fn<Run>(options.run ?? (async () => '普通回答'));
  const policies: AgentPolicy[] = [];
  const hostRecord: {model: string; reasoningEffort?: string} = {model: 'm'};
  const defaultModel = (): ModelSelection => ({provider: 'p', model: hostRecord.model,
    ...(hostRecord.reasoningEffort ? {reasoningEffort: hostRecord.reasoningEffort} : {})});
  const continuationListeners = new Map<string, (turn: RuntimeContinuation) => Promise<void>>();
  const handles: Array<RuntimeSession & {setPermission?: ReturnType<typeof vi.fn>; changeInApp?: (next: string) => void;
    setModelSelection?: ReturnType<typeof vi.fn>; checkpoint: ReturnType<typeof vi.fn>; changeModelInApp?: (next: ModelSelection) => void}> = [];
  const handle = (policy: AgentPolicy, id: string = randomUUID()): RuntimeSession => {
    policies.push(policy);
    let current = options.initialPermission ?? 'workspace-write';
    let selection: ModelSelection = policy.provider && policy.model ? {provider: policy.provider, model: policy.model,
      ...(policy.reasoningEffort ? {reasoningEffort: policy.reasoningEffort} : {})} : defaultModel();
    const value = {id, run: (...args: Parameters<Run>) => run(...args), checkpoint: vi.fn(async () => undefined), cancel: vi.fn(), dispose: vi.fn(async () => undefined),
      onContinuation: vi.fn((listener: (turn: RuntimeContinuation) => Promise<void>) => {
        continuationListeners.set(id, listener);
        return () => continuationListeners.delete(id);
      }),
      ...(options.models ? {modelSelection: () => ({...selection}), setModelSelection: vi.fn((next: ModelSelection) => { selection = {...next}; }),
        sharesModelSelection: Boolean(options.shared), changeModelInApp: (next: ModelSelection) => { selection = {...next}; }} : {}),
      ...(options.permissions ? {permissionState: () => ({current, options: PERMISSIONS, ...(options.defaultPreset ? {defaultPreset: options.defaultPreset} : {})}),
        setPermission: vi.fn((next: string) => { current = next; }),
        // What a change made in the App on this session looks like from here.
        changeInApp: (next: string) => { current = next; }} : {})};
    handles.push(value);
    return value;
  };
  const runtime = {create: vi.fn(async (policy: AgentPolicy) => handle(policy)), resume: vi.fn(async (policy: AgentPolicy, id: string) => handle(policy, id)),
    ...(options.permissions ? {permissionOptions: () => PERMISSIONS, permissionDefault: () => options.defaultPreset ?? 'workspace-write'} : {}),
    ...(options.models ? {catalog: async () => ({models: [{provider: 'p', providerName: 'Provider', model: 'm', name: 'Model', reasoning: {efforts: EFFORTS}},
      {provider: 'p', providerName: 'Provider', model: 'n', name: 'Model N', reasoning: {efforts: EFFORTS}}], defaultSelection: defaultModel()}),
      resolveModelSelection: async (selection?: ModelSelection) => selection ?? defaultModel()} : {}),
    ...(options.shared ? {sharesModelSelection: () => true, saveDefaultModel: vi.fn(async (selection: ModelSelection) => {
      hostRecord.model = selection.model; hostRecord.reasoningEffort = selection.reasoningEffort;
    })} : {})};
  let feedbackCount = 0;
  let topicCount = 0;
  const transport = {
    reply: vi.fn(async (_id: string, _text: string, _options: unknown) => undefined),
    replyRich: vi.fn(async (_id: string, _payload: ReplyPayload, _options: unknown) => undefined),
    sendRichUser: vi.fn(async (_id: string, _payload: ReplyPayload, _options: unknown) => undefined),
    createFeedback: vi.fn(async (_target: unknown, _payload: ReplyPayload, _options: unknown) => `om_feedback${++feedbackCount}`),
    updateFeedback: vi.fn(async (_id: string, _payload: ReplyPayload) => undefined),
    createCardEntity: vi.fn(options.createCardEntity ?? (async () => '7355')),
    replyCardEntity: vi.fn(async () => undefined),
    streamCardText: vi.fn(async () => undefined),
    updateCardEntity: vi.fn(async (_id: string, _card: Record<string, unknown>, _sequence: number) => undefined),
    replyFile: vi.fn(async (_id: string, _path: string, _options: {idempotencyKey: string; inThread: boolean; image: boolean}) => undefined),
    ...(options.topics ? {openTopic: vi.fn(async () => {
      const index = ++topicCount;
      return {threadId: `omt_topic_${index}`, messageId: `om_topic_${index}`};
    })} : {}),
  };
  const progress = {startProgress: vi.fn(async () => 'reaction'), finishProgress: vi.fn(async () => undefined)};
  const audit = vi.fn();
  const permissionPreferences = options.permissions ? await PermissionPreferencesStore.open(config.stateDir) : undefined;
  const modelPreferences = options.models ? await ModelPreferencesStore.open(config.stateDir) : undefined;
  const topics = options.topics ? await TopicStore.open(config.stateDir) : undefined;
  const bridge = new BotBridge(config, runtime, transport, ledger, {sessions, memories, actions,
    ...(options.menus ? {directChats: {get: async () => 'oc_alice', record: async () => undefined}} : {}),
    ...(topics ? {topics} : {}),
    ...(permissionPreferences ? {permissionPreferences} : {}), ...(modelPreferences ? {modelPreferences} : {})}, audit, progress);
  bridge.setCardActionsReady(true);
  bridges.add(bridge);
  const sentText = () => [...transport.reply.mock.calls.map(call => call[1]),
    ...transport.replyRich.mock.calls.map(call => call[1].kind === 'text' ? call[1].text : call[1].kind === 'post' ? call[1].markdown : call[1].fallbackText)];
  const finalCard = () => JSON.stringify(transport.updateCardEntity.mock.calls.at(-1)?.[1] ?? {});
  const continueTurn = async (index: number, turn: RuntimeContinuation) => continuationListeners.get(handles[index]!.id)?.(turn);
  return {bridge, run, runtime, policies, handles, transport, progress, audit, actions, workspace, sentText, finalCard, permissionPreferences, modelPreferences, config, sessions, topics, hostRecord, continueTurn, continuationListeners, ledger};
}

function hostTurn(id: string, run: RuntimeContinuation['run'] = async () => 'continuation result') {
  return {id, pending: true, run: vi.fn(run), cancel: vi.fn()};
}

describe('topic settings drafts and defaults', () => {
  type Harness = Awaited<ReturnType<typeof setup>>;
  const options = {topics: true, models: true, permissions: true, shared: true, streaming: false};
  const latest = (h: Harness) => h.transport.updateFeedback.mock.calls.at(-1)![1];
  const commandToken = (h: Harness, panel: ReplyPayload, suffix: string) => tokens(panel)
    .find(token => h.actions.verify(token)?.command.endsWith(suffix))!;
  const edit = async (h: Harness, field: 'model' | 'thinking' | 'permission', value: string) => {
    const token = commandToken(h, latest(h), ` ${field}`);
    expect(token).toBeTruthy();
    await h.bridge.accept(callback(token, {action_tag: 'select_static', action_name: `dsh_settings_${field}`, option: value}));
  };
  const save = async (h: Harness) => h.bridge.accept(callback(commandToken(h, latest(h), ' save')));
  const open = async (h: Harness, thread = 'omt_topic_1') => {
    await h.bridge.accept(event('/settings', {thread_id: thread}));
    // Direct commands send a new card; selectors and Save update this confirmed card.
    const panel = h.transport.replyRich.mock.calls.at(-1)![1];
    const token = commandToken(h, panel, ' model');
    await h.bridge.accept(callback(token, {action_tag: 'select_static', action_name: 'dsh_settings_model', option: modelChoiceKey({provider: 'p', model: 'm'})}));
  };

  const standaloneChanges = [
    ['model', modelChoiceKey({provider: 'p', model: 'n'})],
    ['thinking', thinkingChoiceKey('high')],
    ['permission', 'read-only'],
  ] as const;
  it.each(standaloneChanges.flatMap(([field, value]) => [undefined, '', `dsh_settings_${field}`].map(name => ({field, value, name}))))(
    'enables Save after a standalone $field callback with name=$name', async ({field, value, name}) => {
    const h = await setup(options);
    await h.bridge.accept(event('task A'));
    await h.bridge.accept(event('/settings', {thread_id: 'omt_topic_1'}));
    const panel = h.transport.replyRich.mock.calls.at(-1)![1];
    expect(commandToken(h, panel, ' save')).toBeUndefined();
    const before = h.transport.updateFeedback.mock.calls.length;
    // Standalone selector events can omit action_name; the signed callback
    // already identifies which draft field receives option.
    const token = commandToken(h, panel, ` ${field}`);
    for (const extra of [{action_name: 'wrong'}, {action_name: 42}, {operator_id: 'ou_other'}, {chat_id: 'oc_other'}, {option: '/new'}]) {
      await h.bridge.accept(callback(token, {action_tag: 'select_static', option: value, ...extra}));
    }
    expect(h.transport.updateFeedback).toHaveBeenCalledTimes(before);
    await h.bridge.accept(callback(token, {action_tag: 'select_static', ...(name === undefined ? {} : {action_name: name}), option: value}));
    expect(h.transport.updateFeedback).toHaveBeenCalledTimes(before + 1);
    expect(commandToken(h, latest(h), ' save')).toBeTruthy();
    expect(h.handles[0]!.modelSelection!()).toMatchObject({model: 'm'});
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
    await save(h);
    if (field === 'model') expect(h.handles[0]!.modelSelection!()).toMatchObject({model: 'n'});
    else if (field === 'thinking') expect(h.handles[0]!.modelSelection!()).toMatchObject({reasoningEffort: 'high'});
    else expect(h.handles[0]!.permissionState!()!.current).toBe('read-only');
  });

  it('disables Save again when a selection returns to the original value', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A')); await open(h);
    await edit(h, 'thinking', thinkingChoiceKey('high'));
    expect(commandToken(h, latest(h), ' save')).toBeTruthy();
    await edit(h, 'thinking', 'default');
    expect(commandToken(h, latest(h), ' save')).toBeUndefined();
    expect(h.handles[0]!.modelSelection!().reasoningEffort).toBeUndefined();
  });

  it('saves new-topic defaults after an unnamed standalone selection', async () => {
    const h = await setup(options); await h.bridge.accept(event('/settings defaults'));
    const panel = h.transport.replyRich.mock.calls.at(-1)![1];
    await h.bridge.accept(callback(commandToken(h, panel, ' thinking'), {action_tag: 'select_static', action_name: '', option: thinkingChoiceKey('high')}));
    expect(commandToken(h, latest(h), ' save')).toBeTruthy();
    expect(h.runtime.saveDefaultModel).not.toHaveBeenCalled();
    await save(h);
    expect(h.runtime.saveDefaultModel).toHaveBeenCalledWith({provider: 'p', model: 'm', reasoningEffort: 'high'});
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('已保存新话题默认')});
  });

  it('keeps model, thinking and permission edits as a draft until one atomic save', async () => {
    const h = await setup(options);
    await h.bridge.accept(event('task A'));
    await open(h);
    const context = await topicContext(h);
    const baseline = await h.modelPreferences!.get(context);
    await edit(h, 'model', modelChoiceKey({provider: 'p', model: 'n'}));
    await edit(h, 'thinking', thinkingChoiceKey('high'));
    await edit(h, 'permission', 'read-only');
    expect(h.handles[0]!.modelSelection!()).toMatchObject({model: 'm'});
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
    expect((await h.modelPreferences!.get(context))?.revision).toBe(baseline?.revision);
    await save(h);
    expect(h.handles[0]!.modelSelection!()).toMatchObject({model: 'n', reasoningEffort: 'high'});
    expect(h.handles[0]!.permissionState!()!.current).toBe('read-only');
    expect(h.runtime.saveDefaultModel).not.toHaveBeenCalled();
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('下一轮生效')});
    const reopened = await ModelPreferencesStore.open(h.config.stateDir);
    expect(await reopened.get(context)).toMatchObject({selection: {model: 'n', reasoningEffort: 'high'}, permissionPreset: 'read-only'});
  });

  it('reports an unavailable default before attempting to create a topic', async () => {
    const h = await setup(options);
    h.runtime.resolveModelSelection = async () => {throw new DshRuntimeError('INVALID_MODEL_SELECTION');};
    await h.bridge.accept(event('task A'));
    expect(h.transport.openTopic).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.sentText()).toContain(new DshRuntimeError('INVALID_MODEL_SELECTION').message);
  });

  function ownerKeyFor(h: Harness) {return ownerKey({senderId: 'ou_alice', chatId: 'oc_alice', chatType: 'p2p', threadId: '', messageId: 'om_test', text: ''}, h.config);}
  async function topicContext(h: Harness) {
    const scope = {ownerKey: ownerKeyFor(h), chatKey: createHash('sha256').update(JSON.stringify([h.config.profile, h.config.botOpenId, 'p2p', 'oc_alice'])).digest('hex')};
    const binding = (await h.topics!.list(scope))[0]!;
    return {ownerKey: binding.ownerKey, conversationKey: binding.conversationKey};
  }

  it('cancels unsaved edits without changing the native session', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A')); await open(h);
    await edit(h, 'model', modelChoiceKey({provider: 'p', model: 'n'}));
    await edit(h, 'permission', 'read-only');
    const before = h.handles[0]!.setModelSelection!.mock.calls.length;
    await h.bridge.accept(callback(commandToken(h, latest(h), ' cancel')));
    expect(h.handles[0]!.setModelSelection).toHaveBeenCalledTimes(before);
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
    expect(h.runtime.saveDefaultModel).not.toHaveBeenCalled();
  });

  it('offers explicit scopes in the main chat and authorizes the topic picker from saved bindings', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A')); await h.bridge.accept(event('task B'));
    await h.bridge.accept(event('/settings'));
    const root = h.transport.replyRich.mock.calls.at(-1)![1];
    expect(tokens(root).map(token => h.actions.verify(token)?.command)).toEqual(['/settings defaults', '/settings topics']);
    await h.bridge.accept(callback(commandToken(h, root, ' topics')));
    const pick = tokens(latest(h)).find(token => h.actions.verify(token)?.command.startsWith('/settings pick '))!;
    await h.bridge.accept(callback(pick, {action_tag: 'select_static', option: 'omt_other_user'}));
    expect(h.runtime.create).toHaveBeenCalledTimes(2);
    await h.bridge.accept(callback(pick, {action_tag: 'select_static', option: 'omt_topic_2', thread_id: 'omt_topic_1'}));
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('task B')});
    const binding = h.actions.verify(commandToken(h, latest(h), ' model'))!;
    expect(binding.threadId).toBe('omt_topic_2');
  });

  it('freezes defaults when an empty topic is created and keeps existing topics independent', async () => {
    const h = await setup(options);
    await h.bridge.accept(event('task A'));
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('/settings defaults'));
    const panel = h.transport.replyRich.mock.calls.at(-1)![1];
    await h.bridge.accept(callback(commandToken(h, panel, ' model'), {action_tag: 'select_static', action_name: 'dsh_settings_model', option: modelChoiceKey({provider: 'p', model: 'n'})}));
    await edit(h, 'thinking', thinkingChoiceKey('high'));
    await edit(h, 'permission', 'read-only'); await save(h);
    expect(h.runtime.saveDefaultModel).toHaveBeenCalledWith(expect.objectContaining({model: 'n'}));
    await h.bridge.accept(event('first question', {thread_id: 'omt_topic_2'}));
    expect(h.handles[1]!.modelSelection!().model).toBe('m');
    expect(h.handles[1]!.permissionState!()!.current).toBe('workspace-write');
    await h.bridge.accept(event('task C'));
    expect(h.handles[2]!.modelSelection!().model).toBe('n');
    expect(h.handles[2]!.modelSelection!().reasoningEffort).toBe('high');
    expect(h.handles[2]!.permissionState!()!.current).toBe('read-only');
    expect(h.handles[0]!.modelSelection!().model).toBe('m');
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
  });

  it('refreshes an old draft after a model or permission change and rejects forged operators', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A')); await open(h);
    await edit(h, 'model', modelChoiceKey({provider: 'p', model: 'n'}));
    const stale = commandToken(h, latest(h), ' save');
    const calls = h.handles[0]!.setModelSelection!.mock.calls.length;
    await h.bridge.accept(callback(stale, {operator_id: 'ou_other'}));
    expect(h.handles[0]!.setModelSelection).toHaveBeenCalledTimes(calls);
    h.handles[0]!.changeInApp!('read-only');
    await h.bridge.accept(callback(stale));
    expect(h.handles[0]!.modelSelection!().model).toBe('m');
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('设置刚刚变化')});
    expect(JSON.stringify(latest(h))).toContain('read-only');
  });

  it('does not apply an uncheckpointed draft or show success', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A')); await open(h);
    await edit(h, 'model', modelChoiceKey({provider: 'p', model: 'n'}));
    h.handles[0]!.checkpoint.mockRejectedValueOnce(new DshRuntimeError('PERSISTENCE_FAILED'));
    await save(h);
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining(new DshRuntimeError('PERSISTENCE_FAILED').message)});
    expect(JSON.stringify(latest(h))).not.toContain('已保存到');
    expect(h.runtime.saveDefaultModel).not.toHaveBeenCalled();
  });

  it('keeps a busy topic save unconsumed so it can be retried after the turn ends', async () => {
    let release!: (value: string) => void, started!: () => void;
    const gate = new Promise<string>(resolve => {release = resolve;});
    const entered = new Promise<void>(resolve => {started = resolve;});
    const h = await setup(options); await h.bridge.accept(event('task A')); await open(h);
    await edit(h, 'permission', 'read-only');
    const token = commandToken(h, latest(h), ' save');
    h.run.mockImplementationOnce(async () => {started(); return gate;});
    const running = h.bridge.accept(event('long task', {thread_id: 'omt_topic_1'}));
    await entered;
    await h.bridge.accept(callback(token));
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('本轮处理中')});
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
    release('finished'); await running;
    await h.bridge.accept(callback(token));
    expect(h.handles[0]!.permissionState!()!.current).toBe('read-only');
  });

  it('initializes a fresh custom native state from the captured default, while preserving later App custom edits', async () => {
    const h = await setup({...options, initialPermission: 'custom'}); await h.bridge.accept(event('task A'));
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
    h.handles[0]!.changeInApp!('custom');
    await open(h);
    await edit(h, 'model', modelChoiceKey({provider: 'p', model: 'n'})); await save(h);
    expect(h.handles[0]!.permissionState!()!.current).toBe('custom');
    expect(h.handles[0]!.modelSelection!().model).toBe('n');
    await h.bridge.accept(event('task B'));
    expect(h.handles[1]!.permissionState!()!.current).toBe('workspace-write');
  });

  it('keeps App permission edits made while a topic was unloaded instead of replacing them from the mirror', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A'));
    await h.bridge.accept(event('/permission use danger-full-access', {thread_id: 'omt_topic_1'}));
    await h.bridge.sweep(Date.now() + LATER);
    h.runtime.resume.mockImplementationOnce(async () => {
      // The native persistence has advanced in the App while the bridge had no open handle.
      h.handles[0]!.changeInApp!('read-only');
      h.handles[0]!.changeModelInApp!({provider: 'p', model: 'n'});
      return h.handles[0]!;
    });
    await h.bridge.accept(event('continue', {thread_id: 'omt_topic_1'}));
    expect(h.handles[0]!.permissionState!()!.current).toBe('read-only');
    expect(h.handles[0]!.modelSelection!().model).toBe('n');
    expect(await h.modelPreferences!.get(await topicContext(h))).toMatchObject({selection: {model: 'n'}, permissionPreset: 'read-only'});
    expect(h.runtime.saveDefaultModel).not.toHaveBeenCalled();
  });

  it('copies new defaults explicitly and asks for full-access confirmation before saving the topic', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A'));
    await h.bridge.accept(event('/permission use danger-full-access'));
    await open(h);
    await h.bridge.accept(callback(commandToken(h, latest(h), ' copy')));
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
    expect(JSON.stringify(latest(h))).toContain('已有其他话题保留原权限');
    await save(h);
    expect(h.handles[0]!.permissionState!()!.current).toBe('danger-full-access');
    await h.bridge.accept(event('/permission use read-only'));
    await h.bridge.accept(event('continue', {thread_id: 'omt_topic_1'}));
    expect(h.handles[0]!.permissionState!()!.current).toBe('danger-full-access');
  });

  it('reports failure when the explicit App default cannot be saved and leaves the local defaults intact', async () => {
    const h = await setup(options); await h.bridge.accept(event('/settings defaults'));
    const panel = h.transport.replyRich.mock.calls.at(-1)![1];
    await h.bridge.accept(callback(commandToken(h, panel, ' model'), {action_tag: 'select_static', action_name: 'dsh_settings_model', option: modelChoiceKey({provider: 'p', model: 'n'})}));
    await edit(h, 'permission', 'read-only');
    h.runtime.saveDefaultModel!.mockRejectedValueOnce(new DshRuntimeError('MODEL_NOT_SAVED'));
    await save(h);
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining(new DshRuntimeError('MODEL_NOT_SAVED').message)});
    await h.bridge.accept(event('new question'));
    expect(h.handles[0]!.modelSelection!().model).toBe('m');
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
  });

  it('refreshes an expired draft without applying any of its pending selections', async () => {
    const h = await setup(options); await h.bridge.accept(event('task A')); await open(h);
    await edit(h, 'permission', 'read-only');
    const token = commandToken(h, latest(h), ' save');
    vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(Date.now() + 11 * 60_000);
    await h.bridge.accept(callback(token));
    expect(h.handles[0]!.permissionState!()!.current).toBe('workspace-write');
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('设置刚刚变化')});
  });

  it.each(['dsh.model', 'dsh.thinking', 'dsh.permission'])('uses an explicit scope chooser for the context-free %s menu', async key => {
    const h = await setup({...options, menus: true});
    await h.bridge.accept({type: 'application.bot.menu_v6', event_id: `ev_menu${++sequence}`, operator_open_id: 'ou_alice',
      app_id: 'cli_example', event_key: key, thread_id: 'omt_untrusted'});
    const panel = h.transport.sendRichUser.mock.calls.at(-1)![1];
    expect(tokens(panel).map(token => h.actions.verify(token)?.command)).toEqual(['/settings defaults', '/settings topics']);
    expect(tokens(panel).every(token => h.actions.verify(token)?.threadId === '')).toBe(true);
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('preserves the model menu for an administrator-restricted private assistant', async () => {
    const h = await setup({...options, menus: true}); h.config.users[0]!.directMode = 'restricted';
    await h.bridge.accept({type: 'application.bot.menu_v6', event_id: `ev_menu${++sequence}`, operator_open_id: 'ou_alice', app_id: 'cli_example', event_key: 'dsh.model'});
    const panel = h.transport.sendRichUser.mock.calls.at(-1)![1];
    expect(panel).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('选择模型')});
    expect(tokens(panel).some(token => h.actions.verify(token)?.command.startsWith('/model use '))).toBe(true);
    expect(h.runtime.saveDefaultModel).not.toHaveBeenCalled();
  });

  it('binds both the topic entry and the finished live reply settings button to the confirmed topic', async () => {
    const h = await setup({...options, streaming: true}); await h.bridge.accept(event('task A'));
    const entry = latest(h);
    expect(h.actions.verify(commandToken(h, entry, '/settings'))).toMatchObject({threadId: 'omt_topic_1', sourceMessageId: 'om_topic_1'});
    const final = h.transport.updateCardEntity.mock.calls.at(-1)![1];
    const token = tokens({kind: 'card', card: final, fallbackText: ''}).find(token => h.actions.verify(token)?.command === '/settings')!;
    expect(h.actions.verify(token)).toMatchObject({threadId: 'omt_topic_1'});
    expect(JSON.stringify(final)).toContain('本话题设置');
  });

  it('opens topic settings from the entry even when the live reply falls back to ordinary text', async () => {
    const h = await setup({...options, streaming: true, createCardEntity: async () => {throw new Error('CardKit unavailable');}});
    await h.bridge.accept(event('task A'));
    const token = commandToken(h, latest(h), '/settings');
    expect(h.actions.verify(token)).toMatchObject({threadId: 'omt_topic_1', sourceMessageId: 'om_topic_1'});
    expect(h.sentText()).toContain('普通回答');
    await h.bridge.accept(callback(token));
    expect(latest(h)).toMatchObject({kind: 'card', fallbackText: expect.stringContaining('话题设置 · task A')});
    expect(h.actions.verify(commandToken(h, latest(h), ' model'))).toMatchObject({threadId: 'omt_topic_1'});
    expect(h.runtime.create).toHaveBeenCalledTimes(1);
  });

  it('captures one complete default snapshot while another lane is saving new defaults', async () => {
    const h = await setup(options); await h.bridge.accept(event('/settings defaults'));
    const panel = h.transport.replyRich.mock.calls.at(-1)![1];
    await h.bridge.accept(callback(commandToken(h, panel, ' model'), {action_tag: 'select_static', action_name: 'dsh_settings_model', option: modelChoiceKey({provider: 'p', model: 'n'})}));
    await edit(h, 'permission', 'read-only');
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const entered = new Promise<void>(resolve => {started = resolve;});
    h.runtime.saveDefaultModel!.mockImplementationOnce(async selection => {h.hostRecord.model = selection.model; started(); await gate;});
    const saving = save(h); await entered;
    const asking = h.bridge.accept(event('concurrent new topic'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.runtime.create).not.toHaveBeenCalled();
    release(); await Promise.all([saving, asking]);
    expect(h.handles[0]!.modelSelection!().model).toBe('n');
    expect(h.handles[0]!.permissionState!()!.current).toBe('read-only');
    expect(await h.modelPreferences!.get(await topicContext(h))).toMatchObject({selection: {model: 'n'}, permissionPreset: 'read-only'});
  });
});

describe('BotBridge harness channel', () => {
  it('runs the owner private chat as a harness session and keeps group chats restricted', async () => {
    const h = await setup({streaming: false});
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(group('hello group'));
    expect(h.policies.map(policy => policy.mode)).toEqual(['harness', 'restricted']);
    expect(h.run.mock.calls[0]![3]).toEqual({approve: expect.any(Function), ask: expect.any(Function)});
    // A restricted session gets no channel hooks at all.
    expect(h.run.mock.calls[1]).toHaveLength(3);
  });

  it('streams a private reply into one live card instead of a typing reaction and a text reply', async () => {
    const h = await setup({run: async (_text, _signal, _context, observer) => {
      observer!.stream!({type: 'attempt'});
      observer!.stream!({type: 'reasoning', text: '先查资料'});
      observer!.stream!({type: 'text', text: '结论'});
      return {text: '结论：可以。', artifacts: [], reasoning: '先查资料'};
    }});
    await h.bridge.accept(event('帮我调研'));
    expect(h.transport.createCardEntity).toHaveBeenCalledOnce();
    expect(h.transport.replyCardEntity).toHaveBeenCalledWith(expect.stringMatching(/^om_channel/), '7355', expect.objectContaining({inThread: false}));
    expect(h.finalCard()).toContain('结论：可以。');
    expect(h.finalCard()).toContain('"streaming_mode":false');
    expect(h.sentText()).toEqual([]);
    expect(h.progress.startProgress).not.toHaveBeenCalled();
  });

  it('delivers a late subagent continuation to the same thread with its own live card and updated file', async () => {
    const h = await setup();
    const original = event('review this', {thread_id: 'omt_review'});
    await h.bridge.accept(original);
    const report = join(h.workspace, 'report.md');
    await writeFile(report, 'updated report');
    const turn: RuntimeContinuation = {id: `${h.handles[0]!.id}:2`, pending: true, cancel: vi.fn(), run: vi.fn(async (_signal, _context, observer) => {
      observer?.stream?.({type: 'attempt'});
      observer?.stream?.({type: 'text', text: 'updated report'});
      return {text: 'updated report', artifacts: [], files: [{path: report, description: 'Revised report'}]};
    })};
    await h.continueTurn(0, turn);
    expect(h.finalCard()).toContain('updated report');
    expect(h.transport.replyCardEntity).toHaveBeenCalledTimes(2);
    const cards = h.transport.replyCardEntity.mock.calls as unknown as Array<[string, string, {idempotencyKey: string; inThread: boolean}]>;
    expect(cards.map(call => [call[0], call[2].inThread])).toEqual([[original.message_id, true], [original.message_id, true]]);
    expect(cards[1]![2].idempotencyKey).not.toBe(cards[0]![2].idempotencyKey);
    expect(h.transport.replyFile).toHaveBeenCalledExactlyOnceWith(original.message_id, await realpath(report), expect.objectContaining({inThread: true}));
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.sentText()).toEqual([]);
  });

  it('keeps continuations in their own native topic when the owner starts a sibling topic', async () => {
    const h = await setup({topics: true, streaming: false});
    await h.bridge.accept(event('first task'));
    await h.bridge.accept(event('second task'));
    const first = hostTurn(`${h.handles[0]!.id}:2`, async () => 'first task revised');
    const second = hostTurn(`${h.handles[1]!.id}:2`, async () => 'second task revised');
    await h.continueTurn(0, first);
    await h.continueTurn(1, second);
    expect(h.transport.openTopic).toHaveBeenCalledTimes(2);
    expect(h.transport.replyRich.mock.calls.slice(-2).map(call => [call[0], call[1], call[2]]))
      .toEqual([
        ['om_topic_1', expect.any(Object), expect.objectContaining({inThread: true})],
        ['om_topic_2', expect.any(Object), expect.objectContaining({inThread: true})],
      ]);
    expect(h.sentText().slice(-2)).toEqual(['first task revised', 'second task revised']);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('serializes ordinary messages behind a continuation and claims each host turn once', async () => {
    const h = await setup({streaming: false});
    const original = event('first', {thread_id: 'omt_review'});
    await h.bridge.accept(original);
    let finish!: (result: string) => void;
    const turn = hostTurn(`${h.handles[0]!.id}:2`, async () => new Promise<string>(resolve => {finish = resolve;}));
    const continuation = h.continueTurn(0, turn);
    await vi.waitFor(() => expect(turn.run).toHaveBeenCalledOnce());
    const incoming = h.bridge.accept(event('next', {thread_id: 'omt_review'}));
    expect(h.run).toHaveBeenCalledOnce();
    finish('late result');
    await Promise.all([continuation, incoming]);
    expect(h.sentText()).toEqual(['普通回答', 'late result', '普通回答']);
    await h.continueTurn(0, turn);
    expect(turn.run).toHaveBeenCalledOnce();
    expect(h.sentText()).toHaveLength(3);
  });

  it('cancels a running continuation and its queued successors through the original topic stop command', async () => {
    const h = await setup();
    await h.bridge.accept(event('first', {thread_id: 'omt_review'}));
    const turn = hostTurn(`${h.handles[0]!.id}:2`, (signal, _context, observer) => new Promise((_resolve, reject) => {
      observer?.stream?.({type: 'text', text: 'working'});
      signal.addEventListener('abort', () => reject(new DshRuntimeError('CANCELLED')), {once: true});
    }));
    const running = h.continueTurn(0, turn);
    await vi.waitFor(() => expect(turn.run).toHaveBeenCalledOnce());
    const next = hostTurn(`${h.handles[0]!.id}:3`);
    const queued = h.continueTurn(0, next);
    await h.bridge.accept(event('/stop', {thread_id: 'omt_review'}));
    await Promise.all([running, queued]);
    expect(h.finalCard()).toContain('已停止。');
    expect(next.run).not.toHaveBeenCalled();
    expect(next.cancel).toHaveBeenCalled();
    expect(h.sentText()).toEqual(['已请求停止当前处理，排队消息已取消。']);
  });

  it('rejects continuations at queue capacity and after unloading or stopping, and never subscribes group sessions', async () => {
    const h = await setup({streaming: false, maxPendingPerSession: 1});
    await h.bridge.accept(event('first'));
    const oldListener = h.continuationListeners.get(h.handles[0]!.id)!;
    let finish!: (result: string) => void;
    const first = hostTurn(`${h.handles[0]!.id}:2`, async () => new Promise<string>(resolve => {finish = resolve;}));
    const running = h.continueTurn(0, first);
    await vi.waitFor(() => expect(first.run).toHaveBeenCalledOnce());
    const full = hostTurn(`${h.handles[0]!.id}:3`);
    await h.continueTurn(0, full);
    expect(full.run).not.toHaveBeenCalled(); expect(full.cancel).toHaveBeenCalled();
    finish('done'); await running;
    await h.bridge.accept(event('/new'));
    const stale = hostTurn(`${h.handles[0]!.id}:4`);
    await oldListener(stale);
    expect(stale.run).not.toHaveBeenCalled(); expect(stale.cancel).toHaveBeenCalled();
    await h.bridge.accept(group('restricted'));
    expect(h.continuationListeners.size).toBe(0);
    await h.bridge.stop();
    const stopped = hostTurn(`${h.handles[0]!.id}:5`);
    await oldListener(stopped);
    expect(stopped.run).not.toHaveBeenCalled(); expect(stopped.cancel).toHaveBeenCalled();
  });

  it('does not acknowledge or continue an uncheckpointed host result', async () => {
    const h = await setup({streaming: false});
    await h.bridge.accept(event('first'));
    h.handles[0]!.checkpoint.mockRejectedValueOnce(new DshRuntimeError('PERSISTENCE_FAILED'));
    await h.continueTurn(0, hostTurn(`${h.handles[0]!.id}:2`, async () => 'unsafe uncheckpointed result'));
    expect(h.sentText()).not.toContain('unsafe uncheckpointed result');
    const later = hostTurn(`${h.handles[0]!.id}:3`);
    await h.continueTurn(0, later);
    expect(later.run).not.toHaveBeenCalled();
    expect(later.cancel).toHaveBeenCalled();
    expect(h.handles[0]!.cancel).toHaveBeenCalled();
  });

  it('keeps a continuation send with an unknown outcome to a single attempt', async () => {
    const h = await setup({streaming: false});
    await h.bridge.accept(event('first'));
    h.transport.replyRich.mockRejectedValueOnce(new Error('unknown send outcome'));
    const turn = hostTurn(`${h.handles[0]!.id}:2`);
    await h.continueTurn(0, turn);
    await h.continueTurn(0, turn);
    expect(turn.run).toHaveBeenCalledOnce();
    expect(h.transport.replyRich).toHaveBeenCalledTimes(2);
    expect(h.transport.reply).not.toHaveBeenCalled();
  });

  it('skips a queued continuation already consumed by a preparing incoming reply', async () => {
    const h = await setup();
    await h.bridge.accept(event('first'));
    const turn = {...hostTurn(`${h.handles[0]!.id}:2`), pending: false};
    await h.continueTurn(0, turn);
    expect(turn.run).not.toHaveBeenCalled();
    expect(h.transport.replyCardEntity).toHaveBeenCalledOnce();
  });

  it('falls back to ordinary replies, and stops trying for a while, when a live card cannot be created', async () => {
    const h = await setup({createCardEntity: async () => { throw new Error('missing cardkit scope'); }});
    await h.bridge.accept(event('first'));
    await h.bridge.accept(event('second'));
    expect(h.transport.createCardEntity).toHaveBeenCalledOnce();
    expect(h.sentText()).toEqual(['普通回答', '普通回答']);
  });

  it('finalizes the live card when the owner stops the turn', async () => {
    const h = await setup({run: (_text, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
    })});
    const turn = h.bridge.accept(event('long task'));
    await vi.waitFor(() => expect(h.transport.replyCardEntity).toHaveBeenCalled());
    await h.bridge.accept(event('/stop'));
    await turn;
    expect(h.finalCard()).toContain('已停止。');
    expect(h.sentText()).toEqual(['已请求停止当前处理，排队消息已取消。']);
  });

  it('lets an owner turn run past a configured cap that still bounds a group turn', async () => {
    const h = await setup({turnTimeoutMs: 1000, run: (_text, signal) => new Promise((resolve, reject) => {
      const done = setTimeout(() => resolve('长任务完成'), 5_000);
      signal.addEventListener('abort', () => { clearTimeout(done); reject(new DshRuntimeError('CANCELLED')); }, {once: true});
    })});
    vi.useFakeTimers({shouldAdvanceTime: true});
    const owner = h.bridge.accept(event('long task'));
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await owner;
    expect(h.run.mock.calls[0]![1].aborted).toBe(false);
    expect(h.finalCard()).toContain('长任务完成');
    expect(h.finalCard()).not.toContain('超时');
    const restricted = h.bridge.accept(group('long group task'));
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_001);
    await restricted;
    expect(h.run.mock.calls[1]![1].aborted).toBe(true);
    expect(h.sentText()).toEqual([expect.stringContaining('超时')]);
  });

  it('asks for approval with a card and resumes the waiting turn on a click from outside its queue', async () => {
    const h = await setup({streaming: false, run: async (_text, signal, _context, observer) =>
      await observer!.approve!({toolName: 'bash', reason: 'Writes outside the sandbox', detail: '{\n  "command": "rm -rf build"\n}'}, signal)
        ? '已清理。' : '没有执行。'});
    const turn = h.bridge.accept(event('清理构建目录'));
    await vi.waitFor(() => expect(h.transport.createFeedback).toHaveBeenCalled());
    const card = h.transport.createFeedback.mock.calls[0]![1];
    expect(JSON.stringify(card)).toContain('rm -rf build');
    const [allow, deny] = tokens(card).map(token => ({token, command: h.actions.verify(token)!.command}));
    expect(allow!.command).toMatch(/^\/approve [a-f0-9]{12}$/);
    expect(deny!.command).toMatch(/^\/deny [a-f0-9]{12}$/);
    await h.bridge.accept(callback(allow!.token));
    await turn;
    expect(h.sentText()).toEqual(['已清理。']);
    expect(JSON.stringify(h.transport.updateFeedback.mock.calls[0]![1])).toContain('已允许这一次。');
    expect(tokens(h.transport.updateFeedback.mock.calls[0]![1])).toEqual([]);
    // The decision was one-shot; a repeated click finds nothing to answer.
    await h.bridge.accept(callback(deny!.token));
    expect(h.sentText()).toContain('这张卡片已经失效。需要的话，直接在聊天里告诉我。');
  });

  it('denies on a deny click, after five minutes, and when card interactions are unavailable', async () => {
    const decide = async (_text: string, signal: AbortSignal, _context: unknown, observer?: TurnObserver) =>
      await observer!.approve!({toolName: 'bash'}, signal) ? 'ran' : 'denied';
    const h = await setup({streaming: false, run: decide});
    const turn = h.bridge.accept(event('first'));
    await vi.waitFor(() => expect(h.transport.createFeedback).toHaveBeenCalled());
    const deny = tokens(h.transport.createFeedback.mock.calls[0]![1]).find(token => h.actions.verify(token)!.command.startsWith('/deny '))!;
    await h.bridge.accept(callback(deny));
    await turn;
    expect(h.sentText()).toEqual(['denied']);

    vi.useFakeTimers({shouldAdvanceTime: true});
    const waiting = h.bridge.accept(event('second'));
    await vi.waitFor(() => expect(h.transport.createFeedback).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await waiting;
    expect(h.sentText()).toEqual(['denied', 'denied']);
    expect(JSON.stringify(h.transport.updateFeedback.mock.calls.at(-1)![1])).toContain('5 分钟内没有确认');
    vi.useRealTimers();

    const noCards = await setup({streaming: false, cards: false, run: decide});
    await noCards.bridge.accept(event('third'));
    expect(noCards.transport.createFeedback).not.toHaveBeenCalled();
    expect(noCards.sentText()).toEqual(['denied']);
  });

  it('answers a short single choice with one tap', async () => {
    const h = await setup({streaming: false, run: async (_text, signal, _context, observer) => {
      const answers = await observer!.ask!([{id: 'mode', question: 'Which mode?', options: [{label: 'Fast (Recommended)'}, {label: 'Careful'}], multiSelect: false}], signal);
      return JSON.stringify(answers);
    }});
    const turn = h.bridge.accept(event('start'));
    await vi.waitFor(() => expect(h.transport.createFeedback).toHaveBeenCalled());
    const choices = tokens(h.transport.createFeedback.mock.calls[0]![1]).map(token => h.actions.verify(token)!.command);
    expect(choices).toHaveLength(3);
    expect(choices[2]).toMatch(/^\/choose [a-f0-9]{12} 2$/);
    const careful = tokens(h.transport.createFeedback.mock.calls[0]![1])[1]!;
    await h.bridge.accept(callback(careful));
    await turn;
    expect(h.sentText()).toEqual([JSON.stringify([{id: 'mode', selected: ['Careful']}])]);
    expect(JSON.stringify(h.transport.updateFeedback.mock.calls[0]![1])).toContain('已回答：Careful');
  });

  it('answers several questions with a form and maps positional fields back to the original labels', async () => {
    const h = await setup({streaming: false, run: async (_text, signal, _context, observer) => JSON.stringify(await observer!.ask!([
      {id: 'langs', question: 'Which languages?', options: [{label: 'TypeScript'}, {label: 'Go'}, {label: 'Rust'}], multiSelect: true},
      {id: 'name', question: 'Project name?', options: [], multiSelect: false},
    ], signal))});
    const turn = h.bridge.accept(event('scaffold'));
    await vi.waitFor(() => expect(h.transport.createFeedback).toHaveBeenCalled());
    const [submit] = tokens(h.transport.createFeedback.mock.calls[0]![1]);
    expect(h.actions.verify(submit!)!.command).toMatch(/^\/reply [a-f0-9]{12}$/);
    // A forged field is rejected and the question stays open.
    await h.bridge.accept(callback(submit!, {action_name: 'dsh_submit', form_value: JSON.stringify({q0: ['o9']})}));
    expect(h.sentText()).toEqual(['这次选择无效，请在卡片上重新选择后提交。']);
    await h.bridge.accept(callback(submit!, {action_name: 'dsh_submit', form_value: JSON.stringify({q0: ['o0', 'o2'], c0: '', c1: 'lark-agent'})}));
    await turn;
    expect(h.sentText().at(-1)).toBe(JSON.stringify([{id: 'langs', selected: ['TypeScript', 'Rust']}, {id: 'name', selected: [], custom: 'lark-agent'}]));
  });

  it('sends presented workspace files and only names files it may not upload', async () => {
    const h = await setup({streaming: false});
    await writeFile(join(h.workspace, 'report.pdf'), 'pdf');
    await writeFile(join(h.workspace, 'chart.png'), 'png');
    await writeFile(join(h.workspace, 'empty.txt'), '');
    const outside = join(h.workspace, '..', 'secret.txt');
    await writeFile(outside, 'private');
    h.run.mockResolvedValue({text: '整理好了。', artifacts: [], files: [
      {path: join(h.workspace, 'report.pdf'), description: '报告'}, {path: join(h.workspace, 'chart.png'), description: ''},
      {path: outside, description: ''}, {path: join(h.workspace, 'empty.txt'), description: ''}, {path: join(h.workspace, 'missing.csv'), description: ''},
    ]});
    await h.bridge.accept(event('出报告'));
    const real = await realpath(h.workspace);
    expect(h.transport.replyFile.mock.calls.map(call => [call[1], call[2].image])).toEqual([
      [join(real, 'report.pdf'), false], [join(real, 'chart.png'), true]]);
    const note = h.sentText().at(-1)!;
    expect(note).toContain('有 3 个文件没有发到这里');
    expect(note).toContain('secret.txt：不在这个私聊的工作区内，没有上传');
    expect(note).toContain('empty.txt：是空文件');
    expect(note).toContain('missing.csv：找不到这个文件');
    expect(h.sentText()[0]).toBe('整理好了。');
  });
});

describe('harness channel help', () => {
  it('tells the owner what the private channel can do, and keeps group help unchanged', async () => {
    const h = await setup({streaming: false});
    await h.bridge.accept(event('/help'));
    await h.bridge.accept(group('/help'));
    const [own, inGroup] = h.sentText();
    expect(own).toContain('这里连着你电脑上的 Harness');
    expect(inGroup).not.toContain('Harness');
  });
});

describe('harness channel permission switch', () => {
  const rich = (h: Awaited<ReturnType<typeof setup>>) => h.transport.replyRich.mock.calls.map(call => call[1]);

  it.each(['sibling topic', 'main chat'] as const)('keeps the original topic choice when settings change in the %s', async source => {
    const h = await setup({topics: true, permissions: true, streaming: false});
    await h.bridge.accept(event('task A'));
    await h.bridge.accept(event('/permission use danger-full-access', {thread_id: 'omt_topic_1'}));
    expect(h.handles[0]!.permissionState!()!.current).toBe('danger-full-access');
    if (source === 'sibling topic') await h.bridge.accept(event('task B'));
    await h.bridge.accept(event('/permission use read-only', source === 'sibling topic' ? {thread_id: 'omt_topic_2'} : {}));
    // The command only changed its own lane. A has not received another user message.
    expect(h.handles[0]!.permissionState!()!.current).toBe('danger-full-access');
    const observed: string[] = [];
    const turn = hostTurn(`${h.handles[0]!.id}:2`, async () => {
      observed.push(h.handles[0]!.permissionState!()!.current);
      return 'continued with current permissions';
    });
    await h.continueTurn(0, turn);
    expect(turn.run).toHaveBeenCalledOnce();
    expect(observed).toEqual(['danger-full-access']);
    expect(h.sentText().at(-1)).toBe('continued with current permissions');
    expect(h.handles[0]!.setPermission!.mock.calls.map(call => call[0])).toEqual(['danger-full-access']);
  });

  it('keeps an App permission change within the original topic during a continuation', async () => {
    const h = await setup({topics: true, permissions: true, streaming: false});
    await h.bridge.accept(event('task A'));
    await h.bridge.accept(event('/permission use danger-full-access', {thread_id: 'omt_topic_1'}));
    h.handles[0]!.changeInApp!('read-only');
    const turn = hostTurn(`${h.handles[0]!.id}:2`);
    await h.continueTurn(0, turn);
    expect(h.handles[0]!.permissionState!()!.current).toBe('read-only');
    expect(h.handles[0]!.setPermission).toHaveBeenCalledExactlyOnceWith('danger-full-access');
    await h.bridge.accept(event('task B'));
    expect(h.handles[1]!.permissionState!()!.current).toBe('workspace-write');
    expect(turn.run).toHaveBeenCalledOnce();
  });

  it('cancels a continuation before model work when the current permission choice cannot be applied', async () => {
    const h = await setup({topics: true, permissions: true, streaming: false});
    await h.bridge.accept(event('task A'));
    await h.bridge.accept(event('/permission use danger-full-access', {thread_id: 'omt_topic_1'}));
    const scope = {ownerKey: ownerKey({senderId: 'ou_alice', chatId: 'oc_alice', chatType: 'p2p', threadId: '', messageId: 'om_test', text: ''}, h.config),
      chatKey: createHash('sha256').update(JSON.stringify([h.config.profile, h.config.botOpenId, 'p2p', 'oc_alice'])).digest('hex')};
    const binding = (await h.topics!.list(scope))[0]!;
    await h.permissionPreferences!.set({ownerKey: binding.ownerKey, conversationKey: binding.conversationKey}, 'read-only');
    h.handles[0]!.setPermission!.mockImplementationOnce(() => {throw new DshRuntimeError('PERMISSION_UNAVAILABLE');});
    const turn = hostTurn(`${h.handles[0]!.id}:2`);
    await h.continueTurn(0, turn);
    expect(turn.run).not.toHaveBeenCalled();
    expect(turn.cancel).toHaveBeenCalled();
    expect(h.handles[0]!.permissionState!()!.current).toBe('danger-full-access');
    expect(h.sentText().at(-1)).toBe(new DshRuntimeError('PERMISSION_UNAVAILABLE').message);
  });

  it('switches on the clicked card itself, with a second confirmation for full access, and keeps it for new sessions', async () => {
    const h = await setup({streaming: false, permissions: true});
    await h.bridge.accept(event('hello'));
    expect(h.handles[0]!.setPermission).not.toHaveBeenCalled();
    await h.bridge.accept(event('/permission'));
    const panel = rich(h).at(-1)!;
    expect(JSON.stringify(panel)).toContain('当前：工作区内修改');
    // The current mode is shown, not offered.
    const buttons = tokens(panel).map(token => ({token, command: h.actions.verify(token)!.command}));
    expect(buttons.map(button => button.command)).toEqual(['/permission use read-only', '/permission use danger-full-access']);
    expect(JSON.stringify(panel)).toContain('✓ 工作区内修改');
    expect(JSON.stringify(panel)).toContain('切换到「完全权限」？');
    const sent = h.transport.replyRich.mock.calls.length;
    await h.bridge.accept(callback(buttons[1]!.token));
    expect(h.handles[0]!.setPermission).toHaveBeenCalledExactlyOnceWith('danger-full-access');
    // No second card: the clicked card turns green, with the new mode and fresh buttons.
    expect(h.transport.replyRich).toHaveBeenCalledTimes(sent);
    const [target, updated] = h.transport.updateFeedback.mock.calls.at(-1)!;
    expect(target).toBe('om_card');
    expect(updated.kind === 'card' && (updated.card.header as {template: string}).template).toBe('green');
    expect(JSON.stringify(updated)).toContain('已切换到「完全权限」');
    expect(tokens(updated).map(token => h.actions.verify(token)!.command)).toEqual(['/permission use read-only', '/permission use workspace-write']);
    // A one-time button cannot switch again.
    await h.bridge.accept(callback(buttons[1]!.token));
    expect(h.handles[0]!.setPermission).toHaveBeenCalledOnce();
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('next topic'));
    expect(h.handles[1]!.setPermission).toHaveBeenCalledExactlyOnceWith('danger-full-access');
  });

  it('starts a new session on the App default preset when the chat has no choice of its own', async () => {
    const h = await setup({streaming: false, permissions: true, defaultPreset: 'danger-full-access'});
    await h.bridge.accept(event('hello'));
    expect(h.handles[0]!.setPermission).toHaveBeenCalledExactlyOnceWith('danger-full-access');
    // A resumed session keeps what it recorded.
    await h.bridge.sweep(Date.now() + 365 * 24 * 60 * 60_000);
    await h.bridge.accept(event('again'));
    expect(h.runtime.resume).toHaveBeenCalledOnce();
    expect(h.handles[1]!.setPermission).not.toHaveBeenCalled();
  });

  it('takes a mode changed in the App on the live session as the chat\'s choice', async () => {
    const h = await setup({streaming: false, permissions: true});
    await h.bridge.accept(event('hello'));
    h.handles[0]!.changeInApp!('read-only');
    await h.bridge.accept(event('/permission'));
    expect(JSON.stringify(rich(h).at(-1))).toContain('当前：仅可查看');
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('next topic'));
    expect(h.handles[1]!.setPermission).toHaveBeenCalledExactlyOnceWith('read-only');
  });

  it('keeps a mode changed in the App when a new topic starts or the session goes idle', async () => {
    const h = await setup({streaming: false, permissions: true});
    await h.bridge.accept(event('hello'));
    h.handles[0]!.changeInApp!('read-only');
    // Straight to a new topic, without another turn or a look at the panel first.
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('next topic'));
    expect(h.handles[1]!.setPermission).toHaveBeenCalledExactlyOnceWith('read-only');
    h.handles[1]!.changeInApp!('danger-full-access');
    await h.bridge.sweep(Date.now() + LATER);
    await h.bridge.accept(event('again'));
    expect(h.runtime.resume).toHaveBeenCalledOnce();
    expect(h.handles[2]!.setPermission).toHaveBeenCalledExactlyOnceWith('danger-full-access');
  });

  it('reaches the switch from the model settings panel', async () => {
    const h = await setup({streaming: false, permissions: true, models: true});
    await h.bridge.accept(event('/model'));
    const commands = tokens(rich(h).at(-1)).map(token => h.actions.verify(token)!.command);
    expect(commands).toContain('/permission');
  });

  it('keeps permission switching to the owner private chat', async () => {
    const h = await setup({streaming: false, permissions: true});
    await h.bridge.accept(group('/permission'));
    expect(h.sentText()).toEqual(['权限模式只能在你和我的私聊里切换。']);
  });
});

describe('harness model shared with the App', () => {
  const rich = (h: Awaited<ReturnType<typeof setup>>) => h.transport.replyRich.mock.calls.map(call => call[1]);
  const pick = (h: Awaited<ReturnType<typeof setup>>, payload: ReplyPayload | undefined, model: string) =>
    tokens(payload).find(token => h.actions.verify(token)!.command === `/model use ${modelChoiceKey({provider: 'p', model})}`)!;

  it('records a Feishu switch in the live session and makes it the App default, on the clicked card', async () => {
    const h = await setup({streaming: false, models: true, shared: true});
    await h.bridge.accept(event('hello'));
    // A new shared session starts on the host default, not on a copy kept by the chat.
    expect(h.policies[0]!.model).toBeUndefined();
    await h.bridge.accept(event('/model'));
    await h.bridge.accept(callback(pick(h, rich(h).at(-1), 'n')));
    expect(h.handles[0]!.setModelSelection).toHaveBeenCalledExactlyOnceWith({provider: 'p', model: 'n'});
    expect(h.handles[0]!.checkpoint).toHaveBeenCalled();
    expect(h.runtime.saveDefaultModel).toHaveBeenCalledExactlyOnceWith({provider: 'p', model: 'n'});
    const [target, updated] = h.transport.updateFeedback.mock.calls.at(-1)!;
    expect(target).toBe('om_card');
    expect(JSON.stringify(updated)).toContain('当前模型：Model N');
  });

  it('shows and keeps a model picked in the App for the live session', async () => {
    const h = await setup({streaming: false, models: true, shared: true});
    await h.bridge.accept(event('hello'));
    h.handles[0]!.changeModelInApp!({provider: 'p', model: 'n'});
    await h.bridge.accept(event('/model'));
    expect(JSON.stringify(rich(h).at(-1))).toContain('当前模型：Model N');
    // The next turn keeps the App's pick instead of forcing the chat's older copy back.
    await h.bridge.accept(event('next'));
    expect(h.handles[0]!.setModelSelection).not.toHaveBeenCalled();
    expect(h.runtime.saveDefaultModel).not.toHaveBeenCalled();
  });

  it('opens the saved session to record a switch made while it was idle', async () => {
    const h = await setup({streaming: false, models: true, shared: true});
    await h.bridge.accept(event('hello'));
    await h.bridge.sweep(Date.now() + 365 * 24 * 60 * 60_000);
    await h.bridge.accept(event('/model'));
    // Showing the menu does not reopen the session.
    expect(h.runtime.resume).not.toHaveBeenCalled();
    await h.bridge.accept(callback(pick(h, rich(h).at(-1), 'n')));
    expect(h.runtime.resume).toHaveBeenCalledOnce();
    expect(h.handles[1]!.setModelSelection).toHaveBeenCalledExactlyOnceWith({provider: 'p', model: 'n'});
  });

  const level = (h: Awaited<ReturnType<typeof setup>>, payload: ReplyPayload | undefined, effort: string) =>
    tokens(payload).find(token => h.actions.verify(token)!.command === `/thinking use ${thinkingChoiceKey(effort)}`)!;
  const template = (payload: ReplyPayload) => payload.kind === 'card' ? (payload.card.header as {template: string}).template : undefined;

  it('refreshes a thinking card instead of applying it after the App switched the live model', async () => {
    const h = await setup({streaming: false, models: true, shared: true});
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/thinking'));
    const card = rich(h).at(-1);
    h.handles[0]!.changeModelInApp!({provider: 'p', model: 'n'});
    await h.bridge.accept(callback(level(h, card, 'high')));
    expect(h.handles[0]!.setModelSelection).not.toHaveBeenCalled();
    const [target, refreshed] = h.transport.updateFeedback.mock.calls.at(-1)!;
    expect(target).toBe('om_card');
    expect(JSON.stringify(refreshed)).toContain('设置刚刚变化');
    expect(JSON.stringify(refreshed)).toContain('当前模型：Model N');
  });

  it('refreshes a thinking card when reopening the idle session brings in a newer choice', async () => {
    const h = await setup({streaming: false, models: true, shared: true});
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/thinking'));
    const card = rich(h).at(-1);
    await h.bridge.sweep(Date.now() + LATER);
    // While it was idle, the session's own record moved on in the App.
    h.hostRecord.model = 'n';
    await h.bridge.accept(callback(level(h, card, 'high')));
    expect(h.runtime.resume).toHaveBeenCalledOnce();
    expect(h.handles[1]!.setModelSelection).not.toHaveBeenCalled();
    const refreshed = h.transport.updateFeedback.mock.calls.at(-1)![1];
    expect(template(refreshed)).toBe('blue');
    expect(JSON.stringify(refreshed)).toContain('设置刚刚变化');
  });

  it('reports a pick that only the App default would hold when saving it fails', async () => {
    const h = await setup({streaming: false, models: true, shared: true});
    // No conversation yet: the pick can only live in the App default.
    await h.bridge.accept(event('/model'));
    h.runtime.saveDefaultModel!.mockRejectedValueOnce(new DshRuntimeError('MODEL_NOT_SAVED'));
    await h.bridge.accept(callback(pick(h, rich(h).at(-1), 'n')));
    const failed = h.transport.updateFeedback.mock.calls.at(-1)![1];
    expect(template(failed)).toBe('red');
    expect(JSON.stringify(failed)).toContain('没能保存');
    // With a session the pick is recorded there, so a failed default save is only logged.
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/model'));
    h.runtime.saveDefaultModel!.mockRejectedValueOnce(new DshRuntimeError('MODEL_NOT_SAVED'));
    await h.bridge.accept(callback(pick(h, rich(h).at(-1), 'n')));
    expect(template(h.transport.updateFeedback.mock.calls.at(-1)![1])).toBe('green');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({stage: 'model-default-unsaved'}));
  });

  it('closes and reopens the session before another turn when a pick was not saved', async () => {
    const h = await setup({streaming: false, models: true, shared: true});
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/model'));
    h.handles[0]!.checkpoint.mockRejectedValueOnce(new DshRuntimeError('PERSISTENCE_FAILED'));
    await h.bridge.accept(callback(pick(h, rich(h).at(-1), 'n')));
    expect(template(h.transport.updateFeedback.mock.calls.at(-1)![1])).toBe('red');
    await h.bridge.accept(event('next'));
    // The unconfirmed pick never drives a turn: that session was closed and the saved one reopened.
    expect(h.handles[0]!.dispose).toHaveBeenCalled();
    expect(h.runtime.resume).toHaveBeenCalledOnce();
    expect(h.handles).toHaveLength(2);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('keeps the chat copy for a host that cannot share, and never touches the App default', async () => {
    const h = await setup({streaming: false, models: true});
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/model'));
    await h.bridge.accept(callback(pick(h, rich(h).at(-1), 'n')));
    expect(h.handles[0]!.setModelSelection).toHaveBeenCalledExactlyOnceWith({provider: 'p', model: 'n'});
    expect(h.runtime).not.toHaveProperty('saveDefaultModel');
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('next topic'));
    expect(h.policies.at(-1)).toMatchObject({provider: 'p', model: 'n'});
  });
});
