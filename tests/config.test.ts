import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
const base = () => ({profile: 'team-bot', botOpenId: 'ou_bot', users: [{openId: 'ou_alice', cwd: '/tmp/alice'}]});
describe('runtime policy parsing', () => {
  it('defaults to explicit admission and no tool capabilities', () => {
    const config = parseConfig(base(), '/tmp/config');
    expect(config.users[0]).toMatchObject({direct: false, groupChats: [], allowedTools: [], directMode: 'restricted'});
    expect(config.stateDir).toBe('/tmp/config/.state');
    expect(config.botMenu).toBe(false);
    expect(config.streamingCards).toBe(false);
    // An agent's turn runs until done or /stop unless an administrator caps it.
    expect(config.turnTimeoutMs).toBeUndefined();
    expect(parseConfig({...base(), turnTimeoutMs: 300_000}).turnTimeoutMs).toBe(300_000);
  });
  it('requires unique users with absolute work directories', () => {
    expect(() => parseConfig({...base(), users: [base().users[0], base().users[0]]})).toThrow('Duplicate');
    expect(() => parseConfig({...base(), users: [{openId: 'ou_alice', cwd: '../alice'}]})).toThrow('absolute');
  });
  it('rejects wildcard and code transport tool grants', () => {
    for (const allowedTools of [['*'], ['run_code']]) {
      expect(() => parseConfig({...base(), users: [{...base().users[0], allowedTools}]})).toThrow('exact tool names');
    }
  });
  it('rejects missing/invalid admission IDs and accidental string booleans', () => {
    expect(() => parseConfig({...base(), users: []})).toThrow('allowlist');
    expect(() => parseConfig({...base(), botOpenId: 'cli_application'})).toThrow('ou_');
    expect(() => parseConfig({...base(), users: [{...base().users[0], direct: 'true'}]})).toThrow('boolean');
  });
  it('bounds queues and timeouts before processing starts', () => {
    for (const input of [{maxPending: 0}, {turnTimeoutMs: Number.POSITIVE_INFINITY}, {maxSessions: 0}]) {
      expect(() => parseConfig({...base(), ...input})).toThrow('integer');
    }
  });
  it('lets a private chat opt into harness mode and opt-in live cards', () => {
    const config = parseConfig({...base(), streamingCards: true, users: [{...base().users[0], direct: true, directMode: 'harness'}]});
    expect(config.users[0]!.directMode).toBe('harness');
    expect(config.streamingCards).toBe(true);
    for (const directMode of ['full', true, 'Harness']) {
      expect(() => parseConfig({...base(), users: [{...base().users[0], directMode}]})).toThrow('directMode must be harness or restricted');
    }
    for (const streamingCards of ['true', 1]) expect(() => parseConfig({...base(), streamingCards})).toThrow('streamingCards must be boolean');
  });
  it('requires an explicit boolean opt-in for the menu receiver', () => {
    expect(parseConfig({...base(), botMenu: true}).botMenu).toBe(true);
    for (const botMenu of ['true', 1, null, []]) expect(() => parseConfig({...base(), botMenu})).toThrow('botMenu must be boolean');
  });
});
