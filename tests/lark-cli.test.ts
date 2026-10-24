import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { consumerFree, LarkCli, noActiveConsumers } from '../src/lark-cli.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
  close(code: number | null = 0) { this.emit('close', code, null); }
}

const ready = '[event] ready event_key=im.message.receive_v1\n';

describe('LarkCli subprocess transport', () => {
  let child: FakeChild;
  beforeEach(() => {
    child = new FakeChild();
    vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('pins the bot profile, waits for readiness, and keeps stdin open', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const events = vi.fn();
    const errors = vi.fn();
    const started = cli.start(events, errors);
    child.stdout.write('{"message_id":"om_1","content":"hello"}\n');
    expect(events).not.toHaveBeenCalled();
    expect(child.stdin.writableEnded).toBe(false);
    child.stderr.write(ready);
    await started;
    expect(events).toHaveBeenCalledWith({ message_id: 'om_1', content: 'hello' });
    expect(spawn).toHaveBeenCalledWith('lark-cli', ['--profile', 'team-bot', 'event', 'consume',
      'im.message.receive_v1', '--as', 'bot'], expect.objectContaining({ shell: false, stdio: 'pipe' }));
    const stopping = cli.stop();
    expect(child.stdin.writableEnded).toBe(true);
    child.close();
    await stopping;
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps message and callback consumers independent with exact readiness markers', async () => {
    const callbackChild = new FakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
      .mockReturnValueOnce(callbackChild as unknown as ReturnType<typeof spawn>);
    const messages = new LarkCli({profile: 'team-bot'});
    const callbacks = new LarkCli({profile: 'team-bot', eventKey: 'card.action.trigger'});
    const receivedMessage = vi.fn();
    const receivedCallback = vi.fn();
    const errors = vi.fn();
    const messageReady = messages.start(receivedMessage, errors);
    const callbackReady = callbacks.start(receivedCallback, errors);
    const action = {type: 'card.action.trigger', operator_id: 'ou_alice', message_id: 'om_card', action_value: '{"action":"status"}'};
    callbackChild.stdout.write(JSON.stringify(action) + '\n');
    callbackChild.stderr.write(ready);
    child.stderr.write('[event] ready event_key=card.action.trigger\n');
    expect(receivedCallback).not.toHaveBeenCalled();
    child.stderr.write(ready);
    await messageReady;
    child.stdout.write('{"type":"im.message.receive_v1"}\n');
    expect(receivedMessage).toHaveBeenCalledOnce();
    expect(receivedCallback).not.toHaveBeenCalled();
    callbackChild.stderr.write('[event] ready event_key=card.action.trigger\n');
    await callbackReady;
    expect(receivedCallback).toHaveBeenCalledWith(action);
    expect(vi.mocked(spawn).mock.calls[1]?.[1]).toEqual(['--profile', 'team-bot', 'event', 'consume', 'card.action.trigger', '--as', 'bot']);
    const messageStop = messages.stop();
    expect(callbackChild.stdin.writableEnded).toBe(false);
    child.close();
    await messageStop;
    const callbackStop = callbacks.stop();
    callbackChild.close();
    await callbackStop;
    expect(errors).not.toHaveBeenCalled();
  });

  it('decodes UTF-8 split across chunks and rejects malformed events', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const events = vi.fn();
    const errors = vi.fn();
    const started = cli.start(events, errors);
    child.stderr.write(ready);
    await started;
    const payload = Buffer.from('{"content":"你好"}\n');
    child.stdout.write(payload.subarray(0, 13));
    child.stdout.write(payload.subarray(13));
    expect(events).toHaveBeenCalledWith({ content: '你好' });
    child.stdout.write('secret-not-json\n');
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0].message).not.toContain('secret');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(1);
  });

  it('uses the menu event key and only its exact readiness marker', async () => {
    const cli = new LarkCli({profile: 'team-bot', eventKey: 'application.bot.menu_v6'});
    const received = vi.fn(), errors = vi.fn();
    const started = cli.start(received, errors);
    const event = {type: 'application.bot.menu_v6', event_id: 'event_menu', operator_open_id: 'ou_alice', event_key: 'dsh.sessions'};
    child.stdout.write(JSON.stringify(event) + '\n');
    child.stderr.write(ready + '[event] ready event_key=card.action.trigger\n');
    expect(received).not.toHaveBeenCalled();
    child.stderr.write('[event] ready event_key=application.bot.menu_v6\n'); await started;
    expect(received).toHaveBeenCalledWith(event);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'event', 'consume', 'application.bot.menu_v6', '--as', 'bot']);
    const stopped = cli.stop(); child.close(); await stopped; expect(errors).not.toHaveBeenCalled();
  });

  it('creates a private message through fixed bot API argv with identity and generated content only in stdin', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const text = '@file $(literal) `not-executed`\nprivate content';
    const sent = cli.sendUser('ou_alice', text, {idempotencyKey: 'menu-event-1'});
    expect(JSON.parse(child.stdin.read()?.toString())).toEqual({receive_id: 'ou_alice', msg_type: 'text',
      content: JSON.stringify({text}), uuid: 'menu-event-1'});
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'api', 'POST', '/open-apis/im/v1/messages',
      '--params', '{"receive_id_type":"open_id"}', '--data', '-', '--as', 'bot', '--format', 'json']);
    child.stdout.write('{"ok":true,"identity":"bot","data":{"message_id":"om_created","chat_id":"oc_private"}}');
    child.close(); await expect(sent).resolves.toBeUndefined();
  });

  it('creates native posts without downloading model-supplied Markdown images', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const markdown = '![literal](https://example.com/private.png)\n```html\n<at id=all></at>\n```';
    const sent = cli.sendRichUser('ou_alice', {kind: 'post', markdown}, {idempotencyKey: 'menu-post'});
    const body = JSON.parse(child.stdin.read()?.toString());
    expect(body.msg_type).toBe('post');
    expect(JSON.parse(body.content)).toEqual({zh_cn: {content: [[{tag: 'md', text: markdown}]]}});
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).not.toContain('--markdown');
    child.stdout.write('{"ok":true,"identity":"bot","data":{"message_id":"om_created","chat_id":"oc_private"}}');
    child.close(); await sent;
  });

  it('creates interactive messages with the bare card as content and no fabricated reply target', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const card = {schema: '2.0', body: {elements: [{tag: 'markdown', content: '请选择'}]}};
    const sent = cli.sendRichUser('ou_alice', {kind: 'card', card, fallbackText: '请选择'}, {idempotencyKey: 'menu-card'});
    expect(JSON.parse(child.stdin.read()?.toString())).toEqual({receive_id: 'ou_alice', msg_type: 'interactive',
      content: JSON.stringify(card), uuid: 'menu-card'});
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.some(value => value.includes('/reply'))).toBe(false);
    child.stdout.write('{"ok":true,"identity":"bot","data":{"message_id":"om_created","chat_id":"oc_private"}}');
    child.close(); await sent;
  });

  it.each([
    ['oc_group', 'key'], ['ou_bad/path', 'key'], ['ou_alice', ''], ['ou_alice', 'key\n'], ['ou_alice', 'x'.repeat(51)],
  ])('rejects invalid outbound identities and keys without spawning: %j %j', async (openId, idempotencyKey) => {
    await expect(new LarkCli({profile: 'team-bot'}).sendUser(openId, 'hello', {idempotencyKey})).rejects.toThrow('Invalid');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds the entire outbound JSON body before starting a child', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    await expect(cli.sendUser('ou_alice', '\\'.repeat(16_000), {idempotencyKey: 'size'})).rejects.toThrow('byte limit');
    await expect(cli.sendUser('ou_alice', '  ', {idempotencyKey: 'empty'})).rejects.toThrow('Invalid');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    {ok: true, identity: 'user', data: {message_id: 'om_x', chat_id: 'oc_x'}},
    {ok: true, identity: 'bot', dry_run: true, data: {message_id: 'om_x', chat_id: 'oc_x'}},
    {ok: true, identity: 'bot', data: {}},
    {ok: true, identity: 'bot', data: {message_id: 'om_x', chat_id: 'bad'}},
    {ok: false}, {code: 0},
  ])('requires actual bot creation evidence and never retries an uncertain send: %j', async output => {
    const sent = new LarkCli({profile: 'team-bot'}).sendUser('ou_alice', 'hello', {idempotencyKey: 'event'});
    child.stdout.write(JSON.stringify(output)); child.close();
    await expect(sent).rejects.toThrow('delivery is unknown'); expect(spawn).toHaveBeenCalledOnce();
  });

  it('times out private sends without retrying and drains their children on shutdown', async () => {
    vi.useFakeTimers(); const cli = new LarkCli({profile: 'team-bot', commandTimeoutMs: 100});
    const failed = expect(cli.sendUser('ou_alice', 'hello', {idempotencyKey: 'event'})).rejects.toThrow('delivery is unknown');
    child.stderr.write('private diagnostic'); await vi.advanceTimersByTimeAsync(100); await failed;
    expect(spawn).toHaveBeenCalledOnce(); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    let stopped = false; const stopping = cli.stop().then(() => {stopped = true;});
    await Promise.resolve(); expect(stopped).toBe(false);
    child.close(1); await stopping; expect(stopped).toBe(true);
  });

  const feedbackCard = () => ({kind: 'card' as const, fallbackText: 'private fallback', card: {
    schema: '2.0', config: {enable_forward: false, update_multi: false},
    body: {elements: [{tag: 'markdown', content: '正在读取 @file $(literal) `code`\n请稍候'}]},
  }});

  it('creates a private feedback card with a validated receipt and explicit shared updates, without mutating its input', async () => {
    const payload = feedbackCard(), original = structuredClone(payload);
    const result = new LarkCli({profile: 'team-bot'}).createFeedback({openId: 'ou_alice'}, payload, {idempotencyKey: 'loading-1'});
    const body = JSON.parse(child.stdin.read()?.toString());
    expect(body).toEqual({receive_id: 'ou_alice', msg_type: 'interactive', uuid: 'loading-1',
      content: JSON.stringify({...payload.card, config: {...payload.card.config, update_multi: true}})});
    expect(payload).toEqual(original); expect(body.content).not.toContain(payload.fallbackText);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'api', 'POST', '/open-apis/im/v1/messages',
      '--params', '{"receive_id_type":"open_id"}', '--data', '-', '--as', 'bot', '--format', 'json']);
    child.stdout.write('{"ok":true,"identity":"bot","dry_run":false,"data":{"message_id":"om_feedback","chat_id":"oc_private"}}');
    child.close(); await expect(result).resolves.toBe('om_feedback');
  });

  it.each([false, true])('creates reply feedback with an explicit thread choice %s and all content on stdin', async inThread => {
    const result = new LarkCli({profile: 'team-bot'}).createFeedback({messageId: 'om_prompt', inThread}, feedbackCard(), {idempotencyKey: 'loading-reply'});
    const body = JSON.parse(child.stdin.read()?.toString());
    expect(body).toMatchObject({msg_type: 'interactive', uuid: 'loading-reply', reply_in_thread: inThread});
    expect(body).not.toHaveProperty('receive_id'); expect(JSON.parse(body.content).config.update_multi).toBe(true);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'api', 'POST', '/open-apis/im/v1/messages/om_prompt/reply',
      '--data', '-', '--as', 'bot', '--format', 'json']);
    child.stdout.write('{"ok":true,"identity":"bot","data":{"message_id":"om_feedback","chat_id":"oc_private"}}');
    child.close(); await expect(result).resolves.toBe('om_feedback');
  });

  it('updates only the given bot card through raw PATCH and accepts the documented empty response', async () => {
    const payload = feedbackCard();
    const result = new LarkCli({profile: 'team-bot'}).updateFeedback('om_feedback', payload);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'api', 'PATCH', '/open-apis/im/v1/messages/om_feedback',
      '--data', '-', '--as', 'bot', '--format', 'json']);
    const body = JSON.parse(child.stdin.read()?.toString());
    expect(Object.keys(body)).toEqual(['content']); expect(JSON.parse(body.content).config.update_multi).toBe(true);
    child.stdout.write('{"ok":true,"identity":"bot","data":{}}'); child.close(); await expect(result).resolves.toBeUndefined();
  });

  it.each([
    {}, {openId: 'oc_chat'}, {openId: 'ou_bad/path'}, {openId: `ou_${'a'.repeat(129)}`},
    {openId: 'ou_alice', messageId: 'om_also'}, {messageId: 'om_prompt'},
    {messageId: 'om_prompt', inThread: 'false'}, {messageId: 'om_bad\n', inThread: false},
    {messageId: 'om_good', inThread: false, path: '/other'},
  ])('rejects ambiguous or malformed feedback targets before creating a child: %j', async target => {
    await expect(new LarkCli({profile: 'team-bot'}).createFeedback(target as never, feedbackCard(), {idempotencyKey: 'key'}))
      .rejects.toThrow('Invalid Lark feedback target');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['', 'om_bad/path', 'oc_group', `om_${'a'.repeat(257)}`])('rejects invalid feedback update IDs %j', async id => {
    await expect(new LarkCli({profile: 'team-bot'}).updateFeedback(id, feedbackCard())).rejects.toThrow('target');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['', 'a'.repeat(51), 'key\n', '$(key)'])('rejects invalid feedback idempotency keys %j', async idempotencyKey => {
    await expect(new LarkCli({profile: 'team-bot'}).createFeedback({openId: 'ou_alice'}, feedbackCard(), {idempotencyKey}))
      .rejects.toThrow('target');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([{kind: 'text', text: 'loading'}, {kind: 'post', markdown: 'loading'}, {kind: 'card', card: []},
    {kind: 'card', card: {config: 'invalid'}}, {kind: 'card', card: {toJSON: () => undefined}}])(
    'rejects non-card or malformed feedback content %j without sending fallback', async payload => {
      const cli = new LarkCli({profile: 'team-bot'});
      await expect(cli.createFeedback({openId: 'ou_alice'}, payload as never, {idempotencyKey: 'key'})).rejects.toThrow('card');
      await expect(cli.updateFeedback('om_card', payload as never)).rejects.toThrow('card');
      expect(spawn).not.toHaveBeenCalled();
    });

  it('enforces the complete escaped feedback body byte limit before create or update', async () => {
    const cli = new LarkCli({profile: 'team-bot'}), payload = feedbackCard();
    payload.card.body.elements[0]!.content = '"'.repeat(8000);
    await expect(cli.createFeedback({openId: 'ou_alice'}, payload, {idempotencyKey: 'key'})).rejects.toThrow('byte limit');
    await expect(cli.updateFeedback('om_card', payload)).rejects.toThrow('byte limit');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    {ok: true, identity: 'bot', data: {}},
    {ok: true, identity: 'bot', data: {message_id: 'om_x', chat_id: 'bad'}},
    {ok: true, identity: 'bot', data: {message_id: 'om_bad/path', chat_id: 'oc_x'}},
    {ok: true, identity: 'user', data: {message_id: 'om_x', chat_id: 'oc_x'}},
    {ok: true, identity: 'bot', dry_run: true, data: {message_id: 'om_x', chat_id: 'oc_x'}},
    {ok: false}, {code: 0},
  ])('requires bot delivery evidence for a feedback receipt and does not retry: %j', async output => {
    const pending = new LarkCli({profile: 'team-bot'}).createFeedback({openId: 'ou_alice'}, feedbackCard(), {idempotencyKey: 'key'});
    child.stdout.write(JSON.stringify(output)); child.close();
    await expect(pending).rejects.toThrow('delivery is unknown'); expect(spawn).toHaveBeenCalledOnce();
  });

  it.each([{ok: true}, {ok: true, identity: 'user'}, {ok: true, identity: 'bot', dry_run: true},
    {ok: true, identity: 'bot', dry_run: 'false'}, {ok: false}, {code: 0}])(
    'does not confirm an uncertain feedback patch or send fallback: %j', async output => {
      const pending = new LarkCli({profile: 'team-bot'}).updateFeedback('om_card', feedbackCard());
      child.stdout.write(JSON.stringify(output)); child.close();
      await expect(pending).rejects.toThrow('delivery is unknown'); expect(spawn).toHaveBeenCalledOnce();
    });

  it.each(['create', 'update'] as const)('bounds %s feedback at five seconds and drains its child on shutdown', async kind => {
    vi.useFakeTimers(); const cli = new LarkCli({profile: 'team-bot', commandTimeoutMs: 30_000});
    const operation = kind === 'create' ? cli.createFeedback({openId: 'ou_alice'}, feedbackCard(), {idempotencyKey: 'key'})
      : cli.updateFeedback('om_card', feedbackCard());
    const failed = expect(operation).rejects.toThrow('delivery is unknown');
    child.stderr.write('private diagnostic');
    await vi.advanceTimersByTimeAsync(4999); expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await failed;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(spawn).toHaveBeenCalledOnce();
    let stopped = false; const stopping = cli.stop().then(() => {stopped = true;});
    await Promise.resolve(); expect(stopped).toBe(false);
    child.close(1); await stopping; expect(stopped).toBe(true);
    await expect(cli.updateFeedback('om_late', feedbackCard())).rejects.toThrow('transport is stopped');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('fails readiness on unexpected exit without leaking diagnostics', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const started = cli.start(vi.fn(), vi.fn());
    child.stderr.write('secret-token-and-message-body\n');
    child.close(3);
    await expect(started).rejects.toThrow('code 3');
  });

  it('reports an unexpected exit after readiness', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const errors = vi.fn();
    const started = cli.start(vi.fn(), errors);
    child.stderr.write(ready);
    await started;
    child.close(4);
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0].message).toContain('code 4');
  });

  it('bounds pre-readiness buffering', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const started = cli.start(vi.fn(), vi.fn());
    for (let i = 0; i < 101; i++) child.stdout.write('{}\n');
    await expect(started).rejects.toThrow('buffer before readiness');
    child.close(1);
  });

  it('times out startup and terminates gracefully', async () => {
    vi.useFakeTimers();
    const cli = new LarkCli({ profile: 'team-bot', readyTimeoutMs: 100 });
    const result = expect(cli.start(vi.fn(), vi.fn())).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(1);
  });

  it('sends generated text through stdin with stable idempotency and thread flags', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const body = '@file $(do-not-execute) `literal`\nhello';
    const result = cli.reply('om_123', body, { idempotencyKey: 'reply-123', inThread: true });
    expect(child.stdin.read()?.toString()).toBe(body);
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['--profile', 'team-bot', 'im', '+messages-reply', '--message-id', 'om_123',
      '--text', '-', '--as', 'bot', '--format', 'json', '--idempotency-key', 'reply-123', '--reply-in-thread']);
    expect(args).not.toContain(body);
    child.stdout.write('{"ok":true,"data":{"message_id":"om_reply"}}');
    child.close();
    await result;
  });

  it('sends a post as native Markdown JSON without invoking CLI Markdown conversion', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const markdown = '**正文**\n![图片](https://example.com/private.png)\n`@file $(literal)`';
    const result = cli.replyRich('om_post', {kind: 'post', markdown}, {idempotencyKey: 'rich-post', inThread: false});
    const body = JSON.parse(child.stdin.read()?.toString());
    expect(body).toEqual({msg_type: 'post', content: JSON.stringify({zh_cn: {content: [[{tag: 'md', text: markdown}]]}}),
      uuid: 'rich-post', reply_in_thread: false});
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).toEqual(['--profile', 'team-bot', 'api', 'POST', '/open-apis/im/v1/messages/om_post/reply',
      '--data', '-', '--as', 'bot', '--format', 'json']);
    expect(args).not.toContain('--markdown');
    expect(args).not.toContain(markdown);
    child.stdout.write('{"ok":true}');
    child.close();
    await result;
  });

  it('preserves native tags in post code without the shortcut corrupting serialized JSON', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const markdown = '```html\n<at id=all></at>\n<at user_id="ou_example">example</at>\n```';
    const result = cli.replyRich('om_code', {kind: 'post', markdown}, {idempotencyKey: 'native-code', inThread: true});
    const envelope = JSON.parse(child.stdin.read()?.toString());
    expect(JSON.parse(envelope.content)).toEqual({zh_cn: {content: [[{tag: 'md', text: markdown}]]}});
    expect(envelope).toMatchObject({msg_type: 'post', uuid: 'native-code', reply_in_thread: true});
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).not.toContain('+messages-reply');
    child.stdout.write('{"ok":true}');
    child.close();
    await result;
  });

  it('adds the official Typing reaction as the bot and returns only its validated ID', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const pending = cli.startProgress('om_prompt');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'im', 'reactions', 'create',
      '--message-id', 'om_prompt', '--data', '-', '--as', 'bot', '--format', 'json']);
    expect(JSON.parse(child.stdin.read()?.toString())).toEqual({reaction_type: {emoji_type: 'Typing'}});
    child.stdout.write('{"ok":true,"data":{"reaction_id":"reaction-private-id_1","operator":{"operator_type":"app"}}}');
    child.close();
    await expect(pending).resolves.toBe('reaction-private-id_1');
  });

  it('removes only the specified progress reaction and keeps its ID out of argv', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const pending = cli.finishProgress('om_prompt', 'reaction-private-id_1');
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).toEqual(['--profile', 'team-bot', 'im', 'reactions', 'delete', '--params', '-', '--as', 'bot', '--format', 'json']);
    expect(args).not.toContain('reaction-private-id_1');
    expect(JSON.parse(child.stdin.read()?.toString())).toEqual({message_id: 'om_prompt', reaction_id: 'reaction-private-id_1'});
    child.stdout.write('{"ok":true,"data":{"reaction_id":"reaction-private-id_1"}}');
    child.close();
    await expect(pending).resolves.toBeUndefined();
  });

  it.each(['{}', '{"reaction_id":""}', '{"reaction_id":"private\\ninvalid"}', '{"reaction_id":17}'])('rejects an unusable reaction response without exposing it: %s', async data => {
    const cli = new LarkCli({profile: 'team-bot'});
    const pending = cli.startProgress('om_prompt');
    child.stdout.write(`{"ok":true,"data":${data}}`);
    child.close();
    await expect(pending).rejects.toThrow('Lark progress command did not return a valid reaction ID.');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('rejects invalid progress targets before launching a CLI child', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    await expect(cli.startProgress('oc_chat')).rejects.toThrow('progress target');
    await expect(cli.finishProgress('om_prompt', 'invalid\nreaction')).rejects.toThrow('progress target');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds progress work at five seconds without retrying or leaking diagnostics', async () => {
    vi.useFakeTimers();
    const cli = new LarkCli({profile: 'team-bot', commandTimeoutMs: 30_000});
    const pending = expect(cli.startProgress('om_prompt')).rejects.toThrow('Lark progress command exceeded its deadline; result is unknown.');
    child.stderr.write('private-token-and-message-body');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(1);
  });

  it('sanitizes a progress API failure and allows the actual reply to proceed', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const progress = cli.startProgress('om_prompt');
    child.stderr.write('{"ok":false,"error":{"message":"private-api-credential"}}');
    child.close(3);
    await expect(progress).rejects.toThrow('Lark progress command failed (exit 3); result is unknown.');
    const outgoing = new FakeChild();
    vi.mocked(spawn).mockReturnValueOnce(outgoing as unknown as ReturnType<typeof spawn>);
    const reply = cli.reply('om_prompt', 'Final answer', {idempotencyKey: 'actual-reply', inThread: false});
    outgoing.stdout.write('{"ok":true}');
    outgoing.close();
    await expect(reply).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('tracks and drains progress children during shutdown without an event consumer', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const pending = expect(cli.finishProgress('om_prompt', 'reaction-private')).rejects.toThrow('was stopped');
    let stopped = false;
    const shutdown = cli.stop().then(() => { stopped = true; });
    await pending;
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(cli.startProgress('om_late')).rejects.toThrow('transport is stopped');
    expect(spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close();
    await shutdown;
    expect(stopped).toBe(true);
  });

  it('sends the bare Card JSON on stdin and retains thread and idempotency options', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const card = {schema: '2.0', config: {summary: {content: '查看状态'}}, body: {elements: [{tag: 'markdown', content: '**已保存**'}]}};
    const result = cli.replyRich('om_card', {kind: 'card', card, fallbackText: 'fallback-private-text'}, {idempotencyKey: 'rich-card', inThread: true});
    const input = child.stdin.read()?.toString();
    expect(JSON.parse(input)).toEqual(card);
    expect(input).not.toContain('fallback-private-text');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'im', '+messages-reply', '--message-id', 'om_card',
      '--msg-type', 'interactive', '--content', '-', '--as', 'bot', '--format', 'json', '--idempotency-key', 'rich-card', '--reply-in-thread']);
    child.stdout.write('{"ok":true}');
    child.close();
    await result;
  });

  it('rejects unserializable cards and oversized serialized rich content before spawning', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const circular: Record<string, unknown> = {private: 'secret-body'};
    circular.self = circular;
    await expect(cli.replyRich('om_card', {kind: 'card', card: circular, fallbackText: 'fallback'}, {idempotencyKey: 'circular', inThread: false}))
      .rejects.toThrow('Invalid Lark reply payload.');
    await expect(cli.replyRich('om_card', {kind: 'card', card: {toJSON: () => undefined}, fallbackText: 'fallback'}, {idempotencyKey: 'empty-json', inThread: false}))
      .rejects.toThrow('Invalid Lark reply payload.');
    // JSON escaping increases the transport bytes beyond the plain text size.
    await expect(cli.replyRich('om_post', {kind: 'post', markdown: '"'.repeat(600_000)}, {idempotencyKey: 'oversized', inThread: false}))
      .rejects.toThrow('message byte limit');
    await expect(cli.replyRich('om_post', {kind: 'post', markdown: '"'.repeat(8000)}, {idempotencyKey: 'escaped-wire', inThread: true}))
      .rejects.toThrow('message byte limit');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not retry or send fallback text after an uncertain card delivery', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const result = cli.replyRich('om_card', {kind: 'card', card: {schema: '2.0', body: {elements: []}}, fallbackText: 'fallback-secret'},
      {idempotencyKey: 'uncertain-card', inThread: false});
    child.stderr.write('{"ok":false,"error":{"message":"secret-token-and-card-body"}}');
    child.close(1);
    await expect(result).rejects.toThrow('Lark reply command failed (exit 1); delivery is unknown.');
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each(['{"code":0}', '{"ok":false}', 'invalid'])('requires the CLI success envelope: %s', async (output) => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const result = cli.reply('om_123', 'hello', { idempotencyKey: 'reply-123', inThread: false });
    child.stdout.write(output);
    child.close();
    await expect(result).rejects.toThrow('delivery is unknown');
  });

  it('times out a reply without retrying or leaking command diagnostics', async () => {
    vi.useFakeTimers();
    const cli = new LarkCli({ profile: 'team-bot', commandTimeoutMs: 100 });
    const result = expect(cli.reply('om_123', 'hello', { idempotencyKey: 'reply-123', inThread: false }))
      .rejects.toThrow('delivery is unknown');
    child.stderr.write('secret-token\n');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(1);
  });

  it('rejects empty transport configuration', () => {
    expect(() => new LarkCli({ profile: '' })).toThrow('profile');
    expect(() => new LarkCli({ profile: 'bot', executable: '' })).toThrow('executable');
    expect(() => new LarkCli({ profile: 'bot', readyTimeoutMs: 0 })).toThrow('timeouts');
    expect(() => new LarkCli({ profile: 'bot', eventKey: 'private.invalid' as never })).toThrow('event key');
  });

  it.each([
    'WARN: event seq gap 1->5, missed 3 events (dropped by bus backpressure)',
    'WARN: consume backpressure, dropped oldest event',
    'WARN: event secret-id (im.message.receive_v1) dropped: malformed payload',
    'WARN: Process error: private-payload',
    'WARN: sink write failed, skipping event: private-payload',
  ])('surfaces event loss without leaking stderr: %s', async (diagnostic) => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const errors = vi.fn();
    const events = vi.fn();
    const started = cli.start(events, errors);
    child.stderr.write(ready);
    await started;
    child.stderr.write(`${diagnostic}\n`);
    child.stdout.write('{}\n');
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]?.[0].message).toBe('Lark event consumer reported an integrity warning; events may have been lost.');
    expect(events).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.close(1);
  });

  it('ignores benign diagnostics and source reconnect progress', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const errors = vi.fn();
    const started = cli.start(vi.fn(), errors);
    child.stderr.write('[event] skipped console precheck: unavailable\n');
    child.stderr.write(ready);
    await started;
    child.stderr.write('[source] feishu: reconnecting (attempt 1)\n');
    child.stderr.write('WARN: event om_1 (im.message.receive_v1): malformed observed_at ignored\n');
    expect(errors).not.toHaveBeenCalled();
    const stopped = cli.stop();
    child.close();
    await stopped;
  });

  it('rejects a startup error envelope with a sanitized error', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const started = cli.start(vi.fn(), vi.fn());
    child.stderr.write('{"ok":false,"error":{"message":"private-token"}}\n');
    await expect(started).rejects.toThrow('reported a command failure');
    child.close(3);
  });

  it('waits for reply child exit during disposal even without an event consumer', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const reply = cli.reply('om_123', 'hello', { idempotencyKey: 'reply-123', inThread: false });
    const rejected = expect(reply).rejects.toThrow('was stopped');
    const stopped = cli.stop();
    expect(cli.stop()).toBe(stopped);
    await rejected;
    let finished = false;
    void stopped.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(cli.reply('om_123', 'late', { idempotencyKey: 'late', inThread: false })).rejects.toThrow('stopped');
    expect(spawn).toHaveBeenCalledOnce();
    child.close();
    await stopped;
    expect(finished).toBe(true);
  });

  it('waits for both the consumer and the reply before disposal completes', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const started = cli.start(vi.fn(), vi.fn());
    child.stderr.write(ready);
    await started;
    const outgoing = new FakeChild();
    vi.mocked(spawn).mockReturnValueOnce(outgoing as unknown as ReturnType<typeof spawn>);
    const reply = expect(cli.reply('om_123', 'hello', { idempotencyKey: 'reply-123', inThread: false }))
      .rejects.toThrow('was stopped');
    const stopped = cli.stop();
    await reply;
    child.close();
    let finished = false;
    void stopped.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    outgoing.close();
    await stopped;
  });

  it('drains both event consumers and every rich reply child during coordinated shutdown', async () => {
    const callbackChild = new FakeChild();
    const postChild = new FakeChild();
    const cardChild = new FakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
      .mockReturnValueOnce(callbackChild as unknown as ReturnType<typeof spawn>)
      .mockReturnValueOnce(postChild as unknown as ReturnType<typeof spawn>)
      .mockReturnValueOnce(cardChild as unknown as ReturnType<typeof spawn>);
    const messages = new LarkCli({profile: 'team-bot'});
    const callbacks = new LarkCli({profile: 'team-bot', eventKey: 'card.action.trigger'});
    const messageReady = messages.start(vi.fn(), vi.fn());
    const callbackReady = callbacks.start(vi.fn(), vi.fn());
    child.stderr.write(ready);
    callbackChild.stderr.write('[event] ready event_key=card.action.trigger\n');
    await Promise.all([messageReady, callbackReady]);
    const post = expect(messages.replyRich('om_post', {kind: 'post', markdown: '**body**'}, {idempotencyKey: 'p', inThread: false})).rejects.toThrow('was stopped');
    const card = expect(callbacks.replyRich('om_card', {kind: 'card', card: {schema: '2.0', body: {elements: []}}, fallbackText: 'body'},
      {idempotencyKey: 'c', inThread: false})).rejects.toThrow('was stopped');
    let finished = false;
    const stopped = Promise.all([messages.stop(), callbacks.stop()]).then(() => { finished = true; });
    await Promise.all([post, card]);
    child.close();
    callbackChild.close();
    postChild.close();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(cardChild.kill).toHaveBeenCalledWith('SIGTERM');
    cardChild.close();
    await stopped;
    expect(finished).toBe(true);
  });

  it('does not cancel in-flight replies during consumer-only reconnect', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const started = cli.start(vi.fn(), vi.fn());
    child.stderr.write(ready);
    await started;
    const outgoing = new FakeChild();
    vi.mocked(spawn).mockReturnValueOnce(outgoing as unknown as ReturnType<typeof spawn>);
    const reply = cli.reply('om_123', 'hello', { idempotencyKey: 'reply-123', inThread: false });
    const stopped = cli.stop({ cancelReplies: false });
    child.close();
    await stopped;
    expect(outgoing.kill).not.toHaveBeenCalled();
    outgoing.stdout.write('{"ok":true}');
    outgoing.close();
    await reply;
  });

  it('upgrades a consumer-only stop to full disposal and waits for replies', async () => {
    const cli = new LarkCli({ profile: 'team-bot' });
    const started = cli.start(vi.fn(), vi.fn());
    child.stderr.write(ready);
    await started;
    const outgoing = new FakeChild();
    vi.mocked(spawn).mockReturnValueOnce(outgoing as unknown as ReturnType<typeof spawn>);
    const reply = expect(cli.reply('om_123', 'hello', { idempotencyKey: 'reply-123', inThread: false }))
      .rejects.toThrow('was stopped');
    const reconnect = cli.stop({ cancelReplies: false });
    const disposed = cli.stop();
    expect(disposed).not.toBe(reconnect);
    child.close();
    await reconnect;
    await reply;
    expect(outgoing.kill).toHaveBeenCalledWith('SIGTERM');
    outgoing.close();
    await disposed;
  });

  it('fails bounded disposal when a reply process does not exit', async () => {
    vi.useFakeTimers();
    const cli = new LarkCli({ profile: 'team-bot' });
    const reply = expect(cli.reply('om_123', 'hello', { idempotencyKey: 'reply-123', inThread: false }))
      .rejects.toThrow('was stopped');
    const stopped = expect(cli.stop()).rejects.toThrow('shutdown is incomplete');
    await reply;
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(child.kill.mock.calls.every(([signal]) => signal === 'SIGTERM')).toBe(true);
    child.close();
  });
});

