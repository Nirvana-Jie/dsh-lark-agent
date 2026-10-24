import {describe, expect, it, vi} from 'vitest';
import {ConnectionApi, officialUrl, parseSnapshot} from '../src/client/api.js';
import type {ConnectionSnapshot} from '../src/onboarding/protocol.js';

const idle: ConnectionSnapshot = {phase: 'idle', message: '', busy: false, capabilities: {cards: true, loading: true}};

describe('owner connection API', () => {
  it('accepts a release notice made of plain version numbers only', () => {
    expect(parseSnapshot({...idle, update: {current: '0.2.0', latest: '0.3.0'}}).update).toEqual({current: '0.2.0', latest: '0.3.0'});
    expect(() => parseSnapshot({...idle, update: {current: '0.2.0', latest: '<b>0.3</b>'}})).toThrow();
    expect(() => parseSnapshot({...idle, update: {current: '0.2.0'}})).toThrow();
    expect(() => parseSnapshot({...idle, update: '0.3.0'})).toThrow();
  });
  it('accepts missing menu entries only with dsh event keys and an official console link', () => {
    const menu = {missing: [{label: '权限模式', eventKey: 'dsh.permission', parent: '设置'}], url: 'https://open.feishu.cn/app/cli_demo'};
    expect(parseSnapshot({...idle, menu}).menu).toEqual(menu);
    expect(() => parseSnapshot({...idle, menu: {...menu, url: 'https://example.com/app'}})).toThrow();
    expect(() => parseSnapshot({...idle, menu: {...menu, missing: [{label: 'x', eventKey: 'javascript:alert(1)'}]}})).toThrow();
    expect(() => parseSnapshot({...idle, menu: {...menu, missing: []}})).toThrow();
  });
  it('uses the host RPC and preserves caller cancellation', async () => {
    const call = vi.fn(async () => ({ok: true, value: idle}));
    const signal = new AbortController().signal;
    await expect(new ConnectionApi({call}).snapshot('create', {cards: true, loading: true}, signal)).resolves.toEqual(idle);
    expect(call).toHaveBeenCalledWith('/larkbot', 'create', {cards: true, loading: true}, signal);
  });

  it('uses the public owner-only API carrier on modern hosts without retrying mutations', async () => {
    const call = vi.fn(async () => ({ok: true, value: idle}));
    const signal = new AbortController().signal;
    await new ConnectionApi({call}, true).snapshot('create', {cards: true}, signal);
    expect(call).toHaveBeenCalledExactlyOnceWith('/api', 'larkbot/create', {cards: true}, signal);
  });

  it('does not expose transport details or arbitrary response fields', async () => {
    const api = new ConnectionApi({call: vi.fn().mockRejectedValue(new Error('secret=do-not-display /Users/private'))});
    await expect(api.snapshot('status', {}, new AbortController().signal)).rejects.toThrow('暂时无法连接助手服务');
    expect(parseSnapshot({...idle, secret: 'do-not-render'})).toEqual(idle);
  });

  it('shows vetted backend actions while refusing malformed or untrusted links', async () => {
    const api = new ConnectionApi({call: vi.fn().mockResolvedValue({ok: false, error: {code: 'internal', message: '请先选择可用模型', details: {}}})});
    await expect(api.snapshot('resume', {}, new AbortController().signal)).rejects.toThrow('请先选择可用模型');
    for (const url of ['javascript:alert(1)', 'http://open.feishu.cn', 'https://feishu.cn.attacker.test', 'https://fake@open.feishu.cn', 'https://open.feishu.cn:444']) {
      expect(() => officialUrl(url)).toThrow();
    }
    expect(officialUrl('https://applink.feishu.cn/client/bot/open?appId=cli_example')).toContain('applink.feishu.cn');
    expect(() => parseSnapshot({...idle, qr: {url: 'https://open.feishu.cn/app', image: 'data:image/svg+xml;base64,abc', expiresAt: 100}})).toThrow();
    expect(() => parseSnapshot({...idle, phase: 'made-up'})).toThrow();
  });
});
