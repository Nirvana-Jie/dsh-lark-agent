import type {AgentCatalog, ConnectionEndpoint, ConnectionList, ConnectionPhase, ConnectionProfile, ConnectionSnapshot, ManagerEndpoint} from '../onboarding/protocol.js';

/** Browser transport supplied by either generation of the DSH host. */
export interface ConnectionRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

const phases: ReadonlySet<string> = new Set<ConnectionPhase>([
  'idle', 'creating', 'waiting_scan', 'configuring', 'action_required', 'pairing',
  'confirming_owner', 'starting', 'connected', 'paused', 'error',
]);

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid response');
  return value as Record<string, unknown>;
}

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('invalid text');
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid time');
  return value;
}

/** Only official HTTPS destinations may become clickable connection links. */
export function officialUrl(value: unknown): string {
  const raw = text(value, 8192);
  const url = new URL(raw);
  const allowed = ['feishu.cn', 'larksuite.com', 'larkoffice.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !allowed.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new Error('invalid destination');
  }
  return raw;
}

/** Validate host data before rendering it or making its URLs actionable. */
export function parseSnapshot(value: unknown): ConnectionSnapshot {
  const data = object(value);
  if (typeof data.phase !== 'string' || !phases.has(data.phase) || typeof data.busy !== 'boolean') {
    throw new Error('invalid state');
  }
  const capabilities = object(data.capabilities);
  if (typeof capabilities.cards !== 'boolean' || typeof capabilities.loading !== 'boolean') throw new Error('invalid capabilities');
  if (capabilities.documents !== undefined && typeof capabilities.documents !== 'boolean') throw new Error('invalid capabilities');
  if (['images', 'voice'].some(key => capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean')) throw new Error('invalid capabilities');
  const snapshot: ConnectionSnapshot = {
    phase: data.phase as ConnectionPhase, message: text(data.message), busy: data.busy,
    capabilities: {cards: capabilities.cards, loading: capabilities.loading,
      ...(capabilities.documents === undefined ? {} : {documents: capabilities.documents}),
      ...(capabilities.images === undefined ? {} : {images: capabilities.images as boolean}),
      ...(capabilities.voice === undefined ? {} : {voice: capabilities.voice as boolean})},
  };
  if (data.qr !== undefined) {
    const qr = object(data.qr);
    const image = text(qr.image, 1_000_000);
    if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)) throw new Error('invalid QR image');
    snapshot.qr = {url: officialUrl(qr.url), image, expiresAt: timestamp(qr.expiresAt)};
  }
  if (data.bot !== undefined) {
    const bot = object(data.bot);
    snapshot.bot = {name: text(bot.name, 200), appId: text(bot.appId, 200), url: officialUrl(bot.url)};
  }
  if (data.pairing !== undefined) {
    const pairing = object(data.pairing);
    snapshot.pairing = {code: text(pairing.code, 200), expiresAt: timestamp(pairing.expiresAt)};
  }
  if (data.confirmation !== undefined) {
    const confirmation = object(data.confirmation);
    snapshot.confirmation = {id: text(confirmation.id, 200), label: text(confirmation.label, 200)};
  }
  if (data.action !== undefined) {
    const action = object(data.action);
    snapshot.action = {label: text(action.label, 100), url: officialUrl(action.url)};
  }
  if (data.documentSetup !== undefined) {
    const setup = object(data.documentSetup);
    if (!['preparing', 'scanning', 'error'].includes(setup.phase as string)) throw new Error('invalid document setup');
    snapshot.documentSetup = {phase: setup.phase as 'preparing' | 'scanning' | 'error', message: text(setup.message, 600)};
    if (setup.qr !== undefined) {
      const qr = object(setup.qr), image = text(qr.image, 1_000_000);
      if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)) throw new Error('invalid QR image');
      snapshot.documentSetup.qr = {url: officialUrl(qr.url), image, expiresAt: timestamp(qr.expiresAt)};
    }
  }
  if (data.inputSetup !== undefined) {
    const setup = object(data.inputSetup);
    if (!['images', 'voice'].includes(setup.kind as string) || !['preparing', 'scanning', 'error'].includes(setup.phase as string)) throw new Error('invalid input setup');
    snapshot.inputSetup = {kind: setup.kind as 'images' | 'voice', phase: setup.phase as 'preparing' | 'scanning' | 'error', message: text(setup.message, 600)};
    if (setup.qr !== undefined) {
      const qr = object(setup.qr), image = text(qr.image, 1_000_000);
      if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)) throw new Error('invalid QR image');
      snapshot.inputSetup.qr = {url: officialUrl(qr.url), image, expiresAt: timestamp(qr.expiresAt)};
    }
  }
  if (data.menu !== undefined) {
    const menu = object(data.menu);
    if (!Array.isArray(menu.missing) || !menu.missing.length || menu.missing.length > 10) throw new Error('invalid menu');
    snapshot.menu = {url: officialUrl(menu.url), missing: menu.missing.map(value => {
      const entry = object(value);
      if (typeof entry.eventKey !== 'string' || !/^dsh\.[a-z]{1,30}$/.test(entry.eventKey)) throw new Error('invalid menu');
      return {label: text(entry.label, 60), eventKey: entry.eventKey, ...(entry.parent === undefined ? {} : {parent: text(entry.parent, 60)})};
    })};
  }
  if (data.update !== undefined) {
    const update = object(data.update);
    const version = (value: unknown) => {
      const raw = text(value, 64);
      if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?$/.test(raw)) throw new Error('invalid version');
      return raw;
    };
    snapshot.update = {current: version(update.current), latest: version(update.latest)};
  }
  if (data.agent !== undefined) {
    const agent = object(data.agent);
    if (typeof agent.imageInput !== 'boolean' || typeof agent.voiceInput !== 'boolean' || typeof agent.editable !== 'boolean') throw new Error('invalid agent');
    snapshot.agent = {label: text(agent.label, 80), agentPreset: text(agent.agentPreset, 200), workspace: text(agent.workspace, 4096),
      workspaceDisplay: text(agent.workspaceDisplay, 4096), imageInput: agent.imageInput, voiceInput: agent.voiceInput, editable: agent.editable};
  }
  return snapshot;
}

