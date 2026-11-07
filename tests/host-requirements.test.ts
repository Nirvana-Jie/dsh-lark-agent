import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';

// The host decides admission with `semver.satisfies(runtime, range,
// {includePrerelease: true})` in @deepseek-ai/dsh-app-boot's
// `unmetRequirements`; an own `engines.dsh` range decides alone and the DSH
// peer ranges are then ignored. Use the same library and options here so the
// suite asserts what DSH actually decides.
//
// `engines.dsh` is deliberately a range, not an exact list: every DSH release
// used to force a plugin release because the exact list had to be edited. The
// range accepts the whole supported 0.x line, so a DSH patch or release
// candidate needs no plugin release; a DSH 1.0 release still does, which is
// when a breaking host contract is expected.
const require = createRequire(import.meta.url);
const semver = require('semver') as {
  satisfies: (version: string, range: string, options: {includePrerelease: boolean}) => boolean;
  validRange: (range: string) => string | null;
};
const gate = {includePrerelease: true} as const;

interface Manifest {
  engines?: {node?: string; dsh?: string};
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;
const hostRequirement = manifest.engines?.dsh;
const hostPeers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/u.test(name));

/** Hosts the plugin supports today, plus future 0.x hosts that need no plugin release. */
const accepted = [
  '0.1.1-rc.2', // legacy CLI / Web host
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.5',
  '0.2.2-rc.1',
  '0.2.3-rc.1',
  '0.2.10',
  '0.3.0-rc.1',
  '0.9.9',
];

/** Untested older hosts and the next major line, which needs a deliberate release. */
const rejected = ['0.1.0', '0.2.0-rc.2', '1.0.0-rc.1', '1.0.0'];

describe('DSH host requirement declaration', () => {
  it('declares a valid engines.dsh range that decides host admission', () => {
    expect(typeof hostRequirement).toBe('string');
    expect(semver.validRange(hostRequirement!)).not.toBeNull();
    expect(hostPeers.length).toBeGreaterThan(0);
  });

  it('accepts every supported host and future 0.x hosts', () => {
    for (const version of accepted) expect(semver.satisfies(version, hostRequirement!, gate), version).toBe(true);
  });

  it('rejects hosts below the floor and the next major line', () => {
    for (const version of rejected) expect(semver.satisfies(version, hostRequirement!, gate), version).toBe(false);
  });

  it('keeps every DSH peer on the same range as engines.dsh', () => {
    expect(hostPeers.map(([name]) => name)).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']));
    for (const [name, range] of hostPeers) {
      expect(range, name).toBe(hostRequirement);
      for (const version of accepted) expect(semver.satisfies(version, range, gate), `${name}@${version}`).toBe(true);
      for (const version of rejected) expect(semver.satisfies(version, range, gate), `${name}@${version}`).toBe(false);
    }
  });

  it('accepts the cordis and schemastery versions supported hosts ship', () => {
    const cordis = manifest.peerDependencies?.['@deepseek-ai/cordis'];
    const schemastery = manifest.peerDependencies?.['@deepseek-ai/schemastery'];
    expect(typeof cordis).toBe('string');
    expect(typeof schemastery).toBe('string');
    for (const version of ['4.0.5', '4.1.0']) expect(semver.satisfies(version, cordis!, gate), `cordis@${version}`).toBe(true);
    for (const version of ['3.18.5', '3.19.0']) expect(semver.satisfies(version, schemastery!, gate), `schemastery@${version}`).toBe(true);
  });
});
