// Сборка CLI одним файлом: dist/contract-impact.mjs (запускается командой node, зависимостей нет).
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/contract-impact.mjs',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  legalComments: 'none',
});
chmodSync('dist/contract-impact.mjs', 0o755);
console.log('dist/contract-impact.mjs готов');
