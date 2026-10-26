import type {Context} from '@deepseek-ai/cordis';
import type {LlmRuntime} from '@deepseek-ai/dsh-llm';
import {realpath, stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {AgentCatalog, AgentSettings} from './protocol.js';
import {SetupError} from './controller.js';
import {SettingsStore} from './settings-store.js';
import {ffmpegAvailable} from '../media-input.js';

const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
export const defaultAgentSettings: AgentSettings = {label: '', agentPreset: '', workspace: '', imageInput: true, voiceInput: false};
export function parseAgentSettings(raw: unknown): AgentSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid agent settings');
  const data = raw as Record<string, unknown>;
  for (const [key, limit] of [['label', 80], ['agentPreset', 200], ['workspace', 4096]] as const) {
    const value = data[key];
    if (typeof value !== 'string' || value.length > limit || value !== value.trim() || controls.test(value)) throw new Error('Invalid agent settings');
  }
  if (typeof data.imageInput !== 'boolean' || typeof data.voiceInput !== 'boolean'
    || (data.workspace && !isAbsolute(data.workspace as string))) throw new Error('Invalid agent settings');
  return {label: data.label as string, agentPreset: data.agentPreset as string, workspace: data.workspace as string,
    imageInput: data.imageInput, voiceInput: data.voiceInput};
}
export function agentSettingsStore(directory: string): SettingsStore<AgentSettings> {
  return new SettingsStore(directory, 'agent.json', parseAgentSettings);
}

interface Presets {
  list(): Promise<Array<{id: string; name?: string; description?: string; broken?: unknown}>>;
  resolve(id?: string): Promise<{id: string; broken?: unknown}>;
  mount(...args: unknown[]): unknown;
}
/** A metadata-only catalog; no plugin definitions, paths, provider endpoints or secrets. */
export async function agentCatalog(ctx: Context): Promise<AgentCatalog> {
  const service = ctx.get('agentPresets') as Presets | undefined;
  const available = typeof service?.list === 'function' && typeof service.resolve === 'function' && typeof service.mount === 'function';
  const catalog: AgentCatalog = {presets: [], presetsAvailable: available, model: '跟随宿主模型',
    imagesAvailable: typeof (ctx.get('attachments') as {saveImages?: unknown} | undefined)?.saveImages === 'function',
    voiceAvailable: await ffmpegAvailable()};
  const display = (value: unknown, limit: number) => typeof value === 'string' && !controls.test(value) ? value.slice(0, limit) : '';
  if (available) {
    const rows = await service.list();
    if (!Array.isArray(rows) || rows.length > 200) throw new SetupError('Agent 预设列表暂时不可用，请检查宿主设置。');
    catalog.presets = rows.filter(row => typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 200 && !controls.test(row.id))
      .map(row => ({id: row.id, name: display(row.name, 200) || row.id,
        ...(display(row.description, 600) ? {description: display(row.description, 600)} : {}), available: !row.broken}));
    try {catalog.defaultPreset = (await service.resolve()).id;} catch { /* An explicit working preset is still selectable. */ }
  }
  const selection = (ctx.get('agentDefaultModel') as {currentSelection?(): {provider?: string; model?: string}} | undefined)?.currentSelection?.();
  if (display(selection?.model, 200)) catalog.model = display(selection?.model, 200);
  catalog.modelImages = 'unknown';
  const llm = ctx.get('llm') as Pick<LlmRuntime, 'resolveModelInfo'> | undefined;
  if (selection?.provider && selection.model && typeof llm?.resolveModelInfo === 'function') {
    const aborter = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Adapter metadata only. No test message, Agent creation or tool execution.
      const info = await Promise.race([
        llm.resolveModelInfo(selection.provider, selection.model, aborter.signal),
        new Promise<undefined>(resolve => {timer = setTimeout(() => {aborter.abort(); resolve(undefined);}, 3000);}),
      ]);
      if (Array.isArray(info?.inputModalities)) catalog.modelImages = info.inputModalities.includes('image') ? 'supported' : 'unsupported';
    } catch { /* Missing metadata is shown as unknown, and checked again for the actual chat model at admission. */ }
    finally {clearTimeout(timer); aborter.abort();}
  }
  return catalog;
}

export async function validateAgentSettings(ctx: Context, settings: AgentSettings): Promise<AgentSettings> {
  const next = parseAgentSettings(settings);
  if (next.agentPreset) {
    const presets = ctx.get('agentPresets') as Presets | undefined;
    if (typeof presets?.resolve !== 'function' || typeof presets.mount !== 'function') throw new SetupError('当前宿主不支持选择 Agent 预设。');
    try {
      const resolved = await presets.resolve(next.agentPreset);
      if (resolved.id !== next.agentPreset || resolved.broken) throw new Error();
    } catch {throw new SetupError('这个 Agent 预设已不可用，请刷新后重新选择。');}
  }
  if (next.workspace) {
    try {
      next.workspace = await realpath(next.workspace);
      if (!(await stat(next.workspace)).isDirectory()) throw new Error();
    } catch {throw new SetupError('工作区必须是这台设备上已有的文件夹。');}
  }
  if (next.voiceInput && !await ffmpegAvailable()) throw new SetupError('请先在宿主设备安装 FFmpeg，再启用语音输入。');
  return next;
}
