import {createHash, randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import QRCode from 'qrcode';
import {parseConfig, type BotConfig} from '../config.js';
import {BotServiceStartError, type BotService} from '../bot-service.js';
import type {IncomingMessage} from '../message.js';
import {LarkCli} from '../lark-cli.js';
import {BOT_SCOPES, CARD_SCOPE, LarkPlatform, LarkPlatformError, type Inspection} from './lark-platform.js';
import {ConnectionStore, type ConnectionRecord} from './store.js';
import {createChallenge, PairingError, waitForPairing} from './pairing.js';
import type {ConnectionEndpoint, ConnectionProfile, ConnectionSnapshot} from './protocol.js';
import {documentScopesReady} from '../rich-scopes.js';

export interface OnboardingDependencies {
  platform: Pick<LarkPlatform, 'listProfiles' | 'registerNew' | 'saveNewProfile' | 'inspect' | 'configureAndPublish'> & Partial<Pick<LarkPlatform, 'enableDocuments'>>;
  store: ConnectionStore;
  checkRuntime(): void;
  start(config: BotConfig, signal: AbortSignal, onHealth: (ready: boolean) => void, pairedChat?: {openId: string; chatId: string}): Promise<BotService>;
  preflight(config: BotConfig, signal: AbortSignal): Promise<void>;
  pair?: typeof waitForPairing;
  qr?: (url: string) => Promise<string>;
  acknowledge?: (profile: string, messageId: string, key: string, signal: AbortSignal) => Promise<void>;
  executable?: string;
}

const messages = {
  idle: '把助手带到飞书，先用飞书确认创建。',
  creating: '正在准备飞书创建入口。', waiting_scan: '用飞书扫码确认，完成后这里会自动继续。',
  configuring: '正在检查机器人权限、消息订阅和发布状态。',
  pairing: '请在机器人私聊发送配对词。', confirming_owner: '请确认刚才发送配对词的是你本人。',
  starting: '正在验证模型并启动连接。', connected: '连接已就绪，可以到飞书私聊继续。',
  paused: '已暂停。恢复后可以继续之前的对话。', error: '连接尚未完成，请检查后重试。',
  action_required: '请在飞书开发者后台完成设置或等待企业批准，再重新检查。',
} as const;

export class SetupError extends Error {}
function errorMessage(error: unknown): string {
  if (error instanceof SetupError) return error.message;
  if (error instanceof PairingError) return {
    EXPIRED: '配对词已过期，请重新生成后发送。', ABORTED: '已取消本次连接。',
    BUSY: '这个机器人已在另一个实例运行，请先暂停原连接。',
    TRANSPORT: '暂时收不到飞书消息，请确认已启用长连接并发布应用。',
  }[error.code];
  if (error instanceof LarkPlatformError) {
    if (error.code === 'REGISTRATION_EXPIRED') return '二维码已过期，请返回并重新扫码。';
    if (error.code === 'PROFILE_EXISTS') return '连接名称已被使用，请重新创建连接。';
    if (error.code === 'COMMAND_FAILED') return '飞书 CLI 暂时不可用，请确认已安装 lark-cli 后重试。';
    if (error.code === 'MISSING_SCOPE') return '飞书应用权限尚未生效，请完成权限配置和发布后重新检查。';
    if (error.code === 'CONFIRMATION_REQUIRED') return '飞书平台要求确认此操作，请在开发者后台完成后重新检查。';
  }
  return '连接暂时失败。已保存的配置与对话会保留，请检查模型、飞书权限或本地服务后重试。';
}
export function officialDestination(raw: string): string {
  const url = new URL(raw);
  if (raw.length > 8192 || url.protocol !== 'https:' || url.username || url.password
    || (url.port && url.port !== '443') || !['feishu.cn', 'larksuite.com', 'larkoffice.com']
      .some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new SetupError('飞书返回了无法识别的授权地址。');
  return raw;
}

/** One host-owner controller. Long operations are polled; views never own their lifetime. */
export class ConnectionController {
  private state: ConnectionSnapshot = {phase: 'idle', message: messages.idle, busy: false, capabilities: {cards: true, loading: true}};
  private record?: ConnectionRecord;
  private service?: BotService;
  private job?: Promise<void>;
  private aborter?: AbortController;
  private generation = 0;
  private closed = false;
  private unsafeStop = false;
  private menuReady = false;
  private documentsReady = false;
  private documentSetup?: ConnectionSnapshot['documentSetup'];
  private documentJob?: Promise<void>;
  private documentAborter?: AbortController;
  private candidate?: {id: string; message: IncomingMessage; expiresAt: number};
  private commands: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: OnboardingDependencies) {}

  snapshot(): ConnectionSnapshot {return structuredClone({...this.state,
    capabilities: {...this.state.capabilities, documents: this.documentsReady}, ...(this.documentSetup ? {documentSetup: this.documentSetup} : {})});}
  private phase(phase: ConnectionSnapshot['phase'], message: string = messages[phase]): void {
    this.state = {phase, message, busy: ['creating', 'configuring', 'starting'].includes(phase),
      capabilities: {cards: this.record?.cards ?? true, loading: this.record?.loading ?? true},
      ...(this.record ? {bot: {name: '我的 dsh 助手', appId: this.record.appId,
        url: `https://applink.${this.record.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/bot/open?appId=${this.record.appId}`}} : {})};
  }
  private action(message: string = messages.action_required): void {
    this.phase('action_required', message);
    if (this.record) this.state.action = {label: '打开飞书后台', url: this.consoleUrl()};
  }
  private consoleUrl(): string {
    return `https://open.${this.record?.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/app/${this.record!.appId}`;
  }
  private assertCurrent(signal: AbortSignal): void {signal.throwIfAborted(); if (this.closed) throw new SetupError('连接设置已关闭。');}
  private async save(record: ConnectionRecord): Promise<void> {await this.deps.store.write(record); this.record = record;}
  private launch(work: (signal: AbortSignal) => Promise<void>): void {
    const generation = ++this.generation;
    const aborter = this.aborter = new AbortController();
    this.job = Promise.resolve().then(() => work(aborter.signal)).catch(error => {
      if (generation !== this.generation || this.closed || aborter.signal.aborted) return;
      this.phase('error', errorMessage(error));
      if (this.record) this.state.action = {label: '检查飞书设置', url: this.consoleUrl()};
    }).finally(() => {if (generation === this.generation) {this.job = undefined; this.aborter = undefined;}});
  }
  async initialize(): Promise<void> {
    this.record = await this.deps.store.read(); // Corrupt durable state fails closed.
    if (!this.record) return;
    if (this.record.enabled && this.record.ownerOpenId) {
      this.phase('configuring'); this.launch(signal => this.check(signal, false));
    } else if (this.record.ownerOpenId && this.record.verified) {
      this.phase('paused');
      const record = this.record, aborter = this.documentAborter = new AbortController();
      // Read capability metadata without resuming a receiver or changing the saved pause state.
      // Keep this independent of the connection job so an immediate Resume click cannot be lost.
      this.documentJob = this.deps.platform.inspect(record.profile, aborter.signal).then(inspection => {
        if (!aborter.signal.aborted && !this.closed && this.record?.appId === record.appId) {
          if (inspection.appId === record.appId && (!record.botOpenId || inspection.botOpenId === record.botOpenId)) {
            this.documentsReady = inspection.scopeStatus === 'verified' && documentScopesReady(inspection.grantedScopes);
          }
        }
      }).catch(() => { /* A metadata outage must not turn an intentional pause into a failed connection. */ })
        .finally(() => {if (this.documentAborter === aborter) {this.documentJob = undefined; this.documentAborter = undefined;}});
    }
    else this.action('已保存机器人，请重新检查发布状态后继续确认本人。');
  }

  async profiles(signal?: AbortSignal): Promise<ConnectionProfile[]> {
    const profiles = await this.deps.platform.listProfiles(signal);
    return profiles.map(p => ({name: p.name, appId: p.appId, label: p.name}));
  }
  async command(endpoint: Exclude<ConnectionEndpoint, 'profiles' | 'status'>, payload: unknown): Promise<ConnectionSnapshot> {
    const result = this.commands.then(async () => {
      if (this.closed) throw new SetupError('连接设置已关闭。');
      if (this.unsafeStop) throw new SetupError('连接未能安全停止，请检查并关闭原实例。为防止重复处理，当前连接锁已保留。');
      const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      if (endpoint === 'cancel-documents') {await this.cancelDocuments(); return this.snapshot();}
      if (endpoint === 'enable-documents') {
        if (!this.record?.verified || !this.record.ownerOpenId || this.job || !this.deps.platform.enableDocuments) throw new SetupError('请先连接并确认本人，再补充默认权限。');
        if (this.documentsReady) return this.snapshot();
        if (this.documentJob) return this.snapshot();
        const record = this.record, aborter = this.documentAborter = new AbortController();
        this.documentSetup = {phase: 'preparing', message: '正在准备文档与画板授权，聊天连接继续保持。'};
        this.documentJob = this.deps.platform.enableDocuments(record.profile, info => {
          const url = officialDestination(info.url), expiresAt = Date.now() + info.expireIn * 1000;
          void (this.deps.qr ?? (url => QRCode.toDataURL(url, {width: 256, margin: 2})))(url).then(image => {
            if (aborter.signal.aborted || this.closed || this.documentAborter !== aborter) return;
            this.documentSetup = {phase: 'scanning', message: '用飞书扫码补充文档与画板权限，无需重新创建或配对机器人。', qr: {url, image, expiresAt}};
          }).catch(() => {if (!aborter.signal.aborted) {this.documentSetup = {phase: 'error', message: '二维码未能生成，请重试。'}; aborter.abort();}});
        }, aborter.signal).then(() => {
          if (!aborter.signal.aborted && !this.closed && this.record?.appId === record.appId) {this.documentsReady = true; this.documentSetup = undefined;}
        }).catch(error => {
          if (!aborter.signal.aborted && !this.closed) this.documentSetup = {phase: 'error', message: errorMessage(error)};
        }).finally(() => {if (this.documentAborter === aborter) {this.documentJob = undefined; this.documentAborter = undefined;}});
        return this.snapshot();
      }
      if (endpoint === 'cancel' || endpoint === 'pause' || endpoint === 'disconnect') {
        await this.cancel();
        if (this.service && !await this.service.stop()) {
          this.unsafeStop = true;
          this.phase('error', '连接未能安全停止，请检查并关闭原实例。');
          throw new SetupError('连接未能安全停止，请检查本地服务；为防重复运行，连接锁已保留。');
        }
        this.service = undefined;
        if (this.record) await this.save({...this.record, enabled: false,
          ...(endpoint === 'disconnect' ? {ownerOpenId: undefined, ownerChatId: undefined, verified: false} : {})});
        this.phase(endpoint === 'pause' ? 'paused' : 'idle');
        return this.snapshot();
      }
      if (endpoint === 'create') {
        if (this.job) {
          if (this.state.phase === 'waiting_scan' && this.state.qr && this.state.qr.expiresAt <= Date.now()) await this.cancel();
          else return this.snapshot();
        }
        if (this.service || this.record?.enabled) throw new SetupError('请先暂停或断开当前机器人。');
        this.deps.checkRuntime();
        this.record = undefined;
        this.phase('creating');
        this.state.capabilities = {cards: data.cards !== false, loading: data.loading !== false};
        const options = {...this.state.capabilities};
        this.launch(signal => this.create(options, signal));
      } else if (endpoint === 'use-profile') {
        if (this.job) return this.snapshot();
        if (this.service || this.record?.enabled) throw new SetupError('请先暂停或断开当前机器人。');
        if (typeof data.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.name)) throw new SetupError('请选择已有机器人。');
        this.deps.checkRuntime();
        const name = data.name;
        this.phase('configuring');
        this.launch(async signal => {
          const profile = (await this.deps.platform.listProfiles(signal)).find(p => p.name === name);
          if (!profile) throw new SetupError('没有找到这个机器人，请刷新列表。');
          this.assertCurrent(signal);
          const previous = this.record?.profile === name && this.record.appId === profile.appId
            && this.record.brand === profile.brand ? this.record : undefined;
          await this.save({schema: 1, profile: name, appId: profile.appId, brand: profile.brand,
            cards: previous?.cards ?? false, loading: previous?.loading ?? false,
            enabled: false, verified: false, publishAttempted: true});
          await this.check(signal, false, !previous);
        });
      } else if (endpoint === 'confirm-owner') {
        const candidate = this.candidate;
        if (this.job || !candidate || this.state.phase !== 'confirming_owner' || data.id !== candidate.id || candidate.expiresAt <= Date.now()) {
          throw new SetupError('这次确认已失效，请重新配对。');
        }
        this.candidate = undefined;
        this.phase('starting');
        this.launch(signal => this.bind(candidate.message, signal));
      } else if (endpoint === 'renew-pairing') {
        if (!this.record || this.record.verified || this.service) throw new SetupError('请先选择需要连接的机器人。');
        await this.cancel();
        this.phase('configuring'); this.launch(signal => this.check(signal, false));
      } else if (endpoint === 'recheck' || endpoint === 'resume') {
        if (this.job) return this.snapshot();
        if (!this.record) {this.phase('idle'); return this.snapshot();}
        if (this.service) {
          if (!this.record.verified || !this.record.enabled) throw new SetupError('本人验证尚未完成，请先安全停止连接后重新配对。');
          this.phase(this.service.ready() ? 'connected' : 'starting', this.service.ready() ? messages.connected : '正在重新连接飞书。');
          return this.snapshot();
        }
        this.deps.checkRuntime();
        this.phase('configuring'); this.launch(signal => this.check(signal, false));
      } else throw new SetupError('不支持的连接操作。');
      return this.snapshot();
    });
    this.commands = result.catch(() => undefined);
    return result;
  }

  private async create(options: {cards: boolean; loading: boolean}, signal: AbortSignal): Promise<void> {
    const profile = `dsh-${randomUUID().slice(0, 18)}`;
    const registration = await this.deps.platform.registerNew({name: '{user} 的 dsh 助手',
      description: '通过飞书继续本机 DeepSeek Harness 的对话与任务。', cardInteractions: options.cards,
      loadingReaction: options.loading, signal,
      onQRCode: info => {
        if (signal.aborted) return;
        this.phase('waiting_scan');
        const url = officialDestination(info.url);
        void (this.deps.qr ?? (url => QRCode.toDataURL(url, {width: 320, margin: 2})))(url).then(image => {
          if (!signal.aborted && !this.closed && this.state.phase === 'waiting_scan') {
            this.state.qr = {url, image, expiresAt: Date.now() + Math.max(1, info.expireIn) * 1000};
          }
        }).catch(() => {if (!signal.aborted) this.phase('error', '二维码生成失败，请返回后重新尝试。');});
      }});
    this.assertCurrent(signal);
    this.phase('configuring');
    await this.deps.platform.saveNewProfile(profile, registration, signal);
    this.assertCurrent(signal);
    await this.save({schema: 1, profile, appId: registration.appId, brand: registration.brand,
      creatorOpenId: registration.creatorOpenId, enabled: false, verified: false, publishAttempted: false,
      cards: options.cards, loading: options.loading});
    // The credential capability goes out of scope; it is never copied into UI/durable state.
    await this.check(signal, true);
  }

  private async check(signal: AbortSignal, configure: boolean, autodetect = false): Promise<void> {
    this.assertCurrent(signal);
    let record = this.record!;
    let inspection: Inspection = await this.deps.platform.inspect(record.profile, signal);
    this.documentsReady = inspection.scopeStatus === 'verified' && documentScopesReady(inspection.grantedScopes);
    this.assertCurrent(signal);
    if (inspection.appId !== record.appId || (record.botOpenId && inspection.botOpenId && record.botOpenId !== inspection.botOpenId)) {
      throw new SetupError('机器人身份发生变化，请断开后重新绑定。');
    }
    record = {...record, botOpenId: inspection.botOpenId ?? record.botOpenId,
      creatorOpenId: record.creatorOpenId ?? inspection.creatorOpenId};
    if (autodetect) {
      const granted = inspection.scopeStatus === 'verified' ? inspection.grantedScopes : [];
      record.cards = granted.includes(CARD_SCOPE) && inspection.cardReady === true;
      record.loading = granted.includes('im:message.reactions:write_only');
    }
    await this.save(record);
    const required = [...BOT_SCOPES, ...(record.cards ? [CARD_SCOPE] : []),
      ...(record.loading ? ['im:message.reactions:write_only'] : [])];
    if (configure && !record.publishAttempted) {
      // Official SDK registration can already provision websocket delivery and publish.
      // Do not require mutation permission or submit a second version in that case.
      // Metadata is still not delivery proof: pairing and the outbound acknowledgment remain mandatory.
      const alreadyProvisioned = inspection.publicationStatus === 'approved' && Boolean(inspection.botOpenId)
        && inspection.scopeStatus === 'verified' && required.every(scope => inspection.grantedScopes.includes(scope));
      // Record this decision before any optional repair: an unknown write result must never trigger a silent retry.
      await this.save({...record, publishAttempted: true});
      if (!alreadyProvisioned) {
        try {
          await this.deps.platform.configureAndPublish(record.profile, record.appId,
            {cardInteractions: record.cards, loadingReaction: record.loading, signal});
        } catch (error) {
          this.assertCurrent(signal);
          this.action(errorMessage(error)); return;
        }
        inspection = await this.deps.platform.inspect(record.profile, signal);
        this.assertCurrent(signal);
        if (inspection.appId !== record.appId || (record.botOpenId && inspection.botOpenId && record.botOpenId !== inspection.botOpenId)) {
          throw new SetupError('机器人身份发生变化，请断开后重新绑定。');
        }
        await this.save({...this.record!, botOpenId: inspection.botOpenId ?? this.record!.botOpenId,
          creatorOpenId: this.record!.creatorOpenId ?? inspection.creatorOpenId});
      }
    }
    if (inspection.appStatus === 0 || inspection.appStatus === 2) {
      this.action('飞书应用尚未启用，请在后台启用并完成发布后重新检查。'); return;
    }
    if (inspection.scopeStatus !== 'verified' || required.some(scope => !inspection.grantedScopes.includes(scope))) {
      this.action('机器人所需的消息权限尚未生效。请在飞书确认权限并发布应用后重新检查。'); return;
    }
    if (['pending', 'draft', 'rejected'].includes(inspection.publicationStatus)) {
      this.action(inspection.publicationStatus === 'pending' ? '应用正在等待企业审批。批准后，回来点击重新检查。'
        : '请在飞书完成应用发布，再回来重新检查。'); return;
    }
    if (!this.record!.botOpenId) {this.action('机器人身份尚未就绪，请确认机器人能力已开启且应用已发布。'); return;}
    this.menuReady = inspection.menuReady === true;
    if (this.record!.ownerOpenId && this.record!.verified) {await this.start(signal); return;}
    const challenge = createChallenge();
    this.phase('pairing'); this.state.pairing = challenge;
    const message = await (this.deps.pair ?? waitForPairing)({profile: record.profile, botOpenId: this.record!.botOpenId!,
      challenge, expectedOwner: this.record!.creatorOpenId ?? this.record!.ownerOpenId, signal, executable: this.deps.executable});
    this.assertCurrent(signal);
    if (this.record!.creatorOpenId) {await this.bind(message, signal); return;}
    this.candidate = {id: randomUUID(), message, expiresAt: challenge.expiresAt};
    this.phase('confirming_owner');
    this.state.confirmation = {id: this.candidate.id, label: '已收到配对消息，请确认这是你刚发送的私聊。'};
  }

  private async config(): Promise<BotConfig> {
    const record = this.record!;
    if (!record.ownerOpenId || !record.botOpenId) throw new SetupError('请先确认你的飞书身份。');
    const identity = createHash('sha256').update(JSON.stringify([record.appId, record.ownerOpenId])).digest('hex').slice(0, 24);
    const directory = join(this.deps.store.directory, 'bots', identity);
    const cwd = join(directory, 'workspace');
    await mkdir(cwd, {recursive: true, mode: 0o700});
    return parseConfig({profile: record.profile, botOpenId: record.botOpenId, stateDir: join(directory, 'state'),
      executable: this.deps.executable ?? 'lark-cli', users: [{openId: record.ownerOpenId, direct: true,
      groupChats: [], cwd, allowedTools: []}], cardInteractions: record.cards, loadingReaction: record.loading, botMenu: this.menuReady}, directory);
  }
  private async bind(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    this.assertCurrent(signal);
    if (this.record!.creatorOpenId && message.senderId !== this.record!.creatorOpenId) throw new SetupError('配对账号与创建者不一致。');
    await this.save({...this.record!, ownerOpenId: message.senderId, ownerChatId: message.chatId, enabled: false, verified: false});
    this.phase('starting');
    await this.start(signal, false);
    try {
      const key = createHash('sha256').update(`pair:${message.messageId}`).digest('hex').slice(0, 48);
      if (this.deps.acknowledge) await this.deps.acknowledge(this.record!.profile, message.messageId, key, signal);
      else {
        const sender = new LarkCli({profile: this.record!.profile, executable: this.deps.executable});
        try {await sender.reply(message.messageId, '连接好了。以后可以在这里找我，继续讨论或交代一件事。', {idempotencyKey: key, inThread: false});}
        finally {await sender.stop();}
      }
      this.assertCurrent(signal);
      await this.save({...this.record!, verified: true, enabled: true});
      this.phase(this.service!.ready() ? 'connected' : 'starting');
    } catch (error) {
      if (this.service && !await this.service.stop()) {
        this.unsafeStop = true;
        throw new SetupError('回复确认失败且连接未安全停止，请检查本地服务。');
      }
      this.service = undefined;
      await this.save({...this.record!, enabled: false});
      throw error;
    }
  }
  private async start(signal: AbortSignal, activate = true): Promise<void> {
    this.assertCurrent(signal); this.deps.checkRuntime(); this.phase('starting');
    const config = await this.config();
    await this.deps.preflight(config, signal);
    this.assertCurrent(signal);
    let ownedService: BotService | undefined;
    let service: BotService;
    try {
      service = await this.deps.start(config, signal, ready => {
        if (this.closed || signal.aborted || !ownedService || this.service !== ownedService || !this.record?.enabled) return;
        if (this.state.phase === 'connected' || this.state.phase === 'starting') this.phase(ready ? 'connected' : 'starting', ready ? messages.connected : '连接暂时中断，正在重连。');
      }, this.record?.ownerOpenId && this.record.ownerChatId ? {openId: this.record.ownerOpenId, chatId: this.record.ownerChatId} : undefined);
    } catch (error) {
      if (error instanceof BotServiceStartError) {this.service = error.service; this.unsafeStop = true;}
      throw error;
    }
    ownedService = service;
    this.service = service;
    try {
      this.assertCurrent(signal);
      if (activate) {await this.save({...this.record!, enabled: true}); this.phase(service.ready() ? 'connected' : 'starting');}
    } catch (error) {
      if (await service.stop()) this.service = undefined;
      else this.unsafeStop = true;
      throw error;
    }
  }
  private async cancel(): Promise<void> {
    await this.cancelDocuments();
    this.generation++; this.aborter?.abort();
    await this.job; this.job = undefined; this.aborter = undefined; this.candidate = undefined;
  }
  private async cancelDocuments(): Promise<void> {
    this.documentAborter?.abort(); await this.documentJob;
    this.documentJob = undefined; this.documentAborter = undefined; this.documentSetup = undefined;
  }
  async dispose(): Promise<boolean> {
    this.closed = true; await this.cancel(); await this.commands;
    return this.service ? this.service.stop() : true;
  }
}
