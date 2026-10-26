import {describe, expect, it} from 'vitest';
import {renderPanel} from '../src/replies.js';
import {sessionControlPanel, sessionPage, sessionQuery, sessionViewCommand, sessionViewCommandParse, type SessionChoice} from '../src/session-controls.js';

const sessions: SessionChoice[] = Array.from({length: 1000}, (_, index) => ({id: index.toString(16).padStart(12, '0'),
  nativeId: '11111111-1111-4111-8111-111111111111', title: index === 0 ? 'Faraway NEEDLE' : `Topic ${index}`,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 + index}));
const action = (label: string, command: string) => ({label, value: {token: command}});

describe('history session selector', () => {
  it('pages all 1000 sessions in recent-activity order and bounds stale pages', () => {
    expect(sessionPage(sessions, {page: 0, query: ''})).toMatchObject({pages: 50, total: 1000, items: expect.arrayContaining([sessions[999]])});
    const last = sessionPage(sessions, {page: 98, query: ''});
    expect(last.view.page).toBe(49); expect(last.items).toHaveLength(20);
    expect(last.items.at(-1)?.id).toBe(sessions[0]!.id);
  });

  it('searches the full catalog before paging, ignoring case and Unicode composition', () => {
    expect(sessionPage(sessions, {page: 40, query: 'needle'})).toMatchObject({items: [sessions[0]], total: 1, pages: 1, view: {page: 0}});
    expect(sessionPage([{...sessions[0]!, title: 'Café'}], {page: 0, query: 'Cafe\u0301'}).total).toBe(1);
  });

  it('keeps a large catalog compact, with a dropdown, search, paging and one selected detail', () => {
    const panel = sessionControlPanel(sessions, sessions[999]!.id, action);
    expect(panel.select?.options).toHaveLength(20);
    expect(panel.sections).toHaveLength(1);
    expect(panel.actions?.map(item => item.label)).toEqual(['下一页', '新建话题']);
    expect(panel.note).toContain('1 / 50');
    const payload = renderPanel(panel);
    expect(payload.kind).toBe('card');
    if (payload.kind !== 'card') throw new Error('Expected card');
    const body = payload.card.body as {elements: Record<string, unknown>[]};
    expect(body.elements.filter(item => item.tag === 'select_static')).toMatchObject([{name: 'dsh_session_picker', width: 'fill', initial_option: sessions[999]!.id}]);
    expect(body.elements.filter(item => item.tag === 'form')).toMatchObject([{name: 'dsh_sessions_search_form', elements: [
      {tag: 'column_set', flex_mode: 'none', columns: [
        {elements: [{tag: 'input', name: 'query', max_length: 80}]},
        {elements: [{tag: 'button', name: 'dsh_sessions_search', form_action_type: 'submit'}]},
      ]},
    ]}]);
    expect(Buffer.byteLength(JSON.stringify(payload.card))).toBeLessThan(24_000);
    expect(payload.fallbackText).toContain(`/resume ${sessions[999]!.id}`);
    expect(payload.fallbackText).not.toContain(sessions[999]!.nativeId);
  });

  it('distinguishes duplicate truncated titles and preserves literal text in options', () => {
    const first = {...sessions[0]!, title: '相同标题'.repeat(20)};
    const second = {...sessions[1]!, title: first.title};
    const panel = sessionControlPanel([first, second], undefined, action);
    expect(panel.select?.options[0]?.label).toContain(second.id.slice(-4));
    expect(panel.select?.options[1]?.label).toContain(first.id.slice(-4));
    expect(panel.select?.options[0]?.label).not.toBe(panel.select?.options[1]?.label);
    expect(panel.select?.options.every(item => item.label.length < 70)).toBe(true);
  });

  it('retains the real thread URL and shows an honest fallback if no link is available', () => {
    const link = 'https://applink.feishu.cn/client/thread/open?chatId=oc_test&threadId=omt_test';
    const selected = {...sessions[0]!, link};
    const panel = sessionControlPanel([selected], undefined, action, {selectedId: selected.id});
    expect(JSON.stringify(renderPanel(panel))).toContain(link);
    const fallback = sessionControlPanel([sessions[0]!], undefined, action, {selectedId: sessions[0]!.id});
    expect(fallback.sections[0]?.text).toContain('找到对应话题');
  });

  it('keeps search and new-topic controls when no results match or the catalog is empty', () => {
    const none = sessionControlPanel(sessions, undefined, action, {view: {page: 0, query: 'missing'}});
    expect(none.select).toBeUndefined(); expect(none.search?.query).toBe('missing');
    expect(none.sections[0]?.text).toContain('清空搜索');
    expect(none.actions?.map(item => item.label)).toEqual(['新建话题']);
    expect(sessionControlPanel([], undefined, action).sections[0]?.text).toContain('还没有历史');
  });

  it('disables controls during an update and preserves usable commands when callbacks are unavailable', () => {
    const pending = sessionControlPanel(sessions, undefined, action, {busy: true});
    expect(pending.select?.disabled).toBe(true); expect(pending.search?.disabled).toBe(true);
    const offline = sessionControlPanel(sessions, undefined, () => undefined);
    expect(offline.select).toBeUndefined(); expect(offline.search).toBeUndefined(); expect(offline.actions).toEqual([]);
    expect(offline.sections[0]?.text).toContain('/resume ');
    expect(offline.note).toContain('/sessions detail');
  });

  it('round-trips bounded search state and refuses malformed or noncanonical command encodings', () => {
    for (const query of ['', '项目 规划', '😀'.repeat(80)]) {
      const view = {page: 49, query};
      expect(sessionViewCommandParse(sessionViewCommand('page', view))).toEqual({kind: 'page', view});
    }
    for (const command of ['/sessions page 0', '/sessions page 01', '/sessions pick 100', '/sessions page 1 _w',
      '/sessions page 1 YQ==', '/sessions pick 1 YQo', `/sessions page 1 ${Buffer.from('x'.repeat(81)).toString('base64url')}`]) {
      expect(sessionViewCommandParse(command)).toBeUndefined();
    }
    expect(sessionQuery('  project  ')).toBe('project');
    expect(sessionQuery('x'.repeat(81))).toBeUndefined(); expect(sessionQuery({query: 'x'})).toBeUndefined();
  });
});
