import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
    }),
  ],
  test: {
    include: ['worker-test/**/*.test.ts'],
    setupFiles: ['./worker-test/setup.ts'],
    testTimeout: 20_000,
  },
});
