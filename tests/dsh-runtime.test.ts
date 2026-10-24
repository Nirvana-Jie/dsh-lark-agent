import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import { DshRuntime, DshRuntimeError, checkRuntimeCompatibility, type AgentPolicy, type ApprovalPrompt, type MemoryAccess, type MemoryEntryLike, type ModelSelection, type UserQuestion } from '../src/dsh-runtime.js';

const basePolicy: AgentPolicy = { cwd: '/tmp/dsh-lark-test', allowedTools: [] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const listeners = new Set<(session: Session, event: SessionEvent) => void>();
  const session = { id: 'test-session', header: {cwd: basePolicy.cwd}, events: [] } as unknown as Session;
  const tools = {
    presentAs: vi.fn(),
    restrict: vi.fn(),
    guard: vi.fn<(guard: ToolGuard) => void>(),
    register: vi.fn(),
  };
  const prompt = { section: vi.fn(), suppressRuntimeContext: vi.fn(), variable: vi.fn() };
  const scopedOn = vi.fn();
  const agentCtx = { get: vi.fn((name: string) => name === 'tools' ? tools : name === 'systemPrompt' ? prompt : undefined), on: scopedOn } as unknown as Context;
  const agent = {
    id: session.id,
    session,
    ctx: agentCtx,
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(() => Promise.resolve()),
  };
  Object.assign(agentCtx, {agent});
  const handle = { agent: agent as unknown as Agent, dispose: vi.fn(() => Promise.resolve()) } satisfies AgentHandle;
  const create = vi.fn(async (options: CreateAgentOptions) => {
    await options.setup?.(agentCtx);
    return handle;
  });
  const resume = vi.fn(async (options: ResumeAgentOptions) => {
    await options.setup?.(agentCtx);
    return handle;
  });
  const removeListener = vi.fn();
  const on = vi.fn((_name: string, listener: (session: Session, event: SessionEvent) => void) => {
    listeners.add(listener);
    return () => { removeListener(); listeners.delete(listener); };
  });
  const currentSelection = vi.fn<() => ModelSelection>(() => ({provider: 'host-provider', model: 'host-model'}));
  const flush = vi.fn(async () => true);
  const get = vi.fn((name: string): unknown => name === 'agentDefaultModel' ? {currentSelection} : name === 'sessions' ? {flush} : undefined);
  const ctx = { agents: { create, resume }, on, get } as unknown as Context;
  const emit = (event: unknown, source = session) => {
    for (const listener of listeners) listener(source, event as SessionEvent);
  };
  const text = (value: string, source = session) => emit({
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: value }] } },
  }, source);
  return { runtime: new DshRuntime(ctx), create, resume, flush, tools, prompt, scopedOn, agent, handle, emit, text, session, removeListener, on, get, currentSelection };
}

function modelFixture() {
  const f = fixture();
  const catalog = [
    {provider: 'host-provider', id: 'host-model', name: 'Host Model', reasoning: {
      efforts: [{id: 'quick', name: 'Quick'}, {id: 'deep', name: 'Deep', description: 'More careful'}], defaultEffort: 'quick',
    }},
    {provider: 'host-provider', id: 'plain-model', name: 'Plain Model'},
  ];
  const llm = {
    listProviders: vi.fn(() => [{id: 'host-provider', name: 'Configured provider', privateEndpoint: 'PRIVATE_ENDPOINT'}]),
    listModels: vi.fn(async () => catalog),
    resolveModelInfo: vi.fn(async (provider: string, model: string) => ({
      ...catalog.find(item => item.id === model)!, provider, id: model, apiKey: 'PRIVATE_KEY',
    })),
    resolveCallConfig: vi.fn(async (selection: ModelSelection) => {
      const info = catalog.find(item => item.id === selection.model);
      const effort = selection.reasoningEffort ?? info?.reasoning?.defaultEffort;
      if (effort !== undefined && !info?.reasoning?.efforts.some(item => item.id === effort)) throw new Error('PRIVATE_PROVIDER_ERROR');
      return {...selection, ...(effort === undefined ? {} : {reasoningEffort: effort}), apiKey: 'PRIVATE_KEY'};
    }),
  };
  const originalGet = f.get.getMockImplementation()!;
  f.get.mockImplementation(name => name === 'llm' ? llm : originalGet(name));
  return {...f, llm, catalog};
}

