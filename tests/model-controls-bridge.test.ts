import {createHash, randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BotBridge, type Transport} from '../src/bridge.js';
import {CardActions} from '../src/card-actions.js';
import {parseConfig} from '../src/config.js';
import {DirectChatsStore} from '../src/direct-chats.js';
import {DshRuntimeError, type AgentPolicy, type ModelCatalog, type ModelSelection, type RuntimeSession} from '../src/dsh-runtime.js';
import {DiskLedger} from '../src/ledger.js';
import {MemoryStore} from '../src/memory-store.js';
import {ModelPreferencesStore} from '../src/model-preferences.js';
import {isModelQuestion, modelChoiceKey, thinkingChoiceKey} from '../src/model-controls.js';
import {ownerKey, parseMessage, sessionKey} from '../src/message.js';
import type {ReplyPayload} from '../src/replies.js';
import {SessionStore, SessionStoreError} from '../src/session-store.js';
import {BOT_MENU_EVENT} from '../src/bot-menu.js';
import type {ProgressTransport} from '../src/progress.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename)};
});

const A: ModelSelection = {provider: 'provider-a', model: 'model-a', reasoningEffort: 'high'};
const B: ModelSelection = {provider: 'provider-b', model: 'model-b', reasoningEffort: 'max'};
const C: ModelSelection = {provider: 'provider-a', model: 'model-c'};
const catalogFixture: ModelCatalog = {models: [
  {provider: A.provider, providerName: 'Provider A', model: A.model, name: '模型 Alpha',
    reasoning: {efforts: [{id: 'low', name: '轻快'}, {id: 'high', name: '深入'}], defaultEffort: 'low'}},
  {provider: B.provider, providerName: 'Provider B', model: B.model, name: '模型 Beta',
    reasoning: {efforts: [{id: 'high', name: '高'}, {id: 'max', name: '最高'}], defaultEffort: 'max'}},
  {provider: C.provider, providerName: 'Provider A', model: C.model, name: '模型 Plain'},
]};
const directories: string[] = [];
const bridges = new Set<BotBridge>();
const cleanupHandles: Array<() => void> = [];
const cleanupGates: Array<() => void> = [];
let sequence = 0;
const event = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'im.message.receive_v1', message_id: `om_model${++sequence}`, message_type: 'text',
  sender_id: 'ou_alice', sender_type: 'user', chat_id: 'oc_alice', chat_type: 'p2p', content: text, ...extra,
});
const group = (text: string, extra: Record<string, unknown> = {}) => event(`@DSH ${text}`, {
  chat_id: 'oc_group', chat_type: 'group', mentions: [{key: '@_user_1', id: 'ou_bot', name: 'DSH'}], ...extra,
});
const callback = (token: string, extra: Record<string, unknown> = {}) => ({
  type: 'card.action.trigger', event_id: `ev_model${++sequence}`, operator_id: 'ou_alice', chat_id: 'oc_alice',
  message_id: 'om_model_card', action_tag: 'button', action_value: JSON.stringify({token}), ...extra,
});
const menu = (key: string, extra: Record<string, unknown> = {}) => ({
  type: BOT_MENU_EVENT, event_id: `ev_menu${++sequence}`, operator_open_id: 'ou_alice',
  app_id: 'cli_test', event_key: key, ...extra,
});
const text = (payload: ReplyPayload) => payload.kind === 'text' ? payload.text : payload.kind === 'post' ? payload.markdown : payload.fallbackText;
function tokens(payload: ReplyPayload): string[] {
  const result: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {item.forEach(visit); return;}
    if (!item || typeof item !== 'object') return;
    const value = item as Record<string, unknown>;
    if (value.type === 'callback' && value.value && typeof value.value === 'object' && 'token' in value.value
      && typeof value.value.token === 'string') result.push(value.value.token);
    Object.values(value).forEach(visit);
  };
  if (payload.kind === 'card') visit(payload.card);
  return result;
}

