import { describe, expect, it, vi } from 'vitest';
import { ProgressTracker, type ProgressTransport } from '../src/progress.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function transport() {
  return {
    startProgress: vi.fn<ProgressTransport['startProgress']>().mockResolvedValue('reaction-1'),
    finishProgress: vi.fn<ProgressTransport['finishProgress']>().mockResolvedValue(undefined),
  };
}
async function settle(): Promise<void> {
  // No timers are used by the tracker; drain its bounded promise continuations.
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe('best-effort progress tracking', () => {
  it('starts immediately while begin and finish remain synchronous and nonblocking', async () => {
    const api = transport();
    const added = deferred<string>(), removed = deferred();
    api.startProgress.mockReturnValue(added.promise);
    api.finishProgress.mockReturnValue(removed.promise);
    const tracker = new ProgressTracker(api);
    const finish = tracker.begin('om_request');
    expect(typeof finish).toBe('function');
    expect(api.startProgress).toHaveBeenCalledWith('om_request');
    expect(finish()).toBeUndefined();
    expect(api.finishProgress).not.toHaveBeenCalled();
    added.resolve('reaction-late');
    await settle();
    expect(api.finishProgress).toHaveBeenCalledWith('om_request', 'reaction-late');
    removed.resolve();
    await tracker.drain();
  });

  it('removes a late successful add even when the operation finished before its id arrived', async () => {
    const api = transport();
    const added = deferred<string>();
    api.startProgress.mockReturnValue(added.promise);
    const tracker = new ProgressTracker(api);
    tracker.begin('om_request')();
    added.resolve('reaction-late');
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenCalledExactlyOnceWith('om_request', 'reaction-late');
  });

  it('shares one reaction across concurrent operations for the same message', async () => {
    const api = transport();
    const tracker = new ProgressTracker(api);
    const first = tracker.begin('om_card'), second = tracker.begin('om_card');
    await settle();
    expect(api.startProgress).toHaveBeenCalledTimes(1);
    first();
    await settle();
    expect(api.finishProgress).not.toHaveBeenCalled();
    second();
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenCalledExactlyOnceWith('om_card', 'reaction-1');
  });

  it('keeps different message indicators independent', async () => {
    const api = transport();
    api.startProgress.mockImplementation(async message => `reaction-${message}`);
    const tracker = new ProgressTracker(api);
    const first = tracker.begin('om_first'), second = tracker.begin('om_second');
    await settle();
    first();
    await settle();
    expect(api.finishProgress).toHaveBeenCalledExactlyOnceWith('om_first', 'reaction-om_first');
    second();
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenCalledWith('om_second', 'reaction-om_second');
  });

  it('keeps the shared reaction when a new begin races with the completion continuation', async () => {
    const api = transport();
    const tracker = new ProgressTracker(api);
    const first = tracker.begin('om_card');
    await settle();
    first();
    let next!: () => void;
    queueMicrotask(() => { next = tracker.begin('om_card'); });
    await settle();
    expect(api.startProgress).toHaveBeenCalledTimes(1);
    expect(api.finishProgress).not.toHaveBeenCalled();
    next();
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenCalledTimes(1);
  });

  it('waits for deletion to complete before adding a new generation for the same message', async () => {
    const api = transport();
    const oldDeletion = deferred();
    api.startProgress.mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    api.finishProgress.mockReturnValueOnce(oldDeletion.promise);
    const tracker = new ProgressTracker(api);
    tracker.begin('om_card')();
    await settle();
    expect(api.finishProgress).toHaveBeenCalledWith('om_card', 'old');
    const next = tracker.begin('om_card');
    await settle();
    expect(api.startProgress).toHaveBeenCalledTimes(1);
    oldDeletion.resolve();
    await settle();
    expect(api.startProgress).toHaveBeenCalledTimes(2);
    expect(api.finishProgress).toHaveBeenCalledTimes(1);
    next();
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenLastCalledWith('om_card', 'new');
  });

  it('does not add an unnecessary generation if the newer operation also finishes during deletion', async () => {
    const api = transport();
    const deleting = deferred();
    api.finishProgress.mockReturnValueOnce(deleting.promise);
    const tracker = new ProgressTracker(api);
    tracker.begin('om_card')();
    await settle();
    tracker.begin('om_card')();
    deleting.resolve();
    await tracker.drain();
    expect(api.startProgress).toHaveBeenCalledTimes(1);
    expect(api.finishProgress).toHaveBeenCalledTimes(1);
  });

  it('makes the returned finish callback idempotent', async () => {
    const api = transport();
    const tracker = new ProgressTracker(api);
    const first = tracker.begin('om_card'), second = tracker.begin('om_card');
    first(); first(); first();
    await settle();
    expect(api.finishProgress).not.toHaveBeenCalled();
    second(); second();
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when disabled', async () => {
    const onError = vi.fn();
    const tracker = new ProgressTracker(undefined, onError);
    const finish = tracker.begin('om_request');
    finish(); finish();
    await tracker.drain();
    tracker.begin('om_later')();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports one failed start without retrying while current operations remain active', async () => {
    const api = transport(), onError = vi.fn();
    api.startProgress.mockRejectedValueOnce(new Error('unavailable'));
    const tracker = new ProgressTracker(api, onError);
    const first = tracker.begin('om_card');
    await settle();
    const second = tracker.begin('om_card');
    await settle();
    expect(api.startProgress).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    first(); second();
    await settle();
    expect(api.finishProgress).not.toHaveBeenCalled();
    const newRequest = tracker.begin('om_card');
    await settle();
    expect(api.startProgress).toHaveBeenCalledTimes(2);
    newRequest();
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenCalledTimes(1);
  });

  it('reports a deletion failure without blindly retrying it', async () => {
    const api = transport(), onError = vi.fn();
    api.finishProgress.mockRejectedValueOnce(new Error('unknown delivery'));
    const tracker = new ProgressTracker(api, onError);
    tracker.begin('om_request')();
    await tracker.drain();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(api.finishProgress).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous transport errors and diagnostics errors', async () => {
    const api = transport();
    api.startProgress.mockImplementation(() => { throw new Error('spawn failed'); });
    const onError = vi.fn(() => { throw new Error('diagnostic failed'); });
    const tracker = new ProgressTracker(api, onError);
    expect(() => tracker.begin('om_request')()).not.toThrow();
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('drains outstanding operations, waits for late add and removal, then refuses new begins', async () => {
    const api = transport();
    const added = deferred<string>(), removed = deferred();
    api.startProgress.mockReturnValueOnce(added.promise);
    api.finishProgress.mockReturnValueOnce(removed.promise);
    const tracker = new ProgressTracker(api);
    const finish = tracker.begin('om_request');
    const drained = vi.fn();
    const draining = tracker.drain();
    expect(tracker.drain()).toBe(draining);
    void draining.then(drained);
    tracker.begin('om_ignored')();
    await settle();
    expect(api.startProgress).toHaveBeenCalledTimes(1);
    expect(drained).not.toHaveBeenCalled();
    added.resolve('reaction-late');
    await settle();
    expect(api.finishProgress).toHaveBeenCalledWith('om_request', 'reaction-late');
    expect(drained).not.toHaveBeenCalled();
    finish(); finish();
    removed.resolve();
    await draining;
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it('drain clears every message and settles even when one transport fails', async () => {
    const api = transport(), onError = vi.fn();
    api.startProgress.mockRejectedValueOnce(new Error('missing permission')).mockResolvedValueOnce('second');
    const tracker = new ProgressTracker(api, onError);
    tracker.begin('om_first'); tracker.begin('om_second');
    await tracker.drain();
    expect(api.finishProgress).toHaveBeenCalledExactlyOnceWith('om_second', 'second');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
