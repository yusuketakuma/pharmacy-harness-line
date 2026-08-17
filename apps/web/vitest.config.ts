import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    globals: false,
    env: { NEXT_PUBLIC_API_URL: 'http://localhost' },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
