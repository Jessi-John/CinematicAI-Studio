import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['proxy.test.ts', 'hooks/**/*.test.ts', 'hooks/**/*.test.tsx', 'lib/**/*.test.ts', 'lib/**/*.test.tsx', 'components/**/*.test.ts', 'components/**/*.test.tsx', 'app/**/*.test.ts', 'app/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});