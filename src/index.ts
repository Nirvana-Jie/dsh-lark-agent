import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { loadConfig } from './config.js';
import { createBotService } from './bot-service.js';

export const name = 'im-larkbot';
export const inject = ['agents', 'tools', 'sessions', 'sessionPersistence'];
export const Config = Schema.object({
  configFile: Schema.string().default('').description('团队配置 JSON 的绝对路径；也可通过 DSH_LARK_CONFIG 设置'),
  dataDir: Schema.string().default('').description('可选：自动连接状态目录；留空由宿主自动隔离'),
  executable: Schema.string().default('').description('可选：Lark CLI 路径；留空自动查找'),
});
export interface PluginConfig { configFile?: string; dataDir?: string; executable?: string }

export async function apply(ctx: Context, pluginConfig: PluginConfig): Promise<void> {
  const configFile = pluginConfig.configFile || process.env.DSH_LARK_CONFIG;
  if (!configFile) {
    const {applyOnboarding} = await import('./onboarding/host.js');
    ctx.inject(['connection'], child => applyOnboarding(child, pluginConfig));
    return;
  }
  const service = await createBotService(ctx, await loadConfig(configFile));
  try {
    ctx.effect(() => {service.start(); return async () => {await service.stop();};}, 'im-larkbot.lifecycle');
  } catch (error) {await service.stop(); throw error;}
}
