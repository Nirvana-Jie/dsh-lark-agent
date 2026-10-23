import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_SCOPES, SETUP_SCOPES, CONFIGURE_SCOPE, CARD_SCOPE, LarkPlatform, LarkPlatformError,
  commandRunner, type AppRegistrar, type PlatformRunner, type RegisteredApp } from '../src/onboarding/lark-platform.js';
import {BOT_MENU_EVENT} from '../src/bot-menu.js';
import {DOCUMENT_SCOPES} from '../src/rich-scopes.js';

vi.mock('node:child_process', () => ({spawn: vi.fn()}));

const profile = {name: 'dsh-new-f07e9', appId: 'cli_test', brand: 'feishu' as const, active: false};
const registered: RegisteredApp = {appId: 'cli_test', appSecret: 'fixture-secret-never-print', brand: 'feishu', creatorOpenId: 'ou_creator'};
const ok = (data: unknown) => JSON.stringify({ok: true, identity: 'bot', data});

function platformFixture(options: {
  missingScope?: string; applicationError?: boolean; pending?: boolean; firstPublication?: boolean; rawApi?: boolean; botError?: boolean;
  cardDecision?: unknown; cardError?: boolean; menuDecision?: unknown; menuError?: boolean;
} = {}) {
  const run = vi.fn<PlatformRunner>(async args => {
    if (args[0] === 'profile') return JSON.stringify([profile]);
    const path = args[4];
    if (options.rawApi) return JSON.stringify({code: 0, data: {}});
    if (args[2] === 'event') {
      if (args[4] === BOT_MENU_EVENT) {
        if (options.menuError) throw new Error('secret raw menu-preflight hint');
        return JSON.stringify(options.menuDecision ?? {ok: true, identity: 'bot', dry_run: true,
          data: {decision: {event_key: BOT_MENU_EVENT, identity: 'bot', status: 'blocked', preconditions: []}}});
      }
      if (args[4] !== 'card.action.trigger') throw new Error('unexpected fake event');
      if (options.cardError) throw new Error('secret raw card-preflight hint');
      return JSON.stringify(options.cardDecision ?? {ok: true, identity: 'bot', dry_run: true,
        data: {decision: {event_key: 'card.action.trigger', identity: 'bot', status: 'blocked', preconditions: []}}});
    }
    if (path === '/open-apis/bot/v3/info') {
      if (options.botError) throw new Error('provider-secret must never reach browser');
      // The official CLI flattens the legacy OpenAPI bot object into envelope.data.
      return ok({open_id: 'ou_bot', app_name: 'test', ip_white_list: ['private-metadata']});
    }
    if (path === '/open-apis/application/v6/scopes') return ok({scopes: [...BOT_SCOPES, ...SETUP_SCOPES, CONFIGURE_SCOPE, CARD_SCOPE].map(scope => ({
      scope_name: scope, grant_status: scope === options.missingScope ? 2 : 1,
    }))});
    if (path === '/open-apis/application/v6/applications/cli_test') {
      if (options.applicationError) throw new LarkPlatformError('MISSING_SCOPE');
      return ok({app: {app_id: 'cli_test', status: 1, creator_id: 'ou_previous_owner',
        owner: {type: 2, owner_id: 'ou_creator'}, online_version_id: options.firstPublication ? '' : 'oav_online',
        unaudit_version_id: options.pending ? 'oav_pending' : '', redirect_urls: ['private-info']}});
    }
    if (path?.includes('/app_versions/')) {
      const version = path.slice(path.lastIndexOf('/') + 1);
      return ok({app_version: {app_id: 'cli_test', version_id: version, status: version === 'oav_pending' ? 3 : 1,
        events: ['im.message.receive_v1']}});
    }
    if (args[3] === 'PATCH') return ok({});
    if (args[3] === 'POST') return ok({version_id: '1000000000000000001'});
    throw new Error('unexpected fake command');
  });
  return {run, platform: new LarkPlatform({run})};
}

