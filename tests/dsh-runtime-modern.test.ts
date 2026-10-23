import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MemoryAccess, MemoryEntryLike } from '../src/dsh-runtime.js';

// Optional real-host contract suite. DSH_MODERN_HOST_ROOT is an isolated copy
// of the App's dependency tree with the compiled dsh-runtime.js at its root.
// No real profiles, network adapters, credentials, or model calls are used.
const hostRoot = process.env.DSH_MODERN_HOST_ROOT;
const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(hostRoot!, path)).href);
const hostModule = (name: string) => load(`node_modules/@deepseek-ai/${name}/lib/index.js`);

describe.skipIf(!hostRoot)('DshRuntime with the official 0.2 host', () => {
  async function createHost(directory: string, blocked = false) {
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
    return {root, owner, adapter: adapter!, requests, started, runtime, prompts, tools, llm, close: () => root.fiber.dispose()};
  }

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
