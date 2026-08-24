import { defineConfig } from 'vitest/config';

// Root vitest config — only picks up tests under `scripts/`.
// Per-package tests (apps/worker, packages/*) keep their own configs.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['scripts/**/*.test.ts'],
    // The customer-onboarding / customer-update tests drive real git repos in
    // temp dirs and run ~6s; the 5s default is not enough headroom.
    testTimeout: 30_000,
  },
});
