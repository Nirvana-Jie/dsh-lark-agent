import type {Context} from '@deepseek-ai/cordis';
import {createHash} from 'node:crypto';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, join, resolve} from 'node:path';
import {createBotService, BotServiceStartError, type BotService} from '../bot-service.js';
import {checkRuntimeCompatibility, DshRuntime} from '../dsh-runtime.js';
import {acquireLock} from '../lock.js';
import {ConnectionController, SetupError} from './controller.js';
import {ConnectionStore} from './store.js';
import {LarkPlatform} from './lark-platform.js';
import type {ConnectionEndpoint, ConnectionResult} from './protocol.js';

interface Peer {principal?: {kind?: string}}
interface RpcHost {
  handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal, peer?: Peer) => Promise<ConnectionResult<unknown>>,
    options?: {authority: 'loopback'}): () => Promise<void>;
}
/** Public modern Connection routes are authenticated and owner-only before dispatch. */
export interface OwnerFetchRoutes {
  register(route: {path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response>}): () => void | Promise<void>;
}
const endpoints = new Set<ConnectionEndpoint>(['status', 'profiles', 'create', 'use-profile', 'recheck', 'cancel',
  'renew-pairing', 'confirm-owner', 'pause', 'resume', 'disconnect', 'enable-documents', 'cancel-documents']);
const failure = (message: string): ConnectionResult<never> => ({ok: false, error: {code: 'internal', message, details: {}}});
class ConnectionRegistrationCleanupError extends Error {}

