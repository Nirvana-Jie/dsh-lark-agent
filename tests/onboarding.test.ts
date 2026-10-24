import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile, stat, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ConnectionController, type OnboardingDependencies} from '../src/onboarding/controller.js';
import {ConnectionStore, connectionRecord, type ConnectionRecord} from '../src/onboarding/store.js';
import {createChallenge, matchesPairing, waitForPairing, type PairingTransport} from '../src/onboarding/pairing.js';
import {BOT_SCOPES, SETUP_SCOPES, CARD_SCOPE, LarkPlatformError, type Inspection, type RegisteredApp} from '../src/onboarding/lark-platform.js';
import {botLeaseDirectory, BotServiceStartError, type BotService} from '../src/bot-service.js';
import {LockHeldError} from '../src/lock.js';
import type {IncomingMessage} from '../src/message.js';
import type {ConnectionEndpoint, ConnectionPhase} from '../src/onboarding/protocol.js';
import {DOCUMENT_SCOPES, STREAMING_SCOPE} from '../src/rich-scopes.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const paths: string[] = [];
const controllers: ConnectionController[] = [];
const secret = 'fixture-app-secret-do-not-serialize';
const baseRecord: ConnectionRecord = {schema: 1, profile: 'test-bot', appId: 'cli_fixture', brand: 'feishu',
  botOpenId: 'ou_bot', creatorOpenId: 'ou_owner', ownerOpenId: 'ou_owner', ownerChatId: 'oc_owner',
  enabled: true, verified: true, publishAttempted: true, cards: false, loading: false};
const inspection = (patch: Partial<Inspection> = {}): Inspection => ({profile: 'test-bot', appId: 'cli_fixture', brand: 'feishu',
  botOpenId: 'ou_bot', creatorOpenId: 'ou_owner', grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES, CARD_SCOPE, 'im:message.reactions:write_only'],
  scopeStatus: 'verified', appStatus: 1, publicationStatus: 'approved', onlineVersionId: 'oav_live', problems: [], ...patch});
const incoming = (code = 'DSH-fixture', patch: Partial<IncomingMessage> = {}): IncomingMessage => ({
  messageId: 'om_pair', senderId: 'ou_owner', chatId: 'oc_owner', chatType: 'p2p', threadId: '', text: code, ...patch,
});
const raw = (content = 'DSH-fixture', patch: Record<string, unknown> = {}) => ({type: 'im.message.receive_v1',
  sender_type: 'user', sender_id: 'ou_owner', message_id: 'om_pair', chat_id: 'oc_owner', chat_type: 'p2p',
  message_type: 'text', content, ...patch});
async function directory() {const path = await mkdtemp(join(tmpdir(), 'dsh-onboarding-')); paths.push(path); return path;}
async function phase(controller: ConnectionController, expected: ConnectionPhase) {
  await vi.waitFor(() => expect(controller.snapshot().phase).toBe(expected), {timeout: 1500, interval: 5});
}
async function fixture(record?: ConnectionRecord) {
  const store = new ConnectionStore(await directory());
  if (record) await store.write(record);
  const service = {start: vi.fn(), ready: vi.fn(() => true), stop: vi.fn(async () => true)} satisfies BotService;
  const registered: RegisteredApp = {appId: 'cli_fixture', appSecret: secret, brand: 'feishu', creatorOpenId: 'ou_owner'};
  const platform = {
    listProfiles: vi.fn<OnboardingDependencies['platform']['listProfiles']>(async () => [{name: 'test-bot', appId: 'cli_fixture', brand: 'feishu', active: false}]),
    registerNew: vi.fn<OnboardingDependencies['platform']['registerNew']>(async request => {
      request.onQRCode({url: 'https://open.feishu.cn/page/cli?user_code=fixture', expireIn: 600}); return registered;
    }),
    saveNewProfile: vi.fn<OnboardingDependencies['platform']['saveNewProfile']>(async name => ({name, appId: 'cli_fixture', brand: 'feishu', active: false})),
    inspect: vi.fn<OnboardingDependencies['platform']['inspect']>(async () => inspection()),
    configureAndPublish: vi.fn<OnboardingDependencies['platform']['configureAndPublish']>(async () => ({versionId: 'oav_new', status: 'submitted'})),
  };
  const deps: OnboardingDependencies = {platform, store,
    checkRuntime: vi.fn(), start: vi.fn(async () => service), preflight: vi.fn(async () => undefined),
    pair: vi.fn(async input => incoming(input.challenge.code)), qr: vi.fn(async () => 'data:image/png;base64,fixture'),
    acknowledge: vi.fn(async () => undefined)};
  const controller = new ConnectionController(deps); controllers.push(controller);
  return {controller, deps, platform, store, service, registered};
}
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose().catch(() => undefined)));
  await Promise.all(paths.splice(0).map(path => rm(path, {recursive: true, force: true})));
  vi.useRealTimers();
});

