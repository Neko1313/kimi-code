import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-workflow',
    include: ['test/**/*.test.ts'],
  },
});
