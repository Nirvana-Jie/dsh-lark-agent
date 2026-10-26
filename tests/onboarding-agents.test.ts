import type {Context} from '@deepseek-ai/cordis';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {agentCatalog, agentSettingsStore, defaultAgentSettings, parseAgentSettings, validateAgentSettings} from '../src/onboarding/agents.js';
import {ffmpegAvailable} from '../src/media-input.js';

vi.mock('../src/media-input.js', async original => ({...await original<typeof import('../src/media-input.js')>(), ffmpegAvailable: vi.fn(async () => true)}));
function host(presets?: unknown): Context {
  return {get: (name: string) => name === 'agentPresets' ? presets : name === 'attachments' ? {saveImages() {}} : name === 'agentDefaultModel'
    ? {currentSelection: () => ({model: 'Host model', apiKey: 'PRIVATE_KEY'})} : undefined} as unknown as Context;
}
describe('robot agent settings', () => {
  it.each([['image', 'supported'], ['text', 'unsupported']] as const)('reads %s input from public model metadata without running an Agent', async (modality, support) => {
    const resolveModelInfo = vi.fn(async () => ({inputModalities: [modality], apiKey: 'PRIVATE'})), stream = vi.fn();
    const ctx = {get: (name: string) => name === 'agentDefaultModel' ? {currentSelection: () => ({provider: 'fixture', model: 'Host model'})}
      : name === 'llm' ? {resolveModelInfo, stream} : name === 'attachments' ? {saveImages() {}} : undefined} as unknown as Context;
    expect(await agentCatalog(ctx)).toMatchObject({modelImages: support});
    expect(resolveModelInfo).toHaveBeenCalledWith('fixture', 'Host model', expect.any(AbortSignal)); expect(stream).not.toHaveBeenCalled();
  });
  it('exposes only metadata and marks broken presets unavailable', async () => {
    const presets = {list: async () => [{id: 'research', name: '研究', description: '资料分析', yaml: 'PRIVATE_PLUGIN_DEFINITION'}, {id: 'broken', broken: {message: 'PRIVATE_PATH'}}],
      resolve: async () => ({id: 'research'}), mount() {}};
    const catalog = await agentCatalog(host(presets));
    expect(catalog).toMatchObject({defaultPreset: 'research', presetsAvailable: true, model: 'Host model', imagesAvailable: true,
      presets: [{id: 'research', name: '研究', available: true}, {id: 'broken', available: false}]});
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE');
    expect((await agentCatalog(host())).presetsAvailable).toBe(false);
  });
  it('revalidates a selected preset and accepts an existing real workspace only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-agent-workspace-'));
    try {
      const resolve = vi.fn(async (id?: string) => ({id, broken: id === 'broken' ? {} : undefined}));
      const ctx = host({resolve, mount() {}});
      const settings = await validateAgentSettings(ctx, {...defaultAgentSettings, agentPreset: 'research', workspace: directory});
      expect(settings.workspace).toBe(await import('node:fs/promises').then(fs => fs.realpath(directory)));
      expect(resolve).toHaveBeenCalledWith('research');
      await expect(validateAgentSettings(ctx, {...settings, agentPreset: 'broken'})).rejects.toThrow('已不可用');
      await expect(validateAgentSettings(host(), {...settings, agentPreset: 'research'})).rejects.toThrow('不支持');
      await expect(validateAgentSettings(ctx, {...settings, workspace: join(directory, 'missing')})).rejects.toThrow('已有的文件夹');
      vi.mocked(ffmpegAvailable).mockResolvedValueOnce(false);
      await expect(validateAgentSettings(ctx, {...defaultAgentSettings, voiceInput: true})).rejects.toThrow('FFmpeg');
    } finally {await rm(directory, {recursive: true, force: true});}
  });
  it('persists a whitelist privately and refuses corrupt data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-agent-store-'));
    try {
      const store = agentSettingsStore(directory);
      await store.write({...defaultAgentSettings, label: '助手', secret: 'PRIVATE'} as typeof defaultAgentSettings);
      expect(await store.read()).toEqual({...defaultAgentSettings, label: '助手'});
      expect((await stat(join(directory, 'agent.json'))).mode & 0o777).toBe(0o600);
      expect(() => parseAgentSettings({...defaultAgentSettings, workspace: '../escape'})).toThrow();
      expect(() => parseAgentSettings({...defaultAgentSettings, label: 'bad\nlabel'})).toThrow();
      expect(() => parseAgentSettings({...defaultAgentSettings, voiceInput: 'yes'})).toThrow();
    } finally {await rm(directory, {recursive: true, force: true});}
  });
});
