import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // vite does not yet know node:sqlite as a builtin; keep it out of the transform pipeline
    server: { deps: { external: [/^node:sqlite$/] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
});
