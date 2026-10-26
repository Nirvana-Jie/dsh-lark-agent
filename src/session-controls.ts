import type {SavedSession} from './session-store.js';
import {plainLabel, type ReplyAction, type ReplyPanel} from './replies.js';

export interface SessionView {page: number; query: string}
export interface SessionChoice extends SavedSession {link?: string}
export const SESSION_PAGE_SIZE = 20;
export const SESSION_QUERY_LENGTH = 80;

export function sessionQuery(value: unknown): string | undefined {
  if (typeof value !== 'string' || Array.from(value).length > SESSION_QUERY_LENGTH || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return;
  return value.normalize('NFC').trim();
}

/** The query travels inside the signed command, never as an executable command fragment. */
export function sessionViewCommand(kind: 'page' | 'pick', view: SessionView): string {
  return `/sessions ${kind} ${view.page + 1}${view.query ? ` ${Buffer.from(view.query).toString('base64url')}` : ''}`;
}

export function sessionViewCommandParse(command: string): {kind: 'page' | 'pick'; view: SessionView} | undefined {
  const match = /^\/sessions (page|pick) ([1-9][0-9]?)(?: ([A-Za-z0-9_-]{1,428}))?$/.exec(command);
  if (!match) return;
  const query = match[3] ? Buffer.from(match[3], 'base64url').toString('utf8') : '';
  if (sessionQuery(query) !== query || (match[3] && Buffer.from(query).toString('base64url') !== match[3])) return;
  return {kind: match[1] as 'page' | 'pick', view: {page: Number(match[2]) - 1, query}};
}

export function sessionPage<T extends SessionChoice>(sessions: readonly T[], view: SessionView) {
  const query = view.query.normalize('NFC').toLocaleLowerCase();
  const matches = sessions.filter(session => session.title.normalize('NFC').toLocaleLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(matches.length / SESSION_PAGE_SIZE));
  const page = Math.max(0, Math.min(view.page, pages - 1));
  return {items: matches.slice(page * SESSION_PAGE_SIZE, (page + 1) * SESSION_PAGE_SIZE), total: matches.length, pages, view: {...view, page}};
}

/** A short picker stays the same height as the catalog grows. Only its selected topic gets a detail row. */
export function sessionControlPanel(sessions: readonly SessionChoice[], currentId: string | undefined,
  action: (label: string, command: string) => ReplyAction | undefined,
  options: {view?: SessionView; selectedId?: string; busy?: boolean; status?: ReplyPanel['status']} = {}): ReplyPanel {
  const page = sessionPage(sessions, options.view ?? {page: 0, query: ''});
  const selected = sessions.find(session => session.id === (options.selectedId ?? currentId));
  const selectedVisible = page.items.some(session => session.id === selected?.id);
  const pick = action('选择话题', sessionViewCommand('pick', page.view));
  const search = action('搜索', '/sessions search');
  const actions = [
    ...(page.view.page > 0 ? [action('上一页', sessionViewCommand('page', {...page.view, page: page.view.page - 1}))] : []),
    ...(page.view.page + 1 < page.pages ? [action('下一页', sessionViewCommand('page', {...page.view, page: page.view.page + 1}))] : []),
    action('新建话题', '/new'),
  ].filter((item): item is ReplyAction => Boolean(item));
  const duplicates = new Map<string, number>();
  const dateFormat = new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});
  for (const session of page.items) {const title = plainLabel(session.title, 30); duplicates.set(title, (duplicates.get(title) ?? 0) + 1);}
  const count = page.view.query ? `找到 ${page.total} 个话题 · 共 ${sessions.length} 个` : `共 ${sessions.length} 个话题 · 最近活跃优先`;
  return {title: '以前的对话', summary: page.view.query ? `搜索历史话题：${page.total} 个结果，可选择话题继续` : `浏览 ${sessions.length} 个历史话题，选择后打开继续聊天`,
    subtitle: count, ...(options.status ? {status: options.status, tone: options.status.tone} : {}),
    ...(search ? {search: {query: page.view.query, value: search.value, disabled: options.busy}} : {}),
    ...(pick && page.items.length ? {select: {placeholder: '选择一个话题继续聊天', value: pick.value, disabled: options.busy,
      ...(selectedVisible ? {initialOption: selected!.id} : {}),
      options: page.items.map(session => {
        const title = plainLabel(session.title, 30);
        const date = dateFormat.format(session.updatedAt);
        return {value: session.id, label: `${title}${Array.from(session.title).length > 30 ? '…' : ''} · ${date}${duplicates.get(title)! > 1 ? ` · ${session.id.slice(-4)}` : ''}`};
      })}} : {}),
    sections: !page.total ? [{text: sessions.length ? '没有找到匹配的话题。换个关键词，或清空搜索查看全部。' : '还没有历史话题。直接发消息，就会开始新的对话。'}]
      : !pick ? page.items.map(session => ({title: plainLabel(session.title, 60), text: `/resume ${session.id}`}))
      : selected ? [{...(!selectedVisible ? {title: plainLabel(selected.title, 60)} : {}), text: selected.link ? `[打开话题继续](${selected.link})`
        : selected.id === currentId ? '当前正在聊的话题' : '话题入口暂不可用，请在聊天中找到对应话题后继续。'}] : [],
    actions, actionColumns: actions.length === 1 ? 1 : actions.length === 2 ? 2 : 3,
    note: `第 ${page.view.page + 1} / ${page.pages} 页${page.view.query ? ' · 清空搜索可查看全部话题' : ''}${!pick ? '\n文字操作：/sessions detail；/resume <ID>' : ''}`,
  };
}
