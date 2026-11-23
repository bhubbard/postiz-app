import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': resolve(import.meta.dirname, 'test/mocks/cloudflare-workers.ts'),
      'cloudflare:workflows': resolve(import.meta.dirname, 'test/mocks/cloudflare-workflows.ts'),
    },
  },
});
