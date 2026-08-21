import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // @line-crm/line-sdk has main=dist/index.js but dist may not exist in
      // the worktree; point Vitest directly at the TS sources so tests resolve
      // without a build step.
      '@line-crm/line-sdk': resolve(configDir, '../../packages/line-sdk/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
