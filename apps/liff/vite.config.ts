import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: mode === 'e2e'
    ? { alias: { '@line/liff': fileURLToPath(new URL('./e2e/liff.mock.ts', import.meta.url)) } }
    : undefined,
  build: { outDir: 'dist' },
}));
