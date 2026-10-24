import {afterEach, describe, expect, it, vi} from 'vitest';
import {newerVersion, npmLatest, type Release, UpdateCheck} from '../src/onboarding/updates.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const DAY = 24 * 60 * 60_000;

afterEach(() => { vi.unstubAllGlobals(); });

describe('plugin update check', () => {
  it.each([
    ['0.3.0', '0.2.0', true], ['0.2.1', '0.2.0', true], ['1.0.0', '0.9.9', true], ['0.10.0', '0.9.0', true],
    ['0.2.0', '0.2.0', false], ['0.1.9', '0.2.0', false], ['0.3.0', '0.3.0-rc.1', true], ['0.3.0-rc.1', '0.3.0', false],
    ['latest', '0.2.0', false], ['0.3.0', 'dev', false],
  ] as const)('treats %s as newer than %s: %s', (next, current, expected) => {
    expect(newerVersion(next, current)).toBe(expected);
  });

  it('never waits for the registry, and offers a newer release once it is known', async () => {
    let finish!: (value: Release) => void;
    const lookup = vi.fn(() => new Promise<Release | undefined>(resolve => { finish = resolve; }));
    const check = new UpdateCheck('0.2.0', lookup, () => 0);
    expect(check.status()).toBeUndefined();
    expect(check.status()).toBeUndefined();
    expect(lookup).toHaveBeenCalledOnce();
    finish({version: '0.3.0', publishedAt: -DAY});
    await vi.waitFor(() => expect(check.status()).toEqual({current: '0.2.0', latest: '0.3.0'}));
  });

  it('holds back a release younger than a day, then offers it as it ages without asking npm again', async () => {
    let clock = 0;
    const lookup = vi.fn(async () => ({version: '0.3.0', publishedAt: -DAY + 60_000}));
    const check = new UpdateCheck('0.2.0', lookup, () => clock);
    expect(check.status()).toBeUndefined();
    await settle();
    expect(check.status()).toBeUndefined();
    clock = 60_000;
    expect(check.status()).toEqual({current: '0.2.0', latest: '0.3.0'});
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('checks at most every six hours, retries a failed check after half an hour, and stays quiet when current', async () => {
    let clock = 0;
    const lookup = vi.fn<(signal: AbortSignal) => Promise<Release | undefined>>(async () => { throw new Error('offline'); });
    const check = new UpdateCheck('0.3.0', lookup, () => clock);
    expect(check.status()).toBeUndefined();
    await settle();
    clock = 29 * 60_000;
    check.status();
    expect(lookup).toHaveBeenCalledTimes(1);
    clock = 31 * 60_000;
    lookup.mockResolvedValueOnce({version: '0.3.0', publishedAt: -DAY});
    expect(check.status()).toBeUndefined();
    await settle();
    expect(lookup).toHaveBeenCalledTimes(2);
    clock += 5 * 60 * 60_000;
    expect(check.status()).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(2);
    clock += 60 * 60_000 + 1;
    check.status();
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('does not look anything up without a readable installed version', () => {
    const lookup = vi.fn(async () => ({version: '9.9.9', publishedAt: -DAY}));
    expect(new UpdateCheck(undefined, lookup).status()).toBeUndefined();
    expect(new UpdateCheck('workspace', lookup).status()).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('asks npm only for the package document and takes stable releases with a publish time', async () => {
    const time = {'0.3.0': '2026-10-24T09:15:26.779Z', '0.4.0-rc.1': '2026-10-25T09:15:26.779Z'};
    const document = (latest: string, times: object = time) => new Response(JSON.stringify({'dist-tags': {latest, next: '0.4.0-rc.1'}, time: times}));
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => document('0.3.0'));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toEqual({version: '0.3.0', publishedAt: Date.parse('2026-10-24T09:15:26.779Z')});
    expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/dsh-lark-agent', {signal, headers: {accept: 'application/json'}});
    fetch.mockResolvedValueOnce(document('0.4.0-rc.1'));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(document('0.3.0', {}));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(document('0.3.0', {'0.3.0': 'yesterday'}));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(new Response('unavailable', {status: 503}));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(document('<script>'));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
  });
});