describe('chat-owned model selection', () => {
  it('lists only registered model and reasoning metadata and materializes the host default', async () => {
    const f = modelFixture();
    expect(await f.runtime.catalog()).toEqual({models: [
      {provider: 'host-provider', providerName: 'Configured provider', model: 'host-model', name: 'Host Model',
        reasoning: {efforts: [{id: 'quick', name: 'Quick'}, {id: 'deep', name: 'Deep', description: 'More careful'}], defaultEffort: 'quick'}},
      {provider: 'host-provider', providerName: 'Configured provider', model: 'plain-model', name: 'Plain Model'},
    ], defaultSelection: {provider: 'host-provider', model: 'host-model', reasoningEffort: 'quick'}});
    expect(JSON.stringify(await f.runtime.catalog())).not.toContain('PRIVATE');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('coalesces concurrent menu reads and returns detached successful metadata for 30 seconds', async () => {
    const f = modelFixture();
    const gate = deferred();
    const resolveInfo = f.llm.resolveModelInfo.getMockImplementation()!;
    f.llm.resolveModelInfo.mockImplementation(async (provider, model) => {
      await gate.promise;
      return resolveInfo(provider, model);
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const readings = Array.from({length: 12}, () => f.runtime.catalog());
      expect(f.llm.listModels).toHaveBeenCalledTimes(1);
      gate.resolve();
      const catalogs = await Promise.all(readings);
      expect(f.llm.resolveModelInfo).toHaveBeenCalledTimes(2);
      expect(f.llm.resolveCallConfig).toHaveBeenCalledTimes(1);
      catalogs[0]!.models[0]!.reasoning!.efforts[0]!.name = 'caller mutation';
      catalogs[0]!.defaultSelection!.model = 'caller mutation';
      expect(catalogs[1]!.models[0]!.reasoning!.efforts[0]!.name).toBe('Quick');
      expect((await f.runtime.catalog()).defaultSelection?.model).toBe('host-model');
      now.mockReturnValue(39_999);
      await f.runtime.catalog();
      expect(f.llm.listModels).toHaveBeenCalledTimes(1);
      now.mockReturnValue(40_000);
      await f.runtime.catalog();
      expect(f.llm.listModels).toHaveBeenCalledTimes(2);
      expect(f.llm.resolveModelInfo).toHaveBeenCalledTimes(4);
    } finally {now.mockRestore();}
  });

  it('invalidates cached metadata immediately when the host default or provider directory changes', async () => {
    const f = modelFixture();
    await f.runtime.catalog();
    f.currentSelection.mockReturnValue({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect((await f.runtime.catalog()).defaultSelection?.reasoningEffort).toBe('deep');
    expect(f.llm.listModels).toHaveBeenCalledTimes(2);
    f.llm.listProviders.mockReturnValue([{id: 'host-provider', name: 'Updated label', privateEndpoint: 'PRIVATE_ENDPOINT'}]);
    expect((await f.runtime.catalog()).models[0]?.providerName).toBe('Updated label');
    expect(f.llm.listModels).toHaveBeenCalledTimes(3);
  });

  it('does not reuse cached metadata after the host model service is replaced', async () => {
    const f = modelFixture();
    await f.runtime.catalog();
    const originalGet = f.get.getMockImplementation()!;
    const replacement = {...f.llm, listModels: vi.fn(async () => []), resolveCallConfig: vi.fn(async (selection: ModelSelection) => selection)};
    f.get.mockImplementation(name => name === 'llm' ? replacement : originalGet(name));
    expect((await f.runtime.catalog()).models).toEqual([]);
    expect(replacement.listModels).toHaveBeenCalledTimes(1);
    expect(f.llm.listModels).toHaveBeenCalledTimes(1);
  });

  it('validates model membership and thinking live even when the menu catalog is cached', async () => {
    const f = modelFixture();
    await f.runtime.catalog();
    f.catalog[0]!.reasoning!.efforts.splice(1, 1);
    await expect(f.runtime.resolveModelSelection({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'}))
      .rejects.toMatchObject({code: 'INVALID_MODEL_SELECTION'});
    expect((await f.runtime.catalog()).models[0]!.reasoning!.efforts).toHaveLength(1);
    f.catalog.splice(1, 1);
    await expect(f.runtime.resolveModelSelection({provider: 'host-provider', model: 'plain-model'}))
      .rejects.toMatchObject({code: 'INVALID_MODEL_SELECTION'});
    expect((await f.runtime.catalog()).models).toHaveLength(1);
    expect(f.llm.listModels).toHaveBeenCalledTimes(5);
  });

  it('does not let an older in-flight catalog repopulate the cache after a rejected live choice', async () => {
    const f = modelFixture();
    const gate = deferred();
    const resolveInfo = f.llm.resolveModelInfo.getMockImplementation()!;
    f.llm.resolveModelInfo.mockImplementationOnce(async (provider, model) => {
      await gate.promise;
      return {...await resolveInfo(provider, model), name: 'Old pending result'};
    });
    const older = f.runtime.catalog();
    await vi.waitFor(() => expect(f.llm.resolveModelInfo).toHaveBeenCalledTimes(2));
    await expect(f.runtime.resolveModelSelection({provider: 'host-provider', model: 'removed-model'}))
      .rejects.toMatchObject({code: 'INVALID_MODEL_SELECTION'});
    const current = await f.runtime.catalog();
    gate.resolve();
    expect((await older).models[0]?.name).toBe('Old pending result');
    expect((await f.runtime.catalog()).models).toEqual(current.models);
    expect(f.llm.listModels).toHaveBeenCalledTimes(3);
  });

  it('retries partial metadata failures instead of caching an incomplete menu', async () => {
    const f = modelFixture();
    f.llm.resolveModelInfo.mockRejectedValueOnce(new Error('PRIVATE_TRANSIENT_ERROR'));
    expect((await f.runtime.catalog()).models).toHaveLength(1);
    expect((await f.runtime.catalog()).models).toHaveLength(2);
    expect(f.llm.listModels).toHaveBeenCalledTimes(2);
    await f.runtime.catalog();
    expect(f.llm.listModels).toHaveBeenCalledTimes(2);
  });

  it('retries a failed provider read and failed default resolution instead of caching either result', async () => {
    const f = modelFixture();
    f.llm.listModels.mockRejectedValueOnce(new Error('PRIVATE_DIRECTORY_ERROR'));
    expect((await f.runtime.catalog()).models).toEqual([]);
    f.llm.resolveCallConfig.mockRejectedValueOnce(new Error('PRIVATE_DEFAULT_ERROR'));
    expect((await f.runtime.catalog()).defaultSelection).toBeUndefined();
    expect((await f.runtime.catalog()).defaultSelection?.reasoningEffort).toBe('quick');
    expect(f.llm.listModels).toHaveBeenCalledTimes(3);
  });

  it('cancels one catalog waiter without cancelling another chat or poisoning the cache', async () => {
    const f = modelFixture();
    const gate = deferred();
    const listModels = f.llm.listModels.getMockImplementation()!;
    f.llm.listModels.mockImplementation(async () => {await gate.promise; return listModels();});
    const controller = new AbortController();
    const cancelled = f.runtime.catalog(controller.signal);
    const other = f.runtime.catalog();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({code: 'CANCELLED'});
    gate.resolve();
    expect((await other).models).toHaveLength(2);
    await f.runtime.catalog();
    expect(f.llm.listModels).toHaveBeenCalledTimes(1);
  });

  it('keeps the default selected effort instead of replacing it with the adapter default', async () => {
    const f = modelFixture();
    f.currentSelection.mockReturnValue({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect(await f.runtime.resolveModelSelection()).toEqual({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    const session = await f.runtime.create(basePolicy);
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
  });

  it.each([
    {provider: 'unknown', model: 'host-model'},
    {provider: 'host-provider', model: 'not-listed'},
    {provider: 'host-provider', model: 'host-model', reasoningEffort: 'unsupported'},
    {provider: 'host-provider', model: 'plain-model', reasoningEffort: 'deep'},
  ])('rejects unavailable explicit menu choice %j without creating or running an agent', async selection => {
    const f = modelFixture();
    const error = await f.runtime.resolveModelSelection(selection).catch(error => error as DshRuntimeError);
    expect(error).toMatchObject({code: 'INVALID_MODEL_SELECTION'});
    expect((error as DshRuntimeError).message).not.toContain('PRIVATE');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.agent.followup).not.toHaveBeenCalled();
  });

  it('can capture an administrator default absent from a catalog without allowing arbitrary menu routes', async () => {
    const f = modelFixture();
    f.currentSelection.mockReturnValue({provider: 'host-provider', model: 'custom-model'});
    expect(await f.runtime.resolveModelSelection()).toEqual({provider: 'host-provider', model: 'custom-model'});
    await expect(f.runtime.resolveModelSelection({provider: 'host-provider', model: 'custom-model'}))
      .rejects.toMatchObject({code: 'INVALID_MODEL_SELECTION'});
    expect((await f.runtime.create({...basePolicy, provider: 'host-provider', model: 'custom-model'})).modelSelection!())
      .toEqual({provider: 'host-provider', model: 'custom-model'});
  });

  it('clears the old effort when switching to a model without reasoning controls', async () => {
    const f = modelFixture();
    f.currentSelection.mockReturnValue({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    const session = await f.runtime.create(basePolicy);
    const choice = await f.runtime.resolveModelSelection({provider: 'host-provider', model: 'plain-model'});
    session.setModelSelection!(choice);
    const assemble = f.scopedOn.mock.calls.find(([name]) => name === 'system-prompt/assemble')![1];
    const request = f.scopedOn.mock.calls.find(([name]) => name === 'agent/request')![1];
    const currentPrompt = f.prompt.variable.mock.calls.find(([name]) => name === 'lark_model')![1] as () => string;
    await session.run('Which model?', new AbortController().signal);
    await assemble({}, {}, async () => ({variables: {}}));
    const resolved = await request({}, async () => ({provider: 'inherited', model: 'inherited', reasoningEffort: 'deep', maxTokens: 1000}));
    expect(resolved).toEqual({provider: 'host-provider', model: 'plain-model', maxTokens: 1000});
    expect(JSON.parse(currentPrompt())).toEqual({provider: 'host-provider', model: 'plain-model', reasoningEffort: null});
    expect(session.id).toBe(f.session.id);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.currentSelection()).toEqual({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
  });

  it('keeps detached choices per session and injects authoritative current model facts', async () => {
    const f = modelFixture();
    const session = await f.runtime.create(basePolicy);
    const requested = {provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'};
    session.setModelSelection!(requested);
    requested.model = 'mutated';
    const returned = session.modelSelection!(); returned.provider = 'mutated';
    f.currentSelection.mockReturnValue({provider: 'another-provider', model: 'another-model'});
    const currentPrompt = f.prompt.variable.mock.calls.find(([name]) => name === 'lark_model')![1] as () => string;
    await session.run('Which model?', new AbortController().signal);
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect(JSON.parse(currentPrompt())).toEqual(session.modelSelection!());
    expect(f.prompt.section.mock.calls[0]![0].text).toContain('宿主为当前回复确定的模型信息');
  });

  it('refuses to mutate a busy or disposed agent', async () => {
    const f = modelFixture();
    const pending = deferred();
    f.agent.whenIdle.mockReturnValue(pending.promise);
    const session = await f.runtime.create(basePolicy);
    const turn = session.run('running', new AbortController().signal);
    const next = {provider: 'host-provider', model: 'plain-model'};
    expect(() => session.setModelSelection!(next)).toThrowError(expect.objectContaining({code: 'BUSY'}));
    pending.resolve(); await turn; await session.dispose();
    expect(() => session.setModelSelection!(next)).toThrowError(expect.objectContaining({code: 'DISPOSED'}));
  });

  it('resumes the stored choice without falling back to a changed host default', async () => {
    const f = modelFixture();
    f.currentSelection.mockReturnValue({provider: 'other', model: 'other'});
    const session = await f.runtime.resume({...basePolicy, provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'},
      'd2b65f56-95f1-4752-b733-4b5220b865f1');
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect(f.currentSelection).not.toHaveBeenCalled();
    expect(f.resume.mock.calls[0]![0].agentOptions).toEqual({provider: 'host-provider', model: 'host-model'});
  });

  it('excludes malformed effort metadata and isolates one failed provider from others', async () => {
    const f = modelFixture();
    f.llm.listProviders.mockReturnValue([{id: 'unavailable', name: 'Unavailable', privateEndpoint: ''},
      {id: 'host-provider', name: 'Configured provider', privateEndpoint: ''}]);
    f.llm.listModels.mockRejectedValueOnce(new Error('PRIVATE_ERROR'));
    f.catalog[0]!.reasoning!.efforts.push({id: 'quick', name: 'Duplicate'});
    const result = await f.runtime.catalog();
    expect(result.models).toEqual([{provider: 'host-provider', providerName: 'Configured provider', model: 'plain-model', name: 'Plain Model'}]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('cancels model reads promptly without echoing provider errors', async () => {
    const f = modelFixture();
    const aborted = new AbortController(); aborted.abort();
    await expect(f.runtime.catalog(aborted.signal)).rejects.toMatchObject({code: 'CANCELLED'});
    expect(f.llm.listModels).not.toHaveBeenCalled();
    f.llm.listModels.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const reading = f.runtime.catalog(controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({code: 'CANCELLED'});
  });
});

describe('DshRuntime', () => {
  it('reports missing host capabilities without creating agents or reading persistence', () => {
    const f = fixture();
    const readFrom = vi.fn();
    const services = {agents: {create: f.create, resume: f.resume}, tools: f.tools, sessions: {flush: f.flush},
      systemPrompt: f.prompt, sessionPersistence: {readFrom}};
    const context = {get: (name: string) => services[name as keyof typeof services]} as unknown as Context;
    expect(checkRuntimeCompatibility(context)).toEqual({supported: true, family: 'legacy', missing: []});
    Object.assign(f.tools, {guard: undefined});
    expect(checkRuntimeCompatibility(context)).toMatchObject({supported: false, family: 'unsupported', missing: ['tools.guard']});
    expect(f.create).not.toHaveBeenCalled();
    expect(f.prompt.section).not.toHaveBeenCalled();
    expect(readFrom).not.toHaveBeenCalled();
  });

  it.each(['complete', 'missing-event', 'wrong-owner', 'read-failure', 'close-failure'] as const)('checks modern durable snapshots and closes readers (%s)', async mode => {
    const f = fixture();
    const events = [{seq: 0, type: 'session/end-seed', data: {}}] as unknown as SessionEvent[];
    const snapshotEvents = vi.fn(() => [...events]);
    Object.assign(f.session, {events: undefined, snapshotEvents});
    const reader = {
      header: {id: f.session.id, cwd: mode === 'wrong-owner' ? '/tmp/other-owner' : basePolicy.cwd},
      read: vi.fn(async () => {
        if (mode === 'read-failure') throw new Error('private backend diagnostic');
        return {events: mode === 'missing-event' ? [] : [...events]};
      }),
      close: vi.fn(async () => { if (mode === 'close-failure') throw new Error('private backend diagnostic'); }),
    };
    const open = vi.fn(async () => reader);
    f.get.mockImplementation(name => name === 'sessionPersistence' ? {open} : name === 'sessions' ? {flush: f.flush}
      : name === 'agentDefaultModel' ? {currentSelection: f.currentSelection} : undefined);
    const runtime = await f.runtime.create(basePolicy);
    f.flush.mockRejectedValue(new Error('native session already detached'));
    if (mode === 'complete') await expect(runtime.dispose()).resolves.toBeUndefined();
    else await expect(runtime.dispose()).rejects.toMatchObject({code: 'PERSISTENCE_FAILED'});
    expect(open).toHaveBeenCalledWith(f.session.id, 'read');
    expect(reader.read).toHaveBeenCalledWith(0);
    expect(reader.close).toHaveBeenCalledOnce();
    expect(f.handle.dispose.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
  });

  it('materializes a new empty native log before its catalog can be published', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    expect(f.create.mock.calls[0]![0].seed).toEqual([]);
    await runtime.checkpoint();
    expect(f.flush).toHaveBeenCalledWith(f.session);
  });

  it('resumes the exact native session with current guards and no create fallback', async () => {
    const f = fixture();
    const id = 'd2b65f56-95f1-4752-b733-4b5220b865f1';
    await f.runtime.resume(basePolicy, id);
    expect(f.resume.mock.calls[0]![0]).toMatchObject({resumeSessionId: id, agentOptions: {provider: 'host-provider', model: 'host-model'}});
    expect(f.create).not.toHaveBeenCalled();
    expect(f.tools.restrict).toHaveBeenCalledWith({allow: []});
    expect(f.prompt.suppressRuntimeContext).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'corrupt', 'wrong version'])('keeps a %s native session mapped instead of silently creating a replacement', async (reason) => {
    const f = fixture();
    f.resume.mockRejectedValue(new Error(reason));
    await expect(f.runtime.resume(basePolicy, 'd2b65f56-95f1-4752-b733-4b5220b865f1')).rejects.toMatchObject({code: 'RESTORE_FAILED'});
    expect(f.create).not.toHaveBeenCalled();
  });

  it('rejects a persisted workspace mismatch before publishing the resumed agent', async () => {
    const f = fixture();
    await expect(f.runtime.resume({...basePolicy, cwd: '/tmp/another-user'}, 'd2b65f56-95f1-4752-b733-4b5220b865f1')).rejects.toMatchObject({code: 'RESTORE_FAILED'});
    expect(f.tools.guard).not.toHaveBeenCalled();
  });

  it('does not confirm a turn before native persistence has drained', async () => {
    const f = fixture();
    const persistence = deferred();
    f.flush.mockImplementation(async () => { await persistence.promise; return true; });
    f.agent.followup.mockImplementation(() => { f.text('durable result'); });
    const runtime = await f.runtime.create(basePolicy);
    let complete = false;
    const pending = runtime.run('question', new AbortController().signal).then(value => { complete = true; return value; });
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
    expect(complete).toBe(false);
    persistence.resolve();
    await expect(pending).resolves.toBe('durable result');
  });

  it('fails closed when no durable backend participates or its flush fails', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    f.flush.mockResolvedValue(false);
    await expect(runtime.checkpoint()).rejects.toMatchObject({code: 'PERSISTENCE_FAILED'});
    await expect(runtime.run('question', new AbortController().signal)).rejects.toMatchObject({code: 'PERSISTENCE_FAILED'});
    f.flush.mockRejectedValue(new Error('private disk path'));
    await expect(runtime.checkpoint()).rejects.toMatchObject({code: 'PERSISTENCE_FAILED'});
  });

  it('replaces the complete memory snapshot on each turn without adding user-role memory messages', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    const value = f.prompt.variable.mock.calls[0]![1] as () => string;
    await runtime.run('one', new AbortController().signal, {memoryText: 'private preference {{unknown}}'});
    expect(value()).toContain('private preference {{unknown}}');
    expect(f.agent.followup.mock.calls[0]![0]).toMatchObject({content: [{type: 'text', text: 'one'}]});
    await runtime.run('two', new AbortController().signal, {memoryText: ''});
    expect(value()).toBe('[]');
    await runtime.run('three', new AbortController().signal);
    expect(value()).toBe('[]');
  });

  it('registers only owner-bound memory capabilities and never forwards model-supplied identity selectors', async () => {
    const f = fixture();
    const entry: MemoryEntryLike = {id: 'memory-one', scope: 'personal', groupShared: false, text: 'prefers Chinese', createdAt: 1, updatedAt: 1};
    let current: MemoryEntryLike[] = [];
    const memory: MemoryAccess = {
      privateChat: true,
      list: vi.fn(async () => current), search: vi.fn(async () => current),
      remember: vi.fn(async () => { current = [entry]; return entry; }),
      forget: vi.fn(async () => { current = []; return true; }),
    };
    await f.runtime.create({...basePolicy, memory});
    const definitions = new Map(f.tools.register.mock.calls.map(([tool]) => [tool.name, tool]));
    expect([...definitions.keys()]).toEqual(['lark_memory_list', 'lark_memory_search', 'lark_memory_remember', 'lark_memory_forget']);
    const exec = {signal: new AbortController().signal};
    await definitions.get('lark_memory_remember')!.execute({text: entry.text, userId: 'another-user', chatId: 'another-chat', groupShared: true}, exec);
    expect(memory.remember).toHaveBeenCalledWith(entry.text, 'personal');
    const snapshot = f.prompt.variable.mock.calls[0]![1] as () => string;
    expect(snapshot()).toContain(entry.text);
    await definitions.get('lark_memory_forget')!.execute({id: entry.id, userId: 'another-user'}, exec);
    expect(memory.forget).toHaveBeenCalledWith(entry.id);
    expect(snapshot()).not.toContain(entry.text);
    const guard = f.tools.guard.mock.calls[0]![0];
    expect(guard({name: 'lark_memory_remember'} as ToolExecution)).toBeUndefined();
    expect(guard({name: 'bash'} as ToolExecution)).toBeTruthy();
    expect(f.tools.restrict).toHaveBeenCalledWith({allow: []});
  });

  it('stages validated presentation only within its active turn and keeps external tools denied', async () => {
    const f = fixture();
    const runtime = await f.runtime.create({...basePolicy, presentation: true});
    const tool = f.tools.register.mock.calls.find(([tool]) => tool.name === 'lark_present')![0];
    const args = {kind: 'chart', title: '示例', summary: '只用于离线测试的示例数据。', content: JSON.stringify({type: 'bar', series: ['计数'], data: [{label: 'A', values: [1]}]})};
    const signal = new AbortController().signal;
    await expect(tool.execute(args, {signal})).rejects.toThrow();
    f.agent.whenIdle.mockImplementationOnce(async () => {await tool.execute(args, {signal}); f.text('这是示例。');});
    const result = await runtime.run('给我图表', signal, {artifactsText: '[{"id":"abcdef123456","title":"old"}]'});
    expect(result).toMatchObject({text: '这是示例。', artifacts: [{kind: 'chart', content: {data: [{label: 'A', values: [1]}]}}]});
    expect(await runtime.run('普通聊天', signal)).toBe('');
    const variable = f.prompt.variable.mock.calls.find(([name]) => name === 'lark_results')![1] as () => string;
    expect(variable()).toBe('[]');
    const guard = f.tools.guard.mock.calls[0]![0];
    expect(guard({name: 'lark_present'} as ToolExecution)).toBeUndefined();
    expect(guard({name: 'bash'} as ToolExecution)).toBeTruthy();
    expect(f.tools.restrict).toHaveBeenCalledWith({allow: []});
  });

  it('does not release staged artifacts when cancellation or native persistence fails', async () => {
    const f = fixture(), runtime = await f.runtime.create({...basePolicy, presentation: true});
    const tool = f.tools.register.mock.calls.find(([tool]) => tool.name === 'lark_present')![0];
    const aborter = new AbortController();
    f.agent.whenIdle.mockImplementationOnce(async () => {
      await tool.execute({kind: 'report', title: '示例', summary: '离线测试中的临时作品。', content: '{"sections":[{"heading":"标题","body":"内容"}]}'}, {signal: aborter.signal});
      aborter.abort();
    });
    await expect(runtime.run('取消', aborter.signal)).rejects.toMatchObject({code: 'CANCELLED'});
    expect(await runtime.run('下一轮', new AbortController().signal)).toBe('');
  });

  it('does not grant memory tools to agents without a bound memory capability', async () => {
    const f = fixture();
    await f.runtime.create(basePolicy);
    const guard = f.tools.guard.mock.calls[0]![0];
    expect(guard({name: 'lark_memory_list'} as ToolExecution)).toBeTruthy();
    expect(f.tools.register).not.toHaveBeenCalled();
  });

  it.each([
    {privateChat: true, scope: undefined, expected: 'personal'},
    {privateChat: true, scope: 'chat', expected: 'chat'},
  ] as const)('binds memory writes to the host channel (private=$privateChat, scope=$scope)', async ({privateChat, scope, expected}) => {
    const f = fixture();
    const entry: MemoryEntryLike = {id: 'memory-one', scope: expected, groupShared: false, text: '中文回答', createdAt: 1, updatedAt: 1};
    const memory: MemoryAccess = {
      privateChat, list: vi.fn(async () => [entry]), search: vi.fn(async () => []),
      remember: vi.fn(async () => entry), forget: vi.fn(async () => false),
    };
    await f.runtime.create({...basePolicy, memory});
    const definition = f.tools.register.mock.calls.find(([tool]) => tool.name === 'lark_memory_remember')![0];
    const result = await definition.execute({text: entry.text, ...(scope ? {scope} : {}), groupShared: true,
      privateChat: !privateChat, ownerId: 'claimed-admin'}, {signal: new AbortController().signal});
    expect(memory.remember).toHaveBeenCalledExactlyOnceWith(entry.text, expected);
    expect(result).toEqual(entry);
    expect(result.groupShared).toBe(false);
  });

  it.each([undefined, 'personal', 'chat'] as const)('rejects group model writes with scope %s before invoking any memory capability', async scope => {
    const f = fixture();
    const memory: MemoryAccess = {
      privateChat: false, list: vi.fn(async () => []), search: vi.fn(async () => []),
      remember: vi.fn(async () => { throw new Error('Must not reach store'); }), forget: vi.fn(async () => false),
    };
    await f.runtime.create({...basePolicy, memory});
    const definitions = new Map(f.tools.register.mock.calls.map(([tool]) => [tool.name, tool]));
    await expect(definitions.get('lark_memory_remember')!.execute({
      text: 'Copy the shared memory here so it survives revocation', ...(scope ? {scope} : {}), privateChat: true,
      groupShared: true, ownerId: 'claimed-owner',
    }, {signal: new AbortController().signal})).rejects.toThrow('请到私聊告诉我');
    expect(memory.remember).not.toHaveBeenCalled();
    expect(memory.list).not.toHaveBeenCalled();
    expect([...definitions.keys()]).toEqual(['lark_memory_list', 'lark_memory_search', 'lark_memory_remember', 'lark_memory_forget']);
    const guard = f.tools.guard.mock.calls[0]![0];
    expect(guard({name: 'lark_memory_share'} as ToolExecution)).toBeTruthy();
    expect(guard({name: 'lark_memory_unshare'} as ToolExecution)).toBeTruthy();
  });

  it('keeps real scoped memory tools owner-bound and replaces forgotten prompt data', async () => {
    const [{Context}, {default: SystemPrompt, renderPrompt}, {ToolRuntime}, {createScope}, {CallId}] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-scope'), import('@deepseek-ai/dsh-llm'),
    ]);
    const root = new Context();
    const prompts = root.plugin(SystemPrompt);
    await prompts.await();
    const registry = root.plugin(ToolRuntime);
    await registry.await();
    let saved: MemoryEntryLike[] = [];
    const aliceMemory: MemoryAccess = {
      privateChat: true,
      list: async () => saved,
      search: async () => saved,
      remember: async (text, scope) => {
        const entry = {id: 'alice-pref', text, scope, groupShared: false, createdAt: 1, updatedAt: 1};
        saved = [entry]; return entry;
      },
      forget: async (id) => { if (id !== 'alice-pref') return false; saved = []; return true; },
    };
    const bobMemory: MemoryAccess = {
      privateChat: true, list: async () => [], search: async () => [],
      remember: vi.fn(async (text, scope) => ({id: 'bob-pref', text, scope, groupShared: false, createdAt: 1, updatedAt: 1})),
      forget: vi.fn(async () => false),
    };
    const alice = fixture();
    const bob = fixture();
    const aliceRuntime = await alice.runtime.create({...basePolicy, memory: aliceMemory});
    await bob.runtime.create({...basePolicy, memory: bobMemory});
    const aliceScope = createScope(root, alice.agent);
    const bobScope = createScope(root, bob.agent);
    try {
      await alice.create.mock.calls[0]![0].setup?.(aliceScope.ctx);
      await bob.create.mock.calls[0]![0].setup?.(bobScope.ctx);
      const execute = (agent: typeof alice.agent, name: string, args = {}) => root.tools.execute({
        agent: agent as unknown as Agent, callId: CallId(name), name, arguments: args, signal: new AbortController().signal,
      });
      expect(root.tools.schemas()).toHaveLength(0);
      expect(root.tools.schemas(alice.agent).map(tool => tool.name)).toHaveLength(4);
      const result = await execute(alice.agent, 'lark_memory_remember', {text: 'Alice {{secret_template}}', scope: 'personal', userId: 'bob'});
      expect(result.isError).toBe(false);
      expect(bobMemory.remember).not.toHaveBeenCalled();
      const aliceAssembly = await root.systemPrompt.assemble({scope: alice.agent});
      expect(renderPrompt(aliceAssembly)).toContain('Alice {{secret_template}}');
      expect(renderPrompt(await root.systemPrompt.assemble({scope: bob.agent}))).not.toContain('Alice');
      const bobLookup = await execute(bob.agent, 'lark_memory_list', {userId: 'alice'});
      expect(bobLookup).toMatchObject({isError: false, value: {items: [], total: 0, hasMore: false}});
      await execute(bob.agent, 'lark_memory_forget', {id: 'alice-pref'});
      expect(saved).toHaveLength(1);
      await execute(alice.agent, 'lark_memory_forget', {id: 'alice-pref'});
      expect(saved).toHaveLength(0);
      expect(renderPrompt(await root.systemPrompt.assemble({scope: alice.agent}))).not.toContain('Alice {{secret_template}}');
      await aliceRuntime.run('plain input', new AbortController().signal, {memoryText: '{{unknown_input}}'});
      expect(renderPrompt(await root.systemPrompt.assemble({scope: alice.agent}))).toContain('{{unknown_input}}');
    } finally {
      await aliceScope.dispose(); await bobScope.dispose(); await registry.dispose(); await prompts.dispose();
    }
  });

  it('bounds memory list and search outputs while exposing truncation', async () => {
    const f = fixture();
    const entries: MemoryEntryLike[] = Array.from({length: 25}, (_, index) => ({id: String(index), text: `Fact ${index}`, scope: 'personal', groupShared: false, createdAt: index, updatedAt: index}));
    const memory: MemoryAccess = {privateChat: true, list: async () => entries, search: async () => entries, remember: async () => entries[0]!, forget: async () => false};
    await f.runtime.create({...basePolicy, memory});
    const definitions = new Map(f.tools.register.mock.calls.map(([tool]) => [tool.name, tool]));
    const exec = {signal: new AbortController().signal};
    for (const [name, args] of [['lark_memory_list', {}], ['lark_memory_search', {query: 'Fact'}]] as const) {
      const result = await definitions.get(name)!.execute(args, exec);
      expect(result).toMatchObject({total: 25, hasMore: true});
      expect(result.items).toHaveLength(20);
    }
  });

  it('checkpoints and restores actual JSONL sessions, preserving dialogue but not replaying old memory headers', async () => {
    const [{Context}, {SessionStore}, {JsonlSessionPersistence}, {createUserMessage}, fs, os, path] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-persistence-jsonl'),
      import('@deepseek-ai/dsh-llm'), import('node:fs/promises'), import('node:os'), import('node:path'),
    ]);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lark-native-'));
    const hosts: Array<{close(): Promise<void>}> = [];
    const host = async () => {
      const root = new Context();
      const sessionsPlugin = root.plugin(SessionStore);
      await sessionsPlugin.await();
      const persistencePlugin = root.plugin(JsonlSessionPersistence, {root: directory, compression: 'none'});
      await persistencePlugin.await();
      const sessions = root.get('sessions') as InstanceType<typeof SessionStore>;
      const persistence = root.get('sessionPersistence') as InstanceType<typeof JsonlSessionPersistence>;
      const f = fixture();
      f.get.mockImplementation((name) => name === 'sessions' ? sessions : name === 'agentDefaultModel' ? {currentSelection: f.currentSelection} : undefined);
      let detach: (() => void) | undefined;
      const publish = async (session: Session, setup?: CreateAgentOptions['setup']) => {
        Object.assign(f.agent, {id: session.id, session});
        await setup?.(f.agent.ctx);
        detach = sessions.enter(session);
        sessions.announce(session);
        return f.handle;
      };
      f.create.mockImplementation(async options => publish(sessions.prepare(options.sessionId, {seed: options.seed, meta: options.meta}), options.setup));
      f.resume.mockImplementation(async options => {
        const preparation = await persistence.prepare(options.resumeSessionId);
        try { return await publish(preparation.session, options.setup); }
        finally { preparation[Symbol.dispose](); }
      });
      f.handle.dispose.mockImplementation(async () => { detach?.(); detach = undefined; });
      let closed = false;
      const result = {...f, sessions, persistence, async close() {
        if (closed) return;
        closed = true;
        await persistencePlugin.dispose();
        await sessionsPlugin.dispose();
      }};
      hosts.push(result);
      return result;
    };
    try {
      const first = await host();
      const runtime = await first.runtime.create(basePolicy);
      await runtime.checkpoint();
      expect((await first.persistence.list()).map(header => header.id)).toContain(runtime.id);
      const original = first.agent.session;
      expect(original.events.map(event => event.type)).toEqual(['session/end-seed']);
      original.append('turn/start', {turn: 1});
      original.append('user/message', createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'conversation survives restart'}]}), {surfaceOp: 'append'});
      original.append('step/start', {turn: 1, step: 1});
      original.append('request/header', {reason: 'initial', header: {config: {provider: 'test', model: 'test'}, system: 'OLD_MEMORY_SNAPSHOT'}});
      original.append('step/end', {turn: 1, step: 1});
      original.append('turn/end', {turn: 1, reason: {kind: 'completed'}});
      // Simulate an interrupted turn whose complete records reached storage.
      original.append('turn/start', {turn: 2});
      original.append('user/message', createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'interrupted input is retained'}]}), {surfaceOp: 'append'});
      await runtime.checkpoint();
      await runtime.dispose();
      await first.close();

      const second = await host();
      await second.persistence.inspect(original.id);
      const restored = await second.runtime.resume(basePolicy, runtime.id);
      const session = second.agent.session;
      expect(restored.id).toBe(runtime.id);
      expect(second.create).not.toHaveBeenCalled();
      expect(JSON.stringify(session.deriveMessages())).toContain('conversation survives restart');
      expect(JSON.stringify(session.deriveMessages())).toContain('interrupted input is retained');
      expect(JSON.stringify(session.deriveMessages())).not.toContain('OLD_MEMORY_SNAPSHOT');
      expect(session.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted')).toBe(true);
      const newMemory = second.prompt.variable.mock.calls[0]![1] as () => string;
      expect(newMemory()).toBe('[]');
      await restored.checkpoint();
      const raw = await second.persistence.readRaw(session.id);
      expect(raw?.content).toContain('OLD_MEMORY_SNAPSHOT'); // Audit history is retained, never claimed erased.
      expect(raw?.content).toContain('interrupted');
      await restored.dispose();
    } finally {
      await Promise.all(hosts.map(item => item.close()));
      await fs.rm(directory, {recursive: true, force: true});
    }
  });

  it.each(['idle', 'active', 'host-idle', 'host-active', 'write-failure'] as const)('verifies the final native log after concurrent Cordis owner teardown (%s)', async (mode) => {
    const [{Context}, {SessionStore}, {JsonlSessionPersistence}, fs, os, path] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-persistence-jsonl'),
      import('node:fs/promises'), import('node:os'), import('node:path'),
    ]);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lark-shutdown-'));
    const root = new Context();
    const sessionsPlugin = root.plugin(SessionStore);
    await sessionsPlugin.await();
    const persistencePlugin = root.plugin(JsonlSessionPersistence, {root: directory, compression: 'none'});
    await persistencePlugin.await();
    const sessions = root.get('sessions') as InstanceType<typeof SessionStore>;
    const persistence = root.get('sessionPersistence') as InstanceType<typeof JsonlSessionPersistence>;
    const f = fixture();
    f.get.mockImplementation(name => name === 'sessions' ? sessions : name === 'sessionPersistence' ? persistence : name === 'agentDefaultModel' ? {currentSelection: f.currentSelection} : undefined);
    let ownerCtx!: Context;
    const owner = root.plugin((ctx: Context) => { ownerCtx = ctx; });
    await owner.await();
    const detached = deferred();
    let detach: (() => void) | undefined;
    let nativeDisposal: Promise<void> | undefined;
    f.handle.dispose.mockImplementation(() => nativeDisposal ??= (async () => {
      f.agent.cancel();
      await f.agent.whenIdle();
      detach?.();
      detached.resolve();
    })());
    f.create.mockImplementation(async options => {
      const session = sessions.prepare(options.sessionId, {seed: options.seed, meta: options.meta});
      Object.assign(f.agent, {id: session.id, session});
      await options.setup?.(f.agent.ctx);
      // Model the native factory's owner-bound effect using the real Cordis
      // fiber. On unload it races the bridge effect, rather than running LIFO.
      ownerCtx.effect(() => () => f.handle.dispose(), 'native agent lifecycle');
      detach = sessions.enter(session);
      sessions.announce(session);
      return f.handle;
    });
    let pendingRun: Promise<unknown> | undefined;
    let appendSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const runtime = await f.runtime.create(basePolicy);
      await runtime.checkpoint();
      const original = f.agent.session;
      if (mode !== 'idle' && mode !== 'host-idle') {
        const idle = deferred();
        f.agent.whenIdle.mockImplementation(() => idle.promise);
        f.agent.followup.mockImplementation(message => {
          original.append('turn/start', {turn: 1});
          original.append('user/message', message, {surfaceOp: 'append'});
        });
        let canceled = false;
        f.agent.cancel.mockImplementation(() => {
          if (canceled) return;
          canceled = true;
          original.append('turn/end', {turn: 1, reason: {kind: 'aborted', reason: {kind: 'user'}}});
          idle.resolve();
        });
        if (mode === 'write-failure') appendSpy = vi.spyOn(persistence, 'appendBatch').mockRejectedValue(new Error('injected disk write failure'));
        pendingRun = runtime.run('input before shutdown', new AbortController().signal).catch(error => error);
      }
      let shutdownResult: unknown;
      ownerCtx.effect(() => async () => {
        // Force a valid unload interleaving: native lifecycle reaches detach
        // before the bridge can flush. Retirement is still tracked by JSONL.
        await detached.promise;
        try { await runtime.dispose(); }
        catch (error) { shutdownResult = error; }
      }, 'bridge shutdown');
      if (mode.startsWith('host-')) await root.fiber.dispose();
      else await owner.dispose();
      await pendingRun;
      if (mode === 'write-failure') {
        expect(shutdownResult).toMatchObject({code: 'PERSISTENCE_FAILED'});
        await expect(runtime.dispose()).rejects.toMatchObject({code: 'PERSISTENCE_FAILED'});
      } else {
        expect(shutdownResult).toBeUndefined();
        await expect(runtime.dispose()).resolves.toBeUndefined();
        const stored = await persistence.readFrom(original.id, 0);
        expect(stored.events).toEqual(original.events);
        if (mode === 'active' || mode === 'host-active') expect(stored.events.at(-1)).toMatchObject({type: 'turn/end', data: {reason: {kind: 'aborted'}}});
      }
    } finally {
      appendSpy?.mockRestore();
      await owner.dispose();
      await persistencePlugin.dispose();
      await sessionsPlugin.dispose();
      await fs.rm(directory, {recursive: true, force: true});
    }
  });

  it('rejects missing or changed durable cancellation events after native detach', async () => {
    const f = fixture();
    const events = [{seq: 0, type: 'session/end-seed', data: {}}, {seq: 1, type: 'turn/end', data: {reason: {kind: 'aborted'}}}] as unknown as SessionEvent[];
    Object.assign(f.session, {events});
    const readFrom = vi.fn(async () => ({meta: {id: f.session.id, cwd: basePolicy.cwd}, events: events.slice(0, 1)}));
    f.get.mockImplementation(name => name === 'sessionPersistence' ? {readFrom} : name === 'sessions' ? {flush: f.flush} : {currentSelection: f.currentSelection});
    const runtime = await f.runtime.create(basePolicy);
    f.flush.mockRejectedValue(new Error('session no longer live'));
    await expect(runtime.dispose()).rejects.toMatchObject({code: 'PERSISTENCE_FAILED'});
    expect(readFrom).toHaveBeenCalledWith(f.session.id, 0);
  });

  it('reads the live host default route for each newly created session', async () => {
    const f = fixture();
    await f.runtime.create(basePolicy);
    expect(f.create.mock.calls[0]![0].agentOptions).toEqual({provider: 'host-provider', model: 'host-model'});
    f.currentSelection.mockReturnValue({provider: 'changed-provider', model: 'changed-model'});
    await f.runtime.create(basePolicy);
    expect(f.create.mock.calls[1]![0].agentOptions).toEqual({provider: 'changed-provider', model: 'changed-model'});
  });

  it('keeps an explicit complete route independent of the host default service', async () => {
    const f = fixture();
    f.get.mockImplementation((name) => {
      if (name === 'agentDefaultModel') throw new Error('default service unavailable');
      return undefined;
    });
    await f.runtime.create({...basePolicy, provider: 'explicit-provider', model: 'explicit-model'});
    expect(f.create.mock.calls[0]![0].agentOptions).toEqual({provider: 'explicit-provider', model: 'explicit-model'});
    expect(f.get).not.toHaveBeenCalledWith('agentDefaultModel');
  });

  it('fills only omitted route fields from the host selection', async () => {
    const f = fixture();
    await f.runtime.create({...basePolicy, model: 'custom-model'});
    expect(f.create.mock.calls[0]![0].agentOptions).toEqual({provider: 'host-provider', model: 'custom-model'});
  });

  it('fails before publishing a session when a model route cannot be resolved', async () => {
    const f = fixture();
    f.get.mockReturnValue(undefined);
    await expect(f.runtime.create(basePolicy)).rejects.toMatchObject({code: 'SETUP_FAILED'});
    expect(f.create).not.toHaveBeenCalled();
  });

  it('applies fail-closed agent-local permissions before publication', async () => {
    const f = fixture();
    const allowedTools = ['safe_lookup'];
    await f.runtime.create({ ...basePolicy, allowedTools, model: 'test-model', provider: 'test-provider' });
    expect(f.create.mock.calls[0]![0]).toMatchObject({
      meta: { cwd: basePolicy.cwd }, agentOptions: { model: 'test-model', provider: 'test-provider' },
    });
    expect(f.create.mock.calls[0]![0].sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.tools.presentAs).toHaveBeenCalledWith('native');
    expect(f.tools.restrict).toHaveBeenCalledWith({ allow: ['safe_lookup'] });
    expect(f.prompt.section).toHaveBeenCalledWith(expect.objectContaining({name: 'deployment:persona', complete: true}));
    expect(f.prompt.suppressRuntimeContext).toHaveBeenCalledTimes(1);
    allowedTools.push('bash');
    const guard = f.tools.guard.mock.calls[0]![0];
    expect(guard({ name: 'safe_lookup' } as ToolExecution)).toBeUndefined();
    expect(guard({ name: 'bash' } as ToolExecution)).toBeTruthy();
    expect(guard({ name: 'run_code' } as ToolExecution)).toBeTruthy();
    const [event, answer, options] = f.scopedOn.mock.calls[0]!;
    expect(event).toBe('approval/request');
    expect(options).toEqual({ prepend: true });
    await expect(answer()).resolves.toBe('rejected');
  });

  it('uses an empty allowlist by default and refuses an unsupported host', async () => {
    const f = fixture();
    await f.runtime.create(basePolicy);
    expect(f.tools.restrict).toHaveBeenCalledWith({ allow: [] });
    Object.assign(f.tools, { guard: undefined });
    await expect(f.runtime.create(basePolicy)).rejects.toMatchObject({ code: 'SETUP_FAILED' });
  });

  it('does not fall back to unrestricted tools after a bad policy', async () => {
    const f = fixture();
    f.tools.restrict.mockImplementation(() => { throw new Error('secret host configuration'); });
    await expect(f.runtime.create({ ...basePolicy, allowedTools: ['unknown'] })).rejects.toMatchObject({
      code: 'SETUP_FAILED', message: '无法创建 dsh 会话，请管理员检查模型和工具权限配置。',
    });
    expect(f.tools.guard).not.toHaveBeenCalled();
    expect(f.on).not.toHaveBeenCalled();
  });

  it('fails closed when scoped prompt isolation is unavailable', async () => {
    const f = fixture();
    Object.assign(f.prompt, { suppressRuntimeContext: undefined });
    await expect(f.runtime.create(basePolicy)).rejects.toMatchObject({code: 'SETUP_FAILED'});
    expect(f.tools.restrict).not.toHaveBeenCalled();
    expect(f.on).not.toHaveBeenCalled();
  });

  it('accepts text only from the exact owned session and ignores reasoning/tools', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    f.agent.followup.mockImplementation(() => {
      f.text('another session', { id: f.session.id } as Session);
      f.emit({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'tool secret' }] } } });
      f.emit({ type: 'assistant/message', data: { message: { content: [
        { type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'first' },
      ] } } });
      f.text('second');
    });
    await expect(runtime.run('question', new AbortController().signal)).resolves.toBe('first\n\nsecond');
    expect(f.agent.followup.mock.calls[0]![0]).toMatchObject({
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }],
    });
  });

  it('drains cancellation before allowing another turn', async () => {
    const f = fixture();
    const idle = deferred();
    f.agent.whenIdle.mockReturnValue(idle.promise);
    const runtime = await f.runtime.create(basePolicy);
    const abort = new AbortController();
    const run = runtime.run('question', abort.signal);
    const rejection = expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    abort.abort();
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    await expect(runtime.run('overlap', new AbortController().signal)).rejects.toMatchObject({ code: 'BUSY' });
    idle.resolve();
    await rejection;
    f.agent.followup.mockImplementation(() => { f.text('new result'); });
    await expect(runtime.run('next', new AbortController().signal)).resolves.toBe('new result');
  });

  it('never queues an already cancelled prompt', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    const abort = new AbortController();
    abort.abort();
    await expect(runtime.run('question', abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.agent.followup).not.toHaveBeenCalled();
  });

  it('hides model and tool error details from the returned error', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    f.agent.followup.mockImplementation(() => {
      f.emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'private token', code: 'secret' } } } });
    });
    await expect(runtime.run('question', new AbortController().signal)).rejects.toMatchObject({
      code: 'TURN_FAILED', message: 'dsh 处理失败，请稍后重试。',
    });
    f.agent.followup.mockImplementation(() => { throw new Error('private process path'); });
    await expect(runtime.run('next', new AbortController().signal)).rejects.toMatchObject({
      code: 'TURN_FAILED', message: 'dsh 处理失败，请稍后重试。',
    });
  });

  it('bounds captured output and cancels excessive responses', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    f.agent.followup.mockImplementation(() => { f.text('x'.repeat(64 * 1024 + 1)); });
    await expect(runtime.run('question', new AbortController().signal)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(f.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
  });

  it('clears captured text between turns and returns no prior reply', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    f.agent.followup.mockImplementationOnce(() => { f.text('old result'); });
    await expect(runtime.run('first', new AbortController().signal)).resolves.toBe('old result');
    await expect(runtime.run('second', new AbortController().signal)).resolves.toBe('');
  });

  it('disposes the owned handle and listener exactly once', async () => {
    const f = fixture();
    const runtime = await f.runtime.create(basePolicy);
    const first = runtime.dispose();
    expect(runtime.dispose()).toBe(first);
    await first;
    expect(f.handle.dispose).toHaveBeenCalledTimes(1);
    expect(f.removeListener).toHaveBeenCalledTimes(1);
    await expect(runtime.run('late', new AbortController().signal)).rejects.toBeInstanceOf(DshRuntimeError);
    expect(f.agent.followup).not.toHaveBeenCalled();
  });

  it('cleans up an agent if event registration fails', async () => {
    const f = fixture();
    f.on.mockImplementation(() => { throw new Error('listener failure'); });
    await expect(f.runtime.create(basePolicy)).rejects.toMatchObject({ code: 'SETUP_FAILED' });
    expect(f.handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('enforces isolation with the real dsh tool registry, including later local tools', async () => {
    const [{ Context }, { default: SystemPrompt, renderPrompt, renderContextSnapshot }, { ToolRuntime, defineContentToolFixture }, { createScope, scopeTarget }, { CallId }] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-scope'), import('@deepseek-ai/dsh-llm'),
    ]);
    const root = new Context();
    const promptPlugin = root.plugin(SystemPrompt, {persona: 'PRIVATE HOST PERSONA'});
    await promptPlugin.await();
    const toolsPlugin = root.plugin(ToolRuntime);
    await toolsPlugin.await();
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'allowed' }]);
    const tool = (name: string) => defineContentToolFixture({ name, description: name, parameters: {}, execute: body });
    root.tools.register(tool('safe_lookup'));
    root.tools.register(tool('bash'));
    root.systemPrompt.section({name: 'private-host-instructions', order: 1, text: 'PRIVATE HOST SECTION'});
    root.systemPrompt.context({name: 'private-host-context', order: 1, text: 'PRIVATE HOST SNAPSHOT'});
    root.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      return {...assembly,
        sections: [...assembly.sections, {name: 'private-late-section', text: 'PRIVATE LATE SECTION'}],
        contexts: [...assembly.contexts, {name: 'private-late-context', text: 'PRIVATE LATE SNAPSHOT'}],
      };
    });

    const f = fixture();
    await f.runtime.create({ ...basePolicy, allowedTools: ['safe_lookup'] });
    const scope = createScope(root, f.agent);
    try {
      await f.create.mock.calls[0]![0].setup?.(scope.ctx);
      expect(root.tools.schemas(f.agent).map((schema) => schema.name)).toEqual(['safe_lookup']);
      expect(root.tools.schemas().map((schema) => schema.name)).toEqual(['safe_lookup', 'bash']);
      const assembly = await root.systemPrompt.assemble({scope: f.agent});
      expect(renderPrompt(assembly)).toContain('飞书中的 dsh 团队助手');
      expect(renderPrompt(assembly)).not.toContain('PRIVATE');
      expect(renderContextSnapshot(assembly)).toBe('');
      expect(assembly.tools.map(schema => schema.name)).toEqual(['safe_lookup']);
      expect(assembly.tools[0]).toMatchObject({description: 'safe_lookup', parameters: {type: 'object'}});
      const hostAssembly = await root.systemPrompt.assemble();
      expect(renderPrompt(hostAssembly)).toContain('PRIVATE HOST PERSONA');
      expect(renderContextSnapshot(hostAssembly)).toContain('PRIVATE HOST SNAPSHOT');
      const waterfall = root as unknown as {waterfall(carrier: object, event: string, request: unknown, next: () => Promise<string>): Promise<string>};
      await expect(waterfall.waterfall(scopeTarget(root, f.agent), 'approval/request', {agent: f.agent}, async () => 'allowed-once')).resolves.toBe('rejected');
      await expect(waterfall.waterfall(scopeTarget(root, {}), 'approval/request', {agent: {}}, async () => 'allowed-once')).resolves.toBe('allowed-once');
      const execute = (name: string) => root.tools.execute({
        callId: CallId(name), name, arguments: {}, agent: f.agent as unknown as Agent, signal: new AbortController().signal,
      });
      expect((await execute('safe_lookup')).isError).toBe(false);
      expect(body).toHaveBeenCalledTimes(1);
      expect((await execute('bash')).isError).toBe(true);
      const scopedTools = scope.ctx.get('tools') as InstanceType<typeof ToolRuntime>;
      scopedTools.register(tool('late_privileged_tool'));
      expect((await execute('late_privileged_tool')).isError).toBe(true);
      expect((await execute('run_code')).isError).toBe(true);
      expect(body).toHaveBeenCalledTimes(1);
    } finally {
      await scope.dispose();
      await toolsPlugin.dispose();
      await promptPlugin.dispose();
    }
  });
});