describe('connection controller lifecycle', () => {
  it('upgrades document permissions in the existing connection and coalesces repeated clicks', async () => {
    const f = await fixture(baseRecord), gate = deferred<void>();
    const enableDocuments = vi.fn<NonNullable<OnboardingDependencies['platform']['enableDocuments']>>(async (_profile, qr) => {qr({url: 'https://open.feishu.cn/verify?code=fixture', expireIn: 300}); await gate.promise;});
    f.deps.platform.enableDocuments = enableDocuments;
    await f.controller.initialize(); await phase(f.controller, 'connected');
    await f.controller.command('enable-documents', {}); await f.controller.command('enable-documents', {});
    await vi.waitFor(() => expect(f.controller.snapshot().documentSetup?.phase).toBe('scanning'));
    expect(enableDocuments).toHaveBeenCalledOnce(); expect(f.controller.snapshot().phase).toBe('connected'); expect(f.service.stop).not.toHaveBeenCalled();
    gate.resolve(); await vi.waitFor(() => expect(f.controller.snapshot().capabilities.documents).toBe(true));
    expect(f.controller.snapshot().documentSetup).toBeUndefined(); expect(f.deps.pair).not.toHaveBeenCalled();
    await f.controller.command('enable-documents', {});
    expect(enableDocuments).toHaveBeenCalledOnce();
    expect(await f.store.read()).toMatchObject({ownerOpenId: 'ou_owner', enabled: true});
  });

  it('cancels only optional authorization and ignores late QR/results without stopping chat', async () => {
    const f = await fixture(baseRecord), gate = deferred<void>(), image = deferred<string>();
    f.deps.qr = () => image.promise;
    f.deps.platform.enableDocuments = vi.fn(async (_profile, qr, signal) => {qr({url: 'https://open.feishu.cn/verify', expireIn: 300}); signal.addEventListener('abort', () => gate.resolve()); await gate.promise;});
    await f.controller.initialize(); await phase(f.controller, 'connected');
    await f.controller.command('enable-documents', {}); await f.controller.command('cancel-documents', {});
    image.resolve('data:image/png;base64,YQ=='); await Promise.resolve();
    expect(f.controller.snapshot().documentSetup).toBeUndefined(); expect(f.controller.snapshot().capabilities.documents).toBe(false);
    expect(f.service.stop).not.toHaveBeenCalled(); expect(f.controller.snapshot().phase).toBe('connected');
  });

  it('starts one registration for repeated create commands', async () => {
    const h = await fixture();
    const registration = deferred<RegisteredApp>();
    h.platform.registerNew.mockImplementation(() => registration.promise);
    await h.controller.command('create', {cards: false, loading: false});
    await h.controller.command('create', {cards: true, loading: true});
    expect(h.platform.registerNew).toHaveBeenCalledOnce();
    registration.resolve(h.registered);
    await phase(h.controller, 'connected');
    expect(h.platform.saveNewProfile).toHaveBeenCalledOnce();
  });

  it('ignores late registration and QR results after cancellation without persisting a secret', async () => {
    const h = await fixture();
    const registration = deferred<RegisteredApp>(), qr = deferred<string>();
    h.platform.registerNew.mockImplementation(() => registration.promise);
    vi.mocked(h.deps.qr!).mockReturnValue(qr.promise);
    await h.controller.command('create', {});
    const request = h.platform.registerNew.mock.calls[0]![0];
    request.onQRCode({url: 'https://open.feishu.cn/page/cli?user_code=fixture', expireIn: 600});
    const cancelling = h.controller.command('cancel', {});
    await vi.waitFor(() => expect(request.signal?.aborted).toBe(true));
    request.onQRCode({url: 'https://open.feishu.cn/page/cli?user_code=late', expireIn: 600});
    qr.resolve('data:image/png;base64,late'); registration.resolve(h.registered);
    await cancelling;
    expect(h.controller.snapshot()).toMatchObject({phase: 'idle'});
    expect(h.controller.snapshot().qr).toBeUndefined();
    expect(h.platform.saveNewProfile).not.toHaveBeenCalled();
    expect(await h.store.read()).toBeUndefined();
  });

  it('keeps credentials out of snapshots and durable metadata throughout a successful flow', async () => {
    const h = await fixture();
    const writes = vi.spyOn(h.store, 'write');
    await h.controller.command('create', {cards: false, loading: false, appSecret: 'untrusted-secret'});
    await phase(h.controller, 'connected');
    expect(h.platform.saveNewProfile.mock.calls[0]?.[1]).toBe(h.registered);
    expect(JSON.stringify(h.controller.snapshot())).not.toContain(secret);
    expect(JSON.stringify(writes.mock.calls)).not.toContain(secret);
    const durable = await readFile(join(h.store.directory, 'connection.json'), 'utf8');
    expect(durable).not.toContain(secret); expect(durable).not.toContain('untrusted-secret');
    expect(await h.store.read()).toMatchObject({enabled: true, ownerOpenId: 'ou_owner', ownerChatId: 'oc_owner'});
    expect(h.deps.preflight).toHaveBeenCalled();
    expect(h.deps.acknowledge).toHaveBeenCalledOnce();
  });

  it('uses an already published SDK-created app without requesting repair permission or republishing', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES]}));
    h.platform.configureAndPublish.mockRejectedValue(new LarkPlatformError('MISSING_SCOPE'));
    await h.controller.command('create', {cards: false, loading: false});
    await phase(h.controller, 'connected');
    expect(h.platform.configureAndPublish).not.toHaveBeenCalled();
    expect(h.deps.pair).toHaveBeenCalledOnce();
    expect(h.deps.acknowledge).toHaveBeenCalledOnce();
    expect(await h.store.read()).toMatchObject({publishAttempted: true, verified: true, enabled: true});
  });

  it('enables available cards and loading for a newly selected profile using one read-only inspection', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({cardReady: true}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'connected');
    expect(await h.store.read()).toMatchObject({cards: true, loading: true});
    expect(vi.mocked(h.deps.start).mock.calls[0]![0]).toMatchObject({cardInteractions: true, loadingReaction: true});
    expect(h.platform.inspect).toHaveBeenCalledOnce();
    expect(h.platform.configureAndPublish).not.toHaveBeenCalled();
    expect(h.platform.registerNew).not.toHaveBeenCalled(); expect(h.platform.saveNewProfile).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('does not infer cards from permission alone when callback evidence is %s', async cardReady => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({cardReady}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'connected');
    expect(await h.store.read()).toMatchObject({cards: false, loading: true});
    expect(h.platform.configureAndPublish).not.toHaveBeenCalled();
  });

  it('enables menus only after the selected profile has verified menu delivery', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({menuReady: true, cardReady: false}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'connected');
    expect(vi.mocked(h.deps.start).mock.calls[0]![0]).toMatchObject({botMenu: true, cardInteractions: false});
    expect(h.platform.inspect).toHaveBeenCalledOnce();
    expect(h.platform.configureAndPublish).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('keeps menus disabled when inspection evidence is %s despite user-supplied flags', async menuReady => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({menuReady, cardReady: true}));
    await h.controller.command('use-profile', {name: 'test-bot', menuReady: true, botMenu: true});
    await phase(h.controller, 'connected');
    expect(vi.mocked(h.deps.start).mock.calls[0]![0]).toMatchObject({botMenu: false, cardInteractions: true});
  });

  it('rechecks menu availability when resuming instead of retaining a prior ready decision', async () => {
    const h = await fixture(baseRecord);
    h.platform.inspect.mockResolvedValueOnce(inspection({menuReady: true})).mockResolvedValue(inspection());
    await h.controller.initialize(); await phase(h.controller, 'connected');
    expect(vi.mocked(h.deps.start).mock.calls[0]![0].botMenu).toBe(true);
    await h.controller.command('pause', {}); await h.controller.command('resume', {});
    await phase(h.controller, 'connected');
    expect(vi.mocked(h.deps.start).mock.calls[1]![0].botMenu).toBe(false);
    expect(h.deps.pair).not.toHaveBeenCalled();
  });

  it('passes only the verified pairing identity to locked service startup for the first menu', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({menuReady: true}));
    vi.mocked(h.deps.pair!).mockImplementation(async input => incoming(input.challenge.code, {chatId: 'oc_real_pair'}));
    await h.controller.command('use-profile', {name: 'test-bot', ownerOpenId: 'ou_attacker', ownerChatId: 'oc_attacker',
      pairedChat: {openId: 'ou_attacker', chatId: 'oc_attacker'}});
    await phase(h.controller, 'connected');
    const startup = vi.mocked(h.deps.start).mock.calls[0]!;
    expect(startup[3]).toEqual({openId: 'ou_owner', chatId: 'oc_real_pair'});
    expect(startup[0].users[0]?.openId).toBe('ou_owner');
    expect(await h.store.read()).toMatchObject({ownerOpenId: 'ou_owner', ownerChatId: 'oc_real_pair'});
    // The controller cannot write the map outside the service's state/bot locks.
    // This fake service does not create a store, so no seed should exist yet.
    await expect(stat(join(startup[0].stateDir, 'direct-chats.json'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects a different pairing user before publishing a trusted private-chat seed', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({menuReady: true}));
    vi.mocked(h.deps.pair!).mockImplementation(async input => incoming(input.challenge.code, {senderId: 'ou_other', chatId: 'oc_other'}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'error');
    expect(h.deps.start).not.toHaveBeenCalled(); expect(h.deps.preflight).not.toHaveBeenCalled();
    expect((await h.store.read())?.ownerChatId).toBeUndefined();
  });

  it('does not enable a detected callback without its granted scope, or loading without its own grant', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({cardReady: true, grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES]}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'connected');
    expect(await h.store.read()).toMatchObject({cards: false, loading: false});
  });

  it('preserves saved feature choices when resuming or reselecting the same profile', async () => {
    const h = await fixture({...baseRecord, enabled: false});
    h.platform.inspect.mockResolvedValue(inspection({cardReady: true}));
    await h.controller.initialize();
    await h.controller.command('resume', {});
    await phase(h.controller, 'connected');
    expect(await h.store.read()).toMatchObject({cards: false, loading: false});
    await h.controller.command('pause', {});
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'connected');
    expect(await h.store.read()).toMatchObject({cards: false, loading: false});
  });

  it.each(BOT_SCOPES)('does not bypass the missing runtime grant %s just because the SDK app is published', async missing => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES].filter(scope => scope !== missing)}));
    h.platform.configureAndPublish.mockRejectedValue(new LarkPlatformError('MISSING_SCOPE'));
    await h.controller.command('create', {cards: false, loading: false});
    await phase(h.controller, 'action_required');
    expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.start).not.toHaveBeenCalled();
    expect((await h.store.read())?.enabled).toBe(false);
  });

  it('does not bypass a missing selected reaction grant on an already published app', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES]}));
    h.platform.configureAndPublish.mockRejectedValue(new LarkPlatformError('MISSING_SCOPE'));
    await h.controller.command('create', {cards: false, loading: true});
    await phase(h.controller, 'action_required');
    expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('does not skip missing card-consumer permission on an already published SDK app', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES]}));
    h.platform.configureAndPublish.mockRejectedValue(new LarkPlatformError('MISSING_SCOPE'));
    await h.controller.command('create', {cards: true, loading: false});
    await phase(h.controller, 'action_required');
    expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('refuses to resume an enabled card connection after the callback permission was revoked', async () => {
    const h = await fixture({...baseRecord, cards: true});
    h.platform.inspect.mockResolvedValue(inspection({grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES]}));
    await h.controller.initialize();
    await phase(h.controller, 'action_required');
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('does not treat a newly submitted SDK app still awaiting approval as already provisioned', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({publicationStatus: 'pending', pendingVersionId: 'oav_pending'}));
    h.platform.configureAndPublish.mockRejectedValue(new LarkPlatformError('APP_IN_REVIEW'));
    await h.controller.command('create', {cards: false, loading: false});
    await phase(h.controller, 'action_required');
    expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.start).not.toHaveBeenCalled();
    expect((await h.store.read())?.verified).toBe(false);
  });

  it.each(['pending', 'draft', 'rejected'] as const)('does not pair or start a %s application', async publicationStatus => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({publicationStatus}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'action_required');
    expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.start).not.toHaveBeenCalled();
    expect((await h.store.read())?.enabled).toBe(false);
  });

  it('does not pair or start when required message scopes are unverified', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({scopeStatus: 'unavailable', grantedScopes: []}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'action_required');
    expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.start).not.toHaveBeenCalled();
  });

  it.each([0, 2])('does not restore an explicitly disabled application with status %s', async appStatus => {
    const h = await fixture(baseRecord);
    h.platform.inspect.mockResolvedValue(inspection({appStatus}));
    await h.controller.initialize();
    await phase(h.controller, 'action_required');
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('rejects a profile that now resolves to another application', async () => {
    const h = await fixture({...baseRecord, enabled: false});
    await h.controller.initialize();
    h.platform.inspect.mockResolvedValue(inspection({appId: 'cli_other'}));
    await h.controller.command('resume', {});
    await phase(h.controller, 'error');
    expect(h.deps.start).not.toHaveBeenCalled();
    expect((await h.store.read())?.appId).toBe('cli_fixture');
  });

  it('revalidates identity after automatic configuration before pairing', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValueOnce(inspection({publicationStatus: 'draft'}))
      .mockResolvedValue(inspection({appId: 'cli_changed', botOpenId: 'ou_otherbot'}));
    await h.controller.command('create', {cards: false, loading: false});
    await phase(h.controller, 'error');
    expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('requires UI confirmation if no creator identity is available and consumes that confirmation once', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({creatorOpenId: undefined}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'confirming_owner');
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(h.deps.preflight).not.toHaveBeenCalled();
    expect((await h.store.read())?.ownerOpenId).toBeUndefined();
    expect((await h.store.read())?.ownerChatId).toBeUndefined();
    const id = h.controller.snapshot().confirmation!.id;
    await expect(h.controller.command('confirm-owner', {id: 'wrong-id'})).rejects.toThrow();
    await h.controller.command('confirm-owner', {id});
    await phase(h.controller, 'connected');
    await expect(h.controller.command('confirm-owner', {id})).rejects.toThrow();
    expect(h.deps.start).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.start).mock.calls[0]![3]).toEqual({openId: 'ou_owner', chatId: 'oc_owner'});
  });

  it('rejects an expired owner confirmation', async () => {
    const h = await fixture();
    h.platform.inspect.mockResolvedValue(inspection({creatorOpenId: undefined}));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'confirming_owner');
    const id = h.controller.snapshot().confirmation!.id;
    const originalNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(originalNow + 11 * 60_000);
    await expect(h.controller.command('confirm-owner', {id})).rejects.toThrow();
    now.mockRestore();
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('does not become ready after model preflight fails, including on a subsequent retry', async () => {
    const h = await fixture();
    h.deps.retryDelay = () => 5;
    vi.mocked(h.deps.preflight).mockRejectedValue(new Error('private-model-token'));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'error');
    expect(h.controller.snapshot().message).not.toContain('private-model-token');
    expect(h.deps.start).not.toHaveBeenCalled();
    // An unverified setup never retries on its own; only the owner's click repeats it.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.deps.preflight).toHaveBeenCalledOnce();
    await h.controller.command('recheck', {});
    await vi.waitFor(() => expect(h.deps.preflight).toHaveBeenCalledTimes(2));
    await phase(h.controller, 'error');
    expect(h.deps.start).not.toHaveBeenCalled();
    expect((await h.store.read())?.enabled).toBe(false);
  });

  it('remains starting until the acknowledgment is successfully sent', async () => {
    const h = await fixture();
    const acknowledgment = deferred<void>();
    vi.mocked(h.deps.acknowledge!).mockReturnValue(acknowledgment.promise);
    await h.controller.command('use-profile', {name: 'test-bot'});
    await vi.waitFor(() => expect(h.deps.acknowledge).toHaveBeenCalledOnce());
    expect(h.controller.snapshot().phase).toBe('starting');
    expect((await h.store.read())?.enabled).toBe(false);
    const health = vi.mocked(h.deps.start).mock.calls[0]![2];
    health(true);
    expect(h.controller.snapshot().phase).toBe('starting');
    acknowledgment.resolve();
    await phase(h.controller, 'connected');
    expect((await h.store.read())?.enabled).toBe(true);
  });

  it('does not overwrite a disconnected transport with connected when acknowledgment completes', async () => {
    const h = await fixture();
    const acknowledgment = deferred<void>();
    vi.mocked(h.deps.acknowledge!).mockReturnValue(acknowledgment.promise);
    await h.controller.command('use-profile', {name: 'test-bot'});
    await vi.waitFor(() => expect(h.deps.acknowledge).toHaveBeenCalledOnce());
    h.service.ready.mockReturnValue(false);
    vi.mocked(h.deps.start).mock.calls[0]![2](false);
    acknowledgment.resolve();
    await vi.waitFor(async () => expect((await h.store.read())?.verified).toBe(true));
    expect(h.controller.snapshot().phase).toBe('starting');
    h.service.ready.mockReturnValue(true);
    vi.mocked(h.deps.start).mock.calls[0]![2](true);
    await phase(h.controller, 'connected');
  });

  it('stops and stays disabled if sending the acknowledgment fails', async () => {
    const h = await fixture();
    vi.mocked(h.deps.acknowledge!).mockRejectedValue(new Error('private-transport-body'));
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'error');
    expect(h.service.stop).toHaveBeenCalledOnce();
    expect((await h.store.read())?.enabled).toBe(false);
    expect(JSON.stringify(h.controller.snapshot())).not.toContain('private-transport-body');
  });

  it('cannot promote an unverified receiver to connected after acknowledgment cleanup fails', async () => {
    const h = await fixture();
    vi.mocked(h.deps.acknowledge!).mockRejectedValue(new Error('ack failed'));
    h.service.stop.mockResolvedValue(false);
    await h.controller.command('use-profile', {name: 'test-bot'});
    await phase(h.controller, 'error');
    expect((await h.store.read())?.verified).toBe(false);
    await h.controller.command('recheck', {}).catch(() => undefined);
    expect(h.controller.snapshot().phase).not.toBe('connected');
    expect(h.deps.start).toHaveBeenCalledOnce();
  });

  it('keeps ownership of a receiver that cannot stop when startup is cancelled', async () => {
    const h = await fixture(baseRecord);
    const startup = deferred<BotService>();
    vi.mocked(h.deps.start).mockReturnValue(startup.promise);
    h.service.stop.mockResolvedValue(false);
    await h.controller.initialize();
    await vi.waitFor(() => expect(h.deps.start).toHaveBeenCalledOnce());
    const cancelling = h.controller.command('cancel', {});
    await vi.waitFor(() => expect(vi.mocked(h.deps.start).mock.calls[0]![1].aborted).toBe(true));
    startup.resolve(h.service);
    await expect(cancelling).rejects.toThrow();
    await expect(h.controller.command('create', {})).rejects.toThrow();
    expect(h.platform.registerNew).not.toHaveBeenCalled();
    expect(await h.controller.dispose()).toBe(false);
  });

  it('retains a receiver handed back by failed host startup and refuses replacement', async () => {
    const h = await fixture(baseRecord);
    h.service.stop.mockResolvedValue(false);
    vi.mocked(h.deps.start).mockRejectedValue(new BotServiceStartError(h.service));
    await h.controller.initialize();
    await phase(h.controller, 'error');
    await expect(h.controller.command('create', {})).rejects.toThrow();
    expect(h.platform.registerNew).not.toHaveBeenCalled();
    expect(await h.controller.dispose()).toBe(false);
  });

  it('automatically restores an enabled owner connection after restart without pairing again', async () => {
    const h = await fixture(baseRecord);
    await h.controller.initialize();
    await phase(h.controller, 'connected');
    expect(h.platform.inspect).toHaveBeenCalled();
    expect(h.deps.start).toHaveBeenCalledOnce();
    expect(h.deps.pair).not.toHaveBeenCalled();
    const config = vi.mocked(h.deps.start).mock.calls[0]![0];
    expect(config.users).toEqual([expect.objectContaining({openId: 'ou_owner', direct: true, groupChats: [], allowedTools: []})]);
    expect(config.botMenu).toBe(false);
    expect(vi.mocked(h.deps.start).mock.calls[0]![3]).toEqual({openId: 'ou_owner', chatId: 'oc_owner'});
  });

  it('keeps retrying a failed automatic restore until it connects, without a click or pairing', async () => {
    const h = await fixture(baseRecord);
    h.deps.retryDelay = () => 5;
    // Offline CLI at login, then unreadable grants, then a model blip during preflight.
    h.platform.inspect.mockRejectedValueOnce(new LarkPlatformError('COMMAND_FAILED'))
      .mockResolvedValueOnce(inspection({scopeStatus: 'unavailable', grantedScopes: [], problems: [{operation: 'scopes', code: 'COMMAND_FAILED'}]}));
    vi.mocked(h.deps.preflight).mockRejectedValueOnce(new Error('provider blip'));
    const phases = new Set<string>();
    const watch = setInterval(() => phases.add(h.controller.snapshot().phase), 1);
    try {
      await h.controller.initialize();
      await phase(h.controller, 'connected');
    } finally {clearInterval(watch);}
    expect(h.platform.inspect).toHaveBeenCalledTimes(4);
    expect(h.deps.preflight).toHaveBeenCalledTimes(2);
    expect(h.deps.start).toHaveBeenCalledOnce();
    expect(h.deps.pair).not.toHaveBeenCalled();
    expect(phases).toContain('error'); expect(phases).toContain('action_required');
    expect(await h.store.read()).toMatchObject({enabled: true, verified: true});
  });

  it('explains a bot held by another process and connects on its own once the lock frees', async () => {
    const h = await fixture(baseRecord);
    h.deps.retryDelay = () => 30;
    vi.mocked(h.deps.start).mockRejectedValueOnce(new LockHeldError('consumers', 4242)).mockRejectedValueOnce(new LockHeldError('running', 4242));
    const seen = new Set<string>();
    const watch = setInterval(() => seen.add(h.controller.snapshot().message), 1);
    try {
      await h.controller.initialize();
      await phase(h.controller, 'connected');
    } finally {clearInterval(watch);}
    expect([...seen].some(message => message.includes('Lark CLI 仍显示这个机器人有进程在接收消息') && message.includes('后台会自动重试'))).toBe(true);
    expect([...seen].some(message => message.includes('这个机器人正在另一个 dsh 实例中运行'))).toBe(true);
    expect(h.deps.start).toHaveBeenCalledTimes(3);
  });

  it('explains a retrying restore and stops retrying once the owner pauses', async () => {
    const h = await fixture(baseRecord);
    h.deps.retryDelay = () => 20;
    h.platform.inspect.mockResolvedValue(inspection({scopeStatus: 'unavailable', grantedScopes: [], problems: [{operation: 'scopes', code: 'TIMEOUT'}]}));
    await h.controller.initialize();
    await phase(h.controller, 'action_required');
    expect(h.controller.snapshot().message).toContain('暂时无法读取飞书应用权限');
    expect(h.controller.snapshot().message).toContain('后台会自动重试');
    await vi.waitFor(() => expect(h.platform.inspect.mock.calls.length).toBeGreaterThan(1), {timeout: 1500, interval: 5});
    await h.controller.command('pause', {});
    const attempts = h.platform.inspect.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(h.platform.inspect).toHaveBeenCalledTimes(attempts);
    expect(h.controller.snapshot().phase).toBe('paused');
    expect(h.deps.start).not.toHaveBeenCalled();
    expect((await h.store.read())?.enabled).toBe(false);
  });

  it('asks an app with documents but no streaming scope to complete its default permissions', async () => {
    const h = await fixture({...baseRecord, enabled: false});
    h.platform.inspect.mockResolvedValue(inspection({grantedScopes: [...BOT_SCOPES, ...DOCUMENT_SCOPES]}));
    await h.controller.initialize();
    await vi.waitFor(() => expect(h.platform.inspect).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.controller.snapshot().capabilities.documents).toBe(false);
  });

  it('refreshes default capabilities after a paused restart without starting or authorizing anything', async () => {
    const h = await fixture({...baseRecord, enabled: false});
    h.platform.inspect.mockResolvedValue(inspection({grantedScopes: [...BOT_SCOPES, ...DOCUMENT_SCOPES, STREAMING_SCOPE]}));
    await h.controller.initialize();
    await vi.waitFor(() => expect(h.controller.snapshot().capabilities.documents).toBe(true));
    expect(h.controller.snapshot().phase).toBe('paused');
    expect(h.deps.start).not.toHaveBeenCalled(); expect(h.platform.registerNew).not.toHaveBeenCalled();
    expect(await h.store.read()).toMatchObject({enabled: false, verified: true});
  });

  it('keeps a paused connection paused when capability metadata is temporarily unavailable', async () => {
    const h = await fixture({...baseRecord, enabled: false});
    h.platform.inspect.mockRejectedValue(new Error('temporarily offline'));
    await h.controller.initialize();
    await vi.waitFor(() => expect(h.platform.inspect).toHaveBeenCalledOnce());
    expect(h.controller.snapshot().phase).toBe('paused'); expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('does not cancel a live connection when an old view requests invalid pairing renewal', async () => {
    const h = await fixture(baseRecord);
    await h.controller.initialize(); await phase(h.controller, 'connected');
    const signal = vi.mocked(h.deps.start).mock.calls[0]![1];
    await expect(h.controller.command('renew-pairing', {})).rejects.toThrow();
    expect(signal.aborted).toBe(false);
    vi.mocked(h.deps.start).mock.calls[0]![2](false);
    expect(h.controller.snapshot().phase).toBe('starting');
  });

  it('rejects changed application identity during restart before starting a receiver, without retrying', async () => {
    const h = await fixture(baseRecord);
    h.deps.retryDelay = () => 5;
    h.platform.inspect.mockResolvedValue(inspection({appId: 'cli_changed'}));
    await h.controller.initialize();
    await phase(h.controller, 'error');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.platform.inspect).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().message).not.toContain('自动重试');
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  it('does not claim a pause or start a replacement receiver when stop cannot release its lease', async () => {
    const h = await fixture(baseRecord);
    await h.controller.initialize(); await phase(h.controller, 'connected');
    h.service.stop.mockResolvedValue(false);
    await expect(h.controller.command('pause', {})).rejects.toThrow();
    expect((await h.store.read())?.enabled).toBe(true);
    await expect(h.controller.command('create', {})).rejects.toThrow();
    expect(h.platform.registerNew).not.toHaveBeenCalled();
    expect(await h.controller.dispose()).toBe(false);
  });

  it('rejects unknown operations and malformed selection payloads without reflecting private input', async () => {
    const h = await fixture();
    await expect(h.controller.command('unexpected' as ConnectionEndpoint as 'create', {message: secret})).rejects.not.toThrow(secret);
    await expect(h.controller.command('use-profile', {name: `--profile ${secret}`})).rejects.not.toThrow(secret);
    expect(h.platform.registerNew).not.toHaveBeenCalled(); expect(h.platform.inspect).not.toHaveBeenCalled();
    expect(JSON.stringify(h.controller.snapshot())).not.toContain(secret);
  });
});

