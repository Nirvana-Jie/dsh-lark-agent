import type {Context} from '@deepseek-ai/cordis';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseConfig} from '../src/config.js';

type Client = {
  options: {eventKey?: string; commandTimeoutMs?: number};
  start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
};
const mocks = vi.hoisted(() => ({clients: [] as Client[], release: vi.fn(), accept: vi.fn(),
  bridgeStop: vi.fn(), sweep: vi.fn(), cardReady: vi.fn(), directOpen: vi.fn(), directRecord: vi.fn(), acquire: vi.fn(), preferencesOpen: vi.fn(),
  consumers: vi.fn()}));
vi.mock('../src/lock.js', () => ({acquireLock: mocks.acquire}));
vi.mock('../src/ledger.js', () => ({DiskLedger: {open: async () => ({})}}));
vi.mock('../src/session-store.js', () => ({SessionStore: {open: async () => ({})}}));
vi.mock('../src/memory-store.js', () => ({MemoryStore: {open: async () => ({})}}));
vi.mock('../src/card-actions.js', () => ({CardActions: {open: async () => ({})}}));
vi.mock('../src/direct-chats.js', () => ({DirectChatsStore: {open: mocks.directOpen}}));
vi.mock('../src/model-preferences.js', () => ({ModelPreferencesStore: {open: mocks.preferencesOpen}}));
vi.mock('../src/artifacts.js', () => ({ArtifactStore: {open: async () => ({})}}));
vi.mock('../src/dsh-runtime.js', () => ({DshRuntime: class {}}));
vi.mock('../src/bridge.js', () => ({BotBridge: class {
  accept = mocks.accept; stop = mocks.bridgeStop; sweep = mocks.sweep; setCardActionsReady = mocks.cardReady;
}}));
vi.mock('../src/lark-cli.js', () => ({LarkCli: class {
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  constructor(public options: Client['options']) {mocks.clients.push(this);}
}, noActiveConsumers: mocks.consumers}));
import {createBotService, type BotService} from '../src/bot-service.js';