async function setup(existing?: string, hostDefault: ModelSelection = A, botMenu = true, progressTransport?: ProgressTransport) {
  const directory = existing ?? await fs.mkdtemp(join(tmpdir(), 'lark-model-controls-'));
  if (!existing) directories.push(directory);
  const config = parseConfig({profile: 'model-test', botOpenId: 'ou_bot', stateDir: join(directory, 'state'),
    cardInteractions: true, botMenu, loadingReaction: Boolean(progressTransport), users: [
      {openId: 'ou_alice', direct: true, groupChats: ['oc_group'], cwd: join(directory, 'alice')},
      {openId: 'ou_bob', direct: true, groupChats: ['oc_group'], cwd: join(directory, 'bob')},
    ]});
  const [sessions, memories, actions, modelPreferences, directChats, ledger] = await Promise.all([
    SessionStore.open(config.stateDir), MemoryStore.open(config.stateDir), CardActions.open(config.stateDir, 'model-test:ou_bot'),
    ModelPreferencesStore.open(config.stateDir), DirectChatsStore.open(config.stateDir), DiskLedger.open(config.stateDir),
  ]);
  let defaultSelection = {...hostDefault};
  const catalogValue: ModelCatalog = structuredClone(catalogFixture);
  const resolve = (input?: ModelSelection): ModelSelection => {
    const requested = input ?? defaultSelection;
    const model = catalogValue.models.find(item => item.provider === requested.provider && item.model === requested.model);
    if (!model) throw new DshRuntimeError('INVALID_MODEL_SELECTION');
    const effort = requested.reasoningEffort ?? model.reasoning?.defaultEffort;
    if (effort && !model.reasoning?.efforts.some(item => item.id === effort)) throw new DshRuntimeError('INVALID_MODEL_SELECTION');
    return {provider: requested.provider, model: requested.model, ...(effort ? {reasoningEffort: effort} : {})};
  };
  const runLog: Array<{id: string; prompt: string; selection: ModelSelection}> = [];
  const handles: Array<RuntimeSession & {
    run: ReturnType<typeof vi.fn<RuntimeSession['run']>>;
    checkpoint: ReturnType<typeof vi.fn<RuntimeSession['checkpoint']>>;
    setModelSelection: ReturnType<typeof vi.fn<(next: ModelSelection) => void>>;
    dispose: ReturnType<typeof vi.fn<RuntimeSession['dispose']>>;
  }> = [];
  const createHandle = (policy: AgentPolicy, id: string = randomUUID()) => {
    let selection = resolve(policy.provider && policy.model
      ? {provider: policy.provider, model: policy.model, ...(policy.reasoningEffort ? {reasoningEffort: policy.reasoningEffort} : {})} : undefined);
    const handle = {id,
      run: vi.fn<RuntimeSession['run']>(async prompt => {runLog.push({id, prompt, selection: {...selection}}); return '普通回复';}),
      checkpoint: vi.fn(async () => undefined), cancel: vi.fn(), dispose: vi.fn(async () => undefined),
      modelSelection: () => ({...selection}),
      setModelSelection: vi.fn((next: ModelSelection) => {selection = resolve(next);}),
    };
    handles.push(handle); return handle;
  };
  const runtime = {catalog: vi.fn(async () => ({...structuredClone(catalogValue), defaultSelection: {...defaultSelection}})),
    resolveModelSelection: vi.fn(async (selection?: ModelSelection) => resolve(selection)),
    create: vi.fn(async (policy: AgentPolicy) => createHandle(policy)),
    resume: vi.fn(async (policy: AgentPolicy, id: string) => createHandle(policy, id)), handles, runLog};
  const delivered: Array<{kind: 'reply' | 'send'; target: string; payload: ReplyPayload}> = [];
  const transport = {
    reply: vi.fn(async (target: string, value: string) => {delivered.push({kind: 'reply', target, payload: {kind: 'text', text: value}});}),
    replyRich: vi.fn(async (target: string, payload: ReplyPayload) => {delivered.push({kind: 'reply', target, payload});}),
    sendUser: vi.fn(async (target: string, value: string) => {delivered.push({kind: 'send', target, payload: {kind: 'text', text: value}});}),
    sendRichUser: vi.fn(async (target: string, payload: ReplyPayload) => {delivered.push({kind: 'send', target, payload});}),
  };
  const audit = vi.fn();
  const bridge = new BotBridge(config, runtime, transport, ledger, {sessions, memories, actions, modelPreferences, directChats}, audit, progressTransport);
  bridge.setCardActionsReady(true); bridges.add(bridge);
  cleanupHandles.push(() => handles.forEach(handle => handle.dispose.mockResolvedValue(undefined)));
  const context = (raw = event('context')) => {
    const incoming = parseMessage(raw, config.botOpenId)!;
    return {ownerKey: ownerKey(incoming, config), conversationKey: sessionKey(incoming, config), privateChat: incoming.chatType === 'p2p'};
  };
  const sessionContext = async (raw = event('context')) => {
    const c = context(raw);
    if (c.privateChat) return c;
    return {...c, conversationKey: createHash('sha256').update(JSON.stringify([
      c.conversationKey, 'group-memory-v1', await memories.groupAccessKey(c),
    ])).digest('hex')};
  };
  const latest = () => {if (!delivered.length) throw new Error('Expected delivery'); return delivered.at(-1)!.payload;};
  const button = (command: string) => {
    const value = tokens(latest()).find(token => actions.verify(token)?.command === command);
    if (!value) throw new Error(`Missing button ${command}`); return value;
  };
  return {directory, bridge, config, sessions, memories, modelPreferences, directChats, actions, ledger, runtime, transport,
    audit, delivered, latest, button, context, sessionContext, catalogValue, createHandle,
    hostDefault: () => ({...defaultSelection}), changeHostDefault: (next: ModelSelection) => {defaultSelection = {...next};}};
}

