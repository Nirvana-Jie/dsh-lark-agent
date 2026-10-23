import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BotBridge} from '../src/bridge.js';
import {ArtifactStore} from '../src/artifacts.js';
import {CardActions} from '../src/card-actions.js';
import {SessionStore} from '../src/session-store.js';
import {MemoryStore} from '../src/memory-store.js';
import {DiskLedger} from '../src/ledger.js';
import {parseConfig} from '../src/config.js';
import {ownerKey, parseMessage, sessionKey} from '../src/message.js';
import {presentationDraft, PresentationError, type PresentationDraft} from '../src/presentation.js';
import type {RuntimeSession, AgentPolicy} from '../src/dsh-runtime.js';
import type {ArtifactPublisher} from '../src/artifact-publisher.js';
import type {ReplyPayload} from '../src/replies.js';

let sequence = 0;
const dirs: string[] = [], bridges: BotBridge[] = [];
const chart = presentationDraft({kind: 'chart', title: '示例数据', summary: '这是用于测试的示例柱状图。', content: {type: 'bar', series: ['计数'], data: [{label: 'A', values: [3]}]}});
const diagram = presentationDraft({kind: 'diagram', title: '示例架构', summary: '只包含离线测试使用的节点。', content: {nodes: [{id: 'a', label: '测试节点'}], edges: []}});
const form = presentationDraft({kind: 'form', title: '补充一个选项', summary: '请选择表达方式，然后继续当前任务。', content: {fields: [{id: 'style', label: '表达方式', type: 'select', options: [{value: 'brief', label: '简短'}]}]}});
const message = (text: string, extra: Record<string, unknown> = {}) => ({type: 'im.message.receive_v1', message_type: 'text', sender_type: 'user', sender_id: 'ou_alice', chat_id: 'oc_alice', chat_type: 'p2p', message_id: `om_${++sequence}`, content: text, ...extra});
function tokens(reply: ReplyPayload): string[] {
  const result: string[] = [];
  const visit = (v: any) => {if (!v || typeof v !== 'object') return; if (v.type === 'callback' && typeof v.value?.token === 'string') result.push(v.value.token); for (const value of Object.values(v)) visit(value);};
  if (reply.kind === 'card') visit(reply.card); return result;
}
const click = (token: string, extra: Record<string, unknown> = {}) => ({type: 'card.action.trigger', event_id: `ev_${++sequence}`, operator_id: 'ou_alice', chat_id: 'oc_alice', message_id: 'om_card', action_tag: 'button', action_name: 'dsh_submit', action_value: JSON.stringify({token}), ...extra});
function deferred<T>() {let resolve!: (v: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
async function fixture(draft: PresentationDraft = chart, directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'dsh-presentation-flow-')); if (!directory) dirs.push(dir);
  const config = parseConfig({profile: 'results-test', botOpenId: 'ou_bot', stateDir: join(dir, 'state'), cardInteractions: true, users: [
    {openId: 'ou_alice', direct: true, groupChats: ['oc_group'], cwd: join(dir, 'alice')},
    {openId: 'ou_bob', direct: true, groupChats: ['oc_group'], cwd: join(dir, 'bob')},
  ]});
  const state = {sessions: await SessionStore.open(config.stateDir), memories: await MemoryStore.open(config.stateDir), artifacts: await ArtifactStore.open(config.stateDir), actions: await CardActions.open(config.stateDir, 'results-test')};
  const run = vi.fn<RuntimeSession['run']>(async () => ({text: '', artifacts: [draft]}));
  const handle = (id: string = randomUUID()): RuntimeSession => ({id, run, checkpoint: vi.fn(async () => undefined), cancel: vi.fn(), dispose: vi.fn(async () => undefined)});
  const runtime = {create: vi.fn(async (_policy: AgentPolicy) => handle()), resume: vi.fn(async (_p: unknown, id: string) => handle(id))};
  const payloads: ReplyPayload[] = [];
  const transport = {reply: vi.fn(async (_id: string, text: string) => {payloads.push({kind: 'text', text});}),
    replyRich: vi.fn(async (_id: string, payload: ReplyPayload) => {payloads.push(payload);})};
  const publisher = {preflight: vi.fn<ArtifactPublisher['preflight']>(async () => undefined),
    publish: vi.fn<ArtifactPublisher['publish']>(async (_artifact, _owner, _signal, record) => {await record('doc_fixture'); return {documentId: 'doc_fixture', url: 'https://www.feishu.cn/docx/doc_fixture'};}),
    verify: vi.fn<ArtifactPublisher['verify']>(async () => undefined)};
  const ledger = await DiskLedger.open(config.stateDir);
  const bridge = new BotBridge(config, runtime, transport, ledger, state, undefined, undefined, publisher); bridge.setCardActionsReady(true); bridges.push(bridge);
  const identity = async (raw = message('identity')) => {
    const incoming = parseMessage(raw, config.botOpenId)!;
    const context = {ownerKey: ownerKey(incoming, config), conversationKey: sessionKey(incoming, config)};
    return {...context, sessionId: (await state.sessions.current(context))!.id};
  };
  return {dir, config, state, run, runtime, transport, publisher, bridge, payloads, ledger, identity};
}
afterEach(async () => {await Promise.all(bridges.splice(0).map(bridge => bridge.stop())); await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true}))); vi.useRealTimers();});

