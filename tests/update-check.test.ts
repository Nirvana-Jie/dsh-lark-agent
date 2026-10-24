import {afterEach, describe, expect, it, vi} from 'vitest';
import {newerVersion, npmLatest, UpdateCheck} from '../src/onboarding/updates.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

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
    let finish!: (value: string) => void;
    const lookup = vi.fn(() => new Promise<string | undefined>(resolve => { finish = resolve; }));
    const check = new UpdateCheck('0.2.0', lookup, () => 0);
    expect(check.status()).toBeUndefined();
    expect(check.status()).toBeUndefined();
    expect(lookup).toHaveBeenCalledOnce();
    finish('0.3.0');
    await vi.waitFor(() => expect(check.status()).toEqual({current: '0.2.0', latest: '0.3.0'}));
  });

  it('checks at most every six hours, retries a failed check after half an hour, and stays quiet when current', async () => {
    let clock = 0;
    const lookup = vi.fn<(signal: AbortSignal) => Promise<string | undefined>>(async () => { throw new Error('offline'); });
    const check = new UpdateCheck('0.3.0', lookup, () => clock);
    expect(check.status()).toBeUndefined();
    await settle();
    clock = 29 * 60_000;
    check.status();
    expect(lookup).toHaveBeenCalledTimes(1);
    clock = 31 * 60_000;
    lookup.mockResolvedValueOnce('0.3.0');
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
    const lookup = vi.fn(async () => '9.9.9');
    expect(new UpdateCheck(undefined, lookup).status()).toBeUndefined();
    expect(new UpdateCheck('workspace', lookup).status()).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('asks npm only for the package dist-tags and takes stable releases only', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({latest: '0.3.0', next: '0.4.0-rc.1'})));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBe('0.3.0');
    expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/-/package/dsh-lark-agent/dist-tags', {signal, headers: {accept: 'application/json'}});
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({latest: '0.4.0-rc.1'})));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(new Response('unavailable', {status: 503}));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({latest: '<script>'})));
    await expect(npmLatest('dsh-lark-agent', signal)).resolves.toBeUndefined();
  });
});