afterEach(async () => {
  cleanupGates.splice(0).forEach(release => release());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset(); vi.mocked(fs.rename).mockReset();
  cleanupHandles.splice(0).forEach(cleanup => cleanup());
  try {await Promise.all([...bridges].map(bridge => bridge.stop()));}
  finally {
    bridges.clear();
    await Promise.all(directories.splice(0).map(path => fs.rm(path, {recursive: true, force: true})));
  }
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function gate() {
  const held = deferred();
  cleanupGates.push(() => held.resolve());
  return held;
}
function feedbackTransport(h: Awaited<ReturnType<typeof setup>>) {
  const createFeedback = vi.fn<NonNullable<Transport['createFeedback']>>().mockResolvedValue('om_loading');
  const updateFeedback = vi.fn<NonNullable<Transport['updateFeedback']>>().mockResolvedValue(undefined);
  Object.assign(h.transport, {createFeedback, updateFeedback});
  return {createFeedback, updateFeedback};
}
function slowCatalog(h: Awaited<ReturnType<typeof setup>>) {
  const entered = deferred(), held = gate();
  const original = h.runtime.catalog.getMockImplementation()!;
  h.runtime.catalog.mockImplementationOnce(async () => {entered.resolve(); await held.promise; return original();});
  return {entered: entered.promise, release: () => held.resolve(), reject: held.reject};
}

describe('model controls through the verified bridge', () => {
  it('freezes the actual first selection and restores it after the host default changes', async () => {
    const h = await setup();
    await h.bridge.accept(event('remember this conversation'));
    const original = await h.modelPreferences.get(h.context());
    expect(original?.selection).toEqual(A);
    h.changeHostDefault(B);
    await h.bridge.accept(event('continue'));
    expect(h.runtime.runLog.at(-1)?.selection).toEqual(A);
    await h.bridge.stop(); bridges.delete(h.bridge);
    const restarted = await setup(h.directory, B);
    await restarted.bridge.accept(event('restore after restart'));
    expect(restarted.runtime.create).not.toHaveBeenCalled();
    expect(restarted.runtime.resume).toHaveBeenCalledWith(expect.objectContaining(A), expect.any(String));
    expect(restarted.runtime.runLog.at(-1)?.selection).toEqual(A);
    expect(await restarted.modelPreferences.get(restarted.context())).toEqual(original);
  });

  it('changes a model through a signed card only for the originating owner/chat/thread', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    const native = h.runtime.handles[0]!;
    await h.bridge.accept(event('/model'));
    expect(h.latest().kind).toBe('card');
    expect(text(h.latest())).toContain('模型 Alpha');
    expect(h.runtime.catalog).toHaveBeenCalledTimes(1);
    const token = h.button(`/model use ${modelChoiceKey(B)}`);
    expect(h.actions.verify(token)).toMatchObject({ownerId: 'ou_alice', chatId: 'oc_alice',
      expectedModelRevision: (await h.modelPreferences.get(h.context()))!.revision});
    await h.bridge.accept(callback(token));
    expect(native.setModelSelection).toHaveBeenLastCalledWith(B);
    expect(h.runtime.handles).toHaveLength(1);
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(B);
    expect(h.hostDefault()).toEqual(A);
    await h.bridge.accept(event('use the selected model'));
    expect(h.runtime.runLog.at(-1)).toMatchObject({id: native.id, selection: B});
    const others = [event('bob', {sender_id: 'ou_bob', chat_id: 'oc_bob'}), group('group'), event('thread', {thread_id: 'omt_other'})];
    for (const incoming of others) {
      expect(await h.modelPreferences.get(h.context(incoming))).toBeUndefined();
      await h.bridge.accept(incoming);
      expect((await h.modelPreferences.get(h.context(incoming)))?.selection).toEqual(A);
    }
  });

  it('shows the current model without a button and keeps explicit thinking when it is chosen again', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    const initial = await h.modelPreferences.get(h.context());
    await h.bridge.accept(event('/model'));
    expect(tokens(h.latest()).map(token => h.actions.verify(token)?.command)).not.toContain(`/model use ${modelChoiceKey(A)}`);
    await h.bridge.accept(event(`/model use ${modelChoiceKey(A)}`));
    expect(await h.modelPreferences.get(h.context())).toEqual(initial);
    expect(h.runtime.handles[0]!.setModelSelection).not.toHaveBeenCalled();
  });

  it('puts the provider first so long same-name model buttons remain distinguishable on mobile', async () => {
    const h = await setup();
    for (const model of h.catalogValue.models.slice(0, 2)) model.name = 'DeepSeek Harness Experimental Model';
    await h.bridge.accept(event('/model'));
    const payload = h.latest();
    if (payload.kind !== 'card') throw new Error('Expected model card');
    const labels: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {value.forEach(visit); return;}
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (object.tag === 'button') labels.push((object.text as {content: string}).content);
      Object.values(object).forEach(visit);
    };
    visit(payload.card);
    expect(labels[0]).toMatch(/^✓ Provider A · DeepSeek Harness/);
    expect(labels[1]).toMatch(/^Provider B · DeepSeek Harness/);
    expect(h.actions.verify(h.button(`/model use ${modelChoiceKey(B)}`))?.command).toBe(`/model use ${modelChoiceKey(B)}`);
  });

  it('freezes the model behind the first thinking card before a native session exists', async () => {
    const h = await setup();
    await h.bridge.accept(event('/thinking'));
    const initial = await h.modelPreferences.get(h.context());
    expect(initial?.selection).toEqual(A);
    const token = h.button(`/thinking use ${thinkingChoiceKey('low')}`);
    expect(h.actions.verify(token)?.expectedModelRevision).toBe(initial!.revision);
    h.changeHostDefault(B);
    await h.bridge.accept(callback(token));
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual({...A, reasoningEffort: 'low'});
    expect(h.runtime.create).not.toHaveBeenCalled();
    await h.bridge.accept(event('start with the choice shown on the card'));
    expect(h.runtime.runLog.at(-1)?.selection).toEqual({...A, reasoningEffort: 'low'});
  });

  it('inherits a selected thinking level within a model and resets it only when the model changes', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/thinking'));
    await h.bridge.accept(callback(h.button(`/thinking use ${thinkingChoiceKey('low')}`)));
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual({...A, reasoningEffort: 'low'});
    await h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(B);
    await h.bridge.accept(event('/thinking'));
    await h.bridge.accept(callback(h.button(`/thinking use ${thinkingChoiceKey('high')}`)));
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual({...B, reasoningEffort: 'high'});
  });

  it('rejects a stale settings revision even after returning to the same A selection', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    const initial = await h.modelPreferences.get(h.context());
    await h.bridge.accept(event('/model'));
    const oldToken = h.button(`/model use ${modelChoiceKey(B)}`);
    await h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    await h.bridge.accept(event(`/model use ${modelChoiceKey(A)}`));
    await h.bridge.accept(event(`/thinking use ${thinkingChoiceKey('high')}`));
    const returned = await h.modelPreferences.get(h.context());
    expect(returned?.selection).toEqual(initial?.selection);
    expect(returned?.revision).not.toBe(initial?.revision);
    const before = h.runtime.handles[0]!.setModelSelection.mock.calls.length;
    await h.bridge.accept(callback(oldToken));
    expect(text(h.latest())).toContain('设置已变化');
    expect(h.runtime.handles[0]!.setModelSelection).toHaveBeenCalledTimes(before);
    expect(await h.modelPreferences.get(h.context())).toEqual(returned);
  });

  it('rejects a settings card after the active topic changes', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/model'));
    const token = h.button(`/model use ${modelChoiceKey(B)}`);
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(callback(token));
    expect(text(h.latest())).toContain('会话状态已改变');
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(A);
  });

  it('consumes a settings mutation nonce once, including callbacks with different event IDs', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    await h.bridge.accept(event('/model'));
    const token = h.button(`/model use ${modelChoiceKey(B)}`);
    const save = vi.spyOn(h.modelPreferences, 'set');
    await h.bridge.accept(callback(token));
    const deliveries = h.delivered.length;
    await h.bridge.accept(callback(token));
    expect(save).toHaveBeenCalledTimes(1);
    expect(h.delivered).toHaveLength(deliveries);
  });

  it('rejects forged, cross-user, cross-chat and unsupported callback values without disclosure', async () => {
    const h = await setup();
    await h.bridge.accept(event('/model'));
    const token = h.button(`/model use ${modelChoiceKey(B)}`);
    const initial = await h.modelPreferences.get(h.context());
    const deliveries = h.delivered.length;
    const invalid = [
      callback(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')),
      callback(token, {operator_id: 'ou_bob'}), callback(token, {chat_id: 'oc_bob'}),
      callback(token, {action_tag: 'select_static', option: modelChoiceKey(B)}),
      callback(token, {action_value: JSON.stringify({token, provider: B.provider})}),
    ];
    for (const incoming of invalid) await h.bridge.accept(incoming);
    expect(h.delivered).toHaveLength(deliveries);
    expect(await h.modelPreferences.get(h.context())).toEqual(initial);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('revalidates an option against the current host catalog before applying an old card', async () => {
    const h = await setup();
    await h.bridge.accept(event('/model'));
    const token = h.button(`/model use ${modelChoiceKey(B)}`);
    const initial = await h.modelPreferences.get(h.context());
    h.catalogValue.models = h.catalogValue.models.filter(item => item.model !== B.model);
    await h.bridge.accept(callback(token));
    expect(text(h.latest())).not.toContain('设置已保存');
    expect(await h.modelPreferences.get(h.context())).toEqual(initial);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('keeps the exact saved route visible if the host no longer lists it as a selectable option', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    h.catalogValue.models = h.catalogValue.models.filter(item => item.model !== A.model);
    await h.bridge.accept(event('/model'));
    expect(text(h.latest())).toContain(A.model);
    const commands = tokens(h.latest()).map(token => h.actions.verify(token)?.command);
    expect(commands).not.toContain(`/model use ${modelChoiceKey(A)}`);
    expect(commands).toContain(`/model use ${modelChoiceKey(B)}`);
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(A);
  });

  it('paginates the actual model catalog through signed navigation without changing the choice', async () => {
    const h = await setup();
    h.catalogValue.models.push(...Array.from({length: 4}, (_, index) => ({
      provider: 'extra-provider', providerName: 'Other provider', model: `extra-${index}`, name: `Extra ${index}`,
    })));
    await h.bridge.accept(event('/model'));
    const original = await h.modelPreferences.get(h.context());
    const commands = () => tokens(h.latest()).map(token => h.actions.verify(token)?.command);
    // Five on the page, the current one shown without a button.
    expect(commands().filter(command => command?.startsWith('/model use '))).toHaveLength(4);
    await h.bridge.accept(callback(h.button('/model page 1')));
    expect(commands().filter(command => command?.startsWith('/model use '))).toHaveLength(2);
    expect(commands()).toContain('/model page 0');
    expect(commands()).not.toContain('/model page 2');
    expect(await h.modelPreferences.get(h.context())).toEqual(original);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('paginates supported thinking levels and signs only the visible choices', async () => {
    const h = await setup();
    h.catalogValue.models[0]!.reasoning!.efforts.push(...Array.from({length: 5}, (_, index) => ({id: `extra-${index}`, name: `Extra ${index}`})));
    await h.bridge.accept(event('/thinking'));
    const commands = () => tokens(h.latest()).map(token => h.actions.verify(token)?.command);
    expect(commands().filter(command => command?.startsWith('/thinking use '))).toHaveLength(5);
    await h.bridge.accept(callback(h.button('/thinking page 1')));
    expect(commands().filter(command => command?.startsWith('/thinking use '))).toEqual([`/thinking use ${thinkingChoiceKey('extra-4')}`]);
    expect(commands()).toContain('/thinking page 0');
    await h.bridge.accept(callback(h.button(`/thinking use ${thinkingChoiceKey('extra-4')}`)));
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual({...A, reasoningEffort: 'extra-4'});
  });

  it('preserves the current chat choice through new topics and explicit history restoration', async () => {
    const h = await setup();
    await h.bridge.accept(event('old topic'));
    const old = (await h.sessions.current(h.context()))!;
    await h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('new topic'));
    expect(h.runtime.runLog.at(-1)?.selection).toEqual(B);
    await h.bridge.accept(event(`/thinking use ${thinkingChoiceKey('high')}`));
    await h.bridge.accept(event(`/resume ${old.id}`));
    await h.bridge.accept(event('continue old topic'));
    expect(h.runtime.runLog.at(-1)).toMatchObject({id: old.nativeId, selection: {...B, reasoningEffort: 'high'}});
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual({...B, reasoningEffort: 'high'});
  });

  it('does not change a live model until the previous turn has finished', async () => {
    const h = await setup();
    await h.bridge.accept(event('initial'));
    const handle = h.runtime.handles[0]!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const running = handle.run.mockImplementationOnce(async () => {await gate; return 'done';});
    const first = h.bridge.accept(event('long task'));
    await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(2));
    const change = h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    try {
      await Promise.resolve();
      expect(handle.setModelSelection).not.toHaveBeenCalled();
    } finally {release();}
    await first; await change;
    expect(handle.setModelSelection).toHaveBeenCalledWith(B);
  });

  it.each(['你现在使用的模型是？', '你现在使用的模型是什么？', '你是什么模型？', '当前模型？'])('answers %s from the host without asking the LLM', async question => {
    const h = await setup();
    await h.bridge.accept(event(question));
    expect(text(h.latest())).toContain('模型 Alpha');
    expect(text(h.latest())).toContain('深入');
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
  });

  it('does not intercept a larger task just because it mentions the model', () => {
    expect(isModelQuestion('你现在使用的模型是什么？请顺便比较这份方案。')).toBe(false);
  });

  it('shows no invented reasoning options for a model that does not support them', async () => {
    const h = await setup();
    await h.bridge.accept(event(`/model use ${modelChoiceKey(C)}`));
    await h.bridge.accept(event('/thinking'));
    expect(h.latest().kind).toBe('card');
    expect(text(h.latest())).toContain('没有提供可切换的思考档位');
    const commands = tokens(h.latest()).map(token => h.actions.verify(token)?.command);
    expect(commands).toEqual(['/model']);
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(C);
    await h.bridge.accept(event(`/thinking use ${thinkingChoiceKey('high')}`));
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(C);
  });
});

describe('model control failures remain fail closed', () => {
  it('does not issue a first settings card unless its displayed selection was durably captured', async () => {
    const h = await setup();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).includes('/model-preferences.')) {
        vi.mocked(fs.open).mockImplementation(actual.open);
        throw new Error('private filesystem diagnostics');
      }
      return actual.open(...args);
    });
    await h.bridge.accept(event('/model'));
    expect(text(h.latest())).toContain('未能保存');
    expect(text(h.latest())).not.toContain('private filesystem diagnostics');
    expect(tokens(h.latest())).toEqual([]);
    expect(await h.modelPreferences.get(h.context())).toBeUndefined();
    expect(h.runtime.create).not.toHaveBeenCalled();
    await h.bridge.accept(event('/model'));
    expect(h.latest().kind).toBe('card');
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(A);
  });

  it('does not mutate the native model if the selection cannot be saved', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    const previous = await h.modelPreferences.get(h.context());
    vi.mocked(fs.open).mockRejectedValueOnce(new Error('private filesystem diagnostics'));
    await h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    expect(text(h.latest())).toContain('未能保存');
    expect(text(h.latest())).not.toContain('private filesystem diagnostics');
    expect(h.runtime.handles[0]!.setModelSelection).not.toHaveBeenCalled();
    expect(await h.modelPreferences.get(h.context())).toEqual(previous);
    await h.bridge.accept(event('still using confirmed selection'));
    expect(h.runtime.runLog.at(-1)?.selection).toEqual(A);
  });

  it('blocks later inference after an uncertain save, then restores the durable choice on reopen', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to);
      if (String(to).endsWith('/model-preferences.json')) {
        vi.mocked(fs.rename).mockImplementation(actual.rename);
        throw new Error('publication confirmation lost');
      }
    });
    await h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    expect(text(h.latest())).toContain('保存结果未能确认');
    await h.bridge.accept(event('must not use an uncertain selection'));
    expect(h.runtime.runLog).toHaveLength(1);
    expect(h.runtime.handles[0]!.setModelSelection).not.toHaveBeenCalled();
    await h.bridge.stop(); bridges.delete(h.bridge);
    const reopened = await setup(h.directory, C);
    await reopened.bridge.accept(event('continue with committed selection'));
    expect(reopened.runtime.runLog.at(-1)?.selection).toEqual(B);
  });

  it('unloads a handle that cannot apply a saved choice and resumes with the saved selection', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    const old = h.runtime.handles[0]!;
    old.setModelSelection.mockImplementationOnce(() => {throw new Error('cannot update live selection');});
    await h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(B);
    await h.bridge.accept(event('continue'));
    expect(h.runtime.resume).toHaveBeenLastCalledWith(expect.objectContaining(B), old.id);
    expect(h.runtime.runLog.at(-1)?.selection).toEqual(B);
  });

  it.each(['missing setter', 'failing setter'] as const)('does not acknowledge or resume twice when %s cleanup fails', async mode => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    const old = h.runtime.handles[0]!;
    if (mode === 'missing setter') Reflect.deleteProperty(old, 'setModelSelection');
    else old.setModelSelection.mockImplementation(() => {throw new Error('setter failed');});
    old.dispose.mockRejectedValue(new Error('native still active'));
    await h.bridge.accept(event(`/model use ${modelChoiceKey(B)}`));
    expect(text(h.latest())).not.toContain('设置已保存');
    await h.bridge.accept(event('must remain blocked'));
    expect(h.runtime.create).toHaveBeenCalledTimes(1);
    expect(h.runtime.resume).not.toHaveBeenCalled();
    expect(old.run).toHaveBeenCalledTimes(1);
    old.dispose.mockResolvedValue(undefined);
    await h.bridge.accept(event('continue only after the old native session is closed'));
    expect(h.runtime.resume).toHaveBeenCalledTimes(1);
    expect(h.runtime.resume).toHaveBeenLastCalledWith(expect.objectContaining(B), old.id);
    expect(h.runtime.runLog.at(-1)?.selection).toEqual(B);
  });
});

