import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';

type MockClient = {
  options: {profile: string; executable: string; eventKey?: string; commandTimeoutMs?: number};
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};
const state = vi.hoisted(() => ({
  config: {profile: 'test-bot', botOpenId: 'ou_bot', executable: 'lark-cli', stateDir: '/state', cardInteractions: false, loadingReaction: false},
  loadConfig: vi.fn(), acquireLock: vi.fn(), release: vi.fn(),
  ledgerOpen: vi.fn(), sessionsOpen: vi.fn(), memoriesOpen: vi.fn(), actionsOpen: vi.fn(),
  configureClient: vi.fn(), clients: [] as MockClient[],
  bridgeConstruct: vi.fn(), bridgeStop: vi.fn(), accept: vi.fn(), sweep: vi.fn(), cardReady: vi.fn(),
}));

vi.mock('../src/config.js', () => ({loadConfig: state.loadConfig}));
vi.mock('../src/lock.js', () => ({acquireLock: state.acquireLock}));
vi.mock('../src/ledger.js', () => ({DiskLedger: {open: state.ledgerOpen}}));
vi.mock('../src/session-store.js', () => ({SessionStore: {open: state.sessionsOpen}}));
vi.mock('../src/topic-store.js', () => ({TopicStore: {open: async () => ({})}}));
vi.mock('../src/memory-store.js', () => ({MemoryStore: {open: state.memoriesOpen}}));
vi.mock('../src/card-actions.js', () => ({CardActions: {open: state.actionsOpen}}));
vi.mock('../src/direct-chats.js', () => ({DirectChatsStore: {open: async () => ({})}}));
vi.mock('../src/model-preferences.js', () => ({ModelPreferencesStore: {open: async () => ({})}}));
vi.mock('../src/artifacts.js', () => ({ArtifactStore: {open: async () => ({})}}));
vi.mock('../src/permission-preferences.js', () => ({PermissionPreferencesStore: {open: async () => ({})}}));
vi.mock('../src/dsh-runtime.js', () => ({DshRuntime: class {}}));
vi.mock('../src/lark-cli.js', () => ({
  LarkCli: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    constructor(public options: MockClient['options']) {
      state.clients.push(this);
      state.configureClient(this);
    }
  },
}));
vi.mock('../src/bridge.js', () => ({
  BotBridge: class {
    stop = state.bridgeStop;
    accept = state.accept;
    sweep = state.sweep;
    setCardActionsReady = state.cardReady;
    constructor(...args: unknown[]) { state.bridgeConstruct(...args); }
  },
}));

