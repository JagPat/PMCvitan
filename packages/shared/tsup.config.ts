import { defineConfig } from 'tsup';

/**
 * Phase 2 Task 2 — build @vitan/shared as a dual runtime package.
 *
 * The API is CommonJS (tsc → dist, run as `node dist/main.js`), so it needs a
 * `require`-able artifact; the web app + vitest resolve the ESM condition. tsup
 * (esbuild) BUNDLES the extensionless internal imports at build time, so neither
 * output depends on Node's ESM extension resolution. `.d.ts` gives the API tsc
 * typecheck a real declaration to resolve against.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  treeshake: true,
});
