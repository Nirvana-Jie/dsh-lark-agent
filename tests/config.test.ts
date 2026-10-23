import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
const base = () => ({profile: 'team-bot', botOpenId: 'ou_bot', users: [{openId: 'ou_alice', cwd: '/tmp/alice'}]});
describe('runtime policy parsing', () => {
  it('defaults to explicit admission and no tool capabilities', () => {
    const config = parseConfig(base(), '/tmp/config');
    expect(config.users[0]).toMatchObject({direct: false, groupChats: [], allowedTools: []});
    expect(config.stateDir).toBe('/tmp/config/.state');
    expect(config.botMenu).toBe(false);
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
  it('requires an explicit boolean opt-in for the menu receiver', () => {
    expect(parseConfig({...base(), botMenu: true}).botMenu).toBe(true);
    for (const botMenu of ['true', 1, null, []]) expect(() => parseConfig({...base(), botMenu})).toThrow('botMenu must be boolean');
  });
});
