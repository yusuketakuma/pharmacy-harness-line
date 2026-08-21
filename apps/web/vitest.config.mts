import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: { alias: { '@': resolve(configDir, 'src') } },
  // tsconfig sets jsx: "preserve" for Next.js, which leaves .tsx untransformed
  // for Vite. Tests have no Next compiler in front of them, so transform here.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    globals: false,
    env: { NEXT_PUBLIC_API_URL: 'http://localhost' },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
