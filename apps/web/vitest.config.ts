import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
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