describe('Lark onboarding platform registration and profiles', () => {
  it('adds bot document scopes to the exact existing app, without storing or returning the new credential', async () => {
    const f = platformFixture();
    const original = f.run.getMockImplementation()!;
    let upgraded = false;
    f.run.mockImplementation(async (args, options) => upgraded && args[4] === '/open-apis/application/v6/scopes'
      ? ok({scopes: DOCUMENT_SCOPES.map(scope_name => ({scope_name, grant_status: 1}))}) : original(args, options));
    const registerApp = vi.fn<AppRegistrar>(async options => {options.onQRCodeReady({url: 'https://accounts.feishu.cn/verify?opaque=fixture', expireIn: 600}); upgraded = true; return {client_id: 'cli_test', client_secret: 'must-never-be-returned'};});
    const platform = new LarkPlatform({run: f.run, registerApp}), qr = vi.fn();
    expect(await platform.enableDocuments(profile.name, qr, new AbortController().signal)).toBeUndefined();
    expect(registerApp.mock.calls[0]![0]).toMatchObject({appId: 'cli_test', addons: {preset: false, scopes: {tenant: [...DOCUMENT_SCOPES]}}});
    expect(registerApp.mock.calls[0]![0].createOnly).not.toBe(true); expect(registerApp.mock.calls[0]![0].addons?.scopes?.user).toBeUndefined();
    expect(f.run.mock.calls.some(([args]) => args[0] === 'config')).toBe(false);
    await platform.enableDocuments(profile.name, qr, new AbortController().signal);
    expect(registerApp).toHaveBeenCalledOnce(); expect(qr).toHaveBeenCalledOnce();
    upgraded = false;
    registerApp.mockResolvedValue({client_id: 'cli_other', client_secret: 'private'});
    await expect(platform.enableDocuments(profile.name, qr, new AbortController().signal)).rejects.toMatchObject({code: 'APP_MISMATCH'});
  });
  it('returns only profile metadata from the CLI bare array without changing the active profile', async () => {
    const run = vi.fn<PlatformRunner>(async () => JSON.stringify([{...profile, user: 'private name', tokenStatus: 'ready', appSecret: 'never-serialize'}]));
    expect(await new LarkPlatform({run}).listProfiles()).toEqual([profile]);
    expect(run.mock.calls[0]?.[0]).toEqual(['profile', 'list']);
  });

  it('fails closed when profile inventory is malformed instead of treating it as empty', async () => {
    const run = vi.fn<PlatformRunner>(async () => JSON.stringify({ok: true, data: []}));
    await expect(new LarkPlatform({run}).saveNewProfile(profile.name, registered)).rejects.toMatchObject({code: 'INVALID_RESPONSE'});
    expect(run).toHaveBeenCalledOnce();
  });

  it('requests default document/board scopes in the first QR with explicitly selected callback/reaction features', async () => {
    const registerApp = vi.fn<AppRegistrar>(async options => {
      options.onQRCodeReady({url: 'https://accounts.feishu.cn/verify?opaque=a%2Fb', expireIn: 600});
      options.onStatusChange?.({status: 'polling', interval: 5});
      return {client_id: 'cli_test', client_secret: registered.appSecret, user_info: {open_id: 'ou_creator', tenant_brand: 'feishu'}};
    });
    const onQRCode = vi.fn(), onStatus = vi.fn(), signal = new AbortController().signal;
    const platform = new LarkPlatform({registerApp});
    expect(await platform.registerNew({name: 'dsh 助手', signal, onQRCode, onStatus})).toEqual(registered);
    const options = registerApp.mock.calls[0]![0];
    expect(options).toMatchObject({createOnly: true, signal, addons: {preset: false,
      scopes: {tenant: [...new Set([...BOT_SCOPES, ...SETUP_SCOPES, ...DOCUMENT_SCOPES])]}, events: {items: {tenant: ['im.message.receive_v1', BOT_MENU_EVENT]}}}});
    expect(options.addons?.scopes?.user).toBeUndefined();
    expect(options.addons?.scopes?.tenant).not.toContain(CONFIGURE_SCOPE);
    expect(options.addons?.scopes?.tenant).not.toContain(CARD_SCOPE);
    expect(options.addons?.callbacks).toBeUndefined();
    expect(onQRCode).toHaveBeenCalledWith({url: 'https://accounts.feishu.cn/verify?opaque=a%2Fb', expireIn: 600});
    expect(onStatus).toHaveBeenCalledWith({status: 'polling', interval: 5});
    await platform.registerNew({name: 'dsh 助手', cardInteractions: true, loadingReaction: true, onQRCode});
    const optional = registerApp.mock.calls[1]![0];
    expect(optional.addons?.scopes?.tenant).toContain('im:message.reactions:write_only');
    expect(optional.addons?.scopes?.tenant).toContain(CARD_SCOPE);
    expect(optional.addons?.callbacks).toEqual({items: ['card.action.trigger']});
    expect(optional.addons?.events).toEqual({items: {tenant: ['im.message.receive_v1', BOT_MENU_EVENT]}});
  });

  it('keeps creator optional and preserves the returned tenant brand', async () => {
    const registerApp = vi.fn<AppRegistrar>(async () => ({client_id: 'cli_test', client_secret: registered.appSecret,
      user_info: {tenant_brand: 'lark'}}));
    const result = await new LarkPlatform({registerApp}).registerNew({name: 'bot', onQRCode: vi.fn()});
    expect(result).toEqual({appId: 'cli_test', appSecret: registered.appSecret, brand: 'lark'});
  });

  it('accepts official developer-platform verification URLs without rewriting opaque parameters', async () => {
    const onQRCode = vi.fn();
    const url = 'https://open.feishu.cn/page/cli?user_code=fixture-code&addons=opaque%2Bvalue';
    const registerApp = vi.fn<AppRegistrar>(async options => {
      options.onQRCodeReady({url, expireIn: 600});
      return {client_id: 'cli_test', client_secret: registered.appSecret};
    });
    await new LarkPlatform({registerApp}).registerNew({name: 'bot', onQRCode});
    expect(onQRCode).toHaveBeenCalledWith({url, expireIn: 600});
  });

  it.each([['expired_token', 'REGISTRATION_EXPIRED'], ['access_denied', 'ACCESS_DENIED'], ['unknown', 'REGISTRATION_FAILED']])(
    'maps registration %s into a safe error', async (code, expected) => {
      const registerApp = vi.fn<AppRegistrar>(async () => { throw {code, description: registered.appSecret}; });
      const pending = new LarkPlatform({registerApp}).registerNew({name: 'bot', onQRCode: vi.fn()});
      await expect(pending).rejects.toMatchObject({code: expected});
      await expect(pending).rejects.not.toThrow(registered.appSecret);
    });

  it('does not forward untrusted registration URLs to the frontend', async () => {
    const onQRCode = vi.fn();
    const registerApp = vi.fn<AppRegistrar>(async options => {
      options.onQRCodeReady({url: 'https://accounts.feishu.cn.evil.test/?secret=x', expireIn: 30});
      return {client_id: 'cli_test', client_secret: registered.appSecret};
    });
    await expect(new LarkPlatform({registerApp}).registerNew({name: 'bot', onQRCode})).rejects.toMatchObject({code: 'INVALID_RESPONSE'});
    expect(onQRCode).not.toHaveBeenCalled();
  });

  it('writes a fresh profile with a secret only on stdin and verifies the resulting metadata', async () => {
    const signal = new AbortController().signal;
    const run = vi.fn<PlatformRunner>().mockResolvedValueOnce('[]')
      .mockResolvedValueOnce(JSON.stringify({appId: registered.appId, appSecret: '****', brand: 'feishu'}))
      .mockResolvedValueOnce(JSON.stringify([profile]));
    expect(await new LarkPlatform({run}).saveNewProfile(profile.name, registered, signal)).toEqual(profile);
    expect(run.mock.calls[1]).toEqual([['config', 'init', '--name', profile.name, '--app-id', 'cli_test',
      '--app-secret-stdin', '--brand', 'feishu'], {signal, stdin: registered.appSecret + '\n'}]);
    expect(run.mock.calls.flatMap(([args]) => args).join(' ')).not.toContain(registered.appSecret);
    expect(run.mock.calls.every(([, options]) => options.signal === signal)).toBe(true);
  });

  it('serializes profile saves and rejects a name that became occupied', async () => {
    let saved = false;
    const run = vi.fn<PlatformRunner>(async args => {
      if (args[0] === 'profile') return JSON.stringify(saved ? [profile] : []);
      saved = true;
      return JSON.stringify({appId: registered.appId, brand: 'feishu'});
    });
    const platform = new LarkPlatform({run});
    const first = platform.saveNewProfile(profile.name, registered);
    const second = platform.saveNewProfile(profile.name, registered);
    await expect(first).resolves.toEqual(profile);
    await expect(second).rejects.toMatchObject({code: 'PROFILE_EXISTS'});
    expect(run.mock.calls.filter(([args]) => args[0] === 'config')).toHaveLength(1);
  });

  it('never overwrites an existing name or a name colliding with an App ID', async () => {
    const {platform, run} = platformFixture();
    await expect(platform.saveNewProfile(profile.name, registered)).rejects.toMatchObject({code: 'PROFILE_EXISTS'});
    await expect(platform.saveNewProfile(profile.appId, registered)).rejects.toMatchObject({code: 'PROFILE_EXISTS'});
    expect(run.mock.calls.every(([args]) => args[0] === 'profile')).toBe(true);
  });
});

