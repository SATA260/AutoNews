import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tts',
    include: ['test/**/*.test.ts'],
  },
});
