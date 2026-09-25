import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupEnv.ts'],
    fileParallelism: false, // all files share one test database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