describe('Lark onboarding platform inspection and publication', () => {
  const readyDecision = (eventKey = 'card.action.trigger') => ({ok: true, identity: 'bot', dry_run: true, data: {decision: {
    event_key: eventKey, identity: 'bot', status: 'ready',
    preconditions: ['credentials_available', 'console_event_published', 'scopes_granted'].map(name => ({name, status: 'ok'})),
    hint: 'private diagnostic never exposed',
  }}});

  it('recognizes card readiness only from a complete read-only CLI decision', async () => {
    const {platform, run} = platformFixture({cardDecision: readyDecision()});
    const result = await platform.inspect(profile.name);
    expect(result.cardReady).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(run.mock.calls.some(([args]) => JSON.stringify(args) === JSON.stringify([
      '--profile', profile.name, 'event', 'consume', 'card.action.trigger', '--as', 'bot', '--dry-run',
    ]))).toBe(true);
    expect(run.mock.calls.some(([args]) => args[3] === 'PATCH' || args[3] === 'POST')).toBe(false);
  });

  it.each(['credentials_available', 'console_event_published', 'scopes_granted'])('does not infer cards if precondition %s is blocked', async name => {
    const decision = readyDecision();
    decision.data.decision.preconditions.find(item => item.name === name)!.status = 'blocked';
    const {platform} = platformFixture({cardDecision: decision});
    expect((await platform.inspect(profile.name)).cardReady).toBeUndefined();
  });

  it.each(['identity', 'dry_run', 'event_key', 'decision_identity', 'missing_check', 'blocked', 'unknown'])('rejects incomplete card readiness evidence: %s', async missing => {
    const decision = readyDecision();
    if (missing === 'identity') decision.identity = 'user';
    if (missing === 'dry_run') decision.dry_run = false;
    if (missing === 'event_key') decision.data.decision.event_key = 'im.message.receive_v1';
    if (missing === 'decision_identity') decision.data.decision.identity = 'user';
    if (missing === 'missing_check') decision.data.decision.preconditions.pop();
    if (missing === 'blocked' || missing === 'unknown') decision.data.decision.status = missing;
    const {platform} = platformFixture({cardDecision: decision});
    expect((await platform.inspect(profile.name)).cardReady).toBeUndefined();
  });

  it('safely degrades optional cards when preflight fails, preserving ordinary bot inspection', async () => {
    const {platform} = platformFixture({cardError: true});
    const result = await platform.inspect(profile.name);
    expect(result.cardReady).toBeUndefined(); expect(result.botOpenId).toBe('ou_bot');
    expect(result.scopeStatus).toBe('verified');
    expect(result.problems).toContainEqual({operation: 'cards', code: 'COMMAND_FAILED'});
    expect(JSON.stringify(result)).not.toContain('secret raw');
  });

  it('recognizes menu readiness independently from a complete read-only menu decision', async () => {
    const {platform, run} = platformFixture({menuDecision: readyDecision(BOT_MENU_EVENT)});
    const result = await platform.inspect(profile.name);
    expect(result.menuReady).toBe(true);
    expect(result.cardReady).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(run.mock.calls.some(([args]) => JSON.stringify(args) === JSON.stringify([
      '--profile', profile.name, 'event', 'consume', BOT_MENU_EVENT, '--as', 'bot', '--dry-run',
    ]))).toBe(true);
    expect(run.mock.calls.some(([args]) => args[3] === 'PATCH' || args[3] === 'POST')).toBe(false);
  });

  it('does not treat ready card evidence as proof that menu delivery is configured', async () => {
    const {platform} = platformFixture({cardDecision: readyDecision(), menuDecision: readyDecision()});
    const result = await platform.inspect(profile.name);
    expect(result.cardReady).toBe(true); expect(result.menuReady).toBeUndefined();
    expect(result.problems).toContainEqual({operation: 'menu', code: 'INVALID_RESPONSE'});
  });

  it.each(['credentials_available', 'console_event_published', 'scopes_granted'])(
    'requires the successful menu precondition %s', async name => {
      const decision = readyDecision(BOT_MENU_EVENT);
      decision.data.decision.preconditions.find(item => item.name === name)!.status = 'blocked';
      const {platform} = platformFixture({menuDecision: decision});
      expect((await platform.inspect(profile.name)).menuReady).toBeUndefined();
    });

  it.each(['identity', 'dry_run', 'event_key', 'decision_identity', 'missing_check', 'duplicate_check', 'blocked', 'unknown'])(
    'does not enable menus from incomplete readiness evidence: %s', async missing => {
      const decision = readyDecision(BOT_MENU_EVENT);
      if (missing === 'identity') decision.identity = 'user';
      if (missing === 'dry_run') decision.dry_run = false;
      if (missing === 'event_key') decision.data.decision.event_key = 'im.message.receive_v1';
      if (missing === 'decision_identity') decision.data.decision.identity = 'user';
      if (missing === 'missing_check') decision.data.decision.preconditions.pop();
      if (missing === 'duplicate_check') decision.data.decision.preconditions.push({...decision.data.decision.preconditions[0]!});
      if (missing === 'blocked' || missing === 'unknown') decision.data.decision.status = missing;
      const {platform} = platformFixture({menuDecision: decision});
      const result = await platform.inspect(profile.name);
      expect(result.menuReady).toBeUndefined();
      expect(result.botOpenId).toBe('ou_bot');
    });

  it('degrades a failed menu preflight without disabling independently verified cards', async () => {
    const {platform} = platformFixture({menuError: true, cardDecision: readyDecision()});
    const result = await platform.inspect(profile.name);
    expect(result.menuReady).toBeUndefined(); expect(result.cardReady).toBe(true);
    expect(result.botOpenId).toBe('ou_bot'); expect(result.scopeStatus).toBe('verified');
    expect(result.problems).toContainEqual({operation: 'menu', code: 'COMMAND_FAILED'});
    expect(JSON.stringify(result)).not.toContain('secret raw');
  });

  it('probes bot identity, grants and ownership using only the selected bot profile', async () => {
    const {platform, run} = platformFixture();
    const signal = new AbortController().signal;
    const result = await platform.inspect(profile.name, signal);
    expect(result).toEqual({profile: profile.name, appId: 'cli_test', brand: 'feishu', botOpenId: 'ou_bot',
      creatorOpenId: 'ou_creator', grantedScopes: [...BOT_SCOPES, ...SETUP_SCOPES, CONFIGURE_SCOPE, CARD_SCOPE], scopeStatus: 'verified', appStatus: 1,
      onlineVersionId: 'oav_online', publicationStatus: 'approved', subscribedEvents: ['im.message.receive_v1'], problems: []});
    expect(JSON.stringify(result)).not.toContain('private');
    for (const [args, options] of run.mock.calls.slice(1)) {
      expect(args.slice(0, 2)).toEqual(['--profile', profile.name]);
      expect(args).toContain('bot');
      expect(options.signal).toBe(signal);
    }
    const appCall = run.mock.calls.find(([args]) => args[4] === '/open-apis/application/v6/applications/cli_test')!;
    expect(appCall[0]).toContain(JSON.stringify({lang: 'zh_cn', user_id_type: 'open_id'}));
  });

  it('returns partial evidence and safe typed problems when application inspection is not granted', async () => {
    const {platform} = platformFixture({applicationError: true, botError: true});
    const result = await platform.inspect(profile.name);
    expect(result.grantedScopes).toEqual([...BOT_SCOPES, ...SETUP_SCOPES, CONFIGURE_SCOPE, CARD_SCOPE]);
    expect(result.publicationStatus).toBe('unknown');
    expect(result.problems).toEqual(expect.arrayContaining([
      {operation: 'application', code: 'MISSING_SCOPE'}, {operation: 'bot', code: 'COMMAND_FAILED'},
    ]));
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(result.creatorOpenId).toBeUndefined();
  });

  it('does not confuse a raw OpenAPI body with successful CLI transport', async () => {
    const {platform} = platformFixture({rawApi: true});
    const result = await platform.inspect(profile.name);
    expect(result.scopeStatus).toBe('unavailable');
    expect(result.botOpenId).toBeUndefined();
    expect(result.problems.every(p => p.code === 'INVALID_RESPONSE')).toBe(true);
  });

  it('configures selected websocket features and reports submission, never approval', async () => {
    const {platform, run} = platformFixture();
    const signal = new AbortController().signal;
    expect(await platform.configureAndPublish(profile.name, 'cli_test', {cardInteractions: true, signal}))
      .toEqual({versionId: '1000000000000000001', status: 'submitted'});
    const writes = run.mock.calls.filter(([args]) => args[3] === 'PATCH' || args[3] === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0]![0][4]).toBe('/open-apis/application/v7/applications/cli_test/config');
    expect(JSON.parse(writes[0]![1].stdin!)).toEqual({event: {subscription_type: 'websocket', add_events: ['im.message.receive_v1', BOT_MENU_EVENT]},
      callback: {callback_type: 'websocket', add_callbacks: ['card.action.trigger']}});
    expect(JSON.parse(writes[1]![1].stdin!)).toMatchObject({mobile_default_ability: 'bot', pc_default_ability: 'bot'});
    expect(writes.every(([, options]) => options.signal === signal)).toBe(true);
  });

  it('does not modify callback settings unless the feature was selected', async () => {
    const {platform, run} = platformFixture();
    await platform.configureAndPublish(profile.name, 'cli_test');
    const patch = run.mock.calls.find(([args]) => args[3] === 'PATCH')!;
    expect(JSON.parse(patch[1].stdin!)).not.toHaveProperty('callback');
    expect(JSON.parse(patch[1].stdin!)).toEqual({event: {subscription_type: 'websocket', add_events: ['im.message.receive_v1', BOT_MENU_EVENT]}});
  });

  it('does not publish after a failed config update or retry a result-unknown write', async () => {
    const {run} = platformFixture();
    const read = run.getMockImplementation()!;
    run.mockImplementation(async (args, options) => {
      if (args[3] === 'PATCH') throw new Error('secret raw platform failure');
      return read(args, options);
    });
    await expect(new LarkPlatform({run}).configureAndPublish(profile.name, 'cli_test')).rejects.toMatchObject({code: 'COMMAND_FAILED'});
    expect(run.mock.calls.filter(([args]) => args[3] === 'PATCH')).toHaveLength(1);
    expect(run.mock.calls.some(([args]) => args[3] === 'POST')).toBe(false);
  });

  it('does not publish when cancellation occurs after configuration', async () => {
    const {run} = platformFixture();
    const read = run.getMockImplementation()!;
    const controller = new AbortController();
    run.mockImplementation(async (args, options) => {
      if (args[3] === 'PATCH') { controller.abort(); return ok({}); }
      return read(args, options);
    });
    await expect(new LarkPlatform({run}).configureAndPublish(profile.name, 'cli_test', {signal: controller.signal}))
      .rejects.toMatchObject({code: 'ABORTED'});
    expect(run.mock.calls.some(([args]) => args[3] === 'POST')).toBe(false);
  });

  it('rejects a failed API envelope even if the command exits successfully', async () => {
    const {run} = platformFixture();
    const read = run.getMockImplementation()!;
    run.mockImplementation(async (args, options) => args[3] === 'POST'
      ? JSON.stringify({ok: false, error: {code: 210302, message: registered.appSecret}}) : read(args, options));
    await expect(new LarkPlatform({run}).configureAndPublish(profile.name, 'cli_test')).rejects.toMatchObject({code: 'APP_IN_REVIEW'});
  });

  it.each([...BOT_SCOPES, CONFIGURE_SCOPE])('never starts configuration without the required grant %s', async missingScope => {
    const {platform, run} = platformFixture({missingScope});
    await expect(platform.configureAndPublish(profile.name, 'cli_test')).rejects.toMatchObject({code: 'MISSING_SCOPE'});
    expect(run.mock.calls.some(([args]) => args[3] === 'PATCH' || args[3] === 'POST')).toBe(false);
  });

  it('does not incorrectly require self-inspection permission for the separately authorized repair API', async () => {
    const {platform, run} = platformFixture({missingScope: SETUP_SCOPES[0], applicationError: true});
    expect(await platform.configureAndPublish(profile.name, 'cli_test')).toEqual({versionId: '1000000000000000001', status: 'submitted'});
    expect(run.mock.calls.filter(([args]) => args[3] === 'PATCH')).toHaveLength(1);
  });

  it('requires the reaction grant only when loading feedback was selected', async () => {
    const {platform, run} = platformFixture();
    await expect(platform.configureAndPublish(profile.name, 'cli_test', {loadingReaction: true})).rejects.toMatchObject({code: 'MISSING_SCOPE'});
    expect(run.mock.calls.some(([args]) => args[3] === 'PATCH')).toBe(false);
  });

  it('requires the CLI callback grant only when card interactions were selected', async () => {
    const {platform, run} = platformFixture({missingScope: CARD_SCOPE});
    await expect(platform.configureAndPublish(profile.name, 'cli_test', {cardInteractions: true})).rejects.toMatchObject({code: 'MISSING_SCOPE'});
    expect(run.mock.calls.some(([args]) => args[3] === 'PATCH')).toBe(false);
    await expect(platform.configureAndPublish(profile.name, 'cli_test', {cardInteractions: false})).resolves.toMatchObject({status: 'submitted'});
  });

  it('does not change an application already under review', async () => {
    const {platform, run} = platformFixture({pending: true});
    await expect(platform.configureAndPublish(profile.name, 'cli_test')).rejects.toMatchObject({code: 'APP_IN_REVIEW'});
    expect(run.mock.calls.some(([args]) => args[3] === 'PATCH')).toBe(false);
  });

  it('keeps an approved online version usable while a later version awaits review', async () => {
    const {platform, run} = platformFixture({pending: true});
    expect(await platform.inspect(profile.name)).toMatchObject({onlineVersionId: 'oav_online', pendingVersionId: 'oav_pending', publicationStatus: 'approved'});
    expect(run.mock.calls.map(([args]) => args[4]).filter(path => path?.includes('/app_versions/')))
      .toEqual(['/open-apis/application/v6/applications/cli_test/app_versions/oav_online']);
  });

  it('judges a first publication with nothing online by its pending version', async () => {
    const {platform} = platformFixture({pending: true, firstPublication: true});
    const result = await platform.inspect(profile.name);
    expect(result).toMatchObject({pendingVersionId: 'oav_pending', publicationStatus: 'pending'});
    expect(result.onlineVersionId).toBeUndefined();
  });

  it('rejects profile and application identity mismatches before writing', async () => {
    const {platform, run} = platformFixture();
    await expect(platform.configureAndPublish(profile.name, 'cli_other')).rejects.toMatchObject({code: 'APP_MISMATCH'});
    expect(run.mock.calls.some(([args]) => args[3] === 'PATCH')).toBe(false);
  });

  it('aborts an inspection instead of returning partial success after cancellation', async () => {
    const controller = new AbortController();
    const run = vi.fn<PlatformRunner>(async args => {
      if (args[0] === 'profile') return JSON.stringify([profile]);
      controller.abort();
      throw new Error('private diagnostic');
    });
    await expect(new LarkPlatform({run}).inspect(profile.name, controller.signal)).rejects.toMatchObject({code: 'ABORTED'});
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
  close(code: number | null = 0) { this.emit('close', code, null); }
}

describe('bounded onboarding CLI transport', () => {
  let child: FakeChild;
  beforeEach(() => {
    child = new FakeChild();
    vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('uses argv, drains diagnostics privately and returns a decoded metadata result', async () => {
    const pending = new LarkPlatform().listProfiles();
    child.stdout.write(JSON.stringify([profile]));
    child.stderr.write('private diagnostic');
    child.close();
    expect(await pending).toEqual([profile]);
    expect(spawn).toHaveBeenCalledWith('lark-cli', ['profile', 'list'], expect.objectContaining({shell: false, stdio: 'pipe'}));
  });

  it('maps permission failures without reflecting stdout or stderr', async () => {
    const pending = new LarkPlatform().listProfiles();
    child.stderr.write(JSON.stringify({ok: false, error: {subtype: 'missing_scope', message: registered.appSecret}}));
    child.close(1);
    await expect(pending).rejects.toMatchObject({code: 'MISSING_SCOPE'});
    await expect(pending).rejects.not.toThrow(registered.appSecret);
  });

  it('honors cancellation and waits for the child to close', async () => {
    const controller = new AbortController();
    const pending = new LarkPlatform().listProfiles(controller.signal);
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(null);
    await expect(pending).rejects.toMatchObject({code: 'ABORTED'});
  });

  it('does not spawn a command for an already aborted request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new LarkPlatform().listProfiles(controller.signal)).rejects.toMatchObject({code: 'ABORTED'});
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds command duration and terminates a child that ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const pending = new LarkPlatform({commandTimeoutMs: 20}).listProfiles();
    const assertion = expect(pending).rejects.toMatchObject({code: 'TIMEOUT'});
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.close(null);
    await assertion;
  });

  it('bounds combined stdout and stderr before buffering another chunk', async () => {
    const pending = new LarkPlatform({maxOutputBytes: 128}).listProfiles();
    child.stdout.write('a'.repeat(80)); child.stderr.write('b'.repeat(80));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(null);
    await expect(pending).rejects.toMatchObject({code: 'OUTPUT_LIMIT'});
  });

  it('does not bypass CLI confirmation requirements', async () => {
    const pending = new LarkPlatform().listProfiles();
    child.close(10);
    await expect(pending).rejects.toMatchObject({code: 'CONFIRMATION_REQUIRED'});
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('keeps publisher work pending until a cancelled child closes, protecting the bot lease', async () => {
    vi.useFakeTimers();
    const aborter = new AbortController();
    const pending = commandRunner('lark-cli', 10_000, 1000, true)(['api', 'POST', '/fixture'], {signal: aborter.signal});
    let settled = false;
    const result = pending.catch(error => {settled = true; return error;});
    aborter.abort(); await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(settled).toBe(false);
    child.close(null); expect(await result).toMatchObject({code: 'ABORTED'});
  });
});