describe('durable native branch rebinding preserves the user topic', () => {
  async function savedFixture() {
    const original = await setup();
    await original.bridge.accept(event('synthetic branch source'));
    await original.bridge.accept(event('/rename Design notes'));
    const saved = (await original.sessions.current(original.context()))!;
    await original.bridge.stop(); bridges.delete(original.bridge);
    const reopened = await setup(original.directory);
    return {...reopened, saved};
  }

  it('checkpoints a new native branch before rebinding, preserves its stable topic, and resumes only that branch after restart', async () => {
    const h = await savedFixture(), childId = randomUUID(), checkpointEntered = deferred(), checkpointGate = gate();
    const preference = await h.modelPreferences.get(h.context());
    const rebind = vi.spyOn(h.sessions, 'rebindNative');
    h.runtime.resume.mockImplementationOnce(async (policy, id) => {
      expect(id).toBe(h.saved.nativeId);
      const handle = h.createHandle(policy, childId);
      handle.checkpoint.mockImplementationOnce(async () => {checkpointEntered.resolve(); await checkpointGate.promise;});
      return handle;
    });
    const continuing = h.bridge.accept(event('continue on the isolated branch'));
    await checkpointEntered.promise;
    expect((await h.sessions.current(h.context()))?.nativeId).toBe(h.saved.nativeId);
    expect(rebind).not.toHaveBeenCalled(); expect(h.runtime.runLog).toEqual([]);
    checkpointGate.resolve(); await continuing;
    expect(rebind).toHaveBeenCalledExactlyOnceWith(h.context(), h.saved.id, h.saved.nativeId, childId);
    expect(h.runtime.runLog).toEqual([expect.objectContaining({id: childId, prompt: 'continue on the isolated branch'})]);
    expect(await h.sessions.current(h.context())).toMatchObject({id: h.saved.id, nativeId: childId,
      title: h.saved.title, createdAt: h.saved.createdAt});
    expect(await h.sessions.list(h.context())).toHaveLength(1);
    expect(await h.modelPreferences.get(h.context())).toEqual(preference);
    expect((await SessionStore.open(h.config.stateDir).then(store => store.current(h.context())))?.nativeId).toBe(childId);
    await h.bridge.stop(); bridges.delete(h.bridge);

    const restarted = await setup(h.directory, C);
    await restarted.bridge.accept(event('continue after another restart'));
    expect(restarted.runtime.create).not.toHaveBeenCalled();
    expect(restarted.runtime.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(A), childId);
    expect(restarted.runtime.runLog[0]?.id).toBe(childId);
    expect(await restarted.sessions.current(restarted.context())).toMatchObject({id: h.saved.id, title: h.saved.title, nativeId: childId});
  });

  it.each(['message', 'resume'] as const)('keeps the original native route when the branch checkpoint fails on %s', async kind => {
    const h = await savedFixture(), childId = randomUUID();
    const rebind = vi.spyOn(h.sessions, 'rebindNative'), activate = vi.spyOn(h.sessions, 'activate');
    h.runtime.resume.mockImplementationOnce(async policy => {
      const handle = h.createHandle(policy, childId);
      handle.checkpoint.mockRejectedValueOnce(new DshRuntimeError('PERSISTENCE_FAILED'));
      return handle;
    });
    await h.bridge.accept(event(kind === 'message' ? 'must wait for durable history' : `/resume ${h.saved.id}`));
    expect(rebind).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
    expect(h.runtime.handles[0]!.run).not.toHaveBeenCalled();
    expect(h.runtime.handles[0]!.dispose).toHaveBeenCalledOnce();
    expect(await h.sessions.current(h.context())).toEqual(h.saved);
    expect((await SessionStore.open(h.config.stateDir).then(store => store.current(h.context())))?.nativeId).toBe(h.saved.nativeId);
    expect(text(h.latest())).toContain('未能可靠保存');
  });

  it.each(['message', 'resume'] as const)('refuses a stale native binding on %s and releases the unused branch without executing it', async kind => {
    const h = await savedFixture(), childId = randomUUID(), competingId = randomUUID();
    const checkpointEntered = deferred(), checkpointGate = gate();
    h.runtime.resume.mockImplementationOnce(async policy => {
      const handle = h.createHandle(policy, childId);
      handle.checkpoint.mockImplementationOnce(async () => {checkpointEntered.resolve(); await checkpointGate.promise;});
      return handle;
    });
    const activate = vi.spyOn(h.sessions, 'activate');
    const pending = h.bridge.accept(event(kind === 'message' ? 'must not run with a stale route' : `/resume ${h.saved.id}`));
    await checkpointEntered.promise;
    await h.sessions.rebindNative(h.context(), h.saved.id, h.saved.nativeId, competingId);
    checkpointGate.resolve(); await pending;
    expect(h.runtime.handles[0]!.run).not.toHaveBeenCalled();
    expect(h.runtime.handles[0]!.dispose).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(await h.sessions.current(h.context())).toMatchObject({id: h.saved.id, nativeId: competingId, title: h.saved.title});
    expect(text(h.latest())).toContain('会话状态已变化');
  });

  it('rebinds an explicitly selected archived topic before activation while preserving the other history entry', async () => {
    const h = await setup();
    await h.bridge.accept(event('first synthetic topic'));
    await h.bridge.accept(event('/rename Original topic'));
    const old = (await h.sessions.current(h.context()))!;
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('second synthetic topic'));
    const current = (await h.sessions.current(h.context()))!;
    const childId = randomUUID(), rebind = vi.spyOn(h.sessions, 'rebindNative'), activate = vi.spyOn(h.sessions, 'activate');
    h.runtime.resume.mockImplementationOnce(async policy => h.createHandle(policy, childId));
    await h.bridge.accept(event(`/resume ${old.id}`));
    const branch = h.runtime.handles.at(-1)!;
    expect(branch.checkpoint).toHaveBeenCalledOnce(); expect(branch.run).not.toHaveBeenCalled();
    expect(rebind).toHaveBeenCalledExactlyOnceWith(h.context(), old.id, old.nativeId, childId);
    expect(rebind.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]!);
    expect(branch.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(rebind.mock.invocationCallOrder[0]!);
    expect(await h.sessions.current(h.context())).toMatchObject({id: old.id, title: old.title, nativeId: childId, createdAt: old.createdAt});
    const history = await h.sessions.list(h.context());
    expect(history).toHaveLength(2); expect(history.find(item => item.id === current.id)).toEqual(current);
    expect(text(h.latest())).toContain('已恢复');
    await h.bridge.accept(event('continue restored topic'));
    expect(h.runtime.runLog.at(-1)).toMatchObject({id: childId, prompt: 'continue restored topic'});
    expect(h.runtime.resume).toHaveBeenCalledOnce();
  });

  it.each(['message', 'resume'] as const)('fails closed on %s if the storage adapter cannot rebind native IDs', async kind => {
    const h = await savedFixture();
    Object.defineProperty(h.sessions, 'rebindNative', {value: undefined, configurable: true});
    h.runtime.resume.mockImplementationOnce(async policy => h.createHandle(policy));
    await h.bridge.accept(event(kind === 'message' ? 'cannot discard the old binding' : `/resume ${h.saved.id}`));
    expect(h.runtime.handles[0]!.run).not.toHaveBeenCalled(); expect(h.runtime.handles[0]!.dispose).toHaveBeenCalledOnce();
    expect(await h.sessions.current(h.context())).toEqual(h.saved);
    expect(text(h.latest())).not.toContain('已恢复');
  });

  it('keeps same-ID resume compatible with a storage adapter that has no rebind capability', async () => {
    const h = await savedFixture();
    Object.defineProperty(h.sessions, 'rebindNative', {value: undefined, configurable: true});
    await h.bridge.accept(event('continue the same native session'));
    expect(h.runtime.runLog.at(-1)?.id).toBe(h.saved.nativeId);
    expect((await h.sessions.current(h.context()))?.id).toBe(h.saved.id);
  });

  it('releases the branch after a persistence failure in rebind and does not run or acknowledge restoration', async () => {
    const h = await savedFixture();
    h.runtime.resume.mockImplementationOnce(async policy => h.createHandle(policy));
    vi.spyOn(h.sessions, 'rebindNative').mockRejectedValueOnce(new SessionStoreError('WRITE_FAILED'));
    await h.bridge.accept(event(`/resume ${h.saved.id}`));
    expect(h.runtime.handles[0]!.dispose).toHaveBeenCalledOnce(); expect(h.runtime.runLog).toEqual([]);
    expect(await h.sessions.current(h.context())).toEqual(h.saved);
    expect(text(h.latest())).toContain('目录保存失败');
    expect(text(h.latest())).not.toContain('已恢复');
  });
});

