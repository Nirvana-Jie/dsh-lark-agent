import { describe, expect, it, vi } from 'vitest';
import { LiveReply, type LiveCardTransport } from '../src/live-reply.js';

type Card = {config: Record<string, unknown>; body: {elements: Array<Record<string, any>>}};

function harness(overrides: Partial<Record<keyof LiveCardTransport, (...args: any[]) => Promise<any>>> = {}) {
  const transport = {
    createCardEntity: vi.fn(overrides.createCardEntity ?? (async (_card: Record<string, unknown>) => '7355')),
    replyCardEntity: vi.fn(overrides.replyCardEntity ?? (async () => undefined)),
    streamCardText: vi.fn(overrides.streamCardText ?? (async (_id: string, _element: string, _content: string, _sequence: number) => undefined)),
    updateCardEntity: vi.fn(overrides.updateCardEntity ?? (async (_id: string, _card: Record<string, unknown>, _sequence: number) => undefined)),
  };
  const audit = vi.fn();
  const sleep = vi.fn(async (_ms: number) => undefined);
  let clock = 1_000;
  const now = () => clock;
  const reply = new LiveReply(transport, {messageId: 'om_prompt', inThread: false, idempotencyKey: 'live-key'}, {now, sleep, audit});
  const advance = (ms: number) => { clock += ms; };
  const sequences = () => [...transport.streamCardText.mock.calls.map(call => call[3]), ...transport.updateCardEntity.mock.calls.map(call => call[2])]
    .sort((a, b) => a - b);
  const last = () => transport.updateCardEntity.mock.calls.at(-1)![1];
  return {transport, audit, sleep, reply, advance, sequences, last};
}

const elements = (card: unknown) => (card as Card).body.elements;
const panel = (card: unknown) => elements(card).find(element => element.tag === 'collapsible_panel');
const title = (card: unknown) => panel(card)?.header.title.content as string;
const rows = (card: unknown) => (panel(card)?.elements ?? []) as Array<Record<string, any>>;
const element = (card: unknown, id: string) => [...elements(card), ...rows(card)].find(item => item.element_id === id);

