import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {describe, expect, it, vi} from 'vitest';
import {acquireLock} from '../src/lock.js';
import {applyOnboarding, registerConnectionRpc} from '../src/onboarding/host.js';
import {ConnectionController, SetupError, officialDestination} from '../src/onboarding/controller.js';
import type {ConnectionResult} from '../src/onboarding/protocol.js';
import type {Release} from '../src/onboarding/updates.js';

type Handler = (endpoint: string, payload: unknown, signal: AbortSignal,
  peer?: {principal?: {kind?: string}}) => Promise<ConnectionResult<unknown>>;
const owner = {principal: {kind: 'owner'}};
function fixture(legacy = false) {
  let callback!: Handler;
  const remove = vi.fn(async () => undefined);
  const registered = vi.fn();
  const rpc = legacy ? {handle(channel: string, handler: Handler, options?: {authority: 'loopback'}) {
    callback = handler; registered(channel, options); return remove;
  }} : {handle(channel: string, handler: Handler) {callback = handler; registered(channel); return remove;}};
  const controller = {snapshot: vi.fn(() => ({phase: 'idle'})), profiles: vi.fn(async () => []),
    command: vi.fn(async () => ({phase: 'creating'}))};
  const cleanup = registerConnectionRpc(rpc, controller as unknown as ConnectionController);
  const signal = new AbortController().signal;
  return {controller, registered, remove, cleanup, signal,
    invoke: (endpoint: string, payload: unknown = {}, peer: Parameters<Handler>[3] = owner) => callback(endpoint, payload, signal, peer),
    noPeer: (endpoint: string, payload: unknown = {}) => callback(endpoint, payload, signal)};
}

describe('owner-only onboarding RPC', () => {
  it('accepts only a fixed input kind for the selected bot, never arbitrary scope names', async () => {
    const h = fixture(), id = 'a'.repeat(32);
    await h.invoke('enable-input', {kind: 'voice', connectionId: id});
    expect(h.controller.command).toHaveBeenCalledWith('enable-input', {kind: 'voice'}, id);
    h.controller.command.mockClear();
    for (const data of [{}, {kind: 'speech_to_text:speech'}, {kind: 'voice', scopes: 'drive:drive'}, {kind: 'voice', appId: 'cli_other'}]) {
      expect(await h.invoke('enable-input', data)).toMatchObject({ok: false});
    }
    expect(await h.invoke('enable-input', {kind: 'voice'}, {principal: {kind: 'guest'}})).toMatchObject({ok: false});
    expect(h.controller.command).not.toHaveBeenCalled();
  });
  it('scopes robot settings by an opaque ID without accepting identities, paths to config, or secrets', async () => {
    const h = fixture();
    const id = 'a'.repeat(32);
    const settings = {label: '研究助手', agentPreset: 'research', workspace: '/tmp/workspace', imageInput: true, voiceInput: false};
    await h.invoke('update-agent', {...settings, connectionId: id});
    expect(h.controller.command).toHaveBeenCalledWith('update-agent', settings, id);
    h.controller.command.mockClear();
    for (const payload of [{...settings, connectionId: '../escape'}, {...settings, configFile: '/tmp/private'},
      {...settings, ownerOpenId: 'ou_fake'}, {...settings, appSecret: 'PRIVATE'}, {...settings, voiceInput: 'true'}, {...settings, workspace: '../relative'}]) {
      expect(await h.invoke('update-agent', payload)).toMatchObject({ok: false});
    }
    expect(h.controller.command).not.toHaveBeenCalled();
  });
  it('requires an owner peer on the modern host, including for read-only state and profile metadata', async () => {
    const h = fixture();
    for (const endpoint of ['status', 'profiles', 'create']) {
      expect(await h.noPeer(endpoint)).toMatchObject({ok: false});
      expect(await h.invoke(endpoint, {}, {principal: {kind: 'guest'}})).toMatchObject({ok: false});
      expect(await h.invoke(endpoint, {}, {})).toMatchObject({ok: false});
    }
    expect(h.controller.snapshot).not.toHaveBeenCalled();
    expect(h.controller.profiles).not.toHaveBeenCalled(); expect(h.controller.command).not.toHaveBeenCalled();
  });

  it('registers the legacy handler with a loopback fence and rejects explicit non-owner peers', async () => {
    const h = fixture(true);
    expect(h.registered).toHaveBeenCalledWith('/larkbot', {authority: 'loopback'});
    expect(await h.noPeer('status')).toEqual({ok: true, value: {phase: 'idle'}});
    expect(await h.invoke('status', {}, {principal: {kind: 'remote'}})).toMatchObject({ok: false});
    expect(h.controller.snapshot).toHaveBeenCalledOnce();
    await h.cleanup(); expect(h.remove).toHaveBeenCalledOnce();
  });

  it('fails closed for an unrecognized RPC signature', () => {
    const rpc = {handle(_channel: string) {return async () => undefined;}};
    expect(() => registerConnectionRpc(rpc, {} as ConnectionController)).toThrow(SetupError);
  });

  it('passes only recognized commands with safe payloads and preserves profile request cancellation', async () => {
    const h = fixture();
    expect(await h.invoke('create', {cards: false, loading: true})).toMatchObject({ok: true});
    expect(h.controller.command).toHaveBeenCalledWith('create', {cards: false, loading: true});
    expect(await h.invoke('profiles')).toEqual({ok: true, value: []});
    expect(h.controller.profiles).toHaveBeenCalledWith(h.signal);
    expect(await h.invoke('status')).toEqual({ok: true, value: {phase: 'idle'}});
  });

  it.each([null, [], 'secret', 0, true, {appSecret: 'never-show'}, {ownerOpenId: 'ou_attacker'},
    {profile: 'unexpected'}, {cards: {nested: true}}, {cards: 'false'}, {loading: 'false'}])(
    'rejects malformed or overbroad create payloads before controller dispatch', async payload => {
      const h = fixture();
      expect(await h.invoke('create', payload)).toMatchObject({ok: false});
      expect(h.controller.command).not.toHaveBeenCalled();
    });

  it.each([['use-profile', {name: true}], ['confirm-owner', {id: false}],
    ['use-profile', {name: 'a'.repeat(201)}], ['pause', {name: 'unexpected'}],
    ['status', {token: 'private'}], ['profiles', {all: true}], ['unknown-secret-operation', {}], ['__proto__', {}]])(
    'rejects invalid endpoint or field types: %s', async (endpoint, payload) => {
      const h = fixture();
      const result = await h.invoke(endpoint, payload);
      expect(result).toMatchObject({ok: false, error: {details: {}}});
      expect(JSON.stringify(result)).not.toContain('unknown-secret');
      expect(h.controller.command).not.toHaveBeenCalled(); expect(h.controller.snapshot).not.toHaveBeenCalled();
      expect(h.controller.profiles).not.toHaveBeenCalled();
    });

  it('does not echo arbitrary errors or diagnostics into the public RPC result', async () => {
    const h = fixture();
    h.controller.command.mockRejectedValue(new Error('APP_SECRET=do-not-reflect'));
    const result = await h.invoke('pause');
    expect(result).toMatchObject({ok: false, error: {code: 'internal', details: {}}});
    expect(JSON.stringify(result)).not.toContain('APP_SECRET');
  });
});

