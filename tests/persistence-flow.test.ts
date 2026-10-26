import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotBridge } from '../src/bridge.js';
import { parseConfig } from '../src/config.js';
import { DshRuntimeError, type AgentPolicy, type RuntimeSession } from '../src/dsh-runtime.js';
import { DiskLedger } from '../src/ledger.js';
import { MemoryStore } from '../src/memory-store.js';
import { ownerKey, parseMessage, sessionKey } from '../src/message.js';
import { SessionStore } from '../src/session-store.js';

const directories: string[] = [];
const bridges = new Set<BotBridge>();
let sequence = 0;
type NativeHandle = RuntimeSession & {
  policy: AgentPolicy;
  history: string[];
  run: ReturnType<typeof vi.fn<RuntimeSession['run']>>;
  dispose: ReturnType<typeof vi.fn<RuntimeSession['dispose']>>;
};

function event(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'im.message.receive_v1', message_id: `om_flow${++sequence}`, message_type: 'text',
    sender_id: 'ou_alice', sender_type: 'user', chat_id: 'oc_alice', chat_type: 'p2p', content: text,
    ...extra,
  };
}

function group(text: string, extra: Record<string, unknown> = {}) {
  return event(`@DSH ${text}`, {
    chat_id: 'oc_group', chat_type: 'group', mentions: [{key: '@_user_1', id: 'ou_bot', name: 'DSH'}],
    ...extra,
  });
}

/** Simulated native logs really survive creation of a completely new runtime object. */
class FileRuntime {
  readonly handles: NativeHandle[] = [];
  failCheckpoint: (id: string, count: number, history: readonly string[]) => boolean = () => false;
  failResume: (id: string) => boolean = () => false;

  constructor(readonly directory: string) {}
  nativeFile(id: string) { return join(this.directory, `${id}.json`); }

  readonly create = vi.fn(async (policy: AgentPolicy): Promise<RuntimeSession> => this.handle(policy, randomUUID(), []));
  readonly resume = vi.fn(async (policy: AgentPolicy, id: string): Promise<RuntimeSession> => {
    if (this.failResume(id)) throw new DshRuntimeError('RESTORE_FAILED');
    try {
      const saved: unknown = JSON.parse(await readFile(this.nativeFile(id), 'utf8'));
      if (!Array.isArray(saved) || saved.some(text => typeof text !== 'string')) throw new Error('Invalid fake native history');
      return this.handle(policy, id, saved as string[]);
    } catch { throw new DshRuntimeError('RESTORE_FAILED'); }
  });

  private handle(policy: AgentPolicy, id: string, history: string[]): RuntimeSession {
    let checkpoints = 0;
    const handle: NativeHandle = {
      id, policy, history: [...history],
      run: vi.fn<RuntimeSession['run']>(async (text, signal) => {
        signal.throwIfAborted();
        const before = [...handle.history];
        handle.history.push(text);
        return `answer:${text};previous=${before.join('|')}`;
      }),
      checkpoint: vi.fn(async () => {
        checkpoints++;
        if (this.failCheckpoint(id, checkpoints, handle.history)) throw new DshRuntimeError('PERSISTENCE_FAILED');
        await writeFile(this.nativeFile(id), JSON.stringify(handle.history), {mode: 0o600});
      }),
      cancel: vi.fn(), dispose: vi.fn(async () => undefined),
    };
    this.handles.push(handle);
    return handle;
  }
}

