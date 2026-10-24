/** Native private-chat entry points. Keys are capabilities, never arbitrary commands. */
export const BOT_MENU_EVENT = 'application.bot.menu_v6';
export const BOT_MENU_SCOPE = 'application:application:patch';
export const BOT_MENU_COMMANDS = Object.freeze({
  'dsh.new': '/new',
  'dsh.sessions': '/sessions',
  'dsh.model': '/model',
  'dsh.thinking': '/thinking',
  'dsh.permission': '/permission',
} as const);
export type BotMenuCommand = (typeof BOT_MENU_COMMANDS)[keyof typeof BOT_MENU_COMMANDS];

export function botMenuCommand(eventKey: unknown): BotMenuCommand | undefined {
  if (typeof eventKey !== 'string' || !Object.hasOwn(BOT_MENU_COMMANDS, eventKey)) return;
  return BOT_MENU_COMMANDS[eventKey as keyof typeof BOT_MENU_COMMANDS];
}

/** A menu entry as the owner adds it in the developer console. */
export interface BotMenuEntry {label: string; eventKey: string; parent?: string}

export interface BotMenuNode {
  menu_id: string;
  parent_menu_id?: string;
  sort: number;
  default_name: string;
  menu_content_type: 2 | 3;
  event_key?: keyof typeof BOT_MENU_COMMANDS;
}

/**
 * Public Application Ability PATCH payload. Publishing is a separate admin action.
 * Three top-level nodes with three children fit both documented floating-menu
 * limit variants (at most five per level and ten in all).
 * Text actions cannot separate a friendly label from the text they send.
 */
export function buildBotMenuAbility(): {bot: {
  enable: true;
  bot_menu_enable: true;
  bot_menu_display_strategy: 3;
  bot_menus: BotMenuNode[];
}} {
  return {bot: {enable: true, bot_menu_enable: true, bot_menu_display_strategy: 3, bot_menus: [
    {menu_id: 'dsh_new', sort: 0, default_name: '新话题', menu_content_type: 2, event_key: 'dsh.new'},
    {menu_id: 'dsh_sessions', sort: 1, default_name: '历史对话', menu_content_type: 2, event_key: 'dsh.sessions'},
    {menu_id: 'dsh_settings', sort: 2, default_name: '设置', menu_content_type: 3},
    {menu_id: 'dsh_model', parent_menu_id: 'dsh_settings', sort: 0, default_name: '模型', menu_content_type: 2, event_key: 'dsh.model'},
    {menu_id: 'dsh_thinking', parent_menu_id: 'dsh_settings', sort: 1, default_name: '思考深度', menu_content_type: 2, event_key: 'dsh.thinking'},
    {menu_id: 'dsh_permission', parent_menu_id: 'dsh_settings', sort: 2, default_name: '权限模式', menu_content_type: 2, event_key: 'dsh.permission'},
  ]}};
}

/**
 * The entries a published menu lacks, by label. A menu configured by hand
 * before a release added an entry stays without it; none is reported when
 * no dsh entry was configured at all.
 */
export function missingBotMenuEntries(eventKeys: readonly string[]): BotMenuEntry[] {
  const nodes = buildBotMenuAbility().bot.bot_menus, entries = nodes.filter(node => node.event_key);
  if (!entries.some(node => eventKeys.includes(node.event_key!))) return [];
  return entries.filter(node => !eventKeys.includes(node.event_key!)).map(node => {
    const parent = nodes.find(candidate => candidate.menu_id === node.parent_menu_id)?.default_name;
    return {label: node.default_name, eventKey: node.event_key!, ...(parent ? {parent} : {})};
  });
}

/** Pure review/export plan: this module never invokes an API or changes an app. */
export function buildBotMenuPlan(appId: string) {
  if (typeof appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,128}$/.test(appId)) throw new Error('Invalid application ID.');
  return {
    scope: BOT_MENU_SCOPE,
    ability: {method: 'PATCH' as const, path: `/open-apis/application/v7/applications/${appId}/ability`, body: buildBotMenuAbility()},
    subscription: {method: 'PATCH' as const, path: `/open-apis/application/v7/applications/${appId}/config`,
      body: {event: {subscription_type: 'websocket' as const, add_events: [BOT_MENU_EVENT]}}},
    requiresPublication: true,
  };
}
