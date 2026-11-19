import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/main.js',
  external: ['electron', 'esbuild'],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __kronosRequire } from 'node:module';\nconst require = __kronosRequire(import.meta.url);" },
  logLevel: 'info',
});