async function setup(directory?: string) {
  if (!directory) {
    directory = await mkdtemp(join(tmpdir(), 'dsh-persistence-flow-'));
    directories.push(directory);
  }
  const stateDirectory = join(directory, 'state');
  const nativeDirectory = join(directory, 'native');
  await mkdir(nativeDirectory, {recursive: true, mode: 0o700});
  const config = parseConfig({profile: 'flow-test', botOpenId: 'ou_bot', stateDir: stateDirectory, users: [
    {openId: 'ou_alice', direct: true, groupChats: ['oc_group', 'oc_other'], cwd: join(directory, 'alice')},
    {openId: 'ou_bob', direct: true, groupChats: ['oc_group'], cwd: join(directory, 'bob')},
  ]});
  const sessions = await SessionStore.open(stateDirectory);
  const memories = await MemoryStore.open(stateDirectory);
  const ledger = await DiskLedger.open(stateDirectory);
  const runtime = new FileRuntime(nativeDirectory);
  const reply = vi.fn(async (_id: string, _text: string, _options: {idempotencyKey: string; inThread: boolean}) => undefined);
  const audit = vi.fn();
  const bridge = new BotBridge(config, runtime, {reply}, ledger, {sessions, memories}, audit);
  bridges.add(bridge);
  const context = (raw = event('context')) => {
    const message = parseMessage(raw, config.botOpenId)!;
    return {ownerKey: ownerKey(message, config), conversationKey: sessionKey(message, config), privateChat: message.chatType === 'p2p'};
  };
  return {directory, config, sessions, memories, ledger, runtime, reply, audit, bridge, context,
    latestReply: () => reply.mock.calls.at(-1)?.[1] ?? ''};
}

afterEach(async () => {
  await Promise.all([...bridges].map(bridge => bridge.stop().catch(() => undefined)));
  bridges.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
  vi.restoreAllMocks();
});