describe('connection store on real temporary filesystem', () => {
  it('writes only whitelisted metadata atomically with private modes', async () => {
    const store = new ConnectionStore(join(await directory(), 'private'));
    await store.write({...baseRecord, appSecret: secret, raw: {token: secret}} as ConnectionRecord);
    expect(await store.read()).toMatchObject(baseRecord);
    expect(await readFile(join(store.directory, 'connection.json'), 'utf8')).not.toContain(secret);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.directory, 'connection.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(store.directory)).toEqual(['connection.json']);
  });

  it.each([null, [], {}, {...baseRecord, schema: 2}, {...baseRecord, enabled: 'true'}, {...baseRecord, verified: false},
    {...baseRecord, profile: '../unsafe'}, {...baseRecord, appId: 'ou_wrong'},
    {...baseRecord, ownerOpenId: undefined}, {...baseRecord, ownerChatId: undefined}, {...baseRecord, botOpenId: undefined}])(
    'rejects invalid durable state instead of treating it as a new connection', async bad => {
      const store = new ConnectionStore(await directory());
      await writeFile(join(store.directory, 'connection.json'), JSON.stringify(bad));
      await expect(store.read()).rejects.toThrow();
    });

  it('fails closed on corrupt JSON and leaves the bytes untouched', async () => {
    const store = new ConnectionStore(await directory());
    const bytes = '{broken-state';
    await writeFile(join(store.directory, 'connection.json'), bytes);
    await expect(store.read()).rejects.toThrow();
    expect(await readFile(join(store.directory, 'connection.json'), 'utf8')).toBe(bytes);
  });

  it('returns absent only for an actually missing record', async () => {
    const store = new ConnectionStore(await directory());
    expect(await store.read()).toBeUndefined();
    await store.write(baseRecord);
    expect(connectionRecord(await store.read())).toMatchObject(baseRecord);
  });

  it('serializes successive updates without leaking the earlier enabled state', async () => {
    const store = new ConnectionStore(await directory());
    await Promise.all([store.write(baseRecord), store.write({...baseRecord, enabled: false})]);
    expect((await store.read())?.enabled).toBe(false);
  });
});

