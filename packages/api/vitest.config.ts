import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    server: { deps: { external: [/^node:sqlite$/] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/stores/cloudflare.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
});