describe('persistent conversation lifecycle', () => {
  it('reopens stores and resumes the exact native history after a full bridge restart', async () => {
    const first = await setup();
    await first.bridge.accept(event('remember in this conversation: cedar'));
    const saved = (await first.sessions.current(first.context()))!;
    await first.bridge.stop();

    const restarted = await setup(first.directory);
    await restarted.bridge.accept(event('continue'));
    expect(restarted.runtime.create).not.toHaveBeenCalled();
    expect(restarted.runtime.resume).toHaveBeenCalledTimes(1);
    expect(restarted.runtime.resume.mock.calls[0]?.[1]).toBe(saved.nativeId);
    expect(restarted.latestReply()).toContain('previous=remember in this conversation: cedar');
    expect((await restarted.sessions.current(restarted.context()))?.id).toBe(saved.id);
  });

  it('evicts only the live handle and restores the same session after idle cleanup', async () => {
    const h = await setup();
    await h.bridge.accept(event('before idle'));
    const saved = (await h.sessions.current(h.context()))!;
    await h.bridge.sweep(Date.now() + h.config.idleTimeoutMs + 1000);
    expect(h.runtime.handles[0]!.dispose).toHaveBeenCalledOnce();
    await h.bridge.accept(event('after idle'));
    expect(h.runtime.create).toHaveBeenCalledOnce();
    expect(h.runtime.resume.mock.calls[0]?.[1]).toBe(saved.nativeId);
    expect(h.latestReply()).toContain('previous=before idle');
  });

  it('archives on /new, keeps memory, lists and restores only the selected old history', async () => {
    const h = await setup();
    await h.bridge.accept(event('/remember 喜欢简短回答'));
    await h.bridge.accept(event('old history'));
    const old = (await h.sessions.current(h.context()))!;
    await h.bridge.accept(event('/rename 原来的计划'));
    await h.bridge.accept(event('/new'));
    expect(await h.sessions.current(h.context())).toBeUndefined();
    expect(await h.memories.list(h.context())).toHaveLength(1);
    await h.bridge.accept(event('/sessions'));
    expect(h.latestReply()).toContain(`/resume ${old.id}`);
    expect(h.latestReply()).toContain('原来的计划');
    await h.bridge.accept(event('/sessions detail'));
    expect(h.latestReply()).toContain(old.id);
    expect(h.latestReply()).toContain('原来的计划');
    expect(h.latestReply()).not.toContain('[当前]');
    expect(h.runtime.create).toHaveBeenCalledOnce();

    await h.bridge.accept(event('new history'));
    const fresh = (await h.sessions.current(h.context()))!;
    expect(fresh.id).not.toBe(old.id);
    expect(h.runtime.handles[1]!.run.mock.calls[0]?.[2]?.memoryText).toContain('喜欢简短回答');
    await h.bridge.accept(event(`/resume ${old.id}`));
    expect(h.latestReply()).toContain('原来的计划');
    expect(h.latestReply()).not.toContain(old.id);
    expect((await h.sessions.current(h.context()))?.id).toBe(old.id);
    await h.bridge.accept(event('continue old'));
    expect(h.latestReply()).toContain('previous=old history');
    expect(h.latestReply()).not.toContain('new history');
  });

  it('retains the prior catalog pointer when switching to an unavailable native log fails', async () => {
    const h = await setup();
    await h.bridge.accept(event('old'));
    const old = (await h.sessions.current(h.context()))!;
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('current'));
    const current = (await h.sessions.current(h.context()))!;
    h.runtime.failResume = id => id === old.nativeId;
    await h.bridge.accept(event(`/resume ${old.id}`));
    expect(h.latestReply()).toContain('无法恢复');
    expect((await h.sessions.current(h.context()))?.id).toBe(current.id);
    await h.bridge.accept(event('continue current'));
    expect(h.runtime.resume.mock.calls.at(-1)?.[1]).toBe(current.nativeId);
    expect(h.latestReply()).toContain('previous=current');
    expect(h.runtime.create).toHaveBeenCalledTimes(2);
  });

  it.each(['new', 'resume'] as const)('does not reuse a disposed wrapper after /%s disposal fails', async command => {
    const h = await setup();
    await h.bridge.accept(event('old conversation'));
    const old = (await h.sessions.current(h.context()))!;
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('current conversation'));
    const current = (await h.sessions.current(h.context()))!;
    const handle = h.runtime.handles[1]!;
    handle.dispose.mockRejectedValueOnce(new DshRuntimeError('TURN_FAILED'));

    await h.bridge.accept(event(command === 'new' ? '/new' : `/resume ${old.id}`));
    expect(h.latestReply()).toContain('处理失败');
    expect((await h.sessions.current(h.context()))?.id).toBe(current.id);
    expect(h.runtime.resume).not.toHaveBeenCalled();

    await h.bridge.accept(event('continue safely'));
    expect(handle.run).toHaveBeenCalledOnce();
    expect(h.runtime.resume.mock.calls.at(-1)?.[1]).toBe(current.nativeId);
    expect(h.latestReply()).toContain('previous=current conversation');
    expect(h.runtime.create).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'corrupt'] as const)('fails closed for a %s native session without creating a replacement', async problem => {
    const first = await setup();
    await first.bridge.accept(event('keep this'));
    const saved = (await first.sessions.current(first.context()))!;
    await first.bridge.stop();
    if (problem === 'missing') await rm(first.runtime.nativeFile(saved.nativeId));
    else await writeFile(first.runtime.nativeFile(saved.nativeId), 'corrupt native log');
    const restarted = await setup(first.directory);
    await restarted.bridge.accept(event('continue'));
    expect(restarted.runtime.resume).toHaveBeenCalledOnce();
    expect(restarted.runtime.create).not.toHaveBeenCalled();
    expect(restarted.latestReply()).toContain('无法恢复');
    expect((await restarted.sessions.current(restarted.context()))?.nativeId).toBe(saved.nativeId);
    expect(await restarted.sessions.list(restarted.context())).toHaveLength(1);
  });

  it('does not publish or acknowledge a native session whose first durability barrier failed', async () => {
    const h = await setup();
    h.runtime.failCheckpoint = (_id, count) => count === 1;
    await h.bridge.accept(event('must not be acknowledged'));
    expect(h.latestReply()).toContain('未能可靠保存');
    expect(h.latestReply()).not.toContain('answer:');
    expect(await h.sessions.current(h.context())).toBeUndefined();
    expect(await h.sessions.list(h.context())).toEqual([]);
    expect(h.runtime.handles[0]!.run).not.toHaveBeenCalled();
    expect(h.runtime.handles[0]!.dispose).toHaveBeenCalledOnce();
  });

  it('does not acknowledge or mark a turn complete when its native checkpoint fails', async () => {
    const h = await setup();
    const touched = vi.spyOn(h.sessions, 'touch');
    h.runtime.failCheckpoint = (_id, count) => count === 2;
    await h.bridge.accept(event('turn with failed persistence'));
    expect(h.latestReply()).toContain('未能可靠保存');
    expect(h.latestReply()).not.toContain('answer:');
    expect(touched).not.toHaveBeenCalled();
    const saved = (await h.sessions.current(h.context()))!;
    // Only the initial empty log was committed; no successful turn is claimed.
    expect(JSON.parse(await readFile(h.runtime.nativeFile(saved.nativeId), 'utf8'))).toEqual([]);
  });
});

