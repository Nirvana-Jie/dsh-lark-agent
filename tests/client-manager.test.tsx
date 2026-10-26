import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {ManagerPanel} from '../src/client/ManagerPanel.js';
import {ConnectionApi, type ConnectionRpc} from '../src/client/api.js';
import type {AgentSettings, ConnectionSnapshot} from '../src/onboarding/protocol.js';

const second = 'a'.repeat(32);
const settings: AgentSettings = {label: '研究助手', agentPreset: 'research', workspace: '', imageInput: true, voiceInput: false};
const catalog = {presets: [{id: 'research', name: '研究', description: '阅读与整理资料', available: true}, {id: 'broken', name: '坏预设', available: false}],
  presetsAvailable: true, defaultPreset: 'standard', model: 'Host Model', imagesAvailable: true, voiceAvailable: true};
function fixture() {
  let saved = {...settings};
  const list = () => ({limit: 10, connections: [
    {id: 'default', label: '工作助手', phase: 'connected', busy: false, agentPreset: ''},
    {id: second, label: saved.label, phase: 'paused', busy: false, agentPreset: saved.agentPreset},
  ]});
  const state = (id: string): ConnectionSnapshot => ({phase: id === 'default' ? 'connected' : 'paused', busy: false, message: '',
    bot: {name: id === 'default' ? '工作助手' : saved.label, appId: 'cli_example', url: 'https://applink.feishu.cn/client/bot/open?appId=cli_example'},
    capabilities: {cards: true, loading: true, documents: true, images: true, voice: false},
    agent: {...(id === 'default' ? {...settings, label: '工作助手', agentPreset: ''} : saved), workspaceDisplay: '独立工作区', editable: id !== 'default'}});
  const call = vi.fn<ConnectionRpc['call']>(async (_channel, endpoint, payload) => {
    const data = payload as {connectionId?: string} & AgentSettings;
    if (endpoint === 'connections') return {ok: true, value: list()};
    if (endpoint === 'agent-catalog') return {ok: true, value: catalog};
    if (endpoint === 'add-connection') return {ok: true, value: {...list(), selectedId: second}};
    if (endpoint === 'update-agent') saved = {label: data.label, agentPreset: data.agentPreset, workspace: data.workspace, imageInput: data.imageInput, voiceInput: data.voiceInput};
    return {ok: true, value: state(data.connectionId ?? 'default')};
  });
  return {call, api: new ConnectionApi({call}), state};
}

