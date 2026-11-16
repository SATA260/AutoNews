import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    removeNodeProtocol: false,
    dts: true,
    clean: true,
    sourcemap: true,
    external: ['node:sqlite', 'jsdom', 'playwright'],
  },
  {
    entry: { worker: 'src/worker/main.ts' },
    format: ['esm'],
    platform: 'node',
    removeNodeProtocol: false,
    dts: false,
    clean: false,
    sourcemap: true,
    outExtension: () => ({ js: '.mjs' }),
    external: ['node:sqlite', 'jsdom', 'playwright'],
  },
]);