describe('persistent ownership and command authorization', () => {
  it('rejects foreign owner/chat/topic resume IDs before any runtime resume call', async () => {
    const h = await setup();
    await h.bridge.accept(event('Alice private title'));
    const privateSession = (await h.sessions.current(h.context()))!;
    const targets = [
      event(`/resume ${privateSession.id}`, {sender_id: 'ou_bob', chat_id: 'oc_bob'}),
      group(`/resume ${privateSession.id}`),
      event(`/resume ${privateSession.id}`, {thread_id: 'omt_other'}),
    ];
    for (const target of targets) {
      await h.bridge.accept(target);
      expect(h.latestReply()).toContain('找不到');
      expect(h.latestReply()).not.toContain(privateSession.title);
    }
    expect(h.runtime.resume).not.toHaveBeenCalled();
    expect(h.runtime.create).toHaveBeenCalledOnce();
    for (const target of [group('/sessions'), event('/sessions', {sender_id: 'ou_bob', chat_id: 'oc_bob'}), event('/sessions', {thread_id: 'omt_other'})]) {
      await h.bridge.accept(target);
      expect(h.latestReply()).not.toContain(privateSession.id);
      expect(h.latestReply()).not.toContain(privateSession.title);
    }
  });

  it('performs no catalog, memory or runtime operations for unauthorized input', async () => {
    const h = await setup();
    const catalog = vi.spyOn(h.sessions, 'current');
    const memory = vi.spyOn(h.memories, 'list');
    for (const raw of [
      event('/sessions', {sender_id: 'ou_stranger'}),
      event('/remember stolen', {sender_id: 'ou_stranger'}),
      group('unknown group', {chat_id: 'oc_forbidden'}),
      group('/memory', {mentions: [{id: 'ou_another_bot', name: 'DSH', key: '@_user_1'}]}),
    ]) await h.bridge.accept(raw);
    expect(catalog).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
    expect(h.runtime.create).not.toHaveBeenCalled();
    expect(h.runtime.resume).not.toHaveBeenCalled();
    expect(h.reply).not.toHaveBeenCalled();
    expect(await h.memories.list(h.context())).toEqual([]);
  });

  it('shares personal knowledge only after an explicit private-chat authorization while keeping history separate', async () => {
    const h = await setup();
    await h.bridge.accept(event('/remember 我喜欢中文'));
    const personal = (await h.memories.list(h.context()))[0]!;
    expect(personal.groupShared).toBe(false);
    expect(await h.memories.list(h.context(group('context')))).toEqual([]);
    await h.bridge.accept(event('/remember --chat 仅私聊项目计划'));
    await h.bridge.accept(event('private first'));
    await h.bridge.accept(event(`/memory share ${personal.id}`));
    expect((await h.memories.list(h.context())).find(memory => memory.id === personal.id)?.groupShared).toBe(true);
    await h.bridge.accept(group('group first'));
    await h.bridge.accept(group('bob first', {sender_id: 'ou_bob'}));
    const [privateHandle, groupHandle, bobHandle] = h.runtime.handles;
    expect(privateHandle!.run.mock.calls[0]?.[2]?.memoryText).toContain('我喜欢中文');
    expect(privateHandle!.run.mock.calls[0]?.[2]?.memoryText).toContain('仅私聊项目计划');
    expect(groupHandle!.run.mock.calls[0]?.[2]?.memoryText).toContain('我喜欢中文');
    expect(groupHandle!.run.mock.calls[0]?.[2]?.memoryText).not.toContain('仅私聊项目计划');
    expect(bobHandle!.run.mock.calls[0]?.[2]?.memoryText).not.toContain('我喜欢中文');
    expect(new Set(h.runtime.handles.map(handle => handle.id)).size).toBe(3);
    expect(groupHandle!.history).toEqual(['group first']);
    expect(bobHandle!.history).toEqual(['bob first']);
  });

  it('never exposes another owner’s memory through list/show/search/forget commands', async () => {
    const h = await setup();
    await h.bridge.accept(event('/remember Alice-only fact'));
    const memory = (await h.memories.list(h.context()))[0]!;
    for (const command of ['/memory', '/memory search Alice', `/memory show ${memory.id}`, `/forget ${memory.id}`]) {
      await h.bridge.accept(event(command, {sender_id: 'ou_bob', chat_id: 'oc_bob'}));
      expect(h.latestReply()).not.toContain('Alice-only fact');
      expect(h.latestReply()).not.toContain(memory.id);
    }
    expect(await h.memories.list(h.context())).toEqual([memory]);
    expect(h.runtime.create).not.toHaveBeenCalled();
  });

  it('refreshes memory on the next turn of an existing live handle after forgetting', async () => {
    const h = await setup();
    await h.bridge.accept(event('/remember erase-me preference'));
    const saved = (await h.memories.list(h.context()))[0]!;
    await h.bridge.accept(event('first'));
    const handle = h.runtime.handles[0]!;
    expect(handle.run.mock.calls[0]?.[2]?.memoryText).toContain('erase-me preference');
    await h.bridge.accept(event(`/forget ${saved.id}`));
    expect(h.latestReply()).toContain('已删除');
    await h.bridge.accept(event('second'));
    expect(h.runtime.create).toHaveBeenCalledOnce();
    expect(handle.run.mock.calls[1]?.[2]?.memoryText).not.toContain('erase-me preference');
    expect(await readFile(h.runtime.nativeFile(handle.id), 'utf8')).not.toContain('erase-me preference');
    expect(await (await MemoryStore.open(join(h.directory, 'state'))).list(h.context())).toEqual([]);
  });

  it('binds model-facing memory capabilities to the authenticated owner and conversation', async () => {
    const h = await setup();
    await h.bridge.accept(event('Alice private'));
    await h.bridge.accept(group('Alice group'));
    await h.bridge.accept(group('Bob group', {sender_id: 'ou_bob'}));
    const [alicePolicy, groupPolicy, bobPolicy] = h.runtime.create.mock.calls.map(([policy]) => policy);
    const global = await alicePolicy!.memory!.remember('Alice personal', 'personal');
    await h.bridge.accept(group('/remember Alice group only'));
    const scoped = (await h.memories.list(h.context(group('context')))).find(memory => memory.scope === 'chat')!;
    expect(scoped.text).toBe('Alice group only');
    expect((await groupPolicy!.memory!.list()).map(memory => memory.text)).toEqual(['Alice group only']);
    expect((await alicePolicy!.memory!.search('Alice')).map(memory => memory.text)).toEqual(['Alice personal']);
    expect(await bobPolicy!.memory!.search('Alice')).toEqual([]);
    expect(await bobPolicy!.memory!.forget(global.id)).toBe(false);
    expect(await bobPolicy!.memory!.forget(scoped.id)).toBe(false);
    expect(await alicePolicy!.memory!.forget(scoped.id)).toBe(false);
    expect(await groupPolicy!.memory!.forget(global.id)).toBe(false);
    for (const scope of ['personal', 'chat'] as const) {
      await expect(groupPolicy!.memory!.remember('Forbidden model copy', scope)).rejects.toThrow();
    }
    expect((await groupPolicy!.memory!.list()).map(memory => memory.text)).toEqual(['Alice group only']);
    expect((await alicePolicy!.memory!.list()).map(memory => memory.text)).toEqual(['Alice personal']);
    expect(await alicePolicy!.memory!.forget(global.id)).toBe(true);
    expect(await alicePolicy!.memory!.list()).toEqual([]);
  });
});