describe('native menu entry points use private proactive delivery', () => {
  it('asks an authorized first-time user to establish a private chat instead of replying to a fake message ID', async () => {
    const h = await setup();
    const incoming = menu('dsh.model');
    await h.bridge.accept(incoming);
    expect(h.transport.sendUser).toHaveBeenCalledWith('ou_alice', expect.stringContaining('发一句话'), expect.any(Object));
    expect(h.transport.reply).not.toHaveBeenCalled();
    expect(h.transport.replyRich).not.toHaveBeenCalled();
    expect(await h.directChats.get('ou_alice')).toBeUndefined();
    await h.bridge.accept(incoming);
    expect(h.transport.sendUser).toHaveBeenCalledTimes(1);
  });

  it('opens an actionable model card via the verified private mapping and active send API', async () => {
    const h = await setup();
    await h.bridge.accept(event('hello'));
    expect(await h.directChats.get('ou_alice')).toBe('oc_alice');
    h.transport.reply.mockClear(); h.transport.replyRich.mockClear();
    await h.bridge.accept(menu('dsh.model', {chat_id: 'oc_untrusted_payload'}));
    expect(h.transport.sendRichUser).toHaveBeenCalledWith('ou_alice', expect.objectContaining({kind: 'card'}), expect.any(Object));
    expect(h.transport.reply).not.toHaveBeenCalled();
    expect(h.transport.replyRich).not.toHaveBeenCalled();
    const token = h.button(`/model use ${modelChoiceKey(B)}`);
    expect(h.actions.verify(token)).toMatchObject({ownerId: 'ou_alice', chatId: 'oc_alice', sourceMessageId: expect.stringMatching(/^menu:/)});
    await h.bridge.accept(callback(token));
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(B);
  });

  it('ignores unknown menu actions and non-admitted users without revealing history', async () => {
    const h = await setup();
    await h.bridge.accept(menu('dsh.model', {operator_open_id: 'ou_unknown'}));
    await h.bridge.accept(menu('/model use arbitrary'));
    await h.bridge.accept(menu('dsh.sessions', {operator_open_id: 'display name'}));
    expect(h.delivered).toEqual([]);
    expect(h.runtime.catalog).not.toHaveBeenCalled();
  });
});

