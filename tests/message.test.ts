import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { authorize, chunksByBytes, parseMessage, sessionKey } from '../src/message.js';

const bot = 'ou_bot';
const config = parseConfig({profile: 'test', botOpenId: bot, users: [
  {openId: 'ou_alice', direct: true, groupChats: ['oc_group'], cwd: '/tmp/alice'},
  {openId: 'ou_bob', direct: false, groupChats: ['oc_group'], cwd: '/tmp/bob'},
]});
const event = (extra: Record<string, unknown> = {}) => ({
  type: 'im.message.receive_v1', sender_type: 'user', sender_id: 'ou_alice',
  message_id: 'om_message', chat_id: 'oc_direct', chat_type: 'p2p', message_type: 'text', content: 'hello', ...extra,
});

describe('parseMessage', () => {
  it('reads already decoded compact text without interpreting it as JSON', () => {
    expect(parseMessage(event({content: '{"text":"literal"}'}), bot)?.text).toBe('{"text":"literal"}');
  });

  it.each([
    null, [], {}, {event: event()}, event({type: 'other'}), event({sender_type: 'bot'}),
    event({sender_id: bot}), event({message_type: 'interactive'}), event({message_type: 'image'}),
    event({sender_id: 'ou_bad/../id'}), event({chat_id: 'bad'}), event({message_id: 'bad'}),
    event({chat_type: 'channel'}), event({content: {text: 'hello'}}), event({content: '  '}),
  ])('fails closed on unknown, malformed, or bot-origin events: %j', (raw) => {
    expect(parseMessage(raw, bot)).toBeUndefined();
  });

  it('requires an actual matching group mention, not its visible text', () => {
    expect(parseMessage(event({chat_type: 'group', content: '@DSH hello'}), bot)).toBeUndefined();
    expect(parseMessage(event({chat_type: 'group', mentions: [{id: 'ou_other', name: 'DSH'}]}), bot)).toBeUndefined();
    expect(parseMessage(event({chat_type: 'group', mentions: [{id: {open_id: bot}}]}), bot)).toBeUndefined();
  });

  it('removes the bot placeholder while preserving other mentions', () => {
    const raw = event({chat_type: 'group', content: '@_user_1 hello @_user_2', mentions: [
      {id: bot, name: 'DSH', key: '@_user_1'}, {id: 'ou_other', name: 'Bob', key: '@_user_2'},
    ]});
    expect(parseMessage(raw, bot)?.text).toBe('hello @_user_2');
  });

  it('recognizes commands after the CLI-rendered @name mention', () => {
    // larksuite/cli events/im/message_receive_test.go expects "hello @Alice".
    const raw = event({chat_type: 'group', content: '@DSH /new', mentions: [{id: bot, name: 'DSH', key: '@_user_1'}]});
    expect(parseMessage(raw, bot)?.text).toBe('/new');
  });

  it('removes exact HTML bot mentions without consuming another user', () => {
    const raw = event({chat_type: 'group', message_type: 'post',
      content: '<at user_id="ou_bot">DSH</at> hello <at user_id="ou_other">Bob</at>',
      mentions: [{id: bot, name: 'DSH', key: '@_user_1'}],
    });
    expect(parseMessage(raw, bot)?.text).toBe('hello <at user_id="ou_other">Bob</at>');
  });

  it('selects only a valid thread id; a quote reply root stays in the current conversation', () => {
    expect(parseMessage(event({thread_id: 'omt_thread', root_id: 'om_root'}), bot)?.threadId).toBe('omt_thread');
    expect(parseMessage(event({thread_id: 'invalid', root_id: 'om_root'}), bot)?.threadId).toBe('');
    expect(parseMessage(event({root_id: 'om_root', reply_to: 'om_parent'}), bot)?.threadId).toBe('');
    expect(parseMessage(event({thread_id: 'invalid', root_id: 'invalid'}), bot)?.threadId).toBe('');
  });
});

describe('message authorization and isolation', () => {
  it('requires a listed user and an explicitly permitted chat surface', () => {
    const direct = parseMessage(event(), bot)!;
    expect(authorize(direct, config)?.openId).toBe('ou_alice');
    expect(authorize({...direct, senderId: 'ou_unknown'}, config)).toBeUndefined();
    expect(authorize({...direct, senderId: 'ou_bob'}, config)).toBeUndefined();
    expect(authorize({...direct, senderId: 'ou_bob', chatType: 'group', chatId: 'oc_group'}, config)?.openId).toBe('ou_bob');
    expect(authorize({...direct, chatType: 'group', chatId: 'oc_not_allowed'}, config)).toBeUndefined();
  });

  it('separates users, chats, chat types, threads, profiles and bots', () => {
    const message = parseMessage(event(), bot)!;
    const keys = [
      sessionKey(message, config), sessionKey({...message, senderId: 'ou_bob'}, config),
      sessionKey({...message, chatId: 'oc_other'}, config), sessionKey({...message, chatType: 'group'}, config),
      sessionKey({...message, threadId: 'omt_one'}, config), sessionKey({...message, threadId: 'omt_two'}, config),
      sessionKey(message, {...config, profile: 'another'}), sessionKey(message, {...config, botOpenId: 'ou_otherbot'}),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(sessionKey({...message, messageId: 'om_next', text: 'next'}, config)).toBe(keys[0]);
  });
});

describe('chunksByBytes', () => {
  it('preserves Unicode code points and the exact content within each byte limit', () => {
    const text = '你好😀界\nabc🌏末尾';
    for (const limit of [4, 5, 8, 10, 100]) {
      const chunks = chunksByBytes(text, limit);
      expect(chunks.join('')).toBe(text);
      expect(chunks.every(chunk => chunk.length > 0 && Buffer.byteLength(chunk, 'utf8') <= limit)).toBe(true);
      expect(chunks.every(chunk => !chunk.includes('\uFFFD'))).toBe(true);
    }
  });

  it('handles an empty response and rejects an unusable byte limit', () => {
    expect(chunksByBytes('', 4)).toEqual([]);
    expect(() => chunksByBytes('a', 3)).toThrow();
  });
});
