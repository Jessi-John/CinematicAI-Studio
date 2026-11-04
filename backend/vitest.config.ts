import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // M67: integration tests need live services (Postgres/Redis) — they run
    // via the dedicated integration job, not the unit gate. Previously the
    // unit include matched them and failed on machines without Docker.
    exclude: ['src/**/*.integration.test.ts', 'node_modules'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['src/test/setup.ts', 'src/**/*.mock.ts'],
    },
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