describe('delayed command feedback through the bridge', () => {
  it.each(['dsh.model', 'dsh.thinking'] as const)('shows loading for a slow %s menu and updates that message in place', async command => {
    const h = await setup(), feedback = feedbackTransport(h);
    await h.directChats.record('ou_alice', 'oc_alice');
    const catalog = slowCatalog(h);
    vi.useFakeTimers();
    const running = h.bridge.accept(menu(command));
    await catalog.entered;
    await vi.advanceTimersByTimeAsync(200);
    expect(feedback.createFeedback).toHaveBeenCalledTimes(1);
    const [target, pending, options] = feedback.createFeedback.mock.calls[0]!;
    expect(target).toEqual({openId: 'ou_alice'});
    expect(pending.kind).toBe('card');
    expect(text(pending)).toContain('正在读取');
    expect(tokens(pending)).toEqual([]);
    expect(options.idempotencyKey).toMatch(/^[a-f0-9]{48}$/);
    expect(feedback.updateFeedback).not.toHaveBeenCalled();
    catalog.release(); await running;
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(1);
    expect(feedback.updateFeedback.mock.calls[0]![0]).toBe('om_loading');
    const final = feedback.updateFeedback.mock.calls[0]![1];
    expect(text(final)).toContain('模型 Alpha');
    expect(tokens(final).length).toBeGreaterThan(0);
    expect(h.delivered).toEqual([]);
  });

  it('keeps fast menu results as one normal card without a loading flash', async () => {
    const h = await setup(), feedback = feedbackTransport(h);
    await h.directChats.record('ou_alice', 'oc_alice');
    vi.useFakeTimers();
    await h.bridge.accept(menu('dsh.model'));
    await vi.runAllTimersAsync();
    expect(feedback.createFeedback).not.toHaveBeenCalled();
    expect(feedback.updateFeedback).not.toHaveBeenCalled();
    expect(h.transport.sendRichUser).toHaveBeenCalledTimes(1);
    expect(h.latest().kind).toBe('card');
  });

  it('uses the real command message as feedback target while preserving its typing reaction lifecycle', async () => {
    const progress = {startProgress: vi.fn<ProgressTransport['startProgress']>().mockResolvedValue('reaction'),
      finishProgress: vi.fn<ProgressTransport['finishProgress']>().mockResolvedValue(undefined)};
    const h = await setup(undefined, A, true, progress), feedback = feedbackTransport(h), catalog = slowCatalog(h);
    vi.useFakeTimers();
    const incoming = event('/model', {thread_id: 'omt_settings'});
    const running = h.bridge.accept(incoming);
    await catalog.entered;
    expect(progress.startProgress).toHaveBeenCalledExactlyOnceWith(incoming.message_id);
    await vi.advanceTimersByTimeAsync(200);
    expect(feedback.createFeedback.mock.calls[0]![0]).toEqual({messageId: incoming.message_id, inThread: true});
    catalog.release(); await running;
    await h.bridge.stop(); bridges.delete(h.bridge);
    expect(progress.finishProgress).toHaveBeenCalledExactlyOnceWith(incoming.message_id, 'reaction');
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(1);
    expect(h.delivered).toEqual([]);
  });

  it('switches on the clicked card: a loading frame while a slow switch runs, then the green result, once', async () => {
    const h = await setup();
    await h.bridge.accept(event('/model'));
    const token = h.button(`/model use ${modelChoiceKey(B)}`), originalDeliveries = h.delivered.length;
    const feedback = feedbackTransport(h), save = vi.spyOn(h.modelPreferences, 'set');
    const entered = deferred(), held = gate();
    const resolveSelection = h.runtime.resolveModelSelection.getMockImplementation()!;
    h.runtime.resolveModelSelection.mockImplementationOnce(async selection => {entered.resolve(); await held.promise; return resolveSelection(selection);});
    const template = (payload: ReplyPayload) => payload.kind === 'card' ? (payload.card.header as {template: string}).template : undefined;
    vi.useFakeTimers();
    const running = h.bridge.accept(callback(token));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(200);
    // No second card: the clicked one shows the switch in progress, with nothing clickable.
    expect(feedback.createFeedback).not.toHaveBeenCalled();
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(1);
    const [target, loading] = feedback.updateFeedback.mock.calls[0]!;
    expect(target).toBe('om_model_card');
    expect(text(loading)).toContain('正在切换到「模型 Beta」');
    expect(tokens(loading)).toEqual([]);
    expect(template(loading)).toBe('wathet');
    held.resolve(); await running;
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(2);
    const [finalTarget, final] = feedback.updateFeedback.mock.calls[1]!;
    expect(finalTarget).toBe('om_model_card');
    expect(template(final)).toBe('green');
    expect(text(final)).toContain('已切换');
    expect(text(final)).toContain('模型 Beta');
    expect(tokens(final).map(value => h.actions.verify(value)?.command)).toContain(`/model use ${modelChoiceKey(A)}`);
    // A one-time button cannot switch again.
    await h.bridge.accept(callback(token));
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(2);
    expect(h.delivered).toHaveLength(originalDeliveries);
  });

  it('opens another panel on the same card and shows a refused switch there in red', async () => {
    const h = await setup();
    await h.bridge.accept(event('/model'));
    const thinking = h.button('/thinking'), choice = h.button(`/model use ${modelChoiceKey(B)}`);
    const feedback = feedbackTransport(h);
    await h.bridge.accept(callback(thinking));
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(1);
    expect(text(feedback.updateFeedback.mock.calls[0]![1])).toContain('思考深度');
    h.runtime.resolveModelSelection.mockRejectedValueOnce(new DshRuntimeError('INVALID_MODEL_SELECTION'));
    await h.bridge.accept(callback(choice));
    const [target, refused] = feedback.updateFeedback.mock.calls.at(-1)!;
    expect(target).toBe('om_model_card');
    expect(refused.kind === 'card' && (refused.card.header as {template: string}).template).toBe('red');
    expect(text(refused)).toContain('这个模型或思考深度当前不可用');
    // Fresh buttons let the owner choose again from the same card.
    expect(tokens(refused).length).toBeGreaterThan(0);
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual(A);
    expect(feedback.createFeedback).not.toHaveBeenCalled();
  });

  it('ignores forged clicks and redraws a stale card in place instead of running it', async () => {
    const h = await setup();
    await h.bridge.accept(event('/model'));
    const token = h.button(`/model use ${modelChoiceKey(B)}`);
    await h.bridge.accept(event(`/thinking use ${thinkingChoiceKey('low')}`));
    const feedback = feedbackTransport(h), deliveries = h.delivered.length;
    vi.useFakeTimers();
    await h.bridge.accept(callback(token, {operator_id: 'ou_bob'}));
    await h.bridge.accept(menu('dsh.model', {operator_open_id: 'ou_unknown'}));
    await h.bridge.accept(callback(token));
    await vi.runAllTimersAsync();
    expect(feedback.createFeedback).not.toHaveBeenCalled();
    // Only the genuine but stale click touches its card, which now shows the current options.
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(1);
    const [target, refreshed] = feedback.updateFeedback.mock.calls[0]!;
    expect(target).toBe('om_model_card');
    expect(text(refreshed)).toContain('设置刚刚变化');
    expect(text(refreshed)).toContain('轻快');
    expect(tokens(refreshed).length).toBeGreaterThan(0);
    expect((await h.modelPreferences.get(h.context()))?.selection).toEqual({...A, reasoningEffort: 'low'});
    expect(h.delivered).toHaveLength(deliveries);
  });

  it.each(['text mode', 'missing create', 'missing update', 'group'] as const)('keeps ordinary delivery and skips command feedback for %s', async mode => {
    const h = await setup(), feedback = feedbackTransport(h), catalog = slowCatalog(h);
    if (mode === 'text mode') h.config.responseMode = 'text';
    if (mode === 'missing create') Reflect.deleteProperty(h.transport, 'createFeedback');
    if (mode === 'missing update') Reflect.deleteProperty(h.transport, 'updateFeedback');
    vi.useFakeTimers();
    const running = h.bridge.accept(mode === 'group' ? group('/model') : event('/model'));
    await catalog.entered;
    await vi.advanceTimersByTimeAsync(500);
    expect(feedback.createFeedback).not.toHaveBeenCalled();
    catalog.release(); await running;
    expect(feedback.updateFeedback).not.toHaveBeenCalled();
    expect(h.delivered).toHaveLength(1);
    if (mode === 'text mode') expect(h.latest().kind).toBe('text');
  });

  it.each(['create', 'update'] as const)('does not send a duplicate final message after uncertain %s delivery', async step => {
    const h = await setup(), feedback = feedbackTransport(h), catalog = slowCatalog(h);
    await h.directChats.record('ou_alice', 'oc_alice');
    if (step === 'create') feedback.createFeedback.mockRejectedValue(new Error('delivery confirmation lost'));
    else feedback.updateFeedback.mockRejectedValue(new Error('update confirmation lost'));
    vi.useFakeTimers();
    const incoming = menu('dsh.model'), running = h.bridge.accept(incoming);
    await catalog.entered; await vi.advanceTimersByTimeAsync(200);
    catalog.release(); await running;
    await h.bridge.accept(incoming);
    await vi.runAllTimersAsync();
    expect(feedback.createFeedback).toHaveBeenCalledTimes(1);
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(step === 'create' ? 0 : 1);
    expect(h.delivered).toEqual([]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({stage: 'failed'}));
  });

  it('replaces loading with a safe error card when the command itself fails', async () => {
    const h = await setup(), feedback = feedbackTransport(h), catalog = slowCatalog(h);
    vi.useFakeTimers();
    const running = h.bridge.accept(event('/model'));
    await catalog.entered; await vi.advanceTimersByTimeAsync(200);
    catalog.reject(new Error('private endpoint and credentials'));
    await running;
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(1);
    const final = feedback.updateFeedback.mock.calls[0]![1];
    expect(final.kind).toBe('card');
    expect(text(final)).toContain('操作未完成');
    expect(text(final)).not.toContain('private endpoint');
    expect(tokens(final)).toEqual([]);
    expect(h.delivered).toEqual([]);
  });

  it('does not send a late loading message after shutdown begins', async () => {
    const h = await setup(), feedback = feedbackTransport(h), catalog = slowCatalog(h);
    vi.useFakeTimers();
    const running = h.bridge.accept(event('/model'));
    await catalog.entered;
    const stopping = h.bridge.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(feedback.createFeedback).not.toHaveBeenCalled();
    catalog.release(); await running; await stopping; bridges.delete(h.bridge);
    expect(feedback.updateFeedback).not.toHaveBeenCalled();
    expect(h.delivered).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes an already visible loading card after shutdown and waits for its update', async () => {
    const h = await setup(), feedback = feedbackTransport(h), catalog = slowCatalog(h), updated = gate(), stopped = vi.fn();
    feedback.updateFeedback.mockReturnValue(updated.promise);
    vi.useFakeTimers();
    const running = h.bridge.accept(event('/model'));
    await catalog.entered; await vi.advanceTimersByTimeAsync(200);
    const stopping = h.bridge.stop().then(stopped);
    catalog.release();
    await vi.waitFor(() => expect(feedback.updateFeedback).toHaveBeenCalledTimes(1));
    expect(text(feedback.updateFeedback.mock.calls[0]![1])).toContain('连接正在关闭');
    expect(stopped).not.toHaveBeenCalled();
    updated.resolve(); await running; await stopping; bridges.delete(h.bridge);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(h.delivered).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['sessions', 'new', 'resume'] as const)('uses the same delayed feedback lifecycle for /%s', async command => {
    const h = await setup();
    await h.bridge.accept(event('a saved topic'));
    const saved = (await h.sessions.current(h.context()))!;
    if (command === 'resume') await h.bridge.accept(event('/new'));
    const feedback = feedbackTransport(h), entered = deferred(), held = gate();
    if (command === 'sessions') {
      const original = h.sessions.list.bind(h.sessions);
      vi.spyOn(h.sessions, 'list').mockImplementationOnce(async (...args) => {entered.resolve(); await held.promise; return original(...args);});
    } else if (command === 'new') {
      h.runtime.handles[0]!.dispose.mockImplementationOnce(async () => {entered.resolve(); await held.promise;});
    } else {
      const original = h.runtime.resume.getMockImplementation()!;
      h.runtime.resume.mockImplementationOnce(async (...args) => {entered.resolve(); await held.promise; return original(...args);});
    }
    const originalDeliveries = h.delivered.length;
    vi.useFakeTimers();
    const running = h.bridge.accept(event(command === 'resume' ? `/resume ${saved.id}` : `/${command}`));
    await entered.promise; await vi.advanceTimersByTimeAsync(200);
    expect(feedback.createFeedback).toHaveBeenCalledTimes(1);
    held.resolve(); await running;
    expect(feedback.updateFeedback).toHaveBeenCalledTimes(1);
    expect(feedback.updateFeedback.mock.calls[0]![0]).toBe('om_loading');
    expect(h.delivered).toHaveLength(originalDeliveries);
    if (command === 'new') expect(await h.sessions.current(h.context())).toBeUndefined();
    if (command === 'resume') expect((await h.sessions.current(h.context()))?.id).toBe(saved.id);
  });
});
