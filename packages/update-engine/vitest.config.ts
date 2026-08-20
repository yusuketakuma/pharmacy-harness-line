import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    // upgrade-matrix replays the full v0.14.1 -> latest migration chain in one
    // test; it lands right on the 5s default, so give it real headroom.
    testTimeout: 30_000,
  },
});
