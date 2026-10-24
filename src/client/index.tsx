import type {ComponentType} from 'react';
import {ConnectionApi, type ConnectionRpc} from './api.js';
import {ConnectionCard, type ConnectionCardProps} from './ConnectionCard.js';
import {installStyles} from './styles.js';

/** Minimal public services shared by the Web and official desktop hosts. */
export interface ClientContext {
  effect(factory: () => void | (() => void), label?: string): unknown;
  connection: {rpc: ConnectionRpc; generation?: {getSnapshot(): unknown}};
  slots: {
    inject(name: string, factory: () => (() => void)): unknown;
    register(options: {name: string; id: string; order: number; label: () => string; inject: () => ConnectionCardProps}, component: ComponentType<ConnectionCardProps>): () => void;
  };
  /** Optional services by name, such as the App's plugin page navigation. */
  get?(name: string): unknown;
}

export const inject = ['slots', 'connection'];

/** Add a dedicated settings tab; both host versions own this public slot. */
export function apply(ctx: ClientContext): void {
  const app = ctx.connection.generation !== undefined;
  const api = new ConnectionApi(ctx.connection.rpc, app);
  // The App (0.2.1-rc.3 and later) can switch to its plugin list, where a third-party plugin is reinstalled.
  const openPlugins = (): boolean => {
    try {
      const navigation = ctx.get?.('pluginNavigation') as {openList?: () => void} | undefined;
      if (typeof navigation?.openList !== 'function') return false;
      navigation.openList();
      return true;
    } catch { return false; }
  };
  ctx.effect(installStyles, 'dsh-larkbot: connection styles');
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'dsh-larkbot', order: 30, label: () => '飞书', inject: () => ({api, host: {app, openPlugins}}),
  }, ConnectionCard));
}
