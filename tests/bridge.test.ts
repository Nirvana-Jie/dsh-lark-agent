import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotBridge } from '../src/bridge.js';
import { parseConfig, type BotConfig } from '../src/config.js';
import { DshRuntimeError, type AgentPolicy, type RuntimeSession } from '../src/dsh-runtime.js';
import type { BotState } from '../src/bridge.js';
import type { SavedSession, SessionContext } from '../src/session-store.js';

function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

function harness(overrides: Partial<BotConfig> = {}, run?: (text: string, signal: AbortSignal, index: number) => Promise<string>) {
  const config: BotConfig = {...parseConfig({profile: 'test', botOpenId: 'ou_bot', users: [
    {openId: 'ou_alice', direct: true, groupChats: ['oc_group'], cwd: '/tmp/alice', allowedTools: ['safe_a']},
    {openId: 'ou_bob', direct: true, groupChats: ['oc_group'], cwd: '/tmp/bob', allowedTools: ['safe_b']},
  ]}), ...overrides};
  const sessions: Array<RuntimeSession & {run: ReturnType<typeof vi.fn<RuntimeSession['run']>>; cancel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>}> = [];
  const create = vi.fn(async (_policy: AgentPolicy) => {
    const index = sessions.length;
    const session = {
      id: `session-${index}`, run: vi.fn<RuntimeSession['run']>((text, signal) => run ? run(text, signal, index) : Promise.resolve(`answer:${text}`)),
      cancel: vi.fn(), dispose: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
    };
    sessions.push(session);
    return session;
  });
  const replies = vi.fn(async (_id: string, _text: string, _options: {idempotencyKey: string; inThread: boolean}) => undefined);
  const seen = new Set<string>();
  const claim = vi.fn(async (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const audit = vi.fn();
  const saved = new Map<string, SavedSession[]>();
  const active = new Map<string, string>();
  const key = (c: SessionContext) => JSON.stringify([c.ownerKey, c.conversationKey]);
  const state: BotState = {
    sessions: {
      current: async c => (saved.get(key(c)) ?? []).find(s => s.id === active.get(key(c))),
      list: async c => saved.get(key(c)) ?? [],
      add: async (c, nativeId, title) => {
        const record = {id: String(saved.size + 1).padStart(12, '0'), nativeId, title: title ?? '新会话', createdAt: Date.now(), updatedAt: Date.now()};
        saved.set(key(c), [...(saved.get(key(c)) ?? []), record]); active.set(key(c), record.id); return record;
      },
      archive: async c => { active.delete(key(c)); },
      activate: async (c, id) => { const record = saved.get(key(c))!.find(s => s.id === id)!; active.set(key(c), id); return record; },
      rename: async (c, title) => { const record = saved.get(key(c))!.find(s => s.id === active.get(key(c)))!; record.title = title; return record; },
      touch: async () => undefined,
    },
    memories: {
      list: async () => [], search: async () => [], remove: async () => false,
      add: async (_c, scope, text) => ({id: '000000000001', scope, groupShared: false, text, createdAt: Date.now(), updatedAt: Date.now()}),
      setGroupShared: async () => undefined,
      groupAccessKey: async () => 'test-group-access',
      withGroupAccess: async (_c, expectedKey, task) => {
        if (expectedKey !== 'test-group-access') return false;
        await task();
        return true;
      },
    },
  };
  const resume = vi.fn(async (policy: AgentPolicy, id: string) => {
    const session = await create(policy);
    session.id = id;
    return session;
  });
  const bridge = new BotBridge(config, {create, resume}, {reply: replies}, {claim}, state, audit);
  let sequence = 0;
  const event = (content: string, extra: Record<string, unknown> = {}) => ({
    type: 'im.message.receive_v1', sender_type: 'user', sender_id: 'ou_alice', message_type: 'text',
    message_id: `om_${++sequence}`, chat_type: 'p2p', chat_id: 'oc_alice', content, ...extra,
  });
  const group = (content: string, extra: Record<string, unknown> = {}) => event(`@_user_1 ${content}`, {
    chat_type: 'group', chat_id: 'oc_group', mentions: [{key: '@_user_1', id: 'ou_bot', name: 'DSH'}], ...extra,
  });
  return {bridge, create, sessions, replies, claim, audit, event, group, config};
}

afterEach(() => { vi.useRealTimers(); });

describe('BotBridge execution and identity boundaries', () => {
  it('serializes one user lane and reuses its session', async () => {
    const first = deferred();
    const h = harness({}, text => text === 'first' ? first.promise : Promise.resolve('second answer'));
    const a = h.bridge.accept(h.event('first'));
    await vi.waitFor(() => expect(h.sessions[0]?.run).toHaveBeenCalledTimes(1));
    const b = h.bridge.accept(h.event('second'));
    await Promise.resolve();
    expect(h.sessions[0]!.run).toHaveBeenCalledTimes(1);
    first.resolve('first answer');
    await Promise.all([a, b]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sessions[0]!.run.mock.calls.map(([text]) => text)).toEqual(['first', 'second']);
    expect(h.replies.mock.calls.map(([, text]) => text)).toEqual(['first answer', 'second answer']);
    await h.bridge.stop();
  });

  it('runs different users concurrently with their respective tool policies', async () => {
    const gate = deferred();
    const h = harness({}, (text) => text === 'alice' ? gate.promise : Promise.resolve('bob done'));
    const alice = h.bridge.accept(h.event('alice'));
    await vi.waitFor(() => expect(h.sessions[0]?.run).toHaveBeenCalledTimes(1));
    await h.bridge.accept(h.event('bob', {sender_id: 'ou_bob'}));
    expect(h.create.mock.calls.map(([policy]) => [policy.cwd, policy.allowedTools])).toEqual([
      ['/tmp/alice', ['safe_a']], ['/tmp/bob', ['safe_b']],
    ]);
    expect(h.replies.mock.calls[0]?.[1]).toBe('bob done');
    gate.resolve('alice done');
    await alice;
    await h.bridge.stop();
  });

  it('isolates private chat, group chat and every thread for one user', async () => {
    const h = harness();
    await h.bridge.accept(h.event('direct'));
    await h.bridge.accept(h.group('group'));
    await h.bridge.accept(h.group('thread one', {thread_id: 'omt_one'}));
    await h.bridge.accept(h.group('thread two', {thread_id: 'omt_two'}));
    await h.bridge.accept(h.group('thread one again', {thread_id: 'omt_one'}));
    expect(h.create).toHaveBeenCalledTimes(4);
    expect(h.sessions[2]!.run.mock.calls.map(([text]) => text)).toEqual(['thread one', 'thread one again']);
    expect(h.replies.mock.calls.map(([, , options]) => options.inThread)).toEqual([false, false, true, true, true]);
    await h.bridge.stop();
  });

  it('continues the current conversation for a quote reply instead of opening an empty one', async () => {
    const h = harness();
    // A Lark quote reply carries root_id/reply_to but no thread_id.
    await h.bridge.accept(h.event('direct'));
    await h.bridge.accept(h.event('direct quote reply', {root_id: 'om_1', reply_to: 'om_bot_answer'}));
    await h.bridge.accept(h.group('group'));
    await h.bridge.accept(h.group('group quote reply', {root_id: 'om_3', reply_to: 'om_bot_answer'}));
    await h.bridge.accept(h.event('real thread', {thread_id: 'omt_topic', root_id: 'om_1'}));
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.sessions[0]!.run.mock.calls.map(([text]) => text)).toEqual(['direct', 'direct quote reply']);
    expect(h.sessions[1]!.run.mock.calls.map(([text]) => text)).toEqual(['group', 'group quote reply']);
    // Replying in thread would turn a quote reply into a Lark thread with a new conversation key.
    expect(h.replies.mock.calls.map(([, , options]) => options.inThread)).toEqual([false, false, false, false, true]);
    await h.bridge.stop();
  });

  it('ignores unauthorized users/groups, another bot mention and bot echoes without claiming or replying', async () => {
    const h = harness();
    await h.bridge.accept(h.event('unknown', {sender_id: 'ou_unknown'}));
    await h.bridge.accept(h.group('wrong group', {chat_id: 'oc_other'}));
    await h.bridge.accept(h.group('wrong bot', {mentions: [{id: 'ou_otherbot', key: '@_user_1'}]}));
    await h.bridge.accept(h.event('echo', {sender_type: 'bot'}));
    await h.bridge.accept(h.event('echo', {sender_id: 'ou_bot'}));
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.replies).not.toHaveBeenCalled();
    await h.bridge.stop();
  });

  it('claims each message before execution and suppresses concurrent duplicates', async () => {
    const h = harness();
    const message = h.event('once');
    await Promise.all([h.bridge.accept(message), h.bridge.accept(message), h.bridge.accept(message)]);
    expect(h.claim).toHaveBeenCalledTimes(3);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sessions[0]!.run).toHaveBeenCalledTimes(1);
    expect(h.replies).toHaveBeenCalledTimes(1);
    await h.bridge.stop();
  });
});

