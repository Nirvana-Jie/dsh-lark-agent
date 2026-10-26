import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ConnectionController, SetupError, type OnboardingDependencies} from './controller.js';
import {ConnectionStore} from './store.js';
import {SettingsStore} from './settings-store.js';
import type {AgentCatalog, ConnectionEndpoint, ConnectionList, ConnectionSnapshot} from './protocol.js';

export const MAX_CONNECTIONS = 10;
export const validConnectionId = (id: unknown): id is string => typeof id === 'string' && (id === 'default' || /^[a-f0-9]{32}$/.test(id));
function ids(raw: unknown): {version: 1; ids: string[]} {
  const value = raw as {version?: unknown; ids?: unknown} | null;
  if (value?.version !== 1 || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > MAX_CONNECTIONS
    || value.ids[0] !== 'default' || !value.ids.every(validConnectionId) || new Set(value.ids).size !== value.ids.length) throw new Error('Invalid connection registry');
  return {version: 1, ids: [...value.ids]};
}

/** Owns independent controllers; the legacy controller and its native logs never move. */
export class ConnectionManager {
  private readonly controllers = new Map<string, ConnectionController>();
  private readonly registry: SettingsStore<{version: 1; ids: string[]}>;
  private readonly claims = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly directory: string, private readonly dependencies: (store: ConnectionStore) => Omit<OnboardingDependencies, 'store'>,
    private readonly readCatalog: () => Promise<AgentCatalog>) {
    this.registry = new SettingsStore(directory, 'connections.json', ids);
  }
  private make(id: string): ConnectionController {
    const directory = id === 'default' ? this.directory : join(this.directory, 'connections', id);
    const store = new ConnectionStore(directory);
    return new ConnectionController({...this.dependencies(store), store, reserveApp: appId => {
      const owner = this.claims.get(appId);
      if (owner && owner !== id) throw new SetupError('这个机器人已在列表中，请直接打开对应的机器人。', false);
      this.claims.set(appId, id);
    }, commitApp: appId => {
      for (const [reserved, owner] of this.claims) if (owner === id && reserved !== appId) this.claims.delete(reserved);
    }});
  }
  async initialize(): Promise<void> {
    const registry = await this.registry.read() ?? {version: 1 as const, ids: ['default']};
    // Reserve all saved identities before any enabled controller starts receiving.
    for (const id of registry.ids) {
      const store = new ConnectionStore(id === 'default' ? this.directory : join(this.directory, 'connections', id));
      const record = await store.read();
      if (record) {
        if (this.claims.has(record.appId)) throw new SetupError('机器人列表有重复身份，请检查本地连接状态。', false);
        this.claims.set(record.appId, id);
      }
      this.controllers.set(id, this.make(id));
    }
    for (const controller of this.controllers.values()) await controller.initialize();
  }
  private get(id = 'default'): ConnectionController {
    if (this.closed || !validConnectionId(id)) throw new SetupError('机器人入口不可用，请刷新列表。');
    const controller = this.controllers.get(id);
    if (!controller) throw new SetupError('没有找到这个机器人，请刷新列表。');
    return controller;
  }
  snapshot(id?: string): ConnectionSnapshot {return this.get(id).snapshot();}
  list(): ConnectionList {
    return {limit: MAX_CONNECTIONS, connections: [...this.controllers].map(([id, controller], index) => {
      const snapshot = controller.snapshot();
      return {id, label: snapshot.agent?.label || snapshot.bot?.name || `飞书助手 ${index + 1}`,
        phase: snapshot.phase, busy: snapshot.busy, agentPreset: snapshot.agent?.agentPreset ?? ''};
    })};
  }
  catalog(): Promise<AgentCatalog> {return this.readCatalog();}
  profiles(signal?: AbortSignal, id?: string) {return this.get(id).profiles(signal);}
  command(endpoint: Exclude<ConnectionEndpoint, 'profiles' | 'status'>, payload: unknown, id?: string) {
    // Serialize roster changes with command admission, before a controller can acquire a service.
    const result = this.tail.then(() => this.get(id).command(endpoint, payload));
    this.tail = result.catch(() => undefined);
    return result;
  }
  add(): Promise<ConnectionList & {selectedId: string}> {
    const result = this.tail.then(async () => {
      if (this.closed) throw new SetupError('连接设置已关闭。');
      if (this.controllers.size >= MAX_CONNECTIONS) throw new SetupError(`最多管理 ${MAX_CONNECTIONS} 个机器人。`);
      const id = randomUUID().replaceAll('-', '');
      const controller = this.make(id);
      await controller.initialize();
      // Publish the new controller only after its roster entry is durable.
      await this.registry.write({version: 1, ids: [...this.controllers.keys(), id]});
      this.controllers.set(id, controller);
      return {...this.list(), selectedId: id};
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  remove(id: string): Promise<ConnectionList & {selectedId: string}> {
    const result = this.tail.then(async () => {
      const controller = this.get(id), snapshot = controller.snapshot();
      if (id === 'default') throw new SetupError('首个机器人入口会保留，可以断开后复用。');
      if (!snapshot.agent?.editable || snapshot.documentSetup || snapshot.inputSetup) throw new SetupError('请先暂停或取消这个机器人的连接和授权，再从列表移除。');
      if (!await controller.dispose()) throw new SetupError('连接尚未安全停止，机器人入口已保留。');
      await this.registry.write({version: 1, ids: [...this.controllers.keys()].filter(key => key !== id)});
      this.controllers.delete(id);
      for (const [appId, owner] of this.claims) if (owner === id) this.claims.delete(appId);
      // Its durable folder and CLI credentials are retained for manual recovery.
      return {...this.list(), selectedId: 'default'};
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  async dispose(): Promise<boolean> {
    this.closed = true;
    await this.tail;
    const results = await Promise.allSettled([...this.controllers.values()].map(controller => controller.dispose()));
    return results.every(result => result.status === 'fulfilled' && result.value);
  }
}
