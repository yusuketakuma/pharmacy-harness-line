import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4311',
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec next dev --hostname 127.0.0.1 --port 4311',
    url: 'http://127.0.0.1:4311/login',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:4311', NEXT_TELEMETRY_DISABLED: '1' },
  },
})
