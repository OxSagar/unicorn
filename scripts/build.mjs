import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir } from 'node:fs/promises';
await mkdir('dist/main', { recursive: true });
await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist/main/index.cjs',
  external: ['electron'],
  sourcemap: true,
});
await build({
  entryPoints: ['src/preload/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist/preload/index.cjs',
  external: ['electron'],
});
await viteBuild();
