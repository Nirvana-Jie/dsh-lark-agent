import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotBridge } from '../src/bridge.js';
import { CardActions, type ActionBinding } from '../src/card-actions.js';
import { parseConfig } from '../src/config.js';
import type { AgentPolicy, RuntimeSession } from '../src/dsh-runtime.js';
import { DiskLedger } from '../src/ledger.js';
import { MemoryStore } from '../src/memory-store.js';
import { ownerKey, parseMessage, sessionKey } from '../src/message.js';
import type { ProgressTransport } from '../src/progress.js';
import type { ReplyPayload } from '../src/replies.js';
import { SessionStore } from '../src/session-store.js';

const directories: string[] = [];
const bridges = new Set<BotBridge>();
let sequence = 0;
type ReplyOptions = {idempotencyKey: string; inThread: boolean};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function event(text: string, extra: Record<string, unknown> = {}) {
  return {type: 'im.message.receive_v1', message_id: `om_rich${++sequence}`, message_type: 'text',
    sender_id: 'ou_alice', sender_type: 'user', chat_id: 'oc_alice', chat_type: 'p2p', content: text, ...extra};
}

function group(text: string, extra: Record<string, unknown> = {}) {
  return event(`@DSH ${text}`, {chat_id: 'oc_group', chat_type: 'group',
    mentions: [{key: '@_user_1', id: 'ou_bot', name: 'DSH'}], ...extra});
}

function callback(token: string, extra: Record<string, unknown> = {}) {
  return {type: 'card.action.trigger', event_id: `ev_rich${++sequence}`, operator_id: 'ou_alice',
    message_id: 'om_card', chat_id: 'oc_alice', host: 'im_message', action_tag: 'button',
    action_value: JSON.stringify({token}), ...extra};
}

function payloadText(payload: ReplyPayload): string {
  return payload.kind === 'text' ? payload.text : payload.kind === 'post' ? payload.markdown : payload.fallbackText;
}

function actionTokens(payload: ReplyPayload): string[] {
  if (payload.kind !== 'card') return [];
  const tokens: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.type === 'callback' && object.value && typeof object.value === 'object'
      && 'token' in object.value && typeof object.value.token === 'string') tokens.push(object.value.token);
    Object.values(object).forEach(visit);
  };
  visit(payload.card);
  return tokens;
}