import { apply } from '../src/index.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function context() {
  let dispose: (() => Promise<void>) | undefined;
  const effect = vi.fn((setup: () => () => Promise<void>) => { dispose = setup(); });
  return {ctx: {effect} as unknown as Context, effect, dispose: async () => { await dispose?.(); }};
}
function messages(): MockClient { return state.clients.find(client => !client.options.eventKey && !client.options.commandTimeoutMs)!; }
function callbacks(): MockClient { return state.clients.find(client => client.options.eventKey === 'card.action.trigger')!; }
function progress(): MockClient | undefined { return state.clients.find(client => client.options.commandTimeoutMs === 5000); }
function enableCards(): void { state.loadConfig.mockResolvedValue({...state.config, cardInteractions: true}); }
async function settle(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }
function disconnect(client: MockClient): void { (client.start.mock.calls.at(-1)![1] as () => void)(); }
function ingress(client: MockClient, value: unknown): void { (client.start.mock.calls.at(-1)![0] as (raw: unknown) => void)(value); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  state.clients.length = 0;
  state.loadConfig.mockResolvedValue({...state.config});
  state.acquireLock.mockImplementation(async (path: string) => path.includes('/.dsh-larkbot/leases/') ? async () => undefined : state.release);
  state.release.mockResolvedValue(undefined);
  state.ledgerOpen.mockResolvedValue({});
  state.sessionsOpen.mockResolvedValue({});
  state.memoriesOpen.mockResolvedValue({});
  state.actionsOpen.mockResolvedValue({issue: vi.fn(), verify: vi.fn()});
  state.bridgeStop.mockResolvedValue(undefined);
  state.accept.mockResolvedValue(undefined);
  state.sweep.mockResolvedValue(undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('plugin lifecycle', () => {
  it('releases ownership if the ledger cannot open, without creating transport', async () => {
    const c = context();
    state.ledgerOpen.mockRejectedValue(new Error('invalid ledger'));
    await expect(apply(c.ctx, {configFile: '/config.json'})).rejects.toThrow('invalid ledger');
    expect(state.release).toHaveBeenCalledTimes(1);
    expect(state.clients).toHaveLength(0);
  });

  it('releases a lock acquired after the Cordis owner was already disposed', async () => {
    const acquired = deferred<() => Promise<void>>();
    state.acquireLock.mockReturnValueOnce(acquired.promise);
    const effect = vi.fn(() => { throw new Error('INACTIVE_EFFECT'); });
    const applying = apply({effect} as unknown as Context, {configFile: '/config.json'});
    const rejection = expect(applying).rejects.toThrow('INACTIVE_EFFECT');
    await Promise.resolve();
    acquired.resolve(state.release);
    await rejection;
    expect(state.release).toHaveBeenCalledTimes(1);
    expect(messages().start).not.toHaveBeenCalled();
  });

  it('returns from apply without waiting for the event consumer to become ready', async () => {
    const ready = deferred();
    state.configureClient.mockImplementation((client: MockClient) => client.start.mockReturnValue(ready.promise));
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    expect(c.effect).toHaveBeenCalledTimes(1);
    expect(messages().start).toHaveBeenCalledTimes(1);
    ready.resolve();
    await c.dispose();
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('does not start either consumer when shutdown happens during initial stop', async () => {
    enableCards();
    const initialStop = deferred();
    state.configureClient.mockImplementation((client: MockClient) => client.stop.mockReturnValueOnce(initialStop.promise));
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    const shutdown = c.dispose();
    initialStop.resolve();
    await shutdown;
    await settle();
    expect(messages().start).not.toHaveBeenCalled();
    expect(callbacks().start).not.toHaveBeenCalled();
    expect(state.cardReady).not.toHaveBeenCalledWith(true);
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('cancels pending reconnects on shutdown and waits for bridge draining before unlock', async () => {
    enableCards();
    state.configureClient.mockImplementation((client: MockClient) => client.start.mockRejectedValue(new Error('missing CLI')));
    const draining = deferred();
    state.bridgeStop.mockReturnValue(draining.promise);
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    const shutdown = c.dispose();
    expect(state.release).not.toHaveBeenCalled();
    draining.resolve();
    await shutdown;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages().start).toHaveBeenCalledTimes(1);
    expect(callbacks().start).toHaveBeenCalledTimes(1);
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('reconnects only the failed message consumer without cancelling replies', async () => {
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    disconnect(messages());
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages().start).toHaveBeenCalledTimes(2);
    expect(messages().stop).toHaveBeenNthCalledWith(1, {cancelReplies: false});
    expect(messages().stop).toHaveBeenNthCalledWith(2, {cancelReplies: false});
    await c.dispose();
    expect(messages().stop).toHaveBeenLastCalledWith();
  });

  it.each(['bridge', 'messages', 'callbacks'])('retains ownership if %s shutdown cannot be confirmed', async failing => {
    enableCards();
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    if (failing === 'bridge') state.bridgeStop.mockRejectedValue(new Error('agent disposal failed'));
    else (failing === 'messages' ? messages() : callbacks()).stop.mockRejectedValueOnce(new Error('consumer did not exit'));
    await c.dispose();
    expect(state.release).not.toHaveBeenCalled();
    expect(state.cardReady).toHaveBeenLastCalledWith(false);
  });
});

describe('independent optional card callback consumer', () => {
  it('does not create signing state or a callback client when interactions are disabled', async () => {
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    expect(state.actionsOpen).not.toHaveBeenCalled();
    expect(state.clients).toHaveLength(1);
    expect(messages().start).toHaveBeenCalledTimes(1);
    expect(state.bridgeConstruct.mock.calls[0]![4]).toMatchObject({actions: undefined});
    expect(state.cardReady).not.toHaveBeenCalled();
    await c.dispose();
  });

  it('fails closed and unlocks if the enabled action signer cannot open', async () => {
    enableCards();
    state.actionsOpen.mockRejectedValue(new Error('invalid key'));
    await expect(apply(context().ctx, {configFile: '/config.json'})).rejects.toThrow('invalid key');
    expect(state.release).toHaveBeenCalledTimes(1);
    expect(state.clients).toHaveLength(0);
  });

  it('opens one signer scoped to this bot and enables actions only after callback readiness', async () => {
    enableCards();
    const ready = deferred();
    state.configureClient.mockImplementation((client: MockClient) => {
      if (client.options.eventKey) client.start.mockReturnValue(ready.promise);
    });
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    expect(state.actionsOpen).toHaveBeenCalledWith('/state', JSON.stringify(['test-bot', 'ou_bot']));
    expect(state.clients).toHaveLength(2);
    expect(messages().start).toHaveBeenCalledTimes(1);
    expect(callbacks().start).toHaveBeenCalledTimes(1);
    expect(state.cardReady).not.toHaveBeenCalledWith(true);
    ingress(messages(), {type: 'im.message.receive_v1', message_id: 'om_incoming'});
    expect(state.accept).toHaveBeenCalledWith({type: 'im.message.receive_v1', message_id: 'om_incoming'});
    ready.resolve();
    await settle();
    expect(state.cardReady).toHaveBeenLastCalledWith(true);
    ingress(callbacks(), {type: 'card.action.trigger', event_id: 'event123'});
    expect(state.accept).toHaveBeenCalledWith({type: 'card.action.trigger', event_id: 'event123'});
    await c.dispose();
  });

  it('keeps ordinary messages working during callback startup failure and reconnects callbacks alone', async () => {
    enableCards();
    state.configureClient.mockImplementation((client: MockClient) => {
      if (client.options.eventKey) client.start.mockRejectedValueOnce(new Error('callback subscription missing'));
    });
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    expect(state.cardReady).toHaveBeenLastCalledWith(false);
    expect(state.cardReady).not.toHaveBeenCalledWith(true);
    ingress(messages(), {type: 'im.message.receive_v1', message_id: 'om_stillworks'});
    expect(state.accept).toHaveBeenCalledWith({type: 'im.message.receive_v1', message_id: 'om_stillworks'});
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks().start).toHaveBeenCalledTimes(2);
    expect(callbacks().stop).toHaveBeenNthCalledWith(2, {cancelReplies: false});
    expect(messages().start).toHaveBeenCalledTimes(1);
    expect(messages().stop).toHaveBeenCalledTimes(1);
    expect(state.cardReady).toHaveBeenLastCalledWith(true);
    await c.dispose();
  });

  it('disables card actions immediately on disconnect without restarting the message consumer', async () => {
    enableCards();
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    expect(state.cardReady).toHaveBeenLastCalledWith(true);
    disconnect(callbacks());
    expect(state.cardReady).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.cardReady).toHaveBeenLastCalledWith(true);
    expect(callbacks().start).toHaveBeenCalledTimes(2);
    expect(messages().start).toHaveBeenCalledTimes(1);
    expect(messages().stop).toHaveBeenCalledTimes(1);
    await c.dispose();
  });

  it('reconnects message events without disabling or restarting healthy card callbacks', async () => {
    enableCards();
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    disconnect(messages());
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages().start).toHaveBeenCalledTimes(2);
    expect(callbacks().start).toHaveBeenCalledTimes(1);
    expect(callbacks().stop).toHaveBeenCalledTimes(1);
    expect(state.cardReady.mock.calls).toEqual([[true]]);
    await c.dispose();
  });

  it('waits for both consumers and bridge to stop before releasing the process lock', async () => {
    enableCards();
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    const messagesClosed = deferred(), callbacksClosed = deferred(), bridgeClosed = deferred();
    messages().stop.mockReturnValueOnce(messagesClosed.promise);
    callbacks().stop.mockReturnValueOnce(callbacksClosed.promise);
    state.bridgeStop.mockReturnValueOnce(bridgeClosed.promise);
    const shutdown = c.dispose();
    expect(state.cardReady).toHaveBeenLastCalledWith(false);
    expect(state.release).not.toHaveBeenCalled();
    messagesClosed.resolve();
    await settle();
    expect(state.release).not.toHaveBeenCalled();
    callbacksClosed.resolve();
    await settle();
    expect(state.release).not.toHaveBeenCalled();
    bridgeClosed.resolve();
    await shutdown;
    expect(state.release).toHaveBeenCalledTimes(1);
    expect(messages().stop).toHaveBeenLastCalledWith();
    expect(callbacks().stop).toHaveBeenLastCalledWith();
  });

  it('does not re-enable actions when a pending readiness result arrives during shutdown', async () => {
    enableCards();
    const ready = deferred();
    state.configureClient.mockImplementation((client: MockClient) => {
      if (client.options.eventKey) client.start.mockReturnValue(ready.promise);
    });
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    const shutdown = c.dispose();
    ready.resolve();
    await shutdown;
    await settle();
    expect(state.cardReady).toHaveBeenLastCalledWith(false);
    expect(state.cardReady).not.toHaveBeenCalledWith(true);
    expect(state.release).toHaveBeenCalledTimes(1);
  });
});

describe('independent optional progress transport', () => {
  it('does not construct or inject a progress client when loading reactions are disabled', async () => {
    enableCards();
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    expect(state.clients).toHaveLength(2);
    expect(progress()).toBeUndefined();
    expect(state.bridgeConstruct.mock.calls[0]![6]).toBeUndefined();
    await c.dispose();
  });

  it('injects a bounded progress-only client without starting an additional event consumer', async () => {
    state.loadConfig.mockResolvedValue({...state.config, cardInteractions: true, loadingReaction: true});
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    expect(state.clients).toHaveLength(3);
    expect(progress()?.options).toEqual({profile: 'test-bot', executable: 'lark-cli', commandTimeoutMs: 5000});
    expect(state.bridgeConstruct.mock.calls[0]![6]).toBe(progress());
    expect(progress()?.start).not.toHaveBeenCalled();
    expect(progress()?.stop).not.toHaveBeenCalled();
    expect(messages().start).toHaveBeenCalledTimes(1);
    expect(callbacks().start).toHaveBeenCalledTimes(1);
    disconnect(callbacks());
    await vi.advanceTimersByTimeAsync(1000);
    expect(progress()?.start).not.toHaveBeenCalled();
    expect(progress()?.stop).not.toHaveBeenCalled();
    await c.dispose();
    expect(progress()?.stop).toHaveBeenCalledTimes(1);
  });

  it('supports loading reactions without enabling card callbacks', async () => {
    state.loadConfig.mockResolvedValue({...state.config, loadingReaction: true});
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    expect(state.clients).toHaveLength(2);
    expect(state.actionsOpen).not.toHaveBeenCalled();
    expect(callbacks()).toBeUndefined();
    expect(progress()).toBeDefined();
    expect(progress()?.start).not.toHaveBeenCalled();
    await c.dispose();
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('keeps progress cleanup alive until bridge and both consumers finish, then waits for its stop before unlocking', async () => {
    state.loadConfig.mockResolvedValue({...state.config, cardInteractions: true, loadingReaction: true});
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    const bridgeClosed = deferred(), messagesClosed = deferred(), callbacksClosed = deferred(), progressClosed = deferred();
    state.bridgeStop.mockReturnValueOnce(bridgeClosed.promise);
    messages().stop.mockReturnValueOnce(messagesClosed.promise);
    callbacks().stop.mockReturnValueOnce(callbacksClosed.promise);
    progress()!.stop.mockReturnValueOnce(progressClosed.promise);
    const shutdown = c.dispose();
    expect(progress()?.stop).not.toHaveBeenCalled();
    bridgeClosed.resolve();
    await settle();
    expect(progress()?.stop).not.toHaveBeenCalled();
    messagesClosed.resolve();
    await settle();
    expect(progress()?.stop).not.toHaveBeenCalled();
    callbacksClosed.resolve();
    await settle();
    expect(progress()?.stop).toHaveBeenCalledTimes(1);
    expect(state.release).not.toHaveBeenCalled();
    progressClosed.resolve();
    await shutdown;
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('retains the state lock if progress subprocess shutdown cannot be confirmed', async () => {
    state.loadConfig.mockResolvedValue({...state.config, loadingReaction: true});
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    progress()!.stop.mockRejectedValueOnce(new Error('progress process still running'));
    await c.dispose();
    expect(state.release).not.toHaveBeenCalled();
  });

  it('still closes progress transport after another shutdown component fails', async () => {
    state.loadConfig.mockResolvedValue({...state.config, loadingReaction: true});
    const c = context();
    await apply(c.ctx, {configFile: '/config.json'});
    await settle();
    state.bridgeStop.mockRejectedValueOnce(new Error('agent drain failed'));
    await c.dispose();
    expect(progress()?.stop).toHaveBeenCalledTimes(1);
    expect(state.release).not.toHaveBeenCalled();
  });
});