describe('LiveReply streaming card', () => {
  it('keeps the ordinary reply path when the card entity cannot be created', async () => {
    const h = harness({createCardEntity: async () => { throw new Error('missing scope'); }});
    await expect(h.reply.open()).resolves.toBe(false);
    expect(h.transport.replyCardEntity).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith('live-card-unavailable');
  });

  it('opens one streaming card as a reply to the prompt, with the process folded', async () => {
    const h = harness();
    await expect(h.reply.open()).resolves.toBe(true);
    const card = h.transport.createCardEntity.mock.calls[0]![0];
    expect((card as Card).config).toMatchObject({update_multi: true, streaming_mode: true, summary: {content: '正在思考…'}});
    expect(panel(card)).toMatchObject({element_id: 'think_panel', expanded: false});
    // Plain text: a tool detail in the title can never become a link or mention.
    expect(panel(card)?.header.title).toEqual({tag: 'plain_text', content: '正在思考…'});
    expect(rows(card)[0]?.content).toContain('正在思考');
    expect(h.transport.replyCardEntity).toHaveBeenCalledWith('om_prompt', '7355', {idempotencyKey: 'live-key', inThread: false});
  });

  it('keeps updating when the reply result is unknown, because it may have been delivered', async () => {
    const h = harness({replyCardEntity: async () => { throw new Error('timeout'); }});
    await expect(h.reply.open()).resolves.toBe(true);
    expect(h.audit).toHaveBeenCalledWith('live-card-delivery-unknown');
    h.reply.push({type: 'reasoning', text: 'still visible'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalled());
    expect(element(h.last(), 's0')?.content).toContain('still visible');
  });

  it('adds each thought as a row, streams its growth, retitles the panel when the answer starts, then streams the answer', async () => {
    const h = harness();
    await h.reply.open();
    h.reply.push({type: 'attempt'});
    h.reply.push({type: 'reasoning', text: 'Compare the two '});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(1));
    expect(element(h.last(), 's0')).toMatchObject({icon: {token: 'mindnote_outlined'}});
    h.reply.push({type: 'reasoning', text: 'options first.'});
    await vi.waitFor(() => expect(h.transport.streamCardText).toHaveBeenCalledWith('7355', 's0', expect.stringContaining('Compare the two options first.'), expect.any(Number)));
    h.advance(3_000);
    h.reply.push({type: 'text', text: 'Option A'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(2));
    expect(panel(h.last())).toMatchObject({expanded: false});
    expect(title(h.last())).toBe('已思考 3 秒');
    expect((h.last() as Card).config).toMatchObject({streaming_mode: true});
    expect(element(h.last(), 'answer')?.content).toBe('Option A');
    h.reply.push({type: 'text', text: ' is faster.'});
    await vi.waitFor(() => expect(h.transport.streamCardText).toHaveBeenCalledWith('7355', 'answer', 'Option A is faster.', expect.any(Number)));
    const sequences = h.sequences();
    expect(sequences).toEqual([...new Set(sequences)]);
    expect(sequences[0]).toBe(1);
  });

  it('names the running step in the title and shows tool calls as App-style rows', async () => {
    const h = harness();
    await h.reply.open();
    h.reply.push({type: 'attempt'});
    h.reply.push({type: 'text', text: 'draft that will be retried'});
    h.reply.push({type: 'discard'});
    h.reply.push({type: 'attempt'});
    h.reply.push({type: 'tool', callId: 'c1', name: 'web_search', detail: 'LodyAI 是什么'});
    await vi.waitFor(() => expect(title(h.last())).toBe('正在搜索网页 · LodyAI 是什么'));
    expect(element(h.last(), 's0')).toMatchObject({icon: {token: 'internet_outlined', color: 'grey'}});
    expect(element(h.last(), 's0')?.content).toContain('进行中');
    h.reply.push({type: 'tool-done', callId: 'c1', ok: true});
    h.reply.push({type: 'tool', callId: 'c2', name: 'bash', detail: 'npm test', code: true});
    h.reply.push({type: 'tool-done', callId: 'c2', ok: true, exitCode: 1});
    h.reply.push({type: 'text', text: 'final'});
    await expect(h.reply.finish({phase: 'done', answer: 'final'})).resolves.toBe(true);
    const final = h.last();
    expect(element(final, 's0')?.content).toBe("网页搜索 · <font color='grey'>LodyAI 是什么</font>");
    expect(element(final, 's1')).toMatchObject({icon: {token: 'code_outlined', color: 'red'}});
    expect(element(final, 's1')?.content).toBe("运行命令 · `npm test` · <font color='red'>退出码 1</font>");
    expect(element(final, 'answer')?.content).toBe('final');
    expect(JSON.stringify(final)).not.toContain('draft that will be retried');
    expect(panel(final)).toMatchObject({expanded: false});
    expect(title(final)).toMatch(/^已完成，用时 \d+ 秒 · 2 次工具调用$/);
  });

  it('writes an inert final card with the settings footer and closes streaming mode', async () => {
    const h = harness();
    await h.reply.open();
    h.reply.setFooter('DeepSeek V4 · 思考深度 高 · 权限 完全权限');
    await vi.waitFor(() => expect(element(h.last(), 'footer')?.content).toContain('DeepSeek V4 · 思考深度 高'));
    h.advance(4_000);
    await expect(h.reply.finish({phase: 'done', answer: 'Hi <at id=all></at> [x](javascript:alert(1))', reasoning: 'why'})).resolves.toBe(true);
    const final = h.last();
    expect((final as Card).config).toMatchObject({streaming_mode: false});
    expect((final as Card).config).not.toHaveProperty('streaming_config');
    expect(element(final, 'answer')?.content).not.toContain('<at');
    expect(element(final, 'answer')?.content).not.toContain('](javascript:');
    expect(rows(final).map(row => row.content)).toEqual(['why']);
    expect(title(final)).toBe('已完成，用时 4 秒');
    expect(elements(final).at(-1)).toMatchObject({element_id: 'footer', icon: {token: 'robot_outlined'}});
  });

  it('reads a long turn in minutes and hours', async () => {
    const minutes = harness();
    await minutes.reply.open();
    minutes.advance(25 * 60_000 + 7_000);
    await minutes.reply.finish({phase: 'done', answer: 'done', reasoning: 'why'});
    expect(title(minutes.last())).toBe('已完成，用时 25 分 7 秒');
    const hours = harness();
    await hours.reply.open();
    hours.advance(2 * 3_600_000 + 3 * 60_000 + 59_000);
    await hours.reply.finish({phase: 'stopped', note: '已停止。', reasoning: 'why'});
    expect(title(hours.last())).toBe('已停止，用时 2 小时 3 分');
  });

  it('shows a long process in full when it fits, and an answer first when the card cannot hold both', async () => {
    const h = harness();
    await h.reply.open();
    // Larger than the old 8 KB cap: the whole thought stays visible.
    const thought = '推理'.repeat(2_000);
    h.reply.push({type: 'reasoning', text: thought});
    await expect(h.reply.finish({phase: 'done', answer: 'short answer'})).resolves.toBe(true);
    expect(element(h.last(), 's0')?.content).toBe(thought);
    expect(Buffer.byteLength(JSON.stringify(h.last()))).toBeLessThanOrEqual(28_000);

    const busy = harness();
    await busy.reply.open();
    busy.reply.push({type: 'reasoning', text: '推理'.repeat(3_000)});
    const fitting = Array.from({length: 20}, (_unused, index) => `第 ${index} 段：${'内容'.repeat(190)}`).join('\n\n');
    await expect(busy.reply.finish({phase: 'done', answer: fitting})).resolves.toBe(true);
    const final = busy.last();
    expect(Buffer.byteLength(JSON.stringify(final))).toBeLessThanOrEqual(28_000);
    expect(element(final, 'answer')?.content).toBe(fitting);
    expect(element(final, 'note')).toBeUndefined();
    // The thought keeps its most recent part, marked as cut.
    expect(element(final, 's0')?.content).toMatch(/^<font color='grey'>…<\/font>\n(推理)+$/);
    expect(title(final)).toMatch(/^已完成/);

    const longer = harness();
    await longer.reply.open();
    const answer = Array.from({length: 80}, (_unused, index) => `第 ${index} 段：${'内容'.repeat(120)}`).join('\n\n');
    await expect(longer.reply.finish({phase: 'done', answer})).resolves.toBe(true);
    const cut = longer.last();
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(28_000);
    const shown = element(cut, 'answer')?.content as string;
    expect(answer.startsWith(shown.trimEnd())).toBe(true);
    expect(shown.length).toBeLessThan(answer.length);
    expect(element(cut, 'note')?.content).toContain('飞书卡片的长度上限');
    // Nothing is left over to send as another message.
    expect(longer.transport.replyCardEntity).toHaveBeenCalledOnce();
  });

  it('folds the oldest steps into a note when there are more than the card can list', async () => {
    const h = harness();
    await h.reply.open();
    for (let index = 0; index < 70; index++) {
      h.reply.push({type: 'tool', callId: `c${index}`, name: 'read', detail: `file-${index}.md`, code: true});
      h.reply.push({type: 'tool-done', callId: `c${index}`, ok: true});
    }
    await expect(h.reply.finish({phase: 'done', answer: 'read them all'})).resolves.toBe(true);
    const listed = rows(h.last());
    expect(listed[0]).toMatchObject({element_id: 'omitted'});
    expect(listed).toHaveLength(61);
    expect(listed.at(-1)?.content).toContain('file-69.md');
    expect(title(h.last())).toMatch(/70 次工具调用$/);
  });

  it('retries the idempotent final update and reports an unconfirmed card', async () => {
    const h = harness({updateCardEntity: async () => { throw new Error('unknown'); }});
    await h.reply.open();
    await expect(h.reply.finish({phase: 'failed', note: '处理没有完成，请稍后重试。'})).resolves.toBe(false);
    expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(3);
    expect(h.sequences()).toEqual([1, 2, 3]);
    expect(h.sleep).toHaveBeenCalledWith(500);
    expect(h.sleep).toHaveBeenCalledWith(1_500);
    expect(h.audit).toHaveBeenCalledWith('live-card-final-failed');
  });

  it('switches to whole-card updates after a stream update fails', async () => {
    const h = harness({streamCardText: async () => { throw new Error('streaming closed'); }});
    await h.reply.open();
    h.reply.push({type: 'reasoning', text: 'first'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(1));
    h.reply.push({type: 'reasoning', text: ' second'});
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalledWith('live-card-degraded'));
    h.reply.push({type: 'reasoning', text: ' third'});
    await vi.waitFor(() => expect(element(h.last(), 's0')?.content).toContain('first second third'));
  });

  it('turns streaming mode back on before Feishu closes it after ten minutes', async () => {
    const h = harness();
    await h.reply.open();
    h.reply.push({type: 'reasoning', text: 'long task'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(1));
    h.advance(9 * 60_000 + 1);
    h.reply.push({type: 'reasoning', text: ' continues'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(2));
    expect((h.last() as Card).config).toMatchObject({streaming_mode: true});
    expect(h.transport.streamCardText).not.toHaveBeenCalled();
  });
});
