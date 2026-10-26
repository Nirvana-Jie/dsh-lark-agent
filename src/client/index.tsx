import type {ComponentType} from 'react';
import {ConnectionApi, type ConnectionRpc} from './api.js';
import type {ConnectionCardProps} from './ConnectionCard.js';
import {installStyles} from './styles.js';
import {ManagerPanel} from './ManagerPanel.js';

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
  const seat = app ? 'settings.section' : 'settings.plugins.tab';
  ctx.slots.inject(seat, () => ctx.slots.register({
    name: seat, id: 'dsh-larkbot', order: 40, label: () => '飞书 agent', inject: () => ({api, host: {app, openPlugins}}),
  }, ManagerPanel));
}
