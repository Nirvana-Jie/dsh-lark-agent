import type {ConnectionEndpoint, ConnectionPhase, ConnectionProfile, ConnectionSnapshot} from '../onboarding/protocol.js';

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
  const snapshot: ConnectionSnapshot = {
    phase: data.phase as ConnectionPhase, message: text(data.message), busy: data.busy,
    capabilities: {cards: capabilities.cards, loading: capabilities.loading,
      ...(capabilities.documents === undefined ? {} : {documents: capabilities.documents})},
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
  return snapshot;
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
  constructor(private readonly rpc: ConnectionRpc, private readonly modern = false) {}

  private async request(endpoint: ConnectionEndpoint, payload: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const response = object(await this.rpc.call(this.modern ? '/api' : '/larkbot', this.modern ? `larkbot/${endpoint}` : endpoint, payload, signal));
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
}