/** Legacy channels pin loopback; modern exact routes inherit the host's authenticated owner gate. */
export function registerConnectionRpc(rpc: RpcHost, controller: ConnectionController): () => Promise<void>;
export function registerConnectionRpc(rpc: RpcHost, controller: ConnectionController, ownerRoutes?: OwnerFetchRoutes): (() => Promise<void>) | Promise<() => Promise<void>>;
export function registerConnectionRpc(rpc: RpcHost, controller: ConnectionController, ownerRoutes?: OwnerFetchRoutes): (() => Promise<void>) | Promise<() => Promise<void>> {
  const legacy = rpc.handle.length === 3;
  if (!legacy && rpc.handle.length !== 2) throw new SetupError('此 dsh 版本的连接接口尚未验证，请更新到支持的版本。');
  const dispatch = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionResult<unknown>> => {
    if (!endpoints.has(endpoint as ConnectionEndpoint)) return failure('不支持的连接操作。');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure('连接请求格式不正确。');
    const allowed = endpoint === 'create' ? ['cards', 'loading'] : endpoint === 'use-profile' ? ['name'] : endpoint === 'confirm-owner' ? ['id'] : [];
    const data = payload as Record<string, unknown>;
    if (Object.keys(data).some(key => !allowed.includes(key)) || Object.values(data).some(value =>
      !['boolean', 'string'].includes(typeof value) || (typeof value === 'string' && value.length > 200))) return failure('连接请求格式不正确。');
    if ((endpoint === 'create' && ['cards', 'loading'].some(key => data[key] !== undefined && typeof data[key] !== 'boolean'))
      || (endpoint === 'use-profile' && typeof data.name !== 'string')
      || (endpoint === 'confirm-owner' && typeof data.id !== 'string')) return failure('连接请求格式不正确。');
    try {
      if (endpoint === 'status') return {ok: true, value: controller.snapshot()};
      if (endpoint === 'profiles') return {ok: true, value: await controller.profiles(signal)};
      return {ok: true, value: await controller.command(endpoint as Exclude<ConnectionEndpoint, 'profiles' | 'status'>, payload)};
    } catch (error) {
      return failure(error instanceof SetupError ? error.message : '连接操作暂时失败，请检查本机服务后重试。');
    }
  };
  if (!legacy && ownerRoutes) {
    // App 0.2.1's custom-channel rpc.handle accesses webServer from a provider
    // context that does not inject it. Its public exact Fetch routes share the
    // existing authenticated /api carrier and reject non-owner peers in the host.
    return (async () => {
      const disposers: Array<() => void | Promise<void>> = [];
      const close = async () => {
        const errors: unknown[] = [];
        for (const dispose of [...disposers].reverse()) {try {await dispose();} catch (error) {errors.push(error);}}
        if (errors.length) throw new ConnectionRegistrationCleanupError('Connection routes could not be removed.');
      };
      try {
        for (const endpoint of endpoints) {
          disposers.push(ownerRoutes.register({path: `/api/larkbot/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
            async fetch(request) {
              const envelope = await readConnectionEnvelope(request, `larkbot/${endpoint}`);
              if (envelope instanceof Response) return envelope;
              const result = await dispatch(endpoint, envelope.payload, request.signal);
              return Response.json({type: 'server-response', rpcId: envelope.rpcId, result});
            },
          }));
        }
      } catch (error) {await close(); throw error;}
      let closing: Promise<void> | undefined;
      return () => closing ??= close();
    })();
  }
  return rpc.handle('/larkbot', async (endpoint, payload, signal, peer) => {
    // Legacy HTTP pins every endpoint to loopback; any supplied peer must be owner.
    if ((!legacy || peer !== undefined) && peer?.principal?.kind !== 'owner') return failure('只有本机所有者可以管理飞书连接。');
    return dispatch(endpoint, payload, signal);
  }, {authority: 'loopback'});
}

async function readConnectionEnvelope(request: Request, method: string): Promise<{rpcId: string; payload: unknown} | Response> {
  if (request.method !== 'POST') return new Response('method not allowed', {status: 405});
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return new Response('JSON required', {status: 415});
  }
  const reader = request.body?.getReader();
  if (!reader) return new Response('invalid request', {status: 400});
  const decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8192) {await reader.cancel(); return new Response('request too large', {status: 413});}
      body += decoder.decode(next.value, {stream: true});
    }
    body += decoder.decode();
    const value = JSON.parse(body) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'client-request'
      || typeof value.rpcId !== 'string' || value.rpcId.length < 1 || value.rpcId.length > 200 || value.method !== method
      || Object.keys(value).some(key => !['type', 'rpcId', 'method', 'payload'].includes(key))) return new Response('invalid request', {status: 400});
    return {rpcId: value.rpcId, payload: value.payload};
  } catch { return new Response('invalid request', {status: 400}); }
  finally {reader.releaseLock();}
}

export async function findLarkExecutable(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const paths = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin'),
    join(homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const directory of paths) {
    const candidate = join(directory, process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli');
    try {await access(candidate, constants.X_OK); return candidate;} catch { /* Try known installation locations. */ }
  }
  return 'lark-cli';
}

function requireRuntime(ctx: Context): void {
  if (!checkRuntimeCompatibility(ctx).supported) throw new SetupError('当前 dsh 缺少所需的会话能力，请检查插件和持久化服务。');
  const selection = (ctx.get('agentDefaultModel') as {currentSelection?(): {provider?: string; model?: string}} | undefined)?.currentSelection?.();
  if (!selection?.provider || !selection.model) throw new SetupError('请先在 dsh 的模型设置中选择可用模型，然后回来继续连接飞书。');
}
async function waitReady(service: BotService, signal: AbortSignal): Promise<void> {
  if (service.ready()) return;
  await new Promise<void>((resolve, reject) => {
    const end = Date.now() + 45_000;
    const abort = () => {clearInterval(timer); reject(new SetupError('连接已取消。'));};
    const timer = setInterval(() => {
      if (signal.aborted) {abort(); return;}
      if (service.ready()) {clearInterval(timer); signal.removeEventListener('abort', abort); resolve();}
      else if (Date.now() >= end) {clearInterval(timer); signal.removeEventListener('abort', abort); reject(new SetupError('飞书长连接尚未就绪，请确认事件订阅和应用发布。'));}
    }, 50);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

/** Attach the control plane without requiring any user-written team configuration. */
export async function applyOnboarding(ctx: Context, options: {dataDir?: string; executable?: string} = {}): Promise<void> {
  const connection = ctx.get('connection') as {rpc: RpcHost; fetch?: OwnerFetchRoutes} | undefined;
  if (!connection?.rpc) throw new SetupError('请在 dsh Web 或桌面 App 中启用插件；后台部署可设置 DSH_LARK_CONFIG。');
  const family = checkRuntimeCompatibility(ctx).family;
  const homeKey = createHash('sha256').update(resolve(process.env.DSH_HOME ?? homedir())).digest('hex').slice(0, 16);
  // Never mix legacy and V4 native logs or silently migrate a former headless installation.
  const directory = options.dataDir ? resolve(options.dataDir) : join(homedir(), '.dsh-larkbot', 'hosts', family, homeKey);
  const release = await acquireLock(join(directory, 'controller'));
  const executable = await findLarkExecutable(options.executable);
  const controller = new ConnectionController({store: new ConnectionStore(directory), platform: new LarkPlatform({executable}), executable,
    checkRuntime: () => requireRuntime(ctx),
    preflight: async (config, signal) => {
      const policy = config.users[0]!;
      const timeout = AbortSignal.timeout(45_000);
      const combined = AbortSignal.any([signal, timeout]);
      const session = await new DshRuntime(ctx).create({...policy, provider: config.provider, model: config.model});
      try {
        const result = await session.run('这是飞书连接测试，请只回复“连接成功”。', combined);
        if (!(typeof result === 'string' ? result : result.text).trim()) throw new SetupError('模型没有返回内容，请检查模型设置后重试。');
        await session.checkpoint();
      } finally {await session.dispose();}
    },
    start: async (config, signal, health, pairedChat) => {
      signal.throwIfAborted();
      const service = await createBotService(ctx, config, health, {directChat: pairedChat});
      try {signal.throwIfAborted(); service.start(); await waitReady(service, signal); return service;}
      catch (error) {if (!await service.stop()) throw new BotServiceStartError(service); throw error;}
    },
  });
  let remove: (() => Promise<void>) | undefined;
  try {
    remove = await registerConnectionRpc(connection.rpc, controller, connection.fetch);
    ctx.effect(() => {
      return async () => {
        await remove!();
        if (await controller.dispose()) await release();
        else console.error('[im-larkbot] connection shutdown incomplete; controller lock retained.');
      };
    }, 'im-larkbot.connection-settings');
    await controller.initialize();
  } catch (error) {
    if (error instanceof ConnectionRegistrationCleanupError) throw error;
    if (remove) await remove();
    if (await controller.dispose()) await release();
    throw error;
  }
}
