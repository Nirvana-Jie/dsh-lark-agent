import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, onTestFinished, vi} from 'vitest';
import type {ConnectionSnapshot} from '../src/onboarding/protocol.js';
import {ConnectionApi, type ConnectionRpc} from '../src/client/api.js';
import {ConnectionCard} from '../src/client/ConnectionCard.js';
import {apply, type ClientContext} from '../src/client/index.js';

const snapshot = (phase: ConnectionSnapshot['phase'], extra: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot => ({
  phase, message: '', busy: false, capabilities: {cards: true, loading: true}, ...extra,
});
const bot = {name: '工作助手', appId: 'cli_example', url: 'https://applink.feishu.cn/client/bot/open?appId=cli_example'};
const result = (value: unknown) => ({ok: true, value});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return {promise, resolve}; }

describe('Feishu connection settings', () => {
  it('shows incremental authorization in the connected card and cancels it without disconnecting', async () => {
    const call = vi.fn<ConnectionRpc['call']>(async (_channel, endpoint) => result(snapshot('connected', {bot,
      ...(endpoint === 'enable-documents' ? {documentSetup: {phase: 'scanning', message: '扫码补充授权', qr: {url: 'https://open.feishu.cn/verify', image: 'data:image/png;base64,YQ==', expiresAt: Date.now() + 60000}}} : {})})));
    render(<ConnectionCard api={new ConnectionApi({call})} />);
    fireEvent.click(await screen.findByRole('button', {name: '补充默认权限'}));
    expect(await screen.findByAltText('默认权限补充授权二维码')).toBeTruthy();
    expect(screen.getByRole('heading', {name: '可以在飞书找我了'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '返回聊天连接'}));
    await waitFor(() => expect(call.mock.calls.some(call => call[1] === 'cancel-documents')).toBe(true));
    expect(call.mock.calls.some(call => ['disconnect', 'pause', 'create'].includes(call[1]))).toBe(false);
  });
  it('requires a deliberate owner confirmation and prevents duplicate mutation requests', async () => {
    const pending = deferred<unknown>();
    const call = vi.fn<ConnectionRpc['call']>(async (_channel, endpoint) => endpoint === 'confirm-owner'
      ? pending.promise
      : result(snapshot('confirming_owner', {confirmation: {id: 'one-time-confirmation', label: '小林'}, bot})));
    render(<ConnectionCard api={new ConnectionApi({call})} />);
    const confirm = await screen.findByRole('button', {name: '这是我，完成连接'});
    expect(call.mock.calls.filter(call => call[1] === 'confirm-owner')).toHaveLength(0);
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(call.mock.calls.filter(call => call[1] === 'confirm-owner')).toHaveLength(1);
    expect(call.mock.calls.find(call => call[1] === 'confirm-owner')?.[2]).toEqual({id: 'one-time-confirmation'});
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending.resolve(result(snapshot('connected', {bot}))); });
    expect(screen.getByRole('heading', {name: '可以在飞书找我了'})).toBeTruthy();
    expect(screen.getByText('已确认本人 · 私聊已就绪')).toBeTruthy();
    expect(screen.queryByText('cli_example')).toBeNull();
  });

  it('keeps approvals incomplete and offers the actual official action', async () => {
    const call = vi.fn<ConnectionRpc['call']>(async () => result(snapshot('action_required', {message: '请等待企业管理员批准', action: {label: '打开飞书管理后台', url: 'https://open.feishu.cn/app'}})));
    render(<ConnectionCard api={new ConnectionApi({call})} />);
    expect(await screen.findByText('请等待企业管理员批准')).toBeTruthy();
    expect(screen.queryByRole('heading', {name: '可以在飞书找我了'})).toBeNull();
    expect(screen.getByRole('link', {name: /打开飞书管理后台/}).getAttribute('href')).toBe('https://open.feishu.cn/app');
    fireEvent.click(screen.getByRole('button', {name: '重新检查'}));
    await waitFor(() => expect(call.mock.calls.some(call => call[1] === 'recheck')).toBe(true));
  });

  it('refreshes expired authorization and pairing instead of claiming completion', async () => {
    const call = vi.fn<ConnectionRpc['call']>(async (_channel, endpoint) => result(endpoint === 'create'
      ? snapshot('pairing', {bot, pairing: {code: 'DSH-one-time', expiresAt: 1}})
      : snapshot('waiting_scan', {qr: {url: 'https://open.feishu.cn/app', image: 'data:image/png;base64,YQ==', expiresAt: 1}})));
    render(<ConnectionCard api={new ConnectionApi({call})} />);
    fireEvent.click(await screen.findByRole('button', {name: '刷新二维码'}));
    const copy = await screen.findByRole('button', {name: '复制配对词'});
    expect((copy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {name: '换一个配对词'}));
    await waitFor(() => expect(call.mock.calls.some(call => call[1] === 'renew-pairing')).toBe(true));
    expect(call.mock.calls.some(call => call[1] === 'confirm-owner')).toBe(false);
  });

  it('reuses an existing robot by its opaque name without asking for secrets', async () => {
    const call = vi.fn<ConnectionRpc['call']>(async (_channel, endpoint) => result(endpoint === 'profiles'
      ? [{name: 'private-profile', appId: 'cli_example', label: '我的工作助手'}]
      : endpoint === 'use-profile' ? snapshot('pairing', {bot, pairing: {code: 'DSH-test', expiresAt: Date.now() + 60000}}) : snapshot('idle')));
    render(<ConnectionCard api={new ConnectionApi({call})} />);
    fireEvent.click(await screen.findByRole('button', {name: /我已有机器人/}));
    expect(await screen.findByRole('radio', {name: '我的工作助手'})).toBeTruthy();
    expect(screen.queryByText('private-profile')).toBeNull();
    expect(screen.queryByLabelText('App Secret')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '连接这个机器人'}));
    await screen.findByRole('heading', {name: '去飞书跟我打个招呼'});
    expect(call.mock.calls.find(call => call[1] === 'use-profile')?.[2]).toEqual({name: 'private-profile'});
  });

  it('does not let an earlier status response overwrite a mutation result', async () => {
    vi.useFakeTimers();
    const oldStatus = deferred<unknown>();
    let reads = 0;
    const call = vi.fn<ConnectionRpc['call']>(async (_channel, endpoint) => {
      if (endpoint === 'status') return ++reads === 1 ? result(snapshot('idle')) : oldStatus.promise;
      return result(snapshot('creating', {busy: true}));
    });
    render(<ConnectionCard api={new ConnectionApi({call})} />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(5000); });
    fireEvent.click(screen.getByRole('button', {name: /扫码创建并连接/}));
    await act(async () => {});
    await act(async () => { oldStatus.resolve(result(snapshot('idle'))); });
    expect(screen.getByRole('heading', {name: '正在准备扫码入口'})).toBeTruthy();
  });

  it('aborts in-flight RPCs and stops polling on unmount', async () => {
    vi.useFakeTimers();
    const read = deferred<unknown>();
    const call = vi.fn<ConnectionRpc['call']>(() => read.promise);
    const view = render(<ConnectionCard api={new ConnectionApi({call})} />);
    const signal = call.mock.calls[0]?.[3];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { read.resolve(result(snapshot('idle'))); vi.advanceTimersByTime(60000); });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('marks every step done once connected or paused', async () => {
    for (const phase of ['connected', 'paused'] as const) {
      const call = vi.fn<ConnectionRpc['call']>(async () => result(snapshot(phase, {bot})));
      const {unmount} = render(<ConnectionCard api={new ConnectionApi({call})} />);
      const steps = await screen.findByRole('list', {name: '连接进度'});
      expect(steps.querySelectorAll('li.done')).toHaveLength(3);
      expect(steps.querySelector('[aria-current]')).toBeNull();
      unmount();
    }
  });
  it('tells the owner which menu entry to add in the developer console', async () => {
    const menu = {missing: [{label: '权限模式', eventKey: 'dsh.permission', parent: '设置'}], url: 'https://open.feishu.cn/app/cli_demo'};
    for (const [phase, last] of [['connected', '回到这里点「暂停连接」，再点「恢复连接」。'], ['paused', '回到这里点「恢复连接」。']] as const) {
      const call = vi.fn<ConnectionRpc['call']>(async () => result(snapshot(phase, {bot, menu})));
      const {unmount} = render(<ConnectionCard api={new ConnectionApi({call})} />);
      expect(await screen.findByText('飞书底部菜单缺少入口')).toBeTruthy();
      expect(screen.getByText('设置 → 权限模式（事件标识 dsh.permission）')).toBeTruthy();
      expect(screen.getByText(last)).toBeTruthy();
      expect(screen.getByRole('link', {name: /打开飞书后台/}).getAttribute('href')).toBe(menu.url);
      unmount();
    }
  });
  it('offers a newer release with the App reinstall steps and opens its plugin list', async () => {
    const call = vi.fn<ConnectionRpc['call']>(async () => result(snapshot('connected', {bot, update: {current: '0.2.0', latest: '0.3.0'}})));
    const openPlugins = vi.fn(() => true);
    render(<ConnectionCard api={new ConnectionApi({call})} host={{app: true, openPlugins}} />);
    expect(await screen.findByText('飞书插件有新版本 0.3.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '升级'}));
    expect(screen.getByText('先点下方「暂停连接」。')).toBeTruthy();
    expect(screen.getByText(/在「插件列表」卸载 dsh-lark-agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '打开插件列表'}));
    expect(openPlugins).toHaveBeenCalledOnce();
    // Without the App's navigation the notice points at the tab instead.
    openPlugins.mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', {name: '打开插件列表'}));
    expect(screen.getByText('请切到上方的「插件列表」继续。')).toBeTruthy();
    expect(call.mock.calls.every(call => call[1] === 'status')).toBe(true);
  });
  it('gives the Web host its update command to copy', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
    try {
      const call = vi.fn<ConnectionRpc['call']>(async () => result(snapshot('paused', {bot, update: {current: '0.2.0', latest: '0.3.0'}})));
      render(<ConnectionCard api={new ConnectionApi({call})} host={{app: false}} />);
      fireEvent.click(await screen.findByRole('button', {name: '升级'}));
      expect(screen.getByText('连接已暂停，可以直接升级。')).toBeTruthy();
      expect(screen.getByText('dsh plugin --profile web update dsh-lark-agent@latest')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', {name: '复制升级命令'}));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('dsh plugin --profile web update dsh-lark-agent@latest'));
      expect(await screen.findByText('已复制升级命令')).toBeTruthy();
    } finally { Reflect.deleteProperty(navigator, 'clipboard'); }
  });
  it('shows no notice when the installed version is current', async () => {
    const call = vi.fn<ConnectionRpc['call']>(async () => result(snapshot('connected', {bot})));
    render(<ConnectionCard api={new ConnectionApi({call})} host={{app: true}} />);
    await screen.findByRole('heading', {name: '可以在飞书找我了'});
    expect(screen.queryByText(/飞书插件有新版本/)).toBeNull();
  });
  it('lets the App tab open the plugin list only through the host service', () => {
    const register = vi.fn<ClientContext['slots']['register']>(() => () => undefined);
    const openList = vi.fn();
    let navigation: unknown = {openList};
    const cleanups: Array<() => void> = [];
    const ctx: ClientContext = {
      effect(factory) { const off = factory(); if (off) cleanups.push(off); },
      connection: {rpc: {call: vi.fn()}, generation: {getSnapshot: () => 1}},
      slots: {inject: (_name, factory) => { cleanups.push(factory()); }, register},
      get: name => name === 'pluginNavigation' ? navigation : undefined,
    };
    apply(ctx);
    onTestFinished(() => { for (const off of cleanups.reverse()) off(); });
    const props = register.mock.calls[0]![0].inject();
    expect(props.host?.app).toBe(true);
    expect(props.host?.openPlugins?.()).toBe(true);
    expect(openList).toHaveBeenCalledOnce();
    // Older hosts lack the service; a failing one is treated the same way.
    navigation = undefined;
    expect(props.host?.openPlugins?.()).toBe(false);
    navigation = {openList: () => { throw new Error('closed'); }};
    expect(props.host?.openPlugins?.()).toBe(false);
  });
  it('registers a disposable settings tab through the public host slot', () => {
    const dispose = vi.fn();
    const register = vi.fn<ClientContext['slots']['register']>(() => dispose);
    const effects: Array<() => void> = [];
    const ctx: ClientContext = {
      effect(factory) { const off = factory(); if (off) effects.push(off); },
      connection: {rpc: {call: vi.fn()}},
      slots: {inject: (_name, factory) => { effects.push(factory()); }, register},
    };
    apply(ctx);
    expect(register.mock.calls[0]?.[0]).toMatchObject({name: 'settings.plugins.tab', id: 'dsh-larkbot'});
    expect(document.querySelector('style[data-plugin="dsh-larkbot"]')).toBeTruthy();
    for (const off of effects.reverse()) off();
    expect(dispose).toHaveBeenCalledOnce();
    expect(document.querySelector('style[data-plugin="dsh-larkbot"]')).toBeNull();
  });
});
