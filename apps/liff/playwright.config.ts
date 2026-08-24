import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
      port: 4173,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 4174 --strictPort --mode e2e',
      port: 4174,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
