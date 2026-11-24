import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'x11'] }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer.js', platform: 'browser', format: 'iife' }),
  build({ ...common, entryPoints: ['src/renderer/setup.ts'], outfile: 'dist/setup.js', platform: 'browser', format: 'iife' }),
]);

for (const f of ['index.html', 'style.css', 'setup.html']) cpSync(`src/renderer/${f}`, `dist/${f}`);