describe('pairing identity and receiver lease', () => {
  it('creates unpredictable, bounded-lived pairing capabilities', () => {
    const a = createChallenge(100), b = createChallenge(100);
    expect(a.code).toMatch(/^DSH-[a-zA-Z0-9_-]{16}$/);
    expect(a.code).not.toBe(b.code); expect(a.expiresAt).toBe(600100);
  });

  it('accepts only exact private text from the expected user before expiry', () => {
    const challenge = {code: 'DSH-fixture', expiresAt: 100};
    expect(matchesPairing(raw(), 'ou_bot', challenge, 'ou_owner', 99)?.senderId).toBe('ou_owner');
    for (const event of [raw('prefix DSH-fixture'), raw('DSH-fixture suffix'), raw('DSH-fixture\nextra'),
      raw('DSH-Fixture'), raw('DSH-fixture', {sender_id: 'ou_stranger'}), raw('DSH-fixture', {message_type: 'post'}),
      raw('DSH-fixture', {sender_type: 'app'}), raw('DSH-fixture', {sender_id: 'ou_bot'}),
      raw('DSH-fixture', {chat_type: 'group', mentions: [{id: 'ou_bot', key: '@bot', name: 'DSH'}]})]) {
      expect(matchesPairing(event, 'ou_bot', challenge, 'ou_owner', 99)).toBeUndefined();
    }
    expect(matchesPairing(raw(), 'ou_bot', challenge, 'ou_owner', 100)).toBeUndefined();
  });

  function transportFixture() {
    let event!: (raw: unknown) => void, error!: (error: Error) => void;
    const transport = {start: vi.fn(async (onEvent, onError) => {event = onEvent; error = onError;}),
      stop: vi.fn(async () => undefined)} satisfies PairingTransport;
    const release = vi.fn(async () => undefined), lease = vi.fn(async () => release);
    const controller = new AbortController();
    const challenge = {code: 'DSH-fixture', expiresAt: Date.now() + 60_000};
    const begin = () => waitForPairing({profile: 'test-bot', botOpenId: 'ou_bot', challenge,
      expectedOwner: 'ou_owner', signal: controller.signal, transport, lease});
    return {transport, release, lease, controller, challenge, begin, send: (value: unknown) => event(value),
      error: () => error(new Error('private transport diagnostic'))};
  }

  it('settles once, stops transport before releasing the receiver lease, and ignores other messages', async () => {
    const h = transportFixture();
    const order: string[] = [];
    h.transport.stop.mockImplementation(async () => {order.push('stop');});
    h.release.mockImplementation(async () => {order.push('release');});
    const pending = h.begin();
    await vi.waitFor(() => expect(h.transport.start).toHaveBeenCalledOnce());
    h.send(raw('wrong')); h.send(raw()); h.send(raw('DSH-fixture', {message_id: 'om_duplicate'}));
    expect((await pending).messageId).toBe('om_pair');
    expect(order).toEqual(['stop', 'release']);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('keeps the lease when receiver shutdown fails', async () => {
    const h = transportFixture();
    h.transport.stop.mockRejectedValue(new Error('stop failed'));
    const pending = h.begin();
    await vi.waitFor(() => expect(h.transport.start).toHaveBeenCalledOnce());
    h.send(raw());
    await expect(pending).rejects.toThrow();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('rejects cancellation and releases only after stopping the listener', async () => {
    const h = transportFixture();
    const pending = h.begin();
    await vi.waitFor(() => expect(h.transport.start).toHaveBeenCalledOnce());
    h.controller.abort();
    await expect(pending).rejects.toMatchObject({code: 'ABORTED'});
    expect(h.transport.stop).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  });

  it('rejects expired pairing without accepting a queued message', async () => {
    const h = transportFixture(); h.challenge.expiresAt = Date.now() - 1;
    await expect(h.begin()).rejects.toMatchObject({code: 'EXPIRED'});
    expect(h.transport.stop).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  });

  it('does not start another receiver when the bot lease is held', async () => {
    const h = transportFixture(); h.lease.mockRejectedValue(new Error('held'));
    await expect(h.begin()).rejects.toMatchObject({code: 'BUSY'});
    expect(h.transport.start).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('recovers a lease left by an exited process only when the bot CLI reports no consumers', async () => {
    const home = await directory(), previous = process.env.HOME;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.HOME = home;
    try {
      const lease = join(botLeaseDirectory('ou_bot'), 'instance.lock'), exited = spawnSync(process.execPath, ['-e', '']).pid!;
      const plant = async () => {
        await mkdir(lease, {recursive: true});
        await writeFile(join(lease, 'owner.json'), JSON.stringify({version: 1, pid: exited, identity: null, createdAt: Date.now(), token: randomUUID()}));
      };
      const cli = async (status: unknown) => {
        const path = join(home, `lark-cli-${randomUUID()}`);
        await writeFile(path, `#!/bin/sh\nprintf '%s' '${JSON.stringify(status)}'\n`, {mode: 0o700});
        return path;
      };
      const pair = (executable: string) => {
        let deliver!: (raw: unknown) => void;
        const transport = {start: vi.fn(async (onEvent: (raw: unknown) => void) => {deliver = onEvent;}), stop: vi.fn(async () => undefined)};
        const pending = waitForPairing({profile: 'test-bot', botOpenId: 'ou_bot', challenge: {code: 'DSH-fixture', expiresAt: Date.now() + 60_000},
          expectedOwner: 'ou_owner', signal: new AbortController().signal, transport, executable});
        return {transport, pending, send: () => deliver(raw())};
      };

      await plant();
      const busy = pair(await cli({apps: [{app_id: 'cli_fixture', status: 'running', running: true, active_consumers: 1, consumers: [{pid: 7}]}]}));
      await expect(busy.pending).rejects.toMatchObject({code: 'BUSY'});
      expect(busy.transport.start).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(join(lease, 'owner.json'), 'utf8')).pid).toBe(exited);

      const free = pair(await cli({apps: [{app_id: 'cli_fixture', status: 'not_running', running: false}]}));
      await vi.waitFor(() => expect(free.transport.start).toHaveBeenCalledOnce());
      expect(JSON.parse(await readFile(join(lease, 'owner.json'), 'utf8')).pid).toBe(process.pid);
      free.send();
      expect((await free.pending).messageId).toBe('om_pair');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exited process ${exited}`));
      await expect(stat(lease)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      process.env.HOME = previous;
      warn.mockRestore();
    }
  });
});
