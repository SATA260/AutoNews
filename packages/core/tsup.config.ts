import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ['node:sqlite', 'jsdom', 'playwright'],
  },
  {
    entry: { worker: 'src/worker/main.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    outExtension: () => ({ js: '.mjs' }),
    external: ['node:sqlite', 'jsdom', 'playwright'],
  },
]);
