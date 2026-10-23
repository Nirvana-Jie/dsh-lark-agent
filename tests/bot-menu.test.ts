import {describe, expect, it} from 'vitest';
import {BOT_MENU_EVENT, botMenuCommand, buildBotMenuAbility, buildBotMenuPlan} from '../src/bot-menu.js';

describe('native bot menu configuration', () => {
  it('keeps all actions within a compact two-level menu with resolvable parents', () => {
    const {bot} = buildBotMenuAbility();
    expect(bot.bot_menu_enable).toBe(true);
    expect(bot.bot_menu_display_strategy).toBe(3);
    const nodes = bot.bot_menus;
    const top = nodes.filter(node => !node.parent_menu_id);
    expect(top.map(node => node.default_name)).toEqual(['新话题', '历史对话', '设置']);
    expect(new Set(nodes.map(node => node.menu_id)).size).toBe(nodes.length);
    for (const node of nodes) {
      expect(node.default_name.length).toBeLessThanOrEqual(60);
      if (node.parent_menu_id) expect(top.some(parent => parent.menu_id === node.parent_menu_id && parent.menu_content_type === 3)).toBe(true);
      if (node.menu_content_type === 2) {
        expect(node.event_key!.length).toBeLessThanOrEqual(30);
        expect(botMenuCommand(node.event_key)).toBeDefined();
      } else expect(node.event_key).toBeUndefined();
    }
    expect(nodes.filter(node => node.parent_menu_id === 'dsh_settings').map(node => node.default_name)).toEqual(['模型', '思考深度']);
    expect(new Set(nodes.filter(node => node.menu_content_type === 2).map(node => botMenuCommand(node.event_key))))
      .toEqual(new Set(['/new', '/sessions', '/model', '/thinking']));
  });

  it('returns detached payloads so a preview edit cannot change later configuration', () => {
    const first = buildBotMenuAbility();
    first.bot.bot_menus[0]!.event_key = 'dsh.model';
    first.bot.bot_menus.pop();
    const second = buildBotMenuAbility();
    expect(second.bot.bot_menus[0]!.event_key).toBe('dsh.new');
    expect(second.bot.bot_menus).toHaveLength(5);
  });

  it('separates ability and subscription updates and declares the publication step', () => {
    const plan = buildBotMenuPlan('cli_demo');
    expect(plan.ability).toMatchObject({method: 'PATCH', path: '/open-apis/application/v7/applications/cli_demo/ability'});
    expect(plan.subscription).toEqual({method: 'PATCH', path: '/open-apis/application/v7/applications/cli_demo/config',
      body: {event: {subscription_type: 'websocket', add_events: [BOT_MENU_EVENT]}}});
    expect(plan.requiresPublication).toBe(true);
    expect(plan.scope).toBe('application:application:patch');
    expect(plan.ability.body).not.toHaveProperty('scope');
    expect(plan.subscription.body.event).not.toHaveProperty('remove_events');
  });

  it.each(['', 'other_app', 'cli_demo/../other', 'cli_demo?x=1', 'cli_demo\n', `cli_${'x'.repeat(129)}`])
    ('rejects unsafe app IDs before constructing any API path: %j', value => {
      expect(() => buildBotMenuPlan(value)).toThrow('Invalid application ID');
    });

  it.each([null, undefined, {}, [], 'new', '/new', '新话题', 'dsh.new ', 'dsh.new\n', '__proto__', 'constructor', 'toString', 'dsh.exec rm'])
    ('does not turn arbitrary keys or labels into commands: %j', value => {
      expect(botMenuCommand(value)).toBeUndefined();
    });
});