describe('BotBridge commands, limits and cancellation', () => {
  it('/new disposes only the current lane and creates a new session lazily', async () => {
    const h = harness();
    await h.bridge.accept(h.event('alice'));
    await h.bridge.accept(h.event('bob', {sender_id: 'ou_bob'}));
    await h.bridge.accept(h.event('/new'));
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.sessions[1]!.dispose).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(2);
    await h.bridge.accept(h.event('fresh'));
    expect(h.create).toHaveBeenCalledTimes(3);
    await h.bridge.stop();
  });

  it('/stop aborts the active turn and discards only that lane’s queued work', async () => {
    const gate = deferred();
    const h = harness({}, text => text === 'first' ? gate.promise : Promise.resolve(`done:${text}`));
    const first = h.bridge.accept(h.event('first'));
    await vi.waitFor(() => expect(h.sessions[0]?.run).toHaveBeenCalledTimes(1));
    const queued = h.bridge.accept(h.event('queued'));
    await h.bridge.accept(h.event('/stop'));
    expect(h.sessions[0]!.run.mock.calls[0]![1].aborted).toBe(true);
    expect(h.sessions[0]!.cancel).toHaveBeenCalledTimes(1);
    await h.bridge.accept(h.event('bob', {sender_id: 'ou_bob'}));
    gate.resolve('stale output');
    await Promise.all([first, queued]);
    expect(h.sessions[0]!.run).toHaveBeenCalledTimes(1);
    expect(h.replies.mock.calls.some(([, text]) => text.includes('stale output'))).toBe(false);
    expect(h.replies.mock.calls.some(([, text]) => text === 'done:bob')).toBe(true);
    await h.bridge.accept(h.event('after stop'));
    expect(h.sessions[0]!.run).toHaveBeenCalledTimes(2);
    await h.bridge.stop();
  });

  it('handles help, status, unknown commands and overlong prompts without creating agents', async () => {
    const h = harness({maxInputChars: 5});
    for (const text of ['/help', '/status', '/unknown', '123456', '/reset']) await h.bridge.accept(h.event(text));
    expect(h.create).not.toHaveBeenCalled();
    expect(h.replies.mock.calls.map(([, text]) => text).join('\n')).toContain('直接');
    expect(h.replies.mock.calls.map(([, text]) => text).join('\n')).toMatch(/未知命令/);
    expect(h.replies.mock.calls.map(([, text]) => text).join('\n')).toMatch(/消息过长/);
    await h.bridge.stop();
  });

  it('keeps ingress capacity after repeated duplicate, queue-full and stop early returns', async () => {
    const gate = deferred();
    const h = harness({maxPending: 2, maxPendingPerSession: 1}, text => text === 'blocked' ? gate.promise : Promise.resolve(text));
    const message = h.event('blocked');
    const running = h.bridge.accept(message);
    await vi.waitFor(() => expect(h.sessions[0]?.run).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 8; i++) {
      await h.bridge.accept(message);
      await h.bridge.accept(h.event('queue-full'));
      await h.bridge.accept(h.event('/stop', {sender_id: 'ou_bob'}));
    }
    gate.resolve('done');
    await running;
    await h.bridge.accept(h.event('finally'));
    expect(h.sessions[0]!.run.mock.calls.map(([text]) => text)).toEqual(['blocked', 'finally']);
    expect(h.audit.mock.calls.some(([event]) => event.stage === 'ingress-full')).toBe(false);
    await h.bridge.stop();
  });

  it('reclaims idle lanes and keeps session-limit early returns from leaking ingress', async () => {
    const h = harness({maxSessions: 1, maxPending: 1, idleTimeoutMs: 1000});
    await h.bridge.accept(h.event('first'));
    for (let i = 0; i < 5; i++) await h.bridge.accept(h.group('cannot create'));
    await h.bridge.sweep(Date.now() + 1001);
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    await h.bridge.accept(h.group('now create'));
    expect(h.create).toHaveBeenCalledTimes(2);
    await h.bridge.stop();
  });

  it('queues a new message behind an idle native close instead of opening a concurrent writer', async () => {
    const h = harness({idleTimeoutMs: 1000});
    await h.bridge.accept(h.event('first'));
    const closing = deferred<void>();
    const entered = deferred<void>();
    h.sessions[0]!.dispose.mockImplementationOnce(() => {entered.resolve(); return closing.promise;});
    const sweep = h.bridge.sweep(Date.now() + 1001);
    await entered.promise;
    const next = h.bridge.accept(h.event('arrived while closing'));
    await vi.waitFor(() => expect(h.claim).toHaveBeenCalledTimes(2));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sessions[0]!.run).toHaveBeenCalledTimes(1);
    closing.resolve();
    await Promise.all([sweep, next]);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.sessions[1]!.run).toHaveBeenCalledWith('arrived while closing', expect.any(AbortSignal), expect.any(Object));
    await h.bridge.accept(h.event('same resumed lane'));
    expect(h.create).toHaveBeenCalledTimes(2);
    await h.bridge.stop();
  });

  it('retains an idle lane after a failed close until native disposal is confirmed', async () => {
    const h = harness({idleTimeoutMs: 1000});
    await h.bridge.accept(h.event('first'));
    const old = h.sessions[0]!;
    old.dispose.mockRejectedValue(new DshRuntimeError('TURN_FAILED'));
    await h.bridge.sweep(Date.now() + 1001);
    await h.bridge.accept(h.event('must stay blocked'));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(old.run).toHaveBeenCalledTimes(1);
    old.dispose.mockResolvedValue(undefined);
    await h.bridge.accept(h.event('safe after closing'));
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(old.run).toHaveBeenCalledTimes(1);
    await h.bridge.stop();
  });

  it('retains an unpublished native handle if initialization and its cleanup both fail', async () => {
    const h = harness();
    const create = h.create.getMockImplementation()!;
    h.create.mockImplementationOnce(async policy => {
      const session = await create(policy);
      session.checkpoint.mockRejectedValue(new DshRuntimeError('PERSISTENCE_FAILED'));
      session.dispose.mockRejectedValue(new DshRuntimeError('TURN_FAILED'));
      return session;
    });
    await h.bridge.accept(h.event('initialization fails'));
    await h.bridge.accept(h.event('must not create a second writer'));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sessions[0]!.run).not.toHaveBeenCalled();
    h.sessions[0]!.dispose.mockResolvedValue(undefined);
    await h.bridge.accept(h.event('recovered after confirmed disposal'));
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.sessions[1]!.run).toHaveBeenCalledTimes(1);
    await h.bridge.stop();
  });

  it('lets a long run finish when no cap is configured', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    const h = harness({}, (_text, signal) => new Promise((resolve, reject) => {
      const done = setTimeout(() => resolve('一小时后完成'), 3_600_000);
      signal.addEventListener('abort', () => { clearTimeout(done); reject(new DshRuntimeError('CANCELLED')); }, {once: true});
    }));
    const task = h.bridge.accept(h.event('long'));
    await vi.waitFor(() => expect(h.sessions[0]?.run).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3_600_000);
    await task;
    expect(h.sessions[0]!.run.mock.calls[0]![1].aborted).toBe(false);
    expect(h.replies.mock.calls.map(call => call[1])).toEqual(['一小时后完成']);
    await h.bridge.stop();
  });

  it('aborts a run past a configured cap and reports a safe timeout', async () => {
    vi.useFakeTimers();
    const h = harness({turnTimeoutMs: 1000}, (_text, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DshRuntimeError('CANCELLED')), {once: true});
    }));
    const task = h.bridge.accept(h.event('slow'));
    await vi.advanceTimersByTimeAsync(1001);
    await task;
    expect(h.sessions[0]!.run.mock.calls[0]![1].aborted).toBe(true);
    expect(h.replies.mock.calls[0]?.[1]).toContain('超时');
    await h.bridge.stop();
  });

  it('reports timeout even if the runtime resolves after observing cancellation', async () => {
    vi.useFakeTimers();
    const h = harness({turnTimeoutMs: 1000}, (_text, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve('stale response'), {once: true});
    }));
    const task = h.bridge.accept(h.event('slow'));
    await vi.advanceTimersByTimeAsync(1001);
    await task;
    expect(h.replies).toHaveBeenCalledTimes(1);
    expect(h.replies.mock.calls[0]?.[1]).toContain('超时');
    expect(h.replies.mock.calls[0]?.[1]).not.toContain('stale response');
    await h.bridge.stop();
  });

  it('waits for active work to drain before disposing and suppresses shutdown replies', async () => {
    const gate = deferred();
    const h = harness({}, () => gate.promise);
    const task = h.bridge.accept(h.event('running'));
    await vi.waitFor(() => expect(h.sessions[0]?.run).toHaveBeenCalledTimes(1));
    const stopped = h.bridge.stop();
    expect(h.sessions[0]!.run.mock.calls[0]![1].aborted).toBe(true);
    expect(h.sessions[0]!.dispose).not.toHaveBeenCalled();
    gate.resolve('late result');
    await Promise.all([task, stopped]);
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.replies).not.toHaveBeenCalled();
    await h.bridge.accept(h.event('after shutdown'));
    expect(h.sessions[0]!.run).toHaveBeenCalledTimes(1);
  });

  it('does not reclaim a lane while its turn is active', async () => {
    const gate = deferred();
    const h = harness({}, () => gate.promise);
    const task = h.bridge.accept(h.event('running'));
    await vi.waitFor(() => expect(h.sessions[0]?.run).toHaveBeenCalledTimes(1));
    await h.bridge.sweep(Date.now() + 100_000_000);
    expect(h.sessions[0]!.dispose).not.toHaveBeenCalled();
    gate.resolve('done');
    await task;
    await h.bridge.stop();
  });

  it('waits for an in-flight ledger claim before shutdown completes', async () => {
    const claim = deferred<boolean>();
    const h = harness();
    h.claim.mockImplementation(() => claim.promise);
    const task = h.bridge.accept(h.event('admitting'));
    await vi.waitFor(() => expect(h.claim).toHaveBeenCalledTimes(1));
    let stopped = false;
    const shutdown = h.bridge.stop().then(() => { stopped = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    claim.resolve(true);
    await Promise.all([task, shutdown]);
    expect(stopped).toBe(true);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.replies).not.toHaveBeenCalled();
  });

  it('drains session creation during shutdown and disposes the newly created handle', async () => {
    const gate = deferred<void>();
    const h = harness();
    const create = h.create.getMockImplementation()!;
    h.create.mockImplementation(async policy => {
      const session = await create(policy);
      await gate.promise;
      return session;
    });
    const task = h.bridge.accept(h.event('creating'));
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    const shutdown = h.bridge.stop();
    expect(h.sessions[0]!.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([task, shutdown]);
    expect(h.sessions[0]!.run).not.toHaveBeenCalled();
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.replies).not.toHaveBeenCalled();
  });

  it('rejects shutdown if a session cannot be disposed and permits a cleanup retry', async () => {
    const h = harness();
    await h.bridge.accept(h.event('created'));
    h.sessions[0]!.dispose.mockRejectedValueOnce(new Error('private disposal reason'));
    await expect(h.bridge.stop()).rejects.toThrow('Some dsh sessions did not dispose successfully.');
    await expect(h.bridge.stop()).resolves.toBeUndefined();
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(2);
  });

  it('chunks by UTF-8 bytes with stable idempotency keys for the same reply', async () => {
    const output = '你好😀世界🌏'.repeat(10);
    const first = harness({chunkBytes: 20}, async () => output);
    const second = harness({chunkBytes: 20}, async () => output);
    await first.bridge.accept(first.group('question', {message_id: 'om_same', thread_id: 'omt_thread'}));
    await second.bridge.accept(second.group('question', {message_id: 'om_same', thread_id: 'omt_thread'}));
    expect(first.replies.mock.calls).toEqual(second.replies.mock.calls);
    expect(first.replies.mock.calls.map(([, text]) => text).join('')).toBe(output);
    expect(first.replies.mock.calls.every(([, text, options]) => Buffer.byteLength(text, 'utf8') <= 20 && options.inThread)).toBe(true);
    const keys = first.replies.mock.calls.map(([, , options]) => options.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    await Promise.all([first.bridge.stop(), second.bridge.stop()]);
  });
});
