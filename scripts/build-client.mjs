import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let output = process.env.DSH_LARKBOT_CLIENT_OUTDIR || 'dist';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--outdir' && args[i + 1]) output = args[++i];
  else if (args[i].startsWith('--outdir=')) output = args[i].slice('--outdir='.length);
  else throw new Error(`Unknown build argument: ${args[i]}`);
}
const {name} = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: path.resolve(root, output, 'client.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  loader: {'.png': 'dataurl'},
  define: {'process.env.NODE_ENV': JSON.stringify('production')},
  banner: {js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`},
  footer: {js: 'return module.exports; } });'},
});