describe('event consumer check before a bot lease takeover', () => {
  let child: FakeChild;
  beforeEach(() => {
    child = new FakeChild();
    vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });

  it('accepts only a stopped bus, or a running one without consumers, for exactly one app', () => {
    // Shapes from larksuite/cli cmd/event/status.go (`event status --current --json`).
    expect(consumerFree({apps: [{app_id: 'cli_fixture', status: 'not_running', running: false}]})).toBe(true);
    expect(consumerFree({apps: [{app_id: 'cli_fixture', status: 'running', running: true, pid: 9, uptime_sec: 5}]})).toBe(true);
    expect(consumerFree({apps: [{app_id: 'cli_fixture', status: 'running', running: true, active_consumers: 1,
      consumers: [{pid: 7, event_key: 'im.message.receive_v1'}]}]})).toBe(false);
    expect(consumerFree({apps: [{app_id: 'cli_fixture', status: 'running', running: true, consumers: [{pid: 7}]}]})).toBe(false);
    // An orphan bus lost its socket, so its consumers cannot be queried.
    expect(consumerFree({apps: [{app_id: 'cli_fixture', status: 'orphan', running: false, pid: 9}]})).toBe(false);
    for (const value of [null, [], {}, {apps: []}, {apps: [{status: 'not_running'}, {status: 'not_running'}]},
      {apps: [{status: 'starting'}]}, {apps: [{status: 'running', active_consumers: '0'}]}, {apps: [{status: 'running', consumers: {}}]}]) {
      expect(consumerFree(value)).toBe(false);
    }
  });

  it('asks the bot profile read-only and treats any failure or timeout as an active consumer', async () => {
    const free = noActiveConsumers({profile: 'team-bot', executable: '/opt/lark-cli'});
    child.stdout.write(JSON.stringify({apps: [{app_id: 'cli_fixture', status: 'not_running', running: false}]}));
    child.close();
    expect(await free).toBe(true);
    expect(spawn).toHaveBeenCalledWith('/opt/lark-cli', ['--profile', 'team-bot', 'event', 'status', '--current', '--json'],
      expect.objectContaining({shell: false}));
    expect(child.stdin.writableEnded).toBe(true);
    for (const finish of [(next: FakeChild) => next.close(1), (next: FakeChild) => {next.stdout.write('not json'); next.close();},
      (next: FakeChild) => next.emit('error', new Error('spawn ENOENT'))]) {
      const next = new FakeChild();
      vi.mocked(spawn).mockReturnValueOnce(next as unknown as ReturnType<typeof spawn>);
      const pending = noActiveConsumers({profile: 'team-bot'});
      finish(next);
      expect(await pending).toBe(false);
    }
    const slow = new FakeChild();
    vi.mocked(spawn).mockReturnValueOnce(slow as unknown as ReturnType<typeof spawn>);
    expect(await noActiveConsumers({profile: 'team-bot', timeoutMs: 10})).toBe(false);
    expect(slow.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('LarkCli live cards and files', () => {
  let child: FakeChild;
  beforeEach(() => {
    child = new FakeChild();
    vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });
  const card = (text = 'hello') => ({schema: '2.0', body: {elements: [{tag: 'markdown', element_id: 'answer', content: text}]}});
  const args = () => vi.mocked(spawn).mock.calls[0]?.[1];
  const body = () => JSON.parse(child.stdin.read()?.toString());

  it('creates a JSON 2.0 card entity on stdin and returns only a validated card ID', async () => {
    const result = new LarkCli({profile: 'team-bot'}).createCardEntity(card());
    expect(args()).toEqual(['--profile', 'team-bot', 'api', 'POST', '/open-apis/cardkit/v1/cards', '--data', '-', '--as', 'bot', '--format', 'json']);
    expect(body()).toEqual({type: 'card_json', data: JSON.stringify(card())});
    child.stdout.write('{"ok":true,"identity":"bot","data":{"card_id":"7355372766134157313"}}');
    child.close();
    await expect(result).resolves.toBe('7355372766134157313');
  });

  it('rejects an unconfirmed card entity and oversized or legacy cards before spawning', async () => {
    const result = new LarkCli({profile: 'team-bot'}).createCardEntity(card());
    child.stdout.write('{"ok":true,"identity":"bot","data":{"card_id":"../x"}}');
    child.close();
    await expect(result).rejects.toThrow('not confirmed');
    vi.mocked(spawn).mockClear();
    await expect(new LarkCli({profile: 'team-bot'}).createCardEntity({schema: '1.0'})).rejects.toThrow('Invalid Lark card entity');
    await expect(new LarkCli({profile: 'team-bot'}).createCardEntity(card('x'.repeat(30_000)))).rejects.toThrow('size limit');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])('replies with a card entity reference and an explicit thread choice %s', async inThread => {
    const result = new LarkCli({profile: 'team-bot'}).replyCardEntity('om_prompt', '7355', {idempotencyKey: 'live-1', inThread});
    expect(args()).toEqual(['--profile', 'team-bot', 'api', 'POST', '/open-apis/im/v1/messages/om_prompt/reply', '--data', '-', '--as', 'bot', '--format', 'json']);
    expect(body()).toEqual({msg_type: 'interactive', content: JSON.stringify({type: 'card', data: {card_id: '7355'}}), uuid: 'live-1', reply_in_thread: inThread});
    child.stdout.write('{"ok":true,"identity":"bot","data":{"message_id":"om_live"}}');
    child.close();
    await expect(result).resolves.toBeUndefined();
  });

  it('streams element text with a strictly increasing caller sequence and replaces whole cards with PUT', async () => {
    const cli = new LarkCli({profile: 'team-bot'});
    const streamed = cli.streamCardText('7355', 'answer', 'partial text', 3);
    expect(args()).toEqual(['--profile', 'team-bot', 'api', 'PUT', '/open-apis/cardkit/v1/cards/7355/elements/answer/content',
      '--data', '-', '--as', 'bot', '--format', 'json']);
    expect(body()).toEqual({content: 'partial text', sequence: 3, uuid: expect.stringMatching(/^[0-9a-f-]{36}$/)});
    child.stdout.write('{"ok":true,"identity":"bot","data":{}}');
    child.close();
    await streamed;
    const second = new FakeChild();
    vi.mocked(spawn).mockReset().mockReturnValue(second as unknown as ReturnType<typeof spawn>);
    const updated = cli.updateCardEntity('7355', card('final'), 4);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--profile', 'team-bot', 'api', 'PUT', '/open-apis/cardkit/v1/cards/7355',
      '--data', '-', '--as', 'bot', '--format', 'json']);
    expect(JSON.parse(second.stdin.read()?.toString())).toEqual({card: {type: 'card_json', data: JSON.stringify(card('final'))}, sequence: 4,
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/)});
    second.stdout.write('{"ok":true,"identity":"bot","data":{}}');
    second.close();
    await updated;
  });

  it.each([
    ['../7355', 'answer', 'text', 1], ['7355', 'Answer', 'text', 1], ['7355', 'answer/x', 'text', 1],
    ['7355', 'answer', '', 1], ['7355', 'answer', 'text', 0], ['7355', 'answer', 'text', 1.5],
  ])('rejects malformed stream updates before spawning: %s %s', async (cardId, elementId, content, sequence) => {
    await expect(new LarkCli({profile: 'team-bot'}).streamCardText(cardId, elementId, content, sequence)).rejects.toThrow('Invalid Lark card stream update');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])('uploads one validated file by ./basename from its own directory (image %s)', async image => {
    const result = new LarkCli({profile: 'team-bot'}).replyFile('om_prompt', '/work/space/file_v2.pdf', {idempotencyKey: 'file-1', inThread: true, image});
    expect(args()).toEqual(['--profile', 'team-bot', 'im', '+messages-reply', '--message-id', 'om_prompt', `--${image ? 'image' : 'file'}=./file_v2.pdf`,
      '--as', 'bot', '--format', 'json', '--idempotency-key', 'file-1', '--reply-in-thread']);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({cwd: '/work/space', shell: false});
    child.stdout.write('{"ok":true,"identity":"bot","data":{"message_id":"om_file"}}');
    child.close();
    await expect(result).resolves.toBeUndefined();
  });

  it.each(['relative/file.pdf', '/work/space/', '/work/space/bad\nname', '/work/space/..'])('rejects unsafe file paths before spawning: %j', async path => {
    await expect(new LarkCli({profile: 'team-bot'}).replyFile('om_prompt', path, {idempotencyKey: 'file-1', inThread: false, image: false}))
      .rejects.toThrow('Invalid Lark file reply');
    expect(spawn).not.toHaveBeenCalled();
  });
});