describe('multi-agent management panel', () => {
  it('selects a robot by its server ID, scopes subsequent requests and saves only its settings', async () => {
    const f = fixture(); render(<ManagerPanel api={f.api} />);
    fireEvent.click(await screen.findByRole('button', {name: /研究助手/}));
    const name = await screen.findByRole('textbox', {name: '机器人名称'});
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('研究助手'));
    fireEvent.change(name, {target: {value: '资料助手'}});
    fireEvent.change(screen.getByLabelText('Agent 预设'), {target: {value: ''}});
    fireEvent.click(screen.getByRole('button', {name: '保存设置'}));
    await waitFor(() => expect(f.call.mock.calls.some(row => row[1] === 'update-agent')).toBe(true));
    expect(f.call.mock.calls.find(row => row[1] === 'update-agent')?.[2]).toEqual({...settings, label: '资料助手', agentPreset: '', connectionId: second});
    expect(await screen.findByRole('button', {name: /资料助手/})).toBeTruthy();
    expect(f.call.mock.calls.some(row => row[1] === 'pause' || row[1] === 'create')).toBe(false);
    expect(screen.getByRole('button', {name: /工作助手/})).toBeTruthy();
  });
  it('keeps running robot settings disabled and explains unavailable voice and preset choices', async () => {
    const f = fixture(); render(<ManagerPanel api={f.api} />);
    const name = await screen.findByLabelText('机器人名称');
    expect((name as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {name: /研究助手/}));
    await waitFor(() => expect((screen.getByLabelText('机器人名称') as HTMLInputElement).disabled).toBe(false));
    const voice = screen.getByRole('checkbox', {name: /语音转文字/});
    expect((voice as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('待开通飞书语音识别与文件读取权限')).toBeTruthy();
    expect(screen.getByRole('button', {name: '开通语音权限'})).toBeTruthy();
    expect((screen.getByRole('option', {name: /坏预设/}) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText('Host Model')).toBeTruthy();
  });
  it('authorizes only the selected robot and requires a separate saved voice choice after authorization', async () => {
    const f = fixture(), original = f.call.getMockImplementation()!;
    let granted = false;
    f.call.mockImplementation(async (channel, endpoint, payload, signal) => {
      if (endpoint === 'enable-input') granted = true;
      const response = await original(channel, endpoint, payload, signal) as {ok: true; value: unknown};
      if (['status', 'enable-input', 'update-agent'].includes(endpoint) && granted) {
        const state = response.value as ConnectionSnapshot; state.capabilities.voice = true;
      }
      return response;
    });
    render(<ManagerPanel api={f.api} />);
    fireEvent.click(await screen.findByRole('button', {name: /研究助手/}));
    await waitFor(() => expect((screen.getByLabelText('机器人名称') as HTMLInputElement).value).toBe('研究助手'));
    expect((screen.getByRole('checkbox', {name: '语音转文字'}) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {name: '开通语音权限'}));
    await waitFor(() => expect((screen.getByRole('checkbox', {name: '语音转文字'}) as HTMLInputElement).disabled).toBe(false));
    expect(f.call.mock.calls.find(row => row[1] === 'enable-input')?.[2]).toEqual({kind: 'voice', connectionId: second});
    expect((screen.getByRole('checkbox', {name: '语音转文字'}) as HTMLInputElement).checked).toBe(false);
    expect(f.call.mock.calls.some(row => row[1] === 'update-agent')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', {name: '语音转文字'}));
    fireEvent.click(screen.getByRole('button', {name: '保存设置'}));
    await waitFor(() => expect(f.call.mock.calls.find(row => row[1] === 'update-agent')?.[2]).toMatchObject({connectionId: second, voiceInput: true}));
  });
  it('filters the list without replacing the selected robot or disclosing profile credentials', async () => {
    const f = fixture(); render(<ManagerPanel api={f.api} />);
    await screen.findByRole('button', {name: /研究助手/});
    fireEvent.change(screen.getByRole('searchbox', {name: '搜索机器人'}), {target: {value: 'research'}});
    expect(screen.queryByRole('button', {name: /工作助手/})).toBeNull();
    expect(screen.getByRole('button', {name: /研究助手/})).toBeTruthy();
    expect(screen.getByRole('main', {name: '机器人详情'}).textContent).toContain('工作助手');
    expect(screen.queryByLabelText('App Secret')).toBeNull();
  });
  it('does not repeat an ambiguous addition and aborts reads when unmounted', async () => {
    const f = fixture(); let reject!: (error: Error) => void;
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation((channel, endpoint, payload, signal) => endpoint === 'add-connection'
      ? new Promise((_resolve, no) => {reject = no;}) : original(channel, endpoint, payload, signal));
    const view = render(<ManagerPanel api={f.api} />);
    const add = await screen.findByRole('button', {name: '＋ 添加机器人'});
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add); fireEvent.click(add);
    expect(f.call.mock.calls.filter(row => row[1] === 'add-connection')).toHaveLength(1);
    await act(async () => {reject(new Error('PRIVATE_TOKEN'));});
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('请先刷新列表'));
    expect(screen.getByRole('alert').textContent).not.toContain('PRIVATE_TOKEN');
    view.unmount();
  });
  it('keeps unsaved input after a rejected settings write', async () => {
    const f = fixture(); const original = f.call.getMockImplementation()!;
    f.call.mockImplementation((channel, endpoint, payload, signal) => endpoint === 'update-agent'
      ? Promise.resolve({ok: false, error: {code: 'internal', message: '这个预设已不可用', details: {}}}) : original(channel, endpoint, payload, signal));
    render(<ManagerPanel api={f.api} />);
    fireEvent.click(await screen.findByRole('button', {name: /研究助手/}));
    await waitFor(() => expect((screen.getByLabelText('机器人名称') as HTMLInputElement).value).toBe('研究助手'));
    fireEvent.change(screen.getByLabelText('机器人名称'), {target: {value: '保留草稿'}});
    fireEvent.click(screen.getByRole('button', {name: '保存设置'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('这个预设已不可用'));
    expect((screen.getByLabelText('机器人名称') as HTMLInputElement).value).toBe('保留草稿');
    expect(screen.getByText('有未保存的修改')).toBeTruthy();
  });
});
