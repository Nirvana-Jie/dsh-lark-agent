import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { registerApp as sdkRegisterApp } from '@larksuiteoapi/node-sdk';
import {BOT_MENU_EVENT} from '../bot-menu.js';
import {DOCUMENT_SCOPES, STREAMING_SCOPE, defaultScopesReady} from '../rich-scopes.js';

// The SDK exports registerApp but not the named option/result interfaces in 1.76.0.
type RegisterAppOptions = Parameters<typeof sdkRegisterApp>[0];
type RegisterAppResult = Awaited<ReturnType<typeof sdkRegisterApp>>;

export type LarkBrand = 'feishu' | 'lark';
export interface ProfileSummary { name: string; appId: string; brand: LarkBrand; active: boolean }
/** Backend-only capability. Never serialize this object into public or durable onboarding state. */
export interface RegisteredApp { appId: string; appSecret: string; brand: LarkBrand; creatorOpenId?: string }
export type PlatformErrorCode = 'ABORTED' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'COMMAND_FAILED' | 'INVALID_INPUT'
  | 'INVALID_RESPONSE' | 'PROFILE_EXISTS' | 'PROFILE_NOT_FOUND' | 'APP_MISMATCH' | 'MISSING_SCOPE'
  | 'APP_IN_REVIEW' | 'UNSUPPORTED_APP' | 'ACCESS_DENIED' | 'AUTH_UNAVAILABLE' | 'CONFIRMATION_REQUIRED'
  | 'REGISTRATION_EXPIRED' | 'REGISTRATION_FAILED';
export class LarkPlatformError extends Error {
  constructor(public readonly code: PlatformErrorCode) {
    // Fixed messages only: SDK/CLI errors may contain URLs, credentials or provider diagnostics.
    super(`Lark setup failed (${code}).`);
    this.name = 'LarkPlatformError';
  }
}
export interface PlatformProblem { operation: 'bot' | 'scopes' | 'application' | 'version' | 'cards' | 'menu'; code: PlatformErrorCode }
export interface Inspection {
  profile: string; appId: string; brand: LarkBrand;
  botOpenId?: string; creatorOpenId?: string;
  grantedScopes: string[]; scopeStatus: 'verified' | 'unavailable';
  appStatus?: number; onlineVersionId?: string; pendingVersionId?: string;
  publicationStatus: 'approved' | 'pending' | 'rejected' | 'draft' | 'unknown';
  subscribedEvents?: string[];
  /** Event keys of the shown bot menu in that version; empty when its menu is off. */
  menuEventKeys?: string[];
  /** Read-only CLI preflight evidence. Actual connection readiness is checked by the service. */
  cardReady?: boolean;
  menuReady?: boolean;
  problems: PlatformProblem[];
}
export interface RegistrationRequest {
  name: string; description?: string; cardInteractions?: boolean; loadingReaction?: boolean;
  signal?: AbortSignal;
  onQRCode: (info: {url: string; expireIn: number}) => void;
  onStatus?: (info: {status: 'polling' | 'slow_down' | 'domain_switched'; interval?: number}) => void;
}
export interface CommandOptions { stdin?: string; signal?: AbortSignal; cwd?: string }
export type PlatformRunner = (args: readonly string[], options: CommandOptions) => Promise<string>;
export type AppRegistrar = (options: RegisterAppOptions) => Promise<RegisterAppResult>;
export interface LarkPlatformOptions {
  executable?: string;
  run?: PlatformRunner;
  registerApp?: AppRegistrar;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
}

