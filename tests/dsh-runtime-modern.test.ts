import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryAccess, MemoryEntryLike } from '../src/dsh-runtime.js';

// Optional real-host contract suite. DSH_MODERN_HOST_ROOT is an isolated copy
// of the App's dependency tree with the compiled dsh-runtime.js at its root.
// No real profiles, network adapters, credentials, or model calls are used.
const hostRoot = process.env.DSH_MODERN_HOST_ROOT;
const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(hostRoot!, path)).href);
const hostModule = (name: string) => load(`node_modules/@deepseek-ai/${name}/lib/index.js`);

describe.skipIf(!hostRoot)('DshRuntime with the official 0.2 host', () => {
  async function createHost(directory: string, blocked = false, chunks?: unknown[]) {
    const [cordis, agents, sessions, prompts, tools, projections, llm, loop, persistence, runtime] = await Promise.all([
      hostModule('cordis'), hostModule('dsh-agent'), hostModule('dsh-session'), hostModule('dsh-system-prompt'),
      hostModule('dsh-tools'), hostModule('dsh-session-projection'), hostModule('dsh-llm'),
      hostModule('dsh-agent-loop'), hostModule('dsh-session-persistence-jsonl'), load('dsh-runtime.js'),
    ]);
    const root = new cordis.Context();
    const mount = async (plugin: unknown, config?: unknown) => {
      const fiber = root.plugin(plugin, config); await fiber.await(); return fiber;
    };
    await mount(agents.AgentRegistry);
    await mount(sessions.SessionStore);
    await mount(prompts.SystemPrompt, {personaPrefix: 'PRIVATE APP PERSONA', personaSuffix: 'PRIVATE APP SUFFIX'});
    await mount(tools.ToolRuntime);
    await mount(projections.SessionProjectionRegistry);
    await mount(llm.LlmRuntime);
    await mount(persistence, {root: directory, compression: 'none'});
    const requests: unknown[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    class OfflineAdapter extends llm.LlmAdapter {
      async resolveModel(provider: string, model: string) {return {provider, id: model, name: 'Offline model', inputModalities: ['text', 'image']};}
      async *stream(request: {signal: AbortSignal}) {
        requests.push(request);
        markStarted();
        if (blocked) {
          await new Promise<void>(resolve => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener('abort', () => resolve(), {once: true});
          });
          yield {type: 'finish', reason: {kind: 'aborted'}};
          return;
        }
        if (chunks) { yield* chunks; return; }
        yield {type: 'text-delta', index: 0, text: 'offline answer'};
        yield {type: 'block-end', index: 0, block: {type: 'text', text: 'offline answer'}};
        yield {type: 'finish', reason: {kind: 'completed'}};
      }
    }
    root.get('llm').registerAdapter(['offline'], new OfflineAdapter());
    root.get('systemPrompt').context({name: 'private-app-context', order: 1, text: 'PRIVATE APP SNAPSHOT'});
    root.get('systemPrompt').context({name: 'working-directory:current', order: 100, required: true,
      text: (context: {agent?: {session: {header: {cwd: string}}}}) => context.agent?.session.header.cwd ?? ''});
    await mount(loop.AgentLoop);
    let adapter: InstanceType<typeof runtime.DshRuntime>;
    const owner = await mount({name: 'test-bot-owner', inject: ['agents', 'tools', 'sessions', 'sessionPersistence', 'systemPrompt'],
      apply(ctx: unknown) { adapter = new runtime.DshRuntime(ctx); }});
    return {root, owner, adapter: adapter!, requests, started, runtime, prompts, tools, llm, mount, close: () => root.fiber.dispose()};
  }

  it('normalizes an inbound image through real attachment storage and restores its durable native reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-image-'));
    const hosts: Array<Awaited<ReturnType<typeof createHost>>> = [];
    const policy = {cwd: join(directory, 'workspace'), allowedTools: [], provider: 'offline', model: 'offline', mode: 'harness' as const,
      memory: {privateChat: true, list: async () => [], search: async () => [], remember: async () => {throw new Error('unused');}, forget: async () => false}};
    try {
      const host = await createHost(directory); hosts.push(host);
      const backend = await hostModule('dsh-attachment-local');
      await host.mount(backend.default ?? backend.LocalAttachmentStore, {dshHome: join(directory, 'home')});
      const sharp = (await load('node_modules/sharp/dist/index.mjs')).default;
      const bytes = await sharp({create: {width: 2, height: 2, channels: 4, background: '#3366ff'}}).png().toBuffer();
      const session = await host.adapter.create(policy);
      expect(await session.run('describe the image', new AbortController().signal, {images: [{data: bytes, mediaType: 'image/png'}]})).toBe('offline answer');
      const agent = host.root.get('agents').get(session.id);
      const messages = agent.session.snapshotEvents().filter((event: {type: string; data: {content?: Array<{type: string}>}}) => event.type === 'user/message'
        && event.data.content?.some(part => part.type === 'image'));
      expect(messages).toHaveLength(1);
      const block = messages[0].data.content.find((part: {type: string}) => part.type === 'image');
      expect(block.attachment).toMatchObject({mediaType: 'image/png', width: 2, height: 2});
      expect(JSON.stringify(messages)).not.toContain(bytes.toString('base64'));
      expect(JSON.stringify(host.requests)).toContain('describe the image');
      await session.dispose(); await host.close();
      const restored = await createHost(directory); hosts.push(restored);
      await restored.mount(backend.default ?? backend.LocalAttachmentStore, {dshHome: join(directory, 'home')});
      const resumed = await restored.adapter.resume(policy, session.id);
      expect(await resumed.run('continue from this image', new AbortController().signal)).toBe('offline answer');
      const reopened = restored.root.get('agents').get(resumed.id).session.snapshotEvents()
        .filter((event: {type: string}) => event.type === 'user/message');
      expect(reopened.some((event: {data: {content?: Array<{type: string; attachment?: unknown}>}}) => event.data.content?.some(part => part.type === 'image'
        && JSON.stringify(part.attachment) === JSON.stringify(block.attachment)))).toBe(true);
      expect((await restored.root.get('attachments').readImage(block.attachment)).data.byteLength).toBeGreaterThan(0);
      expect(JSON.stringify(restored.requests)).toContain('"type":"image"');
      await resumed.dispose();
    } finally {for (const host of hosts.reverse()) await host.close(); await rm(directory, {recursive: true, force: true});}
  });

  it('runs and restores real agents while isolating persona, tools, memory, and required cwd', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-'));
    const hosts: Array<Awaited<ReturnType<typeof createHost>>> = [];
    const policy = {cwd: '/tmp/lark-modern-user', allowedTools: [], provider: 'offline', model: 'offline'};
    try {
      const first = await createHost(directory); hosts.push(first);
      expect(first.runtime.checkRuntimeCompatibility(first.owner.ctx)).toEqual({supported: true, family: 'modern', missing: []});
      const session = await first.adapter.create(policy);
      await session.checkpoint();
      const agent = first.root.get('agents').get(session.id);
      const assembly = await first.root.get('systemPrompt').assemble({scope: agent, agent});
      expect(first.prompts.renderPrompt(assembly)).toContain('飞书中的 dsh 团队助手');
      expect(first.prompts.renderPrompt(assembly)).not.toContain('PRIVATE APP');
      expect(first.prompts.renderContextSnapshot(assembly)).toContain(policy.cwd);
      expect(first.prompts.renderContextSnapshot(assembly)).not.toContain('PRIVATE APP');
      expect(assembly.tools).toEqual([]);
      expect(await session.run('remember this turn', new AbortController().signal, {memoryText: 'PRIVATE ALICE FACT'})).toBe('offline answer');
      expect(JSON.stringify(first.requests)).toContain('PRIVATE ALICE FACT');
      expect(JSON.stringify(first.requests)).not.toContain('PRIVATE APP');
      const events = agent.session.snapshotEvents();
      expect(events.some((event: {type: string}) => event.type === 'assistant/message')).toBe(true);
      await session.dispose();
      await first.close();

      const second = await createHost(directory); hosts.push(second);
      await expect(second.adapter.resume({...policy, cwd: '/tmp/wrong-owner'}, session.id)).rejects.toMatchObject({code: 'RESTORE_FAILED'});
      const restored = await second.adapter.resume(policy, session.id);
      expect(restored.id).toBe(session.id);
      expect(await restored.run('continue', new AbortController().signal)).toBe('offline answer');
      // The prior system snapshot is replaced by the current complete persona;
      // old memory is not reused as current system context on resumption.
      const latest = JSON.stringify(second.requests.at(-1));
      expect(latest).toContain('飞书中的 dsh 团队助手');
      expect(latest).not.toContain('PRIVATE ALICE FACT');
      expect(JSON.stringify(second.root.get('agents').get(session.id).session.snapshotEvents())).toContain('remember this turn');
      await restored.dispose();
    } finally {
      for (const host of hosts) await host.close();
      await rm(directory, {recursive: true, force: true});
    }
  });

  const ownerMemory = (): MemoryAccess => ({privateChat: true, list: async () => [], search: async () => [],
    remember: async () => { throw new Error('unused'); }, forget: async () => false});

  it('runs a harness channel session with the host prompt, context and tools, and streams real frames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-harness-'));
    const host = await createHost(directory, false, [
      {type: 'reasoning-delta', index: 0, text: 'think first'}, {type: 'block-end', index: 0, block: {type: 'reasoning', text: 'think first'}},
      {type: 'text-delta', index: 1, text: 'harness answer'}, {type: 'block-end', index: 1, block: {type: 'text', text: 'harness answer'}},
      {type: 'finish', reason: {kind: 'completed'}},
    ]);
    try {
      host.root.get('tools').register(host.tools.defineTool({name: 'bash', description: 'bash', parameters: {},
        output: {schema: {type: 'object', additionalProperties: false, properties: {}}, render: () => [{type: 'text', text: 'ok'}]},
        async execute() { return {}; }}));
      const session = await host.adapter.create({cwd: '/tmp/lark-modern-owner', allowedTools: [], provider: 'offline', model: 'offline',
        mode: 'harness', memory: ownerMemory()});
      const agent = host.root.get('agents').get(session.id);
      const assembly = await host.root.get('systemPrompt').assemble({scope: agent, agent});
      const prompt = host.prompts.renderPrompt(assembly);
      // The owner's own session keeps the host persona and runtime context.
      expect(prompt).toContain('PRIVATE APP PERSONA');
      expect(prompt).toContain('飞书私聊');
      expect(prompt).not.toContain('飞书中的 dsh 团队助手');
      expect(host.prompts.renderContextSnapshot(assembly)).toContain('PRIVATE APP SNAPSHOT');
      expect(assembly.tools.map((tool: {name: string}) => tool.name)).toEqual(expect.arrayContaining(['bash', 'lark_memory_list']));
      const events: unknown[] = [];
      await expect(session.run('research', new AbortController().signal, undefined, {stream: (event: unknown) => events.push(event)}))
        .resolves.toEqual({text: 'harness answer', artifacts: [], reasoning: 'think first'});
      expect(events).toEqual([{type: 'attempt'}, {type: 'reasoning', text: 'think first'}, {type: 'text', text: 'harness answer'}]);
      await session.dispose();
    } finally {
      await host.close(); await rm(directory, {recursive: true, force: true});
    }
  });

  it('shares a harness session model with the App through the real session record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-model-'));
    const hosts: Array<Awaited<ReturnType<typeof createHost>>> = [];
    // What the App host adds: its per-session model record and the default its selector saves.
    const appHost = async () => {
      const host = await createHost(directory); hosts.push(host);
      const projection = await load('node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/model-selection-projection.js');
      projection.installModelSelectionProjection(host.root);
      const saved: unknown[] = [];
      const fiber = host.root.plugin({name: 'test-default-model', apply(ctx: {provide(name: string, value: unknown): void}) {
        ctx.provide('agentDefaultModel', {currentSelection: () => ({provider: 'offline', model: 'offline'}), saveSelection: async (next: unknown) => { saved.push(next); }});
      }});
      await fiber.await();
      return {host, saved};
    };
    const policy = {cwd: '/tmp/lark-modern-owner', allowedTools: [], mode: 'harness' as const, memory: ownerMemory()};
    const picks = (agent: {session: {snapshotEvents(): Array<{type: string; data: unknown}>}}) =>
      agent.session.snapshotEvents().filter(event => event.type === 'model/selection').map(event => event.data);
    try {
      const {host, saved} = await appHost();
      expect(host.adapter.sharesModelSelection()).toBe(true);
      const session = await host.adapter.create(policy);
      expect(session.sharesModelSelection).toBe(true);
      expect(session.modelSelection()).toEqual({provider: 'offline', model: 'offline'});
      const agent = host.root.get('agents').get(session.id);
      session.setModelSelection({provider: 'offline', model: 'offline', reasoningEffort: 'high'});
      expect(saved).toEqual([]); // A session record and the new-session default have separate write paths.
      expect(picks(agent)).toEqual([{provider: 'offline', model: 'offline', reasoningEffort: 'high'}]);
      expect(session.modelSelection()).toEqual({provider: 'offline', model: 'offline', reasoningEffort: 'high'});
      // A pick made in the App on this session is recorded the same way and routes the next request.
      agent.session.append('model/selection', {provider: 'offline', model: 'app-pick'});
      expect(session.modelSelection()).toEqual({provider: 'offline', model: 'app-pick'});
      expect(await session.run('which model', new AbortController().signal)).toBe('offline answer');
      expect(JSON.stringify(host.requests.at(-1))).toContain('app-pick');
      await host.adapter.saveDefaultModel({provider: 'offline', model: 'app-pick'});
      expect(saved).toEqual([{provider: 'offline', model: 'app-pick'}]);
      await session.checkpoint();
      await session.dispose();
      await host.close();
      // After a restart the session resumes on its own record, not on the host default.
      const restarted = await appHost();
      const resumed = await restarted.host.adapter.resume(policy, session.id);
      expect(resumed.modelSelection()).toEqual({provider: 'offline', model: 'app-pick'});
      await resumed.dispose();
    } finally {
      for (const host of hosts) await host.close().catch(() => undefined);
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('reads the real permission default without a session and preserves a recorded session choice after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-permissions-'));
    const hosts: Array<Awaited<ReturnType<typeof createHost>>> = [];
    const open = async () => {
      const host = await createHost(directory); hosts.push(host);
      await host.mount({name: 'offline-permission-dependencies', apply(ctx: {provide(name: string, value: unknown): void}) {
        ctx.provide('shell', {sandboxMode: 'workspace-write'});
        ctx.provide('approval', {config: {policy: 'ask'}});
      }});
      const permissions = await hostModule('dsh-permission-presets');
      await host.mount(permissions.default ?? permissions.PermissionPresetService, {defaultPreset: 'workspace-write', presets: {
        'workspace-write': {sandbox: 'workspace-write', approval: 'ask', name: 'Workspace'},
        'read-only': {sandbox: 'read-only', approval: 'ask', name: 'Read only'},
      }});
      return host;
    };
    const policy = {cwd: '/tmp/lark-modern-owner', allowedTools: [], provider: 'offline', model: 'offline', mode: 'harness' as const, memory: ownerMemory()};
    try {
      const host = await open();
      expect(host.adapter.permissionDefault()).toBe('workspace-write');
      expect(host.root.get('agents').list()).toEqual([]);
      const session = await host.adapter.create(policy);
      session.setPermission('read-only');
      await session.checkpoint(); await session.dispose(); await host.close();
      const restored = await open();
      expect(restored.adapter.permissionDefault()).toBe('workspace-write');
      const resumed = await restored.adapter.resume(policy, session.id);
      expect(resumed.permissionState()).toMatchObject({current: 'read-only', defaultPreset: 'workspace-write'});
      expect(restored.requests).toHaveLength(0);
      await resumed.dispose();
    } finally {
      for (const host of hosts) await host.close().catch(() => undefined);
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('answers real host approvals and questions only for its own active harness turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-relay-'));
    const host = await createHost(directory, true);
    try {
      const session = await host.adapter.create({cwd: '/tmp/lark-modern-owner', allowedTools: [], provider: 'offline', model: 'offline',
        mode: 'harness', memory: ownerMemory()});
      const agent = host.root.get('agents').get(session.id);
      const {scopeTarget} = await hostModule('dsh-scope');
      const unanswered = async () => 'unavailable';
      expect(await host.root.waterfall(scopeTarget(host.root, agent), 'approval/request', {agent, toolName: 'bash'}, unanswered)).toBe('unavailable');
      const approve = vi.fn(async () => true);
      const ask = vi.fn(async () => [{id: 'go', selected: ['Yes']}]);
      const controller = new AbortController();
      const turn = session.run('go', controller.signal, undefined, {approve, ask});
      await host.started;
      expect(await host.root.waterfall(scopeTarget(host.root, agent), 'approval/request', {agent, toolName: 'bash', reason: 'outside sandbox'}, unanswered))
        .toBe('allowed-once');
      expect(approve).toHaveBeenCalledWith({toolName: 'bash', reason: 'outside sandbox'}, expect.any(AbortSignal));
      expect(await host.root.waterfall(scopeTarget(host.root, agent), 'user-questions/request',
        {agent, questions: [{id: 'go', question: 'Proceed?', options: [{label: 'Yes'}, {label: 'No'}]}]}, async () => { throw new Error('no answerer'); }))
        .toEqual({answers: [{id: 'go', selected: ['Yes']}]});
      // Another agent's request never reaches this chat.
      expect(await host.root.waterfall(scopeTarget(host.root, {}), 'approval/request', {}, unanswered)).toBe('unavailable');
      expect(approve).toHaveBeenCalledOnce();
      controller.abort();
      await expect(turn).rejects.toMatchObject({code: 'CANCELLED'});
      await session.dispose();
    } finally {
      await host.close(); await rm(directory, {recursive: true, force: true});
    }
  });

  it('preserves scoped native guards and automatic approval rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-guard-'));
    const host = await createHost(directory);
    try {
      const tools = host.root.get('tools');
      let executed = 0;
      const tool = (name: string) => host.tools.defineTool({name, description: name, parameters: {},
        output: {schema: {type: 'object', additionalProperties: false, properties: {}}, render: () => [{type: 'text', text: 'ok'}]},
        async execute() { executed++; return {}; }});
      tools.register(tool('safe_lookup'));
      tools.register(tool('bash'));
      const session = await host.adapter.create({cwd: '/tmp/lark-modern-user', allowedTools: ['safe_lookup'], provider: 'offline', model: 'offline'});
      const agent = host.root.get('agents').get(session.id);
      const scoped = agent.ctx.get('tools');
      scoped.register(tool('late_privileged_tool'));
      const execute = (name: string) => tools.execute({callId: host.llm.ToolCallId(name), name, arguments: {}, agent, signal: new AbortController().signal});
      expect((await execute('safe_lookup')).isError).toBe(false);
      expect((await execute('bash')).isError).toBe(true);
      expect((await execute('late_privileged_tool')).isError).toBe(true);
      expect((await execute('run_code')).isError).toBe(true);
      expect(executed).toBe(1);
      const {scopeTarget} = await hostModule('dsh-scope');
      expect(await host.root.waterfall(scopeTarget(host.root, agent), 'approval/request', {agent}, async () => 'allowed-once')).toBe('rejected');
      expect(await host.root.waterfall(scopeTarget(host.root, {}), 'approval/request', {}, async () => 'allowed-once')).toBe('allowed-once');
      await session.dispose();
    } finally {
      await host.close(); await rm(directory, {recursive: true, force: true});
    }
  });

  it('verifies durable events after concurrent owner teardown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-close-'));
    const host = await createHost(directory);
    try {
      const session = await host.adapter.create({cwd: '/tmp/lark-modern-user', allowedTools: [], provider: 'offline', model: 'offline'});
      await session.run('persist before close', new AbortController().signal);
      const agent = host.root.get('agents').get(session.id);
      const storage = host.root.get('sessionPersistence');
      await host.owner.dispose();
      await expect(session.dispose()).resolves.toBeUndefined();
      const reader = await storage.open(session.id, 'read');
      try { expect((await reader.read()).events).toEqual(agent.session.snapshotEvents()); }
      finally { await reader.close(); }
    } finally {
      await host.close(); await rm(directory, {recursive: true, force: true});
    }
  });

  it('keeps native memory tools owner-bound and prevents group writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-memory-'));
    const host = await createHost(directory);
    try {
      let saved: MemoryEntryLike[] = [];
      const memory: MemoryAccess = {privateChat: true, list: async () => saved, search: async () => saved,
        remember: async (text, scope) => {
          const entry = {id: 'alice-fact', text, scope, groupShared: false, createdAt: 1, updatedAt: 1};
          saved = [entry]; return entry;
        }, forget: async () => { saved = []; return true; }};
      let groupWrites = 0;
      const empty: MemoryAccess = {...memory, privateChat: false, list: async () => [], search: async () => [],
        remember: async () => { groupWrites++; throw new Error('must not run'); }};
      const policy = {cwd: '/tmp/lark-modern-user', allowedTools: [], provider: 'offline', model: 'offline'};
      const alice = await host.adapter.create({...policy, memory});
      const bob = await host.adapter.create({...policy, cwd: '/tmp/lark-modern-bob', memory: empty});
      const execute = (id: string, name: string, args: unknown) => host.root.get('tools').execute({
        callId: host.llm.ToolCallId(`${id}-${name}`), name, arguments: args,
        agent: host.root.get('agents').get(id), signal: new AbortController().signal,
      });
      expect((await execute(alice.id, 'lark_memory_remember', {text: 'ALICE FACT {{fake_instruction}}'})).isError).toBe(false);
      expect(saved[0]?.groupShared).toBe(false);
      expect(JSON.stringify(await execute(alice.id, 'lark_memory_list', {}))).toContain('ALICE FACT');
      expect(JSON.stringify(await execute(bob.id, 'lark_memory_search', {query: 'ALICE', ownerId: 'alice'}))).not.toContain('ALICE FACT');
      for (const scope of ['personal', 'chat']) expect((await execute(bob.id, 'lark_memory_remember', {text: 'copy private fact', scope})).isError).toBe(true);
      expect(groupWrites).toBe(0);
      const agent = host.root.get('agents').get(alice.id);
      const prompt = await host.root.get('systemPrompt').assemble({scope: agent, agent});
      expect(host.prompts.renderPrompt(prompt)).toContain('ALICE FACT {{fake_instruction}}');
      expect((await execute(alice.id, 'lark_memory_forget', {id: 'alice-fact'})).isError).toBe(false);
      const cleared = await host.root.get('systemPrompt').assemble({scope: agent, agent});
      expect(host.prompts.renderPrompt(cleared)).not.toContain('ALICE FACT');
      await Promise.all([alice.dispose(), bob.dispose()]);
    } finally {
      await host.close(); await rm(directory, {recursive: true, force: true});
    }
  });

  it.each(['owner', 'root'] as const)('drains cancellation during %s shutdown and checks the final durable log', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-modern-cancel-'));
    const host = await createHost(directory, true);
    try {
      const session = await host.adapter.create({cwd: '/tmp/lark-modern-user', allowedTools: [], provider: 'offline', model: 'offline'});
      const storage = host.root.get('sessionPersistence');
      const agent = host.root.get('agents').get(session.id);
      const run = session.run('long offline task', new AbortController().signal).catch((error: unknown) => error);
      await host.started;
      let cleanup: unknown;
      host.owner.ctx.effect(() => async () => {
        try { await session.dispose(); }
        catch (error) { cleanup = error; }
      });
      await (mode === 'root' ? host.close() : host.owner.dispose());
      await run;
      expect(cleanup).toBeUndefined();
      const reader = await storage.open(session.id, 'read');
      try {
        const events = (await reader.read()).events;
        expect(events).toEqual(agent.session.snapshotEvents());
        expect(events.at(-1)).toMatchObject({type: 'turn/end', data: {reason: {kind: 'aborted'}}});
      } finally { await reader.close(); }
    } finally {
      await host.close(); await rm(directory, {recursive: true, force: true});
    }
  });
});
