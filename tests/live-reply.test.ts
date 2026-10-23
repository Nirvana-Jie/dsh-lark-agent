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
  return {transport, audit, sleep, reply, advance, sequences};
}

const elements = (card: unknown) => (card as Card).body.elements;
const panel = (card: unknown) => elements(card).find(element => element.tag === 'collapsible_panel');
const element = (card: unknown, id: string) => {
  for (const item of elements(card)) {
    if (item.element_id === id) return item;
    const nested = (item.elements as Array<Record<string, any>> | undefined)?.find(child => child.element_id === id);
    if (nested) return nested;
  }
};

describe('LiveReply streaming card', () => {
  it('keeps the ordinary reply path when the card entity cannot be created', async () => {
    const h = harness({createCardEntity: async () => { throw new Error('missing scope'); }});
    await expect(h.reply.open()).resolves.toBe(false);
    expect(h.transport.replyCardEntity).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith('live-card-unavailable');
  });

  it('opens one streaming card as a reply to the prompt', async () => {
    const h = harness();
    await expect(h.reply.open()).resolves.toBe(true);
    const card = h.transport.createCardEntity.mock.calls[0]![0];
    expect((card as Card).config).toMatchObject({update_multi: true, streaming_mode: true, summary: {content: '正在思考…'}});
    expect(panel(card)).toMatchObject({element_id: 'think_panel', expanded: true});
    expect(element(card, 'think')?.content).toContain('正在思考');
    expect(h.transport.replyCardEntity).toHaveBeenCalledWith('om_prompt', '7355', {idempotencyKey: 'live-key', inThread: false});
  });

  it('keeps streaming when the reply result is unknown, because it may have been delivered', async () => {
    const h = harness({replyCardEntity: async () => { throw new Error('timeout'); }});
    await expect(h.reply.open()).resolves.toBe(true);
    expect(h.audit).toHaveBeenCalledWith('live-card-delivery-unknown');
    h.reply.push({type: 'reasoning', text: 'still visible'});
    await vi.waitFor(() => expect(h.transport.streamCardText).toHaveBeenCalled());
  });

  it('streams reasoning, collapses it when the answer starts, then streams the answer with increasing sequences', async () => {
    const h = harness();
    await h.reply.open();
    h.reply.push({type: 'attempt'});
    h.reply.push({type: 'reasoning', text: 'Compare the two '});
    h.reply.push({type: 'reasoning', text: 'options first.'});
    await vi.waitFor(() => expect(h.transport.streamCardText).toHaveBeenCalledWith('7355', 'think', expect.stringContaining('Compare the two options first.'), 1));
    h.reply.push({type: 'text', text: 'Option A'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(1));
    const collapsed = h.transport.updateCardEntity.mock.calls[0]![1];
    expect(panel(collapsed)).toMatchObject({expanded: false});
    expect((collapsed as Card).config).toMatchObject({streaming_mode: true});
    expect(element(collapsed, 'answer')?.content).toBe('Option A');
    h.reply.push({type: 'text', text: ' is faster.'});
    await vi.waitFor(() => expect(h.transport.streamCardText).toHaveBeenCalledWith('7355', 'answer', 'Option A is faster.', expect.any(Number)));
    const sequences = h.sequences();
    expect(sequences).toEqual([...new Set(sequences)]);
    expect(sequences[0]).toBe(1);
  });

  it('drops a retried attempt and shows tool progress among the thinking steps', async () => {
    const h = harness();
    await h.reply.open();
    h.reply.push({type: 'attempt'});
    h.reply.push({type: 'text', text: 'draft that will be retried'});
    h.reply.push({type: 'discard'});
    h.reply.push({type: 'attempt'});
    h.reply.push({type: 'tool', callId: 'c1', name: 'web_search', detail: 'LodyAI'});
    h.reply.push({type: 'tool-done', callId: 'c1', ok: true});
    h.reply.push({type: 'text', text: 'final'});
    const {confirmed} = await h.reply.finish({phase: 'done', answer: 'final'});
    expect(confirmed).toBe(true);
    const final = h.transport.updateCardEntity.mock.calls.at(-1)![1];
    expect(element(final, 'think')?.content).toContain('✅ `web_search` `LodyAI`');
    expect(element(final, 'answer')?.content).toBe('final');
    expect(JSON.stringify(final)).not.toContain('draft that will be retried');
    expect(panel(final)?.header.title.content).toMatch(/^已思考（用时 \d+ 秒） · 使用工具 1 次$/);
  });

  it('writes an inert final card and closes streaming mode', async () => {
    const h = harness();
    await h.reply.open();
    h.advance(4_000);
    const {overflow, confirmed} = await h.reply.finish({phase: 'done', answer: 'Hi <at id=all></at> [x](javascript:alert(1))', reasoning: 'why'});
    expect({overflow, confirmed}).toEqual({overflow: '', confirmed: true});
    const final = h.transport.updateCardEntity.mock.calls.at(-1)![1];
    expect((final as Card).config).toMatchObject({streaming_mode: false});
    expect((final as Card).config).not.toHaveProperty('streaming_config');
    expect(element(final, 'answer')?.content).not.toContain('<at');
    expect(element(final, 'answer')?.content).not.toContain('](javascript:');
    expect(element(final, 'think')?.content).toBe('why');
    expect(panel(final)?.header.title.content).toBe('已思考（用时 4 秒）');
  });

  it('fits a long answer into one card and returns the rest at a block boundary', async () => {
    const h = harness();
    await h.reply.open();
    const paragraphs = Array.from({length: 80}, (_unused, index) => `第 ${index} 段：${'内容'.repeat(120)}`);
    const answer = paragraphs.join('\n\n');
    const {overflow, confirmed} = await h.reply.finish({phase: 'done', answer});
    expect(confirmed).toBe(true);
    const final = h.transport.updateCardEntity.mock.calls.at(-1)![1];
    expect(Buffer.byteLength(JSON.stringify(final))).toBeLessThanOrEqual(28_000);
    const shown = element(final, 'answer')?.content as string;
    expect(overflow.startsWith('第 ')).toBe(true);
    expect(shown.trimEnd() + '\n\n' + overflow).toBe(answer);
    expect(element(final, 'note')?.content).toContain('余下内容在下一条消息');
  });

  it('retries the idempotent final update and reports an unconfirmed card', async () => {
    const h = harness({updateCardEntity: async () => { throw new Error('unknown'); }});
    await h.reply.open();
    await expect(h.reply.finish({phase: 'failed', note: '处理没有完成，请稍后重试。'})).resolves.toEqual({overflow: '', confirmed: false});
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
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalledWith('live-card-degraded'));
    h.reply.push({type: 'reasoning', text: ' second'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalled());
    expect(element(h.transport.updateCardEntity.mock.calls[0]![1], 'think')?.content).toContain('first second');
  });

  it('turns streaming mode back on before Feishu closes it after ten minutes', async () => {
    const h = harness();
    await h.reply.open();
    h.advance(9 * 60_000 + 1);
    h.reply.push({type: 'reasoning', text: 'long task'});
    await vi.waitFor(() => expect(h.transport.updateCardEntity).toHaveBeenCalledTimes(1));
    expect((h.transport.updateCardEntity.mock.calls[0]![1] as Card).config).toMatchObject({streaming_mode: true});
    expect(h.transport.streamCardText).not.toHaveBeenCalled();
  });
});
