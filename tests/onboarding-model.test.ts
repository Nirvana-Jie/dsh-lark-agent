import type {Context} from '@deepseek-ai/cordis';
import type {GenerateOptions, StreamChunk} from '@deepseek-ai/dsh-llm';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseConfig} from '../src/config.js';
import {DshRuntime} from '../src/dsh-runtime.js';
import {SetupError} from '../src/onboarding/controller.js';
import {checkConnectionModel, CONNECTION_TEST_PROMPT} from '../src/onboarding/model-check.js';

const config = parseConfig({profile: 'test-bot', botOpenId: 'ou_bot', users: [
  {openId: 'ou_owner', direct: true, groupChats: [], cwd: '/tmp/lark-connection-workspace'},
]});

afterEach(() => vi.restoreAllMocks());

function fixture(chunks: unknown[] = [
  {type: 'block-end', index: 0, block: {type: 'text', text: '连接成功'}},
  {type: 'finish', reason: {kind: 'stop'}},
]) {
  const create = vi.spyOn(DshRuntime.prototype, 'create').mockResolvedValue({
    id: 'test-session', run: vi.fn(async () => '连接成功'), checkpoint: vi.fn(async () => undefined),
    cancel: vi.fn(), dispose: vi.fn(async () => undefined),
  });
  const stream = vi.fn<(_: GenerateOptions) => AsyncIterable<StreamChunk>>(async function* () {
    yield* chunks as StreamChunk[];
  });
  const currentSelection = vi.fn<() => {provider: string; model: string; reasoningEffort?: string} | undefined>(
    () => ({provider: 'offline', model: 'offline'}));
  const get = vi.fn((name: string) => name === 'llm' ? {stream}
    : name === 'agentDefaultModel' ? {currentSelection} : undefined);
  const ctx = {get} as unknown as Context;
  return {create, stream, currentSelection, get,
    check: (signal = new AbortController().signal, selected = config) => checkConnectionModel(ctx, selected, signal)};
}

describe('connection model check', () => {
  it('checks repeated connections without creating or persisting native conversations', async () => {
    const f = fixture();
    await f.check();
    await f.check();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.stream).toHaveBeenCalledTimes(2);
    const request = f.stream.mock.calls[0]![0];
    expect(request).toEqual({provider: 'offline', model: 'offline', tools: [], signal: expect.any(AbortSignal),
      messages: [expect.objectContaining({role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: CONNECTION_TEST_PROMPT}]})]});
    for (const name of ['agents', 'sessions', 'sessionPersistence', 'workspaceRegistry']) expect(f.get).not.toHaveBeenCalledWith(name);
  });

  it('uses the current host model and thinking depth on each check', async () => {
    const f = fixture();
    await f.check();
    f.currentSelection.mockReturnValue({provider: 'changed', model: 'reasoned', reasoningEffort: 'deep'});
    await f.check();
    expect(f.stream.mock.calls[1]![0]).toMatchObject({provider: 'changed', model: 'reasoned', reasoningEffort: 'deep'});
  });

  it('honors a fixed model route without inheriting unrelated host thinking settings', async () => {
    const f = fixture();
    await f.check(undefined, {...config, provider: 'fixed', model: 'fixed-model'});
    expect(f.currentSelection).not.toHaveBeenCalled();
    expect(f.stream.mock.calls[0]![0]).toMatchObject({provider: 'fixed', model: 'fixed-model'});
    expect(f.stream.mock.calls[0]![0]).not.toHaveProperty('reasoningEffort');
  });

  it('also accepts adapters that provide text deltas without a completed text block', async () => {
    await expect(fixture([{type: 'text-delta', index: 0, text: '连接成功'}, {type: 'finish', reason: {kind: 'stop'}}]).check())
      .resolves.toBeUndefined();
  });

  it.each(['error', 'aborted', 'tool-calls'])('rejects terminal %s even after partial output', async kind => {
    const f = fixture([{type: 'text-delta', index: 0, text: 'partial'},
      {type: 'finish', reason: {kind, failure: {message: 'PRIVATE_PROVIDER_ERROR'}}}]);
    await expect(f.check()).rejects.toThrow('模型连接测试失败');
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each([{chunks: []}, {chunks: [{type: 'text-delta', index: 0, text: 'partial'}]}])('rejects a stream without a terminal result', async ({chunks}) => {
    await expect(fixture(chunks).check()).rejects.toThrow('模型连接测试未完成');
  });

  it('requires an answer, not just reasoning or whitespace', async () => {
    const f = fixture([{type: 'reasoning-delta', index: 0, text: 'thinking'},
      {type: 'block-end', index: 1, block: {type: 'text', text: ' \n '}}, {type: 'finish', reason: {kind: 'stop'}}]);
    await expect(f.check()).rejects.toThrow('模型没有返回内容');
  });

  it('sanitizes provider exceptions and leaves no native conversation', async () => {
    const f = fixture();
    f.stream.mockImplementation(async function* () {throw new Error('PRIVATE_PROVIDER_ERROR');});
    const error = await f.check().catch(error => error);
    expect(error).toBeInstanceOf(SetupError);
    expect(error.message).toContain('模型连接测试失败');
    expect(error.message).not.toContain('PRIVATE');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('rejects missing model configuration without sending a request', async () => {
    const f = fixture();
    f.currentSelection.mockReturnValue(undefined);
    await expect(f.check()).rejects.toThrow('请先在 dsh 的模型设置中选择可用模型');
    expect(f.stream).not.toHaveBeenCalled();
  });

  it('does not start a request after cancellation', async () => {
    const f = fixture();
    await expect(f.check(AbortSignal.abort())).rejects.toThrow('连接已取消');
    expect(f.stream).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'timeout'])('drains the model stream on %s without creating a conversation', async mode => {
    const f = fixture(), abort = new AbortController(), timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const closed = vi.fn();
    f.stream.mockImplementation(async function* (request) {
      try {
        await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), {once: true}));
        yield {type: 'finish', reason: {kind: 'stop'}};
      } finally {closed();}
    });
    const pending = f.check(abort.signal);
    const rejected = expect(pending).rejects.toThrow(mode === 'cancel' ? '连接已取消' : '模型连接测试超时');
    (mode === 'cancel' ? abort : timeout).abort();
    await rejected;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(45_000);
    expect(closed).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
  });
});