describe('harness channel mode', () => {
  const ownerMemory = (privateChat = true): MemoryAccess => ({privateChat, list: vi.fn(async () => []), search: vi.fn(async () => []),
    remember: vi.fn(async () => { throw new Error('unused'); }), forget: vi.fn(async () => false)});
  const harnessPolicy = (): AgentPolicy => ({...basePolicy, mode: 'harness', memory: ownerMemory()});
  type Listener = (...args: any[]) => any;
  const listener = (f: ReturnType<typeof fixture>, name: string): Listener => {
    const entry = f.scopedOn.mock.calls.find(([event]) => event === name);
    if (!entry) throw new Error(`Expected a scoped ${name} listener`);
    return entry[1] as Listener;
  };
  const toolCall = (id: string, name: string, args: string, turn = 1, step = 1) => ({type: 'assistant/chunk', data: {turn, step,
    chunk: {type: 'block-end', index: 0, block: {type: 'tool-call', id, name, arguments: args}}}});

  it('keeps the host prompt, tools and presentation mode and adds only a channel section', async () => {
    const f = fixture();
    await f.runtime.create(harnessPolicy());
    expect(f.prompt.suppressRuntimeContext).not.toHaveBeenCalled();
    expect(f.tools.presentAs).not.toHaveBeenCalled();
    expect(f.tools.guard).not.toHaveBeenCalled();
    // A legacy host would send questions to its one browser provider.
    expect(f.tools.restrict).toHaveBeenCalledExactlyOnceWith({deny: ['ask_user_question']});
    expect(f.prompt.section).toHaveBeenCalledTimes(1);
    const section = f.prompt.section.mock.calls[0]![0] as Record<string, unknown>;
    expect(section).toMatchObject({name: 'lark-channel', order: 15_000});
    expect(section).not.toHaveProperty('complete');
    expect(section.text).toEqual(expect.stringContaining('飞书私聊'));
    expect(section.text).toEqual(expect.stringContaining('{{lark_memory}}'));
    expect(section.text).toEqual(expect.stringContaining('{{lark_model}}'));
    expect(f.tools.register.mock.calls.map(([definition]) => (definition as {name: string}).name)).toEqual(
      ['lark_memory_list', 'lark_memory_search', 'lark_memory_remember', 'lark_memory_forget']);
    expect(f.scopedOn.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining(['approval/request', 'agent/assistant-stream', 'tools/result']));
    expect(f.scopedOn.mock.calls.map(([event]) => event)).not.toContain('user-questions/request');
  });

  it('answers questions itself on a modern host instead of hiding the tool', async () => {
    const f = fixture();
    Object.assign(f.prompt, {getSectionOrder: vi.fn(() => 100)});
    await f.runtime.create(harnessPolicy());
    expect(f.tools.restrict).not.toHaveBeenCalled();
    expect(f.scopedOn.mock.calls.map(([event]) => event)).toContain('user-questions/request');
  });

  it('refuses harness mode outside a verified private chat', async () => {
    const f = fixture();
    await expect(f.runtime.create({...basePolicy, mode: 'harness'})).rejects.toMatchObject({code: 'SETUP_FAILED'});
    await expect(f.runtime.create({...basePolicy, mode: 'harness', memory: ownerMemory(false)})).rejects.toMatchObject({code: 'SETUP_FAILED'});
    expect(f.create).not.toHaveBeenCalled();
  });

  it('relays an approval for its own turn with the exact call arguments', async () => {
    const f = fixture();
    const session = await f.runtime.create(harnessPolicy());
    const relay = listener(f, 'approval/request');
    const next = vi.fn(async () => 'unavailable');
    // Outside a turn this channel owns nothing to ask about.
    await expect(relay({toolName: 'bash'}, next)).resolves.toBe('unavailable');
    expect(next).toHaveBeenCalledTimes(1);
    const outcomes: unknown[] = [];
    const approve = vi.fn(async (_prompt: ApprovalPrompt, _signal: AbortSignal) => true);
    f.agent.followup.mockImplementation(() => f.emit(toolCall('call_1', 'bash', '{"command":"rm -rf build"}')));
    f.agent.whenIdle.mockImplementationOnce(async () => {
      outcomes.push(await relay({toolName: 'bash', callId: 'call_1', reason: 'Writes outside the sandbox'}, next));
      approve.mockResolvedValueOnce(false);
      outcomes.push(await relay({toolName: 'bash', callId: 'call_1'}, next));
      approve.mockRejectedValueOnce(new Error('card failed'));
      outcomes.push(await relay({toolName: 'bash'}, next));
      const aborted = new AbortController();
      aborted.abort();
      approve.mockRejectedValueOnce(new Error('withdrawn'));
      outcomes.push(await relay({toolName: 'bash', signal: aborted.signal}, next));
    });
    await session.run('clean up', new AbortController().signal, undefined, {approve});
    expect(outcomes).toEqual(['allowed-once', 'rejected', 'unavailable', 'cancelled']);
    expect(next).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toEqual({toolName: 'bash', reason: 'Writes outside the sandbox',
      detail: '{\n  "command": "rm -rf build"\n}'});
  });

  it('streams reasoning, text and tool progress from legacy chunks', async () => {
    const f = fixture();
    const session = await f.runtime.create(harnessPolicy());
    const events: unknown[] = [];
    f.agent.followup.mockImplementation(() => {
      f.emit({type: 'assistant/chunk', data: {turn: 1, step: 1, chunk: {type: 'reasoning-delta', index: 0, text: 'think'}}});
      f.emit(toolCall('call_1', 'web_search', '{"queries":["Lody","LodyAI"]}'));
      // Another session's chunks never reach this turn.
      f.emit({type: 'assistant/chunk', data: {turn: 1, step: 1, chunk: {type: 'text-delta', index: 1, text: 'foreign'}}}, {id: f.session.id} as Session);
      listener(f, 'tools/result')({callId: 'call_1'}, {isError: false});
      f.emit({type: 'assistant/chunk', data: {turn: 1, step: 2, chunk: {type: 'text-delta', index: 0, text: 'answer'}}});
      f.text('answer');
    });
    await expect(session.run('research', new AbortController().signal, undefined, {stream: event => events.push(event)})).resolves.toBe('answer');
    expect(events).toEqual([
      {type: 'attempt'}, {type: 'reasoning', text: 'think'},
      {type: 'tool', callId: 'call_1', name: 'web_search', detail: 'Lody, LodyAI'},
      {type: 'tool-done', callId: 'call_1', ok: true},
      {type: 'attempt'}, {type: 'text', text: 'answer'},
    ]);
  });

  it('names a call by its own description first, like the App, and reports a failed command exit code', async () => {
    const f = fixture();
    const session = await f.runtime.create(harnessPolicy());
    const events: unknown[] = [];
    f.agent.followup.mockImplementation(() => {
      f.emit(toolCall('call_1', 'bash', JSON.stringify({command: 'printf x > out.txt', description: '写入桌面审批测试文件'})));
      f.emit(toolCall('call_2', 'bash', JSON.stringify({command: `ls ${'a'.repeat(200)}`})));
      f.emit(toolCall('call_3', 'ask_user_question', JSON.stringify({questions: [{question: '继续吗？'}, {question: '用哪个？'}]})));
      listener(f, 'tools/result')({callId: 'call_1'}, {isError: false, value: {kind: 'foreground', exitCode: 1}});
      listener(f, 'tools/result')({callId: 'call_2'}, {isError: false, value: {kind: 'foreground', exitCode: 0}});
      listener(f, 'tools/result')({callId: 'call_3'}, {isError: true});
      f.text('done');
    });
    await session.run('go', new AbortController().signal, undefined, {stream: event => events.push(event)});
    expect(events).toEqual([
      {type: 'attempt'},
      {type: 'tool', callId: 'call_1', name: 'bash', detail: '写入桌面审批测试文件'},
      {type: 'tool', callId: 'call_2', name: 'bash', detail: `ls ${'a'.repeat(157)}…`, code: true},
      {type: 'tool', callId: 'call_3', name: 'ask_user_question', detail: '继续吗？, 用哪个？'},
      {type: 'tool-done', callId: 'call_1', ok: true, exitCode: 1},
      {type: 'tool-done', callId: 'call_2', ok: true},
      {type: 'tool-done', callId: 'call_3', ok: false},
    ]);
  });

  it('streams modern frames once and discards attempts that will not be part of the answer', async () => {
    const f = fixture();
    const session = await f.runtime.create(harnessPolicy());
    const frames = listener(f, 'agent/assistant-stream');
    const events: unknown[] = [];
    const chunk = (text: string) => ({type: 'chunk', chunk: {type: 'text-delta', index: 0, text}});
    f.agent.followup.mockImplementation(() => {
      frames({agent: f.agent, frame: {type: 'start', turn: 1, step: 1}});
      frames({agent: f.agent, frame: chunk('draft')});
      frames({agent: f.agent, frame: {type: 'end', outcome: {kind: 'committed', eventType: 'assistant/attempt', seq: 3}}});
      frames({agent: {session: {}}, frame: chunk('other agent')});
      // A host that also logged raw chunks must not show the same text twice.
      f.emit({type: 'assistant/chunk', data: {turn: 1, step: 1, chunk: {type: 'text-delta', index: 0, text: 'duplicate'}}});
      frames({agent: f.agent, frame: {type: 'start', turn: 1, step: 1}});
      frames({agent: f.agent, frame: chunk('final')});
      frames({agent: f.agent, frame: {type: 'end', outcome: {kind: 'committed', eventType: 'assistant/message', seq: 4}}});
      f.text('final');
    });
    await session.run('question', new AbortController().signal, undefined, {stream: event => events.push(event)});
    expect(events).toEqual([{type: 'attempt'}, {type: 'text', text: 'draft'}, {type: 'discard'},
      {type: 'attempt'}, {type: 'text', text: 'final'}]);
  });

  it('keeps streaming failures out of the turn', async () => {
    const f = fixture();
    const session = await f.runtime.create(harnessPolicy());
    f.agent.followup.mockImplementation(() => {
      f.emit({type: 'assistant/chunk', data: {turn: 1, step: 1, chunk: {type: 'text-delta', index: 0, text: 'ok'}}});
      f.text('ok');
    });
    await expect(session.run('question', new AbortController().signal, undefined, {stream: () => { throw new Error('card down'); }}))
      .resolves.toBe('ok');
  });

  it('returns reasoning apart from the answer and resolves host-presented files against the workspace', async () => {
    const f = fixture();
    const session = await f.runtime.create(harnessPolicy());
    f.agent.followup.mockImplementation(() => {
      f.emit({type: 'assistant/message', data: {message: {content: [{type: 'reasoning', text: 'why'}, {type: 'text', text: 'done'}]}}});
      f.emit({type: 'deliverables/presented', data: {turn: 1, callId: 'call_9', files: [
        {path: 'out/report.pdf', description: 'Weekly report'}, {path: '/elsewhere/chart.png'},
        {path: 'out/report.pdf', description: 'duplicate'}, {path: 7}, {path: 'bad\0path'},
      ]}});
    });
    await expect(session.run('make a report', new AbortController().signal)).resolves.toEqual({
      text: 'done', artifacts: [], reasoning: 'why',
      files: [{path: '/tmp/dsh-lark-test/out/report.pdf', description: 'Weekly report'}, {path: '/elsewhere/chart.png', description: ''}],
    });
  });

  it('relays a modern question with validated options and answers with the original labels', async () => {
    const f = fixture();
    Object.assign(f.prompt, {getSectionOrder: vi.fn(() => 100)});
    const session = await f.runtime.create(harnessPolicy());
    const relay = listener(f, 'user-questions/request');
    const next = vi.fn(async () => ({answers: []}));
    const ask = vi.fn(async (_questions: UserQuestion[], _signal: AbortSignal) => [{id: 'mode', selected: ['Fast (Recommended)']}]);
    const results: unknown[] = [];
    f.agent.whenIdle.mockImplementationOnce(async () => {
      results.push(await relay({questions: [{id: 'mode', question: 'Which mode?', header: 'Mode',
        options: [{label: 'Fast (Recommended)', description: 'Fewer checks'}, {label: 'Careful'}]}]}, next));
      // Malformed requests stay with the host's other answerers.
      results.push(await relay({questions: [{id: 'x', question: 'Pick', options: [{label: 'a'}, {label: 'a'}]}]}, next));
    });
    await session.run('start', new AbortController().signal, undefined, {ask});
    expect(ask.mock.calls[0]![0]).toEqual([{id: 'mode', question: 'Which mode?', header: 'Mode', multiSelect: false,
      options: [{label: 'Fast (Recommended)', description: 'Fewer checks'}, {label: 'Careful'}]}]);
    expect(results).toEqual([{answers: [{id: 'mode', selected: ['Fast (Recommended)']}]}, {answers: []}]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('harness sessions use the host agent preset', () => {
  const ownerMemory = (): MemoryAccess => ({privateChat: true, list: vi.fn(async () => []), search: vi.fn(async () => []),
    remember: vi.fn(async () => { throw new Error('unused'); }), forget: vi.fn(async () => false)});
  const withPresets = (f: ReturnType<typeof fixture>) => {
    const presets = {resolve: vi.fn(async (id?: string) => ({id: id ?? 'standard'})), mount: vi.fn(async (_ctx: Context, id?: string) => ({id}))};
    const original = f.get.getMockImplementation()!;
    f.get.mockImplementation(name => name === 'agentPresets' ? presets : original(name));
    return presets;
  };

  it('records the default preset on a new session and mounts it before adding the channel section', async () => {
    const f = fixture();
    const presets = withPresets(f);
    await f.runtime.create({...basePolicy, mode: 'harness', memory: ownerMemory()});
    expect(presets.resolve).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.create.mock.calls[0]![0].meta).toEqual({cwd: basePolicy.cwd, agentPreset: 'standard'});
    expect(presets.mount).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'standard');
    expect(presets.mount.mock.invocationCallOrder[0]!).toBeLessThan(f.prompt.section.mock.invocationCallOrder[0]!);
  });

  it('resumes on the recorded preset, and on the default when none was recorded, like the App', async () => {
    const recorded = fixture();
    const presets = withPresets(recorded);
    Object.assign(recorded.session.header, {agentPreset: 'coder'});
    await recorded.runtime.resume({...basePolicy, mode: 'harness', memory: ownerMemory()}, '00000000-0000-4000-8000-000000000000');
    expect(presets.resolve).toHaveBeenCalledExactlyOnceWith('coder');
    expect(presets.mount).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'coder');

    const unrecorded = fixture();
    const defaults = withPresets(unrecorded);
    await unrecorded.runtime.resume({...basePolicy, mode: 'harness', memory: ownerMemory()}, '00000000-0000-4000-8000-000000000000');
    expect(defaults.resolve).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(defaults.mount).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'standard');
  });

  it('never joins a preset for a restricted session', async () => {
    const f = fixture();
    const presets = withPresets(f);
    await f.runtime.create(basePolicy);
    expect(presets.resolve).not.toHaveBeenCalled();
    expect(presets.mount).not.toHaveBeenCalled();
    expect(f.create.mock.calls[0]![0].meta).toEqual({cwd: basePolicy.cwd});
  });

  it('fails closed when the preset cannot be resolved or mounted', async () => {
    const broken = fixture();
    withPresets(broken).mount.mockRejectedValue(new Error('broken preset'));
    await expect(broken.runtime.create({...basePolicy, mode: 'harness', memory: ownerMemory()})).rejects.toMatchObject({code: 'SETUP_FAILED'});
    const invalid = fixture();
    withPresets(invalid).resolve.mockResolvedValue({id: ''});
    await expect(invalid.runtime.create({...basePolicy, mode: 'harness', memory: ownerMemory()})).rejects.toMatchObject({code: 'SETUP_FAILED'});
    expect(invalid.create).not.toHaveBeenCalled();
  });
});

describe('harness permission presets', () => {
  const ownerMemory = (): MemoryAccess => ({privateChat: true, list: vi.fn(async () => []), search: vi.fn(async () => []),
    remember: vi.fn(async () => { throw new Error('unused'); }), forget: vi.fn(async () => false)});
  const withPermissions = (f: ReturnType<typeof fixture>) => {
    const service = {
      catalog: vi.fn(() => ({options: [{value: 'read-only', name: '仅可查看'}, {value: 'workspace-write', name: '工作区内修改', description: '工作区内可写'},
        {value: 'danger-full-access', name: '完全权限'}, {value: 'Bad Value', name: 'ignored'}, {value: 'read-only', name: 'duplicate'}],
        defaultPreset: 'workspace-write'})),
      current: vi.fn((_session: unknown) => 'workspace-write'),
      set: vi.fn((_session: unknown, _name: string) => undefined),
    };
    const original = f.get.getMockImplementation()!;
    f.get.mockImplementation(name => name === 'permissionPresets' ? service : original(name));
    return service;
  };

  it('reads the host catalog and switches the session like the App selector', async () => {
    const f = fixture();
    const service = withPermissions(f);
    const session = await f.runtime.create({...basePolicy, mode: 'harness', memory: ownerMemory()});
    expect(session.permissionState!()).toEqual({current: 'workspace-write', defaultPreset: 'workspace-write', options: [
      {id: 'read-only', name: '仅可查看'}, {id: 'workspace-write', name: '工作区内修改', description: '工作区内可写'}, {id: 'danger-full-access', name: '完全权限'},
    ]});
    session.setPermission!('danger-full-access');
    expect(service.set).toHaveBeenCalledExactlyOnceWith(f.session, 'danger-full-access');
    expect(() => session.setPermission!('Bad Value')).toThrow(expect.objectContaining({code: 'PERMISSION_UNAVAILABLE'}));
    expect(f.runtime.permissionOptions().map(option => option.id)).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
  });

  it('offers no permission switch to a restricted session or a host without a catalog', async () => {
    const restricted = fixture();
    const service = withPermissions(restricted);
    const session = await restricted.runtime.create(basePolicy);
    expect(session.permissionState!()).toBeUndefined();
    expect(() => session.setPermission!('read-only')).toThrow(expect.objectContaining({code: 'PERMISSION_UNAVAILABLE'}));
    expect(service.set).not.toHaveBeenCalled();
    const rosterless = fixture();
    const plain = await rosterless.runtime.create({...basePolicy, mode: 'harness', memory: ownerMemory()});
    expect(plain.permissionState!()).toBeUndefined();
    expect(rosterless.runtime.permissionOptions()).toEqual([]);
  });

  it('refuses to switch during a running turn', async () => {
    const f = fixture();
    withPermissions(f);
    const session = await f.runtime.create({...basePolicy, mode: 'harness', memory: ownerMemory()});
    let busy: unknown;
    f.agent.whenIdle.mockImplementationOnce(async () => { try { session.setPermission!('read-only'); } catch (error) { busy = error; } });
    await session.run('work', new AbortController().signal);
    expect(busy).toMatchObject({code: 'BUSY'});
  });
});

describe('harness model shared with the App', () => {
  const ownerMemory = (): MemoryAccess => ({privateChat: true, list: vi.fn(async () => []), search: vi.fn(async () => []),
    remember: vi.fn(async () => { throw new Error('unused'); }), forget: vi.fn(async () => false)});
  const harness = (extra: Partial<AgentPolicy> = {}): AgentPolicy => ({...basePolicy, mode: 'harness', memory: ownerMemory(), ...extra});
  /** The App host: a per-session model record, a request header and a default the selector saves. */
  const appHost = (f: ReturnType<typeof fixture>, registered = true) => {
    const record = {pending: null as unknown, lastUsed: null as unknown};
    const live = {header: undefined as unknown};
    const append = vi.fn((type: string, data: unknown) => { if (type === 'model/selection') record.pending = data; });
    Object.assign(f.session, {requestHeader: () => live.header, append});
    const stateOf = vi.fn((_session: unknown, key: string) => registered && key === 'modelSelection' ? record : undefined);
    const saveSelection = vi.fn(async (_next: unknown) => undefined);
    const original = f.get.getMockImplementation()!;
    f.get.mockImplementation(name => name === 'sessionProjections' ? {stateOf}
      : name === 'agentDefaultModel' ? {currentSelection: f.currentSelection, saveSelection} : original(name));
    return {record, live, append, saveSelection};
  };

  it('follows the session record like the App: its pick, else its last request, else the host default', async () => {
    const f = fixture();
    const host = appHost(f);
    const session = await f.runtime.create(harness());
    expect(session.sharesModelSelection).toBe(true);
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'host-model'});
    host.live.header = {config: {provider: 'host-provider', model: 'used-model', reasoningEffort: 'deep'}};
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'used-model', reasoningEffort: 'deep'});
    // An effort the adapter filled in itself stays unset, so the adapter keeps choosing it.
    host.live.header = {config: {provider: 'host-provider', model: 'used-model', reasoningEffort: 'quick'}, adapterDefaults: {reasoningEffort: true}};
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'used-model'});
    // A pick made in the App on this session wins, and routes the next request.
    host.record.pending = {provider: 'host-provider', model: 'app-pick', reasoningEffort: 'deep'};
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'app-pick', reasoningEffort: 'deep'});
    const assemble = f.scopedOn.mock.calls.find(([name]) => name === 'system-prompt/assemble')![1];
    const request = f.scopedOn.mock.calls.find(([name]) => name === 'agent/request')![1];
    await assemble({}, {}, async () => ({variables: {}}));
    expect(await request({}, async () => ({provider: 'x', model: 'x', maxTokens: 10})))
      .toEqual({provider: 'host-provider', model: 'app-pick', reasoningEffort: 'deep', maxTokens: 10});
  });

  it('records a Feishu pick in the session, where the App shows it', async () => {
    const f = fixture();
    const host = appHost(f);
    const session = await f.runtime.create(harness());
    session.setModelSelection!({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect(host.append).toHaveBeenCalledExactlyOnceWith('model/selection', {provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect(host.saveSelection).not.toHaveBeenCalled();
  });

  it('keeps a fixed route for restricted chats, administrator routes and hosts without a session record', async () => {
    for (const [policy, registered] of [[basePolicy, true], [harness({provider: 'admin', model: 'pinned'}), true], [harness(), false]] as const) {
      const f = fixture();
      const host = appHost(f, registered);
      const session = await f.runtime.create(policy);
      expect(session.sharesModelSelection).toBe(false);
      session.setModelSelection!({provider: 'host-provider', model: 'other'});
      expect(host.append).not.toHaveBeenCalled();
      expect(session.modelSelection!()).toEqual({provider: 'host-provider', model: 'other'});
    }
  });

  it('saves the App default through the host service the selector uses', async () => {
    const f = fixture();
    expect(f.runtime.sharesModelSelection()).toBe(false);
    const host = appHost(f);
    expect(f.runtime.sharesModelSelection()).toBe(true);
    await f.runtime.saveDefaultModel({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    expect(host.saveSelection).toHaveBeenCalledExactlyOnceWith({provider: 'host-provider', model: 'host-model', reasoningEffort: 'deep'});
    host.saveSelection.mockRejectedValueOnce(new Error('PRIVATE_CONFIG_PATH'));
    await expect(f.runtime.saveDefaultModel({provider: 'host-provider', model: 'host-model'})).rejects.toMatchObject({code: 'MODEL_UNAVAILABLE'});
  });
});
