import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

// Optional real-host gate: with DSH_MODERN_HOST_ROOT pointing at an extracted
// App dependency tree, ask the host's own evaluator whether this package's
// manifest is admitted. This is the gate that skips a plugin at composition
// time (and that the plugin market predicts as "incompatible").
const hostRoot = process.env.DSH_MODERN_HOST_ROOT;
const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(hostRoot!, path)).href);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe.skipIf(!hostRoot)('host compatibility gate', () => {
  it('admits the current manifest on the real host runtime version', async () => {
    const host = await load('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
    const issue = host.evaluatePluginCompatibility(manifest, {}, host.getDshRuntimeVersion());
    expect(issue).toBeUndefined();
  });

  it('lets engines.dsh decide alone over incompatible DSH peers', async () => {
    const host = await load('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
    const enginesWins = {
      ...manifest,
      peerDependencies: Object.fromEntries(Object.keys(manifest.peerDependencies ?? {})
        .filter(name => /^@deepseek-ai\/dsh(?:-|$)/u.test(name))
        .map(name => [name, '0.0.0-0'])),
    };
    // The host ignores peers whenever engines.dsh is present; this is the rule
    // the range-based fix depends on.
    expect(host.evaluatePluginCompatibility(enginesWins, {}, host.getDshRuntimeVersion())).toBeUndefined();
  });

  it('rejects a DSH peer range that excludes the running runtime', async () => {
    const host = await load('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
    // Without engines.dsh the peer ranges decide; this reproduces what the old
    // exact host-version lists caused whenever the host moved on.
    const peerOnly = {
      name: manifest.name,
      version: manifest.version,
      engines: manifest.engines?.node === undefined ? {} : {node: manifest.engines.node},
      peerDependencies: Object.fromEntries(Object.keys(manifest.peerDependencies ?? {})
        .filter(name => /^@deepseek-ai\/dsh(?:-|$)/u.test(name))
        .map(name => [name, '0.0.0-0'])),
    };
    const issue = host.evaluatePluginCompatibility(peerOnly, {}, host.getDshRuntimeVersion());
    expect(issue).toBeDefined();
    expect(Object.keys(issue.requirements ?? {}).length).toBeGreaterThan(0);
  });
});
