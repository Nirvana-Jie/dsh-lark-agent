import {afterEach, describe, expect, it, vi} from 'vitest';
import {CommandFeedback} from '../src/command-feedback.js';
import type {ReplyPayload} from '../src/replies.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const result: ReplyPayload = {kind: 'text', text: '设置已更新'};
function setup(delayMs?: number) {
  vi.useFakeTimers();
  const create = vi.fn<() => Promise<string>>().mockResolvedValue('om_feedback');
  const update = vi.fn<(id: string, payload: ReplyPayload) => Promise<void>>().mockResolvedValue(undefined);
  const fallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const feedback = new CommandFeedback(create, update, delayMs);
  return {create, update, fallback, feedback};
}

afterEach(() => {vi.useRealTimers();});

describe('delayed command feedback', () => {
  it('sends a fast result normally and cancels the pending loading message', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.create).not.toHaveBeenCalled();
    await h.feedback.finish(result, h.fallback);
    await vi.runAllTimersAsync();
    expect(h.fallback).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates loading after the default delay and updates the exact same message with the final payload', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.create).toHaveBeenCalledTimes(1);
    const card: ReplyPayload = {kind: 'card', card: {schema: '2.0', body: {elements: []}}, fallbackText: '模型选择'};
    await h.feedback.finish(card, h.fallback);
    expect(h.update).toHaveBeenCalledExactlyOnceWith('om_feedback', card);
    expect(h.fallback).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('uses the configured delay without starting an unnecessary earlier loading request', async () => {
    const h = setup(50);
    await vi.advanceTimersByTimeAsync(49);
    expect(h.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    await h.feedback.finish(result, h.fallback);
    expect(h.update).toHaveBeenCalledExactlyOnceWith('om_feedback', result);
  });

  it('waits for an in-flight loading creation before updating, even when the command finishes first', async () => {
    const h = setup(), created = deferred<string>(), done = vi.fn();
    h.create.mockReturnValue(created.promise);
    await vi.advanceTimersByTimeAsync(200);
    const finishing = h.feedback.finish(result, h.fallback).then(done);
    await Promise.resolve();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    created.resolve('om_late_feedback');
    await finishing;
    expect(h.update).toHaveBeenCalledExactlyOnceWith('om_late_feedback', result);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('waits for the final update to settle before acknowledging completion', async () => {
    const h = setup(), updated = deferred(), done = vi.fn();
    h.update.mockReturnValue(updated.promise);
    await vi.advanceTimersByTimeAsync(200);
    const finishing = h.feedback.finish(result, h.fallback).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    updated.resolve();
    await finishing;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it.each(['fast', 'loading pending', 'loading created'] as const)('finishes only once when competing callers race: %s', async mode => {
    const h = setup(), created = deferred<string>(), alternative = vi.fn(async () => undefined);
    if (mode === 'loading pending') h.create.mockReturnValue(created.promise);
    if (mode !== 'fast') await vi.advanceTimersByTimeAsync(200);
    const first = h.feedback.finish(result, h.fallback);
    const second = h.feedback.finish({kind: 'text', text: '不应重复发送'}, alternative);
    created.resolve('om_feedback');
    await Promise.all([first, second]);
    await h.feedback.finish({kind: 'text', text: '仍不应重复发送'}, alternative);
    expect(alternative).not.toHaveBeenCalled();
    if (mode === 'fast') {
      expect(h.fallback).toHaveBeenCalledTimes(1);
      expect(h.update).not.toHaveBeenCalled();
    } else {
      expect(h.update).toHaveBeenCalledExactlyOnceWith('om_feedback', result);
      expect(h.fallback).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the timer cancelled while the fast delivery remains in flight', async () => {
    const h = setup(), sent = deferred();
    h.fallback.mockReturnValue(sent.promise);
    const finishing = h.feedback.finish(result, h.fallback);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.create).not.toHaveBeenCalled();
    sent.resolve();
    await finishing;
    expect(h.fallback).toHaveBeenCalledTimes(1);
  });

  it.each(['sync', 'async'] as const)('contains a %s loading creation failure and never sends a duplicate fallback', async mode => {
    const h = setup(), failure = new Error('unknown loading delivery');
    if (mode === 'sync') h.create.mockImplementation(() => {throw failure;});
    else h.create.mockRejectedValue(failure);
    await vi.advanceTimersByTimeAsync(200);
    await expect(h.feedback.finish(result, h.fallback)).rejects.toBe(failure);
    await h.feedback.finish(result, h.fallback).catch(() => undefined);
    await vi.runAllTimersAsync();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it('rejects a late creation failure without falling back or retrying', async () => {
    const h = setup(), created = deferred<string>(), failure = new Error('creation confirmation lost');
    h.create.mockReturnValue(created.promise);
    await vi.advanceTimersByTimeAsync(200);
    const finishing = expect(h.feedback.finish(result, h.fallback)).rejects.toBe(failure);
    created.reject(failure);
    await finishing;
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it.each(['sync', 'async'] as const)('rejects a %s update failure without sending another message or retrying', async mode => {
    const h = setup(), failure = new Error('update confirmation lost');
    if (mode === 'sync') h.update.mockImplementation(() => {throw failure;});
    else h.update.mockRejectedValue(failure);
    await vi.advanceTimersByTimeAsync(200);
    await expect(h.feedback.finish(result, h.fallback)).rejects.toBe(failure);
    await h.feedback.finish(result, h.fallback).catch(() => undefined);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain fast delivery or later send loading', async () => {
    const h = setup(), failure = new Error('fast delivery confirmation lost');
    h.fallback.mockRejectedValue(failure);
    await expect(h.feedback.finish(result, h.fallback)).rejects.toBe(failure);
    await h.feedback.finish(result, h.fallback).catch(() => undefined);
    await vi.runAllTimersAsync();
    expect(h.fallback).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});