describe('official registration destinations', () => {
  it('keeps an opaque official URL intact', () => {
    const url = 'https://open.feishu.cn/page/cli?user_code=fixture%2Bvalue&addons=a%2Fb';
    expect(officialDestination(url)).toBe(url);
  });
  it.each(['http://open.feishu.cn/x', 'https://open.feishu.cn.evil.test/x', 'https://evil.test/feishu.cn',
    'https://user:password@open.feishu.cn/x', 'javascript:alert(1)', 'https://open.feishu.cn:9999/x'])('rejects unsafe destination %s', url => {
      expect(() => officialDestination(url)).toThrow();
    });
});

describe('upgrade notice in the settings snapshot', () => {
  it('adds a newer published release to status and command results without waiting for npm', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-onboarding-update-'));
    try {
      let handler!: Handler;
      const effects: Array<() => () => Promise<void>> = [];
      const ctx = {
        get: (name: string) => name === 'connection' ? {rpc: {handle(_channel: string, callback: Handler) {handler = callback; return async () => undefined;}}} : undefined,
        effect: (factory: () => () => Promise<void>) => {effects.push(factory);},
      };
      let answer!: (value: Release) => void;
      const latestRelease = vi.fn(() => new Promise<Release | undefined>(resolve => {answer = resolve;}));
      await applyOnboarding(ctx as unknown as Context, {dataDir, executable: '/nonexistent/lark-cli', latestRelease});
      const signal = new AbortController().signal;
      const first = await handler('status', {}, signal, owner) as {ok: true; value: Record<string, unknown>};
      expect(first.value).toMatchObject({phase: 'idle'});
      expect(first.value).not.toHaveProperty('update');
      const installed = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string;
      answer({version: '999.0.0', publishedAt: 0});
      await vi.waitFor(async () => expect(await handler('status', {}, signal, owner)).toMatchObject({ok: true,
        value: {phase: 'idle', update: {current: installed, latest: '999.0.0'}}}));
      expect(await handler('cancel', {}, signal, owner)).toMatchObject({ok: true, value: {update: {latest: '999.0.0'}}});
      expect(latestRelease).toHaveBeenCalledOnce();
      await effects[0]!()();
    } finally {
      await rm(dataDir, {recursive: true, force: true});
    }
  });
});

describe('connection settings owned by another running host', () => {
  it('stays readable and inert instead of starting a second controller', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dsh-onboarding-host-'));
    // This live process holds the controller lock, exactly as another running host would.
    const held = await acquireLock(join(dataDir, 'controller'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let handler!: Handler;
      const remove = vi.fn(async () => undefined), effects: Array<() => () => Promise<void>> = [];
      const ctx = {
        get: (name: string) => name === 'connection' ? {rpc: {handle(_channel: string, callback: Handler) {handler = callback; return remove;}}} : undefined,
        effect: (factory: () => () => Promise<void>) => {effects.push(factory);},
      };
      await applyOnboarding(ctx as unknown as Context, {dataDir});
      const signal = new AbortController().signal;
      expect(await handler('status', {}, signal, owner)).toMatchObject({ok: true,
        value: {phase: 'error', busy: false, message: expect.stringContaining('另一个正在运行的 dsh 正在管理这个飞书连接')}});
      for (const endpoint of ['resume', 'create', 'profiles']) {
        expect(await handler(endpoint, {}, signal, owner)).toMatchObject({ok: false, error: {message: expect.stringContaining('请先关闭那个 dsh')}});
      }
      expect(await handler('status', {}, signal, {principal: {kind: 'guest'}})).toMatchObject({ok: false});
      expect(await readdir(dataDir)).toEqual(['controller']);
      await effects[0]!()();
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
      await held();
      await rm(dataDir, {recursive: true, force: true});
    }
  });
});