export const BOT_SCOPES = ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot'] as const;
// SDK registration already provisions and publishes its selected bot features.
// Only self inspection is requested; mutation permission is an optional repair capability.
export const SETUP_SCOPES = ['application:application:self_manage'] as const;
export const CONFIGURE_SCOPE = 'application:application:patch';
// Lark CLI 1.0.98 requires this permission when consuming card.action.trigger.
export const CARD_SCOPE = 'im:message:readonly';
const REACTION_SCOPE = 'im:message.reactions:write_only';
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? v as Record<string, unknown> : undefined;
const validId = (v: unknown, prefix: string): v is string => typeof v === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,128}$`).test(v);
const validProfile = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
// Version IDs are opaque platform identifiers; console versions can also be numeric.
const validVersion = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const brand = (v: unknown): v is LarkBrand => v === 'feishu' || v === 'lark';
function fail(code: PlatformErrorCode): never { throw new LarkPlatformError(code); }
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) fail('ABORTED'); }
function safeError(error: unknown): LarkPlatformError {
  return error instanceof LarkPlatformError ? error : new LarkPlatformError('COMMAND_FAILED');
}
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return fail('INVALID_RESPONSE'); }
}
function classify(value: unknown, fallback: PlatformErrorCode = 'COMMAND_FAILED'): PlatformErrorCode {
  const error = object(object(value)?.error) ?? object(value);
  if (!error) return fallback;
  if (error.code === 210040 || error.code === 210302) return 'APP_IN_REVIEW';
  if (error.code === 210505) return 'UNSUPPORTED_APP';
  if (error.subtype === 'missing_scope' || error.code === 99991672 || error.code === 99991679) return 'MISSING_SCOPE';
  if (error.type === 'authentication' || error.subtype === 'not_configured') return 'AUTH_UNAVAILABLE';
  if (error.subtype === 'confirmation_required' || error.risk === 'high-risk-write') return 'CONFIRMATION_REQUIRED';
  return fallback;
}

/** Bounded argv/stdin transport; no shell, credential reads, default-profile switches or diagnostic echo. */
export function commandRunner(executable: string, timeoutMs: number, maxOutputBytes: number, awaitClose = false): PlatformRunner {
  return (args, options) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new LarkPlatformError('ABORTED')); return; }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {shell: false, windowsHide: true, stdio: 'pipe', cwd: options.cwd, env: {
        ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      }});
    } catch { reject(new LarkPlatformError('COMMAND_FAILED')); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, settled = false, failure: PlatformErrorCode | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined, endTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(endTimer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) { reject(new LarkPlatformError(failure)); return; }
      if (code !== 0) {
        let detail: unknown;
        try { detail = JSON.parse(Buffer.concat(stderr).toString('utf8')); } catch { /* Never expose free text. */ }
        reject(new LarkPlatformError(code === 10 ? 'CONFIRMATION_REQUIRED' : classify(detail))); return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    };
    const stop = (reason: PlatformErrorCode) => {
      if (settled || failure) return;
      failure = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      // A broken child must not block cancellation indefinitely. No write is retried automatically.
      if (!awaitClose) endTimer = setTimeout(() => finish(null), 2000);
    };
    const abort = () => stop('ABORTED');
    const deadline = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const receive = (target: Buffer[], chunk: Buffer | string) => {
      if (settled || failure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxOutputBytes) { stop('OUTPUT_LIMIT'); return; }
      target.push(buffer);
    };
    child.stdout.on('data', chunk => receive(stdout, chunk));
    child.stderr.on('data', chunk => receive(stderr, chunk));
    child.stdin.on('error', () => stop('COMMAND_FAILED'));
    child.on('error', () => {
      if (awaitClose && child.pid !== undefined) stop('COMMAND_FAILED');
      else {failure ??= 'COMMAND_FAILED'; finish(null);}
    });
    child.on('close', code => finish(code));
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) abort();
    child.stdin.end(options.stdin ?? '');
  });
}

export class LarkPlatform {
  private readonly run: PlatformRunner;
  private readonly registrar: AppRegistrar;
  // Serialize writes made by this adapter. Random names and a fresh metadata check also avoid accidental reuse.
  private profileWrite = Promise.resolve();

  constructor(options: LarkPlatformOptions = {}) {
    const executable = options.executable ?? 'lark-cli';
    if (!executable.trim() || executable.includes('\0')) fail('INVALID_INPUT');
    const timeout = options.commandTimeoutMs ?? 30_000, limit = options.maxOutputBytes ?? 1_048_576;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000
      || !Number.isInteger(limit) || limit < 128 || limit > 8_388_608) fail('INVALID_INPUT');
    this.run = options.run ?? commandRunner(executable, timeout, limit);
    this.registrar = options.registerApp ?? (async request => (await import('@larksuiteoapi/node-sdk')).registerApp(request));
  }

  private async json(args: readonly string[], signal?: AbortSignal, stdin?: string): Promise<unknown> {
    checkSignal(signal);
    let result: string;
    try { result = await this.run(args, {signal, stdin}); }
    catch (error) { checkSignal(signal); throw safeError(error); }
    checkSignal(signal);
    return parse(result);
  }

  async listProfiles(signal?: AbortSignal): Promise<ProfileSummary[]> {
    // Unlike API commands, `profile list` returns a bare JSON array.
    const result = await this.json(['profile', 'list'], signal);
    if (!Array.isArray(result) || result.length > 1000) fail('INVALID_RESPONSE');
    const seen = new Set<string>();
    return result.map(raw => {
      const p = object(raw);
      if (!p || !validProfile(p.name) || !validId(p.appId, 'cli') || !brand(p.brand)
        || typeof p.active !== 'boolean' || seen.has(p.name)) fail('INVALID_RESPONSE');
      seen.add(p.name);
      return {name: p.name, appId: p.appId, brand: p.brand, active: p.active};
    });
  }

  async registerNew(request: RegistrationRequest): Promise<RegisteredApp> {
    checkSignal(request.signal);
    if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 60
      || /[\u0000-\u001f\u007f]/.test(request.name) || typeof request.onQRCode !== 'function'
      || (request.description !== undefined && (typeof request.description !== 'string' || request.description.length > 500 || request.description.includes('\0')))
      || (request.cardInteractions !== undefined && typeof request.cardInteractions !== 'boolean')
      || (request.loadingReaction !== undefined && typeof request.loadingReaction !== 'boolean')) fail('INVALID_INPUT');
    try {
      const result = await this.registrar({
        source: 'dsh-larkbot', createOnly: true, signal: request.signal,
        appPreset: {name: request.name, desc: request.description ?? '在飞书中与 dsh 个人助手对话'},
        addons: {
          preset: false,
          scopes: {tenant: [...new Set([...BOT_SCOPES, ...SETUP_SCOPES, ...DOCUMENT_SCOPES, STREAMING_SCOPE, ...(request.cardInteractions ? [CARD_SCOPE] : []),
            ...(request.loadingReaction ? [REACTION_SCOPE] : [])])]},
          events: {items: {tenant: ['im.message.receive_v1', BOT_MENU_EVENT]}},
          ...(request.cardInteractions ? {callbacks: {items: ['card.action.trigger']}} : {}),
        },
        onQRCodeReady: info => {
          checkSignal(request.signal);
          let url: URL;
          try { url = new URL(info.url); } catch { return fail('INVALID_RESPONSE'); }
          if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !['accounts.feishu.cn', 'accounts.larksuite.com', 'open.feishu.cn', 'open.larksuite.com', 'open.larkoffice.com'].includes(url.hostname)
            || !Number.isFinite(info.expireIn) || info.expireIn <= 0) fail('INVALID_RESPONSE');
          request.onQRCode({url: info.url, expireIn: info.expireIn});
        },
        onStatusChange: info => {
          checkSignal(request.signal);
          if (!['polling', 'slow_down', 'domain_switched'].includes(info.status)) return;
          request.onStatus?.({status: info.status,
            ...(Number.isFinite(info.interval) && info.interval! > 0 ? {interval: info.interval} : {})});
        },
      });
      checkSignal(request.signal);
      if (!validId(result.client_id, 'cli') || typeof result.client_secret !== 'string'
        || !result.client_secret || result.client_secret.length > 4096 || /[\u0000-\u0020\u007f]/.test(result.client_secret)
        || (result.user_info?.tenant_brand !== undefined && !brand(result.user_info.tenant_brand))) fail('INVALID_RESPONSE');
      return {appId: result.client_id, appSecret: result.client_secret, brand: result.user_info?.tenant_brand ?? 'feishu',
        ...(validId(result.user_info?.open_id, 'ou') ? {creatorOpenId: result.user_info.open_id} : {})};
    } catch (error) {
      checkSignal(request.signal);
      if (error instanceof LarkPlatformError) throw error;
      const code = object(error)?.code;
      fail(code === 'abort' ? 'ABORTED' : code === 'access_denied' ? 'ACCESS_DENIED'
        : code === 'expired_token' ? 'REGISTRATION_EXPIRED' : 'REGISTRATION_FAILED');
    }
  }

  /** Incremental, owner-confirmed authorization; returned credentials never leave this method. */
  async enableDocuments(profile: string, onQRCode: (info: {url: string; expireIn: number}) => void, signal: AbortSignal): Promise<void> {
    const selected = await this.profile(profile, signal);
    try {
      const current = await this.inspect(profile, signal);
      if (current.appId !== selected.appId) fail('APP_MISMATCH');
      // Another host may already have completed the upgrade; never ask for another scan just to refresh UI state.
      if (current.scopeStatus === 'verified' && defaultScopesReady(current.grantedScopes)) return;
      const result = await this.registrar({source: 'dsh-larkbot', appId: selected.appId, signal,
        addons: {preset: false, scopes: {tenant: [...DOCUMENT_SCOPES, STREAMING_SCOPE]}},
        onQRCodeReady: info => {
          checkSignal(signal);
          let url: URL; try {url = new URL(info.url);} catch {return fail('INVALID_RESPONSE');}
          if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !['accounts.feishu.cn', 'accounts.larksuite.com', 'open.feishu.cn', 'open.larksuite.com', 'open.larkoffice.com'].includes(url.hostname)
            || !Number.isFinite(info.expireIn) || info.expireIn <= 0) fail('INVALID_RESPONSE');
          onQRCode({url: info.url, expireIn: info.expireIn});
        },
      });
      checkSignal(signal);
      if (result.client_id !== selected.appId || (result.user_info?.tenant_brand && result.user_info.tenant_brand !== selected.brand)) fail('APP_MISMATCH');
      const inspection = await this.inspect(profile, signal);
      if (inspection.appId !== selected.appId || inspection.scopeStatus !== 'verified' || !defaultScopesReady(inspection.grantedScopes)) fail('MISSING_SCOPE');
    } catch (error) {checkSignal(signal); if (error instanceof LarkPlatformError) throw error; fail('REGISTRATION_FAILED');}
  }

  async saveNewProfile(profile: string, app: RegisteredApp, signal?: AbortSignal): Promise<ProfileSummary> {
    if (!validProfile(profile) || !validId(app.appId, 'cli') || !brand(app.brand) || typeof app.appSecret !== 'string'
      || !app.appSecret || app.appSecret.length > 4096 || /[\u0000-\u0020\u007f]/.test(app.appSecret)) fail('INVALID_INPUT');
    const operation = this.profileWrite.then(async () => {
      checkSignal(signal);
      const profiles = await this.listProfiles(signal);
      if (profiles.some(p => p.name === profile || p.appId === profile)) fail('PROFILE_EXISTS');
      const result = object(await this.json(['config', 'init', '--name', profile, '--app-id', app.appId,
        '--app-secret-stdin', '--brand', app.brand], signal, app.appSecret + '\n'));
      if (!result || result.appId !== app.appId || result.brand !== app.brand) fail('INVALID_RESPONSE');
      const saved = (await this.listProfiles(signal)).find(p => p.name === profile);
      if (!saved || saved.appId !== app.appId || saved.brand !== app.brand) fail('APP_MISMATCH');
      return saved;
    });
    this.profileWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async profile(name: string, signal?: AbortSignal): Promise<ProfileSummary> {
    if (!validProfile(name)) fail('INVALID_INPUT');
    return (await this.listProfiles(signal)).find(p => p.name === name) ?? fail('PROFILE_NOT_FOUND');
  }

  private async api(profile: string, method: 'GET' | 'PATCH' | 'POST', path: string,
    signal?: AbortSignal, data?: object, params?: object): Promise<Record<string, unknown>> {
    const args = ['--profile', profile, 'api', method, path, '--as', 'bot', '--format', 'json'];
    if (params) args.push('--params', JSON.stringify(params));
    if (data) args.push('--data', '-');
    const result = object(await this.json(args, signal, data ? JSON.stringify(data) : undefined));
    if (!result || result.ok !== true || result.identity !== 'bot' || result.dry_run === true) {
      fail(result?.ok === false ? classify(result) : 'INVALID_RESPONSE');
    }
    // API commands return a success envelope; a bare OpenAPI `code: 0` is not sufficient.
    return object(result.data) ?? {};
  }

  async inspect(profile: string, signal?: AbortSignal): Promise<Inspection> {
    const selected = await this.profile(profile, signal);
    const inspection: Inspection = {profile, appId: selected.appId, brand: selected.brand,
      grantedScopes: [], scopeStatus: 'unavailable', publicationStatus: 'unknown', problems: []};
    const probe = async (operation: PlatformProblem['operation'], action: () => Promise<void>) => {
      try { await action(); } catch (error) {
        checkSignal(signal);
        inspection.problems.push({operation, code: safeError(error).code});
      }
    };
    await Promise.all([
      probe('bot', async () => {
        const result = await this.api(profile, 'GET', '/open-apis/bot/v3/info', signal);
        // CLI SuccessEnvelopeData flattens a legacy top-level `bot` payload into data.
        const bot = object(result.bot) ?? result;
        if (!validId(bot?.open_id, 'ou')) fail('INVALID_RESPONSE');
        inspection.botOpenId = bot.open_id;
      }),
      probe('scopes', async () => {
        const result = await this.api(profile, 'GET', '/open-apis/application/v6/scopes', signal);
        if (!Array.isArray(result.scopes) || result.scopes.length > 3000) fail('INVALID_RESPONSE');
        const granted: string[] = [];
        for (const raw of result.scopes) {
          const scope = object(raw);
          if (!scope || typeof scope.scope_name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(scope.scope_name)
            || (scope.grant_status !== 1 && scope.grant_status !== 2)) fail('INVALID_RESPONSE');
          if (scope.grant_status === 1) granted.push(scope.scope_name);
        }
        inspection.grantedScopes = [...new Set(granted)]; inspection.scopeStatus = 'verified';
      }),
      probe('application', async () => {
        const result = await this.api(profile, 'GET', `/open-apis/application/v6/applications/${selected.appId}`,
          signal, undefined, {lang: 'zh_cn', user_id_type: 'open_id'});
        const app = object(result.app);
        if (!app || app.app_id !== selected.appId || ![0, 1, 2, 3].includes(app.status as number)) fail('INVALID_RESPONSE');
        inspection.appStatus = app.status as number;
        const owner = object(app.owner);
        const creator = owner?.type === 2 && validId(owner.owner_id, 'ou') ? owner.owner_id : app.creator_id;
        if (validId(creator, 'ou')) inspection.creatorOpenId = creator;
        if (validVersion(app.online_version_id)) inspection.onlineVersionId = app.online_version_id;
        if (validVersion(app.unaudit_version_id)) inspection.pendingVersionId = app.unaudit_version_id;
      }),
      probe('cards', async () => {
        // This preview does not start a receiver, daemon or subscription, nor change app permissions.
        const result = object(await this.json(['--profile', profile, 'event', 'consume', 'card.action.trigger',
          '--as', 'bot', '--dry-run'], signal));
        const decision = object(object(result?.data)?.decision);
        if (!result || result.ok !== true || result.identity !== 'bot' || result.dry_run !== true || !decision
          || decision.event_key !== 'card.action.trigger' || decision.identity !== 'bot'
          || !['ready', 'blocked', 'unknown'].includes(decision.status as string)) fail('INVALID_RESPONSE');
        if (decision.status !== 'ready') return;
        if (!Array.isArray(decision.preconditions) || decision.preconditions.length > 32) fail('INVALID_RESPONSE');
        const conditions = decision.preconditions.map(object);
        const expected = ['credentials_available', 'console_event_published', 'scopes_granted'];
        if (conditions.every(condition => condition?.status === 'ok')
          && expected.every(name => conditions.filter(condition => condition?.name === name).length === 1)) {
          inspection.cardReady = true;
        }
      }),
      probe('menu', async () => {
        const result = object(await this.json(['--profile', profile, 'event', 'consume', BOT_MENU_EVENT, '--as', 'bot', '--dry-run'], signal));
        const decision = object(object(result?.data)?.decision);
        if (!result || result.ok !== true || result.identity !== 'bot' || result.dry_run !== true || !decision
          || decision.event_key !== BOT_MENU_EVENT || decision.identity !== 'bot'
          || !['ready', 'blocked', 'unknown'].includes(decision.status as string)) fail('INVALID_RESPONSE');
        if (decision.status !== 'ready') return;
        if (!Array.isArray(decision.preconditions) || decision.preconditions.length > 32) fail('INVALID_RESPONSE');
        const conditions = decision.preconditions.map(object);
        if (conditions.every(condition => condition?.status === 'ok')
          && ['credentials_available', 'console_event_published', 'scopes_granted'].every(name => conditions.filter(condition => condition?.name === name).length === 1)) {
          inspection.menuReady = true;
        }
      }),
    ]);
    // An approved online version keeps serving while a later version awaits review.
    // Only a first publication, with nothing online yet, is judged by its pending version.
    const version = inspection.onlineVersionId ?? inspection.pendingVersionId;
    if (version) await probe('version', async () => {
      const result = await this.api(profile, 'GET', `/open-apis/application/v6/applications/${selected.appId}/app_versions/${version}`,
        signal, undefined, {lang: 'zh_cn', user_id_type: 'open_id'});
      const detail = object(result.app_version);
      if (!detail || detail.app_id !== selected.appId || detail.version_id !== version
        || ![0, 1, 2, 3, 4].includes(detail.status as number)) fail('INVALID_RESPONSE');
      inspection.publicationStatus = ({1: 'approved', 2: 'rejected', 3: 'pending', 4: 'draft'} as const)[detail.status as 1 | 2 | 3 | 4] ?? 'unknown';
      // Version events do not prove websocket delivery. The controller still needs a real paired message.
      if (Array.isArray(detail.events) && detail.events.every(v => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(v))) {
        inspection.subscribedEvents = detail.events as string[];
      }
      const bot = object(object(detail.ability)?.bot);
      if (bot && Array.isArray(bot.bot_menus) && bot.bot_menus.length <= 64) {
        inspection.menuEventKeys = bot.bot_menu_enable !== true ? [] : bot.bot_menus.map(node => object(node)?.event_key)
          .filter((key): key is string => typeof key === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(key));
      }
    });
    checkSignal(signal);
    return inspection;
  }

  async configureAndPublish(profile: string, appId: string, options: {
    cardInteractions?: boolean; loadingReaction?: boolean; signal?: AbortSignal;
  } = {}): Promise<{versionId: string; status: 'submitted'}> {
    if (!validId(appId, 'cli') || (options.cardInteractions !== undefined && typeof options.cardInteractions !== 'boolean')
      || (options.loadingReaction !== undefined && typeof options.loadingReaction !== 'boolean')) fail('INVALID_INPUT');
    const inspection = await this.inspect(profile, options.signal);
    if (inspection.appId !== appId) fail('APP_MISMATCH');
    const required = [...BOT_SCOPES, CONFIGURE_SCOPE, ...(options.cardInteractions ? [CARD_SCOPE] : []),
      ...(options.loadingReaction ? [REACTION_SCOPE] : [])];
    if (inspection.scopeStatus !== 'verified' || required.some(scope => !inspection.grantedScopes.includes(scope))) fail('MISSING_SCOPE');
    if (inspection.pendingVersionId || inspection.publicationStatus === 'pending') fail('APP_IN_REVIEW');
    await this.api(profile, 'PATCH', `/open-apis/application/v7/applications/${appId}/config`, options.signal, {
      event: {subscription_type: 'websocket', add_events: ['im.message.receive_v1', BOT_MENU_EVENT]},
      ...(options.cardInteractions ? {callback: {callback_type: 'websocket', add_callbacks: ['card.action.trigger']}} : {}),
    });
    const result = await this.api(profile, 'POST', `/open-apis/application/v7/applications/${appId}/publish`, options.signal, {
      mobile_default_ability: 'bot', pc_default_ability: 'bot',
      remark: '连接 dsh 飞书机器人', changelog: '配置机器人消息与所选卡片的长连接接收方式',
    });
    if (!validVersion(result.version_id)) fail('INVALID_RESPONSE');
    return {versionId: result.version_id, status: 'submitted'};
  }
}
