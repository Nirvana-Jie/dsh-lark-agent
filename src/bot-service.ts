import type { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from './config.js';
import { LarkCli, noActiveConsumers } from './lark-cli.js';
import { DshRuntime } from './dsh-runtime.js';
import { DiskLedger } from './ledger.js';
import { BotBridge } from './bridge.js';
import { acquireLock } from './lock.js';
import { MemoryStore } from './memory-store.js';
import { SessionStore } from './session-store.js';
import { CardActions } from './card-actions.js';
import { DirectChatsStore } from './direct-chats.js';
import { ModelPreferencesStore } from './model-preferences.js';
import {ArtifactStore} from './artifacts.js';
import {LarkArtifactPublisher} from './artifact-publisher.js';
import {PermissionPreferencesStore} from './permission-preferences.js';

export interface BotService {
  start(): void;
  stop(): Promise<boolean>;
  ready(): boolean;
}
/** A failed close is still an owned service, never a disposable startup error. */
export class BotServiceStartError extends Error {
  constructor(public readonly service: BotService) {super('Bot startup could not be safely stopped');}
}

/** The bot identity lease prevents two homes/profiles from consuming one app. */
export function botLeaseDirectory(botOpenId: string): string {
  return join(homedir(), '.dsh-larkbot', 'leases', createHash('sha256').update(botOpenId).digest('hex'));
}

export async function createBotService(ctx: Context, config: BotConfig,
  onHealth: (ready: boolean) => void = () => undefined,
  startup?: {directChat?: {openId: string; chatId: string}}): Promise<BotService> {
  const releaseState = await acquireLock(config.stateDir);
  let releaseBot: (() => Promise<void>) | undefined;
  try {
    // An exited owner's CLI children may still be consuming this app; recover only when none are.
    releaseBot = await acquireLock(botLeaseDirectory(config.botOpenId),
      {takeover: () => noActiveConsumers({profile: config.profile, executable: config.executable})});
    const ledger = await DiskLedger.open(config.stateDir);
    const openingStores = [
      SessionStore.open(config.stateDir), MemoryStore.open(config.stateDir),
      config.cardInteractions ? CardActions.open(config.stateDir, JSON.stringify([config.profile, config.botOpenId])) : undefined,
      DirectChatsStore.open(config.stateDir), ModelPreferencesStore.open(config.stateDir), ArtifactStore.open(config.stateDir),
      PermissionPreferencesStore.open(config.stateDir),
    ] as const;
    // An opener may create signing state: finish all openers before releasing
    // ownership after a sibling fails, so no old writer outlives the lock.
    const openedStores = await Promise.allSettled(openingStores);
    const failed = openedStores.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const [sessions, memories, actions, directChats, modelPreferences, artifacts, permissionPreferences] = await Promise.all(openingStores);
    if (startup?.directChat) {
      const {openId, chatId} = startup.directChat;
      if (!config.users.some(user => user.openId === openId && user.direct)) throw new Error('Paired chat owner is not authorized for direct messages');
      // Seed only from the onboarding host's verified private pairing, under both
      // leases and before constructing any receiver that can read this store.
      await directChats.record(openId, chatId);
    }
    const transport = new LarkCli({profile: config.profile, executable: config.executable});
    const callbacks = config.cardInteractions
      ? new LarkCli({profile: config.profile, executable: config.executable, eventKey: 'card.action.trigger'}) : undefined;
    const menu = config.botMenu
      ? new LarkCli({profile: config.profile, executable: config.executable, eventKey: 'application.bot.menu_v6'}) : undefined;
    const progressTransport = config.loadingReaction
      ? new LarkCli({profile: config.profile, executable: config.executable, commandTimeoutMs: 5_000}) : undefined;
    const bridge = new BotBridge(config, new DshRuntime(ctx), transport, ledger, {sessions, memories, actions, directChats, modelPreferences, artifacts, permissionPreferences},
      event => console.info(`[im-larkbot] ${JSON.stringify(event)}`), progressTransport,
      new LarkArtifactPublisher(config.profile, config.botOpenId, {executable: config.executable}));
    let stopped = false, started = false, healthy = false;
    type ConsumerKind = 'messages' | 'cards' | 'menu';
    const readiness: Record<ConsumerKind, boolean> = {messages: false, cards: !callbacks, menu: !menu};
    let stopping: Promise<boolean> | undefined;
    let sweep: ReturnType<typeof setInterval> | undefined;
    const publishHealth = () => {
      healthy = !stopped && Object.values(readiness).every(Boolean);
      try {onHealth(healthy);} catch { /* Observer owns UI. */ }
    };
    const health = (kind: ConsumerKind, value: boolean) => {
      readiness[kind] = value;
      publishHealth();
    };
    const consumer = (client: LarkCli, kind: ConsumerKind) => {
      const isCard = kind === 'cards';
      let attempt = 0, connecting = false;
      let revision = 0;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        revision++;
        if (isCard) bridge.setCardActionsReady(false);
        health(kind, false);
        if (stopped || retry) return;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
        console.warn(`[im-larkbot] ${isCard ? 'card callback' : kind === 'menu' ? 'menu event' : 'event'} transport unavailable; reconnect in ${delay} ms. Check the dedicated bot profile and subscriptions.`);
        retry = setTimeout(() => {retry = undefined; void connect();}, delay);
      };
      const connect = async () => {
        if (stopped || connecting) return;
        connecting = true;
        const expectedRevision = revision;
        try {
          await client.stop({cancelReplies: false});
          if (stopped) return;
          await client.start(raw => {
            void bridge.accept(raw).catch(() => console.error('[im-larkbot] ingress failed; inspect local state and CLI health.'));
          }, schedule);
          if (stopped || revision !== expectedRevision) return;
          attempt = 0;
          if (isCard) bridge.setCardActionsReady(true);
          health(kind, true);
          console.info(`[im-larkbot] ${isCard ? 'cards ready' : kind === 'menu' ? 'menu ready' : 'ready'}`);
        } catch {schedule();} finally {connecting = false;}
      };
      return {connect, cancel: () => clearTimeout(retry)};
    };
    const loops = [consumer(transport, 'messages'), ...(callbacks ? [consumer(callbacks, 'cards')] : []), ...(menu ? [consumer(menu, 'menu')] : [])];
    return {
      ready: () => healthy,
      start() {
        if (started || stopped) return;
        started = true;
        sweep = setInterval(() => {void bridge.sweep().catch(() => console.error('[im-larkbot] idle cleanup failed.'));}, 30_000);
        for (const loop of loops) void loop.connect();
      },
      stop() {
        return stopping ??= (async () => {
          stopped = true;
          publishHealth();
          for (const loop of loops) loop.cancel();
          clearInterval(sweep);
          if (callbacks) bridge.setCardActionsReady(false);
          const receivers = [transport, ...(callbacks ? [callbacks] : []), ...(menu ? [menu] : [])];
          // Stop ingress immediately, but keep the send side alive while the
          // bridge drains its confirmed loading-card updates and reactions.
          const results = await Promise.allSettled([bridge.stop(), ...receivers.map(client => client.stop({cancelReplies: false}))]);
          // Always attempt final subprocess cleanup, even if ingress shutdown
          // failed. Keep every stage's error so uncertainty retains both locks.
          results.push(...await Promise.allSettled([...receivers.map(client => client.stop()),
            ...(progressTransport ? [progressTransport.stop()] : [])]));
          if (results.some(result => result.status === 'rejected')) {
            console.error('[im-larkbot] shutdown incomplete; state lock retained.');
            return false;
          }
          await releaseState();
          await releaseBot!();
          return true;
        })();
      },
    };
  } catch (error) {
    await releaseState();
    if (releaseBot) await releaseBot();
    throw error;
  }
}