async function setup(directory?: string, options: {rich?: boolean; responseMode?: 'auto' | 'text';
  progressTransport?: ProgressTransport; loadingReaction?: boolean; answer?: string} = {}) {
  if (!directory) {
    directory = await mkdtemp(join(tmpdir(), 'dsh-rich-bridge-'));
    directories.push(directory);
  }
  const config = parseConfig({profile: 'rich-test', botOpenId: 'ou_bot', stateDir: join(directory, 'state'),
    cardInteractions: true, responseMode: options.responseMode,
    loadingReaction: options.loadingReaction ?? Boolean(options.progressTransport), users: [
      {openId: 'ou_alice', direct: true, groupChats: ['oc_group', 'oc_other'], cwd: join(directory, 'alice')},
      {openId: 'ou_bob', direct: true, groupChats: ['oc_group'], cwd: join(directory, 'bob')},
    ]});
  const sessions = await SessionStore.open(config.stateDir);
  const memories = await MemoryStore.open(config.stateDir);
  const actions = await CardActions.open(config.stateDir, 'rich-test:ou_bot');
  const ledger = await DiskLedger.open(config.stateDir);
  const handles: Array<RuntimeSession & {run: ReturnType<typeof vi.fn<RuntimeSession['run']>>}> = [];
  const run = vi.fn<RuntimeSession['run']>(async () => options.answer ?? '普通回答');
  const handle = (_policy: AgentPolicy, id: string = randomUUID()): RuntimeSession => {
    const value = {id, run: vi.fn<RuntimeSession['run']>((...args) => run(...args)),
      checkpoint: vi.fn(async () => undefined), cancel: vi.fn(), dispose: vi.fn(async () => undefined)};
    handles.push(value);
    return value;
  };
  const runtime = {create: vi.fn(async (policy: AgentPolicy) => handle(policy)),
    resume: vi.fn(async (policy: AgentPolicy, id: string) => handle(policy, id)), handles, run};
  const reply = vi.fn(async (_id: string, _text: string, _options: ReplyOptions): Promise<void> => undefined);
  const replyRich = vi.fn(async (_id: string, _payload: ReplyPayload, _options: ReplyOptions): Promise<void> => undefined);
  const audit = vi.fn();
  const bridge = new BotBridge(config, runtime, {reply, ...(options.rich === false ? {} : {replyRich})},
    ledger, {sessions, memories, actions}, audit, options.progressTransport);
  bridge.setCardActionsReady(true);
  bridges.add(bridge);
  const context = (raw = event('context')) => {
    const message = parseMessage(raw, config.botOpenId)!;
    return {ownerKey: ownerKey(message, config), conversationKey: sessionKey(message, config), privateChat: message.chatType === 'p2p'};
  };
  const sessionContext = async (raw = event('context')) => {
    const identity = context(raw);
    if (identity.privateChat) return identity;
    return {...identity, conversationKey: createHash('sha256').update(JSON.stringify([
      identity.conversationKey, 'group-memory-v1', await memories.groupAccessKey(identity),
    ])).digest('hex')};
  };
  const issue = (command: string, raw = event('source'), extra: Partial<ActionBinding> = {}) => {
    const message = parseMessage(raw, config.botOpenId)!;
    return actions.issue({ownerId: message.senderId, chatId: message.chatId, chatType: message.chatType,
      threadId: message.threadId, sourceMessageId: message.messageId, command, ...extra});
  };
  const latest = () => {
    const payload = replyRich.mock.calls.at(-1)?.[1];
    if (!payload) throw new Error('Expected a rich transport reply');
    return payload;
  };
  const button = (command: string) => {
    const token = actionTokens(latest()).find(token => actions.verify(token)?.command === command);
    if (!token) throw new Error(`Expected button for ${command}`);
    return token;
  };
  return {directory, config, sessions, memories, actions, ledger, runtime, reply, replyRich, audit, bridge, context, sessionContext, issue, latest, button};
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...bridges].map(bridge => bridge.stop()));
  bridges.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('rich command replies and signed card callbacks', () => {
  it.each(['forced text', 'legacy transport'] as const)('neutralizes code-contained native mentions in %s fallback', async mode => {
    const answer = '```html\n<at id=all></at>\n<at user_id=all></at>\n```';
    const h = await setup(undefined, {answer, responseMode: mode === 'forced text' ? 'text' : 'auto', rich: mode !== 'legacy transport'});
    await h.bridge.accept(event('Show the code example'));
    const sent = mode === 'forced text'
      ? h.replyRich.mock.calls.map(([, payload]) => { expect(payload.kind).toBe('text'); return payloadText(payload); }).join('')
      : h.reply.mock.calls.map(([, text]) => text).join('');
    expect(sent).toBe('```html\n‹at id=all›‹/at›\n‹at user_id=all›‹/at›\n```');
    expect(sent).not.toContain('<at');
    if (mode === 'legacy transport') expect(h.replyRich).not.toHaveBeenCalled();
  });

  it('preserves the same native-tag code as literal Markdown when sending a rich post', async () => {
    const answer = '```html\n<at id=all></at>\n<at user_id=all></at>\n```';
    const h = await setup(undefined, {answer});
    await h.bridge.accept(event('Show the code example'));
    expect(h.latest()).toEqual({kind: 'post', markdown: answer});
    expect(h.reply).not.toHaveBeenCalled();
  });

  it('renders requested conversation history as an actionable card without invoking the model', async () => {
    const h = await setup();
    const saved = await h.sessions.add(h.context(), randomUUID(), 'Plan for tomorrow');
    await h.bridge.accept(event('/sessions'));
    expect(h.latest().kind).toBe('card');
    expect(payloadText(h.latest())).toContain('Plan for tomorrow');
    expect(payloadText(h.latest())).toContain(`/resume ${saved.id}`); // usable text fallback
    const payload = h.latest();
    if (payload.kind !== 'card') throw new Error('Expected card');
    const elements = (payload.card.body as {elements: Record<string, unknown>[]}).elements;
    expect(elements.find(item => item.tag === 'select_static')?.options).toMatchObject([{value: saved.id,
      text: {tag: 'plain_text', content: expect.stringContaining('Plan for tomorrow')}}]);
    expect(JSON.stringify(h.latest())).not.toContain(saved.nativeId);
    expect(actionTokens(h.latest()).length).toBeGreaterThan(0);
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
    for (const token of actionTokens(h.latest())) expect(h.actions.verify(token)).toMatchObject({ownerId: 'ou_alice', chatId: 'oc_alice'});
  });

  it.each(['/help', '/status'])('keeps %s conversational without reading or displaying memory records', async command => {
    const h = await setup();
    const entry = await h.memories.add(h.context(), 'personal', 'Private preference that should stay in the background');
    const saved = await h.sessions.add(h.context(), randomUUID(), 'A technical-looking session title');
    const list = vi.spyOn(h.memories, 'list');
    const search = vi.spyOn(h.memories, 'search');
    await h.bridge.accept(event(command));
    expect(h.latest().kind).not.toBe('card');
    const displayed = payloadText(h.latest());
    for (const hidden of [entry.text, entry.id, saved.id, saved.nativeId, '/memory', '/remember']) expect(displayed).not.toContain(hidden);
    expect(list).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
    if (command === '/help') expect(displayed).toContain('直接');
    else expect(displayed).toContain('接着聊');
  });

  it('exposes diagnostic details only through explicitly requested advanced commands', async () => {
    const h = await setup();
    await h.memories.add(h.context(), 'personal', 'A retained preference');
    const saved = await h.sessions.add(h.context(), randomUUID(), 'Existing conversation');
    await h.bridge.accept(event('/help advanced'));
    expect(h.latest().kind).not.toBe('card');
    expect(payloadText(h.latest())).toContain('/status detail');
    expect(payloadText(h.latest())).toContain('/sessions detail');
    expect(payloadText(h.latest())).toContain('/memory');
    await h.bridge.accept(event('/status detail'));
    expect(h.latest().kind).not.toBe('card');
    expect(payloadText(h.latest())).toContain(saved.id);
    expect(payloadText(h.latest())).toContain('1 条');
    await h.bridge.accept(event('/sessions detail'));
    expect(h.latest().kind).not.toBe('card');
    expect(payloadText(h.latest())).toContain(saved.id);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it.each(['private', 'group'] as const)('briefly confirms %s remembering while actually persisting the supplied text', async location => {
    const h = await setup();
    const text = 'A preference with an internal-looking value 12abcdef3456';
    const incoming = location === 'private' ? event(`/remember ${text}`) : group(`/remember ${text}`);
    await h.bridge.accept(incoming);
    const entries = await h.memories.list(h.context(incoming));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({text, scope: location === 'private' ? 'personal' : 'chat', groupShared: false});
    expect(h.latest().kind).toBe('text');
    expect(payloadText(h.latest())).toContain('记住');
    expect(payloadText(h.latest()).length).toBeLessThan(30);
    expect(payloadText(h.latest())).not.toContain(text);
    expect(payloadText(h.latest())).not.toContain(entries[0]!.id);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('shows command guidance without callback buttons until the callback consumer is ready', async () => {
    const h = await setup();
    await h.sessions.add(h.context(), randomUUID(), 'An earlier conversation');
    h.bridge.setCardActionsReady(false);
    await h.bridge.accept(event('/sessions'));
    expect(h.latest().kind).toBe('card');
    expect(actionTokens(h.latest())).toEqual([]);
    expect(payloadText(h.latest())).toContain('/sessions detail');
    h.bridge.setCardActionsReady(true);
    await h.bridge.accept(event('/sessions'));
    expect(actionTokens(h.latest()).length).toBeGreaterThan(0);
  });

  it.each([
    ['/memory show 000000000000', '找不到可用的记忆。'],
    ['/memories unsupported', '用法：/memory [list|global|chat|search <关键词>|show <ID>]；群授权在私聊用 /memory share <ID> 或 /memory unshare <ID>。'],
  ])('shows %s errors directly instead of hiding them in a normal list card', async (command, response) => {
    const h = await setup();
    await h.memories.add(h.context(), 'personal', 'An unrelated saved memory');
    await h.bridge.accept(event(command));
    expect(h.latest().kind).not.toBe('card');
    expect(payloadText(h.latest()).replaceAll('&lt;', '<').replaceAll('&gt;', '>')).toBe(response);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('keeps an existing signed memory action compatible and bound to the clicking owner', async () => {
    const h = await setup();
    await h.memories.add(h.context(), 'personal', 'Alice prefers concise replies');
    await h.memories.add(h.context(event('context', {sender_id: 'ou_bob', chat_id: 'oc_bob'})), 'personal', 'Bob private fact');
    await h.bridge.accept(callback(h.issue('/memory')));
    expect(h.latest().kind).not.toBe('card');
    expect(payloadText(h.latest())).toContain('Alice prefers concise replies');
    expect(payloadText(h.latest())).not.toContain('Bob private fact');
    expect(h.replyRich.mock.calls.at(-1)?.[0]).toBe('om_card');
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
  });

  it('restores a signed original thread and ignores spoofed thread fields on the callback', async () => {
    const h = await setup();
    const source = group('/sessions', {thread_id: 'omt_original'});
    const original = await h.sessionContext(source);
    const sibling = await h.sessionContext(group('context', {thread_id: 'omt_sibling'}));
    const saved = await h.sessions.add(original, randomUUID(), 'Original thread');
    await h.sessions.archive(original);
    const siblingSaved = await h.sessions.add(sibling, randomUUID(), 'Sibling thread');
    await h.bridge.accept(source);
    const token = h.button('/sessions pick 1');
    await h.bridge.accept(callback(token, {action_tag: 'select_static', action_name: 'dsh_session_picker', option: saved.id,
      chat_id: 'oc_group', thread_id: 'omt_sibling', chat_type: 'p2p'}));
    expect((await h.sessions.current(original))?.id).toBe(saved.id);
    expect((await h.sessions.current(sibling))?.id).toBe(siblingSaved.id);
    expect(h.runtime.resume.mock.calls[0]?.[1]).toBe(saved.nativeId);
    expect(h.replyRich.mock.calls.at(-1)?.[2].inThread).toBe(true);
    expect(h.runtime.handles[0]?.run).not.toHaveBeenCalled();
  });

  it.each(['other owner', 'other chat', 'forged token', 'expired token'] as const)('rejects %s without changing memory or sending a reply', async mismatch => {
    const h = await setup();
    const memory = await h.memories.add(h.context(), 'personal', 'Must remain owned by Alice');
    let token = h.issue(`/forget ${memory.id}`);
    const extra: Record<string, unknown> = {};
    if (mismatch === 'other owner') extra.operator_id = 'ou_bob';
    if (mismatch === 'other chat') extra.chat_id = 'oc_other';
    if (mismatch === 'forged token') token = token.replace(/^./, token[0] === 'e' ? 'f' : 'e');
    if (mismatch === 'expired token') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_001);
    await h.bridge.accept(callback(token, extra));
    expect(await h.memories.list(h.context())).toHaveLength(1);
    expect(h.replyRich).not.toHaveBeenCalled();
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
  });

  it('deduplicates an identical callback event but permits separate read-only clicks with distinct reply keys', async () => {
    const h = await setup();
    const token = h.issue('/status');
    h.bridge.setCardActionsReady(false); // Keep the two rendered response bodies identical.
    const first = callback(token);
    await h.bridge.accept(first);
    await h.bridge.accept(first);
    expect(h.replyRich).toHaveBeenCalledOnce();
    await h.bridge.accept(callback(token));
    expect(h.replyRich).toHaveBeenCalledTimes(2);
    const [a, b] = h.replyRich.mock.calls;
    expect(a?.[1]).toEqual(b?.[1]);
    expect(a?.[2].idempotencyKey).not.toBe(b?.[2].idempotencyKey);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('persists one-use mutation nonces across restart even when a click has a new event ID', async () => {
    const first = await setup();
    const entry = await first.memories.add(first.context(), 'personal', 'Delete only once');
    const token = first.issue(`/forget ${entry.id}`);
    const remove = vi.spyOn(first.memories, 'remove');
    await first.bridge.accept(callback(token));
    await first.bridge.accept(callback(token));
    expect(remove).toHaveBeenCalledOnce();
    expect(await first.memories.list(first.context())).toEqual([]);
    await first.bridge.stop();
    const restarted = await setup(first.directory);
    const removeAgain = vi.spyOn(restarted.memories, 'remove');
    expect(restarted.actions.verify(token)).toBeDefined();
    await restarted.bridge.accept(callback(token));
    expect(removeAgain).not.toHaveBeenCalled();
    expect(restarted.replyRich).not.toHaveBeenCalled();
    expect(restarted.runtime.create).not.toHaveBeenCalled();
  });

  it.each(['per-session', 'global'] as const)('keeps a mutation button usable after %s queue capacity rejects an earlier click', async limit => {
    const h = await setup();
    if (limit === 'per-session') h.config.maxPendingPerSession = 1;
    else h.config.maxPending = 1;
    const memory = await h.memories.add(h.context(), 'personal', 'Remove after capacity is available');
    const token = h.issue(`/forget ${memory.id}`);
    const remove = vi.spyOn(h.memories, 'remove');
    const model = deferred<string>();
    h.runtime.run.mockReturnValueOnce(model.promise);
    const running = h.bridge.accept(event('A long task fills the queue'));
    try {
      await vi.waitFor(() => expect(h.runtime.run).toHaveBeenCalledOnce());
      await h.bridge.accept(callback(token));
      expect(payloadText(h.latest())).toContain('排队消息较多');
      expect(remove).not.toHaveBeenCalled();
      expect(await h.memories.list(h.context())).toHaveLength(1);
      model.resolve('Task complete');
      await running;
      await h.bridge.accept(callback(token));
      expect(remove).toHaveBeenCalledOnce();
      expect(await h.memories.list(h.context())).toEqual([]);
      expect(payloadText(h.latest())).toContain('已删除');
    } finally {
      model.resolve('Task complete');
      await running;
    }
  });

  it.each(['/new', '/resume'] as const)('rejects stale %s buttons after the active session changes', async command => {
    const h = await setup();
    const target = await h.sessions.add(h.context(), randomUUID(), 'Old conversation');
    const previous = await h.sessions.add(h.context(), randomUUID(), 'Current at render time');
    await h.bridge.accept(event('/sessions'));
    const token = h.button(command === '/new' ? '/new' : '/sessions pick 1');
    expect(h.actions.verify(token)?.expectedSessionId).toBe(previous.id);
    const current = await h.sessions.add(h.context(), randomUUID(), 'Changed since rendering');
    const archive = vi.spyOn(h.sessions, 'archive');
    await h.bridge.accept(callback(token, command === '/resume' ? {action_tag: 'select_static', action_name: 'dsh_session_picker', option: target.id} : {}));
    expect((await h.sessions.current(h.context()))?.id).toBe(current.id);
    expect(archive).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(payloadText(h.latest())).toContain('会话状态已改变');
  });

  it.each(['direct revoked', 'group revoked', 'user removed'] as const)('rechecks current authorization when %s', async changed => {
    const h = await setup();
    const source = changed === 'group revoked' ? group('/memory') : event('/memory');
    const context = h.context(source);
    const entry = await h.memories.add(context, changed === 'group revoked' ? 'chat' : 'personal', 'Still retained after permission revocation');
    const token = h.issue(`/forget ${entry.id}`, source);
    if (changed === 'direct revoked') h.config.users[0]!.direct = false;
    if (changed === 'group revoked') h.config.users[0]!.groupChats = [];
    if (changed === 'user removed') h.config.users.splice(0, 1);
    await h.bridge.accept(callback(token, {chat_id: changed === 'group revoked' ? 'oc_group' : 'oc_alice'}));
    expect(await h.memories.list(context)).toHaveLength(1);
    expect(h.replyRich).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('does not accept signed callbacks when card interactions are disabled', async () => {
    const h = await setup();
    const token = h.issue('/memory');
    h.config.cardInteractions = false;
    await h.bridge.accept(callback(token));
    expect(h.replyRich).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('never sends a fallback or repeats a callback after an unknown rich-delivery failure', async () => {
    const h = await setup();
    h.replyRich.mockRejectedValueOnce(new Error('private-transport-secret: delivery unknown'));
    const incoming = callback(h.issue('/help'));
    await h.bridge.accept(incoming);
    await h.bridge.accept(incoming);
    expect(h.replyRich).toHaveBeenCalledOnce();
    expect(h.reply).not.toHaveBeenCalled();
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('private-transport-secret');
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
  });
});

describe('progress feedback through the bridge', () => {
  it('begins feedback without blocking model work and removes it only after the reply settles', async () => {
    const added = deferred<string>();
    const model = deferred<string>();
    const delivery = deferred<void>();
    const removed = deferred<void>();
    const progress = {startProgress: vi.fn(() => added.promise), finishProgress: vi.fn(() => removed.promise)};
    const h = await setup(undefined, {progressTransport: progress});
    h.runtime.run.mockReturnValueOnce(model.promise);
    h.replyRich.mockReturnValueOnce(delivery.promise);
    const incoming = event('Take time to answer');
    const handling = h.bridge.accept(incoming);
    try {
      await vi.waitFor(() => expect(h.runtime.run).toHaveBeenCalledOnce());
      // Creation is still unresolved, proving it did not hold up the model.
      expect(progress.startProgress).toHaveBeenCalledWith(incoming.message_id);
      expect(progress.finishProgress).not.toHaveBeenCalled();
      added.resolve('reaction-model');
      model.resolve('The final answer');
      await vi.waitFor(() => expect(h.replyRich).toHaveBeenCalledOnce());
      expect(progress.finishProgress).not.toHaveBeenCalled();
      delivery.resolve();
      await handling;
      await vi.waitFor(() => expect(progress.finishProgress).toHaveBeenCalledWith(incoming.message_id, 'reaction-model'));
      expect(h.replyRich).toHaveBeenCalledOnce();
      expect(h.reply).not.toHaveBeenCalled();

      let stopped = false;
      const shutdown = h.bridge.stop().then(() => { stopped = true; });
      expect(await Promise.race([
        shutdown.then(() => 'stopped'),
        new Promise<string>(resolve => setTimeout(() => resolve('waiting-for-cleanup'), 20)),
      ])).toBe('waiting-for-cleanup');
      expect(stopped).toBe(false);
      removed.resolve();
      await shutdown;
      expect(stopped).toBe(true);
    } finally {
      added.resolve('reaction-model'); model.resolve('The final answer'); delivery.resolve(); removed.resolve();
      await handling;
    }
  });

  it('cleans up a delayed indicator even when the reply finished before reaction creation', async () => {
    const added = deferred<string>();
    const progress = {startProgress: vi.fn(() => added.promise), finishProgress: vi.fn(async () => undefined)};
    const h = await setup(undefined, {progressTransport: progress});
    const incoming = event('A quick answer');
    try {
      await h.bridge.accept(incoming);
      expect(h.replyRich).toHaveBeenCalledOnce();
      expect(progress.finishProgress).not.toHaveBeenCalled();
      added.resolve('late-reaction');
      await vi.waitFor(() => expect(progress.finishProgress).toHaveBeenCalledWith(incoming.message_id, 'late-reaction'));
      expect(h.replyRich).toHaveBeenCalledOnce();
    } finally { added.resolve('late-reaction'); }
  });

  it('gives a command-card click feedback on that card without invoking the model or adding a status message', async () => {
    const delivery = deferred<void>();
    const progress = {startProgress: vi.fn(async () => 'reaction-card'), finishProgress: vi.fn(async () => undefined)};
    const h = await setup(undefined, {progressTransport: progress});
    h.replyRich.mockReturnValueOnce(delivery.promise);
    const incoming = callback(h.issue('/status'));
    const handling = h.bridge.accept(incoming);
    try {
      await vi.waitFor(() => expect(h.replyRich).toHaveBeenCalledOnce());
      expect(progress.startProgress).toHaveBeenCalledWith('om_card');
      expect(progress.finishProgress).not.toHaveBeenCalled();
      expect(h.latest().kind).toBe('text');
      expect(h.runtime.run).not.toHaveBeenCalled();
      expect(h.runtime.create).not.toHaveBeenCalled();
      delivery.resolve();
      await handling;
      await vi.waitFor(() => expect(progress.finishProgress).toHaveBeenCalledWith('om_card', 'reaction-card'));
      expect(h.replyRich).toHaveBeenCalledOnce();
      expect(h.reply).not.toHaveBeenCalled();
    } finally { delivery.resolve(); await handling; }
  });

  it('still delivers an answer when feedback creation fails, without leaking the transport error', async () => {
    const progress = {startProgress: vi.fn(async (): Promise<string> => { throw new Error('private-progress-credential'); }),
      finishProgress: vi.fn(async () => undefined)};
    const h = await setup(undefined, {progressTransport: progress});
    await h.bridge.accept(event('Please answer'));
    expect(h.replyRich).toHaveBeenCalledOnce();
    expect(payloadText(h.latest())).toBe('普通回答');
    expect(progress.finishProgress).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith({stage: 'progress-unavailable'});
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('private-progress-credential');
  });

  it('does not invoke a supplied feedback transport when loading reactions are disabled', async () => {
    const progress = {startProgress: vi.fn(async () => 'unused'), finishProgress: vi.fn(async () => undefined)};
    const h = await setup(undefined, {progressTransport: progress, loadingReaction: false});
    await h.bridge.accept(event('Ordinary conversation'));
    expect(h.replyRich).toHaveBeenCalledOnce();
    expect(progress.startProgress).not.toHaveBeenCalled();
    expect(progress.finishProgress).not.toHaveBeenCalled();
  });
});
