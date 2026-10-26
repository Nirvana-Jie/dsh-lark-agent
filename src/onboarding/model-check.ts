import type {Context} from '@deepseek-ai/cordis';
import {createUserMessage, ReasoningEffortId, type LlmRuntime} from '@deepseek-ai/dsh-llm';
import type {BotConfig} from '../config.js';
import {SetupError} from './controller.js';

export const CONNECTION_TEST_PROMPT = '这是飞书连接测试，请只回复“连接成功”。';

/** One model call, without an Agent or a durable conversation to clean up. */
export async function checkConnectionModel(ctx: Context, config: Pick<BotConfig, 'provider' | 'model'>, signal: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(45_000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    combined.throwIfAborted();
    const selection = config.provider && config.model ? {provider: config.provider, model: config.model}
      : (ctx.get('agentDefaultModel') as {currentSelection?(): {provider?: string; model?: string; reasoningEffort?: string}} | undefined)?.currentSelection?.();
    const llm = ctx.get('llm') as LlmRuntime | undefined;
    if (!selection?.provider || !selection.model || typeof llm?.stream !== 'function') {
      throw new SetupError('请先在 dsh 的模型设置中选择可用模型，然后回来继续连接飞书。');
    }
    let text = false, finished = false;
    for await (const chunk of llm.stream({
      provider: selection.provider, model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : {reasoningEffort: ReasoningEffortId(selection.reasoningEffort)}),
      messages: [createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: CONNECTION_TEST_PROMPT}]})],
      tools: [], signal: combined,
    })) {
      combined.throwIfAborted();
      if (chunk.type === 'text-delta') text ||= Boolean(chunk.text.trim());
      if (chunk.type === 'block-end' && chunk.block.type === 'text') text ||= Boolean(chunk.block.text.trim());
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted' || chunk.reason.kind === 'tool-calls') {
          throw new SetupError('模型连接测试失败，请检查模型设置后重试。');
        }
        finished = true;
      }
    }
    combined.throwIfAborted();
    if (!finished) throw new SetupError('模型连接测试未完成，请检查模型设置后重试。');
    if (!text) throw new SetupError('模型没有返回内容，请检查模型设置后重试。');
  } catch (error) {
    if (signal.aborted) throw new SetupError('连接已取消。');
    if (timeout.aborted) throw new SetupError('模型连接测试超时，请检查模型设置后重试。');
    if (error instanceof SetupError) throw error;
    throw new SetupError('模型连接测试失败，请检查模型设置后重试。');
  }
}
