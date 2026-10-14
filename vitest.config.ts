import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/setupFiles.ts'],
    // Integration tests share a single PostgreSQL database, so run files sequentially
    // and reset state explicitly between tests.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    restoreMocks: true,
  },
});
