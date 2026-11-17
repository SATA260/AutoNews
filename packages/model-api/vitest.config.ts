import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'model-api',
    include: ['test/**/*.test.ts'],
  },
});