const services: BotService[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => {resolve = yes;});
  return {promise, resolve};
}
async function fixture(cards = true, loading = false, botMenu = false, startup?: Parameters<typeof createBotService>[3]) {
  const config = parseConfig({profile: 'fixture', botOpenId: 'ou_bot', stateDir: '/test/state',
    users: [{openId: 'ou_owner', direct: true, cwd: '/test/workspace'}], cardInteractions: cards, loadingReaction: loading, botMenu});
  const health = vi.fn();
  const service = await createBotService({} as Context, config, health, startup); services.push(service);
  const messages = mocks.clients.find(c => !c.options.eventKey && !c.options.commandTimeoutMs)!;
  const callbacks = mocks.clients.find(c => c.options.eventKey === 'card.action.trigger');
  const menu = mocks.clients.find(c => c.options.eventKey === 'application.bot.menu_v6');
  return {service, health, messages, callbacks, menu};
}
const settle = () => vi.advanceTimersByTimeAsync(0);
function disconnect(client: Client) {(client.start.mock.calls.at(-1)![1] as () => void)();}
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); mocks.clients.length = 0;
  mocks.release.mockResolvedValue(undefined); mocks.accept.mockResolvedValue(undefined);
  mocks.bridgeStop.mockResolvedValue(undefined); mocks.sweep.mockResolvedValue(undefined);
  mocks.acquire.mockResolvedValue(mocks.release); mocks.directRecord.mockResolvedValue(undefined);
  mocks.directOpen.mockResolvedValue({record: mocks.directRecord}); mocks.preferencesOpen.mockResolvedValue({});
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('aggregate bot connection readiness', () => {
  it('waits for callbacks even after ordinary messages are ready', async () => {
    const h = await fixture(); const callbackReady = deferred();
    h.callbacks!.start.mockReturnValueOnce(callbackReady.promise);
    h.service.start(); await settle();
    expect(h.messages.start).toHaveBeenCalledOnce();
    expect(h.service.ready()).toBe(false); expect(h.health).not.toHaveBeenCalledWith(true);
    callbackReady.resolve(); await settle();
    expect(h.service.ready()).toBe(true); expect(h.health).toHaveBeenLastCalledWith(true);
    expect(mocks.cardReady).toHaveBeenLastCalledWith(true);
  });

  it('waits for ordinary messages when callbacks connect first', async () => {
    const h = await fixture(); const messageReady = deferred();
    h.messages.start.mockReturnValueOnce(messageReady.promise);
    h.service.start(); await settle();
    expect(mocks.cardReady).toHaveBeenLastCalledWith(true);
    expect(h.service.ready()).toBe(false); expect(h.health).not.toHaveBeenCalledWith(true);
    messageReady.resolve(); await settle();
    expect(h.service.ready()).toBe(true);
  });

  it.each(['messages', 'callbacks'] as const)('becomes unready when %s disconnects and recovers only after that channel reconnects', async channel => {
    const h = await fixture(); h.service.start(); await settle();
    expect(h.service.ready()).toBe(true);
    const affected = h[channel]!;
    const other = channel === 'messages' ? h.callbacks! : h.messages;
    disconnect(affected);
    expect(h.service.ready()).toBe(false); expect(h.health).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(affected.start).toHaveBeenCalledTimes(2); expect(other.start).toHaveBeenCalledOnce();
    expect(h.service.ready()).toBe(true); expect(h.health).toHaveBeenLastCalledWith(true);
  });

  it('keeps ordinary message processing active while callback startup fails, but never reports fully ready', async () => {
    const h = await fixture();
    h.callbacks!.start.mockRejectedValueOnce(new Error('callback grant unavailable'));
    h.service.start(); await settle();
    expect(h.service.ready()).toBe(false);
    const ingress = h.messages.start.mock.calls[0]![0] as (event: unknown) => void;
    ingress({message_id: 'om_message'});
    expect(mocks.accept).toHaveBeenCalledWith({message_id: 'om_message'});
    expect(mocks.cardReady).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.service.ready()).toBe(true);
  });

  it('requires only the message channel when card interactions are disabled', async () => {
    const h = await fixture(false, true);
    h.service.start(); await settle();
    expect(h.callbacks).toBeUndefined(); expect(h.service.ready()).toBe(true);
    const progress = mocks.clients.find(c => c.options.commandTimeoutMs === 5000)!;
    expect(progress.start).not.toHaveBeenCalled();
    expect(mocks.cardReady).not.toHaveBeenCalled();
  });

  it('does not promote a connection whose loss callback fired before its start promise settled', async () => {
    const h = await fixture();
    h.callbacks!.start.mockImplementationOnce(async (_ingress: unknown, onError: () => void) => {onError();});
    h.service.start(); await settle();
    expect(h.service.ready()).toBe(false); expect(mocks.cardReady).not.toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.service.ready()).toBe(true);
  });

  it('stays unready after shutdown even if a pending channel later resolves', async () => {
    const h = await fixture(); const callbackReady = deferred();
    h.callbacks!.start.mockReturnValueOnce(callbackReady.promise);
    h.service.start(); await settle();
    await h.service.stop(); callbackReady.resolve(); await settle();
    expect(h.service.ready()).toBe(false); expect(h.health).toHaveBeenLastCalledWith(false);
    expect(mocks.cardReady).toHaveBeenLastCalledWith(false);
  });

  it('waits for the enabled menu channel while allowing ordinary messages and cards to run', async () => {
    const h = await fixture(true, false, true); const menuReady = deferred();
    h.menu!.start.mockReturnValueOnce(menuReady.promise);
    h.service.start(); await settle();
    expect(h.service.ready()).toBe(false); expect(mocks.cardReady).toHaveBeenLastCalledWith(true);
    expect(h.messages.start).toHaveBeenCalledOnce(); expect(h.callbacks!.start).toHaveBeenCalledOnce();
    menuReady.resolve(); await settle(); expect(h.service.ready()).toBe(true);
    const event = {type: 'application.bot.menu_v6', event_id: 'menu-event', event_key: 'dsh.sessions'};
    (h.menu!.start.mock.calls[0]![0] as (raw: unknown) => void)(event);
    expect(mocks.accept).toHaveBeenCalledWith(event);
  });

  it('reconnects a lost menu without resetting the healthy message/card receivers', async () => {
    const h = await fixture(true, false, true); h.service.start(); await settle();
    expect(h.service.ready()).toBe(true); disconnect(h.menu!);
    expect(h.service.ready()).toBe(false); expect(mocks.cardReady).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.menu!.start).toHaveBeenCalledTimes(2); expect(h.messages.start).toHaveBeenCalledOnce();
    expect(h.callbacks!.start).toHaveBeenCalledOnce(); expect(h.service.ready()).toBe(true);
  });

  it('includes menus in readiness even with card interactions disabled', async () => {
    const h = await fixture(false, false, true); h.menu!.start.mockRejectedValueOnce(new Error('menu subscription missing'));
    h.service.start(); await settle(); expect(h.service.ready()).toBe(false);
    expect(mocks.cardReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(h.service.ready()).toBe(true);
  });

  it('retains both locks if the menu receiver cannot stop', async () => {
    const h = await fixture(true, false, true); h.service.start(); await settle();
    h.menu!.stop.mockRejectedValueOnce(new Error('consumer still alive'));
    await expect(h.service.stop()).resolves.toBe(false);
    expect(h.service.ready()).toBe(false); expect(mocks.release).not.toHaveBeenCalled();
  });

  it('keeps delivery available until the bridge finishes its visible loading card, then closes all transports', async () => {
    const h = await fixture(true, true, true); h.service.start(); await settle();
    const receivers = [h.messages, h.callbacks!, h.menu!];
    const progress = mocks.clients.find(c => c.options.commandTimeoutMs === 5000)!;
    for (const client of mocks.clients) client.stop.mockClear();
    const commandDone = deferred(), finalUpdate = deferred();
    let deliveryAvailable = true;
    const updated = vi.fn();
    h.messages.stop.mockImplementation(async (options?: {cancelReplies?: boolean}) => {
      if (options?.cancelReplies !== false) deliveryAvailable = false;
    });
    mocks.bridgeStop.mockImplementation(async () => {
      await commandDone.promise;
      // LarkCli rejects updateFeedback once full stop marks delivery stopped.
      // This update represents CommandFeedback finishing an existing card.
      if (!deliveryAvailable) throw new Error('Lark transport is stopped.');
      updated('om_loading', '连接正在关闭');
      await finalUpdate.promise;
    });
    const stopping = h.service.stop();
    await settle();
    expect(h.service.ready()).toBe(false);
    for (const client of receivers) expect(client.stop.mock.calls).toEqual([[{cancelReplies: false}]]);
    expect(progress.stop).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled();
    commandDone.resolve(); await settle();
    expect(updated).toHaveBeenCalledExactlyOnceWith('om_loading', '连接正在关闭');
    expect(deliveryAvailable).toBe(true); expect(mocks.release).not.toHaveBeenCalled();
    finalUpdate.resolve(); await expect(stopping).resolves.toBe(true);
    for (const client of receivers) expect(client.stop.mock.calls).toEqual([[{cancelReplies: false}], []]);
    expect(progress.stop).toHaveBeenCalledOnce(); expect(deliveryAvailable).toBe(false);
    expect(mocks.release).toHaveBeenCalledTimes(2);
    for (const client of mocks.clients) {
      expect(client.stop.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.release.mock.invocationCallOrder[0]!);
    }
  });

  it.each(['bridge', 'messages', 'callbacks', 'menu'] as const)(
    'attempts all final cleanup and retains both locks when the first shutdown stage fails at %s', async failed => {
      const h = await fixture(true, true, true); h.service.start(); await settle();
      for (const client of mocks.clients) client.stop.mockClear();
      if (failed === 'bridge') mocks.bridgeStop.mockRejectedValueOnce(new Error('native shutdown unconfirmed'));
      else h[failed]!.stop.mockRejectedValueOnce(new Error('ingress shutdown unconfirmed'));
      await expect(h.service.stop()).resolves.toBe(false);
      for (const client of [h.messages, h.callbacks!, h.menu!]) {
        expect(client.stop.mock.calls).toEqual([[{cancelReplies: false}], []]);
        expect(client.start).toHaveBeenCalledOnce();
      }
      expect(mocks.clients.find(c => c.options.commandTimeoutMs === 5000)!.stop).toHaveBeenCalledOnce();
      expect(mocks.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      for (const client of [h.messages, h.callbacks!, h.menu!]) expect(client.start).toHaveBeenCalledOnce();
    });

  it.each(['messages', 'callbacks', 'menu', 'progress'] as const)(
    'retains ownership if final %s cleanup fails after a successful bridge drain', async failed => {
      const h = await fixture(true, true, true); h.service.start(); await settle();
      for (const client of mocks.clients) client.stop.mockClear();
      const target = failed === 'progress' ? mocks.clients.find(c => c.options.commandTimeoutMs === 5000)! : h[failed]!;
      target.stop.mockImplementation(async (options?: {cancelReplies?: boolean}) => {
        if (options?.cancelReplies !== false) throw new Error('child still alive');
      });
      await expect(h.service.stop()).resolves.toBe(false);
      expect(mocks.bridgeStop).toHaveBeenCalledOnce();
      for (const client of [h.messages, h.callbacks!, h.menu!]) expect(client.stop.mock.calls).toEqual([[{cancelReplies: false}], []]);
      expect(mocks.release).not.toHaveBeenCalled();
    });

  it('waits for every store opener before releasing locks after a sibling opener fails', async () => {
    const pending = deferred(); mocks.preferencesOpen.mockReturnValueOnce(pending.promise);
    mocks.directOpen.mockRejectedValueOnce(new Error('corrupt private chat map'));
    const opening = fixture(); const failed = expect(opening).rejects.toThrow('corrupt private chat map');
    await settle(); expect(mocks.release).not.toHaveBeenCalled();
    pending.resolve(); await failed;
    expect(mocks.release).toHaveBeenCalledTimes(2); expect(mocks.clients).toHaveLength(0);
  });

  it('takes over an exited owner\'s bot lease only after its profile reports no active consumers', async () => {
    mocks.consumers.mockResolvedValue(false);
    await fixture();
    const [state, lease] = mocks.acquire.mock.calls;
    expect(state).toEqual(['/test/state']);
    expect(lease![0]).toMatch(/[\\/]\.dsh-larkbot[\\/]leases[\\/][0-9a-f]{64}$/);
    await expect((lease![1] as {takeover: () => Promise<boolean>}).takeover()).resolves.toBe(false);
    expect(mocks.consumers).toHaveBeenCalledExactlyOnceWith({profile: 'fixture', executable: 'lark-cli'});
  });

  it('seeds a verified paired private chat only after both leases, before creating receivers', async () => {
    const ownership = deferred();
    mocks.acquire.mockResolvedValueOnce(mocks.release).mockReturnValueOnce(ownership.promise.then(() => mocks.release));
    mocks.directRecord.mockImplementation(async () => {expect(mocks.clients).toHaveLength(0);});
    const pending = fixture(true, false, true, {directChat: {openId: 'ou_owner', chatId: 'oc_pair'}});
    await settle(); expect(mocks.directOpen).not.toHaveBeenCalled(); expect(mocks.directRecord).not.toHaveBeenCalled();
    ownership.resolve(); await pending;
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(mocks.directRecord).toHaveBeenCalledExactlyOnceWith('ou_owner', 'oc_pair');
    expect(mocks.directOpen.mock.invocationCallOrder[0]).toBeLessThan(mocks.directRecord.mock.invocationCallOrder[0]!);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'group-only'] as const)('rejects a %s seed owner without writing a private chat mapping', async kind => {
    const config = parseConfig({profile: 'fixture', botOpenId: 'ou_bot', stateDir: '/test/state',
      users: [{openId: 'ou_owner', direct: kind !== 'group-only', groupChats: ['oc_group'], cwd: '/test/workspace'}]});
    await expect(createBotService({} as Context, config, undefined,
      {directChat: {openId: kind === 'unknown' ? 'ou_other' : 'ou_owner', chatId: 'oc_pair'}}))
      .rejects.toThrow('Paired chat owner is not authorized');
    expect(mocks.directRecord).not.toHaveBeenCalled(); expect(mocks.clients).toHaveLength(0);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('does not seed any chat for legacy startup without pairing evidence', async () => {
    await fixture(); expect(mocks.directRecord).not.toHaveBeenCalled();
  });

  it('does not create receivers or lose ownership before a failed seed settles', async () => {
    const pendingSeed = deferred();
    mocks.directRecord.mockImplementation(async () => {await pendingSeed.promise; throw new Error('private map write failed');});
    const opening = fixture(true, false, true, {directChat: {openId: 'ou_owner', chatId: 'oc_pair'}});
    const failed = expect(opening).rejects.toThrow('private map write failed');
    await settle(); expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.clients).toHaveLength(0);
    pendingSeed.resolve(); await failed;
    expect(mocks.release).toHaveBeenCalledTimes(2); expect(mocks.clients).toHaveLength(0);
  });
});
