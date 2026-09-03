import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/pure.ts'],
  format: ['esm', 'cjs'],
  clean: true,
  splitting: false,
  sourcemap: true,
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
});
