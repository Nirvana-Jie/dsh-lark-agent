import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import type {ModelSelection, MemoryAccess} from '../src/dsh-runtime.js';

const privateMemory = (): MemoryAccess => ({privateChat: true, list: async () => [], search: async () => [],
  remember: async () => {throw new Error('not requested');}, forget: async () => false});

// Each fixture contains the supported host's real dependency tree and the current
// compiled dsh-runtime.js. No real profiles, provider credentials or network I/O.
for (const [family, hostRoot] of [['legacy', process.env.DSH_LEGACY_HOST_ROOT],
  ['modern', process.env.DSH_MODERN_HOST_ROOT]] as const) {
  describe.skipIf(!hostRoot)(`model switching with the real ${family} host`, () => {
    async function createHost(directory: string) {
      const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(hostRoot!, name)).href);
      const module = (name: string) => load(`node_modules/@deepseek-ai/${name}/lib/index.js`);
      const [cordis, agents, sessions, prompts, tools, projections, llm, loop, persistence, runtime] = await Promise.all([
        module('cordis'), module('dsh-agent'), module('dsh-session'), module('dsh-system-prompt'), module('dsh-tools'),
        module('dsh-session-projection'), module('dsh-llm'), module('dsh-agent-loop'), module('dsh-session-persistence-jsonl'),
        load('dsh-runtime.js'),
      ]);
      const root = new cordis.Context();
      const mount = async (plugin: unknown, config?: unknown) => {const fiber = root.plugin(plugin, config); await fiber.await(); return fiber;};
      await mount(agents.AgentRegistry);
      await mount(sessions.SessionStore);
      await mount(prompts.SystemPrompt, family === 'modern'
        ? {personaPrefix: 'PRIVATE HOST PERSONA', personaSuffix: 'PRIVATE HOST SUFFIX'} : {persona: 'PRIVATE HOST PERSONA'});
      await mount(tools.ToolRuntime);
      await mount(projections.SessionProjectionRegistry);
      await mount(llm.LlmRuntime);
      await mount(persistence.default ?? persistence, {root: directory, compression: 'none'});
      const requests: Array<ModelSelection & {sessionId: string}> = [];
      const metadataReads = {catalog: 0, model: 0};
      let onRequest: ((sessionId: string) => Promise<void>) | undefined;
      class OfflineAdapter extends llm.LlmAdapter {
        async listModels(provider: string) {
          metadataReads.catalog++;
          return [{provider, id: 'reasoned', name: 'Reasoned model'}, {provider, id: 'plain', name: 'Plain model'}];
        }
        async resolveModel(provider: string, model: string) {
          metadataReads.model++;
          return {provider, id: model, name: model === 'reasoned' ? 'Reasoned model' : 'Plain model',
            ...(model === 'reasoned' ? {reasoning: {efforts: [{id: 'quick', name: 'Quick'}, {id: 'deep', name: 'Deep'}], defaultEffort: 'quick'}} : {})};
        }
        async *stream(request: ModelSelection & {sessionId: string}) {
          requests.push(request);
          const action = onRequest; onRequest = undefined;
          if (action) await action(request.sessionId);
          yield {type: 'text-delta', index: 0, text: 'offline answer'};
          yield {type: 'block-end', index: 0, block: {type: 'text', text: 'offline answer'}};
          yield {type: 'finish', reason: {kind: 'completed'}};
        }
      }
      root.get('llm').registerAdapter(['offline'], new OfflineAdapter());
      await mount(loop.AgentLoop);
      let adapter: InstanceType<typeof runtime.DshRuntime>;
      await mount({inject: ['agents', 'tools', 'sessions', 'sessionPersistence', 'systemPrompt'],
        apply(ctx: unknown) {adapter = new runtime.DshRuntime(ctx);}});
      return {root, adapter: adapter!, requests, metadataReads, toolApi: tools, llmApi: llm, promptApi: prompts,
        nextRequest(action: (sessionId: string) => Promise<void>) {onRequest = action;},
        symbols: cordis.symbols, persistenceApi: await module('dsh-session-persistence'),
        close: () => root.fiber.dispose()};
    }

    it('runs the native presentation schema in a scoped turn without opening host tools', async () => {
      const directory = await mkdtemp(join(tmpdir(), `lark-present-${family}-`)), host = await createHost(directory);
      try {
        const session = await host.adapter.create({cwd: directory, allowedTools: [], provider: 'offline', model: 'plain', presentation: true});
        const agent = host.root.get('agents').get(session.id);
        expect(host.root.get('tools').schemas(agent).map((tool: {name: string}) => tool.name)).toEqual(['lark_present']);
        host.nextRequest(async () => {
          const result = await host.root.get('tools').execute({agent, name: 'lark_present', callId: 'present-fixture', signal: new AbortController().signal,
            arguments: {kind: 'chart', title: '示例数据', summary: '离线示例，只有一个类别。', content: '{"type":"bar","series":["计数"],"data":[{"label":"A","values":[2]}]}'}});
          expect(result.isError).toBe(false);
        });
        expect(await session.run('显示图表', new AbortController().signal)).toMatchObject({text: 'offline answer', artifacts: [{kind: 'chart'}]});
        if (family === 'modern') {
          const delivery = agent.session.snapshotEvents().find((event: {type: string}) => event.type === 'deliverables/presented');
          expect(delivery).toBeTruthy();
          expect(delivery.data.callId).toBe('present-fixture');
          const closing = agent.session.snapshotEvents().findLast((event: {type: string}) => event.type === 'assistant/message');
          expect(delivery.seq).toBeLessThan(closing.seq);
          expect(await readFile(delivery.data.files[0].path, 'utf8')).toContain('<svg');
          const reader = await host.root.get('sessionPersistence').open(session.id, 'read');
          try {expect((await reader.read(0)).events.some((event: {type: string}) => event.type === 'deliverables/presented')).toBe(true);}
          finally {await reader.close();}
        }
        await session.dispose();
        const restored = await host.adapter.resume({cwd: directory, allowedTools: [], provider: 'offline', model: 'plain', presentation: true}, session.id);
        expect(await restored.run('继续已保存的图表话题', new AbortController().signal)).toBe('offline answer');
        if (family === 'modern') expect(host.root.get('agents').get(restored.id).session.snapshotEvents().filter((event: {type: string}) => event.type === 'deliverables/presented')).toHaveLength(1);
        await restored.dispose();
      } finally {await host.close(); await rm(directory, {recursive: true, force: true});}
    });

    it('coalesces and caches catalog reads across the real context service proxies', async () => {
      const directory = await mkdtemp(join(tmpdir(), `lark-catalog-${family}-`));
      const host = await createHost(directory);
      try {
        expect(host.root.get('llm')).not.toBe(host.root.get('llm'));
        const catalogs = await Promise.all(Array.from({length: 8}, () => host.adapter.catalog()));
        expect(catalogs[0].models).toHaveLength(2);
        expect(host.metadataReads).toEqual({catalog: 1, model: 2});
        await host.adapter.catalog();
        expect(host.metadataReads).toEqual({catalog: 1, model: 2});
        await host.adapter.resolveModelSelection({provider: 'offline', model: 'reasoned', reasoningEffort: 'deep'});
        expect(host.metadataReads).toEqual({catalog: 2, model: 3});
        expect(host.requests).toEqual([]);
      } finally {await host.close(); await rm(directory, {recursive: true, force: true});}
    });

    it('switches the actual request and trusted prompt in one session, clears effort, and restores history', async () => {
      const directory = await mkdtemp(join(tmpdir(), `lark-model-${family}-`));
      const hosts: Array<Awaited<ReturnType<typeof createHost>>> = [];
      const policy = {cwd: '/tmp/lark-model-owner', allowedTools: []};
      try {
        const first = await createHost(directory); hosts.push(first);
        const chosen = await first.adapter.resolveModelSelection({provider: 'offline', model: 'reasoned', reasoningEffort: 'deep'});
        const selected = await first.adapter.create({...policy, ...chosen});
        const sibling = await first.adapter.create({...policy, ...chosen});
        expect(await selected.run('retain this earlier conversation', new AbortController().signal)).toBe('offline answer');
        expect(first.requests.at(-1)).toMatchObject(chosen);
        expect(JSON.stringify(first.requests.at(-1))).toContain('宿主为当前回复确定的模型信息');
        expect(JSON.stringify(first.requests.at(-1))).not.toContain('PRIVATE HOST');
        const next = await first.adapter.resolveModelSelection({provider: 'offline', model: 'plain'});
        selected.setModelSelection(next);
        expect(await selected.run('continue with the new model', new AbortController().signal)).toBe('offline answer');
        expect(first.requests.at(-1)).toMatchObject({provider: 'offline', model: 'plain'});
        expect(first.requests.at(-1)).not.toHaveProperty('reasoningEffort');
        expect(JSON.stringify(first.requests.at(-1))).toContain('retain this earlier conversation');
        expect(selected.modelSelection()).toEqual(next);
        expect(await sibling.run('another isolated user', new AbortController().signal)).toBe('offline answer');
        expect(first.requests.at(-1)).toMatchObject(chosen);
        await sibling.dispose(); await selected.dispose(); await first.close();

        const second = await createHost(directory); hosts.push(second);
        const restored = await second.adapter.resume({...policy, ...next}, selected.id);
        expect(restored.id).toBe(selected.id);
        expect(restored.modelSelection()).toEqual(next);
        expect(await restored.run('resume after a host restart', new AbortController().signal)).toBe('offline answer');
        expect(second.requests.at(-1)).toMatchObject({provider: 'offline', model: 'plain'});
        expect(second.requests.at(-1)).not.toHaveProperty('reasoningEffort');
        expect(JSON.stringify(second.requests.at(-1))).toContain('retain this earlier conversation');
        expect(JSON.stringify(second.requests.at(-1))).toContain('continue with the new model');
        expect(JSON.stringify(second.requests.at(-1))).not.toContain('another isolated user');
        await restored.dispose();
      } finally {
        for (const host of hosts) await host.close();
        await rm(directory, {recursive: true, force: true});
      }
    });

    it.each(['vacant', 'host UI already resumed', 'host UI released'] as const)('restores a saved bot conversation after restart when %s', async occupancy => {
      const directory = await mkdtemp(join(tmpdir(), `lark-restore-owner-${family}-`));
      const hosts: Array<Awaited<ReturnType<typeof createHost>>> = [];
      const policy = {cwd: '/tmp/lark-restoration-owner', allowedTools: [], provider: 'offline', model: 'plain', memory: privateMemory()};
      let uiHandle: {dispose(): Promise<void>} | undefined;
      try {
        const original = await createHost(directory); hosts.push(original);
        const saved = await original.adapter.create(policy);
        await saved.run('isolated durable bot conversation', new AbortController().signal);
        await saved.dispose(); await original.close();

        const restarted = await createHost(directory); hosts.push(restarted);
        if (occupancy !== 'vacant') {
          uiHandle = await restarted.root.agents.resume({resumeSessionId: saved.id,
            agentOptions: {provider: policy.provider, model: policy.model}});
          if (family === 'modern') {
            // Public native error distinguishes active ownership from missing
            // logs, a changed model route, or the plugin's scoped cwd check.
            await expect(restarted.root.agents.resume({resumeSessionId: saved.id,
              agentOptions: {provider: policy.provider, model: policy.model}}))
              .rejects.toMatchObject({name: 'SessionAlreadyOwnedError'});
            const reader = await restarted.root.get('sessionPersistence').open(saved.id, 'read');
            try {expect((await reader.read(0)).events.length).toBeGreaterThan(0);}
            finally {await reader.close();}
          }
          if (occupancy === 'host UI released') {await uiHandle!.dispose(); uiHandle = undefined;}
        }
        if (family === 'legacy' && occupancy === 'host UI already resumed') {
          await expect(restarted.adapter.resume(policy, saved.id)).rejects.toMatchObject({code: 'RESTORE_FAILED'});
          return;
        }
        const restored = await restarted.adapter.resume(policy, saved.id);
        if (occupancy === 'host UI already resumed') expect(restored.id).not.toBe(saved.id);
        else expect(restored.id).toBe(saved.id);
        expect(await restored.run('continue the bot conversation', new AbortController().signal)).toBe('offline answer');
        expect(JSON.stringify(restarted.requests.at(-1))).toContain('isolated durable bot conversation');
        expect(JSON.stringify(restarted.requests.at(-1))).not.toContain('PRIVATE HOST PERSONA');
        await restored.dispose();
      } finally {
        await uiHandle?.dispose();
        for (const host of hosts) await host.close();
        await rm(directory, {recursive: true, force: true});
      }
    });

    it.skipIf(family !== 'modern')('forks an occupied private history without mutating its UI owner or inheriting its permissions', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'lark-private-fork-'));
      const host = await createHost(directory);
      let ui: {agent: unknown; dispose(): Promise<void>} | undefined;
      let restored: {id: string; dispose(): Promise<void>} | undefined;
      const memory: MemoryAccess = {...privateMemory(), list: async () => [{id: 'bound-fact', scope: 'personal',
        groupShared: false, text: 'BOUND PRIVATE MEMORY', createdAt: 1, updatedAt: 1}]};
      const policy = {cwd: '/tmp/lark-private-owner', allowedTools: ['safe_lookup'], provider: 'offline',
        model: 'reasoned', reasoningEffort: 'deep', memory};
      try {
        let executions = 0;
        const tool = (name: string) => host.toolApi.defineTool({name, description: name, parameters: {},
          output: {schema: {type: 'object', additionalProperties: false, properties: {}}, render: () => [{type: 'text', text: 'ok'}]},
          async execute() {executions++; return {};}});
        host.root.get('tools').register(tool('safe_lookup'));
        host.root.get('tools').register(tool('host_private_tool'));
        const saved = await host.adapter.create(policy);
        await saved.run('keep this earlier private conversation', new AbortController().signal, {memoryText: 'OLD VISIBLE MEMORY'});
        await saved.dispose();
        ui = await host.root.agents.resume({resumeSessionId: saved.id, agentOptions: {provider: 'offline', model: 'plain'}});
        const uiDispose = vi.spyOn(ui!, 'dispose');
        const readParent = async () => {
          const reader = await host.root.get('sessionPersistence').open(saved.id, 'read');
          try {return structuredClone((await reader.read(0)).events);}
          finally {await reader.close();}
        };
        const originalEvents = await readParent();
        const originalAgent = host.root.get('agents').get(saved.id);
        await expect(host.adapter.resume({...policy, memory: {...memory, privateChat: false}}, saved.id))
          .rejects.toMatchObject({code: 'SESSION_IN_USE'});
        await expect(host.adapter.resume({...policy, memory: undefined}, saved.id))
          .rejects.toMatchObject({code: 'SESSION_IN_USE'});
        const fork = await host.adapter.resume(policy, saved.id); restored = fork;
        expect(fork.id).not.toBe(saved.id);
        const agent = host.root.get('agents').get(fork.id);
        expect(agent).not.toBe(originalAgent);
        expect(agent.session.header).toMatchObject({cwd: policy.cwd, parentSession: saved.id, isSeeded: true});
        expect(agent.session.snapshotEvents().slice(0, originalEvents.length)).toEqual(originalEvents);
        agent.ctx.get('tools').register(tool('late_private_tool'));
        const execute = (name: string, args = {}) => host.root.get('tools').execute({
          callId: host.llmApi.ToolCallId(`${fork.id}-${name}`), name, arguments: args, agent, signal: new AbortController().signal});
        expect((await execute('safe_lookup')).isError).toBe(false);
        expect((await execute('host_private_tool')).isError).toBe(true);
        expect((await execute('late_private_tool')).isError).toBe(true);
        expect(executions).toBe(1);
        expect(JSON.stringify(await execute('lark_memory_list'))).toContain('BOUND PRIVATE MEMORY');
        expect(fork.modelSelection()).toEqual({provider: 'offline', model: 'reasoned', reasoningEffort: 'deep'});
        await fork.run('continue in the private bot channel', new AbortController().signal, {memoryText: 'CURRENT BOUND MEMORY'});
        const latest = JSON.stringify(host.requests.at(-1));
        expect(host.requests.at(-1)).toMatchObject({provider: 'offline', model: 'reasoned', reasoningEffort: 'deep'});
        expect(latest).toContain('keep this earlier private conversation');
        expect(latest).toContain('CURRENT BOUND MEMORY');
        expect(latest).not.toContain('OLD VISIBLE MEMORY');
        expect(latest).not.toContain('PRIVATE HOST');
        expect(latest).not.toContain('host_private_tool');
        expect(await readParent()).toEqual(originalEvents);
        expect(host.root.get('agents').get(saved.id)).toBe(originalAgent);
        expect(uiDispose).not.toHaveBeenCalled();
        await fork.dispose(); restored = undefined;
        const again = await host.adapter.resume(policy, fork.id); restored = again;
        expect(again.id).toBe(fork.id);
        expect(host.root.get('agents').get(again.id).session.snapshotEvents().some(
          (event: unknown) => JSON.stringify(event).includes('continue in the private bot channel'))).toBe(true);
      } finally {
        await restored?.dispose(); await ui?.dispose();
        await host.close(); await rm(directory, {recursive: true, force: true});
      }
    });

    it.skipIf(family !== 'modern').each(['ordinary failure', 'lookalike ownership error', 'another session owned'] as const)(
      'does not fork a private conversation after %s', async failure => {
        const directory = await mkdtemp(join(tmpdir(), 'lark-fork-error-'));
        const host = await createHost(directory);
        let restoreOpen: (() => void) | undefined;
        try {
          const policy = {cwd: '/tmp/lark-error-owner', allowedTools: [], provider: 'offline', model: 'plain', memory: privateMemory()};
          const saved = await host.adapter.create(policy); await saved.checkpoint(); await saved.dispose();
          const persistence = host.root.get('sessionPersistence');
          const original = persistence.open.bind(persistence);
          const failureValue = failure === 'ordinary failure' ? new Error('unavailable')
            : failure === 'lookalike ownership error' ? Object.assign(new Error('occupied'), {name: 'SessionAlreadyOwnedError', sessionId: saved.id})
              : new host.persistenceApi.SessionAlreadyOwnedError('11111111-1111-4111-8111-111111111111');
          const reads = vi.fn();
          const spy = vi.spyOn(persistence[host.symbols.original] ?? persistence, 'open').mockImplementation(async (...args: unknown[]) => {
            if (args[1] === 'write') throw failureValue;
            reads(); return original(...args);
          });
          restoreOpen = () => spy.mockRestore();
          await expect(host.adapter.resume(policy, saved.id)).rejects.toMatchObject({code: 'RESTORE_FAILED'});
          expect(reads).not.toHaveBeenCalled();
          expect(host.root.get('agents').list()).toEqual([]);
        } finally {restoreOpen?.(); await host.close(); await rm(directory, {recursive: true, force: true});}
      });

    it.skipIf(family !== 'modern').each(['wrong id', 'wrong cwd', 'noncontiguous events', 'read failed', 'close failed'] as const)(
      'does not create a fork from an occupied snapshot with %s', async fault => {
        const directory = await mkdtemp(join(tmpdir(), 'lark-fork-snapshot-'));
        const host = await createHost(directory);
        let ui: {dispose(): Promise<void>} | undefined;
        let restoreOpen: (() => void) | undefined;
        try {
          const policy = {cwd: '/tmp/lark-snapshot-owner', allowedTools: [], provider: 'offline', model: 'plain', memory: privateMemory()};
          const saved = await host.adapter.create(policy); await saved.checkpoint(); await saved.dispose();
          ui = await host.root.agents.resume({resumeSessionId: saved.id, agentOptions: {provider: 'offline', model: 'plain'}});
          const persistence = host.root.get('sessionPersistence'), original = persistence.open.bind(persistence);
          const readerClosed = vi.fn();
          const spy = vi.spyOn(persistence[host.symbols.original] ?? persistence, 'open').mockImplementation(async (...args: unknown[]) => {
            const reader = await original(...args);
            if (args[1] !== 'read') return reader;
            return {header: {...reader.header, ...(fault === 'wrong id' ? {id: 'another-id'} : {}),
              ...(fault === 'wrong cwd' ? {cwd: '/tmp/other-owner'} : {})},
            read: async (...params: unknown[]) => {
              if (fault === 'read failed') throw new Error('read failed');
              const result = await reader.read(...params);
              return fault === 'noncontiguous events' ? {...result, events: result.events.map((event: object) => ({...event, seq: 100}))} : result;
            },
            close: async () => {await reader.close(); readerClosed(); if (fault === 'close failed') throw new Error('close failed');}};
          });
          restoreOpen = () => spy.mockRestore();
          await expect(host.adapter.resume(policy, saved.id)).rejects.toMatchObject({code: 'RESTORE_FAILED'});
          expect(readerClosed).toHaveBeenCalledTimes(1);
          expect(host.root.get('agents').list()).toHaveLength(1);
        } finally {restoreOpen?.(); await ui?.dispose(); await host.close(); await rm(directory, {recursive: true, force: true});}
      });
  });
}