const connectionId = (value: unknown): string => {
  const id = text(value, 32);
  if (id !== 'default' && !/^[a-f0-9]{32}$/.test(id)) throw new Error('invalid robot');
  return id;
};
export function parseConnectionList(value: unknown): ConnectionList {
  const data = object(value);
  if (!Array.isArray(data.connections) || data.connections.length > 10 || !Number.isInteger(data.limit) || (data.limit as number) < 1 || (data.limit as number) > 10) throw new Error('invalid robots');
  const connections = data.connections.map(value => {
    const row = object(value);
    if (!phases.has(String(row.phase)) || typeof row.busy !== 'boolean') throw new Error('invalid robot status');
    return {id: connectionId(row.id), label: text(row.label, 200), phase: row.phase as ConnectionPhase, busy: row.busy, agentPreset: text(row.agentPreset, 200)};
  });
  if (new Set(connections.map(row => row.id)).size !== connections.length || connections.length > (data.limit as number)) throw new Error('invalid robots');
  return {connections, limit: data.limit as number};
}
export function parseAgentCatalog(value: unknown): AgentCatalog {
  const data = object(value);
  if (!Array.isArray(data.presets) || data.presets.length > 200 || ['presetsAvailable', 'imagesAvailable', 'voiceAvailable'].some(key => typeof data[key] !== 'boolean')) throw new Error('invalid agent catalog');
  if (data.modelImages !== undefined && !['supported', 'unsupported', 'unknown'].includes(data.modelImages as string)) throw new Error('invalid model capability');
  return {presetsAvailable: data.presetsAvailable as boolean, imagesAvailable: data.imagesAvailable as boolean, voiceAvailable: data.voiceAvailable as boolean,
    model: text(data.model, 200), ...(data.modelImages === undefined ? {} : {modelImages: data.modelImages as AgentCatalog['modelImages']}), ...(data.defaultPreset === undefined ? {} : {defaultPreset: text(data.defaultPreset, 200)}),
    presets: data.presets.map(value => {
      const row = object(value);
      if (typeof row.available !== 'boolean') throw new Error('invalid preset');
      return {id: text(row.id, 200), name: text(row.name, 200), available: row.available,
        ...(row.description === undefined ? {} : {description: text(row.description, 600)})};
    })};
}

function parseProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('invalid robots');
  return value.map(value => {
    const profile = object(value);
    return {name: text(profile.name, 200), appId: text(profile.appId, 200), label: text(profile.label, 200)};
  });
}

/** A vetted, user-facing service error; raw transport errors are never displayed. */
export class ConnectionUiError extends Error {}

/** Owner settings API. Credentials never enter its request or response fields. */
export class ConnectionApi {
  constructor(private readonly rpc: ConnectionRpc, private readonly modern = false, private readonly id?: string) {}

  forConnection(id: string): ConnectionApi {return new ConnectionApi(this.rpc, this.modern, connectionId(id));}

  private async request(endpoint: ConnectionEndpoint | ManagerEndpoint, payload: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const scoped = this.id === undefined || ['connections', 'add-connection', 'remove-connection', 'agent-catalog'].includes(endpoint) ? payload : {...object(payload), connectionId: this.id};
      const response = object(await this.rpc.call(this.modern ? '/api' : '/larkbot', this.modern ? `larkbot/${endpoint}` : endpoint, scoped, signal));
      if (response.ok === true) return response.value;
      if (response.ok === false) {
        const error = object(response.error);
        if (error.code === 'internal') throw new ConnectionUiError(text(error.message));
      }
      throw new Error('invalid response');
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ConnectionUiError) throw error;
      throw new ConnectionUiError('暂时无法连接助手服务，请稍后重试。');
    }
  }

  async snapshot(endpoint: Exclude<ConnectionEndpoint, 'profiles'>, payload: unknown, signal: AbortSignal): Promise<ConnectionSnapshot> {
    const value = await this.request(endpoint, payload, signal);
    try { return parseSnapshot(value); }
    catch { throw new ConnectionUiError('连接状态暂时无法读取，请重试或更新插件。'); }
  }

  async profiles(signal: AbortSignal): Promise<ConnectionProfile[]> {
    const value = await this.request('profiles', {}, signal);
    try { return parseProfiles(value); }
    catch { throw new ConnectionUiError('已有机器人的列表暂时无法读取，请重试。'); }
  }

  async connections(signal: AbortSignal): Promise<ConnectionList> {
    try {return parseConnectionList(await this.request('connections', {}, signal));}
    catch (error) {if (error instanceof ConnectionUiError || signal.aborted) throw error; throw new ConnectionUiError('机器人列表暂时无法读取，请刷新。');}
  }
  async addConnection(signal: AbortSignal): Promise<ConnectionList & {selectedId: string}> {
    const value = await this.request('add-connection', {}, signal);
    try {
      const data = object(value), list = parseConnectionList(data), selectedId = connectionId(data.selectedId);
      if (!list.connections.some(row => row.id === selectedId)) throw new Error();
      return {...list, selectedId};
    } catch {throw new ConnectionUiError('添加结果暂时无法确认，请刷新机器人列表后查看。');}
  }
  async removeConnection(id: string, signal: AbortSignal): Promise<ConnectionList & {selectedId: string}> {
    const value = object(await this.request('remove-connection', {connectionId: connectionId(id)}, signal));
    try {
      const list = parseConnectionList(value), selectedId = connectionId(value.selectedId);
      if (list.connections.some(row => row.id === id) || !list.connections.some(row => row.id === selectedId)) throw new Error();
      return {...list, selectedId};
    } catch {throw new ConnectionUiError('移除结果暂时无法确认，请刷新机器人列表查看。');}
  }
  async agentCatalog(signal: AbortSignal): Promise<AgentCatalog> {
    const value = await this.request('agent-catalog', {}, signal);
    try {return parseAgentCatalog(value);} catch {throw new ConnectionUiError('Agent 选项暂时无法读取，请刷新。');}
  }
}