describe('rich result lifecycle', () => {
  it('persists before sending and recovers a chart in the same logical topic after restart', async () => {
    const f = await fixture(); await f.bridge.accept(message('用图表表示'));
    expect(f.payloads[0]?.kind).toBe('card'); expect((await f.state.artifacts.list(await f.identity()))[0]?.draft.kind).toBe('chart');
    expect(f.runtime.create.mock.calls[0]?.[0]).toMatchObject({presentation: true, allowedTools: []});
    await f.bridge.stop();
    const restored = await fixture(chart, f.dir); await restored.bridge.accept(message('/results'));
    expect(JSON.stringify(restored.payloads)).toContain('"tag":"chart"'); expect(restored.run).not.toHaveBeenCalled();
  });
  it('sends the answer before its artifact and keeps both when the artifact cannot be saved', async () => {
    const f = await fixture();
    f.run.mockResolvedValue({text: '这是正文结论。', artifacts: [chart]});
    await f.bridge.accept(message('画图并说明'));
    expect(f.payloads.map(payload => payload.kind)).toEqual(['text', 'card']);
    expect(f.payloads[0]).toEqual({kind: 'text', text: '这是正文结论。'});
    f.payloads.length = 0;
    vi.spyOn(f.state.artifacts, 'add').mockRejectedValueOnce(new PresentationError('你的作品数量已达到上限，已有作品会保留。'));
    await f.bridge.accept(message('再画一张'));
    expect(f.payloads).toHaveLength(2);
    expect(f.payloads[0]).toEqual({kind: 'text', text: '这是正文结论。'});
    const fallback = f.payloads[1]!.kind === 'text' ? f.payloads[1]!.text : '';
    expect(fallback).toContain('示例数据'); expect(fallback).toContain('A：计数 3');
    expect(fallback).toContain('未能保存为作品：你的作品数量已达到上限');
  });
  it('resumes an owner-bound form as data and prevents a second submission', async () => {
    const f = await fixture(form); await f.bridge.accept(message('让我选择一下'));
    const token = tokens(f.payloads[0]!)[0]!; expect(token).toBeTruthy();
    await f.bridge.stop();
    const resumed = await fixture(form, f.dir); resumed.run.mockResolvedValue('已按简短方式继续。');
    const event = click(token, {form_value: JSON.stringify({style: 'brief'})});
    await resumed.bridge.accept({...event, operator_id: 'ou_bob'}); expect(resumed.run).not.toHaveBeenCalled();
    await resumed.bridge.accept(event); expect(resumed.run).toHaveBeenCalledOnce();
    expect(resumed.run.mock.calls[0]![0]).toContain('简短'); expect(resumed.run.mock.calls[0]![0]).toContain('用户提供的数据');
    await resumed.bridge.accept(click(token, {form_value: JSON.stringify({style: 'brief'})})); expect(resumed.run).toHaveBeenCalledOnce();
  });
  it('rejects stale topic forms and callback values outside the saved schema', async () => {
    const f = await fixture(form); await f.bridge.accept(message('表单'));
    const token = tokens(f.payloads[0]!)[0]!;
    await f.bridge.accept(click(token, {form_value: JSON.stringify({style: 'unknown', owner: 'ou_bob'})})); expect(f.run).toHaveBeenCalledOnce();
    await f.bridge.accept(message('/results'));
    const fresh = tokens(f.payloads.at(-1)!)[0]!;
    await f.bridge.accept(message('/new'));
    await f.bridge.accept(click(fresh, {form_value: JSON.stringify({style: 'brief'})})); expect(f.run).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.payloads)).toContain('会话状态已改变');
  });
  it('publishes a private diagram only to the structured sender and revalidates remote access on lookup', async () => {
    const f = await fixture(diagram); await f.bridge.accept(message('画出架构'));
    expect(f.publisher.publish.mock.calls[0]?.[1]).toBe('ou_alice');
    expect(JSON.stringify(f.payloads)).toContain('打开画板');
    const row = (await f.state.artifacts.list(await f.identity()))[0]!;
    await f.bridge.accept(message(`/publish ${row.id}`, {sender_id: 'ou_bob', chat_id: 'oc_bob'}));
    expect(f.publisher.publish).toHaveBeenCalledOnce();
    await f.bridge.accept(message('/results')); expect(f.publisher.verify).toHaveBeenCalledOnce();
    f.publisher.verify.mockRejectedValue(new Error('revoked'));
    f.payloads.length = 0; await f.bridge.accept(message('/results'));
    expect(JSON.stringify(f.payloads)).not.toContain('https://');
  });
  it('keeps group artifacts in the authorized chat and does not publish cloud resources', async () => {
    const f = await fixture(diagram);
    await f.bridge.accept(message('@DSH 画出架构', {chat_type: 'group', chat_id: 'oc_group', mentions: [{key: '@_user_1', id: 'ou_bot', name: 'DSH'}]}));
    expect(f.publisher.publish).not.toHaveBeenCalled(); expect(f.publisher.preflight).not.toHaveBeenCalled();
    expect(JSON.stringify(f.payloads)).toContain('测试节点');
  });
  it('retains local content and leaves publication retryable when permission preflight fails', async () => {
    const f = await fixture(diagram); f.publisher.preflight.mockRejectedValue(new PresentationError('请扫码补充权限。'));
    await f.bridge.accept(message('画图'));
    const row = (await f.state.artifacts.list(await f.identity()))[0]!;
    expect(row.publication).toBe('local'); expect(tokens(f.payloads[0]!)).toHaveLength(1); expect(f.publisher.publish).not.toHaveBeenCalled();
  });
  it('does not repeat an uncertain cloud create after a restart', async () => {
    const f = await fixture(diagram); f.publisher.publish.mockRejectedValue(new Error('unknown create'));
    await f.bridge.accept(message('画图'));
    const row = (await f.state.artifacts.list(await f.identity()))[0]!; expect(row.publication).toBe('uncertain');
    await f.bridge.stop();
    const restored = await fixture(diagram, f.dir); await restored.bridge.accept(message(`/publish ${row.id}`));
    expect(restored.publisher.publish).not.toHaveBeenCalled(); expect(JSON.stringify(restored.payloads)).not.toContain('https://');
  });
  it('shows one loading card and updates it after publication, without a fallback on uncertain delivery', async () => {
    const f = await fixture(diagram), gate = deferred<void>();
    f.publisher.preflight.mockImplementation(async () => gate.promise);
    const createFeedback = vi.fn(async () => 'om_loading'), updateFeedback = vi.fn(async () => {throw new Error('unknown patch');});
    await f.bridge.stop();
    const bridge = new BotBridge(f.config, f.runtime, {...f.transport, createFeedback, updateFeedback}, f.ledger, f.state, undefined, undefined, f.publisher); bridges.push(bridge); bridge.setCardActionsReady(true);
    const task = bridge.accept(message('请画图'));
    await vi.waitFor(() => expect(createFeedback).toHaveBeenCalledOnce()); gate.resolve(); await task;
    expect(updateFeedback).toHaveBeenCalledOnce(); expect(f.transport.replyRich).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
  });
});
