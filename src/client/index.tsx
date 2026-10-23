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
}

export const inject = ['slots', 'connection'];

/** Add a dedicated settings tab; both host versions own this public slot. */
export function apply(ctx: ClientContext): void {
  const api = new ConnectionApi(ctx.connection.rpc, ctx.connection.generation !== undefined);
  ctx.effect(installStyles, 'dsh-larkbot: connection styles');
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'dsh-larkbot', order: 30, label: () => '飞书', inject: () => ({api}),
  }, ConnectionCard));
}
