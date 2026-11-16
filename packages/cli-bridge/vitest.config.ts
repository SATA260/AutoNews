import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cli-bridge',
    include: ['test/**/*.test.ts'],
  },
});
