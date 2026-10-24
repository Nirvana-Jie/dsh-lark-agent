import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotBridge } from '../src/bridge.js';
import { CardActions } from '../src/card-actions.js';
import { parseConfig } from '../src/config.js';
import type { AgentPolicy, RuntimeSession, TurnObserver } from '../src/dsh-runtime.js';
import { DiskLedger } from '../src/ledger.js';
import { MemoryStore } from '../src/memory-store.js';
import type { ReplyPayload } from '../src/replies.js';
import { SessionStore } from '../src/session-store.js';
import { ModelPreferencesStore } from '../src/model-preferences.js';
import { PermissionPreferencesStore } from '../src/permission-preferences.js';

const directories: string[] = [];
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

const PERMISSIONS = [{id: 'read-only', name: '仅可查看'}, {id: 'workspace-write', name: '工作区内修改'}, {id: 'danger-full-access', name: '完全权限'}];

async function setup(options: {run?: Run; streaming?: boolean; cards?: boolean; createCardEntity?: () => Promise<string>; permissions?: boolean; models?: boolean} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-channel-bridge-'));
  directories.push(directory);
  const workspace = join(directory, 'alice');
  await mkdir(workspace, {recursive: true});
  const config = parseConfig({profile: 'channel-test', botOpenId: 'ou_bot', stateDir: join(directory, 'state'),
    cardInteractions: options.cards ?? true, streamingCards: options.streaming ?? true, loadingReaction: true,
    users: [{openId: 'ou_alice', direct: true, directMode: 'harness', groupChats: ['oc_group'], cwd: workspace}]});
  const sessions = await SessionStore.open(config.stateDir);
  const memories = await MemoryStore.open(config.stateDir);
  const actions = await CardActions.open(config.stateDir, 'channel-test:ou_bot');
  const ledger = await DiskLedger.open(config.stateDir);
  const run = vi.fn<Run>(options.run ?? (async () => '普通回答'));
  const policies: AgentPolicy[] = [];
  const handles: Array<RuntimeSession & {setPermission?: ReturnType<typeof vi.fn>}> = [];
  const handle = (policy: AgentPolicy, id: string = randomUUID()): RuntimeSession => {
    policies.push(policy);
    let current = 'workspace-write';
    const value = {id, run: (...args: Parameters<Run>) => run(...args), checkpoint: vi.fn(async () => undefined), cancel: vi.fn(), dispose: vi.fn(async () => undefined),
      ...(options.permissions ? {permissionState: () => ({current, options: PERMISSIONS}), setPermission: vi.fn((next: string) => { current = next; })} : {})};
    handles.push(value);
    return value;
  };
  const runtime = {create: vi.fn(async (policy: AgentPolicy) => handle(policy)), resume: vi.fn(async (policy: AgentPolicy, id: string) => handle(policy, id)),
    ...(options.permissions ? {permissionOptions: () => PERMISSIONS} : {}),
    ...(options.models ? {catalog: async () => ({models: [{provider: 'p', providerName: 'Provider', model: 'm', name: 'Model'}], defaultSelection: {provider: 'p', model: 'm'}}),
      resolveModelSelection: async (selection?: {provider: string; model: string}) => selection ?? {provider: 'p', model: 'm'}} : {})};
  let feedbackCount = 0;
  const transport = {
    reply: vi.fn(async (_id: string, _text: string, _options: unknown) => undefined),
    replyRich: vi.fn(async (_id: string, _payload: ReplyPayload, _options: unknown) => undefined),
    createFeedback: vi.fn(async (_target: unknown, _payload: ReplyPayload, _options: unknown) => `om_feedback${++feedbackCount}`),
    updateFeedback: vi.fn(async (_id: string, _payload: ReplyPayload) => undefined),
    createCardEntity: vi.fn(options.createCardEntity ?? (async () => '7355')),
    replyCardEntity: vi.fn(async () => undefined),
    streamCardText: vi.fn(async () => undefined),
    updateCardEntity: vi.fn(async (_id: string, _card: Record<string, unknown>, _sequence: number) => undefined),
    replyFile: vi.fn(async (_id: string, _path: string, _options: {idempotencyKey: string; inThread: boolean; image: boolean}) => undefined),
  };
  const progress = {startProgress: vi.fn(async () => 'reaction'), finishProgress: vi.fn(async () => undefined)};
  const audit = vi.fn();
  const permissionPreferences = options.permissions ? await PermissionPreferencesStore.open(config.stateDir) : undefined;
  const modelPreferences = options.models ? await ModelPreferencesStore.open(config.stateDir) : undefined;
  const bridge = new BotBridge(config, runtime, transport, ledger, {sessions, memories, actions,
    ...(permissionPreferences ? {permissionPreferences} : {}), ...(modelPreferences ? {modelPreferences} : {})}, audit, progress);
  bridge.setCardActionsReady(true);
  bridges.add(bridge);
  const sentText = () => [...transport.reply.mock.calls.map(call => call[1]),
    ...transport.replyRich.mock.calls.map(call => call[1].kind === 'text' ? call[1].text : call[1].kind === 'post' ? call[1].markdown : call[1].fallbackText)];
  const finalCard = () => JSON.stringify(transport.updateCardEntity.mock.calls.at(-1)?.[1] ?? {});
  return {bridge, run, runtime, policies, handles, transport, progress, audit, actions, workspace, sentText, finalCard, permissionPreferences};
}

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

  it('switches the private chat from a card, with a second confirmation for full access, and keeps it for new sessions', async () => {
    const h = await setup({streaming: false, permissions: true});
    await h.bridge.accept(event('hello'));
    expect(h.handles[0]!.setPermission).not.toHaveBeenCalled();
    await h.bridge.accept(event('/permission'));
    const panel = rich(h).at(-1)!;
    expect(JSON.stringify(panel)).toContain('当前：工作区内修改');
    const buttons = tokens(panel).map(token => ({token, command: h.actions.verify(token)!.command}));
    expect(buttons.map(button => button.command)).toEqual(['/permission use read-only', '/permission use workspace-write', '/permission use danger-full-access']);
    expect(JSON.stringify(panel)).toContain('切换到「完全权限」？');
    await h.bridge.accept(callback(buttons[2]!.token));
    expect(h.handles[0]!.setPermission).toHaveBeenCalledExactlyOnceWith('danger-full-access');
    expect(JSON.stringify(rich(h).at(-1))).toContain('权限模式已更新');
    // A one-time button cannot switch again.
    await h.bridge.accept(callback(buttons[2]!.token));
    expect(h.handles[0]!.setPermission).toHaveBeenCalledOnce();
    await h.bridge.accept(event('/new'));
    await h.bridge.accept(event('next topic'));
    expect(h.handles[1]!.setPermission).toHaveBeenCalledExactlyOnceWith('danger-full-access');
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
