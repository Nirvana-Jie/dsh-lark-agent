/** Native private-chat entry points. Keys are capabilities, never arbitrary commands. */
export const BOT_MENU_EVENT = 'application.bot.menu_v6';
export const BOT_MENU_SCOPE = 'application:application:patch';
export const BOT_MENU_COMMANDS = Object.freeze({
  'dsh.new': '/new',
  'dsh.sessions': '/sessions',
  'dsh.model': '/model',
  'dsh.thinking': '/thinking',
} as const);
export type BotMenuCommand = (typeof BOT_MENU_COMMANDS)[keyof typeof BOT_MENU_COMMANDS];

export function botMenuCommand(eventKey: unknown): BotMenuCommand | undefined {
  if (typeof eventKey !== 'string' || !Object.hasOwn(BOT_MENU_COMMANDS, eventKey)) return;
  return BOT_MENU_COMMANDS[eventKey as keyof typeof BOT_MENU_COMMANDS];
}

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
 * Five flat nodes fit both documented floating-menu limit variants.
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
  ]}};
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
